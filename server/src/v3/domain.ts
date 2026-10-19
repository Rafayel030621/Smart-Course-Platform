import type { V3Database } from './db.js'
import { V3Error, invalidInput } from './errors.js'
import { isSqliteUniqueError } from './http.js'

/**
 * V3 领域共享逻辑
 * ----------------------------------------------------------------------------
 * 行类型、DTO 映射、任务统计、项目版本递增、当前阶段推导。
 * 所有查询都带 projectId（以及必要的 userId），禁止只按实体 ID 读取。
 */

export interface ProjectRow {
  project_id: string
  owner_user_id: string
  name: string
  short: string
  profile_json: string
  status: string
  visibility: string
  project_revision: number
  current_milestone_id: string | null
  last_activity_at: string
  created_at: string
  updated_at: string
  archived_at: string | null
  deleted_at: string | null
  purge_after: string | null
  migrated_from_revision: number | null
  created_by_user_id: string
}

export interface MilestoneRow {
  milestone_id: string
  project_id: string
  user_id: string
  name: string
  name_key: string
  goal: string | null
  done_criteria: string | null
  due_at: string | null
  status: string
  order_index: number
  source: string
  revision: number
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
  archived_from_status: string | null
  created_by_user_id: string
}

export interface TaskRow {
  task_id: string
  project_id: string
  milestone_id: string | null
  user_id: string
  title: string
  done_criteria: string | null
  status: string
  assignee_user_id: string | null
  order_index: number
  source: string
  revision: number
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
  archived_at: string | null
  created_by_user_id: string
}

export interface EvidenceRow {
  evidence_id: string
  project_id: string
  task_id: string | null
  milestone_id: string | null
  milestone_name_snapshot: string | null
  user_id: string
  submission_id: string
  did_what: string
  found_what: string | null
  still_unsure: string | null
  attachment_name: string | null
  status: string
  author_user_id: string
  revision: number
  created_at: string
  updated_at: string
  redacted_at: string | null
}

export interface ProgressRow {
  progress_id: string
  project_id: string
  milestone_id: string | null
  task_id: string | null
  user_id: string
  summary: string
  evidence_ids_json: string
  occurred_at: string
  status: string
  supersedes_progress_id: string | null
  author_user_id: string
  revision: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface MaterialRow {
  material_id: string
  material_version: number
  project_id: string
  user_id: string
  name: string
  type: string
  size: number
  encoding: string
  status: string
  revision: number
  sha256: string | null
  failure_reason: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface UnderstandingItemRow {
  item_id: string
  client_item_id: string | null
  project_id: string
  material_id: string
  material_version: number
  kind: string
  text: string
  original_text: string
  sources_json: string
  status: string
  source: string
  revision: number
  created_at: string
  updated_at: string
  confirmed_at: string | null
  confirmed_by_user_id: string | null
  removed_at: string | null
}

export interface UnderstandingSourceSegment {
  segmentId: string
  materialId: string
  materialVersion: number
  startLine: number
  endLine: number
  text: string
}

export interface ProjectProfile {
  goal: string | null
  expectedOutcome: string | null
  memberNames: string[]
  researchPeriod: string | null
  scope: string | null
  outOfScope: string | null
}

export interface TaskStats {
  total: number
  done: number
  doing: number
  todo: number
  archived: number
  progress: number
}

export const EMPTY_TASK_STATS: TaskStats = {
  total: 0,
  done: 0,
  doing: 0,
  todo: 0,
  archived: 0,
  progress: 0,
}

/* --------------------------------------------------------------- 文本校验 */

export function codePointLength(value: string): number {
  return [...value].length
}

/**
 * 有效正文判断：必须是字符串且 trim 后非空。
 * JS trim 覆盖普通空格、Tab、换行、回车、全角空格等 Unicode 空白。
 */
export function isMeaningfulText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function requiredText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw invalidInput(`${field} 为必填项`)
  const trimmed = value.trim()
  if (trimmed === '') throw invalidInput(`${field} 不能为空`)
  if (codePointLength(trimmed) > max) throw invalidInput(`${field} 不能超过 ${max} 字`)
  return trimmed
}

export function optionalText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalidInput(`${field} 必须为字符串或 null`)
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (codePointLength(trimmed) > max) throw invalidInput(`${field} 不能超过 ${max} 字`)
  return trimmed
}

