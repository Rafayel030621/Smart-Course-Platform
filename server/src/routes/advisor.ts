import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONTRACT_VERSION,
  createConsoleLogger,
  type AdvisorFailureResponse,
  type AdvisorLogger,
  type AdvisorRuntimeErrorCode,
  type AdvisorSuccessResponse,
} from '../advisor/types.js'
import type { AdvisorService } from '../advisor/service.js'
import type { ConfirmedMaterial, MilestoneContext } from '../advisor/types.js'
import { LIMITS, parseAdvisorRequest } from '../advisor/validation.js'
import type { V3Error } from '../v3/errors.js'
import { sendJson } from './health.js'

/**
 * POST /api/advisor/recommendations 的 HTTP 层
 * ----------------------------------------------------------------------------
 * 只做四件事：匹配路径与方法、读请求体、调服务层、把结果写成契约规定的 JSON。
 * 字段名、状态码、错误码全部以 docs/contracts.md 为准，不在这里另造一套。
 */

export const ADVISOR_RECOMMENDATIONS_PATH = '/api/advisor/recommendations'

const STATUS_BY_CODE: Record<AdvisorRuntimeErrorCode, number> = {
  RATE_LIMITED: 429,
  MODEL_TIMEOUT: 504,
  INVALID_MODEL_OUTPUT: 502,
  MODEL_UNAVAILABLE: 503,
  MODEL_NOT_CONFIGURED: 503,
  INTERNAL: 500,
}

/**
 * 对外文案：只说清楚发生了什么、用户能做什么。
 * 不含堆栈、不含内部错误细节、不含密钥或路径。
 */
const MESSAGE_BY_CODE: Record<AdvisorRuntimeErrorCode, string> = {
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  MODEL_TIMEOUT: '模型调用超时，规则兜底也未生成建议，请稍后重试',
  INVALID_MODEL_OUTPUT: '模型返回内容不合法，规则兜底也未生成建议，请稍后重试',
  MODEL_UNAVAILABLE: '模型服务暂不可用，规则兜底也未生成建议，请稍后重试',
  MODEL_NOT_CONFIGURED: '服务端未配置模型密钥，本轮请改用本地规则建议',
  INTERNAL: '服务内部错误，请稍后重试',
}

export interface AdvisorRouteOptions {
  service: AdvisorService
  logger?: AdvisorLogger
  /** 请求体上限，默认取契约规定的 256 KB */
  maxBodyBytes?: number
  /** 契约 23.2 规则 1/4：项目级实体归属校验；返回错误时不调用模型 */
  validateMilestoneContext?: (projectId: string, context: MilestoneContext) => V3Error | null
  /** 契约 23.3：v3 材料门禁；用服务端权威材料替换客户端自报内容 */
  resolveConfirmedMaterials?: (
    projectId: string,
    materials: ConfirmedMaterial[],
    segmentIds: string[],
  ) => ConfirmedMaterial[]
}

class BodyTooLargeError extends Error {
  constructor() {
    super('请求体超过上限')
    this.name = 'BodyTooLargeError'
  }
}

/** 按上限读取请求体；超限时停止累积，读完后再报错（避免直接掐断连接导致客户端拿不到响应） */
function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
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
      if (overflow) {
        reject(new BodyTooLargeError())
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error: Error) => reject(error))
  })
}

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown'
}

/**
 * 创建建议接口处理器。
 * 返回的函数与 health 的处理器一样：返回 true 表示请求已被处理，调用方不要再兜底。
 */
