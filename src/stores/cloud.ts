/**
 * V3 云端项目 store（契约 22 / 23）。
 *
 * 单一来源：`milestones` / `tasks` / `evidence` / `progress` / `materials` 是领域状态的唯一副本；
 * `project` 是只读投影（项目元信息 + 当前阶段列表 + 聚合统计），不单独维护第二份。
 *
 * 所有写操作遵循：
 *   1. 校验当前项目、实体归属、实体 revision；
 *   2. 只有服务端成功响应才写入状态（失败不产生半更新，无需回滚幽灵数据）；
 *   3. 响应回来时再次校验 epoch/projectId，项目切换后的过期响应一律丢弃；
 *   4. 同一操作的并发重复调用直接拒绝，不发送第二次请求。
 *
 * 契约现状（2026-10-22 核对 origin/main 后端，含 D13 `f83291d` / 契约 v3.10）：
 *   - 任务列表（22.3）与材料/片段/理解草稿读取（22.8）已实现：`refreshTasks` / `refreshMaterials`；
 *   - 进展更正（22.4 supersede）已实现：`supersedeProgress`；
 *   - 时间线（22.11）没有路由：`loadTimeline()` 恒返回 TIMELINE_NOT_AVAILABLE；
 *   - 建议/聊天已支持 v3（`mvp-prompt-v3` / `advisor-chat-v3` + `milestoneContext`），服务端按
 *     projectId 做归属校验：云端项目**始终**发 v3，来源判定见 `supportsMilestoneContext()`；
 *   - 聊天仍是无状态接口（`POST /api/advisor/chat`，不落库）：`sendChat` 只维持本次会话内存消息，
 *     没有会话/消息读取端点，因此不做「云端历史会话」，也不把内存消息标成已持久化。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  archiveMaterial as archiveMaterialApi,
  attachEvidenceToTask as attachEvidenceToTaskApi,
  completeMilestone as completeMilestoneApi,
  createEvidence as createEvidenceApi,
  createMilestone as createMilestoneApi,
  createProject as createProjectApi,
  createTask as createTaskApi,
  generateMilestoneCandidates,
  getMaterial,
  getProject,
  linkTaskToMilestone as linkTaskToMilestoneApi,
  listEvidence,
  listMaterialSegments,
  listMaterials,
  listMaterialUnderstanding,
  listMilestones,
  listProgress,
  listTasks,
  milestoneAction as milestoneActionApi,
  projectAction as projectActionApi,
  reorderMilestones as reorderMilestonesApi,
  reparseMaterial as reparseMaterialApi,
  restoreMaterial as restoreMaterialApi,
  submitProgress as submitProgressApi,
  uploadMaterial as uploadMaterialApi,
  supersedeProgress as supersedeProgressApi,
  taskAction as taskActionApi,
  updateMilestone as updateMilestoneApi,
  updateProject as updateProjectApi,
  updateTask as updateTaskApi,
  type MaterialPageQuery,
  type MilestoneAction,
  type ProjectAction,
  type ProjectApiOptions,
  type TaskAction,
} from '@/services/projectsApi'
import {
  buildAdvisorChatRequest,
  buildAdvisorRequest,
  fetchAdvisorChat,
  fetchRecommendations,
  toRecommendations,
} from '@/services/advisorApi'
import {
  makeV3Error,
  newRequestId,
  validationError,
  v3Failure,
  type V3ApiError,
} from '@/services/v3Http'
import { searchPapers as searchPapersApi } from '@/services/papersApi'
import type { PaperSearchItem, PapersSource } from '@/services/papersApi'
import {
  getOrCreateChatSession,
  listChatMessages,
  type ChatHistoryMessage,
} from '@/services/chatSessionsApi'
import type {
  ActionResult,
  AdvisorFallbackReason,
  AdvisorOutcome,
  ConfirmedMaterial,
  MilestoneContext,
  Recommendation,
  RecommendationSource,
} from '@/domain/recommendation'
import {
  MAX_ADVISOR_CHAT_QUESTION_LENGTH,
  MILESTONE_CANDIDATE_PROMPT_VERSION,
  supportsMilestoneContext,
} from '@/domain/recommendation'
import {
  buildEvidenceSnapshots,
  buildMilestoneContext,
  buildTaskSnapshots,
  milestoneContextTitle,
  selectConfirmedMaterials,
} from '@/domain/v3Advisor'
import { MATERIAL_TYPES } from '@/domain/materials'
import type {
  CloudAiStatus,
  CloudChatMessage,
  CloudDoubt,
  CloudEvidence,
  CloudMaterial,
  CloudMaterialSegment,
  CloudMaterialUploadState,
  CloudMilestone,
  CloudMilestoneCandidate,
  CloudProject,
  CloudProjectSyncState,
  CloudTask,
  CloudUnderstandingItem,
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

export interface GenerateCandidatesActionInput {
  projectId?: string
  maxCandidates?: 1 | 2 | 3
  focus?: string
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

/* ------------------------------------------------------------ 材料读取 */

export interface MaterialReadActionInput {
  /** 传入时必须等于当前项目；用于 UI 防止串项目 */
  projectId?: string
  /** 不传读当前版本；读历史版本时服务端返回 readOnly=true */
  version?: number
  includeArchived?: boolean
}

export interface RefreshMaterialsActionInput {
  projectId?: string
  includeArchived?: boolean
  limit?: number
}

export interface UploadMaterialActionInput {
  projectId?: string
  /** 文件名，扩展名必须是 md/txt（服务端白名单） */
  name: string
  /** 标准 base64（不带 data URL 前缀） */
  contentBase64: string
}

export interface SupersedeProgressActionInput {
  projectId?: string
  /** 被更正的进展 */
  progressId: string
  /** 被更正进展的当前 revision */
  expectedRevision: number
  summary?: string
  taskId?: string | null
  milestoneId?: string | null
  evidenceIds?: string[]
  occurredAt?: string
}

/* ------------------------------------------------------------- AI 状态 */

export interface CloudAdvisorState {
  status: CloudAiStatus
  suggestions: Recommendation[]
  source: RecommendationSource | null
  cached: boolean
  fallbackReason: AdvisorFallbackReason | null
  requestId: string | null
  error: { code: string; message: string } | null
  /** 本次请求是否真的带上了 milestoneContext（false = 后端能力不足，降级为 v2） */
  contextAttached: boolean
  generatedAt: string | null
}

export interface CloudChatState {
  status: CloudAiStatus
  messages: CloudChatMessage[]
  error: { code: string; message: string } | null
  /** 在途或最近一次失败的问题；失败后 UI 可原样重试，不用重新输入 */
  pendingQuestion: string | null
  contextAttached: boolean
  /** 契约 30.1：当前项目对应的会话 ID；尚未取得时为 null */
  sessionId: string | null
  /**
   * 契约 30.2：历史恢复状态。
   * 失败只影响这里，不阻塞打开项目，也不清空已显示的草稿/消息。
   */
  historyStatus: 'idle' | 'loading' | 'ready' | 'error'
  historyError: { code: string; message: string } | null
}

export interface RefreshAdvisorActionInput {
  projectId?: string
  forceRefresh?: boolean
}

export interface SendChatActionInput {
  projectId?: string
  question: string
}

/* --------------------------------------------------- 论文检索（契约 29，V5） */

/**
 * 契约 29.1 规则 4：降级必须显式区分。
 * `fallback` 只可能是「上游不可用但请求成功」，界面要展示 notice，
 * 不能与「检索成功但确实没有结果」共用同一个状态。
 */
export type CloudPapersStatus = 'idle' | 'loading' | 'ready' | 'fallback' | 'error'

export interface CloudPapersState {
  status: CloudPapersStatus
  /** 已展示的论文；失败时保留上一次结果，不清空 */
  papers: PaperSearchItem[]
  source: PapersSource | null
  /** source === 'fallback' 时的中文说明，界面必须展示 */
  notice: string | null
  error: { code: string; message: string } | null
  /** 本次/最近一次请求的 requestId，重试时原样带回 */
  requestId: string | null
  /** 最近一次发起检索的方向（已 trim） */
  query: string | null
  loadedAt: string | null
}