export function optionalIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalidInput(`${field} 必须是 ISO 8601 时间`)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw invalidInput(`${field} 必须是 ISO 8601 时间`)
  return date.toISOString()
}

export function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw invalidInput(`${field} 必须是布尔值`)
  return value
}

export function normalizeNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function shortFromName(name: string): string {
  const characters = [...name.trim()]
  if (characters.length <= 12) return characters.join('')
  return `${characters.slice(0, 12).join('')}…`
}

export function parseProfile(value: unknown): ProjectProfile {
  if (value === undefined || value === null) {
    return {
      goal: null,
      expectedOutcome: null,
      memberNames: [],
      researchPeriod: null,
      scope: null,
      outOfScope: null,
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw invalidInput('profile 必须是对象')
  const record = value as Record<string, unknown>
  const memberNamesRaw = record.memberNames
  let memberNames: string[] = []
  if (memberNamesRaw !== undefined && memberNamesRaw !== null) {
    if (!Array.isArray(memberNamesRaw)) throw invalidInput('profile.memberNames 必须是数组')
    memberNames = memberNamesRaw.map((item) => {
      if (typeof item !== 'string') throw invalidInput('profile.memberNames 只能包含字符串')
      return item.trim()
    })
  }
  return {
    goal: optionalText(record.goal, 300, 'profile.goal'),
    expectedOutcome: optionalText(record.expectedOutcome, 300, 'profile.expectedOutcome'),
    memberNames,
    researchPeriod: optionalText(record.researchPeriod, 100, 'profile.researchPeriod'),
    scope: optionalText(record.scope, 300, 'profile.scope'),
    outOfScope: optionalText(record.outOfScope, 300, 'profile.outOfScope'),
  }
}

export function profileFromJson(value: string): ProjectProfile {
  try {
    return JSON.parse(value) as ProjectProfile
  } catch {
    return {
      goal: null,
      expectedOutcome: null,
      memberNames: [],
      researchPeriod: null,
      scope: null,
      outOfScope: null,
    }
  }
}

/* --------------------------------------------------------------- 读取实体 */

export function loadProject(
  db: V3Database,
  userId: string,
  projectId: string,
  options: { includeDeleted?: boolean } = {},
): ProjectRow {
  const row = db
    .prepare('SELECT * FROM projects WHERE project_id = ? AND owner_user_id = ?')
    .get(projectId, userId) as ProjectRow | undefined
  if (row === undefined) throw new V3Error('PROJECT_NOT_FOUND')
  if (row.status === 'deleted' && options.includeDeleted !== true) {
    throw new V3Error('PROJECT_NOT_FOUND')
  }
  return row
}

export function assertProjectRevision(project: ProjectRow, revision: number): void {
  if (project.project_revision !== revision) {
    throw new V3Error('STALE_REVISION', {
      projectId: project.project_id,
      currentProjectRevision: project.project_revision,
    })
  }
}

/** 所有领域写接口在 loadProject 后必须调用；恢复/删除项目本身例外 */
export function assertProjectWritable(project: ProjectRow): void {
  if (project.status === 'archived') throw new V3Error('PROJECT_ARCHIVED')
}

/** 成功领域写操作递增 projectRevision；一次事务只调用一次 */
export function bumpProjectRevision(db: V3Database, projectId: string, nowText: string): number {
  db.prepare(
    `UPDATE projects
        SET project_revision = project_revision + 1,
            last_activity_at = ?,
            updated_at = ?
      WHERE project_id = ?`,
  ).run(nowText, nowText, projectId)
  const row = db
    .prepare('SELECT project_revision FROM projects WHERE project_id = ?')
    .get(projectId) as { project_revision: number } | undefined
  return row?.project_revision ?? 0
}

export function recalcCurrentMilestone(db: V3Database, projectId: string): string | null {
  const active = db
    .prepare(
      `SELECT milestone_id FROM milestones
        WHERE project_id = ? AND archived_at IS NULL AND status = 'active'
        ORDER BY order_index ASC, created_at ASC LIMIT 1`,
    )
    .get(projectId) as { milestone_id: string } | undefined

  let current: string | null = active?.milestone_id ?? null
  if (current === null) {
    const planned = db
      .prepare(
        `SELECT milestone_id FROM milestones
          WHERE project_id = ? AND archived_at IS NULL AND status = 'planned'
          ORDER BY order_index ASC, created_at ASC LIMIT 1`,
      )
      .get(projectId) as { milestone_id: string } | undefined
    current = planned?.milestone_id ?? null
  }

  db.prepare('UPDATE projects SET current_milestone_id = ? WHERE project_id = ?').run(current, projectId)
  return current
}

export function getMilestone(db: V3Database, projectId: string, milestoneId: string): MilestoneRow {
  const row = db
    .prepare('SELECT * FROM milestones WHERE milestone_id = ? AND project_id = ?')
    .get(milestoneId, projectId) as MilestoneRow | undefined
  if (row === undefined) throw new V3Error('RESOURCE_NOT_FOUND')
  return row
}

export function getTask(db: V3Database, projectId: string, taskId: string): TaskRow {
  const row = db
    .prepare('SELECT * FROM tasks WHERE task_id = ? AND project_id = ?')
    .get(taskId, projectId) as TaskRow | undefined
  if (row === undefined) throw new V3Error('RESOURCE_NOT_FOUND')
  return row
}

export function getEvidence(db: V3Database, projectId: string, evidenceId: string): EvidenceRow {
  const row = db
    .prepare('SELECT * FROM evidence WHERE evidence_id = ? AND project_id = ?')
    .get(evidenceId, projectId) as EvidenceRow | undefined
  if (row === undefined) throw new V3Error('RESOURCE_NOT_FOUND')
  return row
}

export function getProgress(
  db: V3Database,
  projectId: string,
  progressId: string,
): ProgressRow {
  const row = db
    .prepare('SELECT * FROM progress_records WHERE progress_id = ? AND project_id = ?')
    .get(progressId, projectId) as ProgressRow | undefined
  if (row === undefined) throw new V3Error('RESOURCE_NOT_FOUND')
  return row
}

/** 理解条目 sources_json 中声明的 segmentId；其余元数据一律不可信 */
function requestedSourceSegmentIds(item: UnderstandingItemRow): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(item.sources_json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const ids = parsed
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .map((entry) => (typeof entry.segmentId === 'string' ? entry.segmentId : ''))
    .filter((segmentId) => segmentId !== '')
  return [...new Set(ids)]
}

/**
 * 只返回数据库中与条目 materialId + materialVersion 匹配、且正文有效的片段。
 * sources_json 中的 materialId、版本、行号等元数据不参与信任判断。
 */
export function resolveUnderstandingSourceSegments(
  db: V3Database,
  item: UnderstandingItemRow,
): UnderstandingSourceSegment[] {
  const statement = db.prepare(
    `SELECT segment_id, material_id, material_version, start_line, end_line, text
       FROM material_segments
      WHERE material_id = ? AND material_version = ? AND segment_id = ?`,
  )
  const segments: UnderstandingSourceSegment[] = []
  for (const segmentId of requestedSourceSegmentIds(item)) {
    const row = statement.get(
      item.material_id,
      item.material_version,
      segmentId,
    ) as
      | {
          segment_id: string
          material_id: string
          material_version: number
          start_line: number
          end_line: number
          text: string
        }
      | undefined
    if (row === undefined || !isMeaningfulText(row.text)) continue
    segments.push({
      segmentId: row.segment_id,
      materialId: row.material_id,
      materialVersion: row.material_version,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
    })
  }
  return segments
}

export function hasValidUnderstandingSource(db: V3Database, item: UnderstandingItemRow): boolean {
  return resolveUnderstandingSourceSegments(db, item).length > 0
}

export interface UnderstandingItemDto {
  itemId: string
  kind: string
  text: string
  originalText: string
  sources: Array<{
    materialId: string
    materialName: string
    materialVersion: number
    segmentId: string
    startLine: number
    endLine: number
  }>
  status: string
  revision: number
  confirmedAt: string | null
  confirmedByUserId: string | null
  removedAt: string | null
}

export function toUnderstandingItemDto(
  db: V3Database,
  item: UnderstandingItemRow,
  materialName: string,
): UnderstandingItemDto {
  const sources = resolveUnderstandingSourceSegments(db, item).map((segment) => ({
    materialId: item.material_id,
    materialName,
    materialVersion: item.material_version,
    segmentId: segment.segmentId,
    startLine: segment.startLine,
    endLine: segment.endLine,
  }))

  return {
    itemId: item.item_id,
    kind: item.kind,
    text: item.text,
    originalText: item.original_text,
    sources,
    status: item.status,
    revision: item.revision,
    confirmedAt: item.confirmed_at,
    confirmedByUserId: item.confirmed_by_user_id,
    removedAt: item.removed_at,
  }
}

export function requireTaskMilestone(db: V3Database, projectId: string, milestoneId: string): MilestoneRow {
  const milestone = getMilestone(db, projectId, milestoneId)
  return milestone
}

export interface EffectiveStage {
  milestoneId: string | null
  milestone: MilestoneRow | null
}

/**
 * 解析“任务/证据/进展实际归属的阶段”。
 *
 * 客户端漏传 milestoneId 时不能绕过任务自身的阶段归档限制：
 * - 任务有阶段：以数据库中的任务归属为准；
 * - 显式传了不同阶段：拒绝（同用户跨阶段引用）；
 * - 任务没有阶段：允许显式指定一个同项目阶段；
 * - 任务已归档：拒绝提交/链接/更正。
 */
export function resolveEffectiveStage(
  db: V3Database,
  projectId: string,
  taskId: string | null,
  requestedMilestoneId: string | null,
): EffectiveStage {
  let task: TaskRow | null = null
  if (taskId !== null) {
    task = getTask(db, projectId, taskId)
    if (task.archived_at !== null) throw new V3Error('TASK_ARCHIVED')
  }

  const taskStage = task?.milestone_id ?? null
  if (requestedMilestoneId !== null && taskStage !== null && requestedMilestoneId !== taskStage) {
    throw invalidInput('任务的当前阶段与 milestoneId 不一致')
  }

  const milestoneId = requestedMilestoneId ?? taskStage
  if (milestoneId === null) return { milestoneId: null, milestone: null }
  return { milestoneId, milestone: getMilestone(db, projectId, milestoneId) }
}

export function assertStageWritable(stage: EffectiveStage): void {
  if (stage.milestone?.status === 'archived') throw new V3Error('MILESTONE_ARCHIVED')
}

/* ------------------------------------------------------------------ 统计 */

export function milestoneTaskStats(
  db: V3Database,
  projectId: string,
  milestoneId: string,
): TaskStats {
  const active = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END) AS doing,
         SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo
       FROM tasks
       WHERE project_id = ? AND milestone_id = ? AND archived_at IS NULL`,
    )
    .get(projectId, milestoneId) as {
    total: number
    done: number | null
    doing: number | null
    todo: number | null
  }

  const archived = db
    .prepare(
      `SELECT COUNT(*) AS count FROM tasks
        WHERE project_id = ? AND milestone_id = ? AND archived_at IS NOT NULL`,
    )
    .get(projectId, milestoneId) as { count: number }

  const total = active.total
  const done = active.done ?? 0
  return {
    total,
    done,
    doing: active.doing ?? 0,
    todo: active.todo ?? 0,
    archived: archived.count,
    progress: total === 0 ? 0 : Math.floor((done * 100) / total),
  }
}

export function projectTaskStats(db: V3Database, projectId: string): TaskStats {
  const active = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN t.status = 'doing' THEN 1 ELSE 0 END) AS doing,
         SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo
       FROM tasks t
       WHERE t.project_id = ? AND t.archived_at IS NULL
         AND (t.milestone_id IS NULL OR EXISTS (
           SELECT 1 FROM milestones m
            WHERE m.milestone_id = t.milestone_id AND m.archived_at IS NULL))`,
    )
    .get(projectId) as {
    total: number
    done: number | null
    doing: number | null
    todo: number | null
  }

  const archived = db
    .prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND archived_at IS NOT NULL')
    .get(projectId) as { count: number }

  const total = active.total
  const done = active.done ?? 0
  return {
    total,
    done,
    doing: active.doing ?? 0,
    todo: active.todo ?? 0,
    archived: archived.count,
    progress: total === 0 ? 0 : Math.floor((done * 100) / total),
  }
}