export function createAdvisorHandler(
  options: AdvisorRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { service } = options
  const logger = options.logger ?? createConsoleLogger('advisor')
  const maxBodyBytes = options.maxBodyBytes ?? LIMITS.bodyBytes

  function sendFailure(
    res: ServerResponse,
    statusCode: number,
    code:
      | AdvisorRuntimeErrorCode
      | 'INVALID_INPUT'
      | 'CONTRACT_VERSION_MISMATCH'
      | 'UNCONFIRMED_MATERIAL'
      | 'MATERIAL_VERSION_OUTDATED',
    requestId: string | null,
    message: string,
    retryable: boolean,
  ): void {
    const body: AdvisorFailureResponse = {
      contractVersion: CONTRACT_VERSION,
      requestId,
      code,
      message,
      retryable,
      retryAfterSeconds: null,
    }
    sendJson(res, statusCode, body)
  }

  return async function handleAdvisor(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname !== ADVISOR_RECOMMENDATIONS_PATH) return false

    if (req.method !== 'POST') {
      // 与 /health 的处理方式一致：方法不支持返回 405，并给出 allow
      sendJson(
        res,
        405,
        { status: 'error', message: `仅支持 POST ${ADVISOR_RECOMMENDATIONS_PATH}` },
        { allow: 'POST' },
      )
      return true
    }

    try {
      const contentType = String(req.headers['content-type'] ?? '')
      if (!/^application\/json\s*(;|$)/i.test(contentType)) {
        logger.warn('Content-Type 不合法', { contentType })
        sendFailure(res, 400, 'INVALID_INPUT', null, 'Content-Type 必须是 application/json', false)
        return true
      }

      let rawText: string
      try {
        rawText = await readRequestBody(req, maxBodyBytes)
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          logger.warn('请求体超过上限', { maxBodyBytes })
          sendFailure(res, 400, 'INVALID_INPUT', null, `请求体超过 ${maxBodyBytes} 字节上限`, false)
          return true
        }
        logger.warn('读取请求体失败', { detail: toDetail(error) })
        if (!res.headersSent) {
          sendFailure(res, 400, 'INVALID_INPUT', null, '读取请求体失败', false)
        }
        return true
      }

      let body: unknown
      try {
        body = JSON.parse(rawText)
      } catch {
        // 契约 4.5：请求无法解析时 requestId 必须为 null
        logger.warn('请求体不是合法 JSON')
        sendFailure(res, 400, 'INVALID_INPUT', null, '请求体不是合法 JSON', false)
        return true
      }

      const parsed = parseAdvisorRequest(body)
      if (!parsed.ok) {
        logger.warn('请求未通过校验', { requestId: parsed.requestId, issues: parsed.issues })
        sendFailure(
          res,
          400,
          parsed.code ?? 'INVALID_INPUT',
          parsed.requestId,
          `请求内容不合法：${parsed.issues[0] ?? '未知字段问题'}`,
          false,
        )
        return true
      }

      if (parsed.value.milestoneContext && options.validateMilestoneContext) {
        const validationError = options.validateMilestoneContext(
          parsed.value.projectId,
          parsed.value.milestoneContext,
        )
        if (validationError !== null) {
          logger.warn('阶段上下文未通过项目级校验', {
            requestId: parsed.value.requestId,
            code: validationError.code,
          })
          sendFailure(
            res,
            400,
            'INVALID_INPUT',
            parsed.value.requestId,
            validationError.publicMessage,
            false,
          )
          return true
        }
      }

      if (
        parsed.value.promptVersion === 'mvp-prompt-v3' &&
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
            sendFailure(
              res,
              v3Error.status,
              v3Error.code as 'UNCONFIRMED_MATERIAL' | 'MATERIAL_VERSION_OUTDATED',
              parsed.value.requestId,
              v3Error.publicMessage,
              false,
            )
            return true
          }
          throw error
        }
      }

      const result = await service.recommend(parsed.value)

      if (result.ok) {
        const suggestions =
          parsed.value.promptVersion === 'mvp-prompt-v3'
            ? result.suggestions.map((suggestion) => ({
                ...suggestion,
                basisMaterialRefs: suggestion.basisMaterialRefs ?? [],
              }))
            : result.suggestions.map(({ basisMaterialRefs: _ignored, ...suggestion }) => suggestion)
        const successBody: AdvisorSuccessResponse = {
          contractVersion: CONTRACT_VERSION,
          requestId: parsed.value.requestId,
          projectId: parsed.value.projectId,
          projectRevision: parsed.value.projectRevision,
          source: result.source,
          fallbackReason: result.fallbackReason,
          cached: result.cached,
          promptVersion: parsed.value.promptVersion,
          suggestions,
        }
        sendJson(res, 200, successBody)
        return true
      }

      logger.warn('建议生成最终失败', { requestId: parsed.value.requestId, code: result.code })
      sendFailure(
        res,
        STATUS_BY_CODE[result.code],
        result.code,
        parsed.value.requestId,
        MESSAGE_BY_CODE[result.code],
        result.retryable,
      )
      return true
    } catch (error) {
      // 兜底：未预期异常也只返回契约形状的错误，不把堆栈或内部信息带给客户端
      logger.warn('处理建议请求时发生未预期异常', { detail: toDetail(error) })
      if (!res.headersSent) {
        sendFailure(res, 500, 'INTERNAL', null, MESSAGE_BY_CODE.INTERNAL, true)
      } else {
        res.end()
      }
      return true
    }
  }
}
