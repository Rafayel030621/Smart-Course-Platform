import type { IncomingMessage, ServerResponse } from 'node:http'
import { transaction } from './db.js'
import {
  assertProjectRevision,
  assertProjectWritable,
  bumpProjectRevision,
  loadProject,
  optionalText,
  parseProfile,
  profileFromJson,
  requiredText,
  shortFromName,
  toProjectDto,
  toProjectListItem,
  type ProjectRow,
} from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import {
  bodyReadError,
  queryParam,
  readJsonBody,
  requireContractVersion,
  requireIdempotencyKey,
  requireRecord,
  requireRequestId,
  requireWriteEnvelope,
  sendV3Json,
  successBody,
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/** 项目（docs/contracts.md 22.1） */

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, 256 * 1024))
  } catch (error) {
    throw bodyReadError(error)
  }
}

export async function handleProjectList(
  _req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  url: URL,
): Promise<void> {
  const includeArchived = queryParam(url, 'includeArchived') === 'true'
  const db = runtime.getDb()
  const rows = db
    .prepare(
      `SELECT * FROM projects
        WHERE owner_user_id = ?
          AND status != 'deleted'
          AND (? = 1 OR status != 'archived')
        ORDER BY updated_at DESC, project_id DESC`,
    )
    .all(auth.user.user_id, includeArchived ? 1 : 0) as ProjectRow[]

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId: null,
    projectRevision: null,
    data: { projects: rows.map((row) => toProjectListItem(db, row)) },
  })
}

export async function handleProjectCreate(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
): Promise<void> {
  const body = await readBody(req)
  requireContractVersion(body)
  const requestId = requireRequestId(body)
  const idempotencyKey = requireIdempotencyKey(body)
  const name = requiredText(body.name, 120, 'name')
  const shortRaw = optionalText(body.short, 20, 'short')
  const short = shortRaw ?? shortFromName(name)
  if (short.length === 0) throw invalidInput('short 不能为空')
  const profile = parseProfile(body.profile)

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: 'project.create',
    resource: 'projects',
    body,
  })

  const replay = lookupIdempotent(db, userId, idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const projectId = newId('prj', now.getTime())
  const result = transaction(db, () => {
    db.prepare(
      `INSERT INTO projects
         (project_id, owner_user_id, name, short, profile_json, status, visibility,
          project_revision, current_milestone_id, last_activity_at, created_at, updated_at,
          archived_at, deleted_at, purge_after, migrated_from_revision, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'active', 'private', 1, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
    ).run(
      projectId,
      userId,
      name,
      short,
      JSON.stringify(profile),
      nowText,
      nowText,
      nowText,
      userId,
    )

    const project = loadProject(db, userId, projectId)
    const response = successBody(requestId, projectId, {
      projectRevision: 1,
      replayed: false,
      data: { project: toProjectDto(db, project) },
    })
    saveIdempotent(db, userId, idempotencyKey, fingerprint, 200, response, nowText)
    return response
  })

  sendV3Json(res, 200, result)
}

export async function handleProjectGet(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: { project: toProjectDto(db, project) },
  })
}

export async function handleProjectPatch(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'PATCH',
    operation: 'project.patch',
    resource: projectId,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectWritable(project)
  assertProjectRevision(project, envelope.projectRevision)

  const hasName = body.name !== undefined
  const hasShort = body.short !== undefined
  const hasProfile = body.profile !== undefined
  if (!hasName && !hasShort && !hasProfile) {
    throw invalidInput('至少提供一个可编辑字段')
  }

  const name = hasName ? requiredText(body.name, 120, 'name') : project.name
  const shortRaw = hasShort ? optionalText(body.short, 20, 'short') : project.short
  const short = shortRaw ?? shortFromName(name)
  const profile = hasProfile ? parseProfile(body.profile) : profileFromJson(project.profile_json)

  const response = transaction(db, () => {
    db.prepare(
      `UPDATE projects
          SET name = ?, short = ?, profile_json = ?
        WHERE project_id = ? AND owner_user_id = ?`,
    ).run(name, short, JSON.stringify(profile), projectId, userId)
    const revision = bumpProjectRevision(db, projectId, nowText)
    const updated = loadProject(db, userId, projectId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      replayed: false,
      data: { project: toProjectDto(db, updated) },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

const PROJECT_ACTIONS = new Set(['archive', 'restore', 'delete', 'restore-deleted'])

export async function handleProjectAction(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  action: string,
): Promise<void> {
  if (!PROJECT_ACTIONS.has(action)) throw new V3Error('RESOURCE_NOT_FOUND')

  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: `project.${action}`,
    resource: projectId,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId, {
    includeDeleted: action === 'restore-deleted' || action === 'delete',
  })
  // 恢复与删除项目本身不受归档写保护限制；其余项目动作必须先恢复
  if (action !== 'restore' && action !== 'delete') {
    assertProjectWritable(project)
  }
  assertProjectRevision(project, envelope.projectRevision)

  const response = transaction(db, () => {
    let changed = false
    switch (action) {
      case 'archive': {
        if (project.status === 'archived') break
        if (project.status !== 'active') throw new V3Error('INVALID_STATE_TRANSITION')
        db.prepare(
          "UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ?, last_activity_at = ? WHERE project_id = ?",
        ).run(nowText, nowText, nowText, projectId)
        changed = true
        break
      }
      case 'restore': {
        if (project.status === 'active') break
        if (project.status !== 'archived') throw new V3Error('INVALID_STATE_TRANSITION')
        db.prepare(
          "UPDATE projects SET status = 'active', archived_at = NULL, updated_at = ?, last_activity_at = ? WHERE project_id = ?",
        ).run(nowText, nowText, projectId)
        changed = true
        break
      }
      case 'delete': {
        if (project.status === 'deleted') break
        const purgeAfter = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
        db.prepare(
          "UPDATE projects SET status = 'deleted', deleted_at = ?, purge_after = ?, updated_at = ?, last_activity_at = ? WHERE project_id = ?",
        ).run(nowText, purgeAfter, nowText, nowText, projectId)
        changed = true
        break
      }
      case 'restore-deleted': {
        if (project.status !== 'deleted') throw new V3Error('INVALID_STATE_TRANSITION')
        if (project.purge_after !== null && project.purge_after <= nowText) {
          throw new V3Error('PROJECT_NOT_FOUND')
        }
        db.prepare(
          "UPDATE projects SET status = 'active', deleted_at = NULL, purge_after = NULL, updated_at = ?, last_activity_at = ? WHERE project_id = ?",
        ).run(nowText, nowText, projectId)
        changed = true
        break
      }
      default:
        throw new V3Error('RESOURCE_NOT_FOUND')
    }

    const revision = changed ? bumpProjectRevision(db, projectId, nowText) : project.project_revision
    const updated = loadProject(db, userId, projectId, { includeDeleted: true })
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      changed,
      replayed: false,
      data: {
        project: toProjectDto(db, updated, { includeArchivedMilestones: true }),
      },
    })
    saveIdempotent(
      db,
      userId,
      envelope.idempotencyKey,
      fingerprint,
      200,
      payload,
      nowText,
    )
    return payload
  })

  sendV3Json(res, 200, response)
}