/* ------------------------------------------------------------------- DTO */

export interface MilestoneDto {
  milestoneId: string
  name: string
  goal: string | null
  doneCriteria: string | null
  dueAt: string | null
  status: string
  orderIndex: number
  revision: number
  source: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  archivedAt: string | null
  taskStats: TaskStats
}

export function toMilestoneDto(
  db: V3Database,
  row: MilestoneRow,
  stats?: TaskStats,
): MilestoneDto {
  return {
    milestoneId: row.milestone_id,
    name: row.name,
    goal: row.goal,
    doneCriteria: row.done_criteria,
    dueAt: row.due_at,
    status: row.status,
    orderIndex: row.order_index,
    revision: row.revision,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
    taskStats: stats ?? milestoneTaskStats(db, row.project_id, row.milestone_id),
  }
}

export interface TaskDto {
  taskId: string
  projectId: string
  milestoneId: string | null
  milestoneName: string | null
  title: string
  doneCriteria: string | null
  status: string
  assigneeUserId: string | null
  orderIndex: number
  source: string
  revision: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  archivedAt: string | null
}

export function toTaskDto(db: V3Database, row: TaskRow): TaskDto {
  let milestoneName: string | null = null
  if (row.milestone_id !== null) {
    const milestone = db
      .prepare('SELECT name FROM milestones WHERE milestone_id = ? AND project_id = ?')
      .get(row.milestone_id, row.project_id) as { name: string } | undefined
    milestoneName = milestone?.name ?? null
  }
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    milestoneId: row.milestone_id,
    milestoneName,
    title: row.title,
    doneCriteria: row.done_criteria,
    status: row.status,
    assigneeUserId: row.assignee_user_id,
    orderIndex: row.order_index,
    source: row.source,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
  }
}

