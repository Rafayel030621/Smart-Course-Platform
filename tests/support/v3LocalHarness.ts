/**
 * 本地 V3 后端集成测试的公共装置
 * ----------------------------------------------------------------------------
 * 只做四件事：
 *   1. 从环境变量解析 loopback 目标，并给出可读的跳过原因；
 *   2. 把全局 fetch 包一层：改写基地址 → 校验 loopback → 记录请求 → 维护 Cookie；
 *   3. 提供 `must` / `localRequest` 等断言与请求辅助；
 *   4. 生成可识别的测试标记（账号、项目名），但不打印任何凭据。
 *
 * 注意：这里不会读取或设置 `VITE_API_BASE_URL`；客户端即使配了别的地址，
 * 请求也会被改写到 `V3_LOCAL_API_BASE_URL`，或被 loopback 闸门拒绝。
 */
import { API_BASE_URL } from '@/services/http'
import { assertLoopbackRequestUrl, resolveLocalTarget, rewriteRequestUrl } from './v3LocalTarget'

const target = resolveLocalTarget(process.env.V3_LOCAL_API_BASE_URL)

/** 配置非法时在模块加载阶段失败：此时还没有发出任何请求 */
if (target.state === 'invalid') {
  throw new Error(
    `本地 V3 集成测试配置无效：${target.reason}。\n` +
      '请把 V3_LOCAL_API_BASE_URL 指向本机运行的后端（例如 http://127.0.0.1:8099）。',
  )
}

export const LOCAL_BASE_URL = target.state === 'ready' ? target.baseUrl : ''

const inviteCode = (process.env.V3_LOCAL_INVITE_CODE ?? '').trim()
export const HAS_INVITE_CODE = inviteCode !== ''

/** 非空表示本文件应跳过；内容会打印一次，便于理解为什么没跑 */
export const SKIP_REASON =
  target.state === 'unconfigured'
    ? '[v3-local-it] 跳过：未设置 V3_LOCAL_API_BASE_URL（本地 V3 后端地址）'
    : HAS_INVITE_CODE
      ? ''
      : '[v3-local-it] 跳过：未设置 V3_LOCAL_INVITE_CODE（注册测试账号需要邀请码）'

/** 测试数据标记：账号与项目名都带它，便于在本地库里识别残留数据 */
export const TEST_MARKER = 'v3local'

/**
 * 每次运行一个新的测试账号，避免依赖上一次的残留数据。
 * 账号规则：3～32 位字母/数字/下划线。
 */
export const TEST_ACCOUNT = `it_${TEST_MARKER}_${Date.now()}`

/** 测试账号密码：优先环境变量，否则运行时随机生成（不写进文件、不打印） */
function resolveTestPassword(): string {
  const fromEnv = (process.env.V3_LOCAL_TEST_PASSWORD ?? '').trim()
  if (fromEnv !== '') return fromEnv
  return `LocalIt-${crypto.randomUUID()}`
}
export const TEST_PASSWORD = resolveTestPassword()

/** 与服务端 CORS 白名单一致的来源；不影响真实请求的语义，只是让本地后端放行 */
export const LOCAL_TEST_ORIGIN = 'http://localhost:5173'

export function newRequestId(): string {
  return crypto.randomUUID()
}

export interface LocalFetchGuard {
  /** 本次集成测试实际发出的请求地址（已校验为 loopback） */
  readonly requests: string[]
  readonly realFetch: typeof fetch
  uninstall(): void
}

function extractCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  return headers.getSetCookie?.() ?? []
}

/**
 * 安装 fetch 闸门。必须在任何业务请求之前调用。
 * - `redirect: 'error'`：后端若重定向到外部地址，直接失败而不是跟随；
 * - Cookie 存在内存里（Node 的 fetch 不自动维护 Cookie）。
 */
export function installLocalFetchGuard(): LocalFetchGuard {
  const realFetch = globalThis.fetch
  const requests: string[] = []
  const jar = new Map<string, string>()

  const buildCookieHeader = (): string =>
    [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')

  const guardedFetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const finalUrl = rewriteRequestUrl(rawUrl, API_BASE_URL, LOCAL_BASE_URL)
    // 发请求前的最后一道校验：非 loopback / 非 http(s) 直接抛错，绝不调用真实 fetch
    const url = assertLoopbackRequestUrl(finalUrl)
    requests.push(url.toString())

    const headers = new Headers(init.headers)
    headers.set('origin', LOCAL_TEST_ORIGIN)
    const cookie = buildCookieHeader()
    if (cookie !== '') headers.set('cookie', cookie)

    const response = await realFetch(finalUrl, { ...init, headers, redirect: 'error' })

    for (const raw of extractCookies(response)) {
      const [pair = ''] = raw.split(';')
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      const expired = /max-age\s*=\s*0/i.test(raw) || value === ''
      if (expired) jar.delete(name)
      else jar.set(name, value)
    }

    return response
  }

  globalThis.fetch = guardedFetch as typeof fetch

  return {
    requests,
    realFetch,
    uninstall() {
      globalThis.fetch = realFetch
    },
  }
}

type OkResult<T extends { ok: boolean }> = Extract<T, { ok: true }>

/**
 * 断言业务调用成功；失败时带上标签与服务端错误码，便于定位。
 * 只输出错误码与固定中文文案，不输出请求体、邀请码或 Cookie。
 */
export function must<T extends { ok: boolean }>(result: T, label: string): OkResult<T> {
  if (!result.ok) {
    const record = result as unknown as {
      code?: string
      message?: string
      error?: { code?: string; message?: string }
    }
    const code = record.code ?? record.error?.code ?? 'UNKNOWN'
    const message = record.message ?? record.error?.message ?? ''
    throw new Error(`[${label}] 失败：${code} ${message}`.trim())
  }
  return result as OkResult<T>
}

/** 直接对本地后端发请求；仍会经过 fetch 闸门（loopback 校验 + Cookie） */
export function localRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return globalThis.fetch(`${LOCAL_BASE_URL}${path}`, init)
}

/** 只读的环境信息，供测试输出/断言使用（不含凭据） */
export const LOCAL_TARGET_ORIGIN = target.state === 'ready' ? target.origin : ''
