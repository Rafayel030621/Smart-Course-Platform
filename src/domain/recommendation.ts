/**
 * 建议接口的领域类型与线上 DTO
 * ----------------------------------------------------------------------------
 * 唯一依据：docs/contracts.md（第 2 节领域对象、第 4 节建议接口、第 6 节错误码）。
 *
 * 两条约定：
 *   1. 线上字段名与契约完全一致，不另造一套 DTO；契约里没有的字段不要凭空加。
 *   2. 前端本地字段（id / source / requestId / projectRevision / generatedAt）
 *      按契约 2.5(b) 只挂在 Recommendation 上，不混进线格式 Suggestion。
 */

import type {
  DoubtStatus,
  Material,
  MaterialEncoding,
  MaterialState,
  MaterialType,
  NewTaskDraft,
  ProjectProfile,
  TaskStatus,
  UnderstandingBlockStatus,
  UnderstandingDraft,
} from '@/types/platform'

export type { DoubtStatus, TaskStatus, NewTaskDraft }

/** 契约版本：与 docs/contracts.md 第 8.1 节一致 */
export const CONTRACT_VERSION = '1.0'

/**
 * 建议接口的当前提示词版本（契约 17.4）。
 *
 * v1.3 起默认值就是 v2：`docs/ai/prompt-spec.md` §9.1 已登记「四处取值全部切换完毕」。
 * 调用方**显式**传入的值一律原样保留，不做静默改写——「带 v2 字段却发 v1」这类接线
 * 错误应当由服务端按契约 17.4 规则 2 返回 400 暴露出来，前端藏起来只会更难排查。
 */
export const DEFAULT_PROMPT_VERSION = 'mvp-prompt-v2'

/** 契约 17.4：v1 取值兼容保留（旧页面可能仍在用，服务端不删除该取值） */
export const ADVISOR_PROMPT_VERSION_V1 = 'mvp-prompt-v1'

/** 契约 17.4：聊天接口的当前提示词版本；`advisor-chat-v1` 兼容保留 */
export const ADVISOR_CHAT_PROMPT_VERSION = 'advisor-chat-v2'

/**
 * 契约 23.1 / 23.4：**建议接口**的 v3 提示词版本；必须与 `milestoneContext` 成对出现。
 *
 * 名字里带 `ADVISOR`：它只用于 `POST /api/advisor/recommendations`，与阶段候选接口的
 * `milestone-candidate-v1` 不是同一个东西，不能互相顶替。
 */
export const ADVISOR_V3_PROMPT_VERSION = 'mvp-prompt-v3'

/** 契约 23.1：聊天接口的 v3 提示词版本；必须与 milestoneContext 成对出现 */
export const ADVISOR_CHAT_PROMPT_VERSION_V3 = 'advisor-chat-v3'

/**
 * 契约 23.4 / 23.7：**阶段候选接口**（`POST /api/projects/{projectId}/milestones/candidates`）
 * 的提示词版本。
 *
 * D12 状态：契约已定义取值与请求体，但服务端路由尚未确认存在（`server/src/v3/router.ts`
 * 没有该路径）。因此这里**只定义常量**：候选接口一旦确认可用，直接用它装配请求，
 * 不要拿建议接口的 `mvp-prompt-v3` 顶替，也不要提前发请求。
 */
export const MILESTONE_CANDIDATE_PROMPT_VERSION = 'milestone-candidate-v1'

/** 契约 17.4：材料理解接口的提示词版本，只此一值 */
export const MATERIAL_UNDERSTANDING_PROMPT_VERSION = 'material-understanding-v1'

/** 契约 6.4：聊天问题 ≤ 2,000 字、历史 ≤ 20 条、每条文本 ≤ 2,000 字 */
/** 契约 4.1 / 15.2：`projectName` 最多 120 字（超长会让整个请求被 400 拒绝） */
export const MAX_PROJECT_NAME_LENGTH = 120

/** 契约 4.1：`currentMilestone` 最多 60 字 */
export const MAX_CURRENT_MILESTONE_LENGTH = 60

/**
 * 按契约上限裁剪项目名 / 里程碑名。
 *
 * 自定义题目允许学生随意填写，超长时**不能让整个请求失败**：
 * 服务端会按 §4.1 的上限返回 400 `INVALID_INPUT`，那时建议与聊天就完全不可用了。
 * 这里与 `question` / `chatHistory` 的处理一致——超长截断，不改变正常输入。
 */
export function clampProjectName(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const text = value.trim()
  if (text === '') return null
  return text.length > MAX_PROJECT_NAME_LENGTH ? text.slice(0, MAX_PROJECT_NAME_LENGTH) : text
}

export function clampCurrentMilestone(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const text = value.trim()
  if (text === '') return null
  return text.length > MAX_CURRENT_MILESTONE_LENGTH ? text.slice(0, MAX_CURRENT_MILESTONE_LENGTH) : text
}

