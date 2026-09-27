/**
 * 建议接口的领域类型与线上 DTO
 * ----------------------------------------------------------------------------
 * 唯一依据：docs/contracts.md（第 2 节领域对象、第 4 节建议接口、第 6 节错误码）。
 *
 * 两条约定：
 *   1. 线上字段名与契约完全一致，不另造一套 DTO；契约里没有的字段不要凭空加。
 *   2. 前端本地字段（id / source / requestId / projectRevision / generatedAt）
 *      按契约 2.5(b) 只挂在 Recommendation 上，不混进线格式 Suggestion。
 */

import type { DoubtStatus, NewTaskDraft, TaskStatus } from '@/types/platform'

export type { DoubtStatus, TaskStatus, NewTaskDraft }

/** 契约版本：与 docs/contracts.md 第 8.1 节一致 */
export const CONTRACT_VERSION = '1.0'

/** 本轮服务端支持的提示词版本（契约 4.1） */
export const DEFAULT_PROMPT_VERSION = 'mvp-prompt-v1'

/**
 * 建议来源。
 * `model` / `fallback` 由后端返回；`local-rule` 只由前端本地规则产生，永远不会出现在 HTTP 响应里
 * （契约 4.3）。本轮只保留这个类型扩展点，不实现本地规则。
 */
export type RecommendationSource = 'model' | 'fallback' | 'local-rule'

/** 后端返回的来源：不含 local-rule */
export type AdvisorResponseSource = Exclude<RecommendationSource, 'local-rule'>

/* ------------------------------------------------------------ 请求侧快照 */

/** 契约 4.1：TaskSnapshot 不含 projectId，归属由顶层 projectId 决定 */
export interface TaskSnapshot {
  taskId: string
  title: string
  status: TaskStatus
  doneCriteria: string | null
  owner: string | null
  milestone: string | null
  updatedAt: string
}

export interface EvidenceSnapshot {
  evidenceId: string
  submissionId: string
  taskId: string | null
  didWhat: string
  foundWhat: string | null
  stillUnsure: string | null
  author: string | null
  createdAt: string
}

export interface DoubtSnapshot {
  doubtId: string
  text: string
  status: DoubtStatus
  sourceEvidenceId: string | null
  createdAt: string
}

/** 契约 4.1 请求体 */
export interface AdvisorRecommendationsRequest {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  projectName: string
  currentMilestone: string | null
  confirmedContext: string[]
  /** 必须包含该项目全部任务（含已完成） */
  tasks: TaskSnapshot[]
  /** 最近若干条，按 createdAt 倒序 */
  evidence: EvidenceSnapshot[]
  /** 只发 status === 'open' 的疑问 */
  doubts: DoubtSnapshot[]
  promptVersion: string
  forceRefresh: boolean
}

/* -------------------------------------------------------------- 输出侧 */

/**
 * 契约 2.5(a)：一条建议的线格式。
 * `existingTaskId` 必须是 `string | null`——**它是必填可空字段**，缺失不等于空字符串：
 * null 表示"新任务候选"，空字符串是非法值。
 */
export interface Suggestion {
  title: string
  whyNow: string
  doneCriteria: string
  existingTaskId: string | null
  basisEvidenceIds: string[]
  basisDoubtIds: string[]
}

/** 契约 4.3 / 4.4：成功响应（source 为 model 或 fallback） */
export interface AdvisorRecommendationsSuccess {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  source: AdvisorResponseSource
  /** 只有 source === 'fallback' 时非空 */
  fallbackReason: AdvisorFallbackReason | null
  /** 是否复用服务端缓存；本轮服务端没有缓存层，恒为 false */
  cached: boolean
  promptVersion: string
  suggestions: Suggestion[]
}

/* ---------------------------------------------------------------- 错误 */

/** 契约 6.1 本轮启用的错误码 + 6.2 保留码 */
export type AdvisorErrorCode =
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'MODEL_TIMEOUT'
  | 'INVALID_MODEL_OUTPUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_NOT_CONFIGURED'
  | 'INTERNAL'
  // 以下为契约 6.2 的保留码：服务端持久化后才会返回，前端先留分支
  | 'STALE_REVISION'
  | 'UNAUTHORIZED'

