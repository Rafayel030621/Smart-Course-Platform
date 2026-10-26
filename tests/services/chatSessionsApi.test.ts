/**
 * 云端聊天会话 API client 单测（契约第 30 节）
 * ----------------------------------------------------------------------------
 * 说明：后端的聊天持久化实现（PR #44）虽已合入 main，但本文件只验证**客户端解析与装配**，
 * 全部基于契约第 30 节的 mock 响应，不代表真实联调通过；真实往返见
 * tests/integration/chatPersistence.integration.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_MESSAGES_DEFAULT_LIMIT,
  CHAT_MESSAGES_MAX_LIMIT,
  buildChatMessagesQuery,
  chatMessagesPath,
  chatSessionsPath,
  getOrCreateChatSession,
  listChatMessages,
} from '@/services/chatSessionsApi'
import { V3_ERROR_MESSAGES } from '@/services/v3Http'
import {
  echoEnvelope,
  installFetch,
  jsonResponse,
  readEnvelope,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const SESSION_ID = 'chat_1'
const FIXED_ISO = '2026-10-26T01:00:00.000Z'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg_1',
    role: 'user',
    content: '当前阶段下一步该做什么',
    citations: [],
    createdAt: FIXED_ISO,
    ...overrides,
  }
}

function citation(overrides: Record<string, unknown> = {}) {
  return {
    materialId: 'mat_1',
    materialName: '实验手册.md',
    materialVersion: 2,
    segmentId: 'seg_3',
    startLine: 10,
    endLine: 18,
    itemId: 'it_1',
    ...overrides,
  }
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('会话取得或创建（契约 30.1）', () => {
  it('解析标准信封 data: { sessionId, createdAt }', async () => {
    installFetch((_url, init) =>
      jsonResponse(echoEnvelope(init, { sessionId: SESSION_ID, createdAt: FIXED_ISO })),
    )

    const result = await getOrCreateChatSession(PROJECT_ID, { projectRevision: 5 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.sessionId).toBe(SESSION_ID)
    expect(result.data.createdAt).toBe(FIXED_ISO)
  })

  it('请求体带完整的写信封字段，requestId 为 UUID', async () => {
    let captured: Record<string, unknown> | null = null
    installFetch((_url, init) => {
      captured = bodyOf(init)
      return jsonResponse(echoEnvelope(init, { sessionId: SESSION_ID, createdAt: FIXED_ISO }))
    })

    await getOrCreateChatSession(PROJECT_ID, { projectRevision: 7 })

    const body = captured!
    expect(body['contractVersion']).toBe('3.0')
    expect(body['projectId']).toBe(PROJECT_ID)
    expect(body['projectRevision']).toBe(7)
    expect(typeof body['idempotencyKey']).toBe('string')
    expect(String(body['requestId'])).toMatch(UUID_PATTERN)
  })

  it('幂等键与 requestId 绑定：同一请求重试复用，不同请求不复用', async () => {
    const keys: string[] = []
    installFetch((_url, init) => {
      keys.push(String(bodyOf(init)['idempotencyKey']))
      return jsonResponse(echoEnvelope(init, { sessionId: SESSION_ID, createdAt: FIXED_ISO }))
    })

    const first = '3f1d9c8a-5b2e-4f7a-9c1d-8e2b4a6c0d11'
    const second = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
    await getOrCreateChatSession(PROJECT_ID, { projectRevision: 5, requestId: first })
    await getOrCreateChatSession(PROJECT_ID, { projectRevision: 5, requestId: first })
    await getOrCreateChatSession(PROJECT_ID, { projectRevision: 5, requestId: second })

    expect(keys).toHaveLength(3)
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
  })

  it('路径按契约编码：/api/projects/{projectId}/chat/sessions', () => {
    expect(chatSessionsPath('prj_1')).toBe('/api/projects/prj_1/chat/sessions')
    expect(chatMessagesPath('prj_1', 'chat_1')).toBe(
      '/api/projects/prj_1/chat/sessions/chat_1/messages',
    )
  })

  it('projectRevision 缺失或非法时本地拒绝，不发请求', async () => {
    const mock = installFetch(() => jsonResponse({}))

    const zero = await getOrCreateChatSession(PROJECT_ID, { projectRevision: 0 })
    const emptyProject = await getOrCreateChatSession('  ', { projectRevision: 1 })

    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.error.code).toBe('INVALID_INPUT')
    expect(emptyProject.ok).toBe(false)
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('历史消息读取（契约 30.2）', () => {
  it('Query 只带 limit，默认 200，绝不出现 before', async () => {
    const params: URLSearchParams[] = []
    installFetch((url) => {
      params.push(new URL(url, 'http://localhost').searchParams)
      return jsonResponse(readEnvelope({ messages: [] }, PROJECT_ID, 5))
    })

    await listChatMessages(PROJECT_ID, SESSION_ID)
    await listChatMessages(PROJECT_ID, SESSION_ID, { limit: 50 })

    expect(params[0]?.get('limit')).toBe('200')
    expect(params[1]?.get('limit')).toBe('50')
    for (const query of params) {
      expect(query.has('before')).toBe(false)
      expect([...query.keys()]).toEqual(['limit'])
    }
  })

  it('buildChatMessagesQuery 只产出 limit 一个键', () => {
    expect(buildChatMessagesQuery(CHAT_MESSAGES_DEFAULT_LIMIT)).toEqual({
      limit: CHAT_MESSAGES_DEFAULT_LIMIT,
    })
    expect(CHAT_MESSAGES_MAX_LIMIT).toBe(200)
  })

  it('解析 messages[]：保持服务端升序，字段形状与契约一致', async () => {
    const ascending = [
      message({ messageId: 'msg_1', role: 'user', content: '第一个问题' }),
      message({
        messageId: 'msg_2',
        role: 'assistant',
        content: '第一个回答',
        citations: [citation()],
      }),
      message({ messageId: 'msg_3', role: 'user', content: '第二个问题' }),
    ]
    installFetch(() => jsonResponse(readEnvelope({ messages: ascending }, PROJECT_ID, 5)))

    const result = await listChatMessages(PROJECT_ID, SESSION_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.messages.map((item) => item.messageId)).toEqual(['msg_1', 'msg_2', 'msg_3'])
    expect(result.data.messages[1]).toEqual({
      messageId: 'msg_2',
      role: 'assistant',
      content: '第一个回答',
      citations: [citation()],
      createdAt: FIXED_ISO,
    })
  })

  it('历史消息没有 source / fallbackReason：解析结果里也不存在这两个键', async () => {
    installFetch(() =>
      jsonResponse(readEnvelope({ messages: [message({ role: 'assistant' })] }, PROJECT_ID, 5)),
    )

    const result = await listChatMessages(PROJECT_ID, SESSION_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = result.data.messages[0]!
    expect(Object.prototype.hasOwnProperty.call(parsed, 'source')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(parsed, 'fallbackReason')).toBe(false)
  })

  it('citations 为空数组或缺字段都合法；空数组原样保留', async () => {
    installFetch(() =>
      jsonResponse(
        readEnvelope(
          {
            messages: [
              message({ messageId: 'msg_1', citations: [] }),
              { messageId: 'msg_2', role: 'assistant', content: '无引用字段', createdAt: FIXED_ISO },
            ],
          },
          PROJECT_ID,
          5,
        ),
      ),
    )

    const result = await listChatMessages(PROJECT_ID, SESSION_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.messages[0]?.citations).toEqual([])
    expect(result.data.messages[1]?.citations).toEqual([])
  })

  it('单条消息缺 messageId / role 非法时丢弃该条，其余保留', async () => {
    installFetch(() =>
      jsonResponse(
        readEnvelope(
          {
            messages: [
              message({ messageId: '' }),
              message({ messageId: 'msg_ok', role: 'system' }),
              message({ messageId: 'msg_2', role: 'assistant' }),
            ],
          },
          PROJECT_ID,
          5,
        ),
      ),
    )

    const result = await listChatMessages(PROJECT_ID, SESSION_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.messages.map((item) => item.messageId)).toEqual(['msg_2'])
  })

  it('messages 不是数组时判为非法响应', async () => {
    installFetch(() => jsonResponse(readEnvelope({ messages: 'oops' }, PROJECT_ID, 5)))

    const result = await listChatMessages(PROJECT_ID, SESSION_ID)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_RESPONSE')
  })

  it('limit 越界（0 / 201 / 小数）本地拒绝，不发请求', async () => {
    const mock = installFetch(() => jsonResponse(readEnvelope({ messages: [] }, PROJECT_ID, 5)))

    for (const limit of [0, 201, 5.5, -1]) {
      const result = await listChatMessages(PROJECT_ID, SESSION_ID, { limit })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT')
    }
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('错误码中文映射', () => {
  it('404 RESOURCE_NOT_FOUND（跨项目或会话不存在）', async () => {
    installFetch(() =>
      jsonResponse({ contractVersion: '3.0', code: 'RESOURCE_NOT_FOUND', message: 'not found' }, 404),
    )

    const result = await listChatMessages(PROJECT_ID, SESSION_ID)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RESOURCE_NOT_FOUND')
    expect(result.error.message).toBe(V3_ERROR_MESSAGES['RESOURCE_NOT_FOUND'])
  })

  it('401 UNAUTHORIZED', async () => {
    installFetch(() =>
      jsonResponse({ contractVersion: '3.0', code: 'UNAUTHORIZED', message: 'login' }, 401),
    )

    const result = await getOrCreateChatSession(PROJECT_ID, { projectRevision: 5 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNAUTHORIZED')
    expect(result.error.message).toBe('登录状态已失效，请重新登录')
  })

  it('400 INVALID_INPUT（before 等不支持参数由服务端拒绝）', async () => {
    installFetch(() =>
      jsonResponse(
        { contractVersion: '3.0', code: 'INVALID_INPUT', message: 'before 暂不支持' },
        400,
      ),
    )

    const result = await listChatMessages(PROJECT_ID, SESSION_ID)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_INPUT')
    expect(result.error.message).toBe('输入内容不合法，请检查后重试')
  })

  it('网络失败映射 NETWORK_ERROR 且可重试', async () => {
    installFetch(() => {
      throw new Error('boom')
    })

    const result = await listChatMessages(PROJECT_ID, SESSION_ID)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NETWORK_ERROR')
    expect(result.error.retryable).toBe(true)
  })
})