export const MAX_ADVISOR_CHAT_QUESTION_LENGTH = 2_000
export const MAX_ADVISOR_CHAT_HISTORY = 20
export const MAX_ADVISOR_CHAT_TEXT_LENGTH = 2_000

/**
 * 建议来源。
 * `model` / `fallback` 由后端返回；`local-rule` 只由前端本地规则产生，永远不会出现在 HTTP 响应里
 * （契约 4.3）。本轮只保留这个类型扩展点，不实现本地规则。
 */
export type RecommendationSource = 'model' | 'fallback' | 'local-rule'

/** 后端返回的来源：不含 local-rule */
export type AdvisorResponseSource = Exclude<RecommendationSource, 'local-rule'>

/* ------------------------------------------------------------ 请求侧快照 */

/** 契约 4.1：TaskSnapshot 不含 projectId，归属由顶层 projectId 决定 */
export interface TaskSnapshot {
  taskId: string
  title: string
  status: TaskStatus
  doneCriteria: string | null
  owner: string | null
  milestone: string | null
  updatedAt: string
}

export interface EvidenceSnapshot {
  evidenceId: string
  submissionId: string
  taskId: string | null
  didWhat: string
  foundWhat: string | null
  stillUnsure: string | null
  author: string | null
  createdAt: string
}

export interface DoubtSnapshot {
  doubtId: string
  text: string
  status: DoubtStatus
  sourceEvidenceId: string | null
  createdAt: string
}

/* ------------------------------------------------- v2 请求快照（契约 15.2 / 17.1） */

/**
 * 契约 15.2 / 17.1：发出去的一个材料片段。
 * 只发片段文本与行号，不发材料正文全文。
 */
export interface UnderstandingSegmentInput {
  segmentId: string
  startLine: number
  endLine: number
  text: string
}

/** 契约 17.1：建议 / 聊天请求里的「已确认材料」 */
export interface ConfirmedMaterial {
  materialId: string
  name: string
  type: MaterialType
  version: number
  segments: UnderstandingSegmentInput[]
}

/** 契约 17.1：`confirmedMaterials` 里的一条片段（与 UnderstandingSegmentInput 同形） */
export type ConfirmedMaterialSegment = UnderstandingSegmentInput

/* ------------------------------------------------ v3 阶段上下文（契约 23.2） */

/** 契约 23.2：当前阶段任务快照（字段沿用 4.1，包含已完成任务） */
export type MilestoneTaskSnapshot = TaskSnapshot

/** 契约 23.2：最近进展快照 */
export interface ProgressSnapshot {
  progressId: string
  summary: string
  milestoneId: string | null
  taskId: string | null
  occurredAt: string
}

/**
 * 契约 23.2：建议 / 聊天的阶段上下文。
 * `milestoneId === null` 时，其余标量字段必须为 null，三个数组必须为空。
 */
export interface MilestoneContext {
  milestoneId: string | null
  currentMilestone: string | null
  milestoneRevision: number | null
  milestoneGoal: string | null
  milestoneDoneCriteria: string | null
  milestoneStatus: 'planned' | 'active' | null
  milestoneTasks: MilestoneTaskSnapshot[]
  recentProgress: ProgressSnapshot[]
  milestoneEvidence: EvidenceSnapshot[]
}

/** 契约 23.2：来源引用（BasisMaterialRef / Citation 同形） */
export interface BasisMaterialRef {
  materialId: string
  materialName: string
  materialVersion: number
  segmentId: string
  startLine: number
  endLine: number
  itemId: string | null
}

/** 契约 4.1 请求体；`projectProfile` 与 `confirmedMaterials` 是 v2 可选字段 */
export interface AdvisorRecommendationsRequest {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  projectName: string
  currentMilestone: string | null
  /** 契约 13.2：全部为空时**不出现**在请求体里 */
  projectProfile?: ProjectProfile
  confirmedContext: string[]
  /** 契约 17.1：没有已确认材料时**不出现**在请求体里（与 v1.3 行为一致） */
  confirmedMaterials?: ConfirmedMaterial[]
  /** 必须包含该项目全部任务（含已完成） */
  tasks: TaskSnapshot[]
  /** 最近若干条，按 createdAt 倒序 */
  evidence: EvidenceSnapshot[]
  /** 只发 status === 'open' 的疑问 */
  doubts: DoubtSnapshot[]
  /** 契约 23.1：v3 提示词必须携带；v1/v2 必须不出现 */
  milestoneContext?: MilestoneContext
  promptVersion: string
  forceRefresh: boolean
}

/* -------------------------------------------------------------- 输出侧 */

/**
 * 契约 2.5(a)：一条建议的线格式。
 * `existingTaskId` 必须是 `string | null`——**它是必填可空字段**，缺失不等于空字符串：
 * null 表示"新任务候选"，空字符串是非法值。
 */
