import type { IncomingMessage, ServerResponse } from 'node:http'
import type { V3Database } from './db.js'
import { transaction } from './db.js'
import { loadProject } from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import {
  bodyReadError,
  readJsonBody,
  requireRecord,
  requireWriteEnvelope,
  sendV3Json,
  successBody,
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/**
 * 聊天持久化（契约 30）
 * ----------------------------------------------------------------------------
 * 会话与消息只归属 project + user；聊天只追加消息，不递增 projectRevision。
 * 学生消息和助手消息必须在同一事务写入，不能出现“问了没答”的孤儿记录。
 */

export const CHAT_MAX_MESSAGES_PER_SESSION = 500
export const CHAT_MESSAGES_DEFAULT_LIMIT = 200
export const CHAT_MESSAGES_MAX_LIMIT = 200

export interface ChatSessionRow {
  chat_id: string
  project_id: string
  user_id: string
  status: string
  created_at: string
}

interface ChatMessageRow {
  message_id: string
  role: string
  content: string
  citations_json: string
  created_at: string
}

export function getOrCreateActiveSession(
  db: V3Database,
  projectId: string,
  userId: string,
  now: Date,
): ChatSessionRow {
  const existing = db
    .prepare(
      `SELECT chat_id, project_id, user_id, status, created_at
         FROM chat_sessions
        WHERE project_id = ? AND user_id = ? AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get(projectId, userId) as ChatSessionRow | undefined
  if (existing !== undefined) return existing

  const session: ChatSessionRow = {
    chat_id: newId('chat', now.getTime()),
    project_id: projectId,
    user_id: userId,
    status: 'active',
    created_at: now.toISOString(),
  }
  db.prepare(
    `INSERT INTO chat_sessions
       (chat_id, project_id, user_id, status, message_count, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 0, ?, ?)`,
  ).run(session.chat_id, projectId, userId, session.created_at, session.created_at)
  return session
}

export interface PersistChatExchangeInput {
  projectId: string
  userId: string
  requestId: string
  question: string
  answer: string
  citations: unknown[]
  promptVersion: string
  projectRevision: number
  now: Date
}

export interface PersistedChatExchange {
  sessionId: string
  messageId: string
}

/**
 * 在单个事务中写入 user + assistant 两条消息，并更新会话统计。
 * 同一 requestId 已有 assistant 消息时直接复用，不重复写。
 */
export function persistChatExchange(
  db: V3Database,
  input: PersistChatExchangeInput,
): PersistedChatExchange {
  const nowText = input.now.toISOString()
  return transaction(db, () => {
    const session = getOrCreateActiveSession(db, input.projectId, input.userId, input.now)

    const existing = db
      .prepare(
        `SELECT chat_id, message_id
           FROM chat_messages
          WHERE project_id = ? AND request_id = ? AND role = 'assistant'
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(input.projectId, input.requestId) as
      | { chat_id: string; message_id: string }
      | undefined
    if (existing !== undefined) {
      return { sessionId: existing.chat_id, messageId: existing.message_id }
    }

    const maxRow = db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS maxSequence FROM chat_messages WHERE chat_id = ?')
      .get(session.chat_id) as { maxSequence: number }
    const userSequence = maxRow.maxSequence + 1
    const assistantSequence = userSequence + 1
    const userMessageId = newId('msg', input.now.getTime())
    const assistantMessageId = newId('msg', input.now.getTime())

    const insert = db.prepare(
      `INSERT INTO chat_messages
         (message_id, chat_id, project_id, sequence, role, content, source, fallback_reason,
          prompt_version, request_id, project_revision_at_send, citations_json,
          client_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?)`,
    )
    insert.run(
      userMessageId,
      session.chat_id,
      input.projectId,
      userSequence,
      'user',
      input.question,
      input.promptVersion,
      input.requestId,
      input.projectRevision,
      '[]',
      nowText,
    )
    insert.run(
      assistantMessageId,
      session.chat_id,
      input.projectId,
      assistantSequence,
      'assistant',
      input.answer,
      input.promptVersion,
      input.requestId,
      input.projectRevision,
      JSON.stringify(input.citations),
      nowText,
    )

    const countRow = db
      .prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?')
      .get(session.chat_id) as { count: number }
    let messageCount = countRow.count
    if (messageCount > CHAT_MAX_MESSAGES_PER_SESSION) {
      const excess = messageCount - CHAT_MAX_MESSAGES_PER_SESSION
      db.prepare(
        `DELETE FROM chat_messages
          WHERE message_id IN (
            SELECT message_id FROM chat_messages
             WHERE chat_id = ?
             ORDER BY sequence ASC
             LIMIT ?
          )`,
      ).run(session.chat_id, excess)
      messageCount = CHAT_MAX_MESSAGES_PER_SESSION
    }

    db.prepare(
      `UPDATE chat_sessions
          SET message_count = ?, last_message_at = ?, updated_at = ?
        WHERE chat_id = ?`,
    ).run(messageCount, nowText, nowText, session.chat_id)

    return { sessionId: session.chat_id, messageId: assistantMessageId }
  })
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, 256 * 1024))
  } catch (error) {
    throw bodyReadError(error)
  }
}

export async function handleChatSessionCreate(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const body = await readBody(req)
  const envelope = requireWriteEnvelope(body, projectId)
  const db = runtime.getDb()
  loadProject(db, auth.user.user_id, projectId)

  const now = runtime.now()
  const nowText = now.toISOString()
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: 'chat.session.get_or_create',
    resource: projectId,
    body,
  })
  const replay = lookupIdempotent(db, auth.user.user_id, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const session = transaction(db, () => getOrCreateActiveSession(db, projectId, auth.user.user_id, now))
  const response = successBody(envelope.requestId, projectId, {
    replayed: false,
    data: {
      sessionId: session.chat_id,
      createdAt: session.created_at,
    },
  })
  saveIdempotent(db, auth.user.user_id, envelope.idempotencyKey, fingerprint, 200, response, nowText)
  sendV3Json(res, 200, response)
}

function parseMessagesLimit(raw: string | null): number {
  if (raw === null || raw === '') return CHAT_MESSAGES_DEFAULT_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > CHAT_MESSAGES_MAX_LIMIT) {
    throw invalidInput(`limit 必须是 1-${CHAT_MESSAGES_MAX_LIMIT} 的整数`)
  }
  return value
}

function parseCitations(json: string): unknown[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function handleChatMessages(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  sessionId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  loadProject(db, auth.user.user_id, projectId)

  if (url.searchParams.has('before')) {
    throw invalidInput('before 暂不支持')
  }
  const limit = parseMessagesLimit(url.searchParams.get('limit'))

  const session = db
    .prepare(
      `SELECT chat_id FROM chat_sessions
        WHERE chat_id = ? AND project_id = ? AND user_id = ? AND status = 'active'`,
    )
    .get(sessionId, projectId, auth.user.user_id) as { chat_id: string } | undefined
  if (session === undefined) throw new V3Error('RESOURCE_NOT_FOUND')

  const rows = db
    .prepare(
      `SELECT message_id, role, content, citations_json, created_at
         FROM chat_messages
        WHERE chat_id = ?
        ORDER BY sequence DESC
        LIMIT ?`,
    )
    .all(session.chat_id, limit) as ChatMessageRow[]

  const messages = rows
    .slice()
    .reverse()
    .map((row) => ({
      messageId: row.message_id,
      role: row.role,
      content: row.content,
      citations: parseCitations(row.citations_json),
      createdAt: row.created_at,
    }))

  sendV3Json(
    res,
    200,
    successBody(null, projectId, {
      data: { messages },
    }),
  )
}
