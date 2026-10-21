import { requestJson, type HttpFailureCause } from './http'
import {
  ADVISOR_CHAT_PROMPT_VERSION,
  ADVISOR_CHAT_PROMPT_VERSION_V3,
  ADVISOR_V3_PROMPT_VERSION,
  CONTRACT_VERSION,
  DEFAULT_PROMPT_VERSION,
  MAX_ADVISOR_CHAT_HISTORY,
  MAX_ADVISOR_CHAT_QUESTION_LENGTH,
  MAX_ADVISOR_CHAT_TEXT_LENGTH,
  clampCurrentMilestone,
  clampProjectName,
  RETRYABLE_BY_CODE,
  isAdvisorErrorCode,
  type AdvisorApiError,
  type AdvisorApiResult,
  type AdvisorChatMessage,
  type AdvisorChatRequest,
  type AdvisorChatResult,
  type AdvisorChatSuccess,
  type AdvisorErrorCause,
  type AdvisorFallbackReason,
  type AdvisorRecommendationsFailure,
  type AdvisorRecommendationsRequest,
  type AdvisorRecommendationsSuccess,
  type BasisMaterialRef,
  type ConfirmedMaterial,
  type DoubtSnapshot,
  type EvidenceSnapshot,
  type MilestoneContext,
  type Recommendation,
  type RecommendationSource,
  type Suggestion,
  type TaskSnapshot,
} from '@/domain/recommendation'
import type { ProjectProfile } from '@/types/platform'

/**
 * 建议接口适配层
 * ----------------------------------------------------------------------------
 * POST /api/advisor/recommendations
 *
 * 唯一依据是 docs/contracts.md：
 *   - 字段名与契约一致，不另造 DTO；
 *   - 成功响应校验 projectId / projectRevision / requestId（契约 4.7：对不上就整份丢弃）；
 *   - 失败响应保留契约的 code / retryable / requestId / retryAfterSeconds。
 *
 * 页面与 store 只调用这里的方法，不直接 fetch（契约 4.0 第 7 条）。
 * 本文件不读取任何密钥：模型调用全部由后端代理，浏览器端不持有 API Key。
 */

/** 契约 4.0：VITE_API_BASE_URL 不含 /api，由适配层补全 */
export const ADVISOR_RECOMMENDATIONS_PATH = '/api/advisor/recommendations'
/** 契约 6.4：聊天接口 */
export const ADVISOR_CHAT_PATH = '/api/advisor/chat'

/** 契约 4.6：建议最多 3 条。服务端已校验，前端再兜一次，避免异常响应污染列表 */
export const MAX_SUGGESTIONS = 3

/** 契约 4.0：可重试的失败最多自动重试 1 次，退避 1 秒 */
const RETRY_DELAY_MS = 1_000

/* ---------------------------------------------------------------- 工具 */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 生成 requestId（只用于关联响应与丢弃过期结果，不参与安全判断） */
export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 契约 2.5(b) 的 id 约定。
 * `local-rule` 或没有 requestId（本地规则）时用 `rec_local_<revision>_<index>`。
 */
export function buildRecommendationId(
  source: RecommendationSource,
  requestId: string | null,
  projectRevision: number,
  index: number,
): string {
  if (source === 'local-rule' || requestId === null) {
    return `rec_local_${projectRevision}_${index}`
  }
  return `rec_${requestId}_${index}`
}

/* ------------------------------------------------------------ 组装请求 */