export interface Suggestion {
  title: string
  whyNow: string
  doneCriteria: string
  existingTaskId: string | null
  basisEvidenceIds: string[]
  basisDoubtIds: string[]
  /** 契约 23.3：v3 可选，只允许来自已确认材料的片段 */
  basisMaterialRefs?: BasisMaterialRef[]
}

/** 契约 4.3 / 4.4：成功响应（source 为 model 或 fallback） */
export interface AdvisorRecommendationsSuccess {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  source: AdvisorResponseSource
  /** 只有 source === 'fallback' 时非空 */
  fallbackReason: AdvisorFallbackReason | null
  /** 是否复用服务端缓存；本轮服务端没有缓存层，恒为 false */
  cached: boolean
  promptVersion: string
  /** 契约 23.3：v3 响应回显阶段版本；v1/v2 不返回 */
  milestoneRevision?: number | null
  suggestions: Suggestion[]
}

/* ---------------------------------------------- 聊天接口 DTO（契约 6.4） */

/**
 * 契约 6.4：聊天里的一条历史消息。
 * `role` 只有 `user` / `assistant` 两种，`text` ≤ 2,000 字。
 */
export interface AdvisorChatMessage {
  role: 'user' | 'assistant'
  text: string
}

/** 契约 6.4：`POST /api/advisor/chat` 请求体；`projectProfile` / `confirmedMaterials` 是 v2 可选字段 */
export interface AdvisorChatRequest {
  contractVersion: string
  promptVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  projectName: string
  currentMilestone: string | null
  /** 契约 13.2：全部为空时**不出现**在请求体里 */
  projectProfile?: ProjectProfile
  /** 契约 17.1：没有已确认材料时**不出现**在请求体里（与 v1.3 行为一致） */
  confirmedMaterials?: ConfirmedMaterial[]
  tasks: TaskSnapshot[]
  evidence: EvidenceSnapshot[]
  doubts: DoubtSnapshot[]
  /** ≤ 20 条，按时间正序 */
  chatHistory: AdvisorChatMessage[]
  /** 非空，≤ 2,000 字 */
  question: string
  /** 契约 23.1：v3 提示词必须携带；v1/v2 必须不出现 */
  milestoneContext?: MilestoneContext
}

/** 契约 6.4：成功响应。`answer` 非空；`source` 只可能是 model / fallback */
export interface AdvisorChatSuccess {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  source: AdvisorResponseSource
  fallbackReason: AdvisorFallbackReason | null
  promptVersion: string
  /** 契约 23.3：v3 响应回显阶段版本；v1/v2 不返回 */
  milestoneRevision?: number | null
  /** 契约 23.3：v3 必须返回（可为空数组），只包含已确认片段 */
  citations?: BasisMaterialRef[]
  answer: string
}

/** 契约 6.4：聊天接口适配层的返回（不抛异常，与建议接口同一套失败结构） */
export type AdvisorChatResult =
  | { ok: true; data: AdvisorChatSuccess }
  | { ok: false; error: AdvisorApiError }

/* ---------------------------------------------- 材料接口 DTO（契约 15） */

/** 契约 15.0：两个材料接口共用的身份字段 */
export interface MaterialContractIdentity {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
}

/** 契约 15.1：`POST /api/materials` 请求体 */
export interface MaterialUploadRequest extends MaterialContractIdentity {
  materialId: string
  version: number
  name: string
  /** 标准 base64，不带 data URL 前缀 */
  contentBase64: string
}

/**
 * 契约 14.1：材料的**线格式**（服务端响应里的形状）。
 *
 * 与本地形态 `types/platform.ts` 的 `Material` 的区别只有一处：线格式里
 * `type` / `size` / `encoding` / `state` 一定有值（被拒绝的文件根本不会产生材料记录），
 * 而本地形态允许为 `null`（旧数据迁移来的「仅登记」材料）。
 */
export interface MaterialMetadata {
  materialId: string
  projectId: string
  name: string
  type: MaterialType
  /** 解码后的原始字节数，1～1,048,576 */
  size: number
  encoding: MaterialEncoding
  state: MaterialState
  version: number
  createdAt: string
  updatedAt: string
  failureReason: string | null
}

/** 契约 15.1：成功响应（服务端不保存材料，结果完整返回） */
export interface MaterialUploadSuccess extends MaterialContractIdentity {
  material: MaterialMetadata
  segmentCount: number
  /** 线格式分段：契约 14.2，不带 materialId / materialVersion（由响应顶层决定归属） */
  segments: MaterialSegmentDto[]
}

/** 契约 14.2：分段的线格式（`segmentId` 只保证在同一 materialId + version 内唯一） */
export interface MaterialSegmentDto {
  segmentId: string
  index: number
  startLine: number
  endLine: number
  text: string
}

/** 契约 15.2：`POST /api/materials/understanding` 请求体里的材料 */
export interface UnderstandingMaterialInput {
  materialId: string
  name: string
  type: MaterialType
  version: number
  segments: UnderstandingSegmentInput[]
}