/** 能作为 fallbackReason 的原因（契约 4.3：取值来自第 6 节的失败原因码） */
export type AdvisorFallbackReason = Extract<
  AdvisorErrorCode,
  'MODEL_TIMEOUT' | 'MODEL_UNAVAILABLE' | 'MODEL_NOT_CONFIGURED' | 'INVALID_MODEL_OUTPUT' | 'RATE_LIMITED'
>

/** 契约 4.5：失败响应 */
export interface AdvisorRecommendationsFailure {
  contractVersion: string
  /** 请求体无法解析时为 null */
  requestId: string | null
  code: AdvisorErrorCode
  message: string
  retryable: boolean
  /** 只有 RATE_LIMITED 时给整数 */
  retryAfterSeconds: number | null
}

/**
 * 前端内部错误码（契约 3.3 的本地错误，外加本层需要的"过期响应"）。
 * 这些码永远不会发给后端。
 */
export type AdvisorLocalErrorCode =
  /** 未收到契约定义的响应：网络失败、超时、响应不是契约形状 */
  | 'NETWORK_ERROR'
  /** 响应的 requestId / projectId / projectRevision 与本次请求对不上，整份丢弃（契约 4.7） */
  | 'STALE_RESPONSE'

/** 前端内部细分原因：只用于界面文案与排查，不属于契约字段 */
export type AdvisorErrorCause =
  | 'http'
  | 'timeout'
  | 'network'
  | 'aborted'
  | 'invalid-json'
  | 'invalid-response'
  | 'stale-response'

/**
 * 适配层错误。
 * 保留契约规定的 code / retryable / requestId，界面据此决定提示与是否重试。
 */
export interface AdvisorApiError {
  code: AdvisorErrorCode | AdvisorLocalErrorCode
  message: string
  retryable: boolean
  retryAfterSeconds: number | null
  requestId: string | null
  cause: AdvisorErrorCause
}

/** 建议接口调用的统一返回：成功拿契约响应，失败拿带 code/retryable 的错误 */
export type AdvisorApiResult =
  | { ok: true; data: AdvisorRecommendationsSuccess }
  | { ok: false; error: AdvisorApiError }

/** 契约 3.1：store action 的统一结果类型 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

/* -------------------------------------------------------- store action 契约 */

/**
 * 契约 3.3：本地 action 的失败码（不是 HTTP 状态码）。
 * 页面按 `code` 决定提示方式，不按 toast 文案判断成功。
 */
export type LocalActionErrorCode =
  /** 传入的 id 在当前项目中不存在 */
  | 'NOT_FOUND'
  /** id 属于另一个项目 */
  | 'PROJECT_MISMATCH'
  /** 必填字段为空、超出长度上限、入参组合非法 */
  | 'INVALID_INPUT'
  /** 对 done 任务再次认领 */
  | 'TASK_NOT_CLAIMABLE'
  /** 重复解决同一疑问：静默成功语义，不报错 */
  | 'ALREADY_RESOLVED'
  /** localStorage 写入失败 */
  | 'STORAGE_FULL'
  /** 请求已过期被丢弃（契约 4.7） */
  | 'STALE_RESPONSE'
  /** 未收到契约定义的 HTTP 响应（契约 3.3） */
  | 'NETWORK_ERROR'

/**
 * 构造一个本地失败结果。
 * 返回 `ActionResult<never>`：`never` 可赋值给任意 `T`，
 * 因此它可以直接作为任何 `ActionResult<T>` 的失败分支，不需要显式写类型参数。
 */
export function localFailure(code: LocalActionErrorCode, message: string): ActionResult<never> {
  return { ok: false, code, message }
}

/** 契约 3.2：createProject */
export interface CreateProjectInput {
  /** 题目模板 key；自定义题目传 `__custom__` */
  topicId: string
  /** topicId 为 `__custom__` 时的项目名称 */
  customName?: string
  /** 小组人数 */
  members: number
  manualName?: string | null
  dataName?: string | null
  /** 兼容入口：旧表单传 `topic` 而不是 `topicId` */
  topic?: string
  /** 兼容入口：旧表单的成员是「3 人」这类字符串 */
  membersLabel?: string
}

/** 旧创建表单的入参（ProjectCreate.vue 当前在用） */
export interface LegacyCreateProjectInput {
  topic: string
  customName: string
  members: string
  manual: string | null
  data: string | null
}

export interface CreateProjectResult {
  projectId: string
  projectRevision: number
}

export interface SelectProjectResult {
  projectId: string
  projectRevision: number
}

