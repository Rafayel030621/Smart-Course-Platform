/**
 * V3 统一错误码与响应结构（docs/contracts.md 第 25 节）
 * ----------------------------------------------------------------------------
 * 所有 V3 接口只抛 V3Error；HTTP 层统一转换为契约失败响应。
 * message 是可直接展示的中文，不包含字段名、路径、SQL、堆栈或模型原文。
 */

export const V3_CONTRACT_VERSION = '3.0'

export type V3ErrorCode =
  | 'INVALID_INPUT'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'UNAUTHORIZED'
  | 'AUTH_FAILED'
  | 'REGISTER_REJECTED'
  | 'FORBIDDEN_ORIGIN'
  | 'RATE_LIMITED'
  | 'PROJECT_NOT_FOUND'
  | 'RESOURCE_NOT_FOUND'
  | 'PROJECT_MISMATCH'
  | 'STALE_REVISION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ORDER'
  | 'MILESTONE_NAME_CONFLICT'
  | 'MILESTONE_ARCHIVED'
  | 'MILESTONE_COMPLETED'
  | 'MILESTONE_NOT_EMPTY'
  | 'INVALID_STATE_TRANSITION'
  | 'DRAFT_ITEM_ARCHIVED'
  | 'TASK_ARCHIVED'
  | 'TASK_NOT_CLAIMABLE'
  | 'EVIDENCE_IMMUTABLE'
  | 'CONFIRMATION_REQUIRED'
  | 'CANDIDATE_EXPIRED'
  | 'UNCONFIRMED_MATERIAL'
  | 'MATERIAL_VERSION_OUTDATED'
  | 'UNSUPPORTED_MATERIAL_TYPE'
  | 'MATERIAL_TOO_LARGE'
  | 'EMPTY_MATERIAL'
  | 'MATERIAL_ENCODING_UNREADABLE'
  | 'MATERIAL_PARSE_FAILED'
  | 'MIGRATION_NOT_CONFIRMED'
  | 'MIGRATION_CONFIRMATION_EXPIRED'
  | 'MIGRATION_VERSION_UNSUPPORTED'
  | 'MIGRATION_DATA_OUTDATED'
  | 'MIGRATION_INVALID_DATA'
  | 'MIGRATION_TOO_LARGE'
  | 'INTERNAL'

interface ErrorMeta {
  status: number
  retryable: boolean
  message: string
}

export const V3_ERROR_META: Record<V3ErrorCode, ErrorMeta> = {
  INVALID_INPUT: { status: 400, retryable: false, message: '请求内容不合法' },
  CONTRACT_VERSION_MISMATCH: {
    status: 400,
    retryable: false,
    message: '请求版本与接口不匹配，请刷新页面后重试',
  },
  UNAUTHORIZED: { status: 401, retryable: false, message: '登录状态已失效，请重新登录' },
  AUTH_FAILED: { status: 401, retryable: false, message: '用户名或密码不正确' },
  REGISTER_REJECTED: {
    status: 409,
    retryable: false,
    message: '注册未完成，请检查用户名、密码和邀请码',
  },
  FORBIDDEN_ORIGIN: { status: 403, retryable: false, message: '请求来源不受信任' },
  RATE_LIMITED: { status: 429, retryable: true, message: '尝试次数过多，请稍后再试' },
  PROJECT_NOT_FOUND: { status: 404, retryable: false, message: '项目不存在或无权访问' },
  RESOURCE_NOT_FOUND: { status: 404, retryable: false, message: '请求的内容不存在或无权访问' },
  PROJECT_MISMATCH: { status: 409, retryable: false, message: '请求内容与当前项目不匹配' },
  STALE_REVISION: { status: 409, retryable: false, message: '项目内容已更新，请刷新后重试' },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    retryable: false,
    message: '重复请求的内容不一致，请刷新后重试',
  },
  INVALID_ORDER: { status: 400, retryable: false, message: '阶段顺序不完整，请刷新后重试' },
  MILESTONE_NAME_CONFLICT: { status: 409, retryable: false, message: '同一项目中已有同名阶段' },
  MILESTONE_ARCHIVED: { status: 409, retryable: false, message: '该阶段已归档，请先恢复' },
  MILESTONE_COMPLETED: { status: 409, retryable: false, message: '该阶段已完成，请先重新打开' },
  MILESTONE_NOT_EMPTY: {
    status: 409,
    retryable: false,
    message: '该阶段下仍有内容，不能直接删除，请改为归档',
  },
  INVALID_STATE_TRANSITION: { status: 409, retryable: false, message: '当前状态不支持该操作' },
  DRAFT_ITEM_ARCHIVED: {
    status: 409,
    retryable: false,
    message: '这条理解已移除，不能恢复或再次确认，请重新生成',
  },
  TASK_ARCHIVED: { status: 409, retryable: false, message: '该任务已归档，请先恢复' },
  TASK_NOT_CLAIMABLE: { status: 409, retryable: false, message: '该任务已完成' },
  EVIDENCE_IMMUTABLE: { status: 409, retryable: false, message: '证据提交后不能修改正文' },
  CONFIRMATION_REQUIRED: { status: 400, retryable: false, message: '请先确认候选阶段，再创建' },
  CANDIDATE_EXPIRED: { status: 409, retryable: false, message: '候选阶段已过期，请重新生成' },
  UNCONFIRMED_MATERIAL: { status: 400, retryable: false, message: '所选材料尚未确认，不能作为 AI 依据' },
  MATERIAL_VERSION_OUTDATED: {
    status: 409,
    retryable: false,
    message: '材料已更新，请重新生成理解草稿',
  },
  UNSUPPORTED_MATERIAL_TYPE: {
    status: 400,
    retryable: false,
    message: '当前只支持 md、txt 文件；CSV、XLSX 将在下一批支持，PDF、DOCX、ZIP 将在后续版本支持',
  },
  MATERIAL_TOO_LARGE: { status: 400, retryable: false, message: '文件超过 1 MB 上限，请压缩或拆分后再上传' },
  EMPTY_MATERIAL: { status: 400, retryable: false, message: '文件内容为空，请检查后再上传' },
  MATERIAL_ENCODING_UNREADABLE: {
    status: 400,
    retryable: false,
    message: '文件编码无法识别（已尝试 UTF-8 与 GBK），请另存为 UTF-8 后重试',
  },
  MATERIAL_PARSE_FAILED: { status: 400, retryable: false, message: '材料解析失败，请检查文件内容后重试' },
  MIGRATION_NOT_CONFIRMED: { status: 400, retryable: false, message: '请先在页面上确认迁移，再继续' },
  MIGRATION_CONFIRMATION_EXPIRED: {
    status: 400,
    retryable: false,
    message: '迁移确认已过期，请重新确认后重试',
  },
  MIGRATION_VERSION_UNSUPPORTED: {
    status: 409,
    retryable: false,
    message: '本地数据来自更高版本，请刷新页面或升级后再迁移',
  },
  MIGRATION_DATA_OUTDATED: {
    status: 409,
    retryable: false,
    message: '本地数据版本过旧，无法自动迁移；请先导出备份，再联系管理员',
  },
  MIGRATION_INVALID_DATA: {
    status: 400,
    retryable: false,
    message: '本地数据不完整或存在重复记录，迁移未执行；请导出备份后重试',
  },
  MIGRATION_TOO_LARGE: {
    status: 413,
    retryable: false,
    message: '本地数据超过迁移上限，请先清理聊天或材料后重试',
  },
  INTERNAL: { status: 500, retryable: true, message: '服务内部错误，请稍后重试' },
}

