import type { IncomingMessage, ServerResponse } from 'node:http'
import { CONTRACT_VERSION, createConsoleLogger, type AdvisorFailureResponse, type AdvisorLogger } from '../advisor/types.js'
import type { AdvisorService } from '../advisor/service.js'
import { LIMITS, parseAdvisorChatRequest } from '../advisor/validation.js'
import { sendJson } from './health.js'

export const ADVISOR_CHAT_PATH = '/api/advisor/chat'

class BodyTooLargeError extends Error {}
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let overflow = false
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) overflow = true; else chunks.push(chunk) })
    req.on('end', () => overflow ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createAdvisorChatHandler(options: { service: AdvisorService; logger?: AdvisorLogger; maxBodyBytes?: number }): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const logger = options.logger ?? createConsoleLogger('advisor-chat')
  const maxBodyBytes = options.maxBodyBytes ?? LIMITS.bodyBytes
  function failure(res: ServerResponse, status: number, requestId: string | null, message: string): void {
    const body: AdvisorFailureResponse = { contractVersion: CONTRACT_VERSION, requestId, code: 'INVALID_INPUT', message, retryable: false, retryAfterSeconds: null }
    sendJson(res, status, body)
  }
  return async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname !== ADVISOR_CHAT_PATH) return false
    if (req.method !== 'POST') { sendJson(res, 405, { status: 'error', message: `仅支持 POST ${ADVISOR_CHAT_PATH}` }, { allow: 'POST' }); return true }
    const contentType = String(req.headers['content-type'] ?? '')
    if (!/^application\/json\s*(;|$)/i.test(contentType)) { failure(res, 400, null, 'Content-Type 必须是 application/json'); return true }
    let raw: string
    try { raw = await readBody(req, maxBodyBytes) } catch (error) { failure(res, 400, null, error instanceof BodyTooLargeError ? `请求体超过 ${maxBodyBytes} 字节上限` : '读取请求体失败'); return true }
    let body: unknown
    try { body = JSON.parse(raw) } catch { failure(res, 400, null, '请求体不是合法 JSON'); return true }
    const parsed = parseAdvisorChatRequest(body)
    if (!parsed.ok) { logger.warn('聊天请求未通过校验', { requestId: parsed.requestId, issues: parsed.issues }); failure(res, 400, parsed.requestId, `请求内容不合法：${parsed.issues[0] ?? '未知字段问题'}`); return true }
    try {
      const result = await options.service.chat(parsed.value)
      if (!result.ok) { sendJson(res, 503, { contractVersion: CONTRACT_VERSION, requestId: parsed.value.requestId, code: result.code, message: '模型服务暂不可用，请稍后重试', retryable: result.retryable, retryAfterSeconds: result.retryAfterSeconds }); return true }
      sendJson(res, 200, { contractVersion: CONTRACT_VERSION, requestId: parsed.value.requestId, projectId: parsed.value.projectId, projectRevision: parsed.value.projectRevision, source: result.source, fallbackReason: result.fallbackReason, answer: result.answer })
      return true
    } catch (error) { logger.warn('处理聊天请求时发生未预期异常', { detail: error instanceof Error ? error.name : 'unknown' }); failure(res, 500, null, '服务内部错误'); return true }
  }
}
