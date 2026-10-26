import type { AdvisorFallbackReason } from '../advisor/types.js'

/**
 * 材料领域类型（M2-A）
 * ----------------------------------------------------------------------------
 * 与 HTTP 无关：路由层、校验层、解析层、理解层都只通过这些类型通信。
 * 字段名与 docs/contracts.md 第 14 / 15 / 16 节逐字一致；本轮只支持 md / txt。
 */

/** 材料理解接口本轮唯一支持的提示词版本（契约 17.4） */
export const MATERIAL_UNDERSTANDING_PROMPT_VERSION = 'material-understanding-v1'
export const MATERIAL_UNDERSTANDING_V3_PROMPT_VERSION = 'material-understanding-v3'

export type MaterialType = 'md' | 'txt'
export type MaterialEncoding = 'utf-8' | 'gbk'
export type MaterialState = 'parsed' | 'parse_failed'

/** 材料被拒绝时的稳定错误码（契约第 16 节） */
export type MaterialRejectionCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_MATERIAL_TYPE'
  | 'MATERIAL_TOO_LARGE'
  | 'EMPTY_MATERIAL'
  | 'MATERIAL_ENCODING_UNREADABLE'
  | 'MATERIAL_PARSE_FAILED'

/** 材料接口运行期可能返回的全部错误码（含模型相关码与保留码） */
export type MaterialRuntimeErrorCode =
  | MaterialRejectionCode
  | 'RATE_LIMITED'
  | 'MODEL_TIMEOUT'
  | 'INVALID_MODEL_OUTPUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_NOT_CONFIGURED'
  | 'INTERNAL'

/** 对外中文文案：只描述问题与用户能做什么，不含内部信息（契约 16 节约定 2） */
export const MATERIAL_ERROR_MESSAGES: Record<MaterialRuntimeErrorCode, string> = {
  INVALID_INPUT: '请求内容不合法',
  UNSUPPORTED_MATERIAL_TYPE:
    '当前只支持 md、txt 文件；CSV、XLSX 将在下一批支持，PDF、DOCX、ZIP 将在后续版本支持',
  MATERIAL_TOO_LARGE: '文件超过 1 MB 上限，请压缩或拆分后再上传',
  EMPTY_MATERIAL: '文件内容为空，请检查后再上传',
  MATERIAL_ENCODING_UNREADABLE: '文件编码无法识别（已尝试 UTF-8 与 GBK），请另存为 UTF-8 后重试',
  MATERIAL_PARSE_FAILED: '材料解析失败，请检查文件内容后重试',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  MODEL_TIMEOUT: '模型调用超时，材料已保留，请稍后重试',
  INVALID_MODEL_OUTPUT: '模型返回内容不合法，请稍后重试',
  MODEL_UNAVAILABLE: '模型服务暂不可用，请稍后重试',
  MODEL_NOT_CONFIGURED: '服务端未配置模型密钥，暂时无法生成理解草稿',
  INTERNAL: '服务内部错误，请稍后重试',
}

export const MATERIAL_STATUS_BY_CODE: Record<MaterialRuntimeErrorCode, number> = {
  INVALID_INPUT: 400,
  UNSUPPORTED_MATERIAL_TYPE: 400,
  MATERIAL_TOO_LARGE: 400,
  EMPTY_MATERIAL: 400,
  MATERIAL_ENCODING_UNREADABLE: 400,
  MATERIAL_PARSE_FAILED: 400,
  RATE_LIMITED: 429,
  MODEL_TIMEOUT: 504,
  INVALID_MODEL_OUTPUT: 502,
  MODEL_UNAVAILABLE: 503,
  MODEL_NOT_CONFIGURED: 503,
  INTERNAL: 500,
}

