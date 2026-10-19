import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import bcrypt from 'bcryptjs'
import type { V3Database } from './db.js'
import { V3_CONTRACT_VERSION, V3Error, invalidInput } from './errors.js'
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  clearSessionCookie,
  noteUserId,
  readJsonBody,
  readSessionToken,
  requireContractVersion,
  requireIdempotencyKey,
  requireRecord,
  requireRequestId,
  sendV3Json,
  setSessionCookie,
  bodyReadError,
} from './http.js'
import { hashInviteCode, type V3Runtime } from './runtime.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import { transaction } from './db.js'

/**
 * 账号与会话（docs/contracts.md 第 21 节）
 * ----------------------------------------------------------------------------
 * - 密码只保存 bcrypt 哈希（cost 12，兼容 bcrypt 要求）
 * - 会话令牌只保存 SHA-256 哈希；浏览器只拿到 HttpOnly Cookie
 * - 注册失败统一 REGISTER_REJECTED，登录失败统一 AUTH_FAILED
 */

export interface V3UserRow {
  user_id: string
  account: string
  display_name: string
  status: string
  revision: number
  created_at: string
  updated_at: string
}

export interface PublicUser {
  userId: string
  account: string
  displayName: string
  status: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface AuthContext {
  user: V3UserRow
  sessionId: string
  expiresAt: string
}

export function toPublicUser(row: V3UserRow): PublicUser {
  return {
    userId: row.user_id,
    account: row.account,
    displayName: row.display_name,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function tokenHash(token: string): string {
  return sha256Hex(token)
}

function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/* --------------------------------------------------------------- 输入校验 */

const ACCOUNT_PATTERN = /^[A-Za-z0-9_]{3,32}$/
const NUMERIC_ACCOUNT_PATTERN = /^\d{6,20}$/

export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase()
}

function readAccount(body: Record<string, unknown>): string {
  if (
    body.account !== undefined &&
    body.username !== undefined &&
    normalizeAccount(String(body.account)) !== normalizeAccount(String(body.username))
  ) {
    throw invalidInput('account 与 username 不一致')
  }
  const account = body.account ?? body.username
  if (typeof account !== 'string' || account.trim() === '') {
    throw invalidInput('account 为必填项')
  }
  const trimmed = account.trim()
  if (!ACCOUNT_PATTERN.test(trimmed) && !NUMERIC_ACCOUNT_PATTERN.test(trimmed)) {
    throw invalidInput('account 需为 3～32 位字母、数字或下划线')
  }
  return trimmed
}

function readPassword(body: Record<string, unknown>): string {
  const password = body.password
  if (typeof password !== 'string') throw invalidInput('password 为必填项')
  const characters = [...password].length
  if (characters < 8 || characters > 64 || Buffer.byteLength(password, 'utf8') > 72) {
    throw invalidInput('password 需为 8～64 个字符')
  }
  return password
}

function readDisplayName(body: Record<string, unknown>): string {
  const value = body.displayName
  if (typeof value !== 'string') throw invalidInput('displayName 为必填项')
  const trimmed = value.trim()
  if (trimmed === '' || [...trimmed].length > 30) {
    throw invalidInput('displayName 需为 1～30 个字')
  }
  return trimmed
}

function readInviteCode(body: Record<string, unknown>): string {
  const value = body.inviteCode
  if (typeof value !== 'string' || value.length < 8 || value.length > 64) {
    throw invalidInput('inviteCode 需为 8～64 个字符')
  }
  return value
}

function inviteCodeAccepted(runtime: V3Runtime, code: string): boolean {
  const candidate = Buffer.from(hashInviteCode(code), 'hex')
  let matched = false
  for (const hash of runtime.inviteCodeHashes) {
    if (!/^[0-9a-f]{64}$/.test(hash)) continue
    const expected = Buffer.from(hash, 'hex')
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true
  }
  return matched
}

/* ------------------------------------------------------------------- 会话 */

interface SessionJoinRow extends V3UserRow {
  session_id: string
  expires_at: string
}

export function createSession(
  db: V3Database,
  userId: string,
  now: Date,
  runtime: V3Runtime,
  rotatedFromSessionId: string | null = null,
): { token: string; sessionId: string; expiresAt: string } {
  const token = newSessionToken()
  const sessionId = newId('ses', now.getTime())
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + runtime.sessionTtlMs).toISOString()

  db.prepare(
    `INSERT INTO sessions
       (session_id, user_id, token_hash, status, created_at, last_seen_at, expires_at, revoked_at, rotated_from_session_id)
     VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, ?)`,
  ).run(sessionId, userId, tokenHash(token), createdAt, createdAt, expiresAt, rotatedFromSessionId)

  return { token, sessionId, expiresAt }
}

export function resolveSession(
  db: V3Database,
  req: IncomingMessage,
  now: Date,
): AuthContext | null {
  const token = readSessionToken(req)
  if (token === null) return null

  const row = db
    .prepare(
      `SELECT s.session_id, s.expires_at, u.user_id, u.account, u.display_name, u.status,
              u.revision, u.created_at, u.updated_at
         FROM sessions s
         JOIN users u ON u.user_id = s.user_id
        WHERE s.token_hash = ?
          AND s.status = 'active'
          AND s.revoked_at IS NULL`,
    )
    .get(tokenHash(token)) as SessionJoinRow | undefined

  if (row === undefined) return null
  if (row.expires_at <= now.toISOString()) {
    db.prepare("UPDATE sessions SET status = 'expired' WHERE session_id = ? AND status = 'active'").run(
      row.session_id,
    )
    return null
  }
  if (row.status !== 'active') {
    db.prepare("UPDATE sessions SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'").run(
      now.toISOString(),
      row.user_id,
    )
    return null
  }

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?').run(
    now.toISOString(),
    row.session_id,
  )

