import { requestJson, type HttpFailureCause } from './http'
import { createRequestId } from './advisorApi'
import {
  CONTRACT_VERSION,
  MATERIAL_UNDERSTANDING_PROMPT_VERSION,
  RETRYABLE_BY_CODE,
  isAdvisorErrorCode,
  type AdvisorApiError,
  type AdvisorErrorCause,
  type AdvisorFallbackReason,
  type MaterialsUnderstandingRequest,
  type MaterialsUnderstandingSuccess,
  type MaterialSegmentDto,
  type MaterialUploadRequest,
  type MaterialUploadSuccess,
  clampProjectName,
} from '@/domain/recommendation'
import type {
  MaterialEncoding,
  MaterialState,
  MaterialType,
  UnderstandingBlockKind,
  UnderstandingDraft,
} from '@/types/platform'
import { UNDERSTANDING_BLOCK_ORDER, MATERIAL_TYPES } from '@/domain/materials'

/**
 * 材料接口适配层
 * ----------------------------------------------------------------------------
 * POST /api/materials              材料登记与解析（契约 15.1）
 * POST /api/materials/understanding 材料理解草稿（契约 15.2）
 *
 * 与 `advisorApi.ts` 同一套约定：
 *   - 字段名与契约一致，不另造 DTO；
 *   - 成功响应校验 `requestId` / `projectId` / `projectRevision`（契约 4.7），对不上整份丢弃；
 *   - 失败保留契约的 `code` / `retryable` / `retryAfterSeconds`；
 *   - `retryable: true` 的失败在适配层最多自动重试 1 次，退避 1 秒（契约 15.4）；
 *   - 不读、不存、不打印任何密钥；日志只记方法与路径，不记材料正文。
 */

/** 契约 15.0：材料登记与解析 */
export const MATERIALS_PATH = '/api/materials'
/** 契约 15.0：材料理解草稿 */
export const MATERIALS_UNDERSTANDING_PATH = '/api/materials/understanding'

const RETRY_DELAY_MS = 1_000

/** 材料接口的 requestId：与建议接口同一套生成规则，单独导出便于测试注入 */
export function createMaterialRequestId(): string {
  return createRequestId()
}

/* ------------------------------------------------------------------ 工具 */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ------------------------------------------------------------- base64 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 把原始字节编成标准 base64（不带 data URL 前缀，契约 15.1）。
 *
 * 自己实现而不依赖 `btoa`：GBK 文件必须按**原始字节**编码，浏览器把文本
 * 先按 UTF-8 处理会破坏内容；同时避免 `String.fromCharCode(...bytes)` 在
 * 大文件上触发参数上限。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let result = ''

  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index]
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : undefined
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : undefined

    result += BASE64_ALPHABET[b0 >> 2]
    result += BASE64_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)]
    result += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)]
    result += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0b111111]
  }

  return result
}

/* ---------------------------------------------------------- 组装请求 */

export interface BuildMaterialUploadInput {
  projectId: string
  projectRevision: number
  materialId: string
  version: number
  name: string
  contentBase64: string
  /** 不传则自动生成 */
  requestId?: string
}

/** 契约 15.1：装配上传请求体。只做字段装配，不做校验 */
export function buildMaterialUploadRequest(input: BuildMaterialUploadInput): MaterialUploadRequest {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: input.requestId ?? createRequestId(),
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    materialId: input.materialId,
    version: input.version,
    name: input.name,
    contentBase64: input.contentBase64,
  }
}

export interface BuildUnderstandingInput {
  projectId: string
  projectRevision: number
  projectName: string | null
  material: MaterialsUnderstandingRequest['material']
  /** 不传则自动生成 */
  requestId?: string
}

/** 契约 15.2：装配理解请求体。`promptVersion` 固定为 material-understanding-v1 */
export function buildUnderstandingRequest(
  input: BuildUnderstandingInput,
): MaterialsUnderstandingRequest {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: input.requestId ?? createRequestId(),
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    promptVersion: MATERIAL_UNDERSTANDING_PROMPT_VERSION,
    // 契约 15.2：projectName ≤ 120 字、可为 null；超长只截断，不让整个请求 400
    projectName: clampProjectName(input.projectName),
    material: input.material,
  }
}

