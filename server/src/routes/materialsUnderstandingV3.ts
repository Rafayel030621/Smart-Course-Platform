import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConsoleLogger, type AdvisorLogger } from '../advisor/types.js'
import type {
  MaterialsUnderstandingV3Input,
  UnderstandingMaterialInput,
} from '../materials/types.js'
import { MATERIAL_UNDERSTANDING_V3_PROMPT_VERSION } from '../materials/types.js'
import type { MaterialsService } from '../materials/understanding.js'
import { requireAuth } from '../v3/auth.js'
import { loadProject } from '../v3/domain.js'
import { V3Error, invalidInput } from '../v3/errors.js'
import {
  bodyReadError,
  errorBody,
  readJsonBody,
  requireJsonContentType,
  requireRecord,
  requireWriteEnvelope,
  sendV3Json,
  successBody,
} from '../v3/http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from '../v3/idempotency.js'
import {
  gateConfirmedMaterials,
  type ConfirmedMaterialInput,
} from '../v3/materialGate.js'
import type { V3Runtime } from '../v3/runtime.js'

/**
 * POST /api/materials/understanding-v3（契约 31）
 * ----------------------------------------------------------------------------
 * v2 路径完全不变；v3 先鉴权、校验项目归属，再通过 D15 门禁回库，
 * 客户端自报的名称、行号、正文不进入服务层。
 */

export const MATERIALS_UNDERSTANDING_V3_PATH = '/api/materials/understanding-v3'

const MIN_SEGMENTS = 1
const MAX_SEGMENTS = 100

export interface MaterialsUnderstandingV3RouteOptions {
  runtime: V3Runtime
  service: MaterialsService
  logger?: AdvisorLogger
  maxBodyBytes?: number
}

interface SegmentRequest {
  materialId: string
  version: number
  segmentId: string
}

function parseSegmentRequests(value: unknown): SegmentRequest[] {
  if (!Array.isArray(value) || value.length < MIN_SEGMENTS || value.length > MAX_SEGMENTS) {
    throw invalidInput(`segments 必须是 ${MIN_SEGMENTS}-${MAX_SEGMENTS} 条的数组`)
  }

  const seen = new Set<string>()
  const segments: SegmentRequest[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalidInput('segments 的每一项必须是对象')
    }
    const item = raw as Record<string, unknown>
    if (typeof item.materialId !== 'string' || item.materialId.trim() === '') {
      throw invalidInput('segments.materialId 不能为空')
    }
    if (typeof item.version !== 'number' || !Number.isInteger(item.version) || item.version < 1) {
      throw invalidInput('segments.version 必须是 ≥ 1 的整数')
    }
    if (typeof item.segmentId !== 'string' || item.segmentId.trim() === '') {
      throw invalidInput('segments.segmentId 不能为空')
    }

    const materialId = item.materialId.trim()
    const segmentId = item.segmentId.trim()
    const key = `${materialId}\u0000${item.version}\u0000${segmentId}`
    if (seen.has(key)) continue
    seen.add(key)
    segments.push({ materialId, version: item.version, segmentId })
  }
  return segments
}

function toGateInputs(segments: SegmentRequest[]): ConfirmedMaterialInput[] {
  const groups = new Map<string, ConfirmedMaterialInput>()
  for (const segment of segments) {
    const key = `${segment.materialId}\u0000${segment.version}`
    let material = groups.get(key)
    if (material === undefined) {
      material = {
        materialId: segment.materialId,
        name: '',
        type: 'md',
        version: segment.version,
        segments: [],
      }
      groups.set(key, material)
    }
    material.segments.push({
      segmentId: segment.segmentId,
      startLine: 0,
      endLine: 0,
      text: '',
    })
  }
  return [...groups.values()]
}

