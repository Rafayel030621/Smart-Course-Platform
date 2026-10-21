/**
 * V3 项目 / 阶段 / 任务 / 证据 / 进展接口（契约 22、24）。
 *
 * 约定：
 * - 所有写请求都带 20.1 包络（contractVersion / requestId / idempotencyKey /
 *   projectId / projectRevision）；
 * - 成功响应必须由 `requestV3Envelope` 校验后才进入 store；
 * - 这里只做“请求与解析”，不做归属/顺序等业务判断（由 cloud store 校验）；
 * - 任务列表/单条读取按契约 22.3 接入；仍缺失的读取端点（材料理解列表、时间线）**不在这里伪造**。
 */
import { normalizeProjectProfile } from '@/domain/materials'
import { V3_CONTRACT_VERSION } from '@/types/platform'
import type {
  CloudDoubt,
  CloudEvidence,
  CloudMilestone,
  CloudProject,
  CloudProjectSummary,
  CloudTask,
  LocalMigrationResponse,
  MilestoneTaskStats,
  ProjectProfile,
  ProjectTimelineItem,
  ProgressRecord,
  V3User,
} from '@/types/platform'
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  makeV3Error,
  newRequestId,
  requestV3Envelope,
  requestV3Raw,
  stableIdempotencyKey,
  type V3Result,
} from './v3Http'

export interface ProjectApiOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface WriteOptions extends ProjectApiOptions {
  requestId?: string
  idempotencyKey?: string
}

/* ------------------------------------------------------------------ 解析器 */

function stringField(record: Record<string, unknown>, key: string): string | null {
  return asString(record[key])
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return value === undefined || value === null ? null : asString(value)
}

function booleanOrFalse(record: Record<string, unknown>, key: string): boolean {
  return asBoolean(record[key]) ?? false
}

function parseTaskStats(value: unknown): MilestoneTaskStats | null {
  const record = asRecord(value)
  if (record === null) return null
  const total = asNumber(record['total'])
  const done = asNumber(record['done'])
  const doing = asNumber(record['doing'])
  const todo = asNumber(record['todo'])
  const archived = asNumber(record['archived'])
  const progress = asNumber(record['progress'])
  if (total === null || done === null || doing === null || todo === null || archived === null || progress === null) {
    return null
  }
  return { total, done, doing, todo, archived, progress }
}

function emptyTaskStats(): MilestoneTaskStats {
  return { total: 0, done: 0, doing: 0, todo: 0, archived: 0, progress: 0 }
}

export function parseMilestone(value: unknown): CloudMilestone | null {
  const record = asRecord(value)
  if (record === null) return null
  const milestoneId = stringField(record, 'milestoneId')
  const name = stringField(record, 'name')
  const status = stringField(record, 'status')
  const source = stringField(record, 'source')
  const orderIndex = asNumber(record['orderIndex'])
  const revision = asNumber(record['revision'])
  const createdAt = stringField(record, 'createdAt')
  const updatedAt = stringField(record, 'updatedAt')
  if (
    milestoneId === null ||
    name === null ||
    (status !== 'planned' && status !== 'active' && status !== 'completed' && status !== 'archived') ||
    (source !== 'manual' && source !== 'ai-candidate' && source !== 'migration') ||
    orderIndex === null ||
    revision === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null
  }
  return {
    milestoneId,
    name,
    goal: nullableString(record, 'goal') ?? '',
    doneCriteria: nullableString(record, 'doneCriteria') ?? '',
    dueAt: nullableString(record, 'dueAt'),
    status,
    orderIndex,
    revision,
    source,
    createdAt,
    updatedAt,
    completedAt: nullableString(record, 'completedAt'),
    archivedAt: nullableString(record, 'archivedAt'),
    taskStats: parseTaskStats(record['taskStats']) ?? emptyTaskStats(),
  }
}

export function parseTask(value: unknown): CloudTask | null {
  const record = asRecord(value)
  if (record === null) return null
  const taskId = stringField(record, 'taskId')
  const projectId = stringField(record, 'projectId')
  const title = stringField(record, 'title')
  const status = stringField(record, 'status')
  const source = stringField(record, 'source')
  const orderIndex = asNumber(record['orderIndex'])
  const revision = asNumber(record['revision'])
  const createdAt = stringField(record, 'createdAt')
  const updatedAt = stringField(record, 'updatedAt')
  if (
    taskId === null ||
    projectId === null ||
    title === null ||
    (status !== 'todo' && status !== 'doing' && status !== 'done') ||
    (source !== 'manual' && source !== 'ai-suggestion' && source !== 'migration') ||
    orderIndex === null ||
    revision === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null
  }
  return {
    taskId,
    projectId,
    milestoneId: nullableString(record, 'milestoneId'),
    milestoneName: nullableString(record, 'milestoneName'),
    title,
    doneCriteria: nullableString(record, 'doneCriteria') ?? '',
    status,
    assigneeUserId: nullableString(record, 'assigneeUserId'),
    orderIndex,
    source,
    revision,
    createdAt,
    updatedAt,
    startedAt: nullableString(record, 'startedAt'),
    completedAt: nullableString(record, 'completedAt'),
    archivedAt: nullableString(record, 'archivedAt'),
  }
}

export function parseEvidence(value: unknown): CloudEvidence | null {
  const record = asRecord(value)
  if (record === null) return null
  const evidenceId = stringField(record, 'evidenceId')
  const projectId = stringField(record, 'projectId')
  const didWhat = stringField(record, 'didWhat')
  const status = stringField(record, 'status')
  const revision = asNumber(record['revision'])
  const createdAt = stringField(record, 'createdAt')
  const updatedAt = stringField(record, 'updatedAt')
  if (
    evidenceId === null ||
    projectId === null ||
    didWhat === null ||
    (status !== 'active' && status !== 'redacted') ||
    revision === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null
  }
  return {
    evidenceId,
    projectId,
    taskId: nullableString(record, 'taskId'),
    milestoneId: nullableString(record, 'milestoneId'),
    milestoneNameSnapshot: nullableString(record, 'milestoneNameSnapshot'),
    submissionId: nullableString(record, 'submissionId'),
    didWhat,
    foundWhat: nullableString(record, 'foundWhat') ?? '',
    stillUnsure: nullableString(record, 'stillUnsure'),
    attachmentName: nullableString(record, 'attachmentName'),
    status,
    revision,
    createdAt,
    updatedAt,
    redactedAt: nullableString(record, 'redactedAt'),
  }
}

