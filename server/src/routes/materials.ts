import type { IncomingMessage, ServerResponse } from 'node:http'
import { CONTRACT_VERSION, createConsoleLogger, type AdvisorLogger } from '../advisor/types.js'
import type { MaterialsService } from '../materials/understanding.js'
import {
  MATERIAL_ERROR_MESSAGES,
  MATERIAL_RETRYABLE_BY_CODE,
  MATERIAL_STATUS_BY_CODE,
  type MaterialMetadata,
  type MaterialRuntimeErrorCode,
  type MaterialsFailureResponse,
} from '../materials/types.js'
import { MATERIAL_LIMITS, parseMaterialUploadRequest, parseMaterialsUnderstandingRequest } from '../materials/validation.js'
import { sendJson } from './health.js'

/**
 * 材料接口的 HTTP 层（契约第 15 节）
 * ----------------------------------------------------------------------------
 * POST /api/materials                材料登记与解析（不调用模型：不使用 promptVersion / source / fallbackReason）
 * POST /api/materials/understanding  材料理解草稿（调用模型：返回 source / fallbackReason / notice）
 *
 * 只做四件事：匹配路径与方法、读请求体、调服务层、把结果写成契约规定的 JSON。
 * 错误码、状态码与中文文案全部来自 materials/types.ts，不在这里另造一套。
 */

export const MATERIALS_PATH = '/api/materials'
export const MATERIALS_UNDERSTANDING_PATH = '/api/materials/understanding'

export interface MaterialsRouteOptions {
  service: MaterialsService
  logger?: AdvisorLogger
  /** 上传请求体上限，默认 2 MB（契约 15.4） */
  uploadMaxBodyBytes?: number
  /** 理解请求体上限，默认 256 KB */
  understandingMaxBodyBytes?: number
}

class BodyTooLargeError extends Error {
  constructor() {
    super('请求体超过上限')
    this.name = 'BodyTooLargeError'
  }
}

/** 按上限读取请求体；超限时停止累积，读完后再报错（与建议接口同一策略） */
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

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname
}

function sendFailure(
  res: ServerResponse,
  code: MaterialRuntimeErrorCode,
  requestId: string | null,
  message: string,
): void {
  const body: MaterialsFailureResponse = {
    contractVersion: CONTRACT_VERSION,
    requestId,
    code,
    message,
    retryable: MATERIAL_RETRYABLE_BY_CODE[code],
    retryAfterSeconds: null,
  }
  sendJson(res, MATERIAL_STATUS_BY_CODE[code], body)
}

/** 读请求体 + 解析 JSON；返回 null 表示已经写过错误响应 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse, maxBodyBytes: number, logger: AdvisorLogger): Promise<unknown | null> {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    logger.warn('Content-Type 不合法', { contentType })
    sendFailure(res, 'INVALID_INPUT', null, 'Content-Type 必须是 application/json')
    return null
  }

  let rawText: string
  try {
    rawText = await readRequestBody(req, maxBodyBytes)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      logger.warn('请求体超过上限', { maxBodyBytes })
      sendFailure(res, 'INVALID_INPUT', null, `请求体超过 ${maxBodyBytes} 字节上限`)
      return null
    }
    logger.warn('读取请求体失败', { detail: toDetail(error) })
    sendFailure(res, 'INVALID_INPUT', null, '读取请求体失败')
    return null
  }

  try {
    return JSON.parse(rawText)
  } catch {
    // 契约 4.5：请求无法解析时 requestId 必须为 null
    sendFailure(res, 'INVALID_INPUT', null, '请求体不是合法 JSON')
    return null
  }
}

/* ---------------------------------------------------- POST /api/materials */

