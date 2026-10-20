/**
 * V3/V4 契约 HTTP 适配层（docs/contracts.md v3.3）
 * ----------------------------------------------------------------------------
 * 只做四件事：
 *   1. 统一 `credentials: 'include'`（Cookie 会话由浏览器管理，前端不读取令牌）；
 *   2. 校验 20.1 响应包络与 `contractVersion`；
 *   3. 把服务端错误码映射为稳定的中文提示；
 *   4. 生成满足 20.2 的 requestId / idempotencyKey。
 *
 * 这里不判断“当前用户/当前项目”是否已经切换；那属于 store 的职责，
 * store 会用 expectedProjectId / expectedRevision 再校验并在必要时丢弃过期响应。
 */
import { requestJson, type HttpFailureCause } from './http'
import { V3_CONTRACT_VERSION } from '@/types/platform'

export type V3ErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RESOURCE_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ARCHIVED'
  | 'PROJECT_DELETED'
  | 'PROJECT_REVISION_MISMATCH'
  | 'MILESTONE_REVISION_MISMATCH'
  | 'TASK_REVISION_MISMATCH'
  | 'EVIDENCE_REVISION_MISMATCH'
  | 'MILESTONE_NAME_CONFLICT'
  | 'MILESTONE_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'EVIDENCE_NOT_FOUND'
  | 'INVALID_MILESTONE_ORDER'
  | 'INVALID_TASK_TRANSITION'
  | 'TASK_NOT_COMPLETED'
  | 'PROJECT_MISMATCH'
  | 'ALREADY_LINKED'
  | 'DUPLICATE_PROGRESS'
  | 'MIGRATION_IN_PROGRESS'
  | 'MIGRATION_INVALID_DATA'
  | 'MIGRATION_ID_CONFLICT'
  | 'MIGRATION_SOURCE_EXPIRED'
  | 'MIGRATION_SCHEMA_UNSUPPORTED'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL'
  /** 本地扩展：网络层、超时、取消、响应结构异常、过期响应 */
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'
  | 'STALE_RESPONSE'
  /** 本地扩展：调用前校验失败，不发请求 */
  | 'INVALID_INPUT'
  | 'MISSING_CONTRACT'