  return {
    user: {
      user_id: row.user_id,
      account: row.account,
      display_name: row.display_name,
      status: row.status,
      revision: row.revision,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    sessionId: row.session_id,
    expiresAt: row.expires_at,
  }
}

export function requireAuth(
  db: V3Database,
  req: IncomingMessage,
  now: Date,
): AuthContext {
  const auth = resolveSession(db, req, now)
  if (auth === null) throw new V3Error('UNAUTHORIZED')
  noteUserId(req, auth.user.user_id)
  return auth
}

export function revokeSessionByToken(db: V3Database, token: string | null, now: Date): void {
  if (token === null) return
  db.prepare(
    "UPDATE sessions SET status = 'revoked', revoked_at = ? WHERE token_hash = ? AND status = 'active'",
  ).run(now.toISOString(), tokenHash(token))
}

/* --------------------------------------------------------------- 会话事务 */

/**
 * 撤销当前请求携带的旧会话并创建新会话。
 * 必须在调用方事务内执行：旧会话撤销与新会话写入同成败。
 */
function rotateAndCreateSession(
  db: V3Database,
  runtime: V3Runtime,
  userId: string,
  now: Date,
  nowText: string,
  req: IncomingMessage,
): { token: string; sessionId: string; expiresAt: string } {
  const oldToken = readSessionToken(req)
  let rotatedFrom: string | null = null
  if (oldToken !== null) {
    const oldSession = db
      .prepare('SELECT session_id FROM sessions WHERE token_hash = ? AND status = ?')
      .get(tokenHash(oldToken), 'active') as { session_id: string } | undefined
    if (oldSession !== undefined) {
      rotatedFrom = oldSession.session_id
      db.prepare(
        "UPDATE sessions SET status = 'revoked', revoked_at = ? WHERE session_id = ? AND status = 'active'",
      ).run(nowText, oldSession.session_id)
    }
  }
  return createSession(db, userId, now, runtime, rotatedFrom)
}

/* ----------------------------------------------------------------- 路由 */

function readSessionTokenFromRequest(req: IncomingMessage): string | null {
  return readSessionToken(req)
}

async function readBody(req: IncomingMessage, requestId: string | null = null): Promise<Record<string, unknown>> {
  try {
    const parsed = await readJsonBody(req, 256 * 1024)
    return requireRecord(parsed)
  } catch (error) {
    throw bodyReadError(error, requestId)
  }
}

export async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
): Promise<void> {
  const body = await readBody(req)
  requireContractVersion(body)
  const requestId = requireRequestId(body)
  const idempotencyKey = requireIdempotencyKey(body)
  const account = readAccount(body)
  const password = readPassword(body)
  const displayName = readDisplayName(body)
  const inviteCode = readInviteCode(body)

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const accountNormalized = normalizeAccount(account)
  const scope = `anon:${accountNormalized}`
  // 密码和邀请码不进入快速哈希；恢复登录时用 bcrypt/邀请码哈希单独验证。
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: 'auth.register',
    resource: accountNormalized,
    body: { account: accountNormalized, displayName },
  })

  const replay = lookupIdempotent(db, scope, idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    await recoverRegistration({
      req,
      res,
      runtime,
      requestId,
      accountNormalized,
      password,
      inviteCode,
      now,
      nowText,
    })
    return
  }

  const ip = runtime.clientIp(req)
  runtime.authLimiter.reserve(ip, accountNormalized, now.getTime())

  const inviteOk = inviteCodeAccepted(runtime, inviteCode)
  const existing = findUserByAccount(db, accountNormalized)
  if (!inviteOk || existing !== undefined) throw new V3Error('REGISTER_REJECTED')

  const passwordHash = await bcrypt.hash(password, runtime.passwordRounds)
  const userId = newId('usr', now.getTime())

  const result = transaction(db, () => {
    const duplicate = db
      .prepare('SELECT user_id FROM users WHERE account_normalized = ?')
      .get(accountNormalized) as { user_id: string } | undefined
    if (duplicate !== undefined) throw new V3Error('REGISTER_REJECTED')

    db.prepare(
      `INSERT INTO users
         (user_id, account, account_normalized, display_name, password_hash, password_algo,
          status, role, revision, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, 'bcrypt', 'active', 'student', 1, ?, ?, NULL)`,
    ).run(userId, account, accountNormalized, displayName, passwordHash, nowText, nowText)

    const session = createSession(db, userId, now, runtime)
    const response = {
      contractVersion: V3_CONTRACT_VERSION,
      requestId,
      user: {
        userId,
        account,
        displayName,
        status: 'active',
        revision: 1,
        createdAt: nowText,
        updatedAt: nowText,
      },
      sessionExpiresAt: session.expiresAt,
      replayed: false,
    }
    saveIdempotent(db, scope, idempotencyKey, fingerprint, 200, response, nowText)
    return { session, response }
  })

  runtime.authLimiter.resetAccount(ip, accountNormalized)
  noteUserId(req, userId)
  setSessionCookie(res, result.session.token, runtime.secureCookies, SESSION_MAX_AGE_SECONDS)
  sendV3Json(res, 200, result.response)
}

