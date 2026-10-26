/**
 * 建议接口的领域类型
 * ----------------------------------------------------------------------------
 * 这些类型与 HTTP 无关：路由层、校验层、provider 层、兜底层都只通过这些类型通信。
 * 因此把 mock provider 换成真实大模型 provider 时，前端接口契约（docs/contracts.md）不需要任何改动。
 */

/** 契约版本：与 docs/contracts.md 第 8.1 节一致 */
export const CONTRACT_VERSION = '1.0'

/**
 * 服务端支持的提示词版本（契约 4.1 / 17.4）：不在列表内的请求直接拒绝，不做静默降级。
 * - 建议接口：mvp-prompt-v1（兼容保留）、mvp-prompt-v2（项目基本信息/材料摘录）、
 *   mvp-prompt-v3（阶段化建议，必须携带 milestoneContext）；
 * - 聊天接口：advisor-chat-v1（兼容保留）、advisor-chat-v2（同上）、
 *   advisor-chat-v3（阶段化聊天，必须携带 milestoneContext）；
 * - 材料理解接口的版本号在 materials/types.ts（material-understanding-v1）。
 */
export const ADVISOR_PROMPT_VERSIONS: readonly string[] = [
  'mvp-prompt-v1',
  'mvp-prompt-v2',
  'mvp-prompt-v3',
]
export const ADVISOR_CHAT_PROMPT_VERSIONS: readonly string[] = [
  'advisor-chat-v1',
  'advisor-chat-v2',
  'advisor-chat-v3',
]
export const SUPPORTED_PROMPT_VERSIONS: readonly string[] = [
  ...ADVISOR_PROMPT_VERSIONS,
  ...ADVISOR_CHAT_PROMPT_VERSIONS,
]

export type TaskStatus = 'todo' | 'doing' | 'done'
export type DoubtStatus = 'open' | 'resolved'

/* ------------------------------------------------------------------ 请求侧 */

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

export interface ProgressSnapshot {
  progressId: string
  summary: string
  milestoneId: string | null
  taskId: string | null
  occurredAt: string
}

/** 契约 23.2：v3 建议/聊天的阶段上下文；空白项目全部为空。 */
export interface MilestoneContext {
  milestoneId: string | null
  currentMilestone: string | null
  milestoneRevision: number | null
  milestoneGoal: string | null
  milestoneDoneCriteria: string | null
  milestoneStatus: 'planned' | 'active' | null
  milestoneTasks: TaskSnapshot[]
  recentProgress: ProgressSnapshot[]
  milestoneEvidence: EvidenceSnapshot[]
}

/**
 * v2（M2-A）可选字段：项目基本信息（契约第 13 节）。
 * 只有前端显式携带时才进入请求；缺失一律按 null / 空数组处理，旧客户端不受影响。
 */
export interface ProjectProfile {
  goal: string | null
  expectedOutcome: string | null
  memberNames: string[]
  researchPeriod: string | null
  scope: string | null
  outOfScope: string | null
}

/** v2（M2-A）可选字段：已确认的材料片段（契约 17.1）。未确认草稿不允许出现在这里 */
export interface ConfirmedMaterialSegment {
  segmentId: string
  startLine: number
  endLine: number
  text: string
}

export interface ConfirmedMaterial {
  materialId: string
  name: string
  type: 'md' | 'txt'
  version: number
  segments: ConfirmedMaterialSegment[]
}

