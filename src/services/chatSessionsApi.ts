/**
 * 云端聊天会话适配层（docs/contracts.md 第 30 节，V5）
 * ----------------------------------------------------------------------------
 * POST /api/projects/{projectId}/chat/sessions              取得或创建会话（30.1）
 * GET  /api/projects/{projectId}/chat/sessions/{id}/messages 恢复历史消息（30.2）
 *
 * 契约要点：
 *   1. 会话按 `projectId + userId` 归属；跨项目读会话返回 404 `RESOURCE_NOT_FOUND`；
 *   2. 历史消息按时间**升序**，形状 `{ messageId, role, content, citations, createdAt }`；
 *      **没有** `source` / `fallbackReason`——这两个字段只属于实时响应（6.4），
 *      本文件不定义它们，映射层也不得补造；
 *   3. Query 只允许 `limit`（默认 200、上限 200）。`before` 后端明确返回 400
 *      「before 暂不支持」，因此请求装配里**根本不出现**该键，连类型都不给；
 *   4. 复用 `v3Http` 的 Cookie 鉴权、超时与错误归一化。
 *
 * 本文件不发明写入端点：消息由服务端在 `POST /api/advisor/chat`（v3）时落库。
 */
import type { CloudCitation } from '@/types/platform'
import { V3_CONTRACT_VERSION } from '@/types/platform'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  newRequestId,
  requestV3Envelope,
  stableIdempotencyKey,
  validationError,
  type V3Result,
} from './v3Http'

/** 契约 30.2：limit 默认 200、上限 200 */
export const CHAT_MESSAGES_DEFAULT_LIMIT = 200
export const CHAT_MESSAGES_MAX_LIMIT = 200

export type ChatMessageRole = 'user' | 'assistant'

/** 契约 30.1：`data: { sessionId, createdAt }` */
export interface ChatSessionInfo {
  sessionId: string
  createdAt: string
}

/**
 * 契约 30.2：一条历史消息。
 * 刻意**不含** `source` / `fallbackReason`：历史消息本来就没有来源信息。
 */
export interface ChatHistoryMessage {
  messageId: string
  role: ChatMessageRole
  content: string
  citations: CloudCitation[]
  createdAt: string
}

export interface ChatHistoryPage {
  messages: ChatHistoryMessage[]
}

export interface ChatApiOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface GetOrCreateChatSessionInput extends ChatApiOptions {
  /** 契约 30.1 写信封必填：当前已确认的 projectRevision */
  projectRevision: number
  requestId?: string
  idempotencyKey?: string
}

