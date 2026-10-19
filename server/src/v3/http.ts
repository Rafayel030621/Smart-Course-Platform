import type { IncomingMessage, ServerResponse } from 'node:http'
import { V3_CONTRACT_VERSION, V3Error, invalidInput, toFailureBody, type V3ErrorCode } from './errors.js'

/**
 * V3 HTTP 基础设施
 * ----------------------------------------------------------------------------
 * - JSON 请求体读取与上限
 * - Cookie 解析 / 会话 Cookie 写入
 * - Origin 白名单与 CORS（禁止 `*`，允许 credentials）
 * - 统一成功 / 失败信封
 * - 写请求信封字段校验
 */

export const SESSION_COOKIE = 'scp_session'
export const SESSION_MAX_AGE_SECONDS = 604_800
export const JSON_BODY_LIMIT = 256 * 1024
export const MIGRATION_BODY_LIMIT = 8 * 1024 * 1024

export const DEFAULT_ALLOWED_ORIGINS = [
  'https://course.xinxian-music.xyz',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const

export interface RequestContext {
  requestId: string | null
  projectId: string | null
}

/** 请求级安全日志上下文：只保存 requestId 与 userId，不保存请求体 */
const requestIds = new WeakMap<IncomingMessage, string>()
const requestUserIds = new WeakMap<IncomingMessage, string>()

export function noteRequestId(req: IncomingMessage, requestId: string): void {
  requestIds.set(req, requestId)
}

export function getRecordedRequestId(req: IncomingMessage): string | null {
  return requestIds.get(req) ?? null
}

export function noteUserId(req: IncomingMessage, userId: string): void {
  requestUserIds.set(req, userId)
}

export function getRecordedUserId(req: IncomingMessage): string | null {
  return requestUserIds.get(req) ?? null
}

class BodyTooLargeError extends Error {
  readonly limit: number
  constructor(limit: number) {
    super('body too large')
    this.limit = limit
  }
}

class InvalidJsonError extends Error {}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        overflow = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) reject(new BodyTooLargeError(maxBytes))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error: Error) => reject(error))
  })

  if (text.trim() === '') throw new InvalidJsonError()
  try {
    const parsed = JSON.parse(text) as unknown
    if (isRecord(parsed) && typeof parsed.requestId === 'string') {
      noteRequestId(req, parsed.requestId)
    }
    return parsed
  } catch {
    throw new InvalidJsonError()
  }
}

export function bodyReadError(error: unknown, _requestId: string | null = null): V3Error {
  if (error instanceof BodyTooLargeError) {
    if (error.limit >= MIGRATION_BODY_LIMIT) return new V3Error('MIGRATION_TOO_LARGE')
    return invalidInput('请求体超过上限')
  }
  if (error instanceof InvalidJsonError) return invalidInput('请求体必须是合法 JSON 对象')
  if (error instanceof V3Error) return error
  return new V3Error('INTERNAL')
}

export function requireJsonContentType(req: IncomingMessage): void {
  const raw = req.headers['content-type']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || !value.toLowerCase().includes('application/json')) {
    throw invalidInput('Content-Type 必须为 application/json')
  }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie
  if (header === undefined || header === '') return {}
  const result: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name === '') continue
    try {
      result[name] = decodeURIComponent(value)
    } catch {
      result[name] = value
    }
  }
  return result
}

export function readSessionToken(req: IncomingMessage): string | null {
  const token = parseCookies(req)[SESSION_COOKIE]
  return token === undefined || token === '' ? null : token
}

export function setSessionCookie(
  res: ServerResponse,
  token: string,
  secure: boolean,
  maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS,
): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export interface CorsResult {
  /** OPTIONS 已经处理完，调用方直接返回 */
  handled: boolean
}

function originAllowed(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(origin)
}

function applyCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id')
  res.setHeader('Access-Control-Max-Age', '600')
}

function secFetchSiteAllowsWrite(req: IncomingMessage): boolean {
  const raw = req.headers['sec-fetch-site']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === '') return true
  return value === 'same-origin' || value === 'same-site'
}

/**
 * 处理 V3 路径的 CORS 与写请求 Origin 校验。
 * - 预检：只允许白名单，204；否则 403
 * - 写请求：Origin 缺失/不在白名单 → 403 FORBIDDEN_ORIGIN
 * - 读请求：Origin 合法时回显 CORS 头；非法时不回显，但业务仍可读（不带 Cookie 的跨站读取拿不到数据）
 */
