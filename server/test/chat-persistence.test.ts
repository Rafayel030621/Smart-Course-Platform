import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createProject,
  createTestClient,
  envelope,
  registerUser,
  uuid,
  type LoggedInUser,
  type TestClient,
} from './v3-support.js'

/**
 * 聊天持久化（契约 30）
 * ----------------------------------------------------------------------------
 * 使用独立临时 SQLite 与真实 HTTP；不调用真实模型，聊天回答走服务端兜底。
 */

interface Json {
  [key: string]: unknown
}

function blankContext(): Record<string, unknown> {
  return {
    milestoneId: null,
    currentMilestone: null,
    milestoneRevision: null,
    milestoneGoal: null,
    milestoneDoneCriteria: null,
    milestoneStatus: null,
    milestoneTasks: [],
    recentProgress: [],
    milestoneEvidence: [],
  }
}

function chatBody(
  projectId: string,
  projectRevision: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    promptVersion: 'advisor-chat-v3',
    requestId: uuid(),
    projectId,
    projectRevision,
    projectName: '聊天持久化项目',
    currentMilestone: null,
    tasks: [],
    evidence: [],
    doubts: [],
    chatHistory: [],
    question: '下一步应该做什么？',
    milestoneContext: blankContext(),
    ...overrides,
  }
}

async function setup(): Promise<{
  client: TestClient
  user: LoggedInUser
  project: { projectId: string; projectRevision: number }
}> {
  const client = await createTestClient()
  const user = await registerUser(client, { account: `chat_${Date.now().toString().slice(-10)}` })
  const project = await createProject(client, user, { name: '聊天持久化项目' })
  return { client, user, project }
}

async function createSession(
  client: TestClient,
  user: LoggedInUser,
  projectId: string,
  projectRevision: number,
): Promise<{ sessionId: string; createdAt: string; response: Response; body: Json }> {
  const response = await client.request(`/api/projects/${projectId}/chat/sessions`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, projectRevision),
  })
  const body = (await response.json()) as Json
  const data = body.data as { sessionId: string; createdAt: string }
  return { ...data, response, body }
}

async function chat(
  client: TestClient,
  user: LoggedInUser,
  projectId: string,
  projectRevision: number,
  overrides: Record<string, unknown> = {},
): Promise<{ response: Response; body: Json }> {
  const response = await client.request('/api/advisor/chat', {
    method: 'POST',
    cookie: user.cookie,
    body: chatBody(projectId, projectRevision, overrides),
  })
  return { response, body: (await response.json()) as Json }
}

async function messages(
  client: TestClient,
  user: LoggedInUser,
  projectId: string,
  sessionId: string,
  query = '',
): Promise<{ response: Response; body: Json }> {
  const response = await client.request(
    `/api/projects/${projectId}/chat/sessions/${sessionId}/messages${query}`,
    { cookie: user.cookie },
  )
  return { response, body: (await response.json()) as Json }
}

function countMessages(client: TestClient, sessionId: string): number {
  return (
    client.runtime
      .getDb()
      .prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?')
      .get(sessionId) as { count: number }
  ).count
}