/** 契约 15.2：`POST /api/materials/understanding` 请求体 */
export interface MaterialsUnderstandingRequest extends MaterialContractIdentity {
  promptVersion: string
  /** 可为 null */
  projectName: string | null
  material: UnderstandingMaterialInput
}

/** 契约 15.2：成功响应（`source` 只可能是 model / fallback） */
export interface MaterialsUnderstandingSuccess extends MaterialContractIdentity {
  materialId: string
  materialVersion: number
  promptVersion: string
  source: AdvisorResponseSource
  fallbackReason: AdvisorFallbackReason | null
  /** 中文说明，≤ 300 字；model 且成功时为 null */
  notice: string | null
  draft: UnderstandingDraft
}

/* ---------------------------------------------------------------- 错误 */

/** 契约 6.1 本轮启用的错误码 + 6.2 保留码 + 16 材料相关码 */
export type AdvisorErrorCode =
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'MODEL_TIMEOUT'
  | 'INVALID_MODEL_OUTPUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_NOT_CONFIGURED'
  | 'INTERNAL'
  // 契约第 16 节：材料上传与理解新增的码
  | 'UNSUPPORTED_MATERIAL_TYPE'
  | 'MATERIAL_TOO_LARGE'
  | 'EMPTY_MATERIAL'
  | 'MATERIAL_ENCODING_UNREADABLE'
  | 'MATERIAL_PARSE_FAILED'
  // 以下为契约 6.2 的保留码：服务端持久化后才会返回，前端先留分支
  | 'STALE_REVISION'
  | 'UNAUTHORIZED'

/** 能作为 fallbackReason 的原因（契约 4.3：取值来自第 6 节的失败原因码） */
export type AdvisorFallbackReason = Extract<
  AdvisorErrorCode,
  'MODEL_TIMEOUT' | 'MODEL_UNAVAILABLE' | 'MODEL_NOT_CONFIGURED' | 'INVALID_MODEL_OUTPUT' | 'RATE_LIMITED'
>

/** 契约 4.5：失败响应 */
export interface AdvisorRecommendationsFailure {
  contractVersion: string
  /** 请求体无法解析时为 null */
  requestId: string | null
  code: AdvisorErrorCode
  message: string
  retryable: boolean
  /** 只有 RATE_LIMITED 时给整数 */
  retryAfterSeconds: number | null
}

/**
 * 前端内部错误码（契约 3.3 的本地错误，外加本层需要的"过期响应"）。
 * 这些码永远不会发给后端。
 */
export type AdvisorLocalErrorCode =
  /** 未收到契约定义的响应：网络失败、超时、响应不是契约形状 */
  | 'NETWORK_ERROR'
  /** 响应的 requestId / projectId / projectRevision 与本次请求对不上，整份丢弃（契约 4.7） */
  | 'STALE_RESPONSE'

/** 前端内部细分原因：只用于界面文案与排查，不属于契约字段 */
export type AdvisorErrorCause =
  | 'http'
  | 'timeout'
  | 'network'
  | 'aborted'
  | 'invalid-json'
  | 'invalid-response'
  | 'stale-response'

/**
 * 适配层错误。
 * 保留契约规定的 code / retryable / requestId，界面据此决定提示与是否重试。
 */
export interface AdvisorApiError {
  code: AdvisorErrorCode | AdvisorLocalErrorCode
  message: string
  retryable: boolean
  retryAfterSeconds: number | null
  requestId: string | null
  cause: AdvisorErrorCause
}

/** 建议接口调用的统一返回：成功拿契约响应，失败拿带 code/retryable 的错误 */
export type AdvisorApiResult =
  | { ok: true; data: AdvisorRecommendationsSuccess }
  | { ok: false; error: AdvisorApiError }

/** 契约 3.1：store action 的统一结果类型 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

/* -------------------------------------------------------- store action 契约 */

/**
 * 契约 3.3：本地 action 的失败码（不是 HTTP 状态码）。
 * 页面按 `code` 决定提示方式，不按 toast 文案判断成功。
 */
export type LocalActionErrorCode =
  /** 传入的 id 在当前项目中不存在 */
  | 'NOT_FOUND'
  /** id 属于另一个项目 */
  | 'PROJECT_MISMATCH'
  /** 必填字段为空、超出长度上限、入参组合非法 */
  | 'INVALID_INPUT'
  /** 对 done 任务再次认领 */
  | 'TASK_NOT_CLAIMABLE'
  /** 重复解决同一疑问：静默成功语义，不报错 */
  | 'ALREADY_RESOLVED'
  /** localStorage 写入失败 */
  | 'STORAGE_FULL'
  /** 请求已过期被丢弃（契约 4.7） */
  | 'STALE_RESPONSE'
  /** 未收到契约定义的 HTTP 响应（契约 3.3） */
  | 'NETWORK_ERROR'