function toServiceMaterials(materials: ReturnType<typeof gateConfirmedMaterials>): UnderstandingMaterialInput[] {
  return materials.map((material) => ({
    materialId: material.materialId,
    name: material.materialName,
    type: material.type,
    version: material.materialVersion,
    segments: material.segments.map((segment) => ({
      segmentId: segment.segmentId,
      startLine: segment.startLine,
      endLine: segment.endLine,
      text: segment.text,
    })),
  }))
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, maxBytes))
  } catch (error) {
    throw bodyReadError(error)
  }
}

export function createMaterialsUnderstandingV3Handler(
  options: MaterialsUnderstandingV3RouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const logger = options.logger ?? createConsoleLogger('materials')
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024

  return async function handleMaterialsUnderstandingV3(req, res): Promise<boolean> {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname !== MATERIALS_UNDERSTANDING_V3_PATH) return false

    if (req.method !== 'POST') {
      sendV3Json(
        res,
        405,
        { status: 'error', message: `仅支持 POST ${MATERIALS_UNDERSTANDING_V3_PATH}` },
        { allow: 'POST' },
      )
      return true
    }

    let requestId: string | null = null
    let projectId: string | null = null
    try {
      requireJsonContentType(req)
      const body = await readBody(req, maxBodyBytes)
      requestId = typeof body.requestId === 'string' ? body.requestId : null
      projectId = typeof body.projectId === 'string' ? body.projectId : null

      if (projectId === null || projectId.trim() === '') {
        throw invalidInput('projectId 不能为空')
      }
      const envelope = requireWriteEnvelope(body, projectId)
      if (body.promptVersion !== MATERIAL_UNDERSTANDING_V3_PROMPT_VERSION) {
        throw invalidInput(`promptVersion 必须是 "${MATERIAL_UNDERSTANDING_V3_PROMPT_VERSION}"`)
      }
      const segments = parseSegmentRequests(body.segments)

      const db = options.runtime.getDb()
      const now = options.runtime.now()
      const auth = requireAuth(db, req, now)
      const project = loadProject(db, auth.user.user_id, projectId)

      const fingerprint = requestFingerprint({
        method: 'POST',
        operation: 'materials.understanding.v3',
        resource: projectId,
        body,
      })
      const nowText = now.toISOString()
      const replay = lookupIdempotent(
        db,
        auth.user.user_id,
        envelope.idempotencyKey,
        fingerprint,
        nowText,
      )
      if (replay !== null) {
        sendV3Json(res, replay.statusCode, replay.body)
        return true
      }

      const gated = gateConfirmedMaterials(
        db,
        projectId,
        toGateInputs(segments),
        segments.map((segment) => segment.segmentId),
      )
      if (gated.length === 0) throw invalidInput('segments 中没有可用片段')

      const serviceInput: MaterialsUnderstandingV3Input = {
        requestId: envelope.requestId,
        projectId,
        projectRevision: envelope.projectRevision,
        projectName: project.name,
        promptVersion: body.promptVersion,
        materials: toServiceMaterials(gated),
      }
      const result = await options.service.understandV3(serviceInput)
      if (!result.ok) {
        logger.warn('材料理解 V3 最终失败', {
          requestId: envelope.requestId,
          code: result.code,
        })
        throw new V3Error('INTERNAL')
      }

      const response = successBody(envelope.requestId, projectId, {
        projectRevision: envelope.projectRevision,
        promptVersion: body.promptVersion,
        source: result.source,
        fallbackReason: result.fallbackReason,
        notice: result.notice,
        draft: result.draft,
      })
      saveIdempotent(
        db,
        auth.user.user_id,
        envelope.idempotencyKey,
        fingerprint,
        200,
        response,
        nowText,
      )
      sendV3Json(res, 200, response)
      return true
    } catch (error) {
      if (error instanceof V3Error) {
        sendV3Json(res, error.status, errorBody(error, requestId, projectId))
        return true
      }
      logger.warn('处理材料理解 V3 时发生未预期异常', {
        detail: error instanceof Error ? error.name : 'unknown',
      })
      const internal = new V3Error('INTERNAL')
      sendV3Json(res, internal.status, errorBody(internal, requestId, projectId))
      return true
    }
  }
}
