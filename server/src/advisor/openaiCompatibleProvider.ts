import { PROMPT_TEMPERATURE, buildChatMessages, buildMessages } from './prompt.js'
import { buildUnderstandingMessages } from '../materials/prompt.js'
import {
  AdvisorProviderError,
  silentLogger,
  type AdvisorLogger,
  type AdvisorChatRequest,
  type AdvisorProvider,
  type AdvisorRequest,
  type FetchLike,
  type ModelEndpoint,
  type ProviderOutput,
  type UnderstandingProviderInput,
} from './types.js'

/**
 * OpenAI 兼容 provider（真实模型）
 * ----------------------------------------------------------------------------
 * 只做三件事：发请求、取 choices[0].message.content、把内容解析成 JSON 交给输出校验层。
 *
 * 不在这里做建议的字段校验——那是 validation.ts 的职责，复制一套会出现两套规则。
 * 也不在这里做超时兜底决策——provider 只负责"按原因失败"，由 service.ts 决定是否兜底。
 *
 * 不使用任何模型 SDK：用 Node 22 原生 fetch + AbortController。
 */

export const OPENAI_COMPATIBLE_PROVIDER_NAME = 'openai-compatible'

/** 缺配置时的提示：只说缺哪些环境变量名，不含任何值 */
const DEFAULT_MISSING_HINT = 'MODEL_API_URL / MODEL_API_KEY / MODEL_NAME'

