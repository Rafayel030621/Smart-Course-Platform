import { isHumanizedUserText, LIMITS, normalizeSuggestions } from './validation.js'
import type { FallbackGenerator } from './fallback.js'
import {
  AdvisorProviderError,
  silentLogger,
  type AdvisorFallbackReason,
  type AdvisorChatRequest,
  type AdvisorLogger,
  type AdvisorProvider,
  type AdvisorRequest,
  type AdvisorRuntimeErrorCode,
  type ProviderOutput,
  type Suggestion,
} from './types.js'

/**
 * 建议服务：把 provider、输出校验和规则兜底串起来
 * ----------------------------------------------------------------------------
 * 这一层不接触 HTTP：输入是通过校验的 AdvisorRequest，输出是"成功（含来源）"或"最终失败码"。
 * 契约 5.1 规定的分工在这里落地：
 *   - 模型成功且输出合法  → source: "model"
 *   - 模型失败/输出非法    → 服务端规则兜底，成功则 source: "fallback"（仍返回 200）
 *   - 兜底也失败          → 才把失败码交给路由层
 */

export const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000

export interface AdvisorServiceSuccess {
  ok: true
  source: 'model' | 'fallback'
  /** 只有 fallback 时非空 */
  fallbackReason: AdvisorFallbackReason | null
  /** 本轮没有服务端缓存，恒为 false；字段先留在契约位置上 */
  cached: boolean
  suggestions: Suggestion[]
}

export interface AdvisorServiceFailure {
  ok: false
  code: AdvisorRuntimeErrorCode
  retryable: boolean
  retryAfterSeconds: number | null
}

export type AdvisorServiceResult = AdvisorServiceSuccess | AdvisorServiceFailure

export interface AdvisorServiceOptions {
  provider: AdvisorProvider
  /** 规则兜底。同步函数；抛错即视为兜底失败 */
  fallback: FallbackGenerator
  /** 单次 provider 调用超时，默认 20 秒（与契约 7.5 对齐） */
  timeoutMs?: number
  logger?: AdvisorLogger
}

export interface AdvisorService {
  readonly providerName: string
  readonly timeoutMs: number
  recommend(request: AdvisorRequest): Promise<AdvisorServiceResult>
  chat(request: AdvisorChatRequest): Promise<AdvisorChatServiceResult>
}

export interface AdvisorChatServiceSuccess { ok: true; source: 'model' | 'fallback'; fallbackReason: AdvisorFallbackReason | null; answer: string }
export interface AdvisorChatServiceFailure { ok: false; code: AdvisorRuntimeErrorCode; retryable: boolean; retryAfterSeconds: number | null }
export type AdvisorChatServiceResult = AdvisorChatServiceSuccess | AdvisorChatServiceFailure

class ProviderTimeoutError extends Error {
  constructor() {
    super('provider 调用超时')
    this.name = 'ProviderTimeoutError'
  }
}

/**
 * retryable 的含义（契约 6.1）：用户不改变输入时，稍后重试可能成功。
 * MODEL_NOT_CONFIGURED 是确定性失败（服务端没配密钥），重试不会变好。
 */
const RETRYABLE: Record<AdvisorRuntimeErrorCode, boolean> = {
  RATE_LIMITED: true,
  MODEL_TIMEOUT: true,
  INVALID_MODEL_OUTPUT: true,
  MODEL_UNAVAILABLE: true,
  MODEL_NOT_CONFIGURED: false,
  INTERNAL: true,
}