export interface SearchPapersActionInput {
  projectId?: string
  /** 学生输入的方向，1–200 字；不附加项目名/阶段名 */
  query: string
  limit?: number
  /** 调用方生成的 UUID；同一检索重试必须复用 */
  requestId?: string
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

function emptyAdvisorState(): CloudAdvisorState {
  return {
    status: 'idle',
    suggestions: [],
    source: null,
    cached: false,
    fallbackReason: null,
    requestId: null,
    error: null,
    contextAttached: false,
    generatedAt: null,
  }
}

function emptyPapersState(): CloudPapersState {
  return {
    status: 'idle',
    papers: [],
    source: null,
    notice: null,
    error: null,
    requestId: null,
    query: null,
    loadedAt: null,
  }
}

function emptyChatState(): CloudChatState {
  return {
    status: 'idle',
    messages: [],
    error: null,
    pendingQuestion: null,
    contextAttached: false,
    sessionId: null,
    historyStatus: 'idle',
    historyError: null,
  }
}

/** 片段与理解条目按「材料 + 版本」缓存，换版本不会串用旧条目 */
function materialKey(materialId: string, version: number): string {
  return `${materialId}@${version}`
}

function chatMessageId(): string {
  return `chat_${newRequestId()}`
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

  /* -------- 材料（契约 22.8）：列表 + 按 materialId@version 缓存的片段/理解条目 -------- */
  const materials = ref<CloudMaterial[]>([])
  const materialsStatus = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const materialsError = ref<{ code: string; message: string } | null>(null)
  /** 是否成功读过材料列表；false 时页面不能说「没有材料」 */
  const materialsHydrated = ref(false)
  const materialSegments = ref<Record<string, CloudMaterialSegment[]>>({})
  const materialUnderstanding = ref<Record<string, CloudUnderstandingItem[]>>({})
  const materialReadLoading = ref<Record<string, boolean>>({})
  const materialReadError = ref<{ key: string; code: string; message: string } | null>(null)
  /** 材料上传（契约 22.9）：提交生命周期与列表读取分开，失败可重试 */
  const materialUpload = ref<CloudMaterialUploadState>({
    status: 'idle',
    error: null,
    lastUpload: null,
  })

  /* -------- AI（契约 23）：建议与聊天都是单项目状态，切项目即清空 -------- */
  const advisor = ref<CloudAdvisorState>(emptyAdvisorState())
  const chat = ref<CloudChatState>(emptyChatState())

  /* -------- 论文检索（契约 29）：单项目状态，切项目即清空；不做前端结果缓存 -------- */
  const papers = ref<CloudPapersState>(emptyPapersState())

  /* -------- 阶段候选（契约 23.7）：只读候选，不自动写入项目 -------- */
  const candidates = ref<CloudMilestoneCandidate[]>([])
  const candidatesStatus = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const candidatesError = ref<{ code: string; message: string } | null>(null)
  const candidatesNotice = ref<string | null>(null)

  let epoch = 0
  let activeProjectId: string | null = null
  let abortController = new AbortController()
  let advisorAbort: AbortController | null = null
  let chatAbort: AbortController | null = null
  let advisorToken = 0
  let chatToken = 0
  /** 论文检索：新一次检索接管后，旧响应一律丢弃 */
  let papersToken = 0
  /** 聊天历史恢复单独占一条取消通道：不能和「发消息」互相打断 */
  let chatHistoryAbort: AbortController | null = null
  let chatHistoryToken = 0
  /**
   * 失败后重试同一问题时复用同一个 requestId。
   * 服务端按 `requestId` 对聊天落库去重（契约 30 + 22.6 幂等语义），
   * 换一个 ID 重试会写入两条重复消息。
   */
  let pendingChatRequestId: string | null = null
  /** 在途标记：必须在第一个 await 之前置位，否则并发点击会重复发请求 */
  let advisorInFlight = false
  let chatInFlight = false
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
    '契约 22.11 的时间线端点在当前已合并后端中未实现：timeline 暂不可用',
    '契约 23.7 的阶段候选接口（POST .../milestones/candidates）在已合并后端没有路由：未实现客户端调用',
    '契约 22.4 正文没有 supersede 的请求字段表：客户端按 server/src/v3/progress.ts 实现，需补文档',
    '聊天没有会话/消息读写端点（只有无状态 POST /api/advisor/chat）：云端聊天历史只存在于本次会话内存，刷新即丢失',
    '聊天响应的 citations 已按契约解析，但服务端 D15 之前恒返回空数组：回答里暂时不会出现材料引用',
    'V3 没有疑问读取端点：建议/聊天的 doubts 只能发空数组，未解决疑问不进 AI 上下文',
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
    advisorAbort?.abort()
    advisorAbort = null
    chatAbort?.abort()
    chatAbort = null
    chatHistoryAbort?.abort()
    chatHistoryAbort = null
    advisorToken += 1
    chatToken += 1
    chatHistoryToken += 1
    advisorInFlight = false
    chatInFlight = false
    pendingChatRequestId = null
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
    clearMaterialsState()
    clearCandidatesState()
    advisor.value = emptyAdvisorState()
    chat.value = emptyChatState()
    clearPapersState()
    entityOwners.clear()
  }

  /** 论文检索结果只在「当前项目」内有效：切项目、退出登录、重新打开项目都必须清空 */
  function clearPapersState(): void {
    papersToken += 1
    papers.value = emptyPapersState()
  }

  function clearCandidatesState(): void {
    candidates.value = []
    candidatesStatus.value = 'idle'
    candidatesError.value = null
    candidatesNotice.value = null
  }