/** 契约 3.2：claimTask 的两种入参，二者互斥 */
export type ClaimTaskInput = { taskId: string } | { draft: NewTaskDraft }

export interface ClaimTaskResult {
  taskId: string
  status: 'doing'
  projectRevision: number
}

/** 契约 3.2：submitEvidence */
export interface SubmitEvidenceInput {
  /** 幂等键：前端每次提交生成一次 */
  submissionId: string
  taskId: string | null
  didWhat: string
  foundWhat?: string | null
  stillUnsure?: string | null
  attachmentName?: string | null
  /** true = 确认完成（doing → done）；false = 只记录进展 */
  complete: boolean
}

/** 旧证据表单的入参（WorkbenchView.vue 当前在用） */
export interface LegacyEvidenceInput {
  stepLabel: string
  didWhat: string
  foundWhat: string
  solved: string
  unsure: string
  attachment: string | null
}

export interface SubmitEvidenceResult {
  evidenceId: string
  submissionId: string
  deduplicated: boolean
  doubtId: string | null
  taskStatus: 'doing' | 'done' | null
  projectRevision: number
}

export interface ResolveDoubtResult {
  doubtId: string
  projectRevision: number
}

/** 契约 4.5/5.2：证据已保存但建议生成失败时，页面还要能说清建议来源 */
export interface AdvisorOutcome {
  source: RecommendationSource
  suggestions: Recommendation[]
  cached: boolean
  fallbackReason: AdvisorFallbackReason | null
  requestId: string | null
}

/** 契约 2.2 / 4.1：字段长度上限 */
export const MAX_TASK_TITLE_LENGTH = 60
export const MAX_EVIDENCE_DID_WHAT_LENGTH = 300
export const MAX_EVIDENCE_FOUND_WHAT_LENGTH = 300
export const MAX_EVIDENCE_UNSURE_LENGTH = 300
export const MAX_DONE_CRITERIA_LENGTH = 200

/* ------------------------------------------------------------ 领域对象 */

/**
 * 契约 2.5(b)：前端领域对象 = 一条建议 + 本地字段。
 * 字段名与线格式完全一致，只是多了 id / source / requestId / projectRevision / generatedAt。
 */
export interface Recommendation extends Suggestion {
  /** `rec_<requestId>_<index>`；本地规则为 `rec_local_<revision>_<index>`，只用于列表 key 与去重 */
  id: string
  source: RecommendationSource
  /** 本地规则产生时为 null */
  requestId: string | null
  projectRevision: number
  /**
   * 落库时间（ISO）。
   * 注意：它不是线上字段——后端不返回它，由适配层在收到响应时补上（契约 2.5(b)）。
   */
  generatedAt: string
}

/* ------------------------------------------------------------ 运行时工具 */

/** 契约 6.1：retryable 的权威值是响应里的字段，这里只在字段缺失时兜底 */
export const RETRYABLE_BY_CODE: Record<AdvisorErrorCode, boolean> = {
  INVALID_INPUT: false,
  RATE_LIMITED: true,
  MODEL_TIMEOUT: true,
  INVALID_MODEL_OUTPUT: true,
  MODEL_UNAVAILABLE: true,
  MODEL_NOT_CONFIGURED: false,
  INTERNAL: true,
  STALE_REVISION: false,
  UNAUTHORIZED: false,
}

const ADVISOR_ERROR_CODES = Object.keys(RETRYABLE_BY_CODE) as AdvisorErrorCode[]

export function isAdvisorErrorCode(value: unknown): value is AdvisorErrorCode {
  return typeof value === 'string' && (ADVISOR_ERROR_CODES as string[]).includes(value)
}

/* --------------------------------------------------------------- local-rule */

/**
 * 本地规则（后端不可达或后端返回错误时的兜底）实现在 `src/data/mvpFallbacks.ts`
 * 的 `buildLocalRecommendations()`。它产出的一定是：
 *
 * ```ts
 * {
 *   ...Suggestion 的六个字段,
 *   id: buildRecommendationId('local-rule', null, projectRevision, index),
 *   source: 'local-rule',
 *   requestId: null,
 *   projectRevision,
 *   generatedAt: '由调用方传入的 ISO 时间',
 * }
 * ```
 *
 * 类型与 ID 约定以本文件为准；规则内容不需要新的线上字段。
 */