export interface BuildAdvisorRequestInput {
  projectId: string
  projectRevision: number
  projectName: string
  /** 当前里程碑名称；没有就传 null */
  currentMilestone: string | null
  /** 该项目全部任务（含已完成） */
  tasks: TaskSnapshot[]
  /** 最近若干条证据，按 createdAt 倒序 */
  evidence: EvidenceSnapshot[]
  /** 只传 status === 'open' 的疑问 */
  doubts: DoubtSnapshot[]
  /** 已确认的项目事实，没有就留空 */
  confirmedContext?: string[]
  /** 契约 13.2：项目基本信息。全部为空时传 `null` 或不传，请求体里不出现该字段 */
  projectProfile?: ProjectProfile | null
  /** 契约 17.1：已确认的材料片段。为空数组或不传时请求体里不出现该字段 */
  confirmedMaterials?: ConfirmedMaterial[]
  /**
   * 契约 23.2：阶段上下文。传入时默认使用 v3 提示词；显式传入 v1/v2 不会被静默改写，
   * 由服务端按 23.1 返回 400，避免隐藏接线错误。
   */
  milestoneContext?: MilestoneContext | null
  /**
   * 提示词版本。不传时按内容自动选择：
   * 带 `milestoneContext` → v3；带 `projectProfile` 或非空 `confirmedMaterials` → v2；
   * 否则保持 v1（契约 17.4 第 2 条）。
   */
  promptVersion?: string
  /** 对应页面「重新判断下一步」 */
  forceRefresh?: boolean
  /** 不传则自动生成 */
  requestId?: string
}

/**
 * 由 store 把项目状态映射成快照后调用它组装请求体。
 * 这里只做字段装配与默认值，不做校验——校验在请求发出后由契约约束。
 *
 * v2 字段的取舍（契约 13.2 / 17.1 / 17.4）：
 *   - `projectProfile` 全为空 → 整个字段不出现（与 v1.3 完全一致）；
 *   - `confirmedMaterials` 为空 → 整个字段不出现（与 v1.3 完全一致）；
 *   - `promptVersion` 默认取**当前版本**（`DEFAULT_PROMPT_VERSION` = `mvp-prompt-v2`）；
 *     调用方显式传入的值原样保留，**不静默改写**——「带 v2 字段却发 v1」属接线错误，
 *     应当由服务端按契约 17.4 规则 2 返回 400 暴露出来。
 */
export function buildAdvisorRequest(input: BuildAdvisorRequestInput): AdvisorRecommendationsRequest {
  const projectProfile = input.projectProfile ?? null
  const confirmedMaterials =
    input.confirmedMaterials !== undefined && input.confirmedMaterials.length > 0
      ? input.confirmedMaterials
      : null
  const milestoneContext =
    input.milestoneContext === undefined || input.milestoneContext === null
      ? null
      : input.milestoneContext

  const request: AdvisorRecommendationsRequest = {
    contractVersion: CONTRACT_VERSION,
    requestId: input.requestId ?? createRequestId(),
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    // 契约 4.1：projectName ≤ 120、currentMilestone ≤ 60；超长只截断，不让整个请求 400
    projectName: clampProjectName(input.projectName) ?? '',
    currentMilestone: clampCurrentMilestone(input.currentMilestone),
    confirmedContext: input.confirmedContext ?? [],
    tasks: input.tasks,
    evidence: input.evidence,
    doubts: input.doubts,
    promptVersion:
      input.promptVersion ??
      (milestoneContext !== null ? ADVISOR_V3_PROMPT_VERSION : DEFAULT_PROMPT_VERSION),
    forceRefresh: input.forceRefresh ?? false,
  }

  if (projectProfile !== null) request.projectProfile = projectProfile
  if (confirmedMaterials !== null) request.confirmedMaterials = confirmedMaterials
  if (milestoneContext !== null) request.milestoneContext = milestoneContext

  return request
}

/* ------------------------------------------------------------ 聊天请求（契约 6.4） */

