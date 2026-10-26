import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONTRACT_VERSION,
  createConsoleLogger,
  type AdvisorChatSuccessResponse,
  type AdvisorFailureResponse,
  type AdvisorLogger,
  type ConfirmedMaterial,
  type MilestoneContext,
} from '../advisor/types.js'
import type { AdvisorService } from '../advisor/service.js'
import { buildChatCitations } from '../advisor/chatCitations.js'
import { LIMITS, parseAdvisorChatRequest } from '../advisor/validation.js'
import { resolveSession } from '../v3/auth.js'
import { readSessionToken } from '../v3/http.js'
import { persistChatExchange } from '../v3/chat.js'
import type { V3Database } from '../v3/db.js'
import { loadProject } from '../v3/domain.js'
import { V3Error } from '../v3/errors.js'
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

export interface AdvisorChatRouteOptions {
  service: AdvisorService
  logger?: AdvisorLogger
  maxBodyBytes?: number
  /** 契约 23.2 规则 1/4：项目级实体归属校验；返回错误时不调用模型 */
  validateMilestoneContext?: (projectId: string, context: MilestoneContext) => V3Error | null
  /** 契约 23.3：v3 材料门禁；用服务端权威材料替换客户端自报内容 */
  resolveConfirmedMaterials?: (
    projectId: string,
    materials: ConfirmedMaterial[],
    segmentIds: string[],
  ) => ConfirmedMaterial[]
  /** 聊天持久化；测试或旧环境不注入时跳过落库 */
  db?: V3Database | (() => V3Database)
  /** 持久化时间；不传时使用当前时间 */
  now?: () => Date
}

export function createAdvisorChatHandler(options: AdvisorChatRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const logger = options.logger ?? createConsoleLogger('advisor-chat')
  const maxBodyBytes = options.maxBodyBytes ?? LIMITS.bodyBytes
  function failure(res: ServerResponse, status: number, requestId: string | null, message: string, code: AdvisorFailureResponse['code'] = 'INVALID_INPUT'): void {
    const body: AdvisorFailureResponse = { contractVersion: CONTRACT_VERSION, requestId, code, message, retryable: false, retryAfterSeconds: null }
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
    if (!parsed.ok) { logger.warn('聊天请求未通过校验', { requestId: parsed.requestId, issues: parsed.issues }); failure(res, 400, parsed.requestId, `请求内容不合法：${parsed.issues[0] ?? '未知字段问题'}`, parsed.code ?? 'INVALID_INPUT'); return true }
    if (parsed.value.milestoneContext && options.validateMilestoneContext) {
      const validationError = options.validateMilestoneContext(
        parsed.value.projectId,
        parsed.value.milestoneContext,
      )
      if (validationError !== null) {
        logger.warn('聊天阶段上下文未通过项目级校验', {
          requestId: parsed.value.requestId,
          code: validationError.code,
        })
        failure(res, 400, parsed.value.requestId, validationError.publicMessage)
        return true
      }
    }
    if (
      parsed.value.promptVersion === 'advisor-chat-v3' &&
      options.resolveConfirmedMaterials &&
      (parsed.value.confirmedMaterials ?? []).length > 0
    ) {
      try {
        const segmentIds = (parsed.value.confirmedMaterials ?? []).flatMap((material) =>
          material.segments.map((segment) => segment.segmentId),
        )
        parsed.value.confirmedMaterials = options.resolveConfirmedMaterials(
          parsed.value.projectId,
          parsed.value.confirmedMaterials ?? [],
          segmentIds,
        )
      } catch (error) {
        if (error instanceof Error && 'status' in error && 'code' in error) {
          const v3Error = error as V3Error
          failure(
            res,
            v3Error.status,
            parsed.value.requestId,
            v3Error.publicMessage,
            v3Error.code as 'UNCONFIRMED_MATERIAL' | 'MATERIAL_VERSION_OUTDATED',
          )
          return true
        }
        throw error
      }
    }
    try {
      const result = await options.service.chat(parsed.value)
      if (!result.ok) { sendJson(res, 503, { contractVersion: CONTRACT_VERSION, requestId: parsed.value.requestId, code: result.code, message: '模型服务暂不可用，请稍后重试', retryable: result.retryable, retryAfterSeconds: result.retryAfterSeconds }); return true }
      const successBody: AdvisorChatSuccessResponse = {
        contractVersion: CONTRACT_VERSION,
        requestId: parsed.value.requestId,
        projectId: parsed.value.projectId,
        projectRevision: parsed.value.projectRevision,
        source: result.source,
        fallbackReason: result.fallbackReason,
        answer: result.answer,
      }
      if (parsed.value.promptVersion === 'advisor-chat-v3') {
        successBody.milestoneRevision = parsed.value.milestoneContext?.milestoneRevision ?? null
        const citations = buildChatCitations(
          parsed.value.confirmedMaterials ?? [],
          result.segmentIds ?? [],
          logger,
          parsed.value.requestId,
        )
        successBody.citations = citations

        let sessionId: string | null = null
        let messageId: string | null = null
        if (options.db !== undefined && readSessionToken(req) !== null) {
          try {
            const db = typeof options.db === 'function' ? options.db() : options.db
            const now = options.now?.() ?? new Date()
            const auth = resolveSession(db, req, now)
            if (auth !== null) {
              try {
                loadProject(db, auth.user.user_id, parsed.value.projectId)
                const persisted = persistChatExchange(db, {
                  projectId: parsed.value.projectId,
                  userId: auth.user.user_id,
                  requestId: parsed.value.requestId,
                  question: parsed.value.question,
                  answer: result.answer,
                  citations,
                  promptVersion: parsed.value.promptVersion,
                  projectRevision: parsed.value.projectRevision,
                  now,
                })
                sessionId = persisted.sessionId
                messageId = persisted.messageId
              } catch (error) {
                // 本地项目（无云端 projectId）静默跳过；其它持久化失败也不影响聊天回答
                if (!(error instanceof V3Error && error.code === 'PROJECT_NOT_FOUND')) {
                  logger.warn('聊天持久化失败', {
                    requestId: parsed.value.requestId,
                    detail: error instanceof Error ? error.name : 'unknown',
                  })
                }
              }
            }
          } catch (error) {
            logger.warn('聊天持久化初始化失败', {
              requestId: parsed.value.requestId,
              detail: error instanceof Error ? error.name : 'unknown',
            })
          }
        }
        successBody.sessionId = sessionId
        successBody.messageId = messageId
      }
      sendJson(res, 200, successBody)
      return true
    } catch (error) { logger.warn('处理聊天请求时发生未预期异常', { detail: error instanceof Error ? error.name : 'unknown' }); failure(res, 500, null, '服务内部错误'); return true }
  }
}
