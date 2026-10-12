import type { IncomingMessage, ServerResponse } from 'node:http'
import { ADVISOR_RECOMMENDATIONS_PATH } from './advisor.js'
import { ADVISOR_CHAT_PATH } from './advisorChat.js'
import { MATERIALS_PATH, MATERIALS_UNDERSTANDING_PATH } from './materials.js'
import { sendJson } from './health.js'

/** Browser origins allowed to call the advisor API. */
export const ALLOWED_CORS_ORIGINS = [
  'https://course.xinxian-music.xyz',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
}

function isAllowedOrigin(origin: string | undefined): origin is (typeof ALLOWED_CORS_ORIGINS)[number] {
  return origin !== undefined && ALLOWED_CORS_ORIGINS.includes(origin as (typeof ALLOWED_CORS_ORIGINS)[number])
}

/** 需要跨域处理的 API 路径：建议、聊天与两个材料接口（契约 7.4） */
const CORS_PATHS: readonly string[] = [
  ADVISOR_RECOMMENDATIONS_PATH,
  ADVISOR_CHAT_PATH,
  MATERIALS_PATH,
  MATERIALS_UNDERSTANDING_PATH,
]

/** Handle CORS for the API endpoints before their normal route handlers. */
export function handleApiCors(req: IncomingMessage, res: ServerResponse): boolean {
  if (!CORS_PATHS.includes(requestPath(req))) return false

  const origin = req.headers.origin
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    sendJson(res, 403, { status: 'error', message: '来源不被允许' })
    return true
  }

  if (req.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) {
      sendJson(res, 403, { status: 'error', message: '来源不被允许' })
      return true
    }
    res.setHeader('Access-Control-Allow-Origin', origin)
    setCorsHeaders(res)
    res.writeHead(204, { 'content-length': '0' })
    res.end()
    return true
  }

  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    setCorsHeaders(res)
  }
  return false
}