export interface BuildAdvisorChatRequestInput {
  projectId: string
  projectRevision: number
  projectName: string
  currentMilestone: string | null
  tasks: TaskSnapshot[]
  evidence: EvidenceSnapshot[]
  doubts: DoubtSnapshot[]
  /** 本次提问，1～2,000 字 */
  question: string
  /** 之前的对话，最多 20 条；调用方按时间正序传入 */
  chatHistory?: AdvisorChatMessage[]
  /** 契约 13.2：项目基本信息。全部为空时传 `null` 或不传，请求体里不出现该字段 */
  projectProfile?: ProjectProfile | null
  /** 契约 17.1：已确认的材料片段。为空数组或不传时请求体里不出现该字段 */
  confirmedMaterials?: ConfirmedMaterial[]
  /**
   * 契约 23.2：阶段上下文。传入时默认使用 `advisor-chat-v3`；
   * 显式传入 v1/v2 不会被静默改写，由服务端返回 400。
   */
  milestoneContext?: MilestoneContext | null
  /**
   * 提示词版本。不传时用 `ADVISOR_CHAT_PROMPT_VERSION`（`advisor-chat-v2`）；
   * 显式传入的值原样保留，由服务端按契约 17.4 校验。
   */
  promptVersion?: string
  /** 不传则自动生成 */
  requestId?: string
}

/**
 * 契约 6.4：把聊天历史裁剪到契约允许的范围。
 *
 * 规则：丢掉空文本、逐条截断到 2,000 字、只保留最近 20 条、顺序保持不变。
 * 聊天**不发** `confirmedContext`：服务端聊天解析器会自己补空数组（契约 6.4 字段表）。
 */
export function normalizeChatHistory(history: AdvisorChatMessage[] | undefined): AdvisorChatMessage[] {
  if (history === undefined || !Array.isArray(history)) return []

  const cleaned: AdvisorChatMessage[] = []
  for (const message of history) {
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (text === '') continue
    cleaned.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: text.length > MAX_ADVISOR_CHAT_TEXT_LENGTH ? text.slice(0, MAX_ADVISOR_CHAT_TEXT_LENGTH) : text,
    })
  }

  return cleaned.slice(-MAX_ADVISOR_CHAT_HISTORY)
}

/** 契约 6.4：装配聊天请求体。字段与契约一致，未确认草稿不得从这里进来 */
export function buildAdvisorChatRequest(input: BuildAdvisorChatRequestInput): AdvisorChatRequest {
  const projectProfile = input.projectProfile ?? null
  const confirmedMaterials =
    input.confirmedMaterials !== undefined && input.confirmedMaterials.length > 0
      ? input.confirmedMaterials
      : null
  const milestoneContext =
    input.milestoneContext === undefined || input.milestoneContext === null
      ? null
      : input.milestoneContext

  const question = (input.question ?? '').trim()
  const request: AdvisorChatRequest = {
    contractVersion: CONTRACT_VERSION,
    promptVersion:
      input.promptVersion ??
      (milestoneContext !== null ? ADVISOR_CHAT_PROMPT_VERSION_V3 : ADVISOR_CHAT_PROMPT_VERSION),
    requestId: input.requestId ?? createRequestId(),
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    // 契约 4.1：projectName ≤ 120、currentMilestone ≤ 60；超长只截断，不让整个请求 400
    projectName: clampProjectName(input.projectName) ?? '',
    currentMilestone: clampCurrentMilestone(input.currentMilestone),
    tasks: input.tasks,
    evidence: input.evidence,
    doubts: input.doubts,
    chatHistory: normalizeChatHistory(input.chatHistory),
    question:
      question.length > MAX_ADVISOR_CHAT_QUESTION_LENGTH
        ? question.slice(0, MAX_ADVISOR_CHAT_QUESTION_LENGTH)
        : question,
  }

  if (projectProfile !== null) request.projectProfile = projectProfile
  if (confirmedMaterials !== null) request.confirmedMaterials = confirmedMaterials
  if (milestoneContext !== null) request.milestoneContext = milestoneContext

  return request
}

/* ---------------------------------------------------------- 响应校验 */

/**
 * 契约 2.5(a)：逐字段校验一条建议。
 * 关键点：`existingTaskId` 是**必填可空**——必须是 string 或 null；
 * 缺失/其它类型都不接受，尤其**不能**转成空字符串。
 */