export interface OpenAiCompatibleProviderOptions {
  /** 完整端点配置；null 表示配置不完整，调用时直接返回 MODEL_NOT_CONFIGURED */
  endpoint: ModelEndpoint | null
  /** 缺失的环境变量名（只放名字），用于错误信息与服务端日志 */
  missingEnvNames?: string[]
  /** 注入 fetch，便于离线单元测试；默认用全局 fetch */
  fetchImpl?: FetchLike
  logger?: AdvisorLogger
  name?: string
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleProviderOptions): AdvisorProvider {
  const logger = options.logger ?? silentLogger
  const name = options.name ?? OPENAI_COMPATIBLE_PROVIDER_NAME
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  const { endpoint } = options
  const missingEnvNames = options.missingEnvNames ?? []

  async function generate(request: AdvisorRequest): Promise<ProviderOutput> {
    if (endpoint === null) {
      // 配置缺失是确定性失败：重试不会变好，交给 service 走兜底并带上 MODEL_NOT_CONFIGURED
      throw new AdvisorProviderError(
        `模型配置缺失，请设置：${missingEnvNames.length > 0 ? missingEnvNames.join(' / ') : DEFAULT_MISSING_HINT}`,
        'MODEL_NOT_CONFIGURED',
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs)

    try {
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages: buildMessages(request),
          temperature: PROMPT_TEMPERATURE,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        // 只记录状态码，不记录上游响应原文（可能很大，也可能含内部信息）
        logger.warn('模型服务返回非 2xx', { provider: name, status: response.status })
        throw new AdvisorProviderError(`模型服务返回 ${response.status}`, 'MODEL_UNAVAILABLE')
      }

      const payload = await readJsonSafely(response)
      const content = readAssistantContent(payload)

      if (content === null) {
        logger.warn('模型响应结构不完整（缺少 choices[0].message.content）', { provider: name })
        throw new AdvisorProviderError('模型响应结构不完整', 'INVALID_MODEL_OUTPUT')
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(stripCodeFence(content))
      } catch {
        logger.warn('模型返回的 content 不是合法 JSON', { provider: name })
        throw new AdvisorProviderError('模型返回的 content 不是合法 JSON', 'INVALID_MODEL_OUTPUT')
      }

      return { suggestions: extractSuggestions(parsed) }
    } catch (error) {
      if (controller.signal.aborted) {
        logger.warn('模型调用超时', { provider: name, timeoutMs: endpoint.timeoutMs })
        throw new AdvisorProviderError(`模型调用超过 ${endpoint.timeoutMs} 毫秒未返回`, 'MODEL_TIMEOUT')
      }
      if (error instanceof AdvisorProviderError) throw error

      // 网络错误等：只记录错误的类型名，不记录堆栈与请求头
      logger.warn('模型请求失败', {
        provider: name,
        detail: error instanceof Error ? error.name : 'unknown',
      })
      throw new AdvisorProviderError('模型请求失败', 'MODEL_UNAVAILABLE')
    } finally {
      clearTimeout(timer)
    }
  }

  async function generateChat(request: AdvisorChatRequest): Promise<{ answer: unknown }> {
    if (endpoint === null) throw new AdvisorProviderError('模型配置缺失', 'MODEL_NOT_CONFIGURED')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs)
    try {
      const response = await fetchImpl(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` }, body: JSON.stringify({ model: endpoint.model, messages: buildChatMessages(request), temperature: PROMPT_TEMPERATURE }), signal: controller.signal })
      if (!response.ok) throw new AdvisorProviderError(`模型服务返回 ${response.status}`, 'MODEL_UNAVAILABLE')
      const payload = await readJsonSafely(response)
      const content = readAssistantContent(payload)
      if (content === null) throw new AdvisorProviderError('模型响应结构不完整', 'INVALID_MODEL_OUTPUT')
      return { answer: content.trim() }
    } catch (error) {
      if (controller.signal.aborted) throw new AdvisorProviderError('模型调用超时', 'MODEL_TIMEOUT')
      if (error instanceof AdvisorProviderError) throw error
      logger.warn('模型聊天请求失败', { provider: name, detail: error instanceof Error ? error.name : 'unknown' })
      throw new AdvisorProviderError('模型请求失败', 'MODEL_UNAVAILABLE')
    } finally { clearTimeout(timer) }
  }

  /**
   * v2（M2-A）材料理解（契约 15.2）：与 generate 同一套请求形态，只是提示词不同。
   * 只把模型内容解析成 JSON 返回，字段与引用校验全部交给 materials 的输出校验层。
   */
  async function generateUnderstanding(request: UnderstandingProviderInput): Promise<{ draft: unknown }> {
    if (endpoint === null) {
      throw new AdvisorProviderError(
        `模型配置缺失，请设置：${missingEnvNames.length > 0 ? missingEnvNames.join(' / ') : DEFAULT_MISSING_HINT}`,
        'MODEL_NOT_CONFIGURED',
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs)

    try {
      const response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages: buildUnderstandingMessages(request),
          temperature: PROMPT_TEMPERATURE,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        logger.warn('模型服务返回非 2xx', { provider: name, status: response.status })
        throw new AdvisorProviderError(`模型服务返回 ${response.status}`, 'MODEL_UNAVAILABLE')
      }

      const payload = await readJsonSafely(response)
      const content = readAssistantContent(payload)
      if (content === null) {
        logger.warn('模型响应结构不完整（缺少 choices[0].message.content）', { provider: name })
        throw new AdvisorProviderError('模型响应结构不完整', 'INVALID_MODEL_OUTPUT')
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(stripCodeFence(content))
      } catch {
        logger.warn('模型返回的 content 不是合法 JSON', { provider: name })
        throw new AdvisorProviderError('模型返回的 content 不是合法 JSON', 'INVALID_MODEL_OUTPUT')
      }

      return { draft: parsed }
    } catch (error) {
      if (controller.signal.aborted) {
        logger.warn('模型调用超时', { provider: name, timeoutMs: endpoint.timeoutMs })
        throw new AdvisorProviderError(`模型调用超过 ${endpoint.timeoutMs} 毫秒未返回`, 'MODEL_TIMEOUT')
      }
      if (error instanceof AdvisorProviderError) throw error

      logger.warn('模型材料理解请求失败', {
        provider: name,
        detail: error instanceof Error ? error.name : 'unknown',
      })
      throw new AdvisorProviderError('模型请求失败', 'MODEL_UNAVAILABLE')
    } finally {
      clearTimeout(timer)
    }
  }

  return { name, generate, generateChat, generateUnderstanding }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 上游响应不是 JSON 时返回 null，由调用方按"结构不完整"处理 */
async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** 读取 choices[0].message.content；任何一层缺失都返回 null */
function readAssistantContent(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null

  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return null

  const first = choices[0]
  if (!isPlainObject(first)) return null

  const message = first.message
  if (!isPlainObject(message)) return null

  const content = message.content
  return typeof content === 'string' ? content : null
}

/**
 * 有些模型会把 JSON 包在 ```json 代码块里。系统提示词已经禁止了这种输出，
 * 这里做一次最小宽容：优先按原样解析，只有明显带围栏时才剥掉围栏。
 */
function stripCodeFence(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const withoutOpening = trimmed.replace(/^```[a-zA-Z]*\s*/, '')
  return withoutOpening.replace(/```\s*$/, '').trim()
}

/**
 * 从模型返回的 JSON 里取出建议列表，形状不做判断——交给输出校验层。
 * 模型直接给数组时也接受（同样不在这里判断元素是否合法）。
 */
function extractSuggestions(parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed
  if (isPlainObject(parsed)) return parsed.suggestions
  return undefined
}
