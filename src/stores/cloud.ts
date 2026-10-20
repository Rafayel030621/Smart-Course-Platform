/**
 * V3 云端项目 store（契约 22 / 23）。
 *
 * 单一来源：`milestones` / `tasks` / `evidence` / `progress` 是领域状态的唯一副本；
 * `project` 是只读投影（项目元信息 + 当前阶段列表 + 聚合统计），不单独维护第二份。
 *
 * 所有写操作遵循：
 *   1. 校验当前项目、实体归属、实体 revision；
 *   2. 只有服务端成功响应才写入状态（失败不产生半更新，无需回滚幽灵数据）；
 *   3. 响应回来时再次校验 epoch/projectId，项目切换后的过期响应一律丢弃；
 *   4. 同一操作的并发重复调用直接拒绝，不发送第二次请求。
 *
 * 契约缺口（不伪造）：
 *   - 没有读取任务列表的端点，任务只能来自本次会话内的创建/关联响应；
 *   - 没有读取 timeline 的端点，`loadTimeline()` 返回 MISSING_CONTRACT；
 *   - 没有读取材料理解条目的端点，v3 AI 的已确认材料需由调用方显式传入。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  attachEvidenceToTask as attachEvidenceToTaskApi,
  completeMilestone as completeMilestoneApi,
  createEvidence as createEvidenceApi,
  createMilestone as createMilestoneApi,
  createProject as createProjectApi,
  createTask as createTaskApi,
  getProject,
  linkTaskToMilestone as linkTaskToMilestoneApi,
  listEvidence,
  listMilestones,
  listProgress,
  milestoneAction as milestoneActionApi,
  projectAction as projectActionApi,
  reorderMilestones as reorderMilestonesApi,
  submitProgress as submitProgressApi,
  taskAction as taskActionApi,
  updateMilestone as updateMilestoneApi,
  updateProject as updateProjectApi,
  updateTask as updateTaskApi,
  type MilestoneAction,
  type ProjectAction,
  type ProjectApiOptions,
  type TaskAction,
} from '@/services/projectsApi'
import {
  makeV3Error,
  validationError,
  v3Failure,
  type V3ApiError,
} from '@/services/v3Http'
import type { ActionResult } from '@/domain/recommendation'
import type { MilestoneContext } from '@/domain/recommendation'
import { buildMilestoneContext } from '@/domain/v3Advisor'
import type {
  CloudDoubt,
  CloudEvidence,
  CloudMilestone,
  CloudProject,
  CloudProjectSyncState,
  CloudTask,
  MilestoneTaskStats,
  ProgressRecord,
  ProjectProfile,
  ProjectTimelineItem,
} from '@/types/platform'

export interface CloudStoreOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 登录用户 ID；传入时响应中的 ownerUserId 必须一致（由 platform 层注入） */
  expectedOwnerUserId?: string
}

export interface CreateCloudProjectInput {
  name: string
  short?: string | null
  /** 契约 22.1：profile 必填；调用方负责提供真实资料，不在此补造 */
  profile: ProjectProfile
}

export interface UpdateCloudProjectActionInput {
  projectId?: string
  name?: string
  short?: string | null
  profile?: ProjectProfile
}

export interface CreateMilestoneActionInput {
  /** 传入时必须等于当前项目；用于 UI 防止串项目 */
  projectId?: string
  name: string
  goal?: string
  doneCriteria?: string
  dueAt?: string | null
  status?: 'planned' | 'active'
  source?: 'manual' | 'ai-candidate'
  candidateId?: string
  confirmedByUser?: boolean
}

export interface UpdateMilestoneActionInput {
  projectId?: string
  milestoneId: string
  expectedRevision: number
  name?: string
  goal?: string
  doneCriteria?: string
  dueAt?: string | null
}

export interface ReorderMilestonesActionInput {
  projectId?: string
  order: string[]
}

export interface CompleteMilestoneActionInput {
  projectId?: string
  milestoneId: string
  expectedRevision: number
}

export interface CreateTaskActionInput {
  projectId?: string
  title: string
  doneCriteria?: string
  milestoneId?: string | null
  /** 契约 22.3：创建只允许 todo / doing */
  status?: 'todo' | 'doing'
  assigneeUserId?: string | null
  reopenMilestone?: boolean
}

export interface LinkTaskToMilestoneActionInput {
  projectId?: string
  taskId: string
  milestoneId: string | null
  expectedRevision: number
  reopenMilestone?: boolean
}

export interface UpdateTaskActionInput {
  projectId?: string
  taskId: string
  expectedRevision: number
  title?: string
  doneCriteria?: string
}

export interface TaskStateActionInput {
  projectId?: string
  taskId: string
  expectedRevision: number
  action: TaskAction
  targetStatus?: 'doing' | 'todo'
}

export interface MilestoneStateActionInput {
  projectId?: string
  milestoneId: string
  expectedRevision: number
  action: MilestoneAction
}

export interface ProjectStateActionInput {
  projectId?: string
  action: ProjectAction
}

export interface SubmitProgressActionInput {
  projectId?: string
  /** 契约 22.4：可空；同时传 taskId 时服务端校验阶段一致性 */
  milestoneId: string | null
  taskId: string | null
  summary: string
  evidenceIds?: string[]
  occurredAt?: string
}

export interface AttachEvidenceActionInput {
  projectId?: string
  evidenceId: string
  taskId: string | null
  milestoneId: string | null
  expectedRevision: number
}

export interface CreateEvidenceActionInput {
  projectId?: string
  submissionId?: string
  taskId: string | null
  milestoneId: string | null
  didWhat: string
  foundWhat?: string | null
  stillUnsure?: string | null
  attachmentName?: string | null
  completeTask?: boolean
  /** completeTask 为 true 时必填 */
  expectedTaskRevision?: number
}

export interface CreateEvidenceActionResult {
  evidence: CloudEvidence
  doubt: CloudDoubt | null
  task: CloudTask | null
}

export interface ProjectStats {
  total: number
  done: number
  doing: number
  todo: number
  progress: number
}

function failure<T = never>(error: V3ApiError): ActionResult<T> {
  return v3Failure(error)
}