/* ---------------------------------------------------------- 响应校验 */

function asMaterial(value: unknown): MaterialUploadSuccess['material'] | null {
  if (!isPlainObject(value)) return null

  const { materialId, projectId, name, type, size, encoding, state, version } = value
  if (typeof materialId !== 'string' || materialId === '') return null
  if (typeof projectId !== 'string' || projectId === '') return null
  if (typeof name !== 'string' || name.trim() === '') return null
  if (typeof type !== 'string' || !(MATERIAL_TYPES as readonly string[]).includes(type)) return null
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 1) return null
  if (encoding !== 'utf-8' && encoding !== 'gbk') return null
  if (state !== 'parsed' && state !== 'parse_failed') return null
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null

  const failureReason = value.failureReason
  if (failureReason !== null && typeof failureReason !== 'string') return null

  return {
    materialId,
    projectId,
    name,
    type: type as MaterialType,
    size,
    encoding: encoding as MaterialEncoding,
    state: state as MaterialState,
    version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    failureReason: (failureReason ?? null) as string | null,
  }
}

function asMaterialSegmentDto(value: unknown): MaterialSegmentDto | null {
  if (!isPlainObject(value)) return null
  const { segmentId, index, startLine, endLine, text } = value
  if (typeof segmentId !== 'string' || segmentId === '') return null
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) return null
  if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < startLine) return null
  if (typeof text !== 'string') return null

  return { segmentId, index, startLine, endLine, text }
}

/** 契约 15.1：成功响应必需字段齐全 */
function asUploadSuccess(value: unknown): MaterialUploadSuccess | null {
  if (!isPlainObject(value)) return null
  const { contractVersion, requestId, projectId, projectRevision, segmentCount, segments } = value
  if (typeof contractVersion !== 'string' || typeof requestId !== 'string') return null
  if (typeof projectId !== 'string' || typeof projectRevision !== 'number') return null
  if (typeof segmentCount !== 'number') return null
  if (!Array.isArray(segments)) return null

  const material = asMaterial(value.material)
  if (material === null) return null

  const parsedSegments: MaterialSegmentDto[] = []
  for (const item of segments) {
    const segment = asMaterialSegmentDto(item)
    if (segment === null) return null
    parsedSegments.push(segment)
  }

  // 契约 15.1：segmentCount 就是 segments 的条数，两侧不一致说明响应被截断/串包，整份丢弃
  if (segmentCount !== parsedSegments.length) return null

  return {
    contractVersion,
    requestId,
    projectId,
    projectRevision,
    material,
    segmentCount,
    segments: parsedSegments,
  }
}

/** 契约 14.3：逐块校验草稿候选 */
function asDraftBlock(value: unknown): UnderstandingDraft[UnderstandingBlockKind] | null {
  if (!Array.isArray(value)) return null

  const items: UnderstandingDraft[UnderstandingBlockKind] = []
  for (const raw of value) {
    if (!isPlainObject(raw)) return null
    const { itemId, text, sources } = raw
    if (typeof itemId !== 'string' || itemId === '') return null
    if (typeof text !== 'string') return null
    if (!Array.isArray(sources)) return null

    const parsedSources = []
    for (const source of sources) {
      if (!isPlainObject(source)) return null
      const { materialId, materialName, materialVersion, segmentId, startLine, endLine } = source
      if (typeof materialId !== 'string' || typeof materialName !== 'string') return null
      if (typeof materialVersion !== 'number' || typeof segmentId !== 'string') return null
      if (typeof startLine !== 'number' || typeof endLine !== 'number') return null
      parsedSources.push({ materialId, materialName, materialVersion, segmentId, startLine, endLine })
    }

    items.push({ itemId, text, sources: parsedSources })
  }

  return items
}

