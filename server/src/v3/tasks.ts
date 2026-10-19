import type { IncomingMessage, ServerResponse } from 'node:http'
import { transaction, type V3Database } from './db.js'
import {
  assertProjectRevision,
  bumpProjectRevision,
  getMilestone,
  getTask,
  loadProject,
  milestoneTaskStats,
  optionalBoolean,
  optionalText,
  recalcCurrentMilestone,
  requiredText,
  toTaskDto,
  type MilestoneRow,
  type TaskRow,
} from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import {
  bodyReadError,
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

/** 任务（docs/contracts.md 22.3） */

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, 256 * 1024))
  } catch (error) {
    throw bodyReadError(error)
  }
}

function nextOrderIndex(db: V3Database, projectId: string, milestoneId: string | null): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(order_index), -1) AS maxIndex FROM tasks
        WHERE project_id = ? AND archived_at IS NULL
          AND ((? IS NULL AND milestone_id IS NULL) OR milestone_id = ?)`,
    )
    .get(projectId, milestoneId, milestoneId) as { maxIndex: number }
  return row.maxIndex + 1
}

/** 目标阶段为 completed 时，必须显式 reopenMilestone */
function applyTargetMilestone(
  db: V3Database,
  milestone: MilestoneRow,
  reopenMilestone: boolean,
  nowText: string,
): void {
  if (milestone.status === 'archived') throw new V3Error('MILESTONE_ARCHIVED')
  if (milestone.status === 'completed') {
    if (!reopenMilestone) throw new V3Error('MILESTONE_COMPLETED')
    db.prepare(
      `UPDATE milestones
          SET status = 'active', completed_at = NULL, revision = revision + 1, updated_at = ?
        WHERE milestone_id = ? AND project_id = ?`,
    ).run(nowText, milestone.milestone_id, milestone.project_id)
  }
}

function milestoneStatsOrNull(
  db: V3Database,
  projectId: string,
  milestoneId: string | null,
): ReturnType<typeof milestoneTaskStats> | null {
  return milestoneId === null ? null : milestoneTaskStats(db, projectId, milestoneId)
}

export async function handleTaskCreate(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const title = requiredText(body.title, 60, 'title')
  const doneCriteria = optionalText(body.doneCriteria, 200, 'doneCriteria')
  const milestoneIdRaw = body.milestoneId
  if (milestoneIdRaw !== undefined && milestoneIdRaw !== null && typeof milestoneIdRaw !== 'string') {
    throw invalidInput('milestoneId 必须是字符串或 null')
  }
  const milestoneId = typeof milestoneIdRaw === 'string' && milestoneIdRaw !== '' ? milestoneIdRaw : null
  const statusRaw = body.status ?? 'todo'
  if (statusRaw !== 'todo' && statusRaw !== 'doing') {
    throw invalidInput('status 只能是 todo 或 doing')
  }
  const status = statusRaw
  const reopenMilestone = optionalBoolean(body.reopenMilestone, 'reopenMilestone')

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: 'task.create',
    resource: projectId,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)

  if (milestoneId !== null) {
    const milestone = getMilestone(db, projectId, milestoneId)
    if (milestone.status === 'archived') throw new V3Error('MILESTONE_ARCHIVED')
    if (milestone.status === 'completed' && !reopenMilestone) {
      throw new V3Error('MILESTONE_COMPLETED')
    }
  }

  const taskId = newId('tsk', now.getTime())
  const response = transaction(db, () => {
    assertProjectRevision(loadProject(db, userId, projectId), envelope.projectRevision)
    if (milestoneId !== null) {
      applyTargetMilestone(db, getMilestone(db, projectId, milestoneId), reopenMilestone, nowText)
      recalcCurrentMilestone(db, projectId)
    }

    db.prepare(
      `INSERT INTO tasks
         (task_id, project_id, milestone_id, user_id, title, done_criteria, status,
          assignee_user_id, order_index, source, revision, created_at, updated_at,
          started_at, completed_at, archived_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'manual', 1, ?, ?, ?, NULL, NULL, ?)`,
    ).run(
      taskId,
      projectId,
      milestoneId,
      userId,
      title,
      doneCriteria,
      status,
      nextOrderIndex(db, projectId, milestoneId),
      nowText,
      nowText,
      status === 'doing' ? nowText : null,
      userId,
    )

    const revision = bumpProjectRevision(db, projectId, nowText)
    const created = getTask(db, projectId, taskId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      replayed: false,
      data: {
        task: toTaskDto(db, created),
        milestoneStats: milestoneStatsOrNull(db, projectId, milestoneId),
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

export async function handleTaskPatch(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  taskId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const expected = requireExpectedRevision(envelope)
  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'PATCH',
    operation: 'task.patch',
    resource: `${projectId}/${taskId}`,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)
  const task = getTask(db, projectId, taskId)
  if (task.revision !== expected) {
    throw new V3Error('STALE_REVISION', {
      projectId,
      currentProjectRevision: project.project_revision,
      currentEntityRevision: task.revision,
    })
  }
  if (task.archived_at !== null) throw new V3Error('TASK_ARCHIVED')

  const hasTitle = body.title !== undefined
  const hasDone = body.doneCriteria !== undefined
  if (!hasTitle && !hasDone) throw invalidInput('至少提供一个可编辑字段')

  const title = hasTitle ? requiredText(body.title, 60, 'title') : task.title
  const doneCriteria = hasDone ? optionalText(body.doneCriteria, 200, 'doneCriteria') : task.done_criteria

  const response = transaction(db, () => {
    db.prepare(
      `UPDATE tasks
          SET title = ?, done_criteria = ?, revision = revision + 1, updated_at = ?
        WHERE task_id = ? AND project_id = ?`,
    ).run(title, doneCriteria, nowText, taskId, projectId)
    const revision = bumpProjectRevision(db, projectId, nowText)
    const updated = getTask(db, projectId, taskId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      replayed: false,
      data: {
        task: toTaskDto(db, updated),
        milestoneStats: milestoneStatsOrNull(db, projectId, updated.milestone_id),
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

export async function handleTaskLinkMilestone(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  taskId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const expected = requireExpectedRevision(envelope)
  const milestoneIdRaw = body.milestoneId
  if (milestoneIdRaw !== undefined && milestoneIdRaw !== null && typeof milestoneIdRaw !== 'string') {
    throw invalidInput('milestoneId 必须是字符串或 null')
  }
  const milestoneId = typeof milestoneIdRaw === 'string' && milestoneIdRaw !== '' ? milestoneIdRaw : null
  const reopenMilestone = optionalBoolean(body.reopenMilestone, 'reopenMilestone')

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: 'task.link-milestone',
    resource: `${projectId}/${taskId}`,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)
  const task = getTask(db, projectId, taskId)
  if (task.revision !== expected) {
    throw new V3Error('STALE_REVISION', {
      projectId,
      currentProjectRevision: project.project_revision,
      currentEntityRevision: task.revision,
    })
  }
  if (task.archived_at !== null) throw new V3Error('TASK_ARCHIVED')

  if (milestoneId !== null) {
    const target = getMilestone(db, projectId, milestoneId)
    if (target.status === 'archived') throw new V3Error('MILESTONE_ARCHIVED')
    if (target.status === 'completed' && !reopenMilestone) {
      throw new V3Error('MILESTONE_COMPLETED')
    }
  }

  const sourceMilestoneId = task.milestone_id
  const sameTarget = sourceMilestoneId === milestoneId

  const response = transaction(db, () => {
    let changed = false
    if (!sameTarget) {
      if (milestoneId !== null) {
        applyTargetMilestone(db, getMilestone(db, projectId, milestoneId), reopenMilestone, nowText)
        recalcCurrentMilestone(db, projectId)
      }
      db.prepare(
        `UPDATE tasks
            SET milestone_id = ?, order_index = ?, revision = revision + 1, updated_at = ?
          WHERE task_id = ? AND project_id = ?`,
      ).run(
        milestoneId,
        nextOrderIndex(db, projectId, milestoneId),
        nowText,
        taskId,
        projectId,
      )
      changed = true
    }

    const revision = changed
      ? bumpProjectRevision(db, projectId, nowText)
      : project.project_revision
    const updated = getTask(db, projectId, taskId)
    const targetStats = milestoneStatsOrNull(db, projectId, milestoneId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      changed,
      replayed: false,
      data: {
        task: toTaskDto(db, updated),
        milestoneStats: targetStats,
        sourceMilestoneStats: milestoneStatsOrNull(db, projectId, sourceMilestoneId),
        targetMilestoneStats: targetStats,
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

const TASK_ACTIONS = new Set(['start', 'complete', 'reopen', 'archive', 'restore'])

export async function handleTaskAction(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  taskId: string,
  action: string,
): Promise<void> {
  if (!TASK_ACTIONS.has(action)) throw new V3Error('RESOURCE_NOT_FOUND')
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const expected = requireExpectedRevision(envelope)
  const targetStatusRaw = body.targetStatus ?? 'doing'
  if (action === 'reopen' && targetStatusRaw !== 'doing' && targetStatusRaw !== 'todo') {
    throw invalidInput('targetStatus 只能是 doing 或 todo')
  }

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: `task.${action}`,
    resource: `${projectId}/${taskId}`,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectRevision(project, envelope.projectRevision)
  const task = getTask(db, projectId, taskId)
  if (task.revision !== expected) {
    throw new V3Error('STALE_REVISION', {
      projectId,
      currentProjectRevision: project.project_revision,
      currentEntityRevision: task.revision,
    })
  }

  const response = transaction(db, () => {
    const current = getTask(db, projectId, taskId)
    let changed = false
    let nextStatus = current.status
    let startedAt = current.started_at
    let completedAt = current.completed_at
    let archivedAt = current.archived_at

    if (action === 'start') {
      if (current.archived_at !== null) throw new V3Error('TASK_ARCHIVED')
      if (current.status === 'todo') {
        nextStatus = 'doing'
        startedAt = startedAt ?? nowText
        changed = true
      } else if (current.status !== 'doing') {
        throw new V3Error('INVALID_STATE_TRANSITION')
      }
    } else if (action === 'complete') {
      if (current.archived_at !== null) throw new V3Error('TASK_ARCHIVED')
      if (current.status !== 'done') {
        nextStatus = 'done'
        completedAt = nowText
        changed = true
      }
    } else if (action === 'reopen') {
      if (current.archived_at !== null) throw new V3Error('TASK_ARCHIVED')
      const targetStatus = targetStatusRaw as 'doing' | 'todo'
      if (current.status === targetStatus) {
        // 目标状态已满足：幂等
      } else if (current.status === 'done') {
        nextStatus = targetStatus
        completedAt = null
        changed = true
      } else {
        throw new V3Error('INVALID_STATE_TRANSITION')
      }
    } else if (action === 'archive') {
      if (current.archived_at === null) {
        archivedAt = nowText
        changed = true
      }
    } else if (action === 'restore') {
      if (current.archived_at !== null) {
        archivedAt = null
        changed = true
      }
    }

    if (changed) {
      db.prepare(
        `UPDATE tasks
            SET status = ?, started_at = ?, completed_at = ?, archived_at = ?,
                revision = revision + 1, updated_at = ?
          WHERE task_id = ? AND project_id = ?`,
      ).run(nextStatus, startedAt, completedAt, archivedAt, nowText, taskId, projectId)
    }

    const revision = changed
      ? bumpProjectRevision(db, projectId, nowText)
      : project.project_revision
    const updated = getTask(db, projectId, taskId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: revision,
      changed,
      replayed: false,
      data: {
        task: toTaskDto(db, updated),
        milestoneStats: milestoneStatsOrNull(db, projectId, updated.milestone_id),
      },
    })
    saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    return payload
  })

  sendV3Json(res, 200, response)
}

export type { TaskRow }