/** 契约 25.2 中文提示 + 本地扩展；UI 只展示这里的中文，不直接展示 code */
export const V3_ERROR_MESSAGES: Record<string, string> = {
  INVALID_JSON: '请求格式不正确',
  INVALID_REQUEST: '请求内容不合法，请检查后重试',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  FORBIDDEN: '没有权限执行该操作',
  RESOURCE_NOT_FOUND: '请求的资源不存在或已被删除',
  PROJECT_NOT_FOUND: '项目不存在或已被删除',
  PROJECT_ARCHIVED: '项目已归档，请先恢复',
  PROJECT_DELETED: '项目已删除',
  PROJECT_REVISION_MISMATCH: '项目内容已更新，请刷新后重试',
  STALE_REVISION: '项目内容已更新，请刷新后重试',
  MILESTONE_REVISION_MISMATCH: '阶段已更新，请刷新后重试',
  TASK_REVISION_MISMATCH: '任务已更新，请刷新后重试',
  EVIDENCE_REVISION_MISMATCH: '证据已更新，请刷新后重试',
  MILESTONE_NAME_CONFLICT: '同一项目中已有同名阶段',
  MILESTONE_NOT_FOUND: '阶段不存在或不属于该项目',
  MILESTONE_ARCHIVED: '该阶段已归档，请先恢复',
  MILESTONE_COMPLETED: '该阶段已完成，请先重新打开',
  MILESTONE_NOT_EMPTY: '阶段下还有未完成任务，无法归档',
  TASK_NOT_FOUND: '任务不存在或不属于该项目',
  TASK_ARCHIVED: '该任务已归档，请先恢复',
  TASK_NOT_CLAIMABLE: '该任务已完成',
  TASK_NOT_COMPLETED: '任务尚未完成，无法提交进展',
  EVIDENCE_NOT_FOUND: '证据不存在或不属于该项目',
  EVIDENCE_IMMUTABLE: '证据提交后不能修改正文',
  INVALID_MILESTONE_ORDER: '阶段顺序不合法，请刷新后重试',
  INVALID_ORDER: '阶段顺序不完整，请刷新后重试',
  INVALID_TASK_TRANSITION: '任务状态流转不合法',
  INVALID_STATE_TRANSITION: '当前状态不支持该操作',
  PROJECT_MISMATCH: '请求内容与当前项目不匹配',
  ALREADY_LINKED: '任务已关联到该阶段',
  DUPLICATE_PROGRESS: '该进展已提交，请勿重复提交',
  CONFIRMATION_REQUIRED: '请先确认候选阶段，再创建',
  CANDIDATE_EXPIRED: '候选阶段已过期，请重新生成',
  UNCONFIRMED_MATERIAL: '所选材料尚未确认，不能作为 AI 依据',
  MATERIAL_VERSION_OUTDATED: '材料版本已更新，请刷新后重试',
  UNSUPPORTED_MATERIAL_TYPE: '当前不支持该材料格式',
  MATERIAL_TOO_LARGE: '文件超过 1 MB 上限，请压缩或拆分后再上传',
  EMPTY_MATERIAL: '文件内容为空，请检查后再上传',
  MATERIAL_ENCODING_UNREADABLE: '无法识别文件编码，请转换后重试',
  MATERIAL_PARSE_FAILED: '材料解析失败，请检查文件内容后重试',
  DRAFT_ITEM_ARCHIVED: '该理解条目已归档',
  DRAFT_SOURCE_MISSING: '该理解条目缺少有效材料来源',
  AUTH_FAILED: '用户名或密码不正确',
  REGISTER_REJECTED: '注册未通过，请检查填写内容',
  FORBIDDEN_ORIGIN: '请求来源不受信任',
  MIGRATION_IN_PROGRESS: '迁移正在处理中，请稍后查询结果',
  MIGRATION_NOT_CONFIRMED: '请先在页面上确认迁移，再继续',
  MIGRATION_CONFIRMATION_EXPIRED: '迁移确认已过期，请重新确认后重试',
  MIGRATION_INVALID_DATA: '本地数据不完整或存在重复记录，迁移未执行；请导出备份后重试',
  MIGRATION_ID_CONFLICT: '迁移请求冲突，请稍后重试',
  MIGRATION_SOURCE_EXPIRED: '本地数据已超过可迁移期限',
  MIGRATION_SCHEMA_UNSUPPORTED: '本地数据版本过低或已损坏，无法迁移',
  MIGRATION_DATA_OUTDATED: '本地数据版本过旧，无法自动迁移；请先导出备份，再联系管理员',
  MIGRATION_VERSION_UNSUPPORTED: '本地数据来自更高版本，请刷新页面或升级后再迁移',
  MIGRATION_TOO_LARGE: '本地数据超过迁移上限，请先清理聊天或材料后重试',
  IDEMPOTENCY_CONFLICT: '重复请求的内容不一致，请刷新后重试',
  CONTRACT_VERSION_MISMATCH: '前后端接口版本不一致，请刷新页面',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  PAYLOAD_TOO_LARGE: '提交内容过大，请精简后重试',
  METHOD_NOT_ALLOWED: '请求方式不受支持',
  INTERNAL: '服务内部错误，请稍后重试',
  NETWORK_ERROR: '无法连接服务器，请检查网络后重试',
  TIMEOUT: '请求超时，请稍后重试',
  CANCELLED: '请求已取消',
  INVALID_RESPONSE: '服务器响应异常，请稍后重试',
  STALE_RESPONSE: '数据已更新，已忽略过期响应',
  INVALID_INPUT: '输入内容不合法，请检查后重试',
  MISSING_CONTRACT: '接口契约尚未定义，暂无法执行该操作',
  DUPLICATE_REQUEST: '该操作正在处理，请稍候',
  NOT_LOADED: '项目尚未加载完成，请稍后重试',
  TASKS_NOT_AVAILABLE: '任务列表读取接口尚未提供，暂时无法校验任务归属',
  TIMELINE_NOT_AVAILABLE: '时间线读取接口尚未提供',
}

const RETRYABLE_CODES = new Set<string>([
  'NETWORK_ERROR',
  'TIMEOUT',
  'INTERNAL',
  'RATE_LIMITED',
  'MIGRATION_IN_PROGRESS',
])

export interface V3ApiError {
  /** 服务端契约错误码或本地扩展错误码 */
  code: string
  /** 稳定的中文提示 */
  message: string
  /** 是否值得原样重试（迁移、网络、限流等） */
  retryable: boolean
  retryAfterSeconds: number | null
  requestId: string | null
  status: number | null
  cause: HttpFailureCause | 'contract' | 'validation'
  currentProjectRevision: number | null
  currentEntityRevision: number | null
}

