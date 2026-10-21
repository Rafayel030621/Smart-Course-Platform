/**
 * V3 账号接口（契约 21）。
 *
 * 会话完全依赖 HttpOnly Cookie：
 * - 请求必须 `credentials: 'include'`；
 * - 前端不读取 Cookie，也不把令牌写入 localStorage/sessionStorage；
 * - 401 与网络失败必须区分，网络失败不能伪装成“未登录”。
 */
import {
  asNumber,
  asRecord,
  asString,
  makeV3Error,
  newRequestId,
  requestV3Raw,
  type V3ApiError,
  type V3Result,
} from './v3Http'
import type { V3User } from '@/types/platform'

export interface AuthSession {
  user: V3User
  sessionExpiresAt: string
}

export interface AuthApiOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function parseUser(value: unknown): V3User | null {
  const record = asRecord(value)
  if (record === null) return null
  const userId = asString(record['userId'])
  const account = asString(record['account'])
  const displayName = asString(record['displayName'])
  const status = asString(record['status'])
  const revision = asNumber(record['revision'])
  const createdAt = asString(record['createdAt'])
  const updatedAt = asString(record['updatedAt'])
  if (
    userId === null ||
    account === null ||
    displayName === null ||
    (status !== 'active' && status !== 'disabled') ||
    revision === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null
  }
  return { userId, account, displayName, status, revision, createdAt, updatedAt }
}

function parseAuthSession(value: unknown): AuthSession | null {
  const record = asRecord(value)
  if (record === null) return null
  const user = parseUser(record['user'])
  const sessionExpiresAt = asString(record['sessionExpiresAt'])
  if (user === null || sessionExpiresAt === null) return null
  return { user, sessionExpiresAt }
}

function authFailure(error: V3ApiError): { ok: false; error: V3ApiError } {
  return { ok: false, error }
}

/**
 * GET /api/auth/me
 * 200 → 已登录；401 → 未登录/会话过期；网络失败 → NETWORK_ERROR（不是未登录）。
 */
export async function fetchCurrentUser(
  options: AuthApiOptions = {},
): Promise<V3Result<AuthSession>> {
  const raw = await requestV3Raw('/api/auth/me', {
    method: 'GET',
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  if (!raw.ok) {
    return authFailure(raw.error)
  }

  const session = parseAuthSession(raw.body)
  if (session === null) {
    return {
      ok: false,
      error: makeV3Error('INVALID_RESPONSE', { status: raw.status, retryable: false }),
    }
  }

  return {
    ok: true,
    data: session,
    requestId: '',
    projectId: null,
    projectRevision: null,
    replayed: false,
    changed: null,
  }
}

/** POST /api/auth/login（不实现 UI；仅供 store 的 login action 使用） */
export async function loginAccount(
  account: string,
  password: string,
  options: AuthApiOptions = {},
): Promise<V3Result<AuthSession>> {
  const requestId = newRequestId()
  const raw = await requestV3Raw('/api/auth/login', {
    method: 'POST',
    body: {
      contractVersion: '3.0',
      requestId,
      account,
      password,
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  if (!raw.ok) return authFailure(raw.error)

  const record = asRecord(raw.body)
  if (record === null || record['requestId'] !== requestId) {
    return {
      ok: false,
      error: makeV3Error('INVALID_RESPONSE', { status: raw.status, retryable: false }),
    }
  }
  const session = parseAuthSession(record)
  if (session === null) {
    return {
      ok: false,
      error: makeV3Error('INVALID_RESPONSE', { status: raw.status, retryable: false }),
    }
  }

  return {
    ok: true,
    data: session,
    requestId,
    projectId: null,
    projectRevision: null,
    replayed: record['replayed'] === true,
    changed: null,
  }
}

/**
 * POST /api/auth/logout
 * 即使网络失败，调用方也应清理内存会话；但必须把失败如实返回给 UI。
 */
export async function logoutAccount(options: AuthApiOptions = {}): Promise<V3Result<{ loggedOut: true }>> {
  const requestId = newRequestId()
  const raw = await requestV3Raw('/api/auth/logout', {
    method: 'POST',
    body: { contractVersion: '3.0', requestId },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  if (!raw.ok) return authFailure(raw.error)

  const record = asRecord(raw.body)
  if (record === null || record['loggedOut'] !== true) {
    return {
      ok: false,
      error: makeV3Error('INVALID_RESPONSE', { status: raw.status, retryable: false }),
    }
  }
  if (record['requestId'] !== undefined && record['requestId'] !== requestId) {
    return {
      ok: false,
      error: makeV3Error('INVALID_RESPONSE', { status: raw.status, retryable: false }),
    }
  }

  return {
    ok: true,
    data: { loggedOut: true },
    requestId,
    projectId: null,
    projectRevision: null,
    replayed: false,
    changed: null,
  }
}

/** 判断是否属于“未登录/会话过期”，供 store 清理内存态 */
export function isUnauthorized(error: V3ApiError): boolean {
  return error.code === 'UNAUTHORIZED'
}
