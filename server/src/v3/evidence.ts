import type { IncomingMessage, ServerResponse } from 'node:http'
import { transaction, type V3Database } from './db.js'
import {
  assertProjectRevision,
  bumpProjectRevision,
  getEvidence,
  getMilestone,
  getTask,
  loadProject,
  milestoneTaskStats,
  optionalBoolean,
  optionalText,
  requiredText,
  toEvidenceDto,
  toTaskDto,
  type EvidenceRow,
} from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import {
  bodyReadError,
  parseLimit,
  queryParam,
  readJsonBody,
  requireExpectedRevision,
  requirePositiveInteger,
  requireRecord,
  requireWriteEnvelope,
  sendV3Json,
  successBody,
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/** 证据（docs/contracts.md 22.5） */

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, 256 * 1024))
  } catch (error) {
    throw bodyReadError(error)
  }
}

function readNullableId(body: Record<string, unknown>, field: string): string | null {
  const value = body[field]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value === '') throw invalidInput(`${field} 必须是字符串或 null`)
  return value
}

function readSubmissionId(body: Record<string, unknown>, nowText: string): string {
  const value = body.submissionId
  if (value === undefined || value === null) return newId('sub', new Date(nowText).getTime())
  if (typeof value !== 'string' || !/^[\x21-\x7E]{8,64}$/.test(value)) {
    throw invalidInput('submissionId 需为 8～64 个可打印字符')
  }
  return value
}

function validateTaskAndMilestone(
  db: V3Database,
  projectId: string,
  taskId: string | null,
  milestoneId: string | null,
): { milestoneName: string | null } {
  if (taskId !== null) {
    const task = getTask(db, projectId, taskId)
    if (task.archived_at !== null) throw new V3Error('TASK_ARCHIVED')
  }
  if (milestoneId !== null) {
    const milestone = getMilestone(db, projectId, milestoneId)
    if (milestone.status === 'archived') throw new V3Error('MILESTONE_ARCHIVED')
    return { milestoneName: milestone.name }
  }
  return { milestoneName: null }
}

