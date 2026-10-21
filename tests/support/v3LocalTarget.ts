/**
 * 本地 V3 后端集成测试的目标地址策略
 * ----------------------------------------------------------------------------
 * 只用 `V3_LOCAL_API_BASE_URL` 选择后端，且只允许 loopback 地址：
 *   - 协议：http / https
 *   - 主机：localhost、127.0.0.0/8、::1
 * 其他地址一律在**发请求之前**拒绝，避免测试误连生产域名或内网主机。
 *
 * 这里只放纯函数，便于在普通单测里覆盖（不产生任何网络请求）。
 */

/** 允许的主机名：localhost、IPv4 loopback 段、IPv6 loopback */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (normalized === 'localhost') return true
  if (normalized === '[::1]' || normalized === '::1') return true
  // 127.0.0.0/8 整段都是 loopback；限制取值 0~255 避免奇怪主机名被放过
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized)
  if (ipv4 === null) return false
  const octets = ipv4.slice(1).map((part) => Number(part))
  if (octets.some((octet) => octet > 255)) return false
  return octets[0] === 127
}

export type LocalTargetResolution =
  | { state: 'unconfigured'; reason: string }
  | { state: 'invalid'; reason: string }
  | { state: 'ready'; baseUrl: string; origin: string }

/**
 * 解析 `V3_LOCAL_API_BASE_URL`。
 * 未设置 → unconfigured（调用方应跳过用例）；设置但不合规 → invalid（调用方应直接失败）。
 */
export function resolveLocalTarget(raw: string | undefined | null): LocalTargetResolution {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') {
    return {
      state: 'unconfigured',
      reason: '未设置 V3_LOCAL_API_BASE_URL（本地 V3 后端地址，例如 http://127.0.0.1:8099）',
    }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { state: 'invalid', reason: 'V3_LOCAL_API_BASE_URL 不是合法的绝对 URL' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      state: 'invalid',
      reason: `不支持的协议 ${url.protocol}，只允许 http/https`,
    }
  }
  if (url.username !== '' || url.password !== '') {
    return { state: 'invalid', reason: '地址中不允许携带用户名或密码' }
  }
  if (!isLoopbackHostname(url.hostname)) {
    return {
      state: 'invalid',
      reason: `只允许 loopback 地址（localhost / 127.0.0.1 / ::1），实际为 ${url.hostname}`,
    }
  }
  if (/\/api\/?$/.test(url.pathname)) {
    return {
      state: 'invalid',
      reason: 'V3_LOCAL_API_BASE_URL 不应包含 /api 后缀（契约要求路径由调用方补全）',
    }
  }

  return { state: 'ready', baseUrl: value.replace(/\/+$/, ''), origin: url.origin }
}

/**
 * 发请求前的最后一道闸门：解析并校验真实要访问的地址。
 * 不打印完整地址（可能带查询参数），只回显主机名与协议。
 */
export function assertLoopbackRequestUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('本地集成测试拒绝访问：请求地址不是合法的绝对 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`本地集成测试拒绝访问：不支持的协议 ${url.protocol}`)
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(
      `本地集成测试拒绝访问非 loopback 主机 ${url.hostname}（只允许 localhost / 127.0.0.1 / ::1）`,
    )
  }
  return url
}

/**
 * 把客户端解析出的基地址改写到 loopback 目标。
 * 客户端基地址来自 `VITE_API_BASE_URL`（默认 127.0.0.1:8080），
 * 但集成测试不依赖、也不设置它：所有请求在这里统一落到 V3_LOCAL_API_BASE_URL。
 */
export function rewriteRequestUrl(
  requestUrl: string,
  clientBaseUrl: string,
  targetBaseUrl: string,
): string {
  const client = clientBaseUrl.replace(/\/+$/, '')
  if (requestUrl === client) return targetBaseUrl
  if (requestUrl.startsWith(`${client}/`)) {
    return `${targetBaseUrl}${requestUrl.slice(client.length)}`
  }
  return requestUrl
}