export type V3Result<T> =
  | {
      ok: true
      data: T
      requestId: string
      projectId: string | null
      projectRevision: number | null
      replayed: boolean
      changed: boolean | null
    }
  | { ok: false; error: V3ApiError }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

export function v3Message(code: string, fallback?: string | null): string {
  return V3_ERROR_MESSAGES[code] ?? (fallback?.trim() ? fallback : V3_ERROR_MESSAGES.INTERNAL!)
}

export function makeV3Error(
  code: string,
  overrides: Partial<Omit<V3ApiError, 'code' | 'message'>> = {},
): V3ApiError {
  return {
    code,
    message: v3Message(code),
    retryable: overrides.retryable ?? RETRYABLE_CODES.has(code),
    retryAfterSeconds: overrides.retryAfterSeconds ?? null,
    requestId: overrides.requestId ?? null,
    status: overrides.status ?? null,
    cause: overrides.cause ?? 'contract',
    currentProjectRevision: overrides.currentProjectRevision ?? null,
    currentEntityRevision: overrides.currentEntityRevision ?? null,
  }
}

/** 由本地领域校验失败产生的错误（不发请求） */
export function validationError(code: string, message?: string): V3ApiError {
  return {
    ...makeV3Error(code, { cause: 'validation' }),
    message: message ?? v3Message(code),
  }
}

/**
 * requestId 只用于日志追踪与过期响应识别，不是会话令牌。
 * V3 契约 20.2 要求 UUID v4；crypto.randomUUID 不可用时按 v4 格式退化生成。
 */
