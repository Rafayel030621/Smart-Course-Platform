/**
 * 云端聊天持久化的 store 逻辑（契约第 30 节）
 * ----------------------------------------------------------------------------
 * 说明：store 逻辑用 mock 验证，不代表真实联调通过。
 * 真实往返（同一 sessionId、重新 GET 恢复升序、跨用户 404、before 400、limit 边界）
 * 见 tests/integration/chatPersistence.integration.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCloudStore } from '@/stores/cloud'
import {
  cloudRoutes,
  echoEnvelope,
  installFetch,
  jsonResponse,
  makeCloudMilestone,
  makeCloudProject,
  makeCloudTask,
  readEnvelope,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const OTHER_PROJECT_ID = 'prj_2'
const FIXED_ISO = '2026-10-26T01:00:00.000Z'

function project(projectId: string, revision = 5) {
  return makeCloudProject({
    projectId,
    projectRevision: revision,
    currentMilestoneId: 'ms_1',
    milestones: [
      makeCloudMilestone({
        milestoneId: 'ms_1',
        revision: 3,
        taskStats: { total: 1, done: 0, doing: 1, todo: 0, archived: 0, progress: 0 },
      }),
    ],
  })
}

function fixtures(projectId: string) {
  return {
    project: project(projectId),
    tasks: [
      makeCloudTask({
        taskId: `tsk_${projectId}`,
        projectId,
        milestoneId: 'ms_1',
        status: 'doing',
      }),
    ],
    evidence: [],
    progress: [],
  }
}

function historyMessage(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg_1',
    role: 'user',
    content: '当前阶段下一步该做什么',
    citations: [],
    createdAt: FIXED_ISO,
    ...overrides,
  }
}

function chatSuccess(init: RequestInit, overrides: Record<string, unknown> = {}): Response {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  return jsonResponse({
    contractVersion: '1.0',
    requestId: body['requestId'],
    projectId: body['projectId'],
    projectRevision: body['projectRevision'],
    source: 'model',
    fallbackReason: null,
    promptVersion: 'advisor-chat-v3',
    milestoneRevision: 3,
    citations: [],
    answer: '先补齐样例数据',
    sessionId: `chat_${String(body['projectId'])}`,
    messageId: 'msg_assistant_1',
    ...overrides,
  })
}

interface InstallOptions {
  projectIds?: string[]
  /** 每个项目的历史消息 */
  history?: Record<string, unknown[]>
  /** 覆盖任意请求（返回 undefined 表示不接管） */
  override?: (url: string, init: RequestInit) => Response | Promise<Response> | undefined
}