function asBasisMaterialRef(value: unknown): BasisMaterialRef | null {
  if (!isPlainObject(value)) return null
  const { materialId, materialName, materialVersion, segmentId, startLine, endLine, itemId } = value
  if (
    typeof materialId !== 'string' ||
    typeof materialName !== 'string' ||
    typeof materialVersion !== 'number' ||
    typeof segmentId !== 'string' ||
    typeof startLine !== 'number' ||
    typeof endLine !== 'number'
  ) {
    return null
  }
  if (itemId !== null && typeof itemId !== 'string') return null
  return { materialId, materialName, materialVersion, segmentId, startLine, endLine, itemId }
}

function asSuggestion(value: unknown): Suggestion | null {
  if (!isPlainObject(value)) return null

  const { title, whyNow, doneCriteria, existingTaskId, basisEvidenceIds, basisDoubtIds } = value
  if (typeof title !== 'string' || typeof whyNow !== 'string' || typeof doneCriteria !== 'string') return null
  if (existingTaskId !== null && typeof existingTaskId !== 'string') return null
  if (!Array.isArray(basisEvidenceIds) || !basisEvidenceIds.every((id) => typeof id === 'string')) return null
  if (!Array.isArray(basisDoubtIds) || !basisDoubtIds.every((id) => typeof id === 'string')) return null

  const suggestion: Suggestion = {
    title,
    whyNow,
    doneCriteria,
    existingTaskId,
    basisEvidenceIds: [...basisEvidenceIds] as string[],
    basisDoubtIds: [...basisDoubtIds] as string[],
  }

  // 契约 23.3：v3 可选；未知/非法引用逐条剔除，不影响整份建议
  if (value.basisMaterialRefs !== undefined) {
    if (!Array.isArray(value.basisMaterialRefs)) return null
    const refs: BasisMaterialRef[] = []
    for (const item of value.basisMaterialRefs) {
      const ref = asBasisMaterialRef(item)
      if (ref !== null) refs.push(ref)
    }
    suggestion.basisMaterialRefs = refs
  }

  return suggestion
}

/** 契约 4.3 / 4.4：成功响应的必需字段齐全，且 source 只能是 model / fallback */
function asSuccess(value: unknown): AdvisorRecommendationsSuccess | null {
  if (!isPlainObject(value)) return null

  const { contractVersion, requestId, projectId, projectRevision, source, promptVersion, cached, suggestions } = value
  if (typeof contractVersion !== 'string' || typeof requestId !== 'string') return null
  if (typeof projectId !== 'string' || typeof projectRevision !== 'number') return null
  if (source !== 'model' && source !== 'fallback') return null
  if (typeof promptVersion !== 'string') return null
  if (typeof cached !== 'boolean') return null
  if (!Array.isArray(suggestions)) return null

  const fallbackReason = value.fallbackReason
  if (fallbackReason !== null && typeof fallbackReason !== 'string') return null

  const parsedSuggestions: Suggestion[] = []
  for (const item of suggestions) {
    const suggestion = asSuggestion(item)
    if (suggestion === null) return null
    parsedSuggestions.push(suggestion)
  }

  const milestoneRevision = value.milestoneRevision
  if (
    milestoneRevision !== undefined &&
    milestoneRevision !== null &&
    typeof milestoneRevision !== 'number'
  ) {
    return null
  }

  return {
    contractVersion,
    requestId,
    projectId,
    projectRevision,
    source,
    fallbackReason: fallbackReason as AdvisorFallbackReason | null,
    cached,
    promptVersion,
    ...(milestoneRevision === undefined
      ? {}
      : { milestoneRevision: milestoneRevision as number | null }),
    suggestions: parsedSuggestions,
  }
}

/** 契约 4.5：只要 code 是契约里的错误码，就当作契约失败响应处理 */
function asContractFailure(value: unknown): AdvisorRecommendationsFailure | null {
  if (!isPlainObject(value)) return null
  if (!isAdvisorErrorCode(value.code)) return null

  const requestId = typeof value.requestId === 'string' ? value.requestId : null
  const message = typeof value.message === 'string' ? value.message : ''
  const retryable =
    typeof value.retryable === 'boolean' ? value.retryable : RETRYABLE_BY_CODE[value.code]
  const retryAfterSeconds = typeof value.retryAfterSeconds === 'number' ? value.retryAfterSeconds : null

  return { contractVersion: CONTRACT_VERSION, requestId, code: value.code, message, retryable, retryAfterSeconds }
}