interface RegisterRecoveryInput {
  req: IncomingMessage
  res: ServerResponse
  runtime: V3Runtime
  requestId: string
  accountNormalized: string
  password: string
  inviteCode: string
  now: Date
  nowText: string
}

/**
 * 首次注册响应丢失后的恢复：
 * - 必须重新校验密码（bcrypt）和邀请码；
 * - 不能仅凭 account + idempotencyKey 签发会话；
 * - 新会话与旧会话轮换在同一事务中完成。
 */
async function recoverRegistration(input: RegisterRecoveryInput): Promise<void> {
  const { req, res, runtime, requestId, accountNormalized, password, inviteCode, now, nowText } = input
  const db = runtime.getDb()
  const ip = runtime.clientIp(req)
  runtime.authLimiter.reserve(ip, accountNormalized, now.getTime())

  const row = findUserByAccount(db, accountNormalized)
  if (row === undefined || row.status !== 'active') throw new V3Error('REGISTER_REJECTED')

  const inviteOk = inviteCodeAccepted(runtime, inviteCode)
  let verified = false
  try {
    verified = await bcrypt.compare(password, row.password_hash)
  } catch {
    verified = false
  }
  if (!inviteOk || !verified) throw new V3Error('REGISTER_REJECTED')

  const session = transaction(db, () => {
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?').run(
      nowText,
      nowText,
      row.user_id,
    )
    return rotateAndCreateSession(db, runtime, row.user_id, now, nowText, req)
  })

  runtime.authLimiter.resetAccount(ip, accountNormalized)
  noteUserId(req, row.user_id)
  setSessionCookie(res, session.token, runtime.secureCookies, SESSION_MAX_AGE_SECONDS)
  sendV3Json(res, 200, {
    contractVersion: V3_CONTRACT_VERSION,
    requestId,
    user: toPublicUser({ ...row, updated_at: nowText }),
    sessionExpiresAt: session.expiresAt,
    replayed: true,
    recovered: true,
  })
}