function seedMessages(client: TestClient, projectId: string, sessionId: string, count: number): void {
  const db = client.runtime.getDb()
  const insert = db.prepare(
    `INSERT INTO chat_messages
       (message_id, chat_id, project_id, sequence, role, content, source, fallback_reason,
        prompt_version, request_id, project_revision_at_send, citations_json,
        client_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, '[]', NULL, ?)`,
  )
  for (let sequence = 1; sequence <= count; sequence += 1) {
    insert.run(
      `msg_seed_${sessionId}_${sequence}`,
      sessionId,
      projectId,
      sequence,
      sequence % 2 === 0 ? 'assistant' : 'user',
      `旧消息 ${sequence}`,
      `2026-10-01T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
    )
  }
  db.prepare('UPDATE chat_sessions SET message_count = ? WHERE chat_id = ?').run(count, sessionId)
}

test('会话 get-or-create：重复请求返回同一 session 和 createdAt', async () => {
  const { client, user, project } = await setup()
  try {
    const first = await createSession(client, user, project.projectId, project.projectRevision)
    const second = await createSession(client, user, project.projectId, project.projectRevision)

    assert.equal(first.response.status, 200)
    assert.equal(second.response.status, 200)
    assert.equal(first.sessionId, second.sessionId)
    assert.equal(first.createdAt, second.createdAt)
  } finally {
    await client.close()
  }
})

test('跨项目读取会话返回 404 RESOURCE_NOT_FOUND', async () => {
  const { client, user, project } = await setup()
  try {
    const session = await createSession(client, user, project.projectId, project.projectRevision)
    const otherProject = await createProject(client, user, { name: '另一个聊天项目' })

    const result = await messages(
      client,
      user,
      otherProject.projectId,
      session.sessionId,
      '?limit=200',
    )

    assert.equal(result.response.status, 404)
    assert.equal(result.body.code, 'RESOURCE_NOT_FOUND')
  } finally {
    await client.close()
  }
})

test('消息按升序返回，limit 边界与 before 校验', async () => {
  const { client, user, project } = await setup()
  try {
    const session = await createSession(client, user, project.projectId, project.projectRevision)
    seedMessages(client, project.projectId, session.sessionId, 3)

    const limited = await messages(
      client,
      user,
      project.projectId,
      session.sessionId,
      '?limit=2',
    )
    const limitedMessages = (limited.body.data as { messages: Array<Record<string, unknown>> })
      .messages
    assert.equal(limited.response.status, 200)
    assert.equal(limitedMessages.length, 2)
    assert.deepEqual(
      limitedMessages.map((message) => message.content),
      ['旧消息 2', '旧消息 3'],
    )

    const tooLarge = await messages(
      client,
      user,
      project.projectId,
      session.sessionId,
      '?limit=201',
    )
    assert.equal(tooLarge.response.status, 400)
    assert.equal(tooLarge.body.code, 'INVALID_INPUT')

    const before = await messages(
      client,
      user,
      project.projectId,
      session.sessionId,
      '?before=2026-10-01T00:00:00.000Z',
    )
    assert.equal(before.response.status, 400)
    assert.equal(before.body.code, 'INVALID_INPUT')
  } finally {
    await client.close()
  }
})

test('聊天成功后 user + assistant 在同一会话写入', async () => {
  const { client, user, project } = await setup()
  try {
    const session = await createSession(client, user, project.projectId, project.projectRevision)
    const result = await chat(client, user, project.projectId, project.projectRevision)

    assert.equal(result.response.status, 200)
    assert.equal(result.body.sessionId, session.sessionId)
    assert.equal(typeof result.body.messageId, 'string')

    const history = await messages(client, user, project.projectId, session.sessionId)
    const list = (history.body.data as { messages: Array<Record<string, unknown>> }).messages
    assert.equal(list.length, 2)
    assert.deepEqual(list.map((message) => message.role), ['user', 'assistant'])
    assert.equal(list[0]?.content, '下一步应该做什么？')
    assert.equal(typeof list[1]?.content, 'string')
    assert.deepEqual(list[0]?.citations, [])
    assert.deepEqual(list[1]?.citations, [])
    assert.equal(countMessages(client, session.sessionId), 2)
  } finally {
    await client.close()
  }
})

test('本地项目与未登录都跳过落库，sessionId/messageId 为 null', async () => {
  const { client, user, project } = await setup()
  try {
    const local = await chat(client, user, 'prj_local_not_in_cloud', 1)
    assert.equal(local.response.status, 200)
    assert.equal(local.body.sessionId, null)
    assert.equal(local.body.messageId, null)

    // chat() 总是带 cookie；这里单独发一个无 cookie 请求
    const noCookie = await client.request('/api/advisor/chat', {
      method: 'POST',
      body: chatBody(project.projectId, project.projectRevision),
    })
    const noCookieBody = (await noCookie.json()) as Json
    assert.equal(noCookie.status, 200)
    assert.equal(noCookieBody.sessionId, null)
    assert.equal(noCookieBody.messageId, null)
    assert.equal(countMessagesForProject(client, project.projectId), 0)

    // 有 cookie 的 normal 请求仍能落库，证明上面不是全局关闭
    const persisted = await chat(client, user, project.projectId, project.projectRevision)
    assert.equal(typeof persisted.body.sessionId, 'string')
    assert.equal(typeof persisted.body.messageId, 'string')
  } finally {
    await client.close()
  }
})

function countMessagesForProject(client: TestClient, projectId: string): number {
  return (
    client.runtime
      .getDb()
      .prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE project_id = ?')
      .get(projectId) as { count: number }
  ).count
}

test('同 requestId 重放不写第二条消息', async () => {
  const { client, user, project } = await setup()
  try {
    const session = await createSession(client, user, project.projectId, project.projectRevision)
    const requestId = uuid()
    const first = await chat(client, user, project.projectId, project.projectRevision, { requestId })
    const second = await chat(client, user, project.projectId, project.projectRevision, { requestId })

    assert.equal(first.response.status, 200)
    assert.equal(second.response.status, 200)
    assert.equal(first.body.sessionId, session.sessionId)
    assert.equal(second.body.sessionId, session.sessionId)
    assert.equal(second.body.messageId, first.body.messageId)
    assert.equal(countMessages(client, session.sessionId), 2)
  } finally {
    await client.close()
  }
})

test('单会话 500 条上限：写入后删除最旧消息', async () => {
  const { client, user, project } = await setup()
  try {
    const session = await createSession(client, user, project.projectId, project.projectRevision)
    seedMessages(client, project.projectId, session.sessionId, 499)

    const result = await chat(client, user, project.projectId, project.projectRevision)
    assert.equal(result.response.status, 200)
    assert.equal(countMessages(client, session.sessionId), 500)

    const oldest = client.runtime
      .getDb()
      .prepare('SELECT content FROM chat_messages WHERE chat_id = ? ORDER BY sequence ASC LIMIT 1')
      .get(session.sessionId) as { content: string }
    assert.equal(oldest.content, '旧消息 2')
  } finally {
    await client.close()
  }
})
