import type { IncomingMessage, ServerResponse } from 'node:http'
import { transaction, type V3Database } from './db.js'
import {
  assertProjectRevision,
  bumpProjectRevision,
  getMilestone,
  loadProject,
  normalizeNameKey,
  optionalIso,
  optionalText,
  projectStats,
  recalcCurrentMilestone,
  requiredText,
  toMilestoneDto,
  type MilestoneRow,
} from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import {
  bodyReadError,
  isSqliteUniqueError,
  readJsonBody,
  requireExpectedRevision,
  requireRecord,
  requireWriteEnvelope,
  sendV3Json,
  successBody,
  type WriteEnvelope,
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/** 阶段（docs/contracts.md 22.2） */

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, 256 * 1024))
  } catch (error) {
    throw bodyReadError(error)
  }
}

function assertNameFree(
  db: V3Database,
  projectId: string,
  nameKey: string,
  excludeMilestoneId: string | null,
): void {
  const row = db
    .prepare(
      `SELECT milestone_id FROM milestones
        WHERE project_id = ? AND name_key = ? AND archived_at IS NULL
          AND (? IS NULL OR milestone_id != ?)`,
    )
    .get(projectId, nameKey, excludeMilestoneId, excludeMilestoneId ?? '') as
    | { milestone_id: string }
    | undefined
  if (row !== undefined) throw new V3Error('MILESTONE_NAME_CONFLICT')
}

function assertCandidate(db: V3Database, projectId: string, userId: string, candidateId: unknown, nowText: string): void {
  if (typeof candidateId !== 'string' || candidateId === '') {
    throw new V3Error('CONFIRMATION_REQUIRED')
  }
  const row = db
    .prepare(
      `SELECT candidate_id, expires_at FROM milestone_candidates
        WHERE candidate_id = ? AND project_id = ? AND user_id = ?`,
    )
    .get(candidateId, projectId, userId) as { candidate_id: string; expires_at: string } | undefined
  if (row === undefined || row.expires_at <= nowText) throw new V3Error('CANDIDATE_EXPIRED')
}

export async function handleMilestoneList(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const includeArchived = url.searchParams.get('includeArchived') === 'true'
  const includeTaskStats = url.searchParams.get('includeTaskStats') !== 'false'
  const rows = db
    .prepare(
      `SELECT * FROM milestones
        WHERE project_id = ? AND (? = 1 OR archived_at IS NULL)
        ORDER BY order_index ASC, created_at ASC`,
    )
    .all(projectId, includeArchived ? 1 : 0) as MilestoneRow[]

  const milestones = rows.map((row) => {
    const dto = toMilestoneDto(db, row)
    return includeTaskStats ? dto : { ...dto, taskStats: undefined }
  })

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: {
      currentMilestoneId: project.current_milestone_id,
      milestones,
      projectStats: projectStats(db, projectId),
    },
  })
}