export async function handleEvidenceCreate(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const now = runtime.now()
  const nowText = now.toISOString()
  const submissionId = readSubmissionId(body, nowText)
  const taskId = readNullableId(body, 'taskId')
  const milestoneId = readNullableId(body, 'milestoneId')
  const didWhat = requiredText(body.didWhat, 300, 'didWhat')
  const foundWhat = optionalText(body.foundWhat, 500, 'foundWhat')
  const stillUnsure = optionalText(body.stillUnsure, 500, 'stillUnsure')
  const attachmentName = optionalText(body.attachmentName, 200, 'attachmentName')
  const completeTask = optionalBoolean(body.completeTask, 'completeTask')
  const expectedTaskRevision =
    body.expectedTaskRevision === undefined
      ? envelope.expectedRevision
      : requirePositiveInteger(body.expectedTaskRevision, 'expectedTaskRevision')

  const db = runtime.getDb()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint(body)

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)

  const existing = db
    .prepare('SELECT * FROM evidence WHERE project_id = ? AND submission_id = ?')
    .get(projectId, submissionId) as EvidenceRow | undefined
  if (existing !== undefined) {
    sendV3Json(res, 200, {
      contractVersion: '3.0',
      requestId: envelope.requestId,
      projectId,
      projectRevision: project.project_revision,
      replayed: true,
      data: {
        evidence: toEvidenceDto(existing),
        doubt: null,
        task: null,
        milestoneStats:
          existing.milestone_id === null
            ? null
            : milestoneTaskStats(db, projectId, existing.milestone_id),
      },
    })
    return
  }

  const { milestoneName } = validateTaskAndMilestone(db, projectId, taskId, milestoneId)
  if (completeTask) {
    if (taskId === null) throw invalidInput('completeTask 需要同时提供 taskId')
    if (expectedTaskRevision === null) throw invalidInput('completeTask 需要 expectedTaskRevision')
  }

  const evidenceId = newId('evd', now.getTime())
  const doubtId = stillUnsure === null ? null : newId('dbt', now.getTime())

  const response = transaction(db, () => {
    if (taskId !== null) {
      const task = getTask(db, projectId, taskId)
      if (completeTask) {
        if (task.revision !== expectedTaskRevision) {
          throw new V3Error('STALE_REVISION', {
            projectId,
            currentProjectRevision: project.project_revision,
            currentEntityRevision: task.revision,
          })
        }
        if (task.archived_at !== null) throw new V3Error('TASK_ARCHIVED')
        if (task.status !== 'done') {
          db.prepare(
            `UPDATE tasks
                SET status = 'done', completed_at = ?, revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND project_id = ?`,
          ).run(nowText, nowText, taskId, projectId)
        }
      }
    }

    db.prepare(
      `INSERT INTO evidence
         (evidence_id, project_id, task_id, milestone_id, milestone_name_snapshot, user_id,
          submission_id, did_what, found_what, still_unsure, attachment_name, status,
          author_user_id, revision, created_at, updated_at, redacted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, NULL)`,
    ).run(
      evidenceId,
      projectId,
      taskId,
      milestoneId,
      milestoneName,
      userId,
      submissionId,
      didWhat,
      foundWhat,
      stillUnsure,
      attachmentName,
      userId,
      nowText,
      nowText,
    )

    if (doubtId !== null && stillUnsure !== null) {
      db.prepare(
        `INSERT INTO doubts
           (doubt_id, project_id, milestone_id, task_id, user_id, text, status,
            source_evidence_id, revision, created_at, updated_at, resolved_at, resolved_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, NULL, NULL)`,
      ).run(doubtId, projectId, milestoneId, taskId, userId, stillUnsure, evidenceId, nowText, nowText)
    }

    const revision = bumpProjectRevision(db, projectId, nowText)
    const evidence = getEvidence(db, projectId, evidenceId)
    const task = taskId === null ? null : getTask(db, projectId, taskId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      replayed: false,
      data: {
        evidence: toEvidenceDto(evidence),
        doubt:
          doubtId === null
            ? null
            : {
                doubtId,
                text: stillUnsure,
                status: 'open',
                sourceEvidenceId: evidenceId,
                createdAt: nowText,
              },
        task: completeTask && task !== null ? toTaskDto(db, task) : null,
        milestoneStats:
          milestoneId === null ? null : milestoneTaskStats(db, projectId, milestoneId),
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

export async function handleEvidenceLinks(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  evidenceId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const expected = requireExpectedRevision(envelope)
  const taskId = readNullableId(body, 'taskId')
  const milestoneId = readNullableId(body, 'milestoneId')

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
  const evidence = getEvidence(db, projectId, evidenceId)
  if (evidence.revision !== expected) {
    throw new V3Error('STALE_REVISION', {
      projectId,
      currentProjectRevision: project.project_revision,
      currentEntityRevision: evidence.revision,
    })
  }

  const { milestoneName } = validateTaskAndMilestone(db, projectId, taskId, milestoneId)
  const sameLinks = evidence.task_id === taskId && evidence.milestone_id === milestoneId

  const response = transaction(db, () => {
    let changed = false
    if (!sameLinks) {
      db.prepare(
        `UPDATE evidence
            SET task_id = ?, milestone_id = ?, milestone_name_snapshot = ?,
                revision = revision + 1, updated_at = ?
          WHERE evidence_id = ? AND project_id = ?`,
      ).run(taskId, milestoneId, milestoneName, nowText, evidenceId, projectId)
      changed = true
    }

    const revision = changed
      ? bumpProjectRevision(db, projectId, nowText)
      : project.project_revision
    const updated = getEvidence(db, projectId, evidenceId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      changed,
      replayed: false,
      data: {
        evidence: toEvidenceDto(updated),
        milestoneStats:
          milestoneId === null ? null : milestoneTaskStats(db, projectId, milestoneId),
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

export async function handleEvidenceList(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const taskId = queryParam(url, 'taskId')
  const milestoneId = queryParam(url, 'milestoneId')
  const includeArchived = queryParam(url, 'includeArchived') === 'true'
  const limit = parseLimit(queryParam(url, 'limit'))
  const cursorRaw = queryParam(url, 'cursor')

  if (taskId !== null) getTask(db, projectId, taskId)
  if (milestoneId !== null) getMilestone(db, projectId, milestoneId)

  const conditions: string[] = ['e.project_id = ?']
  const params: Array<string | number> = [projectId]
  if (taskId !== null) {
    conditions.push('e.task_id = ?')
    params.push(taskId)
  }
  if (milestoneId !== null) {
    conditions.push('e.milestone_id = ?')
    params.push(milestoneId)
  }
  if (!includeArchived) {
    conditions.push(
      `(e.milestone_id IS NULL OR EXISTS (
          SELECT 1 FROM milestones m
           WHERE m.milestone_id = e.milestone_id AND m.archived_at IS NULL))`,
    )
    conditions.push(
      `(e.task_id IS NULL OR EXISTS (
          SELECT 1 FROM tasks t
           WHERE t.task_id = e.task_id AND t.archived_at IS NULL))`,
    )
  }
  if (cursorRaw !== null) {
    const cursor = decodeCursor(cursorRaw)
    conditions.push(
      '(e.created_at < ? OR (e.created_at = ? AND e.evidence_id < ?))',
    )
    params.push(cursor.createdAt, cursor.createdAt, cursor.evidenceId)
  }
  params.push(limit + 1)

  const rows = db
    .prepare(
      `SELECT e.* FROM evidence e
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.created_at DESC, e.evidence_id DESC
        LIMIT ?`,
    )
    .all(...params) as EvidenceRow[]

  const items = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && items.length > 0
      ? encodeCursor(items[items.length - 1] as EvidenceRow)
      : null

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: { evidence: items.map(toEvidenceDto), nextCursor },
  })
}

interface EvidenceCursor {
  createdAt: string
  evidenceId: string
}

function encodeCursor(row: EvidenceRow): string {
  return Buffer.from(
    JSON.stringify({ c: row.created_at, e: row.evidence_id }),
    'utf8',
  ).toString('base64url')
}

function decodeCursor(raw: string): EvidenceCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof parsed.c !== 'string' || typeof parsed.e !== 'string') throw new Error('bad cursor')
    return { createdAt: parsed.c, evidenceId: parsed.e }
  } catch {
    throw invalidInput('cursor 不合法')
  }
}