/* ---------------------------------------------------------- 失败构造 */

function httpFailureToError(cause: HttpFailureCause): AdvisorApiError {
  const causeMap: Record<HttpFailureCause, AdvisorErrorCause> = {
    http: 'http',
    timeout: 'timeout',
    network: 'network',
    aborted: 'aborted',
    'invalid-json': 'invalid-json',
  }
  const messageByCause: Record<HttpFailureCause, string> = {
    http: '后端返回了未预期的错误响应',
    timeout: '后端响应超时',
    network: '无法连接后端',
    aborted: '请求已取消',
    'invalid-json': '后端响应不是合法 JSON',
  }

  return {
    // 契约 7.5 / 8.4：超时、网络失败、响应不是合法 JSON 都按 NETWORK_ERROR 处理
    code: 'NETWORK_ERROR',
    message: messageByCause[cause],
    // 主动取消不是可重试的失败；其余传输层失败可以稍后重试
    retryable: cause !== 'aborted',
    retryAfterSeconds: null,
    requestId: null,
    cause: causeMap[cause],
  }
}

function contractFailureToError(failure: AdvisorRecommendationsFailure): AdvisorApiError {
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    retryAfterSeconds: failure.retryAfterSeconds,
    requestId: failure.requestId,
    cause: 'http',
  }
}

/** 契约 4.7 第 1~3 条：requestId / projectId / projectRevision 三项都对得上，响应才可用 */
function isStaleResponse(
  success: AdvisorRecommendationsSuccess,
  request: AdvisorRecommendationsRequest,
): boolean {
  return (
    success.requestId !== request.requestId ||
    success.projectId !== request.projectId ||
    success.projectRevision !== request.projectRevision
  )
}

function staleResponseError(success: AdvisorRecommendationsSuccess): AdvisorApiError {
  console.warn('[advisor] 丢弃过期响应：requestId / projectId / projectRevision 与本次请求不一致')
  return {
    code: 'STALE_RESPONSE',
    message: '该建议响应已过期，已丢弃',
    retryable: false,
    retryAfterSeconds: null,
    requestId: success.requestId,
    cause: 'stale-response',
  }
}

/* -------------------------------------------------------------- 主流程 */

export interface FetchRecommendationsOptions {
  /** 覆盖默认超时（默认 20 秒，见 http.ts） */
  timeoutMs?: number
  /** 切换项目 / 重新判断时取消上一次请求 */
  signal?: AbortSignal
  /** 注入 fetch，便于测试 */
  fetchImpl?: typeof fetch
  /** 是否允许自动重试 1 次，默认 true（契约 4.0） */
  retry?: boolean
}

/**
 * 请求后端生成建议。
 * 不抛异常：失败一律以 `{ ok: false, error }` 返回，错误里保留契约字段。
 *
 * 契约 4.0：可重试的失败（`retryable: true`）在**适配层**自动重试 1 次，退避 1 秒。
 * 已经被取消的请求（切换项目、发起新请求）不重试。
 */
export async function fetchRecommendations(
  request: AdvisorRecommendationsRequest,
  options: FetchRecommendationsOptions = {},
): Promise<AdvisorApiResult> {
  const retry = options.retry ?? true
  let result = await requestOnce(request, options)

  if (!result.ok && retry && result.error.retryable && !isAborted(options.signal)) {
    await delay(RETRY_DELAY_MS)
    if (!isAborted(options.signal)) {
      result = await requestOnce(request, options)
    }
  }

  return result
}