export async function handleMilestoneCreate(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const name = requiredText(body.name, 60, 'name')
  const goal = optionalText(body.goal, 300, 'goal')
  const doneCriteria = optionalText(body.doneCriteria, 300, 'doneCriteria')
  const dueAt = optionalIso(body.dueAt, 'dueAt')
  const statusRaw = body.status ?? 'planned'
  if (statusRaw !== 'planned' && statusRaw !== 'active') {
    throw invalidInput('status 只能是 planned 或 active')
  }
  const status = statusRaw
  const sourceRaw = body.source ?? 'manual'
  if (sourceRaw !== 'manual' && sourceRaw !== 'ai-candidate') {
    throw invalidInput('source 只能是 manual 或 ai-candidate')
  }
  const source = sourceRaw

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint(body)

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)

  if (source === 'ai-candidate') {
    if (body.confirmedByUser !== true) throw new V3Error('CONFIRMATION_REQUIRED')
    assertCandidate(db, projectId, userId, body.candidateId, nowText)
  }

  const nameKey = normalizeNameKey(name)
  const milestoneId = newId('ms', now.getTime())

  const response = transaction(db, () => {
    assertProjectRevision(loadProject(db, userId, projectId), envelope.projectRevision)
    assertNameFree(db, projectId, nameKey, null)

    const orderRow = db
      .prepare(
        'SELECT COALESCE(MAX(order_index), -1) AS maxIndex FROM milestones WHERE project_id = ? AND archived_at IS NULL',
      )
      .get(projectId) as { maxIndex: number }

    try {
      db.prepare(
        `INSERT INTO milestones
           (milestone_id, project_id, user_id, name, name_key, goal, done_criteria, due_at,
            status, order_index, source, revision, created_at, updated_at, completed_at,
            archived_at, archived_from_status, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?)`,
      ).run(
        milestoneId,
        projectId,
        userId,
        name,
        nameKey,
        goal,
        doneCriteria,
        dueAt,
        status,
        orderRow.maxIndex + 1,
        source,
        nowText,
        nowText,
        userId,
      )
    } catch (error) {
      if (isSqliteUniqueError(error)) throw new V3Error('MILESTONE_NAME_CONFLICT')
      throw error
    }

    if (status === 'active') recalcCurrentMilestone(db, projectId)
    const revision = bumpProjectRevision(db, projectId, nowText)
    recalcCurrentMilestone(db, projectId)
    const created = getMilestone(db, projectId, milestoneId)

    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      replayed: false,
      data: { milestone: toMilestoneDto(db, created) },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

export async function handleMilestonePatch(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  milestoneId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const expected = requireExpectedRevision(envelope)
  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint(body)

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)
  const milestone = getMilestone(db, projectId, milestoneId)
  if (milestone.revision !== expected) {
    throw new V3Error('STALE_REVISION', {
      projectId,
      currentProjectRevision: project.project_revision,
      currentEntityRevision: milestone.revision,
    })
  }

  const hasName = body.name !== undefined
  const hasGoal = body.goal !== undefined
  const hasDone = body.doneCriteria !== undefined
  const hasDue = body.dueAt !== undefined
  if (!hasName && !hasGoal && !hasDone && !hasDue) {
    throw invalidInput('至少提供一个可编辑字段')
  }

  const name = hasName ? requiredText(body.name, 60, 'name') : milestone.name
  const nameKey = hasName ? normalizeNameKey(name) : milestone.name_key
  const goal = hasGoal ? optionalText(body.goal, 300, 'goal') : milestone.goal
  const doneCriteria = hasDone ? optionalText(body.doneCriteria, 300, 'doneCriteria') : milestone.done_criteria
  const dueAt = hasDue ? optionalIso(body.dueAt, 'dueAt') : milestone.due_at

  const response = transaction(db, () => {
    assertNameFree(db, projectId, nameKey, milestoneId)
    try {
      db.prepare(
        `UPDATE milestones
            SET name = ?, name_key = ?, goal = ?, done_criteria = ?, due_at = ?,
                revision = revision + 1, updated_at = ?
          WHERE milestone_id = ? AND project_id = ?`,
      ).run(name, nameKey, goal, doneCriteria, dueAt, nowText, milestoneId, projectId)
    } catch (error) {
      if (isSqliteUniqueError(error)) throw new V3Error('MILESTONE_NAME_CONFLICT')
      throw error
    }

    const revision = bumpProjectRevision(db, projectId, nowText)
    const updated = getMilestone(db, projectId, milestoneId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      replayed: false,
      data: { milestone: toMilestoneDto(db, updated) },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

export async function handleMilestoneReorder(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  if (!Array.isArray(body.order)) throw invalidInput('order 必须是数组')
  const order = body.order
  if (!order.every((item): item is string => typeof item === 'string')) {
    throw invalidInput('order 只能包含阶段 ID')
  }

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint(body)

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)

  const rows = db
    .prepare(
      'SELECT * FROM milestones WHERE project_id = ? AND archived_at IS NULL ORDER BY order_index ASC',
    )
    .all(projectId) as MilestoneRow[]
  const currentIds = rows.map((row) => row.milestone_id)
  if (order.length !== currentIds.length) throw new V3Error('INVALID_ORDER')
  const unique = new Set(order)
  if (unique.size !== order.length) throw new V3Error('INVALID_ORDER')
  if (!order.every((id) => currentIds.includes(id))) throw new V3Error('INVALID_ORDER')

  const sameOrder = order.every((id, index) => currentIds[index] === id)

  const response = transaction(db, () => {
    let revision = project.project_revision
    if (!sameOrder) {
      const update = db.prepare(
        'UPDATE milestones SET order_index = ?, updated_at = ? WHERE milestone_id = ? AND project_id = ?',
      )
      order.forEach((id, index) => update.run(index, nowText, id, projectId))
      revision = bumpProjectRevision(db, projectId, nowText)
      recalcCurrentMilestone(db, projectId)
    }

    const updatedProject = loadProject(db, userId, projectId)
    const updatedRows = db
      .prepare(
        'SELECT * FROM milestones WHERE project_id = ? AND archived_at IS NULL ORDER BY order_index ASC',
      )
      .all(projectId) as MilestoneRow[]

    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      changed: !sameOrder,
      replayed: false,
      data: {
        currentMilestoneId: updatedProject.current_milestone_id,
        milestones: updatedRows.map((row) => toMilestoneDto(db, row)),
        projectStats: projectStats(db, projectId),
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

const MILESTONE_ACTIONS = new Set(['activate', 'complete', 'reopen', 'archive', 'restore'])

export async function handleMilestoneAction(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  milestoneId: string,
  action: string,
): Promise<void> {
  if (!MILESTONE_ACTIONS.has(action)) throw new V3Error('RESOURCE_NOT_FOUND')
  const body = await readBody(req)
  const envelope: WriteEnvelope = requireWriteEnvelope(body, projectId)
  const expected = requireExpectedRevision(envelope)
  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint(body)

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)
  const milestone = getMilestone(db, projectId, milestoneId)
  if (milestone.revision !== expected) {
    throw new V3Error('STALE_REVISION', {
      projectId,
      currentProjectRevision: project.project_revision,
      currentEntityRevision: milestone.revision,
    })
  }

  const response = transaction(db, () => {
    const current = getMilestone(db, projectId, milestoneId)
    let changed = false
    let nextStatus = current.status
    let completedAt = current.completed_at
    let archivedAt = current.archived_at
    let archivedFrom = current.archived_from_status

    if (action === 'activate') {
      if (current.status === 'archived') throw new V3Error('INVALID_STATE_TRANSITION')
      if (current.status === 'completed') throw new V3Error('INVALID_STATE_TRANSITION')
      if (current.status === 'planned') {
        nextStatus = 'active'
        changed = true
      }
    } else if (action === 'complete') {
      if (current.status === 'archived') throw new V3Error('INVALID_STATE_TRANSITION')
      if (current.status !== 'completed') {
        nextStatus = 'completed'
        completedAt = nowText
        changed = true
      }
    } else if (action === 'reopen') {
      if (current.status !== 'completed') throw new V3Error('INVALID_STATE_TRANSITION')
      nextStatus = 'active'
      completedAt = null
      changed = true
    } else if (action === 'archive') {
      if (current.status !== 'archived') {
        archivedFrom = current.status
        archivedAt = nowText
        nextStatus = 'archived'
        changed = true
      }
    } else if (action === 'restore') {
      if (current.status !== 'archived') throw new V3Error('INVALID_STATE_TRANSITION')
      nextStatus = current.archived_from_status ?? 'planned'
      archivedAt = null
      archivedFrom = null
      if (nextStatus !== 'completed') completedAt = null
      changed = true
    }

    if (changed) {
      db.prepare(
        `UPDATE milestones
            SET status = ?, completed_at = ?, archived_at = ?, archived_from_status = ?,
                revision = revision + 1, updated_at = ?
          WHERE milestone_id = ? AND project_id = ?`,
      ).run(nextStatus, completedAt, archivedAt, archivedFrom, nowText, milestoneId, projectId)
    }

    const revision = changed
      ? bumpProjectRevision(db, projectId, nowText)
      : project.project_revision
    recalcCurrentMilestone(db, projectId)
    const updated = getMilestone(db, projectId, milestoneId)

    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      changed,
      replayed: false,
      data: { milestone: toMilestoneDto(db, updated) },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}