/**
 * 构造一个本地失败结果。
 * 返回 `ActionResult<never>`：`never` 可赋值给任意 `T`，
 * 因此它可以直接作为任何 `ActionResult<T>` 的失败分支，不需要显式写类型参数。
 */
export function localFailure(code: LocalActionErrorCode, message: string): ActionResult<never> {
  return { ok: false, code, message }
}

/** 契约 3.2：createProject */
export interface CreateProjectInput {
  /** 题目模板 key；自定义题目传 `__custom__` */
  topicId: string
  /** topicId 为 `__custom__` 时的项目名称 */
  customName?: string
  /** 小组人数 */
  members: number
  manualName?: string | null
  dataName?: string | null
  /**
   * 契约 13.1（可选）：创建时就能填的项目基本信息。
   * 全部为空与不传等价；不改变 `createProject` 的既有语义与返回值。
   */
  profile?: Partial<ProjectProfile>
  /** 兼容入口：旧表单传 `topic` 而不是 `topicId` */
  topic?: string
  /** 兼容入口：旧表单的成员是「3 人」这类字符串 */
  membersLabel?: string
}

/** 旧创建表单的入参（ProjectCreate.vue 当前在用） */
export interface LegacyCreateProjectInput {
  topic: string
  customName: string
  members: string
  manual: string | null
  data: string | null
}

export interface CreateProjectResult {
  projectId: string
  projectRevision: number
}

export interface SelectProjectResult {
  projectId: string
  projectRevision: number
}

/** 契约 3.2：claimTask 的两种入参，二者互斥 */
export type ClaimTaskInput = { taskId: string } | { draft: NewTaskDraft }

export interface ClaimTaskResult {
  taskId: string
  /**
   * 新建 / 认领 draft 任务时是 `'doing'`；
   * 对已在进行或已完成的任务重复认领时是**该任务的真实状态**（幂等，不写盘）。
   */
  status: TaskStatus
  projectRevision: number
}

/** 契约 3.2：submitEvidence */
export interface SubmitEvidenceInput {
  /** 幂等键：前端每次提交生成一次 */
  submissionId: string
  taskId: string | null
  didWhat: string
  foundWhat?: string | null
  stillUnsure?: string | null
  attachmentName?: string | null
  /** true = 确认完成（doing → done）；false = 只记录进展 */
  complete: boolean
}

/** 旧证据表单的入参（WorkbenchView.vue 当前在用） */
export interface LegacyEvidenceInput {
  stepLabel: string
  didWhat: string
  foundWhat: string
  solved: string
  unsure: string
  attachment: string | null
}

export interface SubmitEvidenceResult {
  evidenceId: string
  submissionId: string
  deduplicated: boolean
  doubtId: string | null
  taskStatus: 'doing' | 'done' | null
  projectRevision: number
}

export interface ResolveDoubtResult {
  doubtId: string
  projectRevision: number
}

/** 契约 4.5/5.2：证据已保存但建议生成失败时，页面还要能说清建议来源 */
export interface AdvisorOutcome {
  source: RecommendationSource
  suggestions: Recommendation[]
  cached: boolean
  fallbackReason: AdvisorFallbackReason | null
  requestId: string | null
}

/** 契约 2.2 / 4.1：字段长度上限 */
export const MAX_TASK_TITLE_LENGTH = 60
export const MAX_EVIDENCE_DID_WHAT_LENGTH = 300
export const MAX_EVIDENCE_FOUND_WHAT_LENGTH = 300
export const MAX_EVIDENCE_UNSURE_LENGTH = 300
export const MAX_DONE_CRITERIA_LENGTH = 200

/* ------------------------------------------------------------ 领域对象 */

/**
 * 契约 2.5(b)：前端领域对象 = 一条建议 + 本地字段。
 * 字段名与线格式完全一致，只是多了 id / source / requestId / projectRevision / generatedAt。
 */
export interface Recommendation extends Suggestion {
  /** `rec_<requestId>_<index>`；本地规则为 `rec_local_<revision>_<index>`，只用于列表 key 与去重 */
  id: string
  source: RecommendationSource
  /** 本地规则产生时为 null */
  requestId: string | null
  projectRevision: number
  /**
   * 落库时间（ISO）。
   * 注意：它不是线上字段——后端不返回它，由适配层在收到响应时补上（契约 2.5(b)）。
   */
  generatedAt: string
}

/* ------------------------------------------------------------ 运行时工具 */

/** 契约 6.1 / 16：retryable 的权威值是响应里的字段，这里只在字段缺失时兜底 */
export const RETRYABLE_BY_CODE: Record<AdvisorErrorCode, boolean> = {
  INVALID_INPUT: false,
  RATE_LIMITED: true,
  MODEL_TIMEOUT: true,
  INVALID_MODEL_OUTPUT: true,
  MODEL_UNAVAILABLE: true,
  MODEL_NOT_CONFIGURED: false,
  INTERNAL: true,
  // 契约 16：材料类错误都是确定性失败，重试不会变好
  UNSUPPORTED_MATERIAL_TYPE: false,
  MATERIAL_TOO_LARGE: false,
  EMPTY_MATERIAL: false,
  MATERIAL_ENCODING_UNREADABLE: false,
  MATERIAL_PARSE_FAILED: false,
  STALE_REVISION: false,
  UNAUTHORIZED: false,
}

