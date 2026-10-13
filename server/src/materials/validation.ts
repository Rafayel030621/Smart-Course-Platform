import { CONTRACT_VERSION } from '../advisor/types.js'
import { extractRequestId } from '../advisor/validation.js'
import { MAX_SEGMENT_CHARS, parseText } from './parseText.js'
import {
  MATERIAL_ERROR_MESSAGES,
  MATERIAL_UNDERSTANDING_PROMPT_VERSION,
  type MaterialEncoding,
  type MaterialRejectionCode,
  type MaterialsUnderstandingInput,
  type MaterialType,
  type MaterialUploadInput,
  type UnderstandingSegmentInput,
} from './types.js'

/**
 * 材料接口的请求校验（契约 15.1 / 15.2）
 * ----------------------------------------------------------------------------
 * 两个入口：
 *   1. parseMaterialUploadRequest        —— POST /api/materials：字段 + base64 + 编码 + 内容特征 + 分段；
 *   2. parseMaterialsUnderstandingRequest —— POST /api/materials/understanding：字段 + 片段上限。
 *
 * 校验顺序固定（契约 15.1），测试与反例按这个顺序构造。
 * 任何情况下都不补默认值；错误响应不回显材料正文。
 */

export const MATERIAL_LIMITS = {
  /** 上传请求体上限：1 MB 文件的 base64 约 1.37 MB，留出余量（契约 15.4） */
  uploadBodyBytes: 2 * 1024 * 1024,
  /** 理解请求体上限：沿用 4.0 的 256 KB */
  understandingBodyBytes: 256 * 1024,
  /** 单份材料大小：按解码后的原始字节数判断，不看 base64 字符串长度 */
  maxFileBytes: 1_048_576,
  nameLength: 200,
  idLength: 64,
  materialIdPrefix: 'mat_',
  projectNameLength: 120,
  /** 理解接口的片段上限（契约 15.2） */
  segments: 100,
  segmentIdLength: 64,
  segmentTextLength: MAX_SEGMENT_CHARS,
  totalTextChars: 24_000,
} as const

export interface MaterialParseSuccess {
  ok: true
  value: MaterialUploadInput
}

export interface UnderstandingParseSuccess {
  ok: true
  value: MaterialsUnderstandingInput
}

export interface MaterialParseFailure {
  ok: false
  /** 能取到就回显，取不到就是 null（契约 4.5） */
  requestId: string | null
  code: MaterialRejectionCode
  message: string
}

export type MaterialParseResult = MaterialParseSuccess | MaterialParseFailure
export type UnderstandingParseResult = UnderstandingParseSuccess | MaterialParseFailure

/* ------------------------------------------------------------ 字段读取 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidInput(requestId: string | null, issue: string): MaterialParseFailure {
  return {
    ok: false,
    requestId,
    code: 'INVALID_INPUT',
    message: `${MATERIAL_ERROR_MESSAGES.INVALID_INPUT}：${issue}`,
  }
}

function reject(requestId: string | null, code: MaterialRejectionCode): MaterialParseFailure {
  return { ok: false, requestId, code, message: MATERIAL_ERROR_MESSAGES[code] }
}

function readStringField(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
  issues: string[],
  path = key,
): string | undefined {
  const value = source[key]
  if (value === undefined) {
    issues.push(`${path} 缺失`)
    return undefined
  }
  if (typeof value !== 'string') {
    issues.push(`${path} 必须是字符串`)
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    issues.push(`${path} 不能为空`)
    return undefined
  }
  if (trimmed.length > maxLength) {
    issues.push(`${path} 超过长度上限 ${maxLength}`)
    return undefined
  }
  return trimmed
}

function readPositiveInteger(
  source: Record<string, unknown>,
  key: string,
  issues: string[],
  path = key,
): number | undefined {
  const value = source[key]
  if (value === undefined) {
    issues.push(`${path} 缺失`)
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    issues.push(`${path} 必须是 ≥ 1 的整数`)
    return undefined
  }
  return value
}

/* ------------------------------------------------------ 文件内容校验 */