export function parseProgress(value: unknown): ProgressRecord | null {
  const record = asRecord(value)
  if (record === null) return null
  const progressId = stringField(record, 'progressId')
  const summary = stringField(record, 'summary')
  const occurredAt = stringField(record, 'occurredAt')
  const status = stringField(record, 'status')
  const revision = asNumber(record['revision'])
  const createdAt = stringField(record, 'createdAt')
  const evidenceIds = asArray(record['evidenceIds'])
  if (
    progressId === null ||
    summary === null ||
    occurredAt === null ||
    (status !== 'active' && status !== 'superseded') ||
    revision === null ||
    createdAt === null ||
    evidenceIds === null ||
    evidenceIds.some((id) => asString(id) === null)
  ) {
    return null
  }
  return {
    progressId,
    milestoneId: nullableString(record, 'milestoneId'),
    taskId: nullableString(record, 'taskId'),
    summary,
    evidenceIds: evidenceIds as string[],
    occurredAt,
    status,
    supersedesProgressId: nullableString(record, 'supersedesProgressId'),
    revision,
    createdAt,
    updatedAt: nullableString(record, 'updatedAt') ?? createdAt,
  }
}

function parseProjectSummary(value: unknown): CloudProjectSummary | null {
  const record = asRecord(value)
  if (record === null) return null
  const projectId = stringField(record, 'projectId')
  const name = stringField(record, 'name')
  const status = stringField(record, 'status')
  const projectRevision = asNumber(record['projectRevision'])
  const milestoneCount = asNumber(record['milestoneCount'])
  const taskCount = asNumber(record['taskCount'])
  const doneTaskCount = asNumber(record['doneTaskCount'])
  const updatedAt = stringField(record, 'updatedAt')
  if (
    projectId === null ||
    name === null ||
    (status !== 'active' && status !== 'archived') ||
    projectRevision === null ||
    milestoneCount === null ||
    taskCount === null ||
    doneTaskCount === null ||
    updatedAt === null
  ) {
    return null
  }
  return {
    projectId,
    name,
    short: nullableString(record, 'short'),
    status,
    projectRevision,
    currentMilestoneId: nullableString(record, 'currentMilestoneId'),
    currentMilestone: nullableString(record, 'currentMilestone'),
    milestoneCount,
    taskCount,
    doneTaskCount,
    updatedAt,
  }
}

export function parseProject(value: unknown): CloudProject | null {
  const record = asRecord(value)
  if (record === null) return null
  const projectId = stringField(record, 'projectId')
  const ownerUserId = stringField(record, 'ownerUserId')
  const name = stringField(record, 'name')
  const status = stringField(record, 'status')
  const projectRevision = asNumber(record['projectRevision'])
  const createdAt = stringField(record, 'createdAt')
  const updatedAt = stringField(record, 'updatedAt')
  const milestonesRaw = asArray(record['milestones'])
  if (
    projectId === null ||
    ownerUserId === null ||
    name === null ||
    (status !== 'active' && status !== 'archived' && status !== 'deleted') ||
    projectRevision === null ||
    createdAt === null ||
    updatedAt === null ||
    milestonesRaw === null
  ) {
    return null
  }
  const milestones = milestonesRaw.map(parseMilestone)
  if (milestones.some((milestone) => milestone === null)) return null
  const stats = asRecord(record['taskStats'])
  return {
    projectId,
    ownerUserId,
    name,
    short: nullableString(record, 'short'),
    profile: normalizeProjectProfile(record['profile']),
    status,
    visibility: 'private',
    projectRevision,
    currentMilestoneId: nullableString(record, 'currentMilestoneId'),
    currentMilestone: nullableString(record, 'currentMilestone'),
    createdAt,
    updatedAt,
    archivedAt: nullableString(record, 'archivedAt'),
    deletedAt: nullableString(record, 'deletedAt'),
    milestones: milestones as CloudMilestone[],
    taskStats: {
      total: stats === null ? 0 : (asNumber(stats['total']) ?? 0),
      done: stats === null ? 0 : (asNumber(stats['done']) ?? 0),
      doing: stats === null ? 0 : (asNumber(stats['doing']) ?? 0),
      todo: stats === null ? 0 : (asNumber(stats['todo']) ?? 0),
      progress: stats === null ? 0 : (asNumber(stats['progress']) ?? 0),
    },
  }
}

export function parseTimelineItem(value: unknown): ProjectTimelineItem | null {
  const record = asRecord(value)
  if (record === null) return null
  const itemId = stringField(record, 'itemId')
  const itemType = stringField(record, 'itemType')
  const summary = stringField(record, 'summary')
  const occurredAt = stringField(record, 'occurredAt')
  if (
    itemId === null ||
    summary === null ||
    occurredAt === null ||
    (itemType !== 'milestone' &&
      itemType !== 'task' &&
      itemType !== 'evidence' &&
      itemType !== 'progress' &&
      itemType !== 'doubt')
  ) {
    return null
  }
  return {
    itemId,
    itemType,
    summary,
    milestoneId: nullableString(record, 'milestoneId'),
    taskId: nullableString(record, 'taskId'),
    evidenceId: nullableString(record, 'evidenceId'),
    occurredAt,
    details: asRecord(record['details']) ?? {},
  }
}

/* -------------------------------------------------------------- 请求包络 */

interface EnvelopeInput {
  requestId: string
  idempotencyKey: string
  projectId: string
  projectRevision: number
}

function envelope(input: EnvelopeInput): Record<string, unknown> {
  return {
    contractVersion: V3_CONTRACT_VERSION,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
  }
}

/**
 * 同一幂等键的重试必须复用同一个 requestId。
 * ----------------------------------------------------------------------------
 * 服务端幂等指纹包含完整请求体（含 requestId）：只复用 idempotencyKey、每次换 requestId
 * 会被判定为 IDEMPOTENCY_CONFLICT。这里按幂等键缓存最近一次 requestId，
 * 让“同一逻辑操作的重试”复用两者；新的项目版本会生成新的幂等键，不会误复用。
 */