async function requestOnce(
  request: AdvisorRecommendationsRequest,
  options: FetchRecommendationsOptions = {},
): Promise<AdvisorApiResult> {
  const result = await requestJson(ADVISOR_RECOMMENDATIONS_PATH, {
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })

  if (!result.ok) {
    if (result.cause === 'http') {
      const failure = asContractFailure(result.data)
      if (failure !== null) {
        console.warn(`[advisor] 后端返回契约错误：${failure.code}`)
        return { ok: false, error: contractFailureToError(failure) }
      }
    }
    return { ok: false, error: httpFailureToError(result.cause) }
  }

  const success = asSuccess(result.data)
  if (success === null) {
    // 契约 8.4：响应缺少必需字段 = 契约违规，按 NETWORK_ERROR 处理，不静默使用残缺数据
    console.warn('[advisor] 响应不符合契约（缺少必需字段或字段类型不对）')
    return {
      ok: false,
      error: {
        ...httpFailureToError('invalid-json'),
        // JSON 本身是合法的，是**结构**不符合契约（契约 4.6 / 8.4）：文案要说清楚
        message: '后端响应不符合契约，已丢弃',
        cause: 'invalid-response',
      },
    }
  }

  if (isStaleResponse(success, request)) {
    return { ok: false, error: staleResponseError(success) }
  }

  return { ok: true, data: success }
}

/* ------------------------------------------------------ 响应 → 领域对象 */

/**
 * 把线上的 suggestions 转成前端领域对象（契约 2.5(b)）。
 * `generatedAt` 是本地字段，后端不返回；在这里补上。
 */
export function toRecommendations(success: AdvisorRecommendationsSuccess): Recommendation[] {
  const generatedAt = new Date().toISOString()

  return success.suggestions.slice(0, MAX_SUGGESTIONS).map((suggestion, index) => ({
    title: suggestion.title,
    whyNow: suggestion.whyNow,
    doneCriteria: suggestion.doneCriteria,
    existingTaskId: suggestion.existingTaskId,
    basisEvidenceIds: [...suggestion.basisEvidenceIds],
    basisDoubtIds: [...suggestion.basisDoubtIds],
    ...(suggestion.basisMaterialRefs === undefined
      ? {}
      : { basisMaterialRefs: [...suggestion.basisMaterialRefs] }),
    id: buildRecommendationId(success.source, success.requestId, success.projectRevision, index),
    source: success.source,
    requestId: success.requestId,
    projectRevision: success.projectRevision,
    generatedAt,
  }))
}

/* ------------------------------------------------------------ 结果判断 */

/** 是否是"过期响应"（契约 4.7）：是则静默丢弃，不要提示用户 */
export function isStaleResponseError(error: AdvisorApiError): boolean {
  return error.code === 'STALE_RESPONSE'
}

/**
 * 契约 5.1：是否需要切到前端本地规则。
 * 除"过期响应"外（那是正常竞态，丢弃即可），其余失败都要有兜底建议可显示。
 */
export function shouldFallbackToLocalRule(error: AdvisorApiError): boolean {
  return error.code !== 'STALE_RESPONSE'
}

/* ------------------------------------------------------------ 聊天主流程 */

/**
 * 契约 6.4：成功响应必需字段齐全，`answer` 必须非空。
 *
 * `promptVersion` **不是**响应必需字段（契约 6.4 的响应只约定
 * `source` / `fallbackReason` / `answer`；服务端聊天接口不回显它）。
 * 这里不回显时用本次请求的版本，绝不能因为"少一个非必需字段"就把正常回答判成非法响应
 * ——那会导致自动重试一次、并把可用的回答丢掉。
 */