export function handleV3Cors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: readonly string[],
): CorsResult {
  const origin = req.headers.origin
  const method = req.method ?? 'GET'
  const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'

  if (method === 'OPTIONS') {
    if (origin === undefined || !originAllowed(origin, allowedOrigins)) {
      sendV3Json(res, 403, errorBody(new V3Error('FORBIDDEN_ORIGIN'), null, null))
      return { handled: true }
    }
    applyCorsHeaders(res, origin)
    res.writeHead(204, { 'content-length': '0', 'cache-control': 'no-store' })
    res.end()
    return { handled: true }
  }

  if (origin !== undefined && originAllowed(origin, allowedOrigins)) {
    applyCorsHeaders(res, origin)
  }

  if (isWrite) {
    if (origin === undefined || !originAllowed(origin, allowedOrigins) || !secFetchSiteAllowsWrite(req)) {
      throw new V3Error('FORBIDDEN_ORIGIN')
    }
  }

  return { handled: false }
}

export function sendV3Json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(payload)
}

export interface V3SuccessBody {
  contractVersion: string
  requestId: string | null
  projectId: string | null
  [key: string]: unknown
}

export function successBody(
  requestId: string | null,
  projectId: string | null,
  fields: Record<string, unknown>,
): V3SuccessBody {
  return {
    contractVersion: V3_CONTRACT_VERSION,
    requestId,
    projectId,
    ...fields,
  }
}

export function errorBody(
  error: V3Error,
  requestId: string | null,
  projectId: string | null,
): ReturnType<typeof toFailureBody> {
  return toFailureBody(error, requestId, projectId)
}

/* --------------------------------------------------------------- 信封校验 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,64}$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireRecord(value: unknown, detail = '请求体必须是 JSON 对象'): Record<string, unknown> {
  if (!isRecord(value)) throw invalidInput(detail)
  return value
}

export function requireContractVersion(body: Record<string, unknown>): void {
  if (body.contractVersion !== V3_CONTRACT_VERSION) {
    throw new V3Error('CONTRACT_VERSION_MISMATCH')
  }
}

export function requireRequestId(body: Record<string, unknown>): string {
  const value = body.requestId
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw invalidInput('requestId 必须是 UUID v4')
  }
  return value
}

export function requireIdempotencyKey(body: Record<string, unknown>): string {
  const value = body.idempotencyKey
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw invalidInput('idempotencyKey 必须是 8～64 个可打印字符')
  }
  return value
}

export function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidInput(`${field} 必须是 ≥ 1 的整数`)
  }
  return value
}

export interface WriteEnvelope {
  requestId: string
  idempotencyKey: string
  projectId: string
  projectRevision: number
  expectedRevision: number | null
}

export function requireWriteEnvelope(
  body: Record<string, unknown>,
  pathProjectId: string,
): WriteEnvelope {
  requireContractVersion(body)
  const requestId = requireRequestId(body)
  const idempotencyKey = requireIdempotencyKey(body)
  if (body.projectId !== pathProjectId) throw invalidInput('projectId 与路径不一致')
  const projectRevision = requirePositiveInteger(body.projectRevision, 'projectRevision')
  const expectedRevision =
    body.expectedRevision === undefined || body.expectedRevision === null
      ? null
      : requirePositiveInteger(body.expectedRevision, 'expectedRevision')
  return { requestId, idempotencyKey, projectId: pathProjectId, projectRevision, expectedRevision }
}

export function requireExpectedRevision(envelope: WriteEnvelope): number {
  if (envelope.expectedRevision === null) throw invalidInput('expectedRevision 为必填项')
  return envelope.expectedRevision
}

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw invalidInput('布尔参数取值不合法')
}

export function parseLimit(raw: string | null, fallback = 50, max = 100): number {
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw invalidInput('limit 取值范围不合法')
  }
  return value
}

export function queryParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)
  return value === null || value === '' ? null : value
}

export function logCategoryFor(method: string, pathname: string): string {
  const parts = pathname.split('/').filter((part) => part !== '')
  const resource = parts[1] ?? 'root'
  const action = parts[2] ?? ''
  if (resource === 'auth') return `auth.${action}`
  if (resource === 'projects' && action === 'migrations') return 'migration.status'
  if (resource === 'projects' && action === 'migrate-local') return 'migration.create'
  if (resource === 'projects') {
    const section = parts[3] ?? 'project'
    return `project.${section}.${method.toLowerCase()}`
  }
  return 'other'
}

/** 判断错误是否 SQLite 唯一约束冲突 */
export function isSqliteUniqueError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  )
}

/** 供路由层区分“业务错误”和“未捕获异常” */
export function isV3Error(error: unknown): error is V3Error {
  return error instanceof V3Error
}

export type { V3ErrorCode }
