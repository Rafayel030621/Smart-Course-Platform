import type { IncomingMessage, ServerResponse } from 'node:http'
import { transaction, type V3Database } from './db.js'
import {
  assertProjectRevision,
  bumpProjectRevision,
  getEvidence,
  getMilestone,
  getProgress,
  getTask,
  loadProject,
  milestoneTaskStats,
  optionalIso,
  parseJsonArray,
  requiredText,
  type ProgressRow,
} from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import {
  bodyReadError,
  parseLimit,
  queryParam,
  readJsonBody,
  requireExpectedRevision,
  requireRecord,
  requireWriteEnvelope,
  sendV3Json,
  successBody,
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/** 进展（docs/contracts.md 22.4） */

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, 256 * 1024))
  } catch (error) {
    throw bodyReadError(error)
  }
}

export interface ProgressDto {
  progressId: string
  summary: string
  milestoneId: string | null
  taskId: string | null
  evidenceIds: string[]
  occurredAt: string
  status: string
  supersedesProgressId: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

function toProgressDto(row: ProgressRow): ProgressDto {
  return {
    progressId: row.progress_id,
    summary: row.summary,
    milestoneId: row.milestone_id,
    taskId: row.task_id,
    evidenceIds: parseJsonArray(row.evidence_ids_json),
    occurredAt: row.occurred_at,
    status: row.status,
    supersedesProgressId: row.supersedes_progress_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function readNullableId(body: Record<string, unknown>, field: string): string | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value === '') throw invalidInput(`${field} 必须是字符串或 null`)
  return value
}

function readEvidenceIds(body: Record<string, unknown>): string[] {
  const value = body.evidenceIds
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalidInput('evidenceIds 必须是数组')
  if (value.length > 10) throw invalidInput('evidenceIds 最多 10 条')
  const ids = value.map((item) => {
    if (typeof item !== 'string' || item === '') throw invalidInput('evidenceIds 只能包含字符串')
    return item
  })
  if (new Set(ids).size !== ids.length) throw invalidInput('evidenceIds 不能重复')
  return ids
}

function validateLinks(
  db: V3Database,
  projectId: string,
  milestoneId: string | null,
  taskId: string | null,
  evidenceIds: string[],
): void {
  if (milestoneId !== null) {
    const milestone = getMilestone(db, projectId, milestoneId)
    if (milestone.status === 'archived') throw new V3Error('MILESTONE_ARCHIVED')
  }
  if (taskId !== null) {
    const task = getTask(db, projectId, taskId)
    if (task.archived_at !== null) throw new V3Error('TASK_ARCHIVED')
    if (milestoneId !== null && task.milestone_id !== milestoneId) {
      throw invalidInput('任务的当前阶段与 milestoneId 不一致')
    }
  }
  for (const evidenceId of evidenceIds) {
    getEvidence(db, projectId, evidenceId)
  }
}

export async function handleProgressCreate(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const summary = requiredText(body.summary, 1000, 'summary')
  const milestoneId = readNullableId(body, 'milestoneId')
  const taskId = readNullableId(body, 'taskId')
  const evidenceIds = readEvidenceIds(body)
  const occurredAt = optionalIso(body.occurredAt, 'occurredAt')

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
  validateLinks(db, projectId, milestoneId, taskId, evidenceIds)

  const progressId = newId('prg', now.getTime())
  const response = transaction(db, () => {
    db.prepare(
      `INSERT INTO progress_records
         (progress_id, project_id, milestone_id, task_id, user_id, summary, evidence_ids_json,
          occurred_at, status, supersedes_progress_id, author_user_id, revision,
          created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, 1, ?, ?, NULL)`,
    ).run(
      progressId,
      projectId,
      milestoneId,
      taskId,
      userId,
      summary,
      JSON.stringify(evidenceIds),
      occurredAt ?? nowText,
      userId,
      nowText,
      nowText,
    )

    const revision = bumpProjectRevision(db, projectId, nowText)
    const created = getProgress(db, projectId, progressId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      replayed: false,
      data: {
        progress: toProgressDto(created),
        milestoneStats:
          milestoneId === null ? null : milestoneTaskStats(db, projectId, milestoneId),
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

interface Cursor {
  occurredAt: string
  createdAt: string
  progressId: string
}

function encodeCursor(row: ProgressRow): string {
  return Buffer.from(
    JSON.stringify({ o: row.occurred_at, c: row.created_at, p: row.progress_id }),
    'utf8',
  ).toString('base64url')
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>
    if (
      typeof parsed.o !== 'string' ||
      typeof parsed.c !== 'string' ||
      typeof parsed.p !== 'string'
    ) {
      throw new Error('bad cursor')
    }
    return { occurredAt: parsed.o, createdAt: parsed.c, progressId: parsed.p }
  } catch {
    throw invalidInput('cursor 不合法')
  }
}

export async function handleProgressList(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const milestoneId = queryParam(url, 'milestoneId')
  const taskId = queryParam(url, 'taskId')
  const includeArchived = queryParam(url, 'includeArchived') === 'true'
  const limit = parseLimit(queryParam(url, 'limit'))
  const cursorRaw = queryParam(url, 'cursor')

  if (milestoneId !== null) getMilestone(db, projectId, milestoneId)
  if (taskId !== null) getTask(db, projectId, taskId)
  const cursor = cursorRaw === null ? null : decodeCursor(cursorRaw)

  const conditions: string[] = ['project_id = ?']
  const params: unknown[] = [projectId]
  if (milestoneId !== null) {
    conditions.push('milestone_id = ?')
    params.push(milestoneId)
  }
  if (taskId !== null) {
    conditions.push('task_id = ?')
    params.push(taskId)
  }
  if (!includeArchived) conditions.push("status != 'archived'")
  if (cursor !== null) {
    conditions.push(
      '(occurred_at < ? OR (occurred_at = ? AND (created_at < ? OR (created_at = ? AND progress_id < ?))))',
    )
    params.push(cursor.occurredAt, cursor.occurredAt, cursor.createdAt, cursor.createdAt, cursor.progressId)
  }
  params.push(limit + 1)

  const rows = db
    .prepare(
      `SELECT * FROM progress_records
        WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC, created_at DESC, progress_id DESC
        LIMIT ?`,
    )
    .all(...params) as ProgressRow[]

  const items = rows.slice(0, limit)
  const nextCursor = rows.length > limit && items.length > 0 ? encodeCursor(items[items.length - 1] as ProgressRow) : null

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: { progress: items.map(toProgressDto), nextCursor },
  })
}

export async function handleProgressSupersede(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  progressId: string,
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
  const previous = getProgress(db, projectId, progressId)
  if (previous.revision !== expected) {
    throw new V3Error('STALE_REVISION', {
      projectId,
      currentProjectRevision: project.project_revision,
      currentEntityRevision: previous.revision,
    })
  }
  if (previous.status === 'archived' || previous.status === 'superseded') {
    throw new V3Error('INVALID_STATE_TRANSITION')
  }

  const summary = body.summary === undefined ? previous.summary : requiredText(body.summary, 1000, 'summary')
  const milestoneId = body.milestoneId === undefined ? previous.milestone_id : readNullableId(body, 'milestoneId')
  const taskId = body.taskId === undefined ? previous.task_id : readNullableId(body, 'taskId')
  const evidenceIds =
    body.evidenceIds === undefined ? parseJsonArray(previous.evidence_ids_json) : readEvidenceIds(body)
  const occurredAt = optionalIso(body.occurredAt, 'occurredAt') ?? nowText
  validateLinks(db, projectId, milestoneId, taskId, evidenceIds)

  const newProgressId = newId('prg', now.getTime())
  const response = transaction(db, () => {
    db.prepare(
      `UPDATE progress_records
          SET status = 'superseded', revision = revision + 1, updated_at = ?
        WHERE progress_id = ? AND project_id = ?`,
    ).run(nowText, progressId, projectId)

    db.prepare(
      `INSERT INTO progress_records
         (progress_id, project_id, milestone_id, task_id, user_id, summary, evidence_ids_json,
          occurred_at, status, supersedes_progress_id, author_user_id, revision,
          created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?, NULL)`,
    ).run(
      newProgressId,
      projectId,
      milestoneId,
      taskId,
      userId,
      summary,
      JSON.stringify(evidenceIds),
      occurredAt,
      progressId,
      userId,
      nowText,
      nowText,
    )

    const revision = bumpProjectRevision(db, projectId, nowText)
    const created = getProgress(db, projectId, newProgressId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      replayed: false,
      data: {
        progress: toProgressDto(created),
        supersededProgressId: progressId,
        milestoneStats:
          milestoneId === null ? null : milestoneTaskStats(db, projectId, milestoneId),
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}