function asChatSuccess(value: unknown, requestPromptVersion: string): AdvisorChatSuccess | null {
  if (!isPlainObject(value)) return null

  const { contractVersion, requestId, projectId, projectRevision, source, promptVersion, answer } = value
  if (typeof contractVersion !== 'string' || typeof requestId !== 'string') return null
  if (typeof projectId !== 'string' || typeof projectRevision !== 'number') return null
  if (source !== 'model' && source !== 'fallback') return null
  if (answer !== undefined && answer !== null && typeof answer !== 'string') return null
  if (typeof answer !== 'string' || answer.trim() === '') return null

  const fallbackReason = value.fallbackReason
  if (fallbackReason !== null && typeof fallbackReason !== 'string') return null

  const milestoneRevision = value.milestoneRevision
  if (
    milestoneRevision !== undefined &&
    milestoneRevision !== null &&
    typeof milestoneRevision !== 'number'
  ) {
    return null
  }

  let citations: BasisMaterialRef[] | undefined
  if (value.citations !== undefined) {
    if (!Array.isArray(value.citations)) return null
    citations = []
    for (const item of value.citations) {
      const ref = asBasisMaterialRef(item)
      if (ref !== null) citations.push(ref)
    }
  }

  return {
    contractVersion,
    requestId,
    projectId,
    projectRevision,
    source,
    fallbackReason: fallbackReason as AdvisorFallbackReason | null,
    promptVersion: typeof promptVersion === 'string' ? promptVersion : requestPromptVersion,
    ...(milestoneRevision === undefined
      ? {}
      : { milestoneRevision: milestoneRevision as number | null }),
    ...(citations === undefined ? {} : { citations }),
    answer,
  }
}

export interface FetchAdvisorChatOptions {
  /** 覆盖默认超时（默认 20 秒，见 http.ts） */
  timeoutMs?: number
  /** 切换项目 / 关闭面板时取消上一次请求 */
  signal?: AbortSignal
  /** 注入 fetch，便于测试 */
  fetchImpl?: typeof fetch
  /** 是否允许自动重试 1 次，默认 true（契约 4.0） */
  retry?: boolean
}

/**
 * 契约 6.4：请求后端回答一次提问。
 *
 * 与建议接口同一套约定：不抛异常；`retryable: true` 的失败在适配层最多重试 1 次
 * （退避 1 秒）；`requestId` / `projectId` / `projectRevision` 三项对不上就整份丢弃。
 */
export async function fetchAdvisorChat(
  request: AdvisorChatRequest,
  options: FetchAdvisorChatOptions = {},
): Promise<AdvisorChatResult> {
  const retry = options.retry ?? true
  let result = await requestChatOnce(request, options)

  if (!result.ok && retry && result.error.retryable && !isAborted(options.signal)) {
    await delay(RETRY_DELAY_MS)
    if (!isAborted(options.signal)) {
      result = await requestChatOnce(request, options)
    }
  }

  return result
}

async function requestChatOnce(
  request: AdvisorChatRequest,
  options: FetchAdvisorChatOptions = {},
): Promise<AdvisorChatResult> {
  const result = await requestJson(ADVISOR_CHAT_PATH, {
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })

  if (!result.ok) {
    if (result.cause === 'http') {
      const failure = asContractFailure(result.data)
      if (failure !== null) {
        console.warn(`[advisor-chat] 后端返回契约错误：${failure.code}`)
        return { ok: false, error: contractFailureToError(failure) }
      }
    }
    return { ok: false, error: httpFailureToError(result.cause) }
  }

  const success = asChatSuccess(result.data, request.promptVersion)
  if (success === null) {
    console.warn('[advisor-chat] 响应不符合契约（缺少必需字段或字段类型不对）')
    return {
      ok: false,
      error: {
        ...httpFailureToError('invalid-json'),
        // JSON 本身是合法的，是**结构**不符合契约（契约 4.6 / 8.4）：文案要说清楚
        message: '后端响应不符合契约，已丢弃',
        cause: 'invalid-response',
      },
    }
  }

  if (
    success.requestId !== request.requestId ||
    success.projectId !== request.projectId ||
    success.projectRevision !== request.projectRevision
  ) {
    console.warn('[advisor-chat] 丢弃过期响应：requestId / projectId / projectRevision 与本次请求不一致')
    return {
      ok: false,
      error: {
        code: 'STALE_RESPONSE',
        message: '该聊天响应已过期，已丢弃',
        retryable: false,
        retryAfterSeconds: null,
        requestId: success.requestId,
        cause: 'stale-response',
      },
    }
  }

  return { ok: true, data: success }
}
