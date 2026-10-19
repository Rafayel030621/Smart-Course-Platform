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

export function createV3ConsoleLogger(prefix = 'v3'): V3Logger {
  return {
    info(message, fields) {
      if (fields === undefined) console.log(`[${prefix}] ${message}`)
      else console.log(`[${prefix}] ${message}`, fields)
    },
    warn(message, fields) {
      if (fields === undefined) console.warn(`[${prefix}] ${message}`)
      else console.warn(`[${prefix}] ${message}`, fields)
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