/** 通过校验之后的请求，各层只消费这个结构 */
export interface AdvisorRequest {
  requestId: string
  projectId: string
  projectRevision: number
  projectName: string
  currentMilestone: string | null
  confirmedContext: string[]
  tasks: TaskSnapshot[]
  evidence: EvidenceSnapshot[]
  doubts: DoubtSnapshot[]
  promptVersion: string
  forceRefresh: boolean
  /** v2：已确认的项目基本信息；缺失或为 null 表示本次请求不携带 */
  projectProfile?: ProjectProfile | null
  /** v2：学生已确认的材料摘录；缺失按空数组处理 */
  confirmedMaterials?: ConfirmedMaterial[]
  /** v3：阶段上下文；v3 必填，v1/v2 必须不出现 */
  milestoneContext?: MilestoneContext | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface AdvisorChatRequest {
  requestId: string
  projectId: string
  projectRevision: number
  projectName: string
  currentMilestone: string | null
  tasks: TaskSnapshot[]
  evidence: EvidenceSnapshot[]
  doubts: DoubtSnapshot[]
  chatHistory: ChatMessage[]
  question: string
  promptVersion: string
  /** v2：同 AdvisorRequest */
  projectProfile?: ProjectProfile | null
  confirmedMaterials?: ConfirmedMaterial[]
  /** v3：同 AdvisorRequest */
  milestoneContext?: MilestoneContext | null
}

/* ------------------------------------------------------------------ 输出侧 */

/** v3 材料引用（契约 23.6 / 23.7）；D15 前由服务端返回空数组 */
export interface BasisMaterialRef {
  materialId: string
  materialName: string
  materialVersion: number
  segmentId: string
  startLine: number
  endLine: number
  itemId: string | null
}

/** 一条建议的线格式（契约 2.5a）。字段名必须与契约一致 */
export interface Suggestion {
  title: string
  whyNow: string
  doneCriteria: string
  /** null 表示"新任务候选" */
  existingTaskId: string | null
  basisEvidenceIds: string[]
  basisDoubtIds: string[]
  /** 仅 v3 建议响应必须出现；v1/v2 不得出现 */
  basisMaterialRefs?: BasisMaterialRef[]
}

/** 聊天成功响应（v3 额外带 milestoneRevision + citations） */
export interface AdvisorChatSuccessResponse {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  source: AdvisorSource
  fallbackReason: AdvisorFallbackReason | null
  answer: string
  milestoneRevision?: number | null
  citations?: BasisMaterialRef[]
}

export type AdvisorSource = 'model' | 'fallback'

export type AdvisorErrorCode =
  | 'INVALID_INPUT'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'UNCONFIRMED_MATERIAL'
  | 'MATERIAL_VERSION_OUTDATED'
  | 'RATE_LIMITED'
  | 'MODEL_TIMEOUT'
  | 'INVALID_MODEL_OUTPUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_NOT_CONFIGURED'
  | 'INTERNAL'

/** 兜底原因：能进入 fallback 的原因集合（INVALID_INPUT 在进入服务前就被拒了） */
export type AdvisorFallbackReason = Exclude<
  AdvisorErrorCode,
  | 'INVALID_INPUT'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'UNCONFIRMED_MATERIAL'
  | 'MATERIAL_VERSION_OUTDATED'
  | 'INTERNAL'
>

/** 运行期错误码：服务层可能返回给路由层、并映射成 HTTP 状态码的集合 */
export type AdvisorRuntimeErrorCode = Exclude<
  AdvisorErrorCode,
  | 'INVALID_INPUT'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'UNCONFIRMED_MATERIAL'
  | 'MATERIAL_VERSION_OUTDATED'
>

/** 成功响应体（契约 4.3 / 4.4） */
export interface AdvisorSuccessResponse {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  source: AdvisorSource
  fallbackReason: AdvisorFallbackReason | null
  cached: boolean
  promptVersion: string
  suggestions: Suggestion[]
}

/** 失败响应体（契约 4.5） */
export interface AdvisorFailureResponse {
  contractVersion: string
  requestId: string | null
  code: AdvisorErrorCode
  message: string
  retryable: boolean
  retryAfterSeconds: number | null
}

/* ------------------------------------------------------------ 模型端点配置 */

/** provider 选型。默认是真实模型；mock 仅用于本地联调与离线测试注入 */
export type AdvisorProviderKind = 'openai-compatible' | 'mock'

/**
 * 一次模型调用的端点配置。
 * `url` 必须是**完整请求地址**（例如 https://host/v1/chat/completions）：
 * provider 不会拼接任何路径，也不会补 /v1 之类的后缀。
 */
export interface ModelEndpoint {
  url: string
  /** 只从环境变量读取，不落盘、不进日志、不进响应 */
  apiKey: string
  model: string
  timeoutMs: number
}

/** 与 fetch 同形，便于测试注入（单元测试禁止访问真实网络） */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/* ---------------------------------------------------------------- provider */

/**
 * provider 的原始输出。
 * 故意用 unknown：真实模型返回的就是一段需要校验的 JSON，
 * 校验层（validation.ts）必须能处理任何形状，而不是相信 provider 的类型声明。
 */
export interface ProviderOutput {
  suggestions: unknown
}

/**
 * 材料理解 provider 输入（M2-A）：领域无关，只描述一次"把材料片段变成理解草稿"的调用需要什么。
 * 材料领域对象见 materials/types.ts；这里保持最小字段，避免 advisor 模块反向依赖 materials。
 */
export interface UnderstandingProviderSegment {
  segmentId: string
  startLine: number
  endLine: number
  text: string
}

export interface UnderstandingProviderInput {
  materialName: string
  materialType: 'md' | 'txt'
  materialVersion: number
  projectName: string | null
  segments: UnderstandingProviderSegment[]
}

export interface CandidateProviderMaterial {
  materialName: string
  materialVersion: number
  segments: Array<{
    ref: string
    startLine: number
    endLine: number
    text: string
  }>
}

export interface CandidateProviderInput {
  projectName: string
  focus: string | null
  maxCandidates: number
  confirmedMaterials: CandidateProviderMaterial[]
}

/**
 * 建议生成器。mock provider 与将来的真实模型 provider 实现同一个接口。
 * 允许抛错与耗时过长，由服务层负责超时与兜底。
 */
export interface AdvisorProvider {
  readonly name: string
  generate(request: AdvisorRequest): Promise<ProviderOutput>
  generateChat?(request: AdvisorChatRequest): Promise<{ answer: unknown }>
  /** v2（M2-A）：材料理解；未实现的 provider 视为 MODEL_UNAVAILABLE */
  generateUnderstanding?(request: UnderstandingProviderInput): Promise<{ draft: unknown }>
  /** v3：阶段候选；未实现的 provider 走规则兜底 */
  generateCandidates?(request: CandidateProviderInput): Promise<{ candidates: unknown }>
}

/**
 * provider 主动声明的失败原因。
 * 例如真实 provider 发现没有读取到密钥时，应抛 reason 为 MODEL_NOT_CONFIGURED 的错误，
 * 这样服务层能区分"重试也不会好"与"上游暂时故障"。
 */
export class AdvisorProviderError extends Error {
  readonly reason: AdvisorFallbackReason

  constructor(message: string, reason: AdvisorFallbackReason) {
    super(message)
    this.name = 'AdvisorProviderError'
    this.reason = reason
  }
}

/* ------------------------------------------------------------------ 日志 */

export interface AdvisorLogger {
  /** 正常路径日志；可选成员，既有实现无需跟进 */
  info?(message: string, detail?: Record<string, unknown>): void
  warn(message: string, detail?: Record<string, unknown>): void
}

export function createConsoleLogger(prefix = 'advisor'): AdvisorLogger {
  return {
    info(message, detail) {
      if (detail === undefined) console.info(`[${prefix}] ${message}`)
      else console.info(`[${prefix}] ${message}`, detail)
    },
    warn(message, detail) {
      if (detail === undefined) console.warn(`[${prefix}] ${message}`)
      else console.warn(`[${prefix}] ${message}`, detail)
    },
  }
}

/** 测试与不需要日志的场合使用 */
export const silentLogger: AdvisorLogger = { warn() {} }
