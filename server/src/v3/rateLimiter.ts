import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { V3Error } from './errors.js'

/**
 * 登录/注册限流
 * ----------------------------------------------------------------------------
 * 反代规则：
 * - 默认只使用 TCP socket 地址（`req.socket.remoteAddress`），不信任 X-Forwarded-For；
 * - 只有显式配置 `SCP_TRUST_PROXY_HOPS` / `trustProxyHops` 时，才从 XFF 右侧数第 N 跳取地址；
 * - XFF 中每段都必须是合法 IP，否则回退 socket 地址；
 * - 不在代码中修改任何代理配置。
 *
 * 预算在昂贵 bcrypt 之前预占；并发请求共享同一计数器。
 */

export interface AuthRateLimitOptions {
  /** 单 IP + 单账号窗口内最大尝试次数 */
  maxAccountAttempts?: number
  /** 单 IP 窗口内最大尝试次数（防换账号喷） */
  maxIpAttempts?: number
  /** 固定窗口长度 */
  windowMs?: number
  /** 内存记录上限，超出后先清过期、再淘汰最旧 */
  maxEntries?: number
}

export const DEFAULT_AUTH_RATE_LIMIT = {
  maxAccountAttempts: 5,
  maxIpAttempts: 50,
  windowMs: 15 * 60 * 1000,
  maxEntries: 10_000,
} as const

interface Entry {
  count: number
  windowStart: number
  lastSeen: number
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return fallback
  return value
}

export class AuthRateLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly maxAccountAttempts: number
  private readonly maxIpAttempts: number
  private readonly windowMs: number
  private readonly maxEntries: number
  private reservationsSinceSweep = 0

  constructor(options: AuthRateLimitOptions = {}) {
    this.maxAccountAttempts = positiveInteger(
      options.maxAccountAttempts,
      DEFAULT_AUTH_RATE_LIMIT.maxAccountAttempts,
    )
    this.maxIpAttempts = positiveInteger(options.maxIpAttempts, DEFAULT_AUTH_RATE_LIMIT.maxIpAttempts)
    this.windowMs = positiveInteger(options.windowMs, DEFAULT_AUTH_RATE_LIMIT.windowMs)
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_AUTH_RATE_LIMIT.maxEntries)
  }

  get size(): number {
    return this.entries.size
  }

  /** 在 bcrypt 前预占预算；超限抛 429 */
  reserve(ip: string, account: string, nowMs: number): void {
    this.sweepIfNeeded(nowMs)

    const accountKey = this.accountKey(ip, account)
    const ipKey = this.ipKey(ip)
    const accountCheck = this.inspect(accountKey, nowMs, this.maxAccountAttempts)
    if (accountCheck !== null) throw accountCheck
    const ipCheck = this.inspect(ipKey, nowMs, this.maxIpAttempts)
    if (ipCheck !== null) throw ipCheck

    this.hit(accountKey, nowMs)
    this.hit(ipKey, nowMs)
    this.enforceCapacity(nowMs)
  }

  /** 登录成功后只清账号预算；IP 预算保留，避免通过成功登录重置喷号额度 */
  resetAccount(ip: string, account: string): void {
    this.entries.delete(this.accountKey(ip, account))
  }

  /** 测试与诊断：不返回任何凭据 */
  stats(): { size: number; keys: number } {
    return { size: this.entries.size, keys: this.entries.size }
  }

  private accountKey(ip: string, account: string): string {
    return `a|${ip}|${account}`
  }

  private ipKey(ip: string): string {
    return `i|${ip}`
  }

  private inspect(key: string, nowMs: number, max: number): V3Error | null {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    if (nowMs - entry.windowStart >= this.windowMs) {
      this.entries.delete(key)
      return null
    }
    if (entry.count >= max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.windowStart + this.windowMs - nowMs) / 1000),
      )
      return new V3Error('RATE_LIMITED', { retryAfterSeconds })
    }
    return null
  }

  private hit(key: string, nowMs: number): void {
    const entry = this.entries.get(key)
    if (entry === undefined || nowMs - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { count: 1, windowStart: nowMs, lastSeen: nowMs })
    } else {
      entry.count += 1
      entry.lastSeen = nowMs
    }
    this.reservationsSinceSweep += 1
  }

  private sweepIfNeeded(nowMs: number): void {
    if (this.reservationsSinceSweep < 64 && this.entries.size <= this.maxEntries) return
    this.reservationsSinceSweep = 0
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.windowStart >= this.windowMs) this.entries.delete(key)
    }
  }

  private enforceCapacity(nowMs: number): void {
    if (this.reservationsSinceSweep < 64 && this.entries.size <= this.maxEntries) return
    this.reservationsSinceSweep = 0
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.windowStart >= this.windowMs) this.entries.delete(key)
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
  }
}

function normalizeIp(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  return isIP(trimmed) === 0 ? null : trimmed
}

/**
 * 解析客户端地址。默认不信任 X-Forwarded-For。
 * trustProxyHops = 1 表示前面只有一层可信反代；取 XFF 从右数第 1 个合法地址。
 */
export function resolveClientIp(req: IncomingMessage, trustProxyHops: number): string {
  const socketAddress = normalizeIp(req.socket.remoteAddress ?? '') ?? 'unknown'
  if (!Number.isInteger(trustProxyHops) || trustProxyHops <= 0) return socketAddress

  const raw = req.headers['x-forwarded-for']
  const header = Array.isArray(raw) ? raw.join(',') : raw
  if (header === undefined || header.trim() === '') return socketAddress

  const parts = header
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((part): part is string => part !== null)
  if (parts.length < trustProxyHops) return socketAddress
  return parts[parts.length - trustProxyHops] as string
}

export function resolveTrustProxyHops(value: number | undefined, env: NodeJS.ProcessEnv): number {
  const raw = value ?? Number(env.SCP_TRUST_PROXY_HOPS ?? 0)
  if (!Number.isInteger(raw) || raw < 0 || raw > 5) return 0
  return raw
}
