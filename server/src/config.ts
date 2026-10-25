import type { AdvisorProviderKind, ModelEndpoint } from './advisor/types.js'

/**
 * 后端配置
 * ----------------------------------------------------------------------------
 * 只从环境变量读，不读配置文件、不落盘、不打印密钥内容。
 * 契约要求默认监听 127.0.0.1:8080，端口可用 PORT 覆盖（见 docs/contracts.md 第 7 节）。
 */

export interface ServerConfig {
  /** 监听地址。默认只监听本机，由 Nginx / Cloudflare 隧道对外 */
  host: string
  /** 监听端口，默认 8080 */
  port: number
  /** 健康检查里返回的服务名 */
  serviceName: string
  /** 契约版本，与 docs/contracts.md 保持一致 */
  contractVersion: string
}

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8080
export const SERVICE_NAME = 'course-platform-api'
export const CONTRACT_VERSION = '1.0'

const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * 解析端口。
 * 非法值直接抛错而不是回退到默认值：宁可启动失败，也不要让服务悄悄跑在别的端口上
 * ——否则隧道和排查都会指向错误的位置。报错信息不回显原值，避免把环境变量内容带进日志。
 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT

  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    throw new Error(`环境变量 PORT 必须是 ${MIN_PORT}-${MAX_PORT} 之间的整数`)
  }
  return value
}

/** 读取一份完整配置。参数可注入，便于测试 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST?.trim() || DEFAULT_HOST,
    port: parsePort(env.PORT),
    serviceName: SERVICE_NAME,
    contractVersion: CONTRACT_VERSION,
  }
}

/** 进程启动时使用的配置 */
export const config: ServerConfig = loadConfig()

/* ---------------------------------------------------------------- 模型配置 */

/** provider 单次调用超时默认值（契约 7.5：与前端适配层的 20 秒对齐） */
export const DEFAULT_MODEL_TIMEOUT_MS = 20_000
const MIN_MODEL_TIMEOUT_MS = 100
const MAX_MODEL_TIMEOUT_MS = 120_000

export interface ModelConfig {
  /** 运行时默认使用真实 provider；mock 只用于本地联调与离线测试注入 */
  provider: AdvisorProviderKind
  /**
   * 模型端点。`url` 按完整地址使用，provider 不拼接任何路径。
   * 三项（URL / Key / 模型名）任一为空时整体为 null，表示"未配置"。
   */
  endpoint: ModelEndpoint | null
  /** 缺失的环境变量名。只放名字，绝不放值 */
  missing: string[]
  /** provider 超时。无论是否配置完整都有值，服务层用它算安全网超时 */
  timeoutMs: number
}

/**
 * 解析模型超时。
 * 非法值回退到默认值并告警，而不是像 PORT 那样直接抛错：
 * 端口配错会让服务监听在错误位置，超时配错只是行为差异，不该让服务起不来。
 */
export function parseModelTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MODEL_TIMEOUT_MS

  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_MODEL_TIMEOUT_MS || value > MAX_MODEL_TIMEOUT_MS) {
    console.warn(
      `[server] MODEL_TIMEOUT_MS 必须是 ${MIN_MODEL_TIMEOUT_MS}-${MAX_MODEL_TIMEOUT_MS} 之间的整数，已按默认 ${DEFAULT_MODEL_TIMEOUT_MS} 毫秒处理`,
    )
    return DEFAULT_MODEL_TIMEOUT_MS
  }
  return value
}

/**
 * 读取模型配置。参数可注入，便于测试。
 *
 * 注意：这里**只做读取与缺失判断**，不做任何默认值填充——
 * 缺少 URL / Key / 模型名必须原样暴露成"未配置"，由 provider 转成 MODEL_NOT_CONFIGURED，
 * 而不是悄悄用一个假地址去请求。
 */
export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const rawProvider = env.ADVISOR_PROVIDER?.trim()
  let provider: AdvisorProviderKind = 'openai-compatible'

  if (rawProvider === 'mock') {
    provider = 'mock'
  } else if (rawProvider !== undefined && rawProvider !== '' && rawProvider !== 'openai-compatible') {
    console.warn('[server] ADVISOR_PROVIDER 只支持 openai-compatible / mock，已按 openai-compatible 处理')
  }

  const timeoutMs = parseModelTimeout(env.MODEL_TIMEOUT_MS)

  // mock provider 不需要模型配置
  if (provider === 'mock') {
    return { provider, endpoint: null, missing: [], timeoutMs }
  }

  const url = env.MODEL_API_URL?.trim() ?? ''
  const apiKey = env.MODEL_API_KEY?.trim() ?? ''
  const model = env.MODEL_NAME?.trim() ?? ''

  const missing: string[] = []
  if (url === '') missing.push('MODEL_API_URL')
  if (apiKey === '') missing.push('MODEL_API_KEY')
  if (model === '') missing.push('MODEL_NAME')

  return {
    provider,
    endpoint: missing.length === 0 ? { url, apiKey, model, timeoutMs } : null,
    missing,
    timeoutMs,
  }
}

/** 进程启动时使用的模型配置 */
export const modelConfig: ModelConfig = loadModelConfig()

/* ---------------------------------------------------------------- 论文检索配置 */

/** OpenAlex 默认超时（契约 29.5）：超过即降级，不把上游错误抛给学生 */
export const DEFAULT_OPENALEX_TIMEOUT_MS = 8_000
const MIN_OPENALEX_TIMEOUT_MS = 500
const MAX_OPENALEX_TIMEOUT_MS = 30_000

export interface PapersConfig {
  /** OpenAlex 礼貌池联系邮箱；未配置时为 null，检索返回 503 PAPERS_UPSTREAM_ERROR */
  mailto: string | null
  /** 上游超时。无论是否配置完整都有值 */
  timeoutMs: number
  /** 缺失的环境变量名。只放名字，绝不放值 */
  missing: string[]
}

/**
 * 解析 OpenAlex 超时。
 * 与模型超时同风格：非法值回退默认并告警，而不是让服务起不来。
 */
export function parseOpenAlexTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_OPENALEX_TIMEOUT_MS

  const value = Number(raw)
  if (!Number.isInteger(value) || value < MIN_OPENALEX_TIMEOUT_MS || value > MAX_OPENALEX_TIMEOUT_MS) {
    console.warn(
      `[server] OPENALEX_TIMEOUT_MS 必须是 ${MIN_OPENALEX_TIMEOUT_MS}-${MAX_OPENALEX_TIMEOUT_MS} 之间的整数，已按默认 ${DEFAULT_OPENALEX_TIMEOUT_MS} 毫秒处理`,
    )
    return DEFAULT_OPENALEX_TIMEOUT_MS
  }
  return value
}

/**
 * 读取论文检索配置。参数可注入，便于测试。
 * 与模型配置一样：缺字段原样暴露成 missing，由路由转成 PAPERS_UPSTREAM_ERROR。
 */
export function loadPapersConfig(env: NodeJS.ProcessEnv = process.env): PapersConfig {
  const mailto = env.OPENALEX_MAILTO?.trim() ?? ''
  const missing: string[] = []
  if (mailto === '') missing.push('OPENALEX_MAILTO')

  return {
    mailto: mailto === '' ? null : mailto,
    timeoutMs: parseOpenAlexTimeout(env.OPENALEX_TIMEOUT_MS),
    missing,
  }
}

/** 进程启动时使用的论文检索配置 */
export const papersConfig: PapersConfig = loadPapersConfig()