export interface EvidenceDto {
  evidenceId: string
  projectId: string
  taskId: string | null
  milestoneId: string | null
  milestoneNameSnapshot: string | null
  submissionId: string
  didWhat: string
  foundWhat: string | null
  stillUnsure: string | null
  attachmentName: string | null
  status: string
  revision: number
  createdAt: string
  updatedAt: string
  redactedAt: string | null
}

export function toEvidenceDto(row: EvidenceRow): EvidenceDto {
  return {
    evidenceId: row.evidence_id,
    projectId: row.project_id,
    taskId: row.task_id,
    milestoneId: row.milestone_id,
    milestoneNameSnapshot: row.milestone_name_snapshot,
    submissionId: row.submission_id,
    didWhat: row.did_what,
    foundWhat: row.found_what,
    stillUnsure: row.still_unsure,
    attachmentName: row.attachment_name,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    redactedAt: row.redacted_at,
  }
}

export interface ProjectListItem {
  projectId: string
  name: string
  short: string
  status: string
  projectRevision: number
  currentMilestoneId: string | null
  currentMilestone: string | null
  milestoneCount: number
  taskCount: number
  doneTaskCount: number
  updatedAt: string
}

export function toProjectListItem(db: V3Database, project: ProjectRow): ProjectListItem {
  const milestoneCount = db
    .prepare(
      'SELECT COUNT(*) AS count FROM milestones WHERE project_id = ? AND archived_at IS NULL',
    )
    .get(project.project_id) as { count: number }

  const stats = projectTaskStats(db, project.project_id)
  let currentMilestone: string | null = null
  if (project.current_milestone_id !== null) {
    const row = db
      .prepare('SELECT name FROM milestones WHERE milestone_id = ? AND project_id = ?')
      .get(project.current_milestone_id, project.project_id) as { name: string } | undefined
    currentMilestone = row?.name ?? null
  }

  return {
    projectId: project.project_id,
    name: project.name,
    short: project.short,
    status: project.status,
    projectRevision: project.project_revision,
    currentMilestoneId: project.current_milestone_id,
    currentMilestone,
    milestoneCount: milestoneCount.count,
    taskCount: stats.total,
    doneTaskCount: stats.done,
    updatedAt: project.updated_at,
  }
}