/** retryable 的含义与契约 6.1 相同：用户不改变输入时，稍后重试有可能成功 */
export const MATERIAL_RETRYABLE_BY_CODE: Record<MaterialRuntimeErrorCode, boolean> = {
  INVALID_INPUT: false,
  UNSUPPORTED_MATERIAL_TYPE: false,
  MATERIAL_TOO_LARGE: false,
  EMPTY_MATERIAL: false,
  MATERIAL_ENCODING_UNREADABLE: false,
  MATERIAL_PARSE_FAILED: false,
  RATE_LIMITED: true,
  MODEL_TIMEOUT: true,
  INVALID_MODEL_OUTPUT: true,
  MODEL_UNAVAILABLE: true,
  MODEL_NOT_CONFIGURED: false,
  INTERNAL: true,
}

/* ---------------------------------------------------------------- 领域对象 */

export interface MaterialSegment {
  segmentId: string
  index: number
  startLine: number
  endLine: number
  text: string
}

export interface MaterialMetadata {
  materialId: string
  projectId: string
  name: string
  type: MaterialType
  /** 解码后的原始字节数（不是 base64 字符串长度） */
  size: number
  encoding: MaterialEncoding
  state: MaterialState
  version: number
  createdAt: string
  updatedAt: string
  failureReason: string | null
}

/* ------------------------------------------------------------ 请求侧（线） */

export interface MaterialUploadInput {
  requestId: string
  projectId: string
  projectRevision: number
  materialId: string
  version: number
  name: string
  /** 由文件扩展名推导，统一小写 */
  type: MaterialType
  size: number
  encoding: MaterialEncoding
  segments: MaterialSegment[]
}

export interface UnderstandingSegmentInput {
  segmentId: string
  startLine: number
  endLine: number
  text: string
}

export interface UnderstandingMaterialInput {
  materialId: string
  name: string
  type: MaterialType
  version: number
  segments: UnderstandingSegmentInput[]
}

export interface MaterialsUnderstandingInput {
  requestId: string
  projectId: string
  projectRevision: number
  projectName: string | null
  promptVersion: string
  material: UnderstandingMaterialInput
}

/** V3 多材料理解：每个材料都由门禁用数据库权威内容回填后再进入服务层 */
export interface MaterialsUnderstandingV3Input {
  requestId: string
  projectId: string
  projectRevision: number
  projectName: string | null
  promptVersion: string
  materials: UnderstandingMaterialInput[]
}

/* ------------------------------------------------------------ 理解草稿 */

export interface MaterialSourceRef {
  materialId: string
  materialName: string
  materialVersion: number
  segmentId: string
  startLine: number
  endLine: number
}

export interface DraftItem {
  itemId: string
  text: string
  sources: MaterialSourceRef[]
}

/** 五块候选 + 待确认问题；行号与材料名一律由服务端按 segmentId 回填（契约 14.3） */
export interface UnderstandingDraft {
  goalCandidates: DraftItem[]
  outcomeCandidates: DraftItem[]
  dataNotes: DraftItem[]
  methodNotes: DraftItem[]
  openQuestions: DraftItem[]
}

export function emptyUnderstandingDraft(): UnderstandingDraft {
  return {
    goalCandidates: [],
    outcomeCandidates: [],
    dataNotes: [],
    methodNotes: [],
    openQuestions: [],
  }
}

/* ------------------------------------------------------------ 服务层结果 */

export interface MaterialsUnderstandingSuccess {
  ok: true
  source: 'model' | 'fallback'
  /** 只有 fallback 时非空 */
  fallbackReason: AdvisorFallbackReason | null
  /** fallback 时的中文说明；model 成功时为 null */
  notice: string | null
  draft: UnderstandingDraft
}

export interface MaterialsUnderstandingFailure {
  ok: false
  code: MaterialRuntimeErrorCode
  retryable: boolean
  retryAfterSeconds: number | null
}

export type MaterialsUnderstandingResult = MaterialsUnderstandingSuccess | MaterialsUnderstandingFailure

/** 失败响应体（契约 4.5 的同一结构） */
export interface MaterialsFailureResponse {
  contractVersion: string
  requestId: string | null
  code: MaterialRuntimeErrorCode
  message: string
  retryable: boolean
  retryAfterSeconds: number | null
}