/** 契约 15.2：成功响应必需字段齐全，`source` 只可能是 model / fallback */
function asUnderstandingSuccess(value: unknown): MaterialsUnderstandingSuccess | null {
  if (!isPlainObject(value)) return null
  const { contractVersion, requestId, projectId, projectRevision, materialId, materialVersion } = value
  if (typeof contractVersion !== 'string' || typeof requestId !== 'string') return null
  if (typeof projectId !== 'string' || typeof projectRevision !== 'number') return null
  if (typeof materialId !== 'string' || typeof materialVersion !== 'number') return null
  if (typeof value.promptVersion !== 'string') return null

  const source = value.source
  if (source !== 'model' && source !== 'fallback') return null

  const fallbackReason = value.fallbackReason
  if (fallbackReason !== null && typeof fallbackReason !== 'string') return null

  const notice = value.notice
  if (notice !== null && typeof notice !== 'string') return null

  if (!isPlainObject(value.draft)) return null
  const draft = {} as UnderstandingDraft
  for (const block of UNDERSTANDING_BLOCK_ORDER) {
    const parsed = asDraftBlock(value.draft[block])
    if (parsed === null) return null
    draft[block] = parsed
  }

  return {
    contractVersion,
    requestId,
    projectId,
    projectRevision,
    materialId,
    materialVersion,
    promptVersion: value.promptVersion,
    source,
    fallbackReason: fallbackReason as AdvisorFallbackReason | null,
    notice: (notice ?? null) as string | null,
    draft,
  }
}

/* ------------------------------------------------------------ 失败构造 */

function httpFailureToError(cause: HttpFailureCause): AdvisorApiError {
  const causeMap: Record<HttpFailureCause, AdvisorErrorCause> = {
    http: 'http',
    timeout: 'timeout',
    network: 'network',
    aborted: 'aborted',
    'invalid-json': 'invalid-json',
  }
  const messageByCause: Record<HttpFailureCause, string> = {
    http: '后端返回了未预期的错误响应',
    timeout: '后端响应超时',
    network: '无法连接后端',
    aborted: '请求已取消',
    'invalid-json': '后端响应不是合法 JSON',
  }

  return {
    code: 'NETWORK_ERROR',
    message: messageByCause[cause],
    retryable: cause !== 'aborted',
    retryAfterSeconds: null,
    requestId: null,
    cause: causeMap[cause],
  }
}

/** 契约 4.5 / 16：只要 code 在契约码表内，就按契约失败响应处理 */
function contractFailureToError(data: unknown): AdvisorApiError | null {
  if (!isPlainObject(data)) return null
  if (!isAdvisorErrorCode(data.code)) return null

  const requestId = typeof data.requestId === 'string' ? data.requestId : null
  const message = typeof data.message === 'string' ? data.message : ''
  const retryable =
    typeof data.retryable === 'boolean' ? data.retryable : RETRYABLE_BY_CODE[data.code]
  const retryAfterSeconds = typeof data.retryAfterSeconds === 'number' ? data.retryAfterSeconds : null

  return {
    code: data.code,
    message,
    retryable,
    retryAfterSeconds,
    requestId,
    cause: 'http',
  }
}

/** 契约 4.7：三项身份对不上就整份丢弃 */
function isStale(
  success: { requestId: string; projectId: string; projectRevision: number },
  request: { requestId: string; projectId: string; projectRevision: number },
): boolean {
  return (
    success.requestId !== request.requestId ||
    success.projectId !== request.projectId ||
    success.projectRevision !== request.projectRevision
  )
}

function staleError(requestId: string): AdvisorApiError {
  console.warn('[materials] 丢弃过期响应：requestId / projectId / projectRevision 与本次请求不一致')
  return {
    code: 'STALE_RESPONSE',
    message: '该响应已过期，已丢弃',
    retryable: false,
    retryAfterSeconds: null,
    requestId,
    cause: 'stale-response',
  }
}

/* -------------------------------------------------------------- 主流程 */

export type MaterialApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AdvisorApiError }

