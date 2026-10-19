import { createHash } from 'node:crypto'
import type { V3Database } from './db.js'
import { defaultDatabasePath, openV3Database } from './db.js'
import { DEFAULT_ALLOWED_ORIGINS } from './http.js'
import { createV3ConsoleLogger, silentV3Logger, type V3Logger } from './logger.js'

/**
 * V3 运行时
 * ----------------------------------------------------------------------------
 * 数据库延迟打开：现有 V2 测试和部署只访问 V2 接口时不会创建任何数据库文件。
 * 首次访问 V3 接口时才建库并执行迁移。
 */

export interface V3RuntimeOptions {
  /** 数据库文件；测试传临时文件或 ':memory:' */
  databasePath?: string
  /** CORS 白名单；默认生产域名 + 本地开发 */
  allowedOrigins?: readonly string[]
  /** Cookie 是否带 Secure；默认 true，本地 http 开发可设 SCP_COOKIE_SECURE=0 */
  secureCookies?: boolean
  /** 邀请码 SHA-256 十六进制列表；也可用 INVITE_CODE_SHA256 / INVITE_CODE 环境变量 */
  inviteCodeHashes?: readonly string[]
  /** 会话绝对过期，默认 7 天 */
  sessionTtlMs?: number
  /** bcrypt cost，默认 12；测试可降低 */
  passwordRounds?: number
  logger?: V3Logger
  now?: () => Date
}

export interface V3Runtime {
  readonly allowedOrigins: readonly string[]
  readonly secureCookies: boolean
  readonly inviteCodeHashes: readonly string[]
  readonly sessionTtlMs: number
  readonly passwordRounds: number
  readonly logger: V3Logger
  readonly now: () => Date
  getDb(): V3Database
  close(): void
}

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_PASSWORD_ROUNDS = 12

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function resolveInviteCodeHashes(
  explicit: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (explicit !== undefined) return explicit.map((value) => value.toLowerCase())
  const hashes: string[] = []
  for (const item of (env.INVITE_CODE_SHA256 ?? '').split(',')) {
    const trimmed = item.trim().toLowerCase()
    if (/^[0-9a-f]{64}$/.test(trimmed)) hashes.push(trimmed)
  }
  const plain = env.INVITE_CODE?.trim()
  if (plain !== undefined && plain !== '') hashes.push(sha256Hex(plain))
  return hashes
}

export function hashInviteCode(code: string): string {
  return sha256Hex(code)
}

function resolvePasswordRounds(value: number | undefined, env: NodeJS.ProcessEnv): number {
  const raw = value ?? Number(env.BCRYPT_ROUNDS ?? DEFAULT_PASSWORD_ROUNDS)
  if (!Number.isInteger(raw) || raw < 4 || raw > 15) return DEFAULT_PASSWORD_ROUNDS
  return raw
}

export function createV3Runtime(options: V3RuntimeOptions = {}): V3Runtime {
  const databasePath = options.databasePath ?? defaultDatabasePath()
  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS
  // 默认 Secure：生产环境不依赖 NODE_ENV 是否被正确设置；本地开发显式关闭。
  const secureCookies = options.secureCookies ?? process.env.SCP_COOKIE_SECURE !== '0'
  const inviteCodeHashes = resolveInviteCodeHashes(options.inviteCodeHashes)
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const passwordRounds = resolvePasswordRounds(options.passwordRounds, process.env)
  const logger = options.logger ?? (process.env.NODE_ENV === 'test' ? silentV3Logger : createV3ConsoleLogger())
  const now = options.now ?? (() => new Date())

  let db: V3Database | null = null

  return {
    allowedOrigins,
    secureCookies,
    inviteCodeHashes,
    sessionTtlMs,
    passwordRounds,
    logger,
    now,
    getDb() {
      if (db === null) {
        db = openV3Database({ filePath: databasePath })
        if (inviteCodeHashes.length === 0) {
          logger.warn('未配置邀请码哈希，注册接口将拒绝所有请求', { category: 'auth.register' })
        }
      }
      return db
    },
    close() {
      if (db !== null) {
        db.close()
        db = null
      }
    },
  }
}