function codepointLength(value: string): number {
  return [...value].length
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function isValidIso(value: string | null): boolean {
  return value === null || !Number.isNaN(new Date(value).getTime())
}

export const useCloudStore = defineStore('cloud', () => {
  /** 服务端项目元信息（不含单独维护的 milestones 副本） */
  const projectMeta = ref<CloudProject | null>(null)
  const milestones = ref<CloudMilestone[]>([])
  const tasks = ref<CloudTask[]>([])
  const evidence = ref<CloudEvidence[]>([])
  const progress = ref<ProgressRecord[]>([])
  /** 契约 22.11 未实现，保持空数组；不使用本地拼装冒充服务端时间线 */
  const timeline = ref<ProjectTimelineItem[]>([])
  const currentMilestoneId = ref<string | null>(null)
  const loadingProject = ref(false)
  const lastError = ref<{ code: string; message: string } | null>(null)
  const pendingActions = ref<Record<string, number>>({})
  /** 已成功读取过的任务只可能来自本次会话；刷新后为空 */
  const tasksHydrated = ref(false)

  let epoch = 0
  let activeProjectId: string | null = null
  let abortController = new AbortController()
  /** 会话内保留 ID→项目 的归属索引，用于识别跨项目实体 */
  const entityOwners = new Map<string, string>()

  const projectStats = computed<ProjectStats>(() => {
    let total = 0
    let done = 0
    let doing = 0
    let todo = 0
    for (const milestone of milestones.value) {
      if (milestone.archivedAt !== null) continue
      total += milestone.taskStats.total
      done += milestone.taskStats.done
      doing += milestone.taskStats.doing
      todo += milestone.taskStats.todo
    }
    return {
      total,
      done,
      doing,
      todo,
      progress: total === 0 ? 0 : Math.round((done / total) * 100),
    }
  })

  const project = computed<CloudProject | null>(() => {
    const meta = projectMeta.value
    if (meta === null) return null
    return {
      ...meta,
      milestones: milestones.value.filter((item) => item.archivedAt === null),
      currentMilestoneId: currentMilestoneId.value,
      taskStats: projectStats.value,
    }
  })

  const projectRevision = computed(() => projectMeta.value?.projectRevision ?? 0)

  const busy = computed(() => Object.values(pendingActions.value).some((count) => count > 0))

  const sync = computed<CloudProjectSyncState>(() => {
    const status = loadingProject.value
      ? 'loading'
      : busy.value
        ? 'saving'
        : lastError.value !== null
          ? 'error'
          : projectMeta.value !== null
            ? 'ready'
            : 'idle'
    return {
      status,
      projectId: activeProjectId,
      projectRevision: projectRevision.value,
      lastSyncedAt: projectMeta.value?.updatedAt ?? null,
      errorCode: lastError.value?.code ?? null,
      errorMessage: lastError.value?.message ?? null,
    }
  })

  const contractBlockers = computed(() => [
    '缺少读取任务列表的契约端点：刷新或重新进入项目后，任务列表无法恢复（阶段统计仍可读）',
    '契约 22.11 的时间线端点在当前已合并后端中未实现：timeline 暂不可用',
    '契约 23.7 的阶段候选接口（POST .../milestones/candidates）在已合并后端没有路由：未实现客户端调用',
    '契约 22.4 只说明 supersede 的语义，没有请求字段表：未实现客户端调用',
    '缺少读取材料理解条目的契约端点：v3 建议/聊天的 confirmedMaterials 需由调用方显式提供',
  ])

  function isActionLoading(name: string): boolean {
    return (pendingActions.value[name] ?? 0) > 0
  }

  function startAction(name: string): boolean {
    if (isActionLoading(name)) return false
    pendingActions.value = {
      ...pendingActions.value,
      [name]: (pendingActions.value[name] ?? 0) + 1,
    }
    return true
  }

  function finishAction(name: string): void {
    const next = { ...pendingActions.value }
    const count = (next[name] ?? 0) - 1
    if (count <= 0) delete next[name]
    else next[name] = count
    pendingActions.value = next
  }

  function renewAbort(): AbortSignal {
    abortController.abort()
    abortController = new AbortController()
    return abortController.signal
  }

  function reset(): void {
    abortController.abort()
    abortController = new AbortController()
    epoch += 1
    activeProjectId = null
    projectMeta.value = null
    milestones.value = []
    tasks.value = []
    evidence.value = []
    progress.value = []
    timeline.value = []
    currentMilestoneId.value = null
    loadingProject.value = false
    lastError.value = null
    pendingActions.value = {}
    tasksHydrated.value = false
    entityOwners.clear()
  }

  function isStale(token: number, projectId: string): boolean {
    return token !== epoch || projectId !== activeProjectId
  }

  function setFailure(error: V3ApiError): void {
    if (error.code === 'CANCELLED' || error.code === 'STALE_RESPONSE') return
    lastError.value = { code: error.code, message: error.message }
  }

  function clearFailure(): void {
    lastError.value = null
  }

  function indexEntity(entityId: string, projectId: string): void {
    entityOwners.set(entityId, projectId)
  }

  function ownerOf(entityId: string): string | null {
    return entityOwners.get(entityId) ?? null
  }

  /** 返回 null 表示可以写；否则返回应直接返回的错误 */
  function ensureWritable(projectId?: string): V3ApiError | null {
    if (projectMeta.value === null || activeProjectId === null) {
      return makeV3Error('NOT_LOADED')
    }
    if (projectId !== undefined && projectId !== activeProjectId) {
      return makeV3Error('PROJECT_MISMATCH')
    }
    if (projectMeta.value.status === 'archived') {
      return makeV3Error('PROJECT_ARCHIVED')
    }
    if (projectMeta.value.status === 'deleted') {
      return makeV3Error('PROJECT_NOT_FOUND')
    }
    return null
  }

  function checkEntityOwner(entityId: string): V3ApiError | null {
    const owner = ownerOf(entityId)
    if (owner !== null && owner !== activeProjectId) {
      return makeV3Error('PROJECT_MISMATCH')
    }
    return null
  }

  function findMilestone(milestoneId: string): CloudMilestone | null {
    return milestones.value.find((item) => item.milestoneId === milestoneId) ?? null
  }

  function findTask(taskId: string): CloudTask | null {
    return tasks.value.find((item) => item.taskId === taskId) ?? null
  }

  function findEvidence(evidenceId: string): CloudEvidence | null {
    return evidence.value.find((item) => item.evidenceId === evidenceId) ?? null
  }

  function applyMilestone(milestone: CloudMilestone): void {
    if (activeProjectId !== null) indexEntity(milestone.milestoneId, activeProjectId)
    const next = milestones.value.filter((item) => item.milestoneId !== milestone.milestoneId)
    next.push(milestone)
    next.sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt))
    milestones.value = next
  }

  /** 契约 22.2：currentMilestoneId = 第一个 active；否则第一个 planned；否则 null */
  function recomputeCurrentMilestoneId(): void {
    const active = milestones.value
      .filter((item) => item.archivedAt === null)
      .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt))
    currentMilestoneId.value =
      active.find((item) => item.status === 'active')?.milestoneId ??
      active.find((item) => item.status === 'planned')?.milestoneId ??
      null
  }

  function applyMilestoneStats(milestoneId: string | null, stats: MilestoneTaskStats | null): void {
    if (milestoneId === null || stats === null) return
    const index = milestones.value.findIndex((item) => item.milestoneId === milestoneId)
    if (index < 0) return
    const next = [...milestones.value]
    next[index] = { ...next[index]!, taskStats: stats }
    milestones.value = next
  }

  function applyTask(task: CloudTask): void {
    indexEntity(task.taskId, task.projectId)
    const index = tasks.value.findIndex((item) => item.taskId === task.taskId)
    if (index < 0) tasks.value = [...tasks.value, task]
    else {
      const next = [...tasks.value]
      next[index] = task
      tasks.value = next
    }
  }

  function applyEvidence(item: CloudEvidence): void {
    indexEntity(item.evidenceId, item.projectId)
    const index = evidence.value.findIndex((entry) => entry.evidenceId === item.evidenceId)
    if (index < 0) evidence.value = [item, ...evidence.value]
    else {
      const next = [...evidence.value]
      next[index] = item
      evidence.value = next
    }
  }

  function applyProgress(item: ProgressRecord): void {
    const index = progress.value.findIndex((entry) => entry.progressId === item.progressId)
    if (index < 0) progress.value = [item, ...progress.value]
    else {
      const next = [...progress.value]
      next[index] = item
      progress.value = next
    }
  }

  function applyRevision(revision: number | null): void {
    if (revision === null || projectMeta.value === null) return
    if (revision > projectMeta.value.projectRevision) {
      projectMeta.value = { ...projectMeta.value, projectRevision: revision }
    }
  }

  /** 项目级写响应（PATCH/archive/restore/delete）以整个项目为准，但不清空证据/进展 */
  function applyProject(updated: CloudProject): void {
    projectMeta.value = updated
    milestones.value = [...updated.milestones].sort(
      (a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt),
    )
    currentMilestoneId.value = updated.currentMilestoneId
    if (activeProjectId !== null) {
      for (const item of milestones.value) indexEntity(item.milestoneId, activeProjectId)
    }
  }

  function ownerMismatch(project: CloudProject, expectedUserId?: string): boolean {
    return expectedUserId !== undefined && project.ownerUserId !== expectedUserId
  }

  function mapAbort(error: V3ApiError): V3ApiError {
    return error.code === 'CANCELLED' ? makeV3Error('STALE_RESPONSE') : error
  }

  /* ---------------------------------------------------------------- 读取 */

  async function openProject(
    projectId: string,
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<CloudProject>> {
    if (projectId.trim() === '') return failure(makeV3Error('INVALID_INPUT'))
    const token = epoch + 1
    epoch = token
    activeProjectId = projectId
    const signal = renewAbort()
    loadingProject.value = true
    clearFailure()

    // 切换项目先清空上一个项目，避免 UI 短暂显示串项目数据
    projectMeta.value = null
    milestones.value = []
    tasks.value = []
    evidence.value = []
    progress.value = []
    timeline.value = []
    currentMilestoneId.value = null
    tasksHydrated.value = false

    const requestOptions: ProjectApiOptions = {
      signal: options.signal ?? signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    }

    try {
      const projectResult = await getProject(projectId, requestOptions)
      if (!projectResult.ok) {
        setFailure(mapAbort(projectResult.error))
        return failure(mapAbort(projectResult.error))
      }
      if (projectResult.data.projectId !== projectId) {
        setFailure(makeV3Error('INVALID_RESPONSE'))
        return failure(makeV3Error('INVALID_RESPONSE'))
      }
      if (ownerMismatch(projectResult.data, options.expectedOwnerUserId)) {
        // 服务端按用户过滤；这里再校验一次，防止缓存/代理串响应
        projectMeta.value = null
        milestones.value = []
        const error = makeV3Error('PROJECT_NOT_FOUND')
        setFailure(error)
        return failure(error)
      }

      const [evidenceResult, progressResult] = await Promise.all([
        listEvidence(projectId, requestOptions),
        listProgress(projectId, requestOptions),
      ])
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!evidenceResult.ok) {
        const error = mapAbort(evidenceResult.error)
        setFailure(error)
        return failure(error)
      }
      if (!progressResult.ok) {
        const error = mapAbort(progressResult.error)
        setFailure(error)
        return failure(error)
      }

      const loaded = projectResult.data
      if (evidenceResult.data.evidence.some((item) => item.projectId !== projectId)) {
        const error = makeV3Error('PROJECT_MISMATCH')
        setFailure(error)
        return failure(error)
      }

      projectMeta.value = loaded
      milestones.value = [...loaded.milestones].sort(
        (a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt),
      )
      currentMilestoneId.value = loaded.currentMilestoneId
      evidence.value = evidenceResult.data.evidence
      progress.value = progressResult.data.progress
      for (const item of loaded.milestones) indexEntity(item.milestoneId, projectId)
      for (const item of evidence.value) indexEntity(item.evidenceId, projectId)
      // 任务列表读取端点缺失：不伪造，只标记未恢复
      tasksHydrated.value = false
      loadingProject.value = false
      clearFailure()
      return { ok: true, data: project.value! }
    } catch {
      const error = makeV3Error('NETWORK_ERROR', { retryable: true })
      setFailure(error)
      return failure(error)
    } finally {
      if (token === epoch) loadingProject.value = false
    }
  }

  async function refreshEvidence(
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<CloudEvidence[]>> {
    const projectId = activeProjectId
    if (projectId === null) return failure(makeV3Error('NOT_LOADED'))
    const token = epoch
    const result = await listEvidence(projectId, {
      signal: options.signal ?? abortController.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    })
    if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
    if (!result.ok) {
      setFailure(mapAbort(result.error))
      return failure(mapAbort(result.error))
    }
    evidence.value = result.data.evidence
    return { ok: true, data: result.data.evidence }
  }

  async function refreshProgress(
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<ProgressRecord[]>> {
    const projectId = activeProjectId
    if (projectId === null) return failure(makeV3Error('NOT_LOADED'))
    const token = epoch
    const result = await listProgress(projectId, {
      signal: options.signal ?? abortController.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    })
    if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
    if (!result.ok) {
      setFailure(mapAbort(result.error))
      return failure(mapAbort(result.error))
    }
    progress.value = result.data.progress
    return { ok: true, data: result.data.progress }
  }

  /** 不发送请求：当前后端没有 timeline 路由 */
  function loadTimeline(): ActionResult<ProjectTimelineItem[]> {
    return failure(makeV3Error('TIMELINE_NOT_AVAILABLE'))
  }

  /* ---------------------------------------------------------------- 创建 */

  async function createProject(
    input: CreateCloudProjectInput,
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<CloudProject>> {
    const name = input.name.trim()
    if (name === '' || codepointLength(name) > 120) {
      return failure(validationError('INVALID_INPUT', '项目名称需为 1～120 字'))
    }
    const short = input.short?.trim() ?? ''
    if (short !== '' && codepointLength(short) > 20) {
      return failure(validationError('INVALID_INPUT', '项目短名需为 1～20 字'))
    }
    if (!startAction('createProject')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await createProjectApi(
        {
          name,
          short: short === '' ? null : short,
          profile: input.profile,
        },
        {
          signal: options.signal ?? renewAbort(),
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        },
      )
      if (!result.ok) {
        setFailure(result.error)
        return failure(result.error)
      }
      // 契约 22.1：创建请求不带 milestones，服务端也不得注入模板
      if (result.data.milestones.length > 0) {
        const error = makeV3Error('INVALID_RESPONSE')
        setFailure(error)
        return failure(error)
      }
      if (ownerMismatch(result.data, options.expectedOwnerUserId)) {
        projectMeta.value = null
        const error = makeV3Error('PROJECT_NOT_FOUND')
        setFailure(error)
        return failure(error)
      }

      const token = epoch + 1
      epoch = token
      activeProjectId = result.data.projectId
      projectMeta.value = result.data
      milestones.value = []
      tasks.value = []
      evidence.value = []
      progress.value = []
      timeline.value = []
      currentMilestoneId.value = null
      tasksHydrated.value = false
      clearFailure()
      return { ok: true, data: project.value! }
    } finally {
      finishAction('createProject')
    }
  }

  async function updateProject(
    input: UpdateCloudProjectActionInput,
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<CloudProject>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const hasField =
      input.name !== undefined || input.short !== undefined || input.profile !== undefined
    if (!hasField) return failure(validationError('INVALID_INPUT', '没有需要更新的字段'))
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (name === '' || codepointLength(name) > 120) {
        return failure(validationError('INVALID_INPUT', '项目名称需为 1～120 字'))
      }
    }
    if (input.short !== undefined && input.short !== null) {
      const short = input.short.trim()
      if (short === '' || codepointLength(short) > 20) {
        return failure(validationError('INVALID_INPUT', '项目短名需为 1～20 字'))
      }
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('updateProject')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await updateProjectApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          ...(input.name === undefined ? {} : { name: input.name.trim() }),
          ...(input.short === undefined
            ? {}
            : { short: input.short === null ? null : input.short.trim() }),
          ...(input.profile === undefined ? {} : { profile: input.profile }),
        },
        {
          signal: options.signal ?? abortController.signal,
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.project.projectId !== projectId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      if (ownerMismatch(result.data.project, options.expectedOwnerUserId)) {
        return failure(makeV3Error('PROJECT_NOT_FOUND'))
      }
      applyProject(result.data.project)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: project.value! }
    } finally {
      finishAction('updateProject')
    }
  }

  async function runProjectAction(
    input: ProjectStateActionInput,
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<CloudProject>> {
    if (projectMeta.value === null || activeProjectId === null) {
      return failure(makeV3Error('NOT_LOADED'))
    }
    if (input.projectId !== undefined && input.projectId !== activeProjectId) {
      return failure(makeV3Error('PROJECT_MISMATCH'))
    }
    const projectId = activeProjectId
    const actionName = `project.${input.action}`
    if (!startAction(actionName)) return failure(makeV3Error('DUPLICATE_REQUEST'))
    const token = epoch
    try {
      const result = await projectActionApi(
        { projectId, projectRevision: projectRevision.value, action: input.action },
        {
          signal: options.signal ?? abortController.signal,
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.project.projectId !== projectId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      applyProject(result.data.project)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: project.value! }
    } finally {
      finishAction(actionName)
    }
  }

  function archiveProject(input: { projectId?: string } = {}) {
    return runProjectAction({ ...input, action: 'archive' })
  }

  function restoreProject(input: { projectId?: string } = {}) {
    return runProjectAction({ ...input, action: 'restore' })
  }

  function deleteProject(input: { projectId?: string } = {}) {
    return runProjectAction({ ...input, action: 'delete' })
  }

  function restoreDeletedProject(input: { projectId?: string } = {}) {
    return runProjectAction({ ...input, action: 'restore-deleted' })
  }

  /* ---------------------------------------------------------------- 阶段 */

  async function createMilestone(
    input: CreateMilestoneActionInput,
  ): Promise<ActionResult<CloudMilestone>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const name = normalizeName(input.name)
    if (name === '' || codepointLength(name) > 60) {
      return failure(validationError('INVALID_INPUT', '阶段名称需为 1～60 字'))
    }
    if (input.goal !== undefined && codepointLength(input.goal) > 300) {
      return failure(validationError('INVALID_INPUT', '阶段目标不能超过 300 字'))
    }
    if (input.doneCriteria !== undefined && codepointLength(input.doneCriteria) > 300) {
      return failure(validationError('INVALID_INPUT', '完成标准不能超过 300 字'))
    }
    if (!isValidIso(input.dueAt ?? null)) {
      return failure(validationError('INVALID_INPUT', '截止时间格式不正确'))
    }
    if (
      milestones.value.some(
        (item) => item.archivedAt === null && normalizeName(item.name) === name,
      )
    ) {
      return failure(makeV3Error('MILESTONE_NAME_CONFLICT'))
    }
    if (input.source === 'ai-candidate' && (input.confirmedByUser !== true || !input.candidateId)) {
      return failure(makeV3Error('CONFIRMATION_REQUIRED'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('createMilestone')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await createMilestoneApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          name,
          goal: input.goal ?? '',
          doneCriteria: input.doneCriteria ?? '',
          dueAt: input.dueAt ?? null,
          status: input.status ?? 'planned',
          source: input.source ?? 'manual',
          ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
          ...(input.confirmedByUser === undefined ? {} : { confirmedByUser: input.confirmedByUser }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      applyMilestone(result.data.milestone)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.milestone }
    } finally {
      finishAction('createMilestone')
    }
  }

  async function updateMilestone(
    input: UpdateMilestoneActionInput,
  ): Promise<ActionResult<CloudMilestone>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const ownerError = checkEntityOwner(input.milestoneId)
    if (ownerError !== null) return failure(ownerError)
    const target = findMilestone(input.milestoneId)
    if (target === null) return failure(makeV3Error('MILESTONE_NOT_FOUND'))
    if (target.archivedAt !== null) return failure(makeV3Error('MILESTONE_ARCHIVED'))
    if (target.revision !== input.expectedRevision) {
      return failure(makeV3Error('STALE_REVISION'))
    }
    const hasField =
      input.name !== undefined ||
      input.goal !== undefined ||
      input.doneCriteria !== undefined ||
      input.dueAt !== undefined
    if (!hasField) return failure(validationError('INVALID_INPUT', '没有需要更新的字段'))
    if (input.name !== undefined) {
      const name = normalizeName(input.name)
      if (name === '' || codepointLength(name) > 60) {
        return failure(validationError('INVALID_INPUT', '阶段名称需为 1～60 字'))
      }
      if (
        milestones.value.some(
          (item) =>
            item.milestoneId !== input.milestoneId &&
            item.archivedAt === null &&
            normalizeName(item.name) === name,
        )
      ) {
        return failure(makeV3Error('MILESTONE_NAME_CONFLICT'))
      }
    }
    if (input.goal !== undefined && codepointLength(input.goal) > 300) {
      return failure(validationError('INVALID_INPUT', '阶段目标不能超过 300 字'))
    }
    if (input.doneCriteria !== undefined && codepointLength(input.doneCriteria) > 300) {
      return failure(validationError('INVALID_INPUT', '完成标准不能超过 300 字'))
    }
    if (input.dueAt !== undefined && !isValidIso(input.dueAt)) {
      return failure(validationError('INVALID_INPUT', '截止时间格式不正确'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('updateMilestone')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await updateMilestoneApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          milestoneId: input.milestoneId,
          expectedRevision: input.expectedRevision,
          ...(input.name === undefined ? {} : { name: normalizeName(input.name) }),
          ...(input.goal === undefined ? {} : { goal: input.goal }),
          ...(input.doneCriteria === undefined ? {} : { doneCriteria: input.doneCriteria }),
          ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      applyMilestone(result.data.milestone)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.milestone }
    } finally {
      finishAction('updateMilestone')
    }
  }

  async function reorderMilestones(
    input: ReorderMilestonesActionInput,
  ): Promise<ActionResult<CloudMilestone[]>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const active = milestones.value.filter((item) => item.archivedAt === null)
    const activeIds = active.map((item) => item.milestoneId)
    const unique = new Set(input.order)
    if (
      input.order.length !== activeIds.length ||
      unique.size !== input.order.length ||
      input.order.some((id) => !activeIds.includes(id))
    ) {
      return failure(validationError('INVALID_ORDER'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('reorderMilestones')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await reorderMilestonesApi(
        { projectId, projectRevision: projectRevision.value, order: input.order },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      milestones.value = [...result.data.milestones].sort(
        (a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt),
      )
      currentMilestoneId.value = result.data.currentMilestoneId
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: milestones.value }
    } finally {
      finishAction('reorderMilestones')
    }
  }

  async function completeMilestone(
    input: CompleteMilestoneActionInput,
  ): Promise<ActionResult<CloudMilestone>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const ownerError = checkEntityOwner(input.milestoneId)
    if (ownerError !== null) return failure(ownerError)
    const target = findMilestone(input.milestoneId)
    if (target === null) return failure(makeV3Error('MILESTONE_NOT_FOUND'))
    if (target.archivedAt !== null) return failure(makeV3Error('MILESTONE_ARCHIVED'))
    if (target.revision !== input.expectedRevision) {
      return failure(makeV3Error('STALE_REVISION'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('completeMilestone')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await completeMilestoneApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          milestoneId: input.milestoneId,
          expectedRevision: input.expectedRevision,
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      applyMilestone(result.data.milestone)
      recomputeCurrentMilestoneId()
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.milestone }
    } finally {
      finishAction('completeMilestone')
    }
  }

  async function changeMilestoneState(
    input: MilestoneStateActionInput,
  ): Promise<ActionResult<CloudMilestone>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const ownerError = checkEntityOwner(input.milestoneId)
    if (ownerError !== null) return failure(ownerError)
    const target = findMilestone(input.milestoneId)
    if (target === null) return failure(makeV3Error('MILESTONE_NOT_FOUND'))
    if (target.revision !== input.expectedRevision) {
      return failure(makeV3Error('STALE_REVISION'))
    }
    if (input.action === 'restore' && target.archivedAt === null) {
      // 契约 22.2：非归档阶段 restore 是 no-op，不发送请求
      return { ok: true, data: target }
    }
    if (input.action !== 'restore' && target.archivedAt !== null) {
      return failure(makeV3Error('MILESTONE_ARCHIVED'))
    }

    const projectId = activeProjectId!
    const token = epoch
    const actionName = `milestone.${input.action}`
    if (!startAction(actionName)) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await milestoneActionApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          milestoneId: input.milestoneId,
          expectedRevision: input.expectedRevision,
          action: input.action,
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.milestone.milestoneId !== input.milestoneId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      applyMilestone(result.data.milestone)
      recomputeCurrentMilestoneId()
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.milestone }
    } finally {
      finishAction(actionName)
    }
  }

  function activateMilestone(input: Omit<MilestoneStateActionInput, 'action'>) {
    return changeMilestoneState({ ...input, action: 'activate' })
  }

  function reopenMilestone(input: Omit<MilestoneStateActionInput, 'action'>) {
    return changeMilestoneState({ ...input, action: 'reopen' })
  }

  function archiveMilestone(input: Omit<MilestoneStateActionInput, 'action'>) {
    return changeMilestoneState({ ...input, action: 'archive' })
  }

  function restoreMilestone(input: Omit<MilestoneStateActionInput, 'action'>) {
    return changeMilestoneState({ ...input, action: 'restore' })
  }

  /* ---------------------------------------------------------------- 任务 */

  function validateTaskMilestone(milestoneId: string | null): V3ApiError | null {
    if (milestoneId === null) return null
    const ownerError = checkEntityOwner(milestoneId)
    if (ownerError !== null) return ownerError
    const milestone = findMilestone(milestoneId)
    if (milestone === null) return makeV3Error('MILESTONE_NOT_FOUND')
    if (milestone.archivedAt !== null) return makeV3Error('MILESTONE_ARCHIVED')
    return null
  }

  async function createTask(input: CreateTaskActionInput): Promise<ActionResult<CloudTask>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const title = input.title.trim()
    if (title === '' || codepointLength(title) > 60) {
      return failure(validationError('INVALID_INPUT', '任务标题需为 1～60 字'))
    }
    if (input.doneCriteria !== undefined && codepointLength(input.doneCriteria) > 200) {
      return failure(validationError('INVALID_INPUT', '完成标准不能超过 200 字'))
    }
    if (input.status !== undefined && input.status !== 'todo' && input.status !== 'doing') {
      return failure(validationError('INVALID_INPUT', '创建任务时状态只能是 todo 或 doing'))
    }
    const milestoneError = validateTaskMilestone(input.milestoneId ?? null)
    if (milestoneError !== null) return failure(milestoneError)

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('createTask')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await createTaskApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          title,
          doneCriteria: input.doneCriteria ?? '',
          milestoneId: input.milestoneId ?? null,
          status: input.status ?? 'todo',
          ...(input.assigneeUserId === undefined ? {} : { assigneeUserId: input.assigneeUserId }),
          ...(input.reopenMilestone === undefined ? {} : { reopenMilestone: input.reopenMilestone }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.task.projectId !== projectId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      applyTask(result.data.task)
      applyMilestoneStats(result.data.task.milestoneId, result.data.milestoneStats)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.task }
    } finally {
      finishAction('createTask')
    }
  }

  async function linkTaskToMilestone(
    input: LinkTaskToMilestoneActionInput,
  ): Promise<ActionResult<CloudTask>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const ownerError = checkEntityOwner(input.taskId)
    if (ownerError !== null) return failure(ownerError)
    const task = findTask(input.taskId)
    if (task === null) {
      // 契约没有任务列表读取端点；未知任务不能假装已校验通过
      return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
    }
    if (task.revision !== input.expectedRevision) {
      return failure(makeV3Error('STALE_REVISION'))
    }
    if (task.archivedAt !== null) return failure(makeV3Error('TASK_ARCHIVED'))
    const milestoneError = validateTaskMilestone(input.milestoneId)
    if (milestoneError !== null) return failure(milestoneError)
    if (task.milestoneId === input.milestoneId) {
      return failure(makeV3Error('ALREADY_LINKED'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('linkTaskToMilestone')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await linkTaskToMilestoneApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          taskId: input.taskId,
          milestoneId: input.milestoneId,
          expectedRevision: input.expectedRevision,
          ...(input.reopenMilestone === undefined ? {} : { reopenMilestone: input.reopenMilestone }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.task.projectId !== projectId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      applyTask(result.data.task)
      // 契约 22.3：响应同时给出源阶段与目标阶段统计
      applyMilestoneStats(input.milestoneId, result.data.targetMilestoneStats ?? result.data.milestoneStats)
      applyMilestoneStats(task.milestoneId, result.data.sourceMilestoneStats)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.task }
    } finally {
      finishAction('linkTaskToMilestone')
    }
  }

  async function updateTask(
    input: UpdateTaskActionInput,
  ): Promise<ActionResult<CloudTask>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const ownerError = checkEntityOwner(input.taskId)
    if (ownerError !== null) return failure(ownerError)
    const task = findTask(input.taskId)
    if (task === null) return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
    if (task.revision !== input.expectedRevision) {
      return failure(makeV3Error('STALE_REVISION'))
    }
    if (task.archivedAt !== null) return failure(makeV3Error('TASK_ARCHIVED'))
    if (input.title === undefined && input.doneCriteria === undefined) {
      return failure(validationError('INVALID_INPUT', '没有需要更新的字段'))
    }
    if (input.title !== undefined) {
      const title = input.title.trim()
      if (title === '' || codepointLength(title) > 60) {
        return failure(validationError('INVALID_INPUT', '任务标题需为 1～60 字'))
      }
    }
    if (input.doneCriteria !== undefined && codepointLength(input.doneCriteria) > 200) {
      return failure(validationError('INVALID_INPUT', '完成标准不能超过 200 字'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('updateTask')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await updateTaskApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          ...(input.title === undefined ? {} : { title: input.title.trim() }),
          ...(input.doneCriteria === undefined ? {} : { doneCriteria: input.doneCriteria }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.task.projectId !== projectId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      applyTask(result.data.task)
      applyMilestoneStats(result.data.task.milestoneId, result.data.milestoneStats)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.task }
    } finally {
      finishAction('updateTask')
    }
  }

  async function changeTaskState(
    input: TaskStateActionInput,
  ): Promise<ActionResult<CloudTask>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const ownerError = checkEntityOwner(input.taskId)
    if (ownerError !== null) return failure(ownerError)
    const task = findTask(input.taskId)
    if (task === null) return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
    if (task.revision !== input.expectedRevision) {
      return failure(makeV3Error('STALE_REVISION'))
    }
    if (input.action !== 'restore' && task.archivedAt !== null) {
      return failure(makeV3Error('TASK_ARCHIVED'))
    }
    if (input.action === 'restore' && task.archivedAt === null) {
      return { ok: true, data: task }
    }
    if (
      input.action === 'reopen' &&
      input.targetStatus !== undefined &&
      input.targetStatus !== 'doing' &&
      input.targetStatus !== 'todo'
    ) {
      return failure(validationError('INVALID_INPUT', 'targetStatus 只能是 doing 或 todo'))
    }

    const projectId = activeProjectId!
    const token = epoch
    const actionName = `task.${input.action}`
    if (!startAction(actionName)) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await taskActionApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          taskId: input.taskId,
          expectedRevision: input.expectedRevision,
          action: input.action,
          ...(input.targetStatus === undefined ? {} : { targetStatus: input.targetStatus }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.task.projectId !== projectId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      applyTask(result.data.task)
      applyMilestoneStats(result.data.task.milestoneId, result.data.milestoneStats)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.task }
    } finally {
      finishAction(actionName)
    }
  }

  function startTask(input: Omit<TaskStateActionInput, 'action'>) {
    return changeTaskState({ ...input, action: 'start' })
  }

  function completeTask(input: Omit<TaskStateActionInput, 'action'>) {
    return changeTaskState({ ...input, action: 'complete' })
  }

  function reopenTask(input: Omit<TaskStateActionInput, 'action'>) {
    return changeTaskState({ ...input, action: 'reopen' })
  }

  function archiveTask(input: Omit<TaskStateActionInput, 'action'>) {
    return changeTaskState({ ...input, action: 'archive' })
  }

  function restoreTask(input: Omit<TaskStateActionInput, 'action'>) {
    return changeTaskState({ ...input, action: 'restore' })
  }

  async function refreshMilestones(): Promise<void> {
    const projectId = activeProjectId
    if (projectId === null) return
    const token = epoch
    const result = await listMilestones(projectId, { signal: abortController.signal })
    if (isStale(token, projectId) || !result.ok) return
    milestones.value = result.data.milestones
    currentMilestoneId.value = result.data.currentMilestoneId
  }

  /* ---------------------------------------------------------------- 进展 */

  async function submitProgress(
    input: SubmitProgressActionInput,
  ): Promise<ActionResult<ProgressRecord>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const summary = input.summary.trim()
    if (summary === '' || codepointLength(summary) > 1000) {
      return failure(validationError('INVALID_INPUT', '进展说明需为 1～1000 字'))
    }
    const milestoneError = validateTaskMilestone(input.milestoneId)
    if (milestoneError !== null) return failure(milestoneError)
    const task = input.taskId === null ? null : findTask(input.taskId)
    if (input.taskId !== null) {
      const taskOwnerError = checkEntityOwner(input.taskId)
      if (taskOwnerError !== null) return failure(taskOwnerError)
      if (task === null) return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
      // 契约 22.4：显式阶段必须与任务当前阶段一致；null 表示由服务端按任务阶段处理
      if (input.milestoneId !== null && task.milestoneId !== input.milestoneId) {
        return failure(validationError('INVALID_INPUT', '任务不属于所选阶段'))
      }
    }
    for (const evidenceId of input.evidenceIds ?? []) {
      const owner = checkEntityOwner(evidenceId)
      if (owner !== null) return failure(owner)
      if (findEvidence(evidenceId) === null) return failure(makeV3Error('EVIDENCE_NOT_FOUND'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('submitProgress')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await submitProgressApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          milestoneId: input.milestoneId,
          taskId: input.taskId,
          summary,
          evidenceIds: input.evidenceIds ?? [],
          ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      applyProgress(result.data.progress)
      applyMilestoneStats(
        result.data.progress.milestoneId ?? input.milestoneId,
        result.data.milestoneStats,
      )
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.progress }
    } finally {
      finishAction('submitProgress')
    }
  }

  /* ---------------------------------------------------------------- 证据 */

  async function attachEvidenceToTask(
    input: AttachEvidenceActionInput,
  ): Promise<ActionResult<CloudEvidence>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const evidenceOwner = checkEntityOwner(input.evidenceId)
    if (evidenceOwner !== null) return failure(evidenceOwner)
    const evidenceItem = findEvidence(input.evidenceId)
    if (evidenceItem === null) return failure(makeV3Error('EVIDENCE_NOT_FOUND'))
    if (evidenceItem.status !== 'active') return failure(makeV3Error('EVIDENCE_IMMUTABLE'))
    if (evidenceItem.revision !== input.expectedRevision) {
      return failure(makeV3Error('STALE_REVISION'))
    }
    if (input.taskId !== null) {
      const taskOwner = checkEntityOwner(input.taskId)
      if (taskOwner !== null) return failure(taskOwner)
      if (findTask(input.taskId) === null) return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
    }
    const milestoneError = validateTaskMilestone(input.milestoneId)
    if (milestoneError !== null) return failure(milestoneError)

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('attachEvidenceToTask')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await attachEvidenceToTaskApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          evidenceId: input.evidenceId,
          taskId: input.taskId,
          milestoneId: input.milestoneId,
          expectedRevision: input.expectedRevision,
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.evidence.projectId !== projectId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      applyEvidence(result.data.evidence)
      applyMilestoneStats(
        input.milestoneId ?? result.data.evidence.milestoneId,
        result.data.milestoneStats,
      )
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.evidence }
    } finally {
      finishAction('attachEvidenceToTask')
    }
  }

  async function createEvidence(
    input: CreateEvidenceActionInput,
  ): Promise<ActionResult<CreateEvidenceActionResult>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const didWhat = input.didWhat.trim()
    if (didWhat === '' || codepointLength(didWhat) > 300) {
      return failure(validationError('INVALID_INPUT', '证据说明需为 1～300 字'))
    }
    if (input.foundWhat !== undefined && input.foundWhat !== null && codepointLength(input.foundWhat) > 500) {
      return failure(validationError('INVALID_INPUT', '发现不能超过 500 字'))
    }
    if (input.stillUnsure !== undefined && input.stillUnsure !== null && codepointLength(input.stillUnsure) > 500) {
      return failure(validationError('INVALID_INPUT', '待确认事项不能超过 500 字'))
    }
    if (input.attachmentName !== undefined && input.attachmentName !== null && codepointLength(input.attachmentName) > 200) {
      return failure(validationError('INVALID_INPUT', '附件名不能超过 200 字'))
    }
    if (
      input.submissionId !== undefined &&
      !/^[\x21-\x7E]{8,64}$/.test(input.submissionId)
    ) {
      return failure(validationError('INVALID_INPUT', '提交编号需为 8～64 个可打印字符'))
    }
    const milestoneError = validateTaskMilestone(input.milestoneId)
    if (milestoneError !== null) return failure(milestoneError)

    let task: CloudTask | null = null
    if (input.taskId !== null) {
      const taskOwner = checkEntityOwner(input.taskId)
      if (taskOwner !== null) return failure(taskOwner)
      task = findTask(input.taskId)
      if (task === null) return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
      if (task.archivedAt !== null) return failure(makeV3Error('TASK_ARCHIVED'))
      if (input.milestoneId !== null && task.milestoneId !== input.milestoneId) {
        return failure(validationError('INVALID_INPUT', '任务不属于所选阶段'))
      }
    }
    if (input.completeTask === true) {
      if (task === null) return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
      if (input.expectedTaskRevision === undefined) {
        return failure(validationError('INVALID_INPUT', '完成任务时必须提供任务版本'))
      }
      if (task.revision !== input.expectedTaskRevision) {
        return failure(makeV3Error('STALE_REVISION'))
      }
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('createEvidence')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await createEvidenceApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          ...(input.submissionId === undefined ? {} : { submissionId: input.submissionId }),
          taskId: input.taskId,
          milestoneId: input.milestoneId,
          didWhat,
          foundWhat: input.foundWhat ?? null,
          stillUnsure: input.stillUnsure ?? null,
          attachmentName: input.attachmentName ?? null,
          ...(input.completeTask === undefined ? {} : { completeTask: input.completeTask }),
          ...(input.expectedTaskRevision === undefined
            ? {}
            : { expectedTaskRevision: input.expectedTaskRevision }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      if (result.data.evidence.projectId !== projectId) {
        return failure(makeV3Error('PROJECT_MISMATCH'))
      }
      applyEvidence(result.data.evidence)
      if (result.data.task !== null) {
        if (result.data.task.projectId !== projectId) {
          return failure(makeV3Error('PROJECT_MISMATCH'))
        }
        applyTask(result.data.task)
      }
      applyMilestoneStats(
        result.data.evidence.milestoneId ?? input.milestoneId,
        result.data.milestoneStats,
      )
      applyRevision(result.projectRevision)
      clearFailure()
      return {
        ok: true,
        data: { evidence: result.data.evidence, doubt: result.data.doubt, task: result.data.task },
      }
    } finally {
      finishAction('createEvidence')
    }
  }

  /**
   * 契约 23.2：构造当前阶段的 AI 上下文。
   * 任务列表读取端点缺失时，只有“服务端统计为 0 个任务”或“本次会话已知任务数 == 统计数”才认为完整；
   * 否则返回 TASKS_NOT_AVAILABLE，绝不拿部分任务冒充“该阶段全部任务”。
   */
  function buildAdvisorContext(): ActionResult<MilestoneContext> {
    if (projectMeta.value === null || activeProjectId === null) {
      return failure(makeV3Error('NOT_LOADED'))
    }
    if (currentMilestoneId.value === null) {
      return {
        ok: true,
        data: buildMilestoneContext({
          projectId: activeProjectId,
          currentMilestoneId: null,
          milestones: [],
          tasks: [],
          progress: [],
          evidence: [],
        }),
      }
    }
    const milestone = findMilestone(currentMilestoneId.value)
    if (milestone === null) return failure(makeV3Error('MILESTONE_NOT_FOUND'))
    const knownTasks = tasks.value.filter(
      (task) =>
        task.projectId === activeProjectId &&
        task.milestoneId === milestone.milestoneId &&
        task.archivedAt === null,
    )
    if (knownTasks.length !== milestone.taskStats.total) {
      return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
    }
    return {
      ok: true,
      data: buildMilestoneContext({
        projectId: activeProjectId,
        currentMilestoneId: milestone.milestoneId,
        milestones: milestones.value,
        tasks: tasks.value,
        progress: progress.value,
        evidence: evidence.value,
      }),
    }
  }

  return {
    /* 状态（只读投影） */
    project,
    projectRevision,
    projectStats,
    milestones,
    tasks,
    evidence,
    progress,
    timeline,
    currentMilestoneId,
    loadingProject,
    busy,
    sync,
    lastError,
    tasksHydrated,
    contractBlockers,
    isActionLoading,

    /* 生命周期 */
    openProject,
    reset,
    refreshEvidence,
    refreshProgress,
    refreshMilestones,
    loadTimeline,
    createProject,

    /* 项目写动作（契约 22.1） */
    updateProject,
    archiveProject,
    restoreProject,
    deleteProject,
    restoreDeletedProject,

    /* 阶段写动作（契约 22.2） */
    createMilestone,
    updateMilestone,
    reorderMilestones,
    completeMilestone,
    activateMilestone,
    reopenMilestone,
    archiveMilestone,
    restoreMilestone,

    /* 任务写动作（契约 22.3） */
    createTask,
    updateTask,
    linkTaskToMilestone,
    startTask,
    completeTask,
    reopenTask,
    archiveTask,
    restoreTask,

    /* 进展 / 证据写动作（契约 22.4 / 22.5） */
    submitProgress,
    createEvidence,
    attachEvidenceToTask,

    /* AI 阶段上下文（契约 23.2；任务不完整时显式拒绝） */
    buildAdvisorContext,
  }
})