/** 契约 16：材料与理解相关错误码，供页面先做本地提示（服务端也会回中文 message） */
export const MATERIAL_ERROR_CODES: readonly AdvisorErrorCode[] = [
  'UNSUPPORTED_MATERIAL_TYPE',
  'MATERIAL_TOO_LARGE',
  'EMPTY_MATERIAL',
  'MATERIAL_ENCODING_UNREADABLE',
  'MATERIAL_PARSE_FAILED',
]

export function isMaterialErrorCode(value: unknown): value is AdvisorErrorCode {
  return typeof value === 'string' && (MATERIAL_ERROR_CODES as string[]).includes(value)
}

/**
 * 契约 16：材料与理解相关错误码的**对外中文 message**。
 *
 * 页面在请求还没发出去时就能给同一套文案（例如本地先挡住非法扩展名），
 * 服务端返回时以响应里的 `message` 为准。这里只做"文案唯一出处"，
 * 不含任何密钥、路径或上游原文。
 */
export const MATERIAL_ERROR_MESSAGES: Record<
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'UNSUPPORTED_MATERIAL_TYPE'
  | 'MATERIAL_TOO_LARGE'
  | 'EMPTY_MATERIAL'
  | 'MATERIAL_ENCODING_UNREADABLE'
  | 'MATERIAL_PARSE_FAILED'
  | 'MODEL_TIMEOUT'
  | 'INVALID_MODEL_OUTPUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_NOT_CONFIGURED',
  string
> = {
  // 契约 16 的模板是「请求内容不合法：<第一条具体问题>」；
  // 前端本地校验没有具体问题列表，用冒号式句式保持同构（服务端 message 永远优先）
  INVALID_INPUT: '请求内容不合法：请检查后重试',
  // 契约 6.1 / 6.2：材料接口沿用这两个码（限流预留、服务端未预期异常）
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  INTERNAL: '服务端出现异常，请稍后重试',
  UNSUPPORTED_MATERIAL_TYPE:
    '当前只支持 md、txt 文件；CSV、XLSX 将在下一批支持，PDF、DOCX、ZIP 将在后续版本支持',
  MATERIAL_TOO_LARGE: '文件超过 1 MB 上限，请压缩或拆分后再上传',
  EMPTY_MATERIAL: '文件内容为空，请检查后再上传',
  MATERIAL_ENCODING_UNREADABLE: '文件编码无法识别（已尝试 UTF-8 与 GBK），请另存为 UTF-8 后重试',
  MATERIAL_PARSE_FAILED: '材料解析失败，请检查文件内容后重试',
  MODEL_TIMEOUT: '模型调用超时，材料已保留，请稍后重试',
  INVALID_MODEL_OUTPUT: '模型返回内容不合法，请稍后重试',
  MODEL_UNAVAILABLE: '模型服务暂不可用，请稍后重试',
  MODEL_NOT_CONFIGURED: '服务端未配置模型密钥，暂时无法生成理解草稿',
}

/** 契约 16（+ 6.1 / 6.2）：材料与理解相关错误码的 retryable 兜底值（响应缺字段时使用） */
export const MATERIAL_RETRYABLE_BY_CODE: Record<string, boolean> = {
  INVALID_INPUT: false,
  RATE_LIMITED: true,
  INTERNAL: true,
  UNSUPPORTED_MATERIAL_TYPE: false,
  MATERIAL_TOO_LARGE: false,
  EMPTY_MATERIAL: false,
  MATERIAL_ENCODING_UNREADABLE: false,
  MATERIAL_PARSE_FAILED: false,
  MODEL_TIMEOUT: true,
  INVALID_MODEL_OUTPUT: true,
  MODEL_UNAVAILABLE: true,
  MODEL_NOT_CONFIGURED: false,
}

const ADVISOR_ERROR_CODES = Object.keys(RETRYABLE_BY_CODE) as AdvisorErrorCode[]

export function isAdvisorErrorCode(value: unknown): value is AdvisorErrorCode {
  return typeof value === 'string' && (ADVISOR_ERROR_CODES as string[]).includes(value)
}

/* --------------------------------------------------------------- local-rule */

/**
 * 本地规则（后端不可达或后端返回错误时的兜底）实现在 `src/data/mvpFallbacks.ts`
 * 的 `buildLocalRecommendations()`。它产出的一定是：
 *
 * ```ts
 * {
 *   ...Suggestion 的六个字段,
 *   id: buildRecommendationId('local-rule', null, projectRevision, index),
 *   source: 'local-rule',
 *   requestId: null,
 *   projectRevision,
 *   generatedAt: '由调用方传入的 ISO 时间',
 * }
 * ```
 *
 * 类型与 ID 约定以本文件为准；规则内容不需要新的线上字段。
 */

