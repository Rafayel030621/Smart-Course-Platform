import { requestJson, type HttpFailureCause } from './http'
import {
  CONTRACT_VERSION,
  DEFAULT_PROMPT_VERSION,
  RETRYABLE_BY_CODE,
  isAdvisorErrorCode,
  type AdvisorApiError,
  type AdvisorApiResult,
  type AdvisorErrorCause,
  type AdvisorFallbackReason,
  type AdvisorRecommendationsFailure,
  type AdvisorRecommendationsRequest,
  type AdvisorRecommendationsSuccess,
  type DoubtSnapshot,
  type EvidenceSnapshot,
  type Recommendation,
  type RecommendationSource,
  type Suggestion,
  type TaskSnapshot,
} from '@/domain/recommendation'

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
  /** 默认取契约约定的当前版本 */
  promptVersion?: string
  /** 对应页面「重新判断下一步」 */
  forceRefresh?: boolean
  /** 不传则自动生成 */
  requestId?: string
}

/**
 * 由 store 把项目状态映射成快照后调用它组装请求体。
 * 这里只做字段装配与默认值，不做校验——校验在请求发出后由契约约束。
 */
export function buildAdvisorRequest(input: BuildAdvisorRequestInput): AdvisorRecommendationsRequest {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: input.requestId ?? createRequestId(),
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    projectName: input.projectName,
    currentMilestone: input.currentMilestone,
    confirmedContext: input.confirmedContext ?? [],
    tasks: input.tasks,
    evidence: input.evidence,
    doubts: input.doubts,
    promptVersion: input.promptVersion ?? DEFAULT_PROMPT_VERSION,
    forceRefresh: input.forceRefresh ?? false,
  }
}

/* ---------------------------------------------------------- 响应校验 */

/**
 * 契约 2.5(a)：逐字段校验一条建议。
 * 关键点：`existingTaskId` 是**必填可空**——必须是 string 或 null；
 * 缺失/其它类型都不接受，尤其**不能**转成空字符串。
 */
function asSuggestion(value: unknown): Suggestion | null {
  if (!isPlainObject(value)) return null

  const { title, whyNow, doneCriteria, existingTaskId, basisEvidenceIds, basisDoubtIds } = value
  if (typeof title !== 'string' || typeof whyNow !== 'string' || typeof doneCriteria !== 'string') return null
  if (existingTaskId !== null && typeof existingTaskId !== 'string') return null
  if (!Array.isArray(basisEvidenceIds) || !basisEvidenceIds.every((id) => typeof id === 'string')) return null
  if (!Array.isArray(basisDoubtIds) || !basisDoubtIds.every((id) => typeof id === 'string')) return null

  return {
    title,
    whyNow,
    doneCriteria,
    existingTaskId,
    basisEvidenceIds: [...basisEvidenceIds] as string[],
    basisDoubtIds: [...basisDoubtIds] as string[],
  }
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

  return {
    contractVersion,
    requestId,
    projectId,
    projectRevision,
    source,
    fallbackReason: fallbackReason as AdvisorFallbackReason | null,
    cached,
    promptVersion,
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
      error: { ...httpFailureToError('invalid-json'), cause: 'invalid-response' },
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
