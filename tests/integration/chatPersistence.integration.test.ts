/**
 * 聊天持久化真实 HTTP 联调（opt-in，仅 loopback）
 * ----------------------------------------------------------------------------
 * 后端：本仓库 `server/`（`ADVISOR_PROVIDER=mock`），独立端口 + 临时 SQLite + 随机邀请码。
 * 覆盖契约第 30 节的确定性路径：
 *   1. 会话 get-or-create 两次返回同一 sessionId；
 *   2. `advisor-chat-v3` 发送后消息落库，响应带 sessionId / messageId；
 *   3. 重新 GET 能恢复升序历史（user 在前、assistant 在后）；
 *   4. `before` 参数被服务端拒绝（400），客户端本来就不发；
 *   5. limit 边界（200 合法、0/201 拒绝）；
 *   6. 跨用户 / 伪造 sessionId 返回 404。
 *
 * 明确不在本套件内：真实模型回答质量、500 条上限的裁剪行为（页面不提示，属人工验收）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlatformStore } from '@/stores/platform'
import { useCloudStore } from '@/stores/cloud'
import {
  CHAT_MESSAGES_DEFAULT_LIMIT,
  getOrCreateChatSession,
  listChatMessages,
} from '@/services/chatSessionsApi'
import {
  HAS_INVITE_CODE,
  LOCAL_BASE_URL,
  SKIP_REASON,
  TEST_ACCOUNT,
  TEST_MARKER,
  TEST_PASSWORD,
  installLocalFetchGuard,
  localRequest,
  must,
  newRequestId,
  type LocalFetchGuard,
} from '../support/v3LocalHarness'

const RUN = LOCAL_BASE_URL !== '' && HAS_INVITE_CODE
const INVITE_CODE = (process.env.V3_LOCAL_INVITE_CODE ?? '').trim()

if (!RUN) console.info(SKIP_REASON)

let guard: LocalFetchGuard | null = null
let platform: ReturnType<typeof usePlatformStore>
let cloud: ReturnType<typeof useCloudStore>

let projectId = ''
let milestoneId = ''
let sessionId = ''
let otherAccount = ''
const question = '当前阶段的下一步该做什么？'

async function registerAccount(account: string): Promise<void> {
  const response = await localRequest('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contractVersion: '3.0',
      requestId: newRequestId(),
      idempotencyKey: `it-chat-register-${account}`,
      account,
      password: TEST_PASSWORD,
      displayName: '聊天持久化联调用户',
      inviteCode: INVITE_CODE,
    }),
  })
  expect(response.status, `注册失败：HTTP ${response.status}`).toBeLessThan(300)
  must(await platform.initialize(), `初始化会话（${account}）`)
  expect(platform.authStatus).toBe('authenticated')
}

function messagesPath(targetProjectId: string, targetSessionId: string): string {
  return `/api/projects/${targetProjectId}/chat/sessions/${targetSessionId}/messages`
}

describe.skipIf(!RUN)('聊天持久化（真实 HTTP，仅 loopback）', () => {
  beforeAll(async () => {
    setActivePinia(createPinia())
    guard = installLocalFetchGuard()
    platform = usePlatformStore()
    cloud = useCloudStore()

    await registerAccount(TEST_ACCOUNT)
    const created = must(
      await platform.createCloudProject({
        name: `[${TEST_MARKER}] chat persistence`,
        profile: {
          goal: '验证聊天落库与会话恢复',
          expectedOutcome: '会话、消息、历史读取都可断言',
          memberNames: ['聊天持久化联调用户'],
          researchPeriod: '2026-10',
          scope: '仅本地临时数据库',
          outOfScope: null,
        },
      }),
      '创建项目',
    )
    projectId = created.data.projectId
    must(await cloud.openProject(projectId), '打开项目')

    const milestone = must(
      await cloud.createMilestone({
        name: '数据获取与预处理',
        goal: '拿到可复现的样例数据',
        doneCriteria: '样例数据可下载',
        status: 'active',
      }),
      '创建阶段',
    )
    milestoneId = milestone.data.milestoneId
    must(
      await cloud.createTask({
        title: '跑通数据下载链路',
        doneCriteria: '能读出关键变量',
        milestoneId,
        status: 'doing',
      }),
      '创建任务',
    )
  }, 90_000)

  afterAll(() => {
    guard?.uninstall()
    console.info(
      `[${TEST_MARKER}] chat 联调数据（不会自动清理）：` +
        JSON.stringify({ projectId, sessionId, otherAccount }),
    )
  })

  it('打开项目时自动取得会话（get-or-create 两次返回同一 sessionId）', async () => {
    // openProject 内部已经 POST 过一次 sessions
    expect(cloud.chat.historyError).toBeNull()
    expect(cloud.chat.historyStatus).toBe('ready')
    expect(cloud.chat.sessionId).toMatch(/^chat_/)
    sessionId = cloud.chat.sessionId!

    const again = must(
      await getOrCreateChatSession(projectId, { projectRevision: cloud.projectRevision }),
      '再次取得会话',
    )

    expect(again.data.sessionId).toBe(sessionId)
    expect(again.data.createdAt).not.toBe('')
  })

  it('advisor-chat-v3 发送后落库：助手消息带 messageId 并标记已保存', async () => {
    const result = must(await cloud.sendChat({ question }), '发送聊天')

    const assistant = result.data
    expect(assistant.role).toBe('assistant')
    expect(assistant.messageId).toMatch(/^msg_/)
    expect(assistant.persisted).toBe(true)
    // 会话沿用打开项目时取得的那一个
    expect(cloud.chat.sessionId).toBe(sessionId)
  })

  it('重新 GET 能恢复升序历史：先提问、后回答', async () => {
    const history = must(await listChatMessages(projectId, sessionId), '读取历史')

    expect(history.data.messages.length).toBeGreaterThanOrEqual(2)
    const roles = history.data.messages.map((item) => item.role)
    expect(roles.slice(0, 2)).toEqual(['user', 'assistant'])
    expect(history.data.messages[0]?.content).toBe(question)
    expect(history.data.messages[1]?.content.trim()).not.toBe('')

    // 历史消息没有来源字段，客户端也不补造（由 store 层保证，这里确认 DTO 上没有）
    const first = history.data.messages[0]!
    expect(Object.prototype.hasOwnProperty.call(first, 'source')).toBe(false)
    expect(Array.isArray(first.citations)).toBe(true)
  })

  it('store 重新打开项目后能恢复刚才的历史，且不伪造来源', async () => {
    must(await cloud.openProject(projectId), '重新打开项目')

    expect(cloud.chat.sessionId).toBe(sessionId)
    expect(cloud.chat.historyStatus).toBe('ready')
    expect(cloud.chat.messages.length).toBeGreaterThanOrEqual(2)
    const userMessage = cloud.chat.messages[0]!
    expect(userMessage.text).toBe(question)
    expect(userMessage.source).toBeUndefined()
    expect(userMessage.fallbackReason).toBeUndefined()
  })

  it('limit 边界：200 合法，0 / 201 被拒 400', async () => {
    const max = await localRequest(`${messagesPath(projectId, sessionId)}?limit=200`)
    expect(max.status).toBe(200)
    expect(CHAT_MESSAGES_DEFAULT_LIMIT).toBe(200)

    for (const limit of ['0', '201']) {
      const response = await localRequest(`${messagesPath(projectId, sessionId)}?limit=${limit}`)
      expect(response.status, `limit=${limit}`).toBe(400)
      const body = (await response.json()) as Record<string, unknown>
      expect(body['code']).toBe('INVALID_INPUT')
    }
  })

  it('before 参数被服务端显式拒绝 400（客户端一律不发送）', async () => {
    const response = await localRequest(
      `${messagesPath(projectId, sessionId)}?limit=200&before=2026-10-26T00:00:00.000Z`,
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['code']).toBe('INVALID_INPUT')
    expect(String(body['message'])).toContain('before')
  })

  it('伪造 sessionId 返回 404 RESOURCE_NOT_FOUND', async () => {
    const result = await listChatMessages(projectId, 'chat_does_not_exist')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RESOURCE_NOT_FOUND')
    expect(result.error.status).toBe(404)
  })

  it('跨用户访问他人项目的会话返回 404', async () => {
    otherAccount = `${TEST_ACCOUNT}_b`
    // 注册第二个账号会顶掉当前会话
    await registerAccount(otherAccount)

    const result = await listChatMessages(projectId, sessionId)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.status).toBe(404)
    expect(['PROJECT_NOT_FOUND', 'RESOURCE_NOT_FOUND']).toContain(result.error.code)
  })

  it('确实只访问了 loopback', () => {
    const requests = guard?.requests ?? []
    expect(requests.length).toBeGreaterThan(0)
    for (const url of requests) {
      const parsed = new URL(url)
      expect(['127.0.0.1', 'localhost', '::1', '[::1]']).toContain(parsed.hostname)
    }
  })
})