const recentRequestIds = new Map<string, string>()

function requestIdForIdempotencyKey(idempotencyKey: string): string {
  const cached = recentRequestIds.get(idempotencyKey)
  if (cached !== undefined) return cached
  const requestId = newRequestId()
  recentRequestIds.set(idempotencyKey, requestId)
  if (recentRequestIds.size > 128) {
    const oldest = recentRequestIds.keys().next().value
    if (oldest !== undefined) recentRequestIds.delete(oldest)
  }
  return requestId
}

function writeIdentity(
  operation: string,
  options: WriteOptions,
  projectId: string,
  signature: unknown,
): { requestId: string; idempotencyKey: string } {
  const idempotencyKey =
    options.idempotencyKey ?? stableIdempotencyKey(`${operation}:${projectId}`, signature)
  return {
    requestId: options.requestId ?? requestIdForIdempotencyKey(idempotencyKey),
    idempotencyKey,
  }
}

/* ------------------------------------------------------------------ 项目 */

export async function listProjects(
  options: ProjectApiOptions & { includeArchived?: boolean; cursor?: string; limit?: number } = {},
): Promise<V3Result<{ projects: CloudProjectSummary[]; nextCursor: string | null }>> {
  const requestId = newRequestId()
  return requestV3Envelope('/api/projects', {
    method: 'GET',
    requestId,
    query: {
      includeArchived: options.includeArchived === true ? true : undefined,
      cursor: options.cursor,
      limit: options.limit,
    },
    parseData: (data) => {
      const record = asRecord(data)
      const list = record === null ? null : asArray(record['projects'])
      if (record === null || list === null) return null
      const projects = list.map(parseProjectSummary)
      if (projects.some((project) => project === null)) return null
      const nextCursor = record['nextCursor']
      if (nextCursor !== undefined && nextCursor !== null && asString(nextCursor) === null) return null
      return { projects: projects as CloudProjectSummary[], nextCursor: nextCursor === undefined ? null : (nextCursor as string | null) }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export async function getProject(
  projectId: string,
  options: ProjectApiOptions = {},
): Promise<V3Result<CloudProject>> {
  const requestId = newRequestId()
  return requestV3Envelope(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'GET',
    requestId,
    expectedProjectId: projectId,
    parseData: (data) => {
      const record = asRecord(data)
      return record === null ? null : parseProject(record['project'])
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export interface CreateProjectInput {
  name: string
  short?: string | null
  /** 契约 22.1：profile 必填；缺失字段由服务端补 null，客户端不补造内容 */
  profile: ProjectProfile
}

/**
 * 创建项目。契约 22.1：请求体**没有** milestones 字段，服务端不得注入模板。
 * store 还会校验响应 milestones 为空，防止“空白项目被悄悄注入阶段”。
 */
export async function createProject(
  input: CreateProjectInput,
  options: ProjectApiOptions = {},
): Promise<V3Result<CloudProject>> {
  const requestId = newRequestId()
  return requestV3Envelope('/api/projects', {
    method: 'POST',
    requestId,
    body: {
      contractVersion: V3_CONTRACT_VERSION,
      requestId,
      idempotencyKey: stableIdempotencyKey('project.create', {
        name: input.name,
        short: input.short ?? null,
      }),
      name: input.name,
      short: input.short ?? null,
      profile: input.profile,
    },
    parseData: (data) => {
      const record = asRecord(data)
      return record === null ? null : parseProject(record['project'])
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export interface UpdateProjectInput {
  projectId: string
  projectRevision: number
  name?: string
  short?: string | null
  profile?: ProjectProfile
}

/** PATCH /api/projects/{projectId}；契约不要求 expectedRevision，版本由 projectRevision 控制 */
export async function updateProject(
  input: UpdateProjectInput,
  options: WriteOptions = {},
): Promise<V3Result<{ project: CloudProject }>> {
  const fields: Record<string, unknown> = {}
  if (input.name !== undefined) fields['name'] = input.name
  if (input.short !== undefined) fields['short'] = input.short
  if (input.profile !== undefined) fields['profile'] = input.profile
  const identity = writeIdentity('project.update', options, input.projectId, {
    projectRevision: input.projectRevision,
    fields,
  })
  return requestV3Envelope(`/api/projects/${encodeURIComponent(input.projectId)}`, {
    method: 'PATCH',
    requestId: identity.requestId,
    idempotencyKey: identity.idempotencyKey,
    expectedProjectId: input.projectId,
    expectedMinRevision: input.projectRevision,
    body: {
      ...envelope({
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
      }),
      ...fields,
    },
    parseData: (data) => {
      const record = asRecord(data)
      const project = record === null ? null : parseProject(record['project'])
      return project === null ? null : { project }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export type ProjectAction = 'archive' | 'restore' | 'delete' | 'restore-deleted'

/** POST /api/projects/{projectId}/archive|restore|delete|restore-deleted */
export async function projectAction(
  input: { projectId: string; projectRevision: number; action: ProjectAction },
  options: WriteOptions = {},
): Promise<V3Result<{ project: CloudProject }>> {
  const identity = writeIdentity(`project.${input.action}`, options, input.projectId, {
    projectRevision: input.projectRevision,
    action: input.action,
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/${input.action}`,
    {
      method: 'POST',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: envelope({
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
      }),
      parseData: (data) => {
        const record = asRecord(data)
        const project = record === null ? null : parseProject(record['project'])
        return project === null ? null : { project }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

/* ------------------------------------------------------------------ 阶段 */

export async function listMilestones(
  projectId: string,
  options: ProjectApiOptions & { includeArchived?: boolean } = {},
): Promise<V3Result<{ milestones: CloudMilestone[]; currentMilestoneId: string | null }>> {
  const requestId = newRequestId()
  return requestV3Envelope(`/api/projects/${encodeURIComponent(projectId)}/milestones`, {
    method: 'GET',
    requestId,
    expectedProjectId: projectId,
    query: { includeArchived: options.includeArchived === true ? true : undefined },
    parseData: (data) => {
      const record = asRecord(data)
      const list = record === null ? null : asArray(record['milestones'])
      if (record === null || list === null) return null
      const milestones = list.map(parseMilestone)
      if (milestones.some((milestone) => milestone === null)) return null
      return {
        milestones: milestones as CloudMilestone[],
        currentMilestoneId: nullableString(record, 'currentMilestoneId'),
      }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export interface CreateMilestoneInput {
  projectId: string
  projectRevision: number
  name: string
  goal?: string
  doneCriteria?: string
  dueAt?: string | null
  status?: 'planned' | 'active'
  source?: 'manual' | 'ai-candidate'
  candidateId?: string
  confirmedByUser?: boolean
}

export async function createMilestone(
  input: CreateMilestoneInput,
  options: WriteOptions = {},
): Promise<V3Result<{ milestone: CloudMilestone }>> {
  const identity = writeIdentity('milestone.create', options, input.projectId, {
    projectRevision: input.projectRevision,
    name: input.name,
    goal: input.goal ?? '',
    doneCriteria: input.doneCriteria ?? '',
    dueAt: input.dueAt ?? null,
    status: input.status ?? 'planned',
    source: input.source ?? 'manual',
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/milestones`,
    {
      method: 'POST',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: {
        ...envelope({
          requestId: identity.requestId,
          idempotencyKey: identity.idempotencyKey,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
        }),
        name: input.name,
        goal: input.goal ?? '',
        doneCriteria: input.doneCriteria ?? '',
        dueAt: input.dueAt ?? null,
        status: input.status ?? 'planned',
        source: input.source ?? 'manual',
        ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
        ...(input.confirmedByUser === undefined ? {} : { confirmedByUser: input.confirmedByUser }),
      },
      parseData: (data) => {
        const record = asRecord(data)
        const milestone = record === null ? null : parseMilestone(record['milestone'])
        return milestone === null ? null : { milestone }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

export interface UpdateMilestoneInput {
  projectId: string
  projectRevision: number
  milestoneId: string
  expectedRevision: number
  name?: string
  goal?: string
  doneCriteria?: string
  dueAt?: string | null
}

export async function updateMilestone(
  input: UpdateMilestoneInput,
  options: WriteOptions = {},
): Promise<V3Result<{ milestone: CloudMilestone; changed: boolean }>> {
  const fields: Record<string, unknown> = {}
  if (input.name !== undefined) fields['name'] = input.name
  if (input.goal !== undefined) fields['goal'] = input.goal
  if (input.doneCriteria !== undefined) fields['doneCriteria'] = input.doneCriteria
  if (input.dueAt !== undefined) fields['dueAt'] = input.dueAt
  const identity = writeIdentity('milestone.update', options, input.projectId, {
    projectRevision: input.projectRevision,
    milestoneId: input.milestoneId,
    expectedRevision: input.expectedRevision,
    fields,
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/milestones/${encodeURIComponent(input.milestoneId)}`,
    {
      method: 'PATCH',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: {
        ...envelope({
          requestId: identity.requestId,
          idempotencyKey: identity.idempotencyKey,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
        }),
        expectedRevision: input.expectedRevision,
        ...fields,
      },
      parseData: (data) => {
        const record = asRecord(data)
        const milestone = record === null ? null : parseMilestone(record['milestone'])
        return milestone === null ? null : { milestone, changed: booleanOrFalse(record as Record<string, unknown>, 'changed') }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

export interface ReorderMilestonesInput {
  projectId: string
  projectRevision: number
  order: string[]
}

export async function reorderMilestones(
  input: ReorderMilestonesInput,
  options: WriteOptions = {},
): Promise<V3Result<{ milestones: CloudMilestone[]; currentMilestoneId: string | null; changed: boolean }>> {
  const identity = writeIdentity('milestone.reorder', options, input.projectId, {
    projectRevision: input.projectRevision,
    order: input.order,
  })
  return requestV3Envelope(`/api/projects/${encodeURIComponent(input.projectId)}/milestones/reorder`, {
    method: 'POST',
    requestId: identity.requestId,
    idempotencyKey: identity.idempotencyKey,
    expectedProjectId: input.projectId,
    expectedMinRevision: input.projectRevision,
    body: {
      ...envelope({
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
      }),
      order: input.order,
    },
    parseData: (data) => {
      const record = asRecord(data)
      const list = record === null ? null : asArray(record['milestones'])
      if (record === null || list === null) return null
      const milestones = list.map(parseMilestone)
      if (milestones.some((milestone) => milestone === null)) return null
      return {
        milestones: milestones as CloudMilestone[],
        currentMilestoneId: nullableString(record, 'currentMilestoneId'),
        changed: asBoolean(record['changed']) ?? false,
      }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export interface CompleteMilestoneInput {
  projectId: string
  projectRevision: number
  milestoneId: string
  expectedRevision: number
}

export async function completeMilestone(
  input: CompleteMilestoneInput,
  options: WriteOptions = {},
): Promise<V3Result<{ milestone: CloudMilestone; changed: boolean }>> {
  const identity = writeIdentity('milestone.complete', options, input.projectId, {
    projectRevision: input.projectRevision,
    milestoneId: input.milestoneId,
    expectedRevision: input.expectedRevision,
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/milestones/${encodeURIComponent(input.milestoneId)}/complete`,
    {
      method: 'POST',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: {
        ...envelope({
          requestId: identity.requestId,
          idempotencyKey: identity.idempotencyKey,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
        }),
        expectedRevision: input.expectedRevision,
      },
      parseData: (data) => {
        const record = asRecord(data)
        const milestone = record === null ? null : parseMilestone(record['milestone'])
        return milestone === null ? null : { milestone, changed: booleanOrFalse(record as Record<string, unknown>, 'changed') }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

export type MilestoneAction = 'activate' | 'complete' | 'reopen' | 'archive' | 'restore'

/** POST /api/projects/{projectId}/milestones/{milestoneId}/{activate|complete|reopen|archive|restore} */
export async function milestoneAction(
  input: {
    projectId: string
    projectRevision: number
    milestoneId: string
    expectedRevision: number
    action: MilestoneAction
  },
  options: WriteOptions = {},
): Promise<V3Result<{ milestone: CloudMilestone }>> {
  const identity = writeIdentity(`milestone.${input.action}`, options, input.projectId, {
    projectRevision: input.projectRevision,
    milestoneId: input.milestoneId,
    expectedRevision: input.expectedRevision,
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/milestones/${encodeURIComponent(input.milestoneId)}/${input.action}`,
    {
      method: 'POST',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: {
        ...envelope({
          requestId: identity.requestId,
          idempotencyKey: identity.idempotencyKey,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
        }),
        expectedRevision: input.expectedRevision,
      },
      parseData: (data) => {
        const record = asRecord(data)
        const milestone = record === null ? null : parseMilestone(record['milestone'])
        return milestone === null ? null : { milestone }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

/* ------------------------------------------------------------------ 任务 */

export interface TaskListQuery {
  /** 契约 22.3：按阶段筛选 */
  milestoneId?: string
  status?: CloudTask['status']
  includeArchived?: boolean
  limit?: number
  cursor?: string
}

export interface CloudTaskPage {
  tasks: CloudTask[]
  /** 契约 22.3：无下一页时为 null */
  nextCursor: string | null
}

/** GET /api/projects/{projectId}/tasks */
export async function listTasks(
  projectId: string,
  query: TaskListQuery = {},
  options: ProjectApiOptions = {},
): Promise<V3Result<CloudTaskPage>> {
  const requestId = newRequestId()
  return requestV3Envelope(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
    method: 'GET',
    requestId,
    expectedProjectId: projectId,
    query: {
      milestoneId: query.milestoneId,
      status: query.status,
      includeArchived: query.includeArchived === true ? true : undefined,
      limit: query.limit,
      cursor: query.cursor,
    },
    parseData: (data) => {
      const record = asRecord(data)
      const list = record === null ? null : asArray(record['tasks'])
      if (record === null || list === null) return null
      const tasks = list.map(parseTask)
      if (tasks.some((task) => task === null)) return null
      const nextCursor = record['nextCursor']
      return {
        tasks: tasks as CloudTask[],
        nextCursor: typeof nextCursor === 'string' && nextCursor !== '' ? nextCursor : null,
      }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

/** GET /api/projects/{projectId}/tasks/{taskId} */
export async function getTask(
  projectId: string,
  taskId: string,
  options: ProjectApiOptions = {},
): Promise<V3Result<{ task: CloudTask }>> {
  const requestId = newRequestId()
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'GET',
      requestId,
      expectedProjectId: projectId,
      parseData: (data) => {
        const record = asRecord(data)
        const task = record === null ? null : parseTask(record['task'])
        return task === null ? null : { task }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

export interface CreateTaskInput {
  projectId: string
  projectRevision: number
  title: string
  doneCriteria?: string
  milestoneId?: string | null
  /** 契约 22.3：创建只允许 todo / doing；done 必须通过完成任务动作 */
  status?: 'todo' | 'doing'
  assigneeUserId?: string | null
  reopenMilestone?: boolean
}

export async function createTask(
  input: CreateTaskInput,
  options: WriteOptions = {},
): Promise<V3Result<{ task: CloudTask; milestoneStats: MilestoneTaskStats | null }>> {
  const identity = writeIdentity('task.create', options, input.projectId, {
    projectRevision: input.projectRevision,
    title: input.title,
    doneCriteria: input.doneCriteria ?? '',
    milestoneId: input.milestoneId ?? null,
    status: input.status ?? 'todo',
  })
  return requestV3Envelope(`/api/projects/${encodeURIComponent(input.projectId)}/tasks`, {
    method: 'POST',
    requestId: identity.requestId,
    idempotencyKey: identity.idempotencyKey,
    expectedProjectId: input.projectId,
    expectedMinRevision: input.projectRevision,
    body: {
      ...envelope({
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
      }),
      title: input.title,
      doneCriteria: input.doneCriteria ?? '',
      milestoneId: input.milestoneId ?? null,
      status: input.status ?? 'todo',
      ...(input.assigneeUserId === undefined ? {} : { assigneeUserId: input.assigneeUserId }),
      ...(input.reopenMilestone === undefined ? {} : { reopenMilestone: input.reopenMilestone }),
    },
    parseData: (data) => {
      const record = asRecord(data)
      const task = record === null ? null : parseTask(record['task'])
      if (task === null) return null
      return { task, milestoneStats: parseTaskStats(record?.['milestoneStats']) }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export interface LinkTaskToMilestoneInput {
  projectId: string
  projectRevision: number
  taskId: string
  /** 契约 22.3：可为 null（移回项目待办） */
  milestoneId: string | null
  expectedRevision: number
  reopenMilestone?: boolean
}

export async function linkTaskToMilestone(
  input: LinkTaskToMilestoneInput,
  options: WriteOptions = {},
): Promise<
  V3Result<{
    task: CloudTask
    milestoneStats: MilestoneTaskStats | null
    sourceMilestoneStats: MilestoneTaskStats | null
    targetMilestoneStats: MilestoneTaskStats | null
  }>
> {
  const identity = writeIdentity('task.linkMilestone', options, input.projectId, {
    projectRevision: input.projectRevision,
    taskId: input.taskId,
    milestoneId: input.milestoneId,
    expectedRevision: input.expectedRevision,
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/tasks/${encodeURIComponent(input.taskId)}/link-milestone`,
    {
      method: 'POST',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: {
        ...envelope({
          requestId: identity.requestId,
          idempotencyKey: identity.idempotencyKey,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
        }),
        milestoneId: input.milestoneId,
        expectedRevision: input.expectedRevision,
        ...(input.reopenMilestone === undefined ? {} : { reopenMilestone: input.reopenMilestone }),
      },
      parseData: (data) => {
        const record = asRecord(data)
        const task = record === null ? null : parseTask(record['task'])
        if (task === null) return null
        return {
          task,
          milestoneStats: parseTaskStats(record?.['milestoneStats']),
          sourceMilestoneStats: parseTaskStats(record?.['sourceMilestoneStats']),
          targetMilestoneStats: parseTaskStats(record?.['targetMilestoneStats']),
        }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

export interface UpdateTaskInput {
  projectId: string
  projectRevision: number
  taskId: string
  expectedRevision: number
  title?: string
  doneCriteria?: string
}

/** PATCH /api/projects/{projectId}/tasks/{taskId} */
export async function updateTask(
  input: UpdateTaskInput,
  options: WriteOptions = {},
): Promise<V3Result<{ task: CloudTask; milestoneStats: MilestoneTaskStats | null }>> {
  const fields: Record<string, unknown> = {}
  if (input.title !== undefined) fields['title'] = input.title
  if (input.doneCriteria !== undefined) fields['doneCriteria'] = input.doneCriteria
  const identity = writeIdentity('task.update', options, input.projectId, {
    projectRevision: input.projectRevision,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    fields,
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/tasks/${encodeURIComponent(input.taskId)}`,
    {
      method: 'PATCH',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: {
        ...envelope({
          requestId: identity.requestId,
          idempotencyKey: identity.idempotencyKey,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
        }),
        expectedRevision: input.expectedRevision,
        ...fields,
      },
      parseData: (data) => {
        const record = asRecord(data)
        const task = record === null ? null : parseTask(record['task'])
        if (task === null) return null
        return { task, milestoneStats: parseTaskStats(record?.['milestoneStats']) }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

export type TaskAction = 'start' | 'complete' | 'reopen' | 'archive' | 'restore'

export interface TaskActionInput {
  projectId: string
  projectRevision: number
  taskId: string
  expectedRevision: number
  action: TaskAction
  targetStatus?: 'doing' | 'todo'
}

/** POST /api/projects/{projectId}/tasks/{taskId}/{start|complete|reopen|archive|restore} */
export async function taskAction(
  input: TaskActionInput,
  options: WriteOptions = {},
): Promise<V3Result<{ task: CloudTask; milestoneStats: MilestoneTaskStats | null }>> {
  const identity = writeIdentity(`task.${input.action}`, options, input.projectId, {
    projectRevision: input.projectRevision,
    taskId: input.taskId,
    expectedRevision: input.expectedRevision,
    ...(input.targetStatus === undefined ? {} : { targetStatus: input.targetStatus }),
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/tasks/${encodeURIComponent(input.taskId)}/${input.action}`,
    {
      method: 'POST',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: {
        ...envelope({
          requestId: identity.requestId,
          idempotencyKey: identity.idempotencyKey,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
        }),
        expectedRevision: input.expectedRevision,
        ...(input.targetStatus === undefined ? {} : { targetStatus: input.targetStatus }),
      },
      parseData: (data) => {
        const record = asRecord(data)
        const task = record === null ? null : parseTask(record['task'])
        if (task === null) return null
        return { task, milestoneStats: parseTaskStats(record?.['milestoneStats']) }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

/* ------------------------------------------------------------------ 进展 */

export interface SubmitProgressInput {
  projectId: string
  projectRevision: number
  /** 契约 22.4：字段必填但可为 null；服务端以任务当前阶段为准 */
  milestoneId: string | null
  taskId: string | null
  summary: string
  evidenceIds?: string[]
  occurredAt?: string
}

export async function submitProgress(
  input: SubmitProgressInput,
  options: WriteOptions = {},
): Promise<V3Result<{ progress: ProgressRecord; milestoneStats: MilestoneTaskStats | null }>> {
  const identity = writeIdentity('progress.create', options, input.projectId, {
    projectRevision: input.projectRevision,
    milestoneId: input.milestoneId,
    taskId: input.taskId,
    summary: input.summary,
    evidenceIds: input.evidenceIds ?? [],
    occurredAt: input.occurredAt ?? null,
  })
  return requestV3Envelope(`/api/projects/${encodeURIComponent(input.projectId)}/progress`, {
    method: 'POST',
    requestId: identity.requestId,
    idempotencyKey: identity.idempotencyKey,
    expectedProjectId: input.projectId,
    expectedMinRevision: input.projectRevision,
    body: {
      ...envelope({
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
      }),
      milestoneId: input.milestoneId,
      taskId: input.taskId,
      summary: input.summary,
      evidenceIds: input.evidenceIds ?? [],
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    },
    parseData: (data) => {
      const record = asRecord(data)
      const progress = record === null ? null : parseProgress(record['progress'])
      if (progress === null) return null
      return { progress, milestoneStats: parseTaskStats(record?.['milestoneStats']) }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

/* ------------------------------------------------------------------ 证据 */

export interface AttachEvidenceToTaskInput {
  projectId: string
  projectRevision: number
  evidenceId: string
  /** 契约 22.5：可为 null，表示解除关联 */
  taskId: string | null
  milestoneId: string | null
  expectedRevision: number
}

export async function attachEvidenceToTask(
  input: AttachEvidenceToTaskInput,
  options: WriteOptions = {},
): Promise<V3Result<{ evidence: CloudEvidence; milestoneStats: MilestoneTaskStats | null }>> {
  const identity = writeIdentity('evidence.link', options, input.projectId, {
    projectRevision: input.projectRevision,
    evidenceId: input.evidenceId,
    taskId: input.taskId,
    milestoneId: input.milestoneId,
    expectedRevision: input.expectedRevision,
  })
  return requestV3Envelope(
    `/api/projects/${encodeURIComponent(input.projectId)}/evidence/${encodeURIComponent(input.evidenceId)}/links`,
    {
      method: 'POST',
      requestId: identity.requestId,
      idempotencyKey: identity.idempotencyKey,
      expectedProjectId: input.projectId,
      expectedMinRevision: input.projectRevision,
      body: {
        ...envelope({
          requestId: identity.requestId,
          idempotencyKey: identity.idempotencyKey,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
        }),
        taskId: input.taskId,
        milestoneId: input.milestoneId,
        expectedRevision: input.expectedRevision,
      },
      parseData: (data) => {
        const record = asRecord(data)
        const evidence = record === null ? null : parseEvidence(record['evidence'])
        if (evidence === null) return null
        return { evidence, milestoneStats: parseTaskStats(record?.['milestoneStats']) }
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    },
  )
}

export function parseDoubt(value: unknown): CloudDoubt | null {
  const record = asRecord(value)
  if (record === null) return null
  const doubtId = stringField(record, 'doubtId')
  const text = stringField(record, 'text')
  const status = stringField(record, 'status')
  const createdAt = stringField(record, 'createdAt')
  if (
    doubtId === null ||
    text === null ||
    (status !== 'open' && status !== 'resolved') ||
    createdAt === null
  ) {
    return null
  }
  return {
    doubtId,
    // 证据创建响应不带 projectId；归属由证据的 projectId 保证
    projectId: nullableString(record, 'projectId'),
    text,
    status,
    sourceEvidenceId: nullableString(record, 'sourceEvidenceId'),
    createdAt,
    resolvedAt: nullableString(record, 'resolvedAt'),
  }
}

export interface CreateEvidenceInput {
  projectId: string
  projectRevision: number
  submissionId?: string
  taskId: string | null
  milestoneId: string | null
  didWhat: string
  foundWhat?: string | null
  stillUnsure?: string | null
  attachmentName?: string | null
  completeTask?: boolean
  /** 契约 22.5：completeTask 为 true 时必填 */
  expectedTaskRevision?: number
}

/** POST /api/projects/{projectId}/evidence */
export async function createEvidence(
  input: CreateEvidenceInput,
  options: WriteOptions = {},
): Promise<
  V3Result<{
    evidence: CloudEvidence
    doubt: CloudDoubt | null
    task: CloudTask | null
    milestoneStats: MilestoneTaskStats | null
  }>
> {
  const identity = writeIdentity('evidence.create', options, input.projectId, {
    projectRevision: input.projectRevision,
    submissionId: input.submissionId ?? null,
    taskId: input.taskId,
    milestoneId: input.milestoneId,
    didWhat: input.didWhat,
    foundWhat: input.foundWhat ?? null,
    stillUnsure: input.stillUnsure ?? null,
    attachmentName: input.attachmentName ?? null,
    completeTask: input.completeTask ?? false,
    expectedTaskRevision: input.expectedTaskRevision ?? null,
  })
  return requestV3Envelope(`/api/projects/${encodeURIComponent(input.projectId)}/evidence`, {
    method: 'POST',
    requestId: identity.requestId,
    idempotencyKey: identity.idempotencyKey,
    expectedProjectId: input.projectId,
    expectedMinRevision: input.projectRevision,
    body: {
      ...envelope({
        requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey,
        projectId: input.projectId,
        projectRevision: input.projectRevision,
      }),
      ...(input.submissionId === undefined ? {} : { submissionId: input.submissionId }),
      taskId: input.taskId,
      milestoneId: input.milestoneId,
      didWhat: input.didWhat,
      foundWhat: input.foundWhat ?? null,
      stillUnsure: input.stillUnsure ?? null,
      attachmentName: input.attachmentName ?? null,
      ...(input.completeTask === undefined ? {} : { completeTask: input.completeTask }),
      ...(input.expectedTaskRevision === undefined
        ? {}
        : { expectedTaskRevision: input.expectedTaskRevision }),
    },
    parseData: (data) => {
      const record = asRecord(data)
      const evidence = record === null ? null : parseEvidence(record['evidence'])
      if (record === null || evidence === null) return null
      const doubtRaw = record['doubt']
      const doubt =
        doubtRaw === undefined || doubtRaw === null ? null : parseDoubt(doubtRaw)
      if (doubtRaw !== undefined && doubtRaw !== null && doubt === null) return null
      const taskRaw = record['task']
      const task = taskRaw === undefined || taskRaw === null ? null : parseTask(taskRaw)
      if (taskRaw !== undefined && taskRaw !== null && task === null) return null
      return { evidence, doubt, task, milestoneStats: parseTaskStats(record['milestoneStats']) }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export async function listEvidence(
  projectId: string,
  options: ProjectApiOptions & { cursor?: string; limit?: number; taskId?: string; milestoneId?: string } = {},
): Promise<V3Result<{ evidence: CloudEvidence[]; nextCursor: string | null }>> {
  const requestId = newRequestId()
  return requestV3Envelope(`/api/projects/${encodeURIComponent(projectId)}/evidence`, {
    method: 'GET',
    requestId,
    expectedProjectId: projectId,
    query: {
      cursor: options.cursor,
      limit: options.limit,
      taskId: options.taskId,
      milestoneId: options.milestoneId,
    },
    parseData: (data) => {
      const record = asRecord(data)
      const list = record === null ? null : asArray(record['evidence'])
      if (record === null || list === null) return null
      const evidence = list.map(parseEvidence)
      if (evidence.some((item) => item === null)) return null
      const nextCursor = record['nextCursor']
      return {
        evidence: evidence as CloudEvidence[],
        nextCursor: nextCursor === undefined ? null : (nextCursor as string | null),
      }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

export async function listProgress(
  projectId: string,
  options: ProjectApiOptions & { cursor?: string; limit?: number; milestoneId?: string; taskId?: string } = {},
): Promise<V3Result<{ progress: ProgressRecord[]; nextCursor: string | null }>> {
  const requestId = newRequestId()
  return requestV3Envelope(`/api/projects/${encodeURIComponent(projectId)}/progress`, {
    method: 'GET',
    requestId,
    expectedProjectId: projectId,
    query: {
      cursor: options.cursor,
      limit: options.limit,
      milestoneId: options.milestoneId,
      taskId: options.taskId,
    },
    parseData: (data) => {
      const record = asRecord(data)
      const list = record === null ? null : asArray(record['progress'])
      if (record === null || list === null) return null
      const progress = list.map(parseProgress)
      if (progress.some((item) => item === null)) return null
      const nextCursor = record['nextCursor']
      return {
        progress: progress as ProgressRecord[],
        nextCursor: nextCursor === undefined ? null : (nextCursor as string | null),
      }
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
}

/**
 * GET /timeline（契约 22.11）在冻结文档中存在，但当前已合并后端没有该路由。
 * 为避免向未实现端点发送生产请求，这里只保留类型与显式阻塞错误；
 * 待后端实现后再补解析与调用，不伪造本地时间线。
 */
export const TIMELINE_ENDPOINT_PENDING = true

export function timelineEndpointUnavailable(): V3Result<never> {
  return { ok: false, error: makeV3Error('MISSING_CONTRACT') }
}

/** 仅供测试/未来端点接入时使用的纯解析函数 */
export function parseTimelinePayload(value: unknown): ProjectTimelineItem[] | null {
  const record = asRecord(value)
  const list = record === null ? null : asArray(record['timeline'])
  if (list === null) return null
  const items = list.map(parseTimelineItem)
  return items.some((item) => item === null) ? null : (items as ProjectTimelineItem[])
}

/* ------------------------------------------------------------------ 迁移 */

export interface LocalMigrationApiOptions extends WriteOptions {
  /** 显式确认时间；未确认时 store 不允许调用 */
  userConfirmedAt: string
}

export type MigrationApiResponse = LocalMigrationResponse

function parseStringMap(value: unknown): Record<string, string> | null {
  const record = asRecord(value)
  if (record === null) return null
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    const text = asString(item)
    if (text === null) return null
    result[key] = text
  }
  return result
}

function parseMigrationResponse(value: unknown, expectedRequestId: string, expectedMigrationId: string): MigrationApiResponse | null {
  const record = asRecord(value)
  if (record === null) return null
  if (record['contractVersion'] !== V3_CONTRACT_VERSION) return null
  if (record['requestId'] !== expectedRequestId) return null
  if (record['migrationId'] !== expectedMigrationId) return null
  if (record['status'] !== 'completed') return null
  const projectId = asString(record['projectId'])
  const projectRevision = asNumber(record['projectRevision'])
  const importedAt = asString(record['importedAt'])
  const deduplicated = asBoolean(record['deduplicated'])
  const replayed = asBoolean(record['replayed'])
  const appliedChanges = asBoolean(record['appliedChanges'])
  const idMapRaw = asRecord(record['idMap'])
  const countsRaw = asRecord(record['counts'])
  const warningsRaw = asArray(record['warnings'])
  if (
    projectId === null ||
    projectRevision === null ||
    importedAt === null ||
    deduplicated === null ||
    replayed === null ||
    appliedChanges === null ||
    idMapRaw === null ||
    countsRaw === null ||
    warningsRaw === null
  ) {
    return null
  }
  const milestones = parseStringMap(idMapRaw['milestones'])
  const tasks = parseStringMap(idMapRaw['tasks'])
  const evidence = parseStringMap(idMapRaw['evidence'])
  const progress = parseStringMap(idMapRaw['progress'])
  const doubts = parseStringMap(idMapRaw['doubts'])
  const materials = parseStringMap(idMapRaw['materials'])
  const understandingItems = parseStringMap(idMapRaw['understandingItems'])
  const chats = parseStringMap(idMapRaw['chats'])
  if (
    milestones === null ||
    tasks === null ||
    evidence === null ||
    progress === null ||
    doubts === null ||
    materials === null ||
    understandingItems === null ||
    chats === null
  ) {
    return null
  }
  const counts = {
    milestones: asNumber(countsRaw['milestones']),
    tasks: asNumber(countsRaw['tasks']),
    evidence: asNumber(countsRaw['evidence']),
    progress: asNumber(countsRaw['progress']),
    materials: asNumber(countsRaw['materials']),
    materialSegments: asNumber(countsRaw['materialSegments']),
    understandingItems: asNumber(countsRaw['understandingItems']),
    doubts: asNumber(countsRaw['doubts']),
    chatMessages: asNumber(countsRaw['chatMessages']),
  }
  if (Object.values(counts).some((count) => count === null)) return null
  const warnings: MigrationApiResponse['warnings'] = []
  for (const item of warningsRaw) {
    const warning = asRecord(item)
    const code = warning === null ? null : asString(warning['code'])
    const message = warning === null ? null : asString(warning['message'])
    const count = warning === null ? null : asNumber(warning['count'])
    if (code === null || message === null || count === null) return null
    warnings.push({ code, message, count })
  }

  return {
    contractVersion: V3_CONTRACT_VERSION,
    requestId: expectedRequestId,
    migrationId: expectedMigrationId,
    status: 'completed',
    projectId,
    projectRevision,
    replayed,
    deduplicated,
    appliedChanges,
    idMap: { milestones, tasks, evidence, progress, doubts, materials, understandingItems, chats },
    counts: counts as MigrationApiResponse['counts'],
    warnings,
    importedAt,
  }
}

/**
 * POST /api/projects/migrate-local
 * 响应不是 20.1 的 data 包络，因此单独校验；只有 completed 才允许标记本地迁移成功。
 */
export async function migrateLocalProject(
  request: Record<string, unknown>,
  options: LocalMigrationApiOptions,
): Promise<V3Result<MigrationApiResponse>> {
  const requestId = options.requestId ?? newRequestId()
  const idempotencyKey = options.idempotencyKey ?? stableIdempotencyKey('migration.local', request['migrationId'])
  const migrationId = asString(request['migrationId'])
  if (migrationId === null) {
    return { ok: false, error: makeV3Error('INVALID_INPUT') }
  }
  const raw = await requestV3Raw('/api/projects/migrate-local', {
    method: 'POST',
    body: { ...request, requestId, idempotencyKey, contractVersion: V3_CONTRACT_VERSION },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  if (!raw.ok) return raw

  const parsed = parseMigrationResponse(raw.body, requestId, migrationId)
  if (parsed === null) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE') }
  }
  return {
    ok: true,
    data: parsed,
    requestId,
    projectId: parsed.projectId,
    projectRevision: null,
    replayed: parsed.deduplicated,
    changed: parsed.appliedChanges ?? null,
  }
}

export async function getMigrationStatus(
  migrationId: string,
  options: ProjectApiOptions = {},
): Promise<
  V3Result<{
    migrationId: string
    status: 'processing' | 'completed' | 'failed'
    projectId: string | null
    importedAt: string | null
  }>
> {
  const raw = await requestV3Raw(`/api/projects/migrations/${encodeURIComponent(migrationId)}`, {
    method: 'GET',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  if (!raw.ok) return raw

  const record = asRecord(raw.body)
  if (record === null || record['contractVersion'] !== V3_CONTRACT_VERSION) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE') }
  }
  if (record['migrationId'] !== migrationId) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE') }
  }
  const status = asString(record['status'])
  if (status !== 'processing' && status !== 'completed' && status !== 'failed') {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE') }
  }
  return {
    ok: true,
    data: {
      migrationId,
      status,
      projectId: nullableString(record, 'projectId'),
      importedAt: nullableString(record, 'importedAt'),
    },
    requestId: '',
    projectId: nullableString(record, 'projectId'),
    projectRevision: null,
    replayed: false,
    changed: null,
  }
}

/** 当前登录用户缓存（供 UI 只读展示，不参与鉴权） */
export type CachedUser = V3User