/** 严格的 base64：长度是 4 的倍数、字符集合法、且解码再编码后与输入完全一致 */
export function decodeBase64Strict(raw: string): Buffer | null {
  const value = raw.trim()
  if (value === '' || value.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null

  const bytes = Buffer.from(value, 'base64')
  return bytes.toString('base64') === value ? bytes : null
}

function decodeStrict(bytes: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * GBK 结构校验：部分运行时对 GBK 的 fatal 解码不生效（非法字节会被静默丢弃），
 * 因此在交给 TextDecoder 之前先按 GBK 字节结构判断：
 *   单字节 0x00-0x7F；双字节 首字节 0x81-0xFE、尾字节 0x40-0xFE（剔除 0x7F）。
 * 只判断结构，不做字符映射。
 */
export function isValidGbkBytes(bytes: Buffer): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (byte <= 0x7f) continue
    if (byte < 0x81 || byte > 0xfe) return false

    const trail = bytes[index + 1]
    if (trail === undefined) return false
    if (trail < 0x40 || trail > 0xfe || trail === 0x7f) return false
    index += 1
  }
  return true
}

/**
 * 编码识别：UTF-8 优先（严格解码），失败回退 GBK（严格解码）；都失败返回 null。
 * 解出替换字符（U+FFFD）视为对应编码不成立——这能兜住部分运行时对 GBK 不启用 fatal 的情况。
 */
export function decodeMaterialText(bytes: Buffer): { encoding: MaterialEncoding; text: string } | null {
  const utf8 = decodeStrict(bytes, 'utf-8')
  if (utf8 !== null && !utf8.includes('\uFFFD')) {
    return { encoding: 'utf-8', text: stripBom(utf8) }
  }

  if (!isValidGbkBytes(bytes)) return null

  const gbk = decodeStrict(bytes, 'gbk')
  if (gbk !== null && !gbk.includes('\uFFFD')) {
    return { encoding: 'gbk', text: stripBom(gbk) }
  }

  return null
}

/** 按文件名扩展名推导材料类型；本轮白名单只有 .md 与 .txt（不区分大小写） */
export function materialTypeFromName(name: string): MaterialType | null {
  const lower = name.trim().toLowerCase()
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.txt')) return 'txt'
  return null
}

/* ---------------------------------------------------------- 上传接口 */

