/**
 * 通用 HTTP 请求封装
 * ----------------------------------------------------------------------------
 * 职责只有四件：拼地址、发请求、处理超时、把结果整理成统一形状。
 *
 * 两条硬约束：
 *   1. 前端**永远不持有模型 API Key**（契约 7.4）：这里只读 VITE_API_BASE_URL 这个公开地址，
 *      不读、不存、不打印任何密钥；模型调用一律由后端代理。
 *   2. 日志里不出现请求体（项目材料属于业务内容，可能含隐私信息），只记录方法与路径。
 */

/** 本地开发的默认后端地址：VITE_API_BASE_URL 未配置时使用 */
export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8080'

/** 与契约 7.5 对齐：前端适配层 20 秒超时，超时按 NETWORK_ERROR 处理 */
export const DEFAULT_TIMEOUT_MS = 20_000

/** 去掉末尾斜杠，避免拼出 `//api/...` */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * 读取后端地址。
 * VITE_API_BASE_URL **不含 `/api`**（契约 4.0）：路径由调用方按契约补全。
 */
export function resolveApiBaseUrl(env?: ImportMetaEnv): string {
  const raw = env?.VITE_API_BASE_URL
  const value = typeof raw === 'string' ? raw.trim() : ''
  return normalizeBaseUrl(value === '' ? DEFAULT_API_BASE_URL : value)
}

/** 当前生效的后端地址（模块加载时解析一次） */
export const API_BASE_URL: string = resolveApiBaseUrl(import.meta.env)

/** 拼接完整地址；已是完整 http(s) 地址时原样返回（便于临时指向别的环境） */
export function buildUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE_URL}${suffix}`
}

/** 失败原因，供上层区分处理（界面文案与是否切本地规则） */
export type HttpFailureCause =
  /** 收到了响应，但状态码不是 2xx */
  | 'http'
  /** 超过了 timeoutMs */
  | 'timeout'
  /** 网络层失败（DNS / 连接被拒 / CORS / 代理断开） */
  | 'network'
  /** 调用方主动取消（例如切换项目） */
  | 'aborted'
  /** 2xx，但响应体不是合法 JSON */
  | 'invalid-json'

export type HttpResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number | null; cause: HttpFailureCause; data: unknown }

export interface HttpRequestOptions {
  method?: 'GET' | 'POST'
  /** 会被 JSON.stringify；不要放敏感字段 */
  body?: unknown
  timeoutMs?: number
  /** 外部取消信号（与内部超时联动） */
  signal?: AbortSignal
  headers?: Record<string, string>
  /** 注入 fetch，便于测试替换；默认用全局 fetch */
  fetchImpl?: typeof fetch
}

type JsonReadResult = { parsed: true; value: unknown } | { parsed: false }

async function readJson(response: Response): Promise<JsonReadResult> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return { parsed: false }
  }
  if (text.trim() === '') return { parsed: true, value: null }
  try {
    return { parsed: true, value: JSON.parse(text) as unknown }
  } catch {
    return { parsed: false }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 发一个 JSON 请求。
 * 不抛异常：所有失败都以 `{ ok: false, cause }` 返回，由上层映射成契约错误码。
 */
export async function requestJson(path: string, options: HttpRequestOptions = {}): Promise<HttpResult> {
  const {
    method = 'GET',
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    headers,
    fetchImpl = fetch,
  } = options

  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onExternalAbort = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort)
  }

  try {
    const response = await fetchImpl(buildUrl(path), {
      method,
      headers: {
        accept: 'application/json',
        // 契约 4.0：Content-Type: application/json（charset=utf-8）
        ...(body === undefined ? {} : { 'content-type': 'application/json;charset=utf-8' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })

    const json = await readJson(response)

    if (!response.ok) {
      // 只记录方法、路径与状态码：不打印请求体或响应体
      console.warn(`[http] ${method} ${path} → HTTP ${response.status}`)
      return { ok: false, status: response.status, cause: 'http', data: json.parsed ? json.value : null }
    }

    if (!json.parsed) {
      console.warn(`[http] ${method} ${path} → HTTP ${response.status}（响应不是合法 JSON）`)
      return { ok: false, status: response.status, cause: 'invalid-json', data: null }
    }

    return { ok: true, status: response.status, data: json.value }
  } catch (error) {
    if (timedOut) {
      console.warn(`[http] ${method} ${path} 超时（${timeoutMs}ms）`)
      return { ok: false, status: null, cause: 'timeout', data: null }
    }
    if (isAbortError(error)) {
      return { ok: false, status: null, cause: 'aborted', data: null }
    }
    console.warn(`[http] ${method} ${path} 网络请求失败（${error instanceof Error ? error.name : 'unknown'}）`)
    return { ok: false, status: null, cause: 'network', data: null }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}
