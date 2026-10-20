import type { ServerResponse } from 'node:http'
import type { V3Database } from './db.js'
import { getMilestone, getTask, loadProject, toTaskDto, type TaskRow } from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import { parseLimit, queryParam, sendV3Json } from './http.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/** 任务只读接口（PR2B 第一阶段） */

function includeArchived(url: URL): boolean {
  return queryParam(url, 'includeArchived') === 'true'
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('bad cursor')
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.createdAt !== 'string' || typeof record.taskId !== 'string') {
      throw new Error('bad cursor')
    }
    return { createdAt: record.createdAt, taskId: record.taskId }
  } catch {
    throw invalidInput('cursor 不合法')
  }
}

function milestoneIsArchived(
  db: V3Database,
  projectId: string,
  milestoneId: string | null,
): boolean {
  if (milestoneId === null) return false
  const row = db
    .prepare(
      'SELECT archived_at FROM milestones WHERE milestone_id = ? AND project_id = ?',
    )
    .get(milestoneId, projectId) as { archived_at: string | null } | undefined
  // 非空 milestoneId 却查不到阶段属于数据异常，按不可见处理，避免泄露孤儿数据
  return row === undefined || row.archived_at !== null
}

export async function handleTaskList(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const include = includeArchived(url)
  const limit = parseLimit(queryParam(url, 'limit'))
  const milestoneId = queryParam(url, 'milestoneId')
  const status = queryParam(url, 'status')
  const cursorRaw = queryParam(url, 'cursor')

  if (milestoneId !== null) getMilestone(db, projectId, milestoneId)
  if (status !== null && !['todo', 'doing', 'done'].includes(status)) {
    throw invalidInput('status 只能是 todo、doing 或 done')
  }

  const conditions = ['t.project_id = ?']
  const params: Array<string | number> = [projectId]
  if (!include) {
    conditions.push('t.archived_at IS NULL')
    conditions.push(
      `(t.milestone_id IS NULL OR EXISTS (
         SELECT 1 FROM milestones m
          WHERE m.milestone_id = t.milestone_id
            AND m.project_id = t.project_id
            AND m.archived_at IS NULL))`,
    )
  }
  if (milestoneId !== null) {
    conditions.push('t.milestone_id = ?')
    params.push(milestoneId)
  }
  if (status !== null) {
    conditions.push('t.status = ?')
    params.push(status)
  }
  if (cursorRaw !== null) {
    const cursor = decodeCursor(cursorRaw)
    conditions.push(
      '(t.created_at < ? OR (t.created_at = ? AND t.task_id < ?))',
    )
    params.push(cursor.createdAt, cursor.createdAt, cursor.taskId)
  }
  params.push(limit + 1)

  const rows = db
    .prepare(
      `SELECT t.* FROM tasks t
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.created_at DESC, t.task_id DESC
        LIMIT ?`,
    )
    .all(...params) as TaskRow[]

  const items = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && items.length > 0
      ? encodeCursor({
          createdAt: items[items.length - 1]?.created_at as string,
          taskId: items[items.length - 1]?.task_id as string,
        })
      : null

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: {
      tasks: items.map((row) => toTaskDto(db, row)),
      nextCursor,
    },
  })
}

export async function handleTaskGet(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  taskId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const task = getTask(db, projectId, taskId)
  const include = includeArchived(url)

  if (!include) {
    if (task.archived_at !== null) throw new V3Error('RESOURCE_NOT_FOUND')
    if (milestoneIsArchived(db, projectId, task.milestone_id)) {
      throw new V3Error('RESOURCE_NOT_FOUND')
    }
  }

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: { task: toTaskDto(db, task) },
  })
}