/* ------------------------------------- v2 store action（契约 13 / 14） */

/** 契约 13.1：保存项目基本信息。缺省字段表示"不改这一项"由调用方决定，统一按全量提交处理 */
export type UpdateProjectProfileInput = Partial<ProjectProfile>

export interface UpdateProjectProfileResult {
  projectRevision: number
}

/** 兼容别名：团队既有页面用 `updateProjectBasicInfo` 命名，二者指向同一个 action */
export type UpdateProjectBasicInfoInput = UpdateProjectProfileInput
export type ProjectBasicInfoResult = UpdateProjectProfileResult

/**
 * 契约 14.1：登记一份材料（本地写入，不访问网络）。
 *
 * 只有 `state === 'parsed'` 且带 `segments` 的材料才能参与理解与建议请求；
 * 无法识别编码 / 类型不支持的文件由服务端在 15.1 阶段拒绝，不产生材料记录。
 */
export interface RegisterMaterialInput {
  name: string
  /** 不传则前端生成 `mat_...` */
  materialId?: string
  /** 不传则沿用同名材料的现有版本（首次为 1），同名重传时 +1（契约 14.5 第 4 条） */
  version?: number
  size?: number
  encoding?: MaterialEncoding
  state?: MaterialState
  failureReason?: string | null
  /** 线格式分段（契约 14.2，不带 materialId / materialVersion，由 store 补上） */
  segments?: MaterialSegmentDto[]
}

export interface RegisterMaterialResult {
  materialId: string
  version: number
  segmentCount: number
  projectRevision: number
  /** true = 同一 materialId 重新登记，version 已 +1，旧版本草稿已作废 */
  updated: boolean
}

/** 契约 15.1：上传并解析一份材料（读原始字节 → base64 → POST /api/materials） */
export interface UploadMaterialFileInput {
  /** 不传则取 `file.name` */
  name?: string
  /** 文件内容（浏览器 File / Blob） */
  file?: Blob
  /** 重新上传已有材料时传入，服务端按 version 区分版本 */
  materialId?: string
  signal?: AbortSignal
}

export interface UploadMaterialFileResult {
  /** 写入 store 后的本地形态（`needsReupload` 已按片段数算好） */
  material: Material
  version: number
  segmentCount: number
  projectRevision: number
  /** 服务端返回的线格式片段（界面可直接展示解析结果） */
  segments: MaterialSegmentDto[]
}

/** 契约 15.2：请求某份材料的理解草稿 */
export interface RequestUnderstandingInput {
  materialId: string
  signal?: AbortSignal
  /** 只发送选定的片段；不传则从第 1 段开始累计到上限（契约 15.2） */
  segmentIds?: string[]
}

/** 契约 15.2：理解请求的结果（含 fallback；`blockCount` 是本次写入的草稿条数） */
export interface RequestUnderstandingResult {
  materialId: string
  materialVersion: number
  source: RecommendationSource
  fallbackReason: AdvisorFallbackReason | null
  notice: string | null
  /** 界面展示用：本次生成/写入的草稿条数 */
  blockCount: number
  draft: UnderstandingDraft
  projectRevision: number
}

/** 契约 14.3：把服务端草稿写入本地状态（不访问网络） */
export interface RecordUnderstandingInput {
  materialId: string
  materialVersion: number
  draft: UnderstandingDraft
  /** fallback 时服务端给的中文说明 */
  notice?: string | null
}

export interface RecordUnderstandingResult {
  materialId: string
  blockCount: number
  projectRevision: number
}

/** 契约 14.3：单条草稿的入参。`blockId` 是**本地**唯一条目 id（不是服务端 itemId） */
export interface UnderstandingBlockIdInput {
  blockId: string
}

export interface ModifyUnderstandingBlockInput {
  blockId: string
  /** 修改后的正文，1～300 字 */
  content: string
}

export interface UnderstandingBlockResult {
  blockId: string
  status: UnderstandingBlockStatus
  projectRevision: number
}

export interface DeleteUnderstandingBlockResult {
  blockId: string
  projectRevision: number
}

/** 契约 14.3：整份草稿确认（按材料） */
export interface ConfirmAllUnderstandingInput {
  materialId: string
}

export interface ConfirmAllUnderstandingResult {
  materialId: string
  confirmedCount: number
  projectRevision: number
}

/* ------------------------------------------------- 错误 → 界面文案 */