export interface ProjectDto {
  projectId: string
  ownerUserId: string
  name: string
  short: string
  profile: ProjectProfile
  status: string
  visibility: string
  projectRevision: number
  currentMilestoneId: string | null
  currentMilestone: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  deletedAt: string | null
  milestones: MilestoneDto[]
  taskStats: TaskStats
}

export function toProjectDto(
  db: V3Database,
  project: ProjectRow,
  options: { includeArchivedMilestones?: boolean } = {},
): ProjectDto {
  const rows = db
    .prepare(
      `SELECT * FROM milestones
        WHERE project_id = ?
          AND (? = 1 OR archived_at IS NULL)
        ORDER BY order_index ASC, created_at ASC`,
    )
    .all(project.project_id, options.includeArchivedMilestones === true ? 1 : 0) as MilestoneRow[]

  let currentMilestone: string | null = null
  if (project.current_milestone_id !== null) {
    const row = db
      .prepare('SELECT name FROM milestones WHERE milestone_id = ? AND project_id = ?')
      .get(project.current_milestone_id, project.project_id) as { name: string } | undefined
    currentMilestone = row?.name ?? null
  }

  return {
    projectId: project.project_id,
    ownerUserId: project.owner_user_id,
    name: project.name,
    short: project.short,
    profile: profileFromJson(project.profile_json),
    status: project.status,
    visibility: project.visibility,
    projectRevision: project.project_revision,
    currentMilestoneId: project.current_milestone_id,
    currentMilestone,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    archivedAt: project.archived_at,
    deletedAt: project.deleted_at,
    milestones: rows.map((row) => toMilestoneDto(db, row)),
    taskStats: projectTaskStats(db, project.project_id),
  }
}

export function projectStats(db: V3Database, projectId: string): Record<string, number> {
  const milestoneCounts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         COUNT(*) AS total
       FROM milestones WHERE project_id = ? AND archived_at IS NULL`,
    )
    .get(projectId) as { active: number | null; completed: number | null; total: number }

  const stats = projectTaskStats(db, projectId)
  return {
    milestoneCount: milestoneCounts.total,
    activeMilestoneCount: milestoneCounts.active ?? 0,
    completedMilestoneCount: milestoneCounts.completed ?? 0,
    taskTotal: stats.total,
    taskDone: stats.done,
    taskDoing: stats.doing,
    taskTodo: stats.todo,
    taskArchived: stats.archived,
    progress: stats.progress,
  }
}

export function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export { isSqliteUniqueError }
