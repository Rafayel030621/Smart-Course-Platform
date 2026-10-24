/**
 * 模型 JSON 输出的容错提取
 * ----------------------------------------------------------------------------
 * 生产环境里模型经常在 JSON 前后附带说明文字，或把 JSON 包进 ```json 围栏。
 * 这里先按“明显围栏”剥一次；仍解析失败时，再截取第一个 `{` / `[`
 * 到最后一个 `}` / `]` 之间的内容，避免只因为包装文字就判整份输出非法。
 *
 * 只做“取出可解析 JSON”，不判断 JSON 的字段结构——那由各输出校验层负责。
 */

export interface ModelJsonSuccess {
  ok: true
  parsed: unknown
}

export interface ModelJsonFailure {
  ok: false
  /** 原文长度，便于日志判断是不是被截断 */
  contentLength: number
  /** 原文前 120 字符；仅用于 warn 日志定位，不进入 info 日志或响应 */
  contentPreview: string
}

export type ModelJsonResult = ModelJsonSuccess | ModelJsonFailure

const CONTENT_PREVIEW_LIMIT = 120

function stripCodeFence(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const withoutOpening = trimmed.replace(/^```[a-zA-Z]*\s*/, '')
  return withoutOpening.replace(/```\s*$/, '').trim()
}

function firstJsonStart(value: string): number {
  const objectStart = value.indexOf('{')
  const arrayStart = value.indexOf('[')
  if (objectStart === -1) return arrayStart
  if (arrayStart === -1) return objectStart
  return Math.min(objectStart, arrayStart)
}

function lastJsonEnd(value: string, start: number): number {
  return value[start] === '{' ? value.lastIndexOf('}') : value.lastIndexOf(']')
}

export function extractModelJson(content: string): ModelJsonResult {
  const failure = (): ModelJsonFailure => ({
    ok: false,
    contentLength: content.length,
    contentPreview: content.slice(0, CONTENT_PREVIEW_LIMIT),
  })

  const withoutFence = stripCodeFence(content)

  try {
    return { ok: true, parsed: JSON.parse(withoutFence) }
  } catch {
    // 不是纯 JSON：继续尝试截取 JSON 主体
  }

  const start = firstJsonStart(withoutFence)
  if (start === -1) return failure()
  const end = lastJsonEnd(withoutFence, start)
  if (end === -1 || end <= start) return failure()

  try {
    return { ok: true, parsed: JSON.parse(withoutFence.slice(start, end + 1)) }
  } catch {
    return failure()
  }
}