export function newRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  const hex = (length: number) =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16)
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`
}

/**
 * 同一会话内，相同操作 + 相同业务内容复用同一个幂等键。
 * 不持久化、不含用户隐私；页面刷新后由服务端业务规则（阶段名冲突等）兜底。
 */
const idempotencyKeys = new Map<string, string>()

function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

export function stableIdempotencyKey(operation: string, signature: unknown): string {
  const normalized = JSON.stringify(signature ?? null)
  const cacheKey = `${operation}|${normalized}`
  const existing = idempotencyKeys.get(cacheKey)
  if (existing !== undefined) return existing
  const safeOperation = operation.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'op'
  const key = `scp_${safeOperation}_${fnv1a(normalized)}${fnv1a(`${operation}:${normalized}`)}`
  idempotencyKeys.set(cacheKey, key)
  return key
}

/** 测试用：清空进程内幂等键缓存，模拟新会话 */
export function resetIdempotencyCache(): void {
  idempotencyKeys.clear()
}

export interface V3RawOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
  query?: Record<string, string | number | boolean | null | undefined>
}

export type V3RawResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: V3ApiError }

function buildPath(path: string, query?: V3RawOptions['query']): string {
  if (query === undefined) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix === '' ? path : `${path}?${suffix}`
}

function httpError(status: number, data: unknown): V3ApiError {
  const record = asRecord(data)
  const rawCode = record !== null ? asString(record['code']) : null
  const code =
    rawCode ??
    (status === 401
      ? 'UNAUTHORIZED'
      : status === 403
        ? 'FORBIDDEN'
        : status === 404
          ? 'RESOURCE_NOT_FOUND'
          : status === 405
            ? 'METHOD_NOT_ALLOWED'
            : status === 413
              ? 'PAYLOAD_TOO_LARGE'
              : status === 429
                ? 'RATE_LIMITED'
                : status >= 500
                  ? 'INTERNAL'
                  : 'INVALID_REQUEST')
  const retryAfter = record !== null ? asNumber(record['retryAfterSeconds']) : null
  return {
    ...makeV3Error(code, {
      status,
      cause: 'http',
      requestId: record !== null ? asString(record['requestId']) : null,
      retryAfterSeconds: retryAfter,
      retryable: RETRYABLE_CODES.has(code),
      currentProjectRevision: record !== null ? asNumber(record['currentProjectRevision']) : null,
      currentEntityRevision: record !== null ? asNumber(record['currentEntityRevision']) : null,
    }),
  }
}

/** 发原始 V3 请求；auth/me、auth/logout、迁移响应不使用 20.1 包络 */
export async function requestV3Raw(path: string, options: V3RawOptions = {}): Promise<V3RawResult> {
  const result = await requestJson(buildPath(path, options.query), {
    method: options.method ?? 'GET',
    body: options.body,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    credentials: 'include',
  })

  if (result.ok) return { ok: true, status: result.status, body: result.data }

  if (result.cause === 'timeout') {
    return { ok: false, error: makeV3Error('TIMEOUT', { cause: 'timeout', retryable: true }) }
  }
  if (result.cause === 'aborted') {
    return { ok: false, error: makeV3Error('CANCELLED', { cause: 'aborted', retryable: false }) }
  }
  if (result.cause === 'network') {
    return { ok: false, error: makeV3Error('NETWORK_ERROR', { cause: 'network', retryable: true }) }
  }
  if (result.cause === 'invalid-json') {
    return {
      ok: false,
      error: makeV3Error('INVALID_RESPONSE', {
        status: result.status,
        cause: 'contract',
        retryable: false,
      }),
    }
  }
  return { ok: false, error: httpError(result.status ?? 0, result.data) }
}

export interface V3EnvelopeOptions extends V3RawOptions {
  requestId: string
  /** 已随请求体发送；包络校验不需要，但调用方统一传入便于追踪 */
  idempotencyKey?: string
  /** 写请求必须与响应 projectId 一致；列表接口传 undefined */
  expectedProjectId?: string | null
  /** 低于该 revision 的响应视为过期（由 store 传入当前已确认版本） */
  expectedMinRevision?: number
  parseData: (value: unknown) => unknown | null
}

/** 校验 20.1 成功包络，并解析业务 data */
export async function requestV3Envelope<T>(path: string, options: V3EnvelopeOptions): Promise<V3Result<T>> {
  const raw = await requestV3Raw(path, options)
  if (!raw.ok) return raw

  const envelope = asRecord(raw.body)
  if (envelope === null) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE', { status: raw.status }) }
  }
  if (envelope['contractVersion'] !== V3_CONTRACT_VERSION) {
    return {
      ok: false,
      error: makeV3Error('CONTRACT_VERSION_MISMATCH', { status: raw.status, retryable: false }),
    }
  }
  // 契约 22.1：读接口不返回 requestId/replayed；写接口必须回显
  const isRead = (options.method ?? 'GET') === 'GET'
  const responseRequestId = envelope['requestId']
  if (responseRequestId !== undefined) {
    if (responseRequestId !== options.requestId) {
      return { ok: false, error: makeV3Error('INVALID_RESPONSE', { status: raw.status }) }
    }
  } else if (!isRead) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE', { status: raw.status }) }
  }

  const projectIdValue = envelope['projectId']
  const projectId = projectIdValue === null ? null : asString(projectIdValue)
  if (projectIdValue !== null && projectId === null) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE', { status: raw.status }) }
  }
  if (options.expectedProjectId !== undefined && projectId !== options.expectedProjectId) {
    return {
      ok: false,
      error: makeV3Error('STALE_RESPONSE', { status: raw.status, retryable: false }),
    }
  }

  const projectRevisionValue = envelope['projectRevision']
  const projectRevision = projectRevisionValue === null ? null : asNumber(projectRevisionValue)
  if (projectRevisionValue !== null && projectRevision === null) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE', { status: raw.status }) }
  }
  if (
    options.expectedMinRevision !== undefined &&
    projectRevision !== null &&
    projectRevision < options.expectedMinRevision
  ) {
    return {
      ok: false,
      error: makeV3Error('STALE_RESPONSE', { status: raw.status, retryable: false }),
    }
  }

  const replayedValue = envelope['replayed']
  const replayed = replayedValue === undefined ? (isRead ? false : null) : asBoolean(replayedValue)
  if (replayed === null) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE', { status: raw.status }) }
  }
  const changed = envelope['changed'] === undefined ? null : asBoolean(envelope['changed'])
  if (envelope['changed'] !== undefined && changed === null) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE', { status: raw.status }) }
  }

  const data = options.parseData(envelope['data'])
  if (data === null) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE', { status: raw.status }) }
  }

  return {
    ok: true,
    data: data as T,
    requestId: options.requestId,
    projectId,
    projectRevision,
    replayed,
    changed,
  }
}

/** 把 V3ApiError 收敛为统一 ActionResult 的失败分支（可直接赋给任意 ActionResult<T>） */
export function v3Failure(error: V3ApiError): { ok: false; code: string; message: string } {
  return { ok: false, code: error.code, message: error.message }
}