export interface MaterialApiOptions {
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** 是否允许自动重试 1 次，默认 true（契约 15.4） */
  retry?: boolean
}

async function withRetry<T>(
  run: () => Promise<MaterialApiResult<T>>,
  options: MaterialApiOptions,
): Promise<MaterialApiResult<T>> {
  const retry = options.retry ?? true
  let result = await run()

  if (!result.ok && retry && result.error.retryable && !isAborted(options.signal)) {
    await delay(RETRY_DELAY_MS)
    if (!isAborted(options.signal)) result = await run()
  }

  return result
}

/** 契约 15.1：上传并解析一份材料。不抛异常，失败一律以 `{ ok: false, error }` 返回 */
export async function uploadMaterial(
  request: MaterialUploadRequest,
  options: MaterialApiOptions = {},
): Promise<MaterialApiResult<MaterialUploadSuccess>> {
  return withRetry(async () => {
    const result = await requestJson(MATERIALS_PATH, {
      method: 'POST',
      body: request,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })

    if (!result.ok) {
      if (result.cause === 'http') {
        const failure = contractFailureToError(result.data)
        if (failure !== null) {
          console.warn(`[materials] 后端返回契约错误：${failure.code}`)
          return { ok: false, error: failure }
        }
      }
      return { ok: false, error: httpFailureToError(result.cause) }
    }

    const success = asUploadSuccess(result.data)
    if (success === null) {
      console.warn('[materials] 上传响应不符合契约（缺少必需字段或字段类型不对）')
      return {
        ok: false,
        error: {
          ...httpFailureToError('invalid-json'),
          message: '后端响应不符合契约，已丢弃',
          cause: 'invalid-response',
        },
      }
    }

    if (isStale(success, request)) return { ok: false, error: staleError(success.requestId) }

    return { ok: true, data: success }
  }, options)
}

/** 契约 15.2：请求材料理解草稿。不抛异常，失败一律以 `{ ok: false, error }` 返回 */
export async function fetchMaterialUnderstanding(
  request: MaterialsUnderstandingRequest,
  options: MaterialApiOptions = {},
): Promise<MaterialApiResult<MaterialsUnderstandingSuccess>> {
  return withRetry(async () => {
    const result = await requestJson(MATERIALS_UNDERSTANDING_PATH, {
      method: 'POST',
      body: request,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })

    if (!result.ok) {
      if (result.cause === 'http') {
        const failure = contractFailureToError(result.data)
        if (failure !== null) {
          console.warn(`[materials] 后端返回契约错误：${failure.code}`)
          return { ok: false, error: failure }
        }
      }
      return { ok: false, error: httpFailureToError(result.cause) }
    }

    const success = asUnderstandingSuccess(result.data)
    if (success === null) {
      console.warn('[materials] 理解响应不符合契约（缺少必需字段或字段类型不对）')
      return {
        ok: false,
        error: {
          ...httpFailureToError('invalid-json'),
          message: '后端响应不符合契约，已丢弃',
          cause: 'invalid-response',
        },
      }
    }

    if (
      success.requestId !== request.requestId ||
      success.projectId !== request.projectId ||
      success.projectRevision !== request.projectRevision
    ) {
      return { ok: false, error: staleError(success.requestId) }
    }

    // 契约 4.7 + 14.5.3/4：草稿必须回给**本次请求的那份材料、那一个版本**。
    // 材料在请求期间被换版（同一 materialId 重新上传）时，identity 对不上就整份丢弃，
    // 否则会把旧版本的草稿写到新版本材料上。
    if (
      success.materialId !== request.material.materialId ||
      success.materialVersion !== request.material.version
    ) {
      console.warn('[materials] 丢弃过期响应：理解结果对应的材料或版本与本次请求不一致')
      return { ok: false, error: staleError(success.requestId) }
    }

    return { ok: true, data: success }
  }, options)
}

/** 契约 4.7：是否是"过期响应"（是则静默丢弃，不提示用户） */
export function isStaleMaterialResponse(error: AdvisorApiError): boolean {
  return error.code === 'STALE_RESPONSE'
}