interface UserWithPassword extends V3UserRow {
  password_hash: string
}

function findUserByAccount(
  db: V3Database,
  accountNormalized: string,
): UserWithPassword | undefined {
  return db
    .prepare(
      `SELECT user_id, account, display_name, password_hash, status, revision, created_at, updated_at
         FROM users WHERE account_normalized = ?`,
    )
    .get(accountNormalized) as UserWithPassword | undefined
}

export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
): Promise<void> {
  const body = await readBody(req)
  requireContractVersion(body)
  requireRequestId(body)
  const account = readAccount(body)
  const password = readPassword(body)
  const accountNormalized = normalizeAccount(account)

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const ip = runtime.clientIp(req)

  // 在 bcrypt 之前预占预算：并发请求也会计入同一窗口
  runtime.authLimiter.reserve(ip, accountNormalized, now.getTime())

  const row = findUserByAccount(db, accountNormalized)

  // 账号不存在时也执行一次哈希比较，避免通过耗时枚举账号
  const hash =
    row?.password_hash ?? '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW'
  let verified = false
  try {
    verified = await bcrypt.compare(password, hash)
  } catch {
    verified = false
  }

  if (row === undefined || !verified || row.status !== 'active') {
    throw new V3Error('AUTH_FAILED')
  }

  // 旧会话撤销与新会话创建同事务；任何一步失败都不会留下“只撤销旧会话”的状态。
  const session = transaction(db, () => {
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?').run(
      nowText,
      nowText,
      row.user_id,
    )
    return rotateAndCreateSession(db, runtime, row.user_id, now, nowText, req)
  })

  runtime.authLimiter.resetAccount(ip, accountNormalized)
  noteUserId(req, row.user_id)
  setSessionCookie(res, session.token, runtime.secureCookies, SESSION_MAX_AGE_SECONDS)

  sendV3Json(res, 200, {
    contractVersion: V3_CONTRACT_VERSION,
    requestId: requireRequestId(body),
    user: toPublicUser({ ...row, updated_at: nowText }),
    sessionExpiresAt: session.expiresAt,
  })
}

export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
): Promise<void> {
  const body = await readBody(req)
  requireContractVersion(body)
  const requestId = requireRequestId(body)
  const db = runtime.getDb()
  const now = runtime.now()

  transaction(db, () => {
    revokeSessionByToken(db, readSessionTokenFromRequest(req), now)
  })
  clearSessionCookie(res, runtime.secureCookies)

  sendV3Json(res, 200, {
    contractVersion: V3_CONTRACT_VERSION,
    requestId,
    loggedOut: true,
  })
}

export function handleMe(req: IncomingMessage, res: ServerResponse, runtime: V3Runtime): void {
  const db = runtime.getDb()
  const auth = requireAuth(db, req, runtime.now())
  sendV3Json(res, 200, {
    contractVersion: V3_CONTRACT_VERSION,
    requestId: null,
    user: toPublicUser(auth.user),
    sessionExpiresAt: auth.expiresAt,
  })
}

export { SESSION_COOKIE }
