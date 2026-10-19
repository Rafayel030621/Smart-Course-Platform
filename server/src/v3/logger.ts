/**
 * V3 安全日志
 * ----------------------------------------------------------------------------
 * 只记录 requestId、用户安全标识、操作类别、状态与数量。
 * 不记录密码、Cookie、邀请码、材料/聊天正文、模型原文、文件路径或密钥。
 */

export type SafeLogFields = Record<string, string | number | boolean | null>

export interface V3Logger {
  info(message: string, fields?: SafeLogFields): void
  warn(message: string, fields?: SafeLogFields): void
}

const MAX_MESSAGE_LENGTH = 200
const MAX_FIELD_COUNT = 16
const MAX_STRING_LENGTH = 120
const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/

export function sanitizeLogMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, MAX_MESSAGE_LENGTH)
}

export function sanitizeLogValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    return value.replace(/[\r\n\t]/g, ' ').slice(0, MAX_STRING_LENGTH)
  }
  return null
}

/** 日志字段只保留有界原始值，禁止嵌套对象/数组把请求正文带进日志 */
export function sanitizeLogFields(
  fields: Record<string, unknown> | undefined,
): SafeLogFields | undefined {
  if (fields === undefined) return undefined
  const out: SafeLogFields = {}
  let count = 0
  for (const [key, value] of Object.entries(fields)) {
    if (count >= MAX_FIELD_COUNT) break
    if (!SAFE_KEY.test(key)) continue
    out[key] = sanitizeLogValue(value)
    count += 1
  }
  return out
}

export function createV3ConsoleLogger(prefix = 'v3'): V3Logger {
  return {
    info(message, fields) {
      const safeMessage = sanitizeLogMessage(message)
      if (fields === undefined) console.log(`[${prefix}] ${safeMessage}`)
      else console.log(`[${prefix}] ${safeMessage}`, sanitizeLogFields(fields))
    },
    warn(message, fields) {
      const safeMessage = sanitizeLogMessage(message)
      if (fields === undefined) console.warn(`[${prefix}] ${safeMessage}`)
      else console.warn(`[${prefix}] ${safeMessage}`, sanitizeLogFields(fields))
    },
  }
}

export const silentV3Logger: V3Logger = {
  info() {},
  warn() {},
}

/** 用户安全标识：只取 ID 后 8 位，避免完整租户键进入日志 */
export function safeUserRef(userId: string | null | undefined): string | null {
  if (userId === null || userId === undefined || userId === '') return null
  return `usr_…${userId.slice(-8)}`
}