export interface V3ErrorOptions {
  detail?: string
  projectId?: string | null
  currentProjectRevision?: number | null
  currentEntityRevision?: number | null
  retryAfterSeconds?: number | null
  details?: Record<string, unknown> | null
}

export class V3Error extends Error {
  readonly code: V3ErrorCode
  readonly status: number
  readonly retryable: boolean
  readonly detail: string | null
  readonly projectId: string | null
  readonly currentProjectRevision: number | null
  readonly currentEntityRevision: number | null
  readonly retryAfterSeconds: number | null
  readonly details: Record<string, unknown> | null

  constructor(code: V3ErrorCode, options: V3ErrorOptions = {}) {
    const meta = V3_ERROR_META[code]
    super(meta.message)
    this.name = 'V3Error'
    this.code = code
    this.status = meta.status
    this.retryable = meta.retryable
    this.detail = options.detail ?? null
    this.projectId = options.projectId ?? null
    this.currentProjectRevision = options.currentProjectRevision ?? null
    this.currentEntityRevision = options.currentEntityRevision ?? null
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
    this.details = options.details ?? null
  }

  /** 对外文案：INVALID_INPUT 可带一条安全的具体问题，其余只使用固定文案 */
  get publicMessage(): string {
    if (this.code === 'INVALID_INPUT' && this.detail !== null && this.detail !== '') {
      return `${V3_ERROR_META.INVALID_INPUT.message}：${this.detail}`
    }
    return V3_ERROR_META[this.code].message
  }
}

export function invalidInput(detail: string): V3Error {
  return new V3Error('INVALID_INPUT', { detail })
}

export function staleRevision(options: {
  projectId?: string | null
  currentProjectRevision?: number | null
  currentEntityRevision?: number | null
}): V3Error {
  return new V3Error('STALE_REVISION', options)
}

export interface V3FailureBody {
  contractVersion: string
  requestId: string | null
  projectId: string | null
  code: V3ErrorCode
  message: string
  retryable: boolean
  retryAfterSeconds: number | null
  currentProjectRevision: number | null
  currentEntityRevision: number | null
  details: Record<string, unknown> | null
}

export function toFailureBody(
  error: V3Error,
  requestId: string | null,
  projectId: string | null,
): V3FailureBody {
  return {
    contractVersion: V3_CONTRACT_VERSION,
    requestId,
    projectId: error.projectId ?? projectId,
    code: error.code,
    message: error.publicMessage,
    retryable: error.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
    currentProjectRevision: error.currentProjectRevision,
    currentEntityRevision: error.currentEntityRevision,
    details: error.details,
  }
}