const ADVISOR_FAILURE_TEXT: Partial<Record<AdvisorErrorCode, string>> = {
  INVALID_INPUT: '请求内容不合法，请检查后重试',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  MODEL_TIMEOUT: '模型响应超时，可稍后重试',
  INVALID_MODEL_OUTPUT: '模型返回内容不合法，可稍后重试',
  MODEL_UNAVAILABLE: '模型服务暂不可用，可稍后重试',
  MODEL_NOT_CONFIGURED: '服务端未配置模型密钥',
  UNSUPPORTED_MATERIAL_TYPE: '当前只支持 md、txt 文件',
  MATERIAL_TOO_LARGE: '文件超过 1 MB 上限，请压缩或拆分后再上传',
  EMPTY_MATERIAL: '文件内容为空，请检查后再上传',
  MATERIAL_ENCODING_UNREADABLE: '文件编码无法识别，请另存为 UTF-8 后重试',
  MATERIAL_PARSE_FAILED: '材料解析失败，请检查文件内容后重试',
}

/**
 * 聊天失败 → 中文人话（契约 6.4 / 16：按**稳定错误码**映射）。
 *
 * 聊天不使用服务端 `message`：它属于面向开发者的排障信息，可能包含字段名、路径或
 * 上游原文；一旦原样渲染就会泄漏内部细节。这里只按 code 出文案。
 */
const CHAT_FAILURE_TEXT: Partial<Record<AdvisorErrorCode, string>> = {
  INVALID_INPUT: '这次提问没有被服务端接受，项目里的数据不受影响，可以改一下问法再试',
  RATE_LIMITED: '提问有点频繁，稍等一会儿再问',
  MODEL_TIMEOUT: '模型响应超时，问题已经保存，可以稍后重试',
  INVALID_MODEL_OUTPUT: '模型这次没有给出可用回答，可以稍后重试',
  MODEL_UNAVAILABLE: '模型服务暂时不可用，可以稍后重试',
  MODEL_NOT_CONFIGURED: '服务端还没有接入模型，暂时回答不了，可以先按自己的判断推进',
  INTERNAL: '服务端刚才没能处理这次提问，可以稍后重试',
  STALE_REVISION: '项目状态已经变化，请重新提问',
  UNAUTHORIZED: '这次请求没有通过服务端校验',
  UNSUPPORTED_MATERIAL_TYPE: '这条问题里带上了当前不支持的材料类型，请先把材料改成 MD 或 TXT 再问',
  MATERIAL_TOO_LARGE: '相关材料超过 1 MB 上限，处理不了，请压缩后再问',
  EMPTY_MATERIAL: '相关材料内容为空，请检查材料后再问',
  MATERIAL_ENCODING_UNREADABLE: '相关材料的编码无法识别，请另存为 UTF-8 后再问',
  MATERIAL_PARSE_FAILED: '相关材料没有解析成功，请重新上传后再问',
}

/** 前端内部码 NETWORK_ERROR 也要有中文说明（后端不可达 / 超时 / 响应不是契约形状） */
const CHAT_LOCAL_FAILURE_TEXT: Record<string, string> = {
  NETWORK_ERROR: '连不上后端服务，请检查网络后重试',
  STALE_RESPONSE: '这条回答已经过期，已丢弃',
}

/** 聊天失败的中文说明（不认识的原因也给一句可执行的话） */
export function describeChatFailure(error: AdvisorApiError): string {
  return (
    CHAT_LOCAL_FAILURE_TEXT[error.code] ??
    CHAT_FAILURE_TEXT[error.code as AdvisorErrorCode] ??
    '提问没有成功，可以稍后重试'
  )
}

/**
 * 用户可见文本的安全检查（契约 12.2 / 16：不展示内部字段名、路径、堆栈或原始报文）。
 * 命中任何一条就认为服务端 `message` 不适合直接展示。
 */
const UNSAFE_MESSAGE_TOKENS = [
  'projectRevision',
  'materialId',
  'materialVersion',
  'segmentId',
  'doneCriteria',
  'currentMilestone',
  'confirmedContext',
  'confirmedMaterials',
  'goalCandidates',
  'openQuestions',
  'http://',
  'https://',
  '/api/',
  'stack',
  'Error:',
] as const

export function isSafeUserFacingMessage(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 300) return false
  // 面向用户的话必须是中文：整段没有汉字时宁可改用本地映射，也不把上游英文原文端给用户
  if (!/[\u4e00-\u9fa5]/.test(trimmed)) return false
  return !UNSAFE_MESSAGE_TOKENS.some((token) => trimmed.includes(token))
}

/**
 * 把适配层错误映射成给人看的中文说明（契约 18：界面不显示英文码）。
 * 服务端给了**安全**的 `message` 时优先用它——它比本地映射更贴近当时的失败原因；
 * 含内部字段名、路径或堆栈的报文一律丢弃，改用按 code 映射的中文。
 */
export function describeAdvisorFailure(error: AdvisorApiError): string {
  if (isSafeUserFacingMessage(error.message)) return error.message.trim()
  return ADVISOR_FAILURE_TEXT[error.code as AdvisorErrorCode] ?? '请求未能完成，请稍后重试'
}