export function createAdvisorService(options: AdvisorServiceOptions): AdvisorService {
  const { provider, fallback } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
  const logger = options.logger ?? silentLogger

  function logNotes(request: AdvisorRequest, notes: string[]): void {
    if (notes.length === 0) return
    logger.warn('建议输出被清理', { requestId: request.requestId, notes })
  }

  function finalFailure(reason: AdvisorRuntimeErrorCode): AdvisorServiceFailure {
    return {
      ok: false,
      code: reason,
      retryable: RETRYABLE[reason],
      retryAfterSeconds: null,
    }
  }

  /** 走规则兜底；兜底结果与模型输出走同一套校验 */
  function runFallback(request: AdvisorRequest, reason: AdvisorFallbackReason): AdvisorServiceResult {
    let raw: ProviderOutput
    try {
      raw = fallback(request, reason)
    } catch (error) {
      logger.warn('规则兜底自身抛错', {
        requestId: request.requestId,
        reason,
        detail: error instanceof Error ? error.message : 'unknown',
      })
      return finalFailure(reason)
    }

    const normalized = normalizeSuggestions(raw, request)
    logNotes(request, normalized.notes)

    if (!normalized.ok || normalized.suggestions.length === 0) {
      logger.warn('规则兜底未能产出合法建议', { requestId: request.requestId, reason })
      return finalFailure(reason)
    }

    return {
      ok: true,
      source: 'fallback',
      fallbackReason: reason,
      cached: false,
      suggestions: normalized.suggestions,
    }
  }

  return {
    providerName: provider.name,
    timeoutMs,

    async recommend(request: AdvisorRequest): Promise<AdvisorServiceResult> {
      const outcome = await callProvider(provider, request, timeoutMs)

      if (!outcome.ok) {
        logger.warn('provider 调用失败，改用规则兜底', {
          requestId: request.requestId,
          reason: outcome.reason,
          provider: provider.name,
        })
        return runFallback(request, outcome.reason)
      }

      const normalized = normalizeSuggestions(outcome.output, request)
      logNotes(request, normalized.notes)

      const modelTextHasInternalTerm = normalized.ok && normalized.suggestions.some((suggestion) =>
        [suggestion.title, suggestion.whyNow, suggestion.doneCriteria].some((text) => !isHumanizedUserText(text)),
      )

      if (!normalized.ok || normalized.suggestions.length === 0 || modelTextHasInternalTerm) {
        logger.warn('模型输出不合法，改用规则兜底', { requestId: request.requestId })
        return runFallback(request, 'INVALID_MODEL_OUTPUT')
      }

      return {
        ok: true,
        source: 'model',
        fallbackReason: null,
        cached: false,
        suggestions: normalized.suggestions,
      }
    },
    async chat(request: AdvisorChatRequest): Promise<AdvisorChatServiceResult> {
      const providerWithChat = provider.generateChat
      const outcome = providerWithChat === undefined
        ? { ok: false as const, reason: 'MODEL_UNAVAILABLE' as const }
        : await callChatProvider(providerWithChat.bind(provider), request, timeoutMs)
      if (outcome.ok && typeof outcome.output.answer === 'string') {
        const answer = outcome.output.answer.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
        if (answer.length > 0 && answer.length <= LIMITS.answerLength && isHumanizedUserText(answer)) {
          return { ok: true, source: 'model', fallbackReason: null, answer }
        }
      }
      const reason = outcome.ok ? 'INVALID_MODEL_OUTPUT' : outcome.reason
      const fallback = '目前无法可靠生成回答。请根据当前项目中的任务、证据和未解决疑问继续推进，并把新的发现记录为证据后再提问。'
      logger.warn('聊天模型失败，使用安全兜底', { requestId: request.requestId, reason })
      return { ok: true, source: 'fallback', fallbackReason: reason, answer: fallback }
    },
  }
}

type ProviderOutcome = { ok: true; output: ProviderOutput } | { ok: false; reason: AdvisorFallbackReason }

async function callProvider(
  provider: AdvisorProvider,
  request: AdvisorRequest,
  timeoutMs: number,
): Promise<ProviderOutcome> {
  let timer: NodeJS.Timeout | undefined

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      const handle = setTimeout(() => reject(new ProviderTimeoutError()), timeoutMs)
      // 不让未触发的定时器把进程留住
      handle.unref()
      timer = handle
    })

    const output = await Promise.race([provider.generate(request), timeout])
    return { ok: true, output }
  } catch (error) {
    if (error instanceof ProviderTimeoutError) return { ok: false, reason: 'MODEL_TIMEOUT' }
    // provider 主动声明的失败原因优先采用（例如未配置密钥）
    if (error instanceof AdvisorProviderError) return { ok: false, reason: error.reason }
    // 其余一律按上游暂不可用处理
    return { ok: false, reason: 'MODEL_UNAVAILABLE' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function callChatProvider(
  generate: (request: AdvisorChatRequest) => Promise<{ answer: unknown }>,
  request: AdvisorChatRequest,
  timeoutMs: number,
): Promise<{ ok: true; output: { answer: unknown } } | { ok: false; reason: AdvisorFallbackReason }> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => { const handle = setTimeout(() => reject(new ProviderTimeoutError()), timeoutMs); handle.unref(); timer = handle })
    return { ok: true, output: await Promise.race([generate(request), timeout]) }
  } catch (error) {
    if (error instanceof ProviderTimeoutError) return { ok: false, reason: 'MODEL_TIMEOUT' }
    if (error instanceof AdvisorProviderError) return { ok: false, reason: error.reason }
    return { ok: false, reason: 'MODEL_UNAVAILABLE' }
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