/** `POST /api/projects/{projectId}/chat/sessions` */
export function chatSessionsPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/chat/sessions`
}

/** `GET /api/projects/{projectId}/chat/sessions/{sessionId}/messages` */
export function chatMessagesPath(projectId: string, sessionId: string): string {
  return `${chatSessionsPath(projectId)}/${encodeURIComponent(sessionId)}/messages`
}

/**
 * 契约 30.2 的请求 Query：**只有 limit**。
 *
 * `before` 在契约里是「为分页预留」，后端当前对任何 `before` 直接 400，
 * 所以这里既不接收也不装配该参数——不留半成品调用。
 */
export function buildChatMessagesQuery(limit: number): Record<string, string | number> {
  return { limit }
}

function parseCitation(value: unknown): CloudCitation | null {
  const record = asRecord(value)
  if (record === null) return null

  const materialId = asString(record['materialId'])
  const materialName = asString(record['materialName'])
  const materialVersion = asNumber(record['materialVersion'])
  const segmentId = asString(record['segmentId'])
  const startLine = asNumber(record['startLine'])
  const endLine = asNumber(record['endLine'])
  if (
    materialId === null ||
    materialName === null ||
    materialVersion === null ||
    segmentId === null ||
    startLine === null ||
    endLine === null
  ) {
    return null
  }

  const rawItemId = record['itemId']
  const itemId = rawItemId === null || rawItemId === undefined ? null : asString(rawItemId)
  if (rawItemId !== null && rawItemId !== undefined && itemId === null) return null

  return { materialId, materialName, materialVersion, segmentId, startLine, endLine, itemId }
}

function parseHistoryMessage(value: unknown): ChatHistoryMessage | null {
  const record = asRecord(value)
  if (record === null) return null

  const messageId = asString(record['messageId'])
  if (messageId === null || messageId.trim() === '') return null

  const role = record['role']
  if (role !== 'user' && role !== 'assistant') return null

  const content = asString(record['content'])
  if (content === null) return null

  const createdAt = asString(record['createdAt'])
  if (createdAt === null) return null

  // citations 可能是空数组（契约 30.2），缺字段时按空数组处理；不是数组就整条丢弃
  const rawCitations = record['citations']
  const citations: CloudCitation[] = []
  if (rawCitations !== undefined && rawCitations !== null) {
    const list = asArray(rawCitations)
    if (list === null) return null
    for (const item of list) {
      const citation = parseCitation(item)
      if (citation === null) return null
      citations.push(citation)
    }
  }

  return { messageId, role, content, citations, createdAt }
}

/** 契约 30.2：`data: { messages }`；服务端已按时间升序返回，这里保持原序不再重排 */
export function parseChatHistoryPage(value: unknown): ChatHistoryPage | null {
  const record = asRecord(value)
  if (record === null) return null
  const list = asArray(record['messages'])
  if (list === null) return null

  const messages: ChatHistoryMessage[] = []
  for (const item of list) {
    const parsed = parseHistoryMessage(item)
    if (parsed !== null) messages.push(parsed)
  }
  return { messages }
}

/** 契约 30.1：取得或创建会话。同一项目重复调用返回同一 sessionId */
export async function getOrCreateChatSession(
  projectId: string,
  input: GetOrCreateChatSessionInput,
): Promise<V3Result<ChatSessionInfo>> {
  const trimmed = projectId.trim()
  if (trimmed === '') {
    return { ok: false, error: validationError('INVALID_INPUT', '缺少项目信息，无法创建聊天会话') }
  }
  if (!Number.isInteger(input.projectRevision) || input.projectRevision < 1) {
    return {
      ok: false,
      error: validationError('INVALID_INPUT', '项目版本尚未确认，暂时无法创建聊天会话'),
    }
  }

  const requestId = input.requestId ?? newRequestId()
  /**
   * 幂等键与「项目 + requestId」绑定。
   *
   * 服务端幂等指纹包含 requestId，所以「固定键 + 每次新 requestId」会被判成
   * 409 IDEMPOTENCY_CONFLICT。同一请求重试必须同时复用 requestId 与幂等键；
   * 不同请求各用各的键——「同一项目只有一个会话」由服务端 get-or-create 保证，
   * 不靠幂等回放。
   */
  const idempotencyKey =
    input.idempotencyKey ?? stableIdempotencyKey('chat.session', { projectId: trimmed, requestId })

  return requestV3Envelope<ChatSessionInfo>(chatSessionsPath(trimmed), {
    method: 'POST',
    requestId,
    idempotencyKey,
    expectedProjectId: trimmed,
    body: {
      contractVersion: V3_CONTRACT_VERSION,
      requestId,
      idempotencyKey,
      projectId: trimmed,
      projectRevision: input.projectRevision,
    },
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
    parseData: (data) => {
      const record = asRecord(data)
      if (record === null) return null
      const sessionId = asString(record['sessionId'])
      const createdAt = asString(record['createdAt'])
      if (sessionId === null || sessionId.trim() === '' || createdAt === null) return null
      return { sessionId, createdAt }
    },
  })
}

/** 契约 30.2：读取历史消息（只带 limit；不带 before） */
export async function listChatMessages(
  projectId: string,
  sessionId: string,
  query: { limit?: number } = {},
  options: ChatApiOptions = {},
): Promise<V3Result<ChatHistoryPage>> {
  const trimmedProject = projectId.trim()
  const trimmedSession = sessionId.trim()
  if (trimmedProject === '') {
    return { ok: false, error: validationError('INVALID_INPUT', '缺少项目信息，无法读取聊天记录') }
  }
  if (trimmedSession === '') {
    return { ok: false, error: validationError('INVALID_INPUT', '缺少会话信息，无法读取聊天记录') }
  }

  const limit = query.limit ?? CHAT_MESSAGES_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_MESSAGES_MAX_LIMIT) {
    return {
      ok: false,
      error: validationError('INVALID_INPUT', `聊天记录条数需为 1–${CHAT_MESSAGES_MAX_LIMIT} 之间的整数`),
    }
  }

  const requestId = newRequestId()
  return requestV3Envelope<ChatHistoryPage>(chatMessagesPath(trimmedProject, trimmedSession), {
    method: 'GET',
    requestId,
    expectedProjectId: trimmedProject,
    query: buildChatMessagesQuery(limit),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    parseData: parseChatHistoryPage,
  })
}