  /** 材料状态只在「当前项目」内有效：切项目、退出登录、重新打开项目都必须清空 */
  function clearMaterialsState(): void {
    materials.value = []
    materialsStatus.value = 'idle'
    materialsError.value = null
    materialsHydrated.value = false
    materialSegments.value = {}
    materialUnderstanding.value = {}
    materialReadLoading.value = {}
    materialReadError.value = null
    materialUpload.value = { status: 'idle', error: null, lastUpload: null }
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
    clearMaterialsState()
    clearCandidatesState()
    // 上一个项目的建议/聊天必须丢弃：AI 上下文属于单个项目
    advisorAbort?.abort()
    advisorAbort = null
    chatAbort?.abort()
    chatAbort = null
    chatHistoryAbort?.abort()
    chatHistoryAbort = null
    advisorToken += 1
    chatToken += 1
    chatHistoryToken += 1
    advisorInFlight = false
    chatInFlight = false
    pendingChatRequestId = null
    advisor.value = emptyAdvisorState()
    chat.value = emptyChatState()
    clearPapersState()

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
      // 任务列表（契约 22.3）：读取失败不阻断打开项目，只保持未恢复状态
      await refreshTasks({ ...requestOptions, silent: true })
      // 材料列表（契约 22.8）：同上，失败只体现在 materialsStatus/materialsError
      await refreshMaterials({ ...requestOptions, silent: true })
      // 聊天历史（契约 30.1 / 30.2）：失败只体现在 chat.historyStatus/historyError，
      // 不阻塞打开项目；本地项目不会走到这里（本地聊天仍是内存态）。
      await loadChatHistory({ ...requestOptions, silent: true })
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

  function failCandidates(error: V3ApiError): ActionResult<CloudMilestoneCandidate[]> {
    candidates.value = []
    candidatesStatus.value = 'error'
    candidatesError.value = { code: error.code, message: error.message }
    candidatesNotice.value = null
    setFailure(error)
    return failure(error)
  }

  /**
   * 契约 23.7：生成阶段候选。候选只读，不写入项目；确认创建走 createMilestone。
   */
  async function generateCandidates(
    input: GenerateCandidatesActionInput = {},
  ): Promise<ActionResult<CloudMilestoneCandidate[]>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failCandidates(blocked)
    const maxCandidates = input.maxCandidates ?? 2
    const focus = input.focus === undefined ? null : input.focus.trim()
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 3) {
      return failCandidates(validationError('INVALID_INPUT', '候选数量需为 1～3 个'))
    }
    if (focus !== null && codepointLength(focus) > 200) {
      return failCandidates(validationError('INVALID_INPUT', '生成重点不能超过 200 字'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('generateCandidates')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    candidatesStatus.value = 'loading'
    candidates.value = []
    candidatesError.value = null
    candidatesNotice.value = null
    try {
      const result = await generateMilestoneCandidates(
        projectId,
        {
          projectRevision: projectRevision.value,
          promptVersion: MILESTONE_CANDIDATE_PROMPT_VERSION,
          maxCandidates,
          ...(focus === null || focus === '' ? {} : { focus }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        const mapped = mapAbort(result.error)
        const error = mapped.code === 'STALE_REVISION'
          ? { ...mapped, message: '项目已更新，请刷新后重试' }
          : mapped
        return failCandidates(error)
      }
      candidates.value = result.data.candidates
      candidatesStatus.value = 'ready'
      candidatesNotice.value = result.data.notice
        ?? (result.data.source === 'fallback'
          ? '模型未参与，以下为按项目资料生成的规则候选，请确认后再创建阶段。'
          : null)
      candidatesError.value = null
      clearFailure()
      return { ok: true, data: candidates.value }
    } finally {
      finishAction('generateCandidates')
    }
  }

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
      // 契约 22.2：新建 active 阶段会把它设为当前阶段（服务端已写 current_milestone_id），
      // 创建响应只回 data.milestone，所以本地按同一规则重算，避免 AI 上下文拿不到当前阶段
      recomputeCurrentMilestoneId()
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
      // 阶段状态变化可能影响任务归属/归档状态，按服务端最新列表校正
      await refreshTasks({ silent: true })
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
      // 阶段状态变化可能影响任务归属/归档状态，按服务端最新列表校正
      await refreshTasks({ silent: true })
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
      // 写成功后按服务端最新列表校正（失败不影响本次写入结果）
      await refreshTasks({ silent: true })
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
      await refreshTasks({ silent: true })
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
      // 写成功后按服务端最新列表校正（失败不影响本次写入结果）
      await refreshTasks({ silent: true })
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
      // 写成功后按服务端最新列表校正（失败不影响本次写入结果）
      await refreshTasks({ silent: true })
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

  /**
   * 读取任务列表（契约 22.3），补齐刷新/重进项目后丢失的任务。
   *
   * - 成功：整体替换任务副本并置 `tasksHydrated = true`；
   * - 失败：不改变现有任务，也不置 `tasksHydrated`（避免把"没读到"说成"没有任务"）；
   * - `silent` 用于 openProject / 写操作后的自动刷新，不覆盖项目级 `lastError`。
   */
  async function refreshTasks(
    options: CloudStoreOptions & { silent?: boolean } = {},
  ): Promise<ActionResult<CloudTask[]>> {
    const projectId = activeProjectId
    if (projectId === null) return failure(makeV3Error('NOT_LOADED'))
    const token = epoch
    const collected = new Map<string, CloudTask>()
    let cursor: string | undefined
    let complete = false
    for (let page = 0; page < 100; page += 1) {
      const result = await listTasks(
        projectId,
        {
          includeArchived: true,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
        {
          signal: options.signal ?? abortController.signal,
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        const error = mapAbort(result.error)
        if (options.silent !== true) setFailure(error)
        return failure(error)
      }
      if (result.data.tasks.some((task) => task.projectId !== projectId)) {
        const error = makeV3Error('PROJECT_MISMATCH')
        if (options.silent !== true) setFailure(error)
        return failure(error)
      }
      for (const task of result.data.tasks) collected.set(task.taskId, task)
      if (result.data.nextCursor === null) {
        complete = true
        break
      }
      cursor = result.data.nextCursor
    }
    if (!complete) {
      const error = makeV3Error('INVALID_RESPONSE')
      if (options.silent !== true) setFailure(error)
      return failure(error)
    }
    tasks.value = [...collected.values()]
    for (const task of tasks.value) indexEntity(task.taskId, projectId)
    tasksHydrated.value = true
    return { ok: true, data: tasks.value }
  }

  /* ------------------------------------------------------------ 材料读取 */
  /* 契约 22.8：列表只返回当前版本；片段与理解条目按「材料 + 版本」分页读取并缓存。 */

  function findMaterial(materialId: string): CloudMaterial | null {
    return materials.value.find((item) => item.materialId === materialId) ?? null
  }

  /** 已缓存的片段（同一 materialId + materialVersion），未读过返回 null 而不是空数组 */
  function cachedSegments(materialId: string, version: number): CloudMaterialSegment[] | null {
    return materialSegments.value[materialKey(materialId, version)] ?? null
  }

  function cachedUnderstanding(materialId: string, version: number): CloudUnderstandingItem[] | null {
    return materialUnderstanding.value[materialKey(materialId, version)] ?? null
  }

  function isMaterialReadLoading(materialId: string, version: number): boolean {
    return materialReadLoading.value[materialKey(materialId, version)] === true
  }

  function setMaterialReadLoading(key: string, value: boolean): void {
    const next = { ...materialReadLoading.value }
    if (value) next[key] = true
    else delete next[key]
    materialReadLoading.value = next
  }

  /**
   * 读取材料列表（契约 22.8，分页拉全）。
   *
   * - 成功：整体替换列表并置 `materialsHydrated = true`；
   * - 失败：保留现有列表，状态置 error（不把「没读到」说成「没有材料」）；
   * - `silent` 用于 openProject 的自动加载，不覆盖项目级 lastError。
   */
  async function refreshMaterials(
    options: RefreshMaterialsActionInput & CloudStoreOptions & { silent?: boolean } = {},
  ): Promise<ActionResult<CloudMaterial[]>> {
    const projectId = activeProjectId
    if (projectId === null) return failure(makeV3Error('NOT_LOADED'))
    if (options.projectId !== undefined && options.projectId !== projectId) {
      return failure(makeV3Error('PROJECT_MISMATCH'))
    }
    const token = epoch
    const limit = options.limit ?? 100
    const collected = new Map<string, CloudMaterial>()
    let cursor: string | undefined
    let complete = false

    materialsStatus.value = 'loading'
    for (let page = 0; page < 100; page += 1) {
      const result = await listMaterials(
        projectId,
        {
          limit,
          ...(options.includeArchived === true ? { includeArchived: true } : {}),
          ...(cursor === undefined ? {} : { cursor }),
        },
        {
          signal: options.signal ?? abortController.signal,
          timeoutMs: options.timeoutMs,
          fetchImpl: options.fetchImpl,
        },
      )
      // 项目已切换/重置：状态归新的一次加载所有，这里不能改动 materialsStatus
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        const error = mapAbort(result.error)
        materialsStatus.value = 'error'
        materialsError.value = { code: error.code, message: error.message }
        if (options.silent !== true) setFailure(error)
        return failure(error)
      }
      for (const material of result.data.materials) collected.set(material.materialId, material)
      if (result.data.nextCursor === null) {
        complete = true
        break
      }
      cursor = result.data.nextCursor
    }
    if (!complete) {
      const error = makeV3Error('INVALID_RESPONSE')
      materialsStatus.value = 'error'
      materialsError.value = { code: error.code, message: error.message }
      if (options.silent !== true) setFailure(error)
      return failure(error)
    }

    materials.value = [...collected.values()]
    materialsHydrated.value = true
    materialsStatus.value = 'ready'
    materialsError.value = null
    return { ok: true, data: materials.value }
  }

  /** 读取单份材料（契约 22.8），历史版本会返回 readOnly=true */
  async function loadMaterialDetail(
    materialId: string,
    input: MaterialReadActionInput & CloudStoreOptions = {},
  ): Promise<ActionResult<CloudMaterial>> {
    const projectId = activeProjectId
    if (projectId === null) return failure(makeV3Error('NOT_LOADED'))
    if (input.projectId !== undefined && input.projectId !== projectId) {
      return failure(makeV3Error('PROJECT_MISMATCH'))
    }
    const token = epoch
    const result = await getMaterial(
      projectId,
      materialId,
      {
        version: input.version,
        includeArchived: input.includeArchived === true,
      },
      {
        signal: input.signal ?? abortController.signal,
        timeoutMs: input.timeoutMs,
        fetchImpl: input.fetchImpl,
      },
    )
    if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
    if (!result.ok) {
      const error = mapAbort(result.error)
      setFailure(error)
      return failure(error)
    }
    if (result.data.material.isCurrent) {
      const index = materials.value.findIndex((item) => item.materialId === materialId)
      if (index >= 0) {
        const next = [...materials.value]
        next[index] = result.data.material
        materials.value = next
      }
    }
    return { ok: true, data: result.data.material }
  }

  async function loadMaterialSegments(
    materialId: string,
    input: MaterialReadActionInput & { limit?: number; forceRefresh?: boolean } & CloudStoreOptions = {},
  ): Promise<ActionResult<CloudMaterialSegment[]>> {
    const projectId = activeProjectId
    if (projectId === null) return failure(makeV3Error('NOT_LOADED'))
    if (input.projectId !== undefined && input.projectId !== projectId) {
      return failure(makeV3Error('PROJECT_MISMATCH'))
    }
    const material = findMaterial(materialId)
    const version = input.version ?? material?.materialVersion
    if (version === undefined) return failure(makeV3Error('RESOURCE_NOT_FOUND'))
    const key = materialKey(materialId, version)
    const token = epoch
    const limit = input.limit ?? 200
    const collected: CloudMaterialSegment[] = []
    let cursor: string | undefined
    let complete = false

    // 缓存命中直接返回（includeArchived=true 的语义不同，不读也不写这份缓存）
    const cacheable = input.includeArchived !== true
    const cached = cacheable ? cachedSegments(materialId, version) : null
    if (cached !== null && input.forceRefresh !== true) return { ok: true, data: cached }

    setMaterialReadLoading(key, true)
    try {
      for (let page = 0; page < 100; page += 1) {
        const query: MaterialPageQuery = {
          version,
          includeArchived: input.includeArchived === true,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }
        const result = await listMaterialSegments(projectId, materialId, query, {
          signal: input.signal ?? abortController.signal,
          timeoutMs: input.timeoutMs,
          fetchImpl: input.fetchImpl,
        })
        if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
        if (!result.ok) {
          const error = mapAbort(result.error)
          materialReadError.value = { key, code: error.code, message: error.message }
          return failure(error)
        }
        collected.push(...result.data.segments)
        if (result.data.nextCursor === null) {
          complete = true
          break
        }
        cursor = result.data.nextCursor
      }
      if (!complete) {
        const error = makeV3Error('INVALID_RESPONSE')
        materialReadError.value = { key, code: error.code, message: error.message }
        return failure(error)
      }
      materialSegments.value = { ...materialSegments.value, [key]: collected }
      materialReadError.value = null
      return { ok: true, data: collected }
    } finally {
      setMaterialReadLoading(key, false)
    }
  }

  async function loadMaterialUnderstanding(
    materialId: string,
    input: MaterialReadActionInput & { limit?: number; forceRefresh?: boolean } & CloudStoreOptions = {},
  ): Promise<ActionResult<CloudUnderstandingItem[]>> {
    const projectId = activeProjectId
    if (projectId === null) return failure(makeV3Error('NOT_LOADED'))
    if (input.projectId !== undefined && input.projectId !== projectId) {
      return failure(makeV3Error('PROJECT_MISMATCH'))
    }
    const material = findMaterial(materialId)
    const version = input.version ?? material?.materialVersion
    if (version === undefined) return failure(makeV3Error('RESOURCE_NOT_FOUND'))
    const key = materialKey(materialId, version)
    const token = epoch
    const limit = input.limit ?? 200
    const collected: CloudUnderstandingItem[] = []
    let cursor: string | undefined
    let complete = false

    const cacheable = input.includeArchived !== true
    const cached = cacheable ? cachedUnderstanding(materialId, version) : null
    if (cached !== null && input.forceRefresh !== true) return { ok: true, data: cached }

    setMaterialReadLoading(key, true)
    try {
      for (let page = 0; page < 100; page += 1) {
        const query: MaterialPageQuery = {
          version,
          includeArchived: input.includeArchived === true,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }
        const result = await listMaterialUnderstanding(projectId, materialId, query, {
          signal: input.signal ?? abortController.signal,
          timeoutMs: input.timeoutMs,
          fetchImpl: input.fetchImpl,
        })
        if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
        if (!result.ok) {
          const error = mapAbort(result.error)
          materialReadError.value = { key, code: error.code, message: error.message }
          return failure(error)
        }
        collected.push(...result.data.items)
        if (result.data.nextCursor === null) {
          complete = true
          break
        }
        cursor = result.data.nextCursor
      }
      if (!complete) {
        const error = makeV3Error('INVALID_RESPONSE')
        materialReadError.value = { key, code: error.code, message: error.message }
        return failure(error)
      }
      materialUnderstanding.value = { ...materialUnderstanding.value, [key]: collected }
      materialReadError.value = null
      return { ok: true, data: collected }
    } finally {
      setMaterialReadLoading(key, false)
    }
  }

  /** 新上传的材料插到列表最前；已存在（去重命中/刷新）则原位替换 */
  function upsertMaterial(material: CloudMaterial): void {
    const index = materials.value.findIndex((item) => item.materialId === material.materialId)
    if (index < 0) {
      materials.value = [material, ...materials.value]
      indexEntity(material.materialId, activeProjectId ?? '')
      return
    }
    const next = [...materials.value]
    next[index] = material
    materials.value = next
  }

  function replaceMaterial(material: CloudMaterial): void {
    const index = materials.value.findIndex((item) => item.materialId === material.materialId)
    if (index < 0) return
    const next = [...materials.value]
    next[index] = material
    materials.value = next
  }

  /**
   * 上传一份材料（契约 22.9 `POST /api/projects/{id}/materials`）。
   *
   * 语义边界：
   * - 成功 = 服务端已存下这份材料（`materials` 行 + 原文），**不代表**理解草稿已生成；
   *   新材料的理解条目需要另行生成，`buildConfirmedMaterialsContext()` 在读到条目之前会返回
   *   `MATERIALS_NOT_AVAILABLE`，不会拿空数组冒充「没有可引用材料」；
   * - `parse_failed`（分段失败）同样是提交成功，状态从返回的 `material.status` 读；
   * - `deduplicated=true` 表示同项目同 sha256 命中既有材料：不新建版本、`projectRevision` 不变。
   */
  async function uploadMaterial(
    input: UploadMaterialActionInput,
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<CloudMaterial>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    const projectId = activeProjectId!
    const name = input.name.trim()
    if (name === '') {
      const error = validationError('INVALID_INPUT', '文件名不能为空')
      materialUpload.value = { status: 'error', error: { code: error.code, message: error.message }, lastUpload: null }
      return failure(error)
    }
    if (typeof input.contentBase64 !== 'string' || input.contentBase64.trim() === '') {
      const error = validationError('EMPTY_MATERIAL', '请选择要上传的文件')
      materialUpload.value = { status: 'error', error: { code: error.code, message: error.message }, lastUpload: null }
      return failure(error)
    }
    if (!startAction('uploadMaterial')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    const token = epoch
    materialUpload.value = { status: 'submitting', error: null, lastUpload: materialUpload.value.lastUpload }
    try {
      const result = await uploadMaterialApi(
        projectId,
        { name, contentBase64: input.contentBase64, projectRevision: projectRevision.value },
        { signal: abortController.signal, timeoutMs: options.timeoutMs },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        const error = mapAbort(result.error)
        materialUpload.value = {
          status: 'error',
          error: { code: error.code, message: error.message },
          lastUpload: materialUpload.value.lastUpload,
        }
        setFailure(error)
        return failure(error)
      }

      const { material, segments, segmentCount, deduplicated } = result.data
      upsertMaterial(material)
      // 列表还没完整读过：补一次全量刷新，避免页面把「只有这一份」当成全部
      if (!materialsHydrated.value) await refreshMaterials({ silent: true })
      // 服务端最多回前 20 条片段：只有「返回条数 == 真实总数」时才能整段写进版本缓存，
      // 否则留给 loadMaterialSegments() 分页读取，绝不拿截断结果冒充完整片段。
      if (segmentCount > 0 && segments.length === segmentCount) {
        materialSegments.value = {
          ...materialSegments.value,
          [materialKey(material.materialId, material.materialVersion)]: segments,
        }
      }
      applyRevision(result.projectRevision)
      materialUpload.value = {
        status: 'done',
        error: null,
        lastUpload: {
          materialId: material.materialId,
          materialVersion: material.materialVersion,
          materialStatus: material.status,
          deduplicated,
          segmentCount,
        },
      }
      clearFailure()
      return { ok: true, data: material }
    } finally {
      finishAction('uploadMaterial')
    }
  }

  /** POST .../materials/{materialId}/archive（契约 22.9） */
  async function archiveMaterial(
    materialId: string,
    options: CloudStoreOptions & { projectId?: string } = {},
  ): Promise<ActionResult<CloudMaterial>> {
    const blocked = ensureWritable(options.projectId)
    if (blocked !== null) return failure(blocked)
    const material = findMaterial(materialId)
    if (material === null) return failure(makeV3Error('RESOURCE_NOT_FOUND'))
    if (material.status === 'archived') {
      return failure(validationError('INVALID_STATE_TRANSITION', '这份材料已经归档'))
    }
    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('archiveMaterial')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await archiveMaterialApi(projectId, materialId, projectRevision.value, {
        signal: abortController.signal,
      })
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      // 本地保留这一行（status=archived、readOnly=true），页面能显示「已归档」；
      // 不带 includeArchived 的 refreshMaterials() 之后会把它从列表里去掉。
      replaceMaterial(result.data.material)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.material }
    } finally {
      finishAction('archiveMaterial')
    }
  }

  /** POST .../materials/{materialId}/restore（契约 22.9） */
  async function restoreMaterial(
    materialId: string,
    options: CloudStoreOptions & { projectId?: string } = {},
  ): Promise<ActionResult<CloudMaterial>> {
    const blocked = ensureWritable(options.projectId)
    if (blocked !== null) return failure(blocked)
    const material = findMaterial(materialId)
    if (material === null) return failure(makeV3Error('RESOURCE_NOT_FOUND'))
    if (material.status !== 'archived') {
      return failure(validationError('INVALID_STATE_TRANSITION', '这份材料没有被归档'))
    }
    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('restoreMaterial')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await restoreMaterialApi(projectId, materialId, projectRevision.value, {
        signal: abortController.signal,
      })
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      replaceMaterial(result.data.material)
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.material }
    } finally {
      finishAction('restoreMaterial')
    }
  }

  /**
   * POST .../materials/{materialId}/reparse（契约 22.9）。
   *
   * 服务端会生成新的 materialVersion 并置为当前版本；新版本的片段直接来自响应，
   * 但理解条目需要重新生成 → 新版本的条目缓存不存在，`buildConfirmedMaterialsContext()`
   * 会返回 `MATERIALS_NOT_AVAILABLE` 直到条目被重新读取，不会沿用旧版本的已确认内容。
   */
  async function reparseMaterial(
    materialId: string,
    options: CloudStoreOptions & { projectId?: string } = {},
  ): Promise<ActionResult<CloudMaterial>> {
    const blocked = ensureWritable(options.projectId)
    if (blocked !== null) return failure(blocked)
    const material = findMaterial(materialId)
    if (material === null) return failure(makeV3Error('RESOURCE_NOT_FOUND'))
    if (material.status === 'archived') {
      return failure(validationError('INVALID_STATE_TRANSITION', '归档材料不能重新解析'))
    }
    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('reparseMaterial')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await reparseMaterialApi(projectId, materialId, projectRevision.value, {
        signal: abortController.signal,
      })
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }
      replaceMaterial(result.data.material)
      const key = materialKey(result.data.material.materialId, result.data.material.materialVersion)
      materialSegments.value = { ...materialSegments.value, [key]: result.data.segments }
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.material }
    } finally {
      finishAction('reparseMaterial')
    }
  }

  /**
   * 契约 23.3：组装 `confirmedMaterials`。
   *
   * 只用**已经读过**的理解条目与片段；有任何一份可入 AI 的材料还没读，就返回
   * `MATERIALS_NOT_AVAILABLE`，绝不用空数组冒充「没有已确认材料」。
   */
  function buildConfirmedMaterialsContext(): ActionResult<ConfirmedMaterial[]> {
    if (activeProjectId === null || projectMeta.value === null) {
      return failure(makeV3Error('NOT_LOADED'))
    }
    if (!materialsHydrated.value) return failure(makeV3Error('MATERIALS_NOT_AVAILABLE'))

    const items: CloudUnderstandingItem[] = []
    const segments: CloudMaterialSegment[] = []
    for (const material of materials.value) {
      if (!material.isCurrent || material.status !== 'parsed') continue
      if (!(MATERIAL_TYPES as readonly string[]).includes(material.type)) continue
      const version = material.materialVersion
      const cachedItems = cachedUnderstanding(material.materialId, version)
      const cachedSegmentList = cachedSegments(material.materialId, version)
      if (cachedItems === null || cachedSegmentList === null) {
        return failure(makeV3Error('MATERIALS_NOT_AVAILABLE'))
      }
      items.push(...cachedItems)
      segments.push(...cachedSegmentList)
    }

    return { ok: true, data: selectConfirmedMaterials(items, segments, materials.value) }
  }

  /** 确保所有可入 AI 的材料都读过片段与理解条目，再组装上下文 */
  async function ensureConfirmedMaterialsContext(
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<ConfirmedMaterial[]>> {
    if (activeProjectId === null) return failure(makeV3Error('NOT_LOADED'))
    if (!materialsHydrated.value) {
      const loaded = await refreshMaterials({ ...options, silent: true })
      if (!loaded.ok) return failure(makeV3Error('MATERIALS_NOT_AVAILABLE'))
    }
    for (const material of materials.value) {
      if (!material.isCurrent || material.status !== 'parsed') continue
      if (!(MATERIAL_TYPES as readonly string[]).includes(material.type)) continue
      const version = material.materialVersion
      if (cachedUnderstanding(material.materialId, version) === null) {
        const result = await loadMaterialUnderstanding(material.materialId, { ...options, version })
        if (!result.ok) return failure(makeV3Error('MATERIALS_NOT_AVAILABLE'))
      }
      if (cachedSegments(material.materialId, version) === null) {
        const result = await loadMaterialSegments(material.materialId, { ...options, version })
        if (!result.ok) return failure(makeV3Error('MATERIALS_NOT_AVAILABLE'))
      }
    }
    return buildConfirmedMaterialsContext()
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

  /**
   * 契约 22.4：更正一条已提交的进展。
   *
   * 服务端行为：旧记录置 `superseded`（正文保留、revision+1），新建一条 `active` 记录，
   * 响应只返回新记录 + `supersededProgressId`，**不返回旧记录**；因此本地对旧记录只做
   * `status = 'superseded'`（+revision/updatedAt）的最小同步。
   *
   * 更正后 `progress` 里只剩一条 active，`buildMilestoneContext` 只取 active 记录，
   * 顾问/聊天拿到的必然是更正后的正文。
   */
  async function supersedeProgress(
    input: SupersedeProgressActionInput,
  ): Promise<ActionResult<ProgressRecord>> {
    const blocked = ensureWritable(input.projectId)
    if (blocked !== null) return failure(blocked)
    if (input.summary !== undefined) {
      const summary = input.summary.trim()
      if (summary === '' || codepointLength(summary) > 1000) {
        return failure(validationError('INVALID_INPUT', '进展说明需为 1～1000 字'))
      }
    }
    const previous = progress.value.find((item) => item.progressId === input.progressId)
    if (previous === undefined) return failure(makeV3Error('RESOURCE_NOT_FOUND'))
    if (previous.status !== 'active') {
      return failure(validationError('INVALID_STATE_TRANSITION', '这条进展已被更正，不能重复更正'))
    }
    if (previous.revision !== input.expectedRevision) {
      return failure(makeV3Error('STALE_REVISION', { currentEntityRevision: previous.revision }))
    }
    const milestoneError = validateTaskMilestone(input.milestoneId ?? null)
    if (milestoneError !== null) return failure(milestoneError)
    if (input.taskId !== undefined && input.taskId !== null) {
      const taskOwner = checkEntityOwner(input.taskId)
      if (taskOwner !== null) return failure(taskOwner)
      if (findTask(input.taskId) === null) return failure(makeV3Error('TASKS_NOT_AVAILABLE'))
    }
    for (const evidenceId of input.evidenceIds ?? []) {
      const owner = checkEntityOwner(evidenceId)
      if (owner !== null) return failure(owner)
      if (findEvidence(evidenceId) === null) return failure(makeV3Error('EVIDENCE_NOT_FOUND'))
    }

    const projectId = activeProjectId!
    const token = epoch
    if (!startAction('supersedeProgress')) return failure(makeV3Error('DUPLICATE_REQUEST'))
    try {
      const result = await supersedeProgressApi(
        {
          projectId,
          projectRevision: projectRevision.value,
          progressId: input.progressId,
          expectedRevision: input.expectedRevision,
          ...(input.summary === undefined ? {} : { summary: input.summary.trim() }),
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.milestoneId === undefined ? {} : { milestoneId: input.milestoneId }),
          ...(input.evidenceIds === undefined ? {} : { evidenceIds: input.evidenceIds }),
          ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
        },
        { signal: abortController.signal },
      )
      if (isStale(token, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!result.ok) {
        setFailure(mapAbort(result.error))
        return failure(mapAbort(result.error))
      }

      // 旧记录：服务端已把它置 superseded；本地只更新状态与版本，保留正文
      const superseded = progress.value.find((item) => item.progressId === result.data.supersededProgressId)
      if (superseded !== undefined) {
        applyProgress({
          ...superseded,
          status: 'superseded',
          revision: superseded.revision + 1,
          updatedAt: result.data.progress.createdAt,
        })
      }
      applyProgress(result.data.progress)
      applyMilestoneStats(
        result.data.progress.milestoneId ?? input.milestoneId ?? null,
        result.data.milestoneStats,
      )
      applyRevision(result.projectRevision)
      clearFailure()
      return { ok: true, data: result.data.progress }
    } finally {
      finishAction('supersedeProgress')
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

  /* ------------------------------------------------------- AI：建议 / 聊天 */

  /**
   * 组装建议/聊天共用的请求输入。
   *
   * - 本 store 只服务**云端项目**，因此按 `supportsMilestoneContext('cloud')` 固定发 v3：
   *   `milestoneContext` 一定是 `buildAdvisorContext()` 的真实产物（空白项目是全 null 的空上下文，
   *   契约 23.2 规则 2 允许）；本地工作台走 `workbench` store，不经过这里，仍然发 v2；
   * - `confirmedMaterials`：只用已确认条目，且必须先读过；读不到就整次请求拒绝，
   *   不用空数组冒充「没有已确认材料」；
   * - `doubts`：V3 没有疑问读取端点（接口清单 ⬜），只能发空数组，这一项是已知的信息缺口。
   */
  async function buildAiRequestBase(
    options: CloudStoreOptions,
  ): Promise<
    | {
        ok: true
        attach: boolean
        context: MilestoneContext
        confirmedMaterials: ConfirmedMaterial[]
        tasks: ReturnType<typeof buildTaskSnapshots>
        evidence: ReturnType<typeof buildEvidenceSnapshots>
        projectId: string
        projectRevision: number
        projectName: string
        currentMilestone: string | null
      }
    | { ok: false; error: V3ApiError }
  > {
    const projectId = activeProjectId
    const meta = projectMeta.value
    if (projectId === null || meta === null) return { ok: false, error: makeV3Error('NOT_LOADED') }
    if (!tasksHydrated.value) return { ok: false, error: makeV3Error('TASKS_NOT_AVAILABLE') }

    const context = buildAdvisorContext()
    if (!context.ok) return { ok: false, error: makeV3Error(context.code) }

    const confirmed = await ensureConfirmedMaterialsContext(options)
    if (!confirmed.ok) return { ok: false, error: makeV3Error(confirmed.code) }

    const attach = supportsMilestoneContext('cloud')
    return {
      ok: true,
      attach,
      context: context.data,
      confirmedMaterials: confirmed.data,
      tasks: buildTaskSnapshots(tasks.value, projectId),
      evidence: buildEvidenceSnapshots(evidence.value, projectId),
      projectId,
      projectRevision: projectRevision.value,
      projectName: meta.name,
      // 契约 23.2 规则 5：两者都非空时必须一致；发送阶段上下文时以上下文为准
      // （当前阶段已完成/归档时上下文全 null，这里也随之变成 null，不会出现「半空」组合）
      currentMilestone: attach ? milestoneContextTitle(context.data) : meta.currentMilestone,
    }
  }

  /** 契约 23.5：刷新云端项目的顾问建议 */
  async function refreshAdvisor(
    options: RefreshAdvisorActionInput & CloudStoreOptions = {},
  ): Promise<ActionResult<AdvisorOutcome>> {
    const projectId = activeProjectId
    if (projectId === null || projectMeta.value === null) return failure(makeV3Error('NOT_LOADED'))
    if (options.projectId !== undefined && options.projectId !== projectId) {
      return failure(makeV3Error('PROJECT_MISMATCH'))
    }
    // 抢占标记必须在第一个 await 之前：并发的第二次点击不能等到上下文组装完才被拒
    if (advisorInFlight || advisor.value.status === 'loading') {
      return failure(makeV3Error('DUPLICATE_REQUEST'))
    }
    const entryEpoch = epoch
    advisorInFlight = true
    try {
      const base = await buildAiRequestBase(options)
      // 组装上下文期间切换了项目/退出登录：这份请求已不属于当前项目
      if (isStale(entryEpoch, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!base.ok) {
        advisor.value = {
          ...advisor.value,
          status: 'error',
          error: { code: base.error.code, message: base.error.message },
          contextAttached: false,
        }
        return failure(base.error)
      }
      return await requestAdvisor(base, options)
    } finally {
      advisorInFlight = false
    }
  }

  /** 真正发请求的部分（与上下文组装分开，便于保证并发标记的清理） */
  async function requestAdvisor(
    base: Extract<Awaited<ReturnType<typeof buildAiRequestBase>>, { ok: true }>,
    options: RefreshAdvisorActionInput & CloudStoreOptions,
  ): Promise<ActionResult<AdvisorOutcome>> {
    const projectId = base.projectId
    const meta = projectMeta.value
    if (meta === null) return failure(makeV3Error('NOT_LOADED'))

    const request = buildAdvisorRequest({
      projectId: base.projectId,
      projectRevision: base.projectRevision,
      projectName: base.projectName,
      currentMilestone: base.currentMilestone,
      tasks: base.tasks,
      evidence: base.evidence,
      doubts: [],
      projectProfile: meta.profile,
      confirmedMaterials: base.confirmedMaterials,
      milestoneContext: base.attach ? base.context : null,
      forceRefresh: options.forceRefresh === true,
    })

    advisorAbort?.abort()
    const controller = new AbortController()
    advisorAbort = controller
    advisorToken += 1
    const token = advisorToken
    const projectToken = epoch
    advisor.value = {
      ...emptyAdvisorState(),
      status: 'loading',
      requestId: request.requestId,
      contextAttached: base.attach,
    }

    try {
      const result = await fetchRecommendations(request, {
        signal: options.signal ?? controller.signal,
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      })
      // 过期判断：新请求接管 / 项目切换 / 退出登录，任何一个成立都丢弃
      if (token !== advisorToken || isStale(projectToken, projectId)) {
        return failure(makeV3Error('STALE_RESPONSE'))
      }
      if (!result.ok) {
        const error = result.error
        if (error.code === 'STALE_RESPONSE') {
          return failure(makeV3Error('STALE_RESPONSE'))
        }
        advisor.value = {
          ...emptyAdvisorState(),
          status: 'error',
          error: { code: error.code, message: error.message },
          contextAttached: base.attach,
        }
        return { ok: false, code: error.code, message: error.message }
      }

      const suggestions = toRecommendations(result.data)
      advisor.value = {
        status: 'ready',
        suggestions,
        source: result.data.source,
        cached: result.data.cached,
        fallbackReason: result.data.fallbackReason,
        requestId: result.data.requestId,
        error: null,
        contextAttached: base.attach,
        generatedAt: new Date().toISOString(),
      }
      clearFailure()
      return {
        ok: true,
        data: {
          source: result.data.source,
          suggestions,
          cached: result.data.cached,
          fallbackReason: result.data.fallbackReason,
          requestId: result.data.requestId,
        },
      }
    } finally {
      if (advisorAbort === controller) advisorAbort = null
    }
  }

  /**
   * 契约 30.2：历史消息 → 现有 `CloudChatMessage`。
   *
   * 历史消息**没有** `source` / `fallbackReason`（只有实时响应才有），
   * 这里刻意不填，运行期保持 `undefined`：界面读到 undefined 时不会渲染任何来源标签，
   * 也就不会把历史消息伪装成「AI 模型回答」。
   *
   * 类型上 `CloudChatMessage.source` 仍标为必填（界面据此取来源文案，本批次不改界面层），
   * 所以这里做一次窄转换；需要彻底类型安全时，由界面层补一个 undefined 分支即可。
   */
  function toHistoryChatMessage(dto: ChatHistoryMessage): CloudChatMessage {
    const message = {
      clientId: `hist_${dto.messageId}`,
      role: dto.role,
      text: dto.content,
      citations: dto.citations.map((citation) => ({ ...citation })),
      createdAt: dto.createdAt,
      messageId: dto.messageId,
      // 历史消息一定是服务端读回来的，等价于已落库
      persisted: true,
    }
    return message as unknown as CloudChatMessage
  }

  /**
   * 契约 30.1 / 30.2：恢复当前云端项目的聊天历史。
   *
   * - 先 POST sessions 取得/创建会话，再 GET messages（只带 limit，不带 before）；
   * - 失败降级为空历史 + `historyError`：不阻塞打开项目，也不碰已有消息与待重发问题；
   * - 项目切换 / 退出 / 新一次恢复接管后，迟到响应按 epoch + token 丢弃。
   */
  async function loadChatHistory(
    options: CloudStoreOptions & { silent?: boolean } = {},
  ): Promise<ActionResult<CloudChatMessage[]>> {
    const projectId = activeProjectId
    if (projectId === null || projectMeta.value === null) return failure(makeV3Error('NOT_LOADED'))

    const revision = projectRevision.value
    if (!Number.isInteger(revision) || revision < 1) {
      // 契约 30.1 的写信封要求正整数 projectRevision；拿不到就不发请求，也不编造
      return failure(makeV3Error('INVALID_INPUT'))
    }

    const projectToken = epoch
    chatHistoryAbort?.abort()
    const controller = new AbortController()
    chatHistoryAbort = controller
    chatHistoryToken += 1
    const token = chatHistoryToken
    const signal = options.signal ?? controller.signal

    chat.value = { ...chat.value, historyStatus: 'loading', historyError: null }

    try {
      const session = await getOrCreateChatSession(projectId, {
        projectRevision: revision,
        signal,
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      })
      if (token !== chatHistoryToken || isStale(projectToken, projectId)) {
        return failure(makeV3Error('STALE_RESPONSE'))
      }
      if (!session.ok) {
        const error = mapAbort(session.error)
        chat.value = {
          ...chat.value,
          historyStatus: 'error',
          historyError: { code: error.code, message: error.message },
        }
        if (options.silent !== true) setFailure(error)
        return failure(error)
      }

      const history = await listChatMessages(
        projectId,
        session.data.sessionId,
        {},
        { signal, timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl },
      )
      if (token !== chatHistoryToken || isStale(projectToken, projectId)) {
        return failure(makeV3Error('STALE_RESPONSE'))
      }
      if (!history.ok) {
        const error = mapAbort(history.error)
        chat.value = {
          ...chat.value,
          // 会话已拿到：保留它，失败只影响消息列表
          sessionId: session.data.sessionId,
          historyStatus: 'error',
          historyError: { code: error.code, message: error.message },
        }
        if (options.silent !== true) setFailure(error)
        return failure(error)
      }

      const messages = history.data.messages.map(toHistoryChatMessage)
      chat.value = {
        ...chat.value,
        sessionId: session.data.sessionId,
        messages,
        historyStatus: 'ready',
        historyError: null,
      }
      return { ok: true, data: messages }
    } finally {
      if (chatHistoryAbort === controller) chatHistoryAbort = null
    }
  }

  /**
   * 契约 6.4 / 23.7：向顾问提问一次。
   *
   * 后端只有无状态聊天接口：历史由客户端每次回传（`chatHistory`），消息只存在本次会话内存里。
   * 因此：
   * - 没有「会话列表 / 历史消息」读取端点，刷新或换设备后聊天不可恢复（阻塞项，不伪造）；
   * - 用户消息只在请求成功后与回答一起入列，失败时用 `pendingQuestion` 保留原文供重试，避免重复入列；
   * - 同一时刻只允许一个在途提问，重复点击返回 `DUPLICATE_REQUEST`。
   */
  async function sendChat(
    input: SendChatActionInput & CloudStoreOptions,
  ): Promise<ActionResult<CloudChatMessage>> {
    const projectId = activeProjectId
    if (projectId === null || projectMeta.value === null) return failure(makeV3Error('NOT_LOADED'))
    if (input.projectId !== undefined && input.projectId !== projectId) {
      return failure(makeV3Error('PROJECT_MISMATCH'))
    }
    const question = input.question.trim()
    if (question === '') return failure(validationError('INVALID_INPUT', '请先写下要问的问题'))
    if (codepointLength(question) > MAX_ADVISOR_CHAT_QUESTION_LENGTH) {
      return failure(
        validationError('INVALID_INPUT', `问题不能超过 ${MAX_ADVISOR_CHAT_QUESTION_LENGTH} 字，请精简后再问`),
      )
    }
    // 同 refreshAdvisor：并发标记必须在 await 之前，否则连点会发出两次请求
    if (chatInFlight || chat.value.status === 'loading') return failure(makeV3Error('DUPLICATE_REQUEST'))
    // 重试同一个问题时复用同一个 requestId：服务端按它重放去重，
    // 换一个 ID 重试会写入两条重复消息（契约 30 未写、但与 22.6 幂等语义一致）
    if (pendingChatRequestId === null || chat.value.pendingQuestion !== question) {
      pendingChatRequestId = newRequestId()
    }
    const entryEpoch = epoch
    chatInFlight = true
    try {
      const base = await buildAiRequestBase(input)
      if (isStale(entryEpoch, projectId)) return failure(makeV3Error('STALE_RESPONSE'))
      if (!base.ok) {
        chat.value = {
          ...chat.value,
          status: 'error',
          error: { code: base.error.code, message: base.error.message },
          pendingQuestion: question,
          contextAttached: false,
        }
        return failure(base.error)
      }
      return await requestChat(base, question, input)
    } finally {
      chatInFlight = false
    }
  }

  /** 真正发聊天请求的部分；历史在发出瞬间快照，成功后与回答一起入列 */
  async function requestChat(
    base: Extract<Awaited<ReturnType<typeof buildAiRequestBase>>, { ok: true }>,
    question: string,
    input: SendChatActionInput & CloudStoreOptions,
  ): Promise<ActionResult<CloudChatMessage>> {
    const projectId = base.projectId
    const meta = projectMeta.value
    if (meta === null) return failure(makeV3Error('NOT_LOADED'))
    const request = buildAdvisorChatRequest({
      projectId: base.projectId,
      projectRevision: base.projectRevision,
      projectName: base.projectName,
      currentMilestone: base.currentMilestone,
      tasks: base.tasks,
      evidence: base.evidence,
      doubts: [],
      question,
      // 失败重试时复用同一个 requestId，避免服务端重复落库
      ...(pendingChatRequestId === null ? {} : { requestId: pendingChatRequestId }),
      chatHistory: chat.value.messages.map((message) => ({ role: message.role, text: message.text })),
      projectProfile: meta.profile,
      confirmedMaterials: base.confirmedMaterials,
      milestoneContext: base.attach ? base.context : null,
    })

    chatAbort?.abort()
    const controller = new AbortController()
    chatAbort = controller
    chatToken += 1
    const token = chatToken
    const projectToken = epoch
    chat.value = {
      ...chat.value,
      status: 'loading',
      error: null,
      pendingQuestion: question,
      contextAttached: base.attach,
    }

    try {
      const result = await fetchAdvisorChat(request, {
        signal: input.signal ?? controller.signal,
        timeoutMs: input.timeoutMs,
        fetchImpl: input.fetchImpl,
      })
      if (token !== chatToken || isStale(projectToken, projectId)) {
        return failure(makeV3Error('STALE_RESPONSE'))
      }
      if (!result.ok) {
        const error = result.error
        if (error.code === 'STALE_RESPONSE') {
          return failure(makeV3Error('STALE_RESPONSE'))
        }
        chat.value = {
          ...chat.value,
          status: 'error',
          error: { code: error.code, message: error.message },
          pendingQuestion: question,
        }
        return { ok: false, code: error.code, message: error.message }
      }

      const createdAt = new Date().toISOString()
      // 契约 30.3：messageId 为 null = 没有落库（本地项目 / 未登录 / 落库失败），
      // 此时照常展示回答，但不得把消息标成「已保存」
      const messageId = result.data.messageId ?? null
      const persisted = messageId !== null
      const userMessage: CloudChatMessage = {
        clientId: chatMessageId(),
        role: 'user',
        text: question,
        source: 'model',
        fallbackReason: null,
        citations: [],
        createdAt,
        // 服务端只回助手消息的 messageId，提问不单独标记已持久化
        messageId: null,
        persisted: false,
      }
      const assistantMessage: CloudChatMessage = {
        clientId: chatMessageId(),
        role: 'assistant',
        text: result.data.answer,
        source: result.data.source,
        fallbackReason: result.data.fallbackReason,
        citations: (result.data.citations ?? []).map((citation) => ({
          materialId: citation.materialId,
          materialName: citation.materialName,
          materialVersion: citation.materialVersion,
          segmentId: citation.segmentId,
          startLine: citation.startLine,
          endLine: citation.endLine,
          itemId: citation.itemId,
        })),
        createdAt: new Date().toISOString(),
        messageId,
        persisted,
      }
      // 本次提问已成功：下一次提问换新的 requestId
      pendingChatRequestId = null
      chat.value = {
        ...chat.value,
        status: 'ready',
        sessionId: result.data.sessionId ?? chat.value.sessionId,
        messages: [...chat.value.messages, userMessage, assistantMessage],
        error: null,
        pendingQuestion: null,
      }
      clearFailure()
      return { ok: true, data: assistantMessage }
    } finally {
      if (chatAbort === controller) chatAbort = null
    }
  }

  /** 重发上一次失败的问题；问题文本不会被清掉，用户也不用重新输入 */
  function retryChat(options: CloudStoreOptions = {}): Promise<ActionResult<CloudChatMessage>> {
    const question = chat.value.pendingQuestion
    if (question === null) return Promise.resolve(failure(makeV3Error('INVALID_INPUT')))
    return sendChat({ ...options, question })
  }

  /** 只清空本次会话的聊天（后端不落库，没有云端历史可以删） */
  function clearChat(): void {
    chatAbort?.abort()
    chatAbort = null
    chatToken += 1
    chatInFlight = false
    chat.value = emptyChatState()
  }

  /**
   * 契约 23.2：构造当前阶段的 AI 上下文。
   *
   * 职责分工（避免两处重复组装）：
   * - 本函数只负责「从 store 取当前状态 + 校验完整性」，然后交给 domain；
   * - 字段裁剪、排序、上限、空上下文形状全部由 `buildMilestoneContext()`（domain/v3Advisor）决定。
   *
   * 完整性：只有「服务端统计为 0 个任务」或「本次会话已知任务数 == 统计数」才认为任务齐了；
   * 否则返回 TASKS_NOT_AVAILABLE，绝不拿部分任务冒充「该阶段全部任务」。
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

  /**
   * 契约 29.2：检索论文。
   *
   * 约定：
   * - `requestId` 由调用方生成；重试同一检索时传回同一个值，服务端据此重放；
   * - 不做前端结果缓存，每次调用都真的发请求；
   * - `fallback` 是独立状态，`notice` 原样保留给界面，绝不退化成普通零结果；
   * - 失败只标记状态与错误，保留已展示的论文；
   * - 项目切换/退出/reset 后，迟到响应按 epoch + token 丢弃。
   */
  async function searchPapers(
    input: SearchPapersActionInput & CloudStoreOptions,
  ): Promise<ActionResult<CloudPapersState>> {
    const projectId = activeProjectId
    if (projectId === null || projectMeta.value === null) return failure(makeV3Error('NOT_LOADED'))
    if (input.projectId !== undefined && input.projectId !== projectId) {
      return failure(makeV3Error('PROJECT_MISMATCH'))
    }

    const query = input.query.trim()
    if (query === '') return failure(makeV3Error('INVALID_INPUT'))

    const requestId = input.requestId ?? newRequestId()
    const projectToken = epoch
    papersToken += 1
    const token = papersToken
    // 加载中保留上一份结果：界面进入「检索中」，但不清空已展示内容
    papers.value = { ...papers.value, status: 'loading', error: null, requestId, query }

    const result = await searchPapersApi({
      projectId,
      query,
      limit: input.limit,
      requestId,
      signal: input.signal ?? abortController.signal,
      timeoutMs: input.timeoutMs,
      fetchImpl: input.fetchImpl,
    })

    // 新一次检索接管 / 项目切换 / 退出登录：迟到响应丢弃，不写入任何状态
    if (token !== papersToken || isStale(projectToken, projectId)) {
      return failure(makeV3Error('STALE_RESPONSE'))
    }

    if (!result.ok) {
      const error = mapAbort(result.error)
      if (error.code === 'STALE_RESPONSE') {
        return failure(makeV3Error('STALE_RESPONSE'))
      }
      papers.value = {
        ...papers.value,
        status: 'error',
        error: { code: error.code, message: error.message },
        requestId,
      }
      return failure(error)
    }

    papers.value = {
      status: result.data.source === 'fallback' ? 'fallback' : 'ready',
      papers: result.data.papers,
      source: result.data.source,
      notice: result.data.notice,
      error: null,
      requestId,
      query,
      loadedAt: new Date().toISOString(),
    }
    clearFailure()
    return { ok: true, data: papers.value }
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

    /* 材料（契约 22.8） */
    materials,
    materialsStatus,
    materialsError,
    materialsHydrated,
    materialSegments,
    materialUnderstanding,
    materialReadError,
    isMaterialReadLoading,
    findMaterial,
    cachedSegments,
    cachedUnderstanding,

    /* AI（契约 23.1 / 6.4 / 23.7） */
    advisor,
    chat,
    candidates,
    candidatesStatus,
    candidatesError,
    candidatesNotice,

    /* 生命周期 */
    openProject,
    reset,
    refreshEvidence,
    refreshProgress,
    refreshMilestones,
    refreshTasks,
    refreshMaterials,
    uploadMaterial,
    materialUpload,
    loadMaterialDetail,
    loadMaterialSegments,
    loadMaterialUnderstanding,
    buildConfirmedMaterialsContext,
    archiveMaterial,
    restoreMaterial,
    reparseMaterial,
    loadTimeline,
    createProject,

    /* 项目写动作（契约 22.1） */
    updateProject,
    archiveProject,
    restoreProject,
    deleteProject,
    restoreDeletedProject,

    /* 阶段写动作（契约 22.2 / 23.7） */
    generateCandidates,
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
    supersedeProgress,
    createEvidence,
    attachEvidenceToTask,

    /* AI（契约 23.2 / 23.5 / 6.4） */
    buildAdvisorContext,
    refreshAdvisor,
    sendChat,
    retryChat,
    clearChat,

    /* 论文检索（契约 29） */
    papers,
    searchPapers,
  }
})