/** 安装路由：项目读取 + 聊天会话 + 顾问聊天，返回捕获到的聊天请求体 */
function install(options: InstallOptions = {}) {
  const projectIds = options.projectIds ?? [PROJECT_ID]
  const bases = projectIds.map((id) => cloudRoutes(fixtures(id)))
  const captured: { url: string; body: Record<string, unknown> }[] = []

  installFetch((url, init) => {
    const method = init.method ?? 'GET'
    const path = url.split('?')[0] ?? url

    const handled = options.override?.(url, init)
    if (handled !== undefined) return handled

    const sessionMatch = /\/api\/projects\/([^/]+)\/chat\/sessions$/.exec(path)
    if (sessionMatch !== null && method === 'POST') {
      const projectId = decodeURIComponent(sessionMatch[1]!)
      return jsonResponse(
        echoEnvelope(init, { sessionId: `chat_${projectId}`, createdAt: FIXED_ISO }),
      )
    }

    const messagesMatch = /\/api\/projects\/([^/]+)\/chat\/sessions\/([^/]+)\/messages$/.exec(path)
    if (messagesMatch !== null && method === 'GET') {
      const projectId = decodeURIComponent(messagesMatch[1]!)
      return jsonResponse(
        readEnvelope({ messages: options.history?.[projectId] ?? [] }, projectId, 5),
      )
    }

    if (url.includes('/api/advisor/chat')) {
      captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return chatSuccess(init)
    }

    for (const base of bases) {
      const result = base(url, init)
      if (result !== undefined) return result
    }
    return undefined
  })

  return captured
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('进入云端项目时恢复历史（契约 30.1 / 30.2）', () => {
  it('先取会话再读消息，按升序恢复并记录 sessionId', async () => {
    install({
      history: {
        [PROJECT_ID]: [
          historyMessage({ messageId: 'msg_1', role: 'user', content: '第一个问题' }),
          historyMessage({
            messageId: 'msg_2',
            role: 'assistant',
            content: '第一个回答',
            citations: [
              {
                materialId: 'mat_1',
                materialName: '实验手册.md',
                materialVersion: 1,
                segmentId: 'seg_0',
                startLine: 1,
                endLine: 6,
                itemId: null,
              },
            ],
          }),
        ],
      },
    })
    const store = useCloudStore()

    const opened = await store.openProject(PROJECT_ID)

    expect(opened.ok).toBe(true)
    expect(store.chat.historyStatus).toBe('ready')
    expect(store.chat.historyError).toBeNull()
    expect(store.chat.sessionId).toBe(`chat_${PROJECT_ID}`)
    expect(store.chat.messages.map((item) => item.text)).toEqual(['第一个问题', '第一个回答'])
    expect(store.chat.messages.map((item) => item.role)).toEqual(['user', 'assistant'])
    expect(store.chat.messages[1]?.citations).toHaveLength(1)
  })

  it('历史消息没有 source / fallbackReason，恢复后保持 undefined 且标记已持久化', async () => {
    install({
      history: { [PROJECT_ID]: [historyMessage({ role: 'assistant', messageId: 'msg_a' })] },
    })
    const store = useCloudStore()

    await store.openProject(PROJECT_ID)

    const restored = store.chat.messages[0]!
    expect(restored.source).toBeUndefined()
    expect(restored.fallbackReason).toBeUndefined()
    expect(restored.messageId).toBe('msg_a')
    expect(restored.persisted).toBe(true)
  })

  it('没有历史时恢复为空列表，不是错误', async () => {
    install()
    const store = useCloudStore()

    await store.openProject(PROJECT_ID)

    expect(store.chat.messages).toEqual([])
    expect(store.chat.historyStatus).toBe('ready')
    expect(store.chat.historyError).toBeNull()
  })

  it('历史拉取失败不阻塞打开项目，只标记 historyError', async () => {
    install({
      override: (url, init) => {
        if (url.includes('/chat/sessions') && (init.method ?? 'GET') === 'GET') {
          return jsonResponse(
            { contractVersion: '3.0', code: 'RESOURCE_NOT_FOUND', message: '会话不存在' },
            404,
          )
        }
        return undefined
      },
    })
    const store = useCloudStore()

    const opened = await store.openProject(PROJECT_ID)

    expect(opened.ok).toBe(true)
    expect(store.project?.projectId).toBe(PROJECT_ID)
    expect(store.chat.historyStatus).toBe('error')
    expect(store.chat.historyError?.code).toBe('RESOURCE_NOT_FOUND')
    expect(store.chat.historyError?.message).toBe('请求的资源不存在或已被删除')
    expect(store.chat.messages).toEqual([])
  })

  it('会话接口 401 时映射为中文错误，项目本身仍可打开', async () => {
    install({
      override: (url, init) => {
        if (url.endsWith('/chat/sessions') && (init.method ?? 'GET') === 'POST') {
          return jsonResponse(
            { contractVersion: '3.0', code: 'UNAUTHORIZED', message: 'login' },
            401,
          )
        }
        return undefined
      },
    })
    const store = useCloudStore()

    const opened = await store.openProject(PROJECT_ID)

    expect(opened.ok).toBe(true)
    expect(store.chat.historyStatus).toBe('error')
    expect(store.chat.historyError?.code).toBe('UNAUTHORIZED')
    expect(store.chat.historyError?.message).toBe('登录状态已失效，请重新登录')
  })
})

describe('发送消息时记录会话与消息 ID（契约 30.3）', () => {
  it('成功后写入 sessionId / messageId，并标记已持久化', async () => {
    const captured = install()
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.sendChat({ question: '下一步做什么' })

    expect(result.ok).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.body['promptVersion']).toBe('advisor-chat-v3')

    const assistant = store.chat.messages.at(-1)!
    expect(assistant.messageId).toBe('msg_assistant_1')
    expect(assistant.persisted).toBe(true)
    expect(store.chat.sessionId).toBe(`chat_${PROJECT_ID}`)
    expect(store.chat.pendingQuestion).toBeNull()
  })

  it('messageId 为 null 时照常展示回答，但不标记为已保存', async () => {
    install({
      override: (url, init) => {
        if (url.includes('/api/advisor/chat')) {
          return chatSuccess(init, { sessionId: null, messageId: null })
        }
        return undefined
      },
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.sendChat({ question: '下一步做什么' })

    expect(result.ok).toBe(true)
    const assistant = store.chat.messages.at(-1)!
    expect(assistant.text).toBe('先补齐样例数据')
    expect(assistant.messageId).toBeNull()
    expect(assistant.persisted).toBe(false)
    // 会话 ID 没拿到时保持原值（这里来自打开项目时的 get-or-create）
    expect(store.chat.sessionId).toBe(`chat_${PROJECT_ID}`)
  })

  it('失败后重试复用同一个 requestId，避免服务端重复写消息', async () => {
    let failFirst = true
    const captured: Record<string, unknown>[] = []
    install({
      override: (url, init) => {
        if (!url.includes('/api/advisor/chat')) return undefined
        captured.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        if (failFirst) {
          failFirst = false
          // 用不可自动重试的 400：INTERNAL/500 会被适配层自动重试一次，测不到手动重试
          return jsonResponse({ code: 'INVALID_INPUT', message: '请求不合法' }, 400)
        }
        return chatSuccess(init)
      },
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const failed = await store.sendChat({ question: '下一步做什么' })
    expect(failed.ok).toBe(false)
    expect(store.chat.pendingQuestion).toBe('下一步做什么')

    const retried = await store.retryChat()
    expect(retried.ok).toBe(true)

    expect(captured).toHaveLength(2)
    expect(captured[1]?.['requestId']).toBe(captured[0]?.['requestId'])
  })

  it('换一个问题时使用新的 requestId', async () => {
    const captured: Record<string, unknown>[] = []
    install({
      override: (url, init) => {
        if (!url.includes('/api/advisor/chat')) return undefined
        captured.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return chatSuccess(init)
      },
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    await store.sendChat({ question: '第一个问题' })
    await store.sendChat({ question: '第二个问题' })

    expect(captured).toHaveLength(2)
    expect(captured[1]?.['requestId']).not.toBe(captured[0]?.['requestId'])
  })
})

describe('项目切换与迟到响应', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  it('切换项目后聊天状态隔离，旧项目历史不残留', async () => {
    install({
      projectIds: [PROJECT_ID, OTHER_PROJECT_ID],
      history: {
        [PROJECT_ID]: [historyMessage({ messageId: 'msg_a', content: '旧项目历史' })],
        [OTHER_PROJECT_ID]: [],
      },
    })
    const store = useCloudStore()

    await store.openProject(PROJECT_ID)
    expect(store.chat.messages).toHaveLength(1)

    await store.openProject(OTHER_PROJECT_ID)

    expect(store.chat.messages).toEqual([])
    expect(store.chat.sessionId).toBe(`chat_${OTHER_PROJECT_ID}`)
    expect(store.chat.historyStatus).toBe('ready')
  })

  it('切项目后丢弃迟到的历史响应', async () => {
    const gate = deferred<Response>()
    install({
      projectIds: [PROJECT_ID, OTHER_PROJECT_ID],
      override: (url, init) => {
        if (!url.includes(`/api/projects/${PROJECT_ID}/chat/sessions/`)) return undefined
        if ((init.method ?? 'GET') !== 'GET') return undefined
        return gate.promise
      },
    })
    const store = useCloudStore()

    const first = store.openProject(PROJECT_ID)
    // 让第一个项目的读取先走到历史接口（此时 gate 挂起）
    await vi.waitFor(() => {
      expect(store.chat.historyStatus).toBe('loading')
    })

    await store.openProject(OTHER_PROJECT_ID)
    expect(store.chat.messages).toEqual([])
    expect(store.chat.sessionId).toBe(`chat_${OTHER_PROJECT_ID}`)

    gate.resolve(
      jsonResponse(readEnvelope({ messages: [historyMessage({ content: '迟到的历史' })] }, PROJECT_ID, 5)),
    )
    await first

    expect(store.project?.projectId).toBe(OTHER_PROJECT_ID)
    expect(store.chat.messages).toEqual([])
    expect(store.chat.sessionId).toBe(`chat_${OTHER_PROJECT_ID}`)
  })

  it('reset 后聊天状态整体回到初始值', async () => {
    install({
      history: { [PROJECT_ID]: [historyMessage()] },
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    expect(store.chat.messages).toHaveLength(1)

    store.reset()

    expect(store.chat.messages).toEqual([])
    expect(store.chat.sessionId).toBeNull()
    expect(store.chat.historyStatus).toBe('idle')
    expect(store.chat.historyError).toBeNull()
  })
})