export function parseMaterialUploadRequest(body: unknown): MaterialParseResult {
  if (!isPlainObject(body)) return invalidInput(null, '请求体必须是一个 JSON 对象')

  const requestId = extractRequestId(body)
  const issues: string[] = []

  if (body.contractVersion !== CONTRACT_VERSION) {
    issues.push(`contractVersion 必须是 "${CONTRACT_VERSION}"`)
  }
  if (requestId === null) {
    issues.push('requestId 缺失或不是合法字符串')
  }

  const projectId = readStringField(body, 'projectId', MATERIAL_LIMITS.idLength, issues)
  const projectRevision = readPositiveInteger(body, 'projectRevision', issues)
  const materialId = readStringField(body, 'materialId', MATERIAL_LIMITS.idLength, issues)
  if (materialId !== undefined && !materialId.startsWith(MATERIAL_LIMITS.materialIdPrefix)) {
    issues.push(`materialId 必须以 "${MATERIAL_LIMITS.materialIdPrefix}" 开头`)
  }
  const version = readPositiveInteger(body, 'version', issues)
  const name = readStringField(body, 'name', MATERIAL_LIMITS.nameLength, issues)

  // contentBase64 单独读取：允许空串（空文件按 EMPTY_MATERIAL 处理，契约 15.1 第 7 步）
  const rawContentBase64 = body.contentBase64
  let contentBase64: string | undefined
  if (rawContentBase64 === undefined) {
    issues.push('contentBase64 缺失')
  } else if (typeof rawContentBase64 !== 'string') {
    issues.push('contentBase64 必须是字符串')
  } else if (rawContentBase64.trim().length > MATERIAL_LIMITS.uploadBodyBytes) {
    issues.push(`contentBase64 超过长度上限 ${MATERIAL_LIMITS.uploadBodyBytes}`)
  } else {
    contentBase64 = rawContentBase64.trim()
  }

  if (issues.length > 0) return invalidInput(requestId, issues[0])

  // 3. 扩展名白名单
  const type = materialTypeFromName(name as string)
  if (type === null) return reject(requestId, 'UNSUPPORTED_MATERIAL_TYPE')

  // 4. base64 与大小（大小按解码后的字节数，不看 base64 字符串长度）
  const bytes =
    (contentBase64 as string) === '' ? Buffer.alloc(0) : decodeBase64Strict(contentBase64 as string)
  if (bytes === null) return invalidInput(requestId, 'contentBase64 不是合法的 base64')
  if (bytes.length > MATERIAL_LIMITS.maxFileBytes) return reject(requestId, 'MATERIAL_TOO_LARGE')

  // 5. 编码：UTF-8 优先，失败回退 GBK
  const decoded = decodeMaterialText(bytes)
  if (decoded === null) return reject(requestId, 'MATERIAL_ENCODING_UNREADABLE')

  // 6. 内容特征：含 NUL 判为二进制内容
  if (decoded.text.includes('\u0000')) return reject(requestId, 'UNSUPPORTED_MATERIAL_TYPE')

  // 7. 空文件
  if (decoded.text.trim() === '') return reject(requestId, 'EMPTY_MATERIAL')

  // 8. 分段（必须确定性）
  let segments: ReturnType<typeof parseText>
  try {
    segments = parseText(decoded.text)
  } catch {
    return reject(requestId, 'MATERIAL_PARSE_FAILED')
  }
  if (segments.length === 0) return reject(requestId, 'MATERIAL_PARSE_FAILED')

  return {
    ok: true,
    value: {
      requestId: requestId as string,
      projectId: projectId as string,
      projectRevision: projectRevision as number,
      materialId: materialId as string,
      version: version as number,
      name: name as string,
      type,
      size: bytes.length,
      encoding: decoded.encoding,
      segments,
    },
  }
}

/* -------------------------------------------------------- 理解接口 */

function parseMaterialObject(
  raw: Record<string, unknown>,
  issues: string[],
): MaterialsUnderstandingInput['material'] | undefined {
  const materialId = readStringField(raw, 'materialId', MATERIAL_LIMITS.idLength, issues)
  const name = readStringField(raw, 'name', MATERIAL_LIMITS.nameLength, issues)
  const type = readStringField(raw, 'type', 8, issues)
  const version = readPositiveInteger(raw, 'version', issues)

  const expectedType = name === undefined ? null : materialTypeFromName(name)
  if (type !== undefined && type !== 'md' && type !== 'txt') {
    issues.push('material.type 必须是 md / txt 之一')
  }
  if (name !== undefined && expectedType === null) {
    issues.push('material.name 必须是 .md 或 .txt 文件名')
  }
  if (type !== undefined && expectedType !== null && type !== expectedType) {
    issues.push('material.type 必须与 name 的扩展名一致')
  }

  const segmentsRaw = raw.segments
  const segments: UnderstandingSegmentInput[] = []

  if (segmentsRaw === undefined) {
    issues.push('material.segments 缺失')
  } else if (!Array.isArray(segmentsRaw)) {
    issues.push('material.segments 必须是数组')
  } else if (segmentsRaw.length === 0) {
    issues.push('material.segments 至少 1 条')
  } else if (segmentsRaw.length > MATERIAL_LIMITS.segments) {
    issues.push(`material.segments 最多 ${MATERIAL_LIMITS.segments} 条`)
  } else {
    let totalChars = 0
    // segmentId 必须在本次请求内唯一：不依赖后续 Map 的"后写覆盖"，重复直接拒绝（契约 15.2）
    const seenSegmentIds = new Set<string>()
    segmentsRaw.forEach((item, index) => {
      const path = `material.segments[${index}]`
      if (!isPlainObject(item)) {
        issues.push(`${path} 必须是对象`)
        return
      }
      const segmentId = readStringField(
        item,
        'segmentId',
        MATERIAL_LIMITS.segmentIdLength,
        issues,
        `${path}.segmentId`,
      )
      const text = readStringField(item, 'text', MATERIAL_LIMITS.segmentTextLength, issues, `${path}.text`)
      const startLine = readPositiveInteger(item, 'startLine', issues, `${path}.startLine`)
      const endLine = readPositiveInteger(item, 'endLine', issues, `${path}.endLine`)
      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        issues.push(`${path}.endLine 不能小于 startLine`)
        return
      }
      if (segmentId === undefined || text === undefined || startLine === undefined || endLine === undefined)
        return

      if (seenSegmentIds.has(segmentId)) {
        issues.push(`${path}.segmentId 与前面的片段重复，同一份材料内 segmentId 必须唯一`)
        return
      }
      seenSegmentIds.add(segmentId)

      segments.push({ segmentId, startLine, endLine, text })
      totalChars += text.length
    })

    if (totalChars > MATERIAL_LIMITS.totalTextChars) {
      issues.push(`material.segments 的文本合计最多 ${MATERIAL_LIMITS.totalTextChars} 字`)
    }
  }

  if (materialId === undefined || name === undefined || type === undefined || version === undefined) {
    return undefined
  }
  if (segments.length === 0) return undefined

  return { materialId, name, type: type as MaterialType, version, segments }
}