export function createMaterialsHandler(
  options: MaterialsRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const logger = options.logger ?? createConsoleLogger('materials')
  const maxBodyBytes = options.uploadMaxBodyBytes ?? MATERIAL_LIMITS.uploadBodyBytes

  return async function handleMaterials(req, res): Promise<boolean> {
    if (requestPath(req) !== MATERIALS_PATH) return false

    if (req.method !== 'POST') {
      sendJson(res, 405, { status: 'error', message: `仅支持 POST ${MATERIALS_PATH}` }, { allow: 'POST' })
      return true
    }

    try {
      const body = await readJsonBody(req, res, maxBodyBytes, logger)
      if (body === null) return true

      const parsed = parseMaterialUploadRequest(body)
      if (!parsed.ok) {
        logger.warn('材料上传未通过校验', { requestId: parsed.requestId, code: parsed.code })
        sendFailure(res, parsed.code, parsed.requestId, parsed.message)
        return true
      }

      const now = new Date().toISOString()
      const material: MaterialMetadata = {
        materialId: parsed.value.materialId,
        projectId: parsed.value.projectId,
        name: parsed.value.name,
        type: parsed.value.type,
        size: parsed.value.size,
        encoding: parsed.value.encoding,
        state: 'parsed',
        version: parsed.value.version,
        createdAt: now,
        updatedAt: now,
        failureReason: null,
      }

      sendJson(res, 200, {
        contractVersion: CONTRACT_VERSION,
        requestId: parsed.value.requestId,
        projectId: parsed.value.projectId,
        projectRevision: parsed.value.projectRevision,
        material,
        segmentCount: parsed.value.segments.length,
        segments: parsed.value.segments,
      })
      return true
    } catch (error) {
      logger.warn('处理材料上传时发生未预期异常', { detail: toDetail(error) })
      if (!res.headersSent) sendFailure(res, 'INTERNAL', null, MATERIAL_ERROR_MESSAGES.INTERNAL)
      else res.end()
      return true
    }
  }
}

/* --------------------------------------- POST /api/materials/understanding */

export function createMaterialsUnderstandingHandler(
  options: MaterialsRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const logger = options.logger ?? createConsoleLogger('materials')
  const maxBodyBytes = options.understandingMaxBodyBytes ?? MATERIAL_LIMITS.understandingBodyBytes

  return async function handleMaterialsUnderstanding(req, res): Promise<boolean> {
    if (requestPath(req) !== MATERIALS_UNDERSTANDING_PATH) return false

    if (req.method !== 'POST') {
      sendJson(
        res,
        405,
        { status: 'error', message: `仅支持 POST ${MATERIALS_UNDERSTANDING_PATH}` },
        { allow: 'POST' },
      )
      return true
    }

    try {
      const body = await readJsonBody(req, res, maxBodyBytes, logger)
      if (body === null) return true

      const parsed = parseMaterialsUnderstandingRequest(body)
      if (!parsed.ok) {
        logger.warn('材料理解请求未通过校验', { requestId: parsed.requestId, code: parsed.code })
        sendFailure(res, parsed.code, parsed.requestId, parsed.message)
        return true
      }

      const result = await options.service.understand(parsed.value)

      if (!result.ok) {
        logger.warn('材料理解最终失败', { requestId: parsed.value.requestId, code: result.code })
        sendFailure(res, result.code, parsed.value.requestId, MATERIAL_ERROR_MESSAGES[result.code])
        return true
      }

      sendJson(res, 200, {
        contractVersion: CONTRACT_VERSION,
        requestId: parsed.value.requestId,
        projectId: parsed.value.projectId,
        projectRevision: parsed.value.projectRevision,
        materialId: parsed.value.material.materialId,
        materialVersion: parsed.value.material.version,
        promptVersion: parsed.value.promptVersion,
        source: result.source,
        fallbackReason: result.fallbackReason,
        notice: result.notice,
        draft: result.draft,
      })
      return true
    } catch (error) {
      logger.warn('处理材料理解时发生未预期异常', { detail: toDetail(error) })
      if (!res.headersSent) sendFailure(res, 'INTERNAL', null, MATERIAL_ERROR_MESSAGES.INTERNAL)
      else res.end()
      return true
    }
  }
}
