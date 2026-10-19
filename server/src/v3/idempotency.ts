import { createHash } from 'node:crypto'
import type { V3Database } from './db.js'
import { V3Error } from './errors.js'

/**
 * 幂等记录
 * ----------------------------------------------------------------------------
 * 作用域：userId + idempotencyKey；保留 24 小时。
 *
 * 指纹 = 规范化 HTTP 方法 + 操作类别 + 资源目标 + 有效请求体。
 * 同一个 key 被用于不同操作或不同资源时，必须先返回 409 IDEMPOTENCY_CONFLICT，
 * 不能被当成上一次请求的重放。请求体中的密码、邀请码等敏感字段不参与哈希，
 * 需要业务层用慢哈希/常量时间比较单独验证。
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

const REDACTED_FIELDS = new Set([
  'password',
  'inviteCode',
  'cookie',
  'authorization',
  'sessionToken',
  'token',
])

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      if (REDACTED_FIELDS.has(key)) {
        out[key] = '[redacted]'
      } else {
        out[key] = canonicalize(record[key])
      }
    }
    return out
  }
  return value
}

export interface FingerprintInput {
  method: string
  operation: string
  resource: string
  body: unknown
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * 生成幂等指纹。
 *
 * `operation` 和 `resource` 由服务端路由固定提供，不读取客户端任意字段；
 * `resource` 通常是 projectId 或 projectId/entityId。
 */
export function requestFingerprint(input: FingerprintInput): string {
  const payload = {
    v: 2,
    method: normalizeToken(input.method),
    operation: normalizeToken(input.operation),
    resource: input.resource.trim(),
    body: canonicalize(input.body),
  }
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

interface IdempotencyRow {
  request_hash: string
  status_code: number
  response_json: string
  expires_at: string
}

export interface StoredResponse {
  statusCode: number
  body: Record<string, unknown>
}

export function lookupIdempotent(
  db: V3Database,
  userId: string,
  key: string,
  fingerprint: string,
  nowIso: string,
): StoredResponse | null {
  const row = db
    .prepare(
      'SELECT request_hash, status_code, response_json, expires_at FROM idempotency_records WHERE user_id = ? AND idempotency_key = ?',
    )
    .get(userId, key) as IdempotencyRow | undefined

  if (row === undefined) return null

  if (row.expires_at <= nowIso) {
    db.prepare('DELETE FROM idempotency_records WHERE user_id = ? AND idempotency_key = ?').run(
      userId,
      key,
    )
    return null
  }

  if (row.request_hash !== fingerprint) throw new V3Error('IDEMPOTENCY_CONFLICT')

  const parsed = JSON.parse(row.response_json) as unknown
  const body =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  if (typeof body.replayed === 'boolean') body.replayed = true
  return { statusCode: row.status_code, body }
}

export function saveIdempotent(
  db: V3Database,
  userId: string,
  key: string,
  fingerprint: string,
  statusCode: number,
  body: unknown,
  nowIso: string,
): void {
  const expiresAt = new Date(new Date(nowIso).getTime() + IDEMPOTENCY_TTL_MS).toISOString()
  db.prepare(
    `INSERT INTO idempotency_records
       (user_id, idempotency_key, request_hash, status_code, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, key, fingerprint, statusCode, JSON.stringify(body), nowIso, expiresAt)
}

/** 清理过期记录；写请求成功后顺带执行，不启动后台任务 */
export function pruneIdempotent(db: V3Database, nowIso: string): void {
  db.prepare('DELETE FROM idempotency_records WHERE expires_at <= ?').run(nowIso)
}