export function parseMaterialsUnderstandingRequest(body: unknown): UnderstandingParseResult {
  if (!isPlainObject(body)) return invalidInput(null, '请求体必须是一个 JSON 对象')

  const requestId = extractRequestId(body)
  const issues: string[] = []

  if (body.contractVersion !== CONTRACT_VERSION) {
    issues.push(`contractVersion 必须是 "${CONTRACT_VERSION}"`)
  }
  if (requestId === null) {
    issues.push('requestId 缺失或不是合法字符串')
  }

  const promptVersion = readStringField(body, 'promptVersion', MATERIAL_LIMITS.idLength, issues)
  if (promptVersion !== undefined && promptVersion !== MATERIAL_UNDERSTANDING_PROMPT_VERSION) {
    issues.push(`promptVersion 必须是 "${MATERIAL_UNDERSTANDING_PROMPT_VERSION}"`)
  }

  const projectId = readStringField(body, 'projectId', MATERIAL_LIMITS.idLength, issues)
  const projectRevision = readPositiveInteger(body, 'projectRevision', issues)

  // projectName 必填可空
  let projectName: string | null | undefined
  const rawProjectName = body.projectName
  if (rawProjectName === undefined) {
    issues.push('projectName 缺失')
  } else if (rawProjectName === null) {
    projectName = null
  } else if (typeof rawProjectName !== 'string') {
    issues.push('projectName 必须是字符串或 null')
  } else {
    const trimmed = rawProjectName.trim()
    if (trimmed.length > MATERIAL_LIMITS.projectNameLength) {
      issues.push(`projectName 超过长度上限 ${MATERIAL_LIMITS.projectNameLength}`)
    } else {
      projectName = trimmed === '' ? null : trimmed
    }
  }

  const materialRaw = body.material
  let material: MaterialsUnderstandingInput['material'] | undefined
  if (materialRaw === undefined) {
    issues.push('material 缺失')
  } else if (!isPlainObject(materialRaw)) {
    issues.push('material 必须是对象')
  } else {
    material = parseMaterialObject(materialRaw, issues)
  }

  if (issues.length > 0) return invalidInput(requestId, issues[0])

  return {
    ok: true,
    value: {
      requestId: requestId as string,
      projectId: projectId as string,
      projectRevision: projectRevision as number,
      projectName: projectName as string | null,
      promptVersion: promptVersion as string,
      material: material as MaterialsUnderstandingInput['material'],
    },
  }
}
