import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCloudStore } from '@/stores/cloud'
import { MILESTONE_CANDIDATE_PROMPT_VERSION, supportsMilestoneContext } from '@/domain/recommendation'
import {
  cloudRoutes,
  installFetch,
  jsonResponse,
  makeCloudMaterial,
  makeCloudMilestone,
  makeCloudProject,
  makeCloudTask,
  makeEvidence,
  makeMaterialSegment,
  makeProgress,
  makeUnderstandingItem,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'

interface Captured {
  url: string
  body: Record<string, unknown>
}

function project() {
  return makeCloudProject({
    projectId: PROJECT_ID,
    projectRevision: 5,
    name: '极端风浪事件分析',
    currentMilestoneId: 'ms_1',
    milestones: [
      makeCloudMilestone({
        milestoneId: 'ms_1',
        revision: 3,
        taskStats: { total: 2, done: 1, doing: 1, todo: 0, archived: 0, progress: 50 },
      }),
    ],
  })
}

function fixtures() {
  return {
    project: project(),
    tasks: [
      makeCloudTask({ taskId: 'tsk_1', milestoneId: 'ms_1', status: 'done', orderIndex: 0 }),
      makeCloudTask({ taskId: 'tsk_2', milestoneId: 'ms_1', status: 'doing', orderIndex: 1, title: '清洗风浪数据' }),
    ],
    evidence: [makeEvidence({ evidenceId: 'evd_1', milestoneId: 'ms_1' })],
    progress: [makeProgress({ progressId: 'prg_1', milestoneId: 'ms_1', summary: '校正后：完成 3 组数据' })],
    materials: [makeCloudMaterial()],
    materialSegments: {
      'mat_1@1': [makeMaterialSegment({ segmentId: 'seg_0', text: '已确认的正文片段' })],
    },
    materialItems: {
      'mat_1@1': [makeUnderstandingItem({ itemId: 'it_1', status: 'confirmed' })],
    },
  }
}

function suggestionResponse(init: RequestInit) {
  return {
    contractVersion: '1.0',
    requestId: String((JSON.parse(String(init.body)) as Record<string, unknown>)['requestId']),
    projectId: PROJECT_ID,
    projectRevision: 5,
    source: 'model',
    fallbackReason: null,
    cached: false,
    promptVersion: 'mvp-prompt-v2',
    suggestions: [
      {
        title: '先补齐缺失的潮位序列',
        whyNow: '当前阶段的完成标准要求样例数据可复现',
        doneCriteria: '补齐后 3 组样例都能跑通',
        existingTaskId: null,
        basisEvidenceIds: ['evd_1'],
        basisDoubtIds: [],
      },
    ],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

async function openStore(captured: Captured[] = []) {
  const base = cloudRoutes(fixtures())
  installFetch((url, init) => {
    if (url.includes('/api/advisor/')) {
      captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return jsonResponse(suggestionResponse(init))
    }
    return base(url, init)
  })
  const store = useCloudStore()
  await store.openProject(PROJECT_ID)
  return store
}

describe('云端顾问建议', () => {
  it('云端项目默认发 v3：请求体带真实 milestoneContext，且提示词版本与接口匹配', async () => {
    const captured: Captured[] = []
    const store = await openStore(captured)

    const result = await store.refreshAdvisor()

    expect(supportsMilestoneContext('cloud')).toBe(true)
    expect(result.ok).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toContain('/api/advisor/recommendations')
    const body = captured[0]!.body
    expect(body['promptVersion']).toBe('mvp-prompt-v3')
    expect(body['promptVersion']).not.toBe(MILESTONE_CANDIDATE_PROMPT_VERSION)
    const context = body['milestoneContext'] as Record<string, unknown>
    expect(context['milestoneId']).toBe('ms_1')
    expect(context['currentMilestone']).toBe('数据获取与预处理')
    expect(context['milestoneRevision']).toBe(3)
    expect(context['milestoneStatus']).toBe('active')
    expect((context['milestoneTasks'] as unknown[]).length).toBe(2)
    expect((context['recentProgress'] as Array<Record<string, unknown>>)[0]!['progressId']).toBe('prg_1')
    expect(store.advisor.contextAttached).toBe(true)
    // 契约 23.2 规则 5：顶层 currentMilestone 必须与上下文一致
    expect(body['currentMilestone']).toBe('数据获取与预处理')
  })

  it('上下文里的实体 ID 全部来自当前云端项目，不夹带其他项目的数据', async () => {
    const captured: Captured[] = []
    const store = await openStore(captured)
    // 混入一条别的项目的证据与任务：不得进入请求
    store.evidence = [
      ...store.evidence,
      makeEvidence({ evidenceId: 'evd_other', projectId: 'prj_other', milestoneId: 'ms_1' }),
    ]
    store.tasks = [
      ...store.tasks,
      makeCloudTask({ taskId: 'tsk_other', projectId: 'prj_other', milestoneId: 'ms_1' }),
    ]

    await store.refreshAdvisor()

    const body = captured[0]!.body
    const context = body['milestoneContext'] as Record<string, unknown>
    const ids = JSON.stringify(context) + JSON.stringify(body['tasks']) + JSON.stringify(body['evidence'])
    expect(ids).not.toContain('evd_other')
    expect(ids).not.toContain('tsk_other')
    expect(ids).not.toContain('prj_other')
  })

  it('服务端项目级校验失败（400 INVALID_INPUT）原样透出，不静默降级成 v2', async () => {
    const base = cloudRoutes(fixtures())
    const captured: Captured[] = []
    installFetch((url, init) => {
      if (url.includes('/api/advisor/recommendations')) {
        captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        return jsonResponse(
          { code: 'INVALID_INPUT', message: '阶段任务不属于当前项目或当前阶段', retryable: false },
          400,
        )
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.refreshAdvisor()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_INPUT')
    // 只有一次请求，且仍然是 v3：契约 23.1 不允许自动降级
    expect(captured).toHaveLength(1)
    expect(captured[0]!.body['promptVersion']).toBe('mvp-prompt-v3')
    expect(store.advisor.status).toBe('error')
    expect(store.advisor.error?.message).toBe('阶段任务不属于当前项目或当前阶段')
  })

  it('confirmedMaterials 只含已确认条目，未确认正文不进入请求', async () => {
    const captured: Captured[] = []
    const store = await openStore(captured)

    await store.refreshAdvisor()

    const materials = captured[0]!.body['confirmedMaterials'] as Array<Record<string, unknown>>
    expect(materials).toHaveLength(1)
    expect(JSON.stringify(materials)).toContain('已确认的正文片段')
  })

  it('任务列表未恢复时拒绝发请求，不伪造上下文', async () => {
    const store = await openStore()
    store.tasks = []
    store.milestones = [
      makeCloudMilestone({
        milestoneId: 'ms_1',
        taskStats: { total: 2, done: 1, doing: 1, todo: 0, archived: 0, progress: 50 },
      }),
    ]
    const before = vi.mocked(fetch).mock.calls.length

    const result = await store.refreshAdvisor()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TASKS_NOT_AVAILABLE')
    expect(store.advisor.status).toBe('error')
    expect(vi.mocked(fetch).mock.calls.length).toBe(before)
  })

  it('接口失败时保留错误信息，不显示旧建议', async () => {
    const base = cloudRoutes(fixtures())
    installFetch((url, init) => {
      if (url.includes('/api/advisor/recommendations')) {
        return jsonResponse({ code: 'MODEL_UNAVAILABLE', message: '模型服务暂不可用', retryable: false }, 503)
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.refreshAdvisor()

    expect(result.ok).toBe(false)
    expect(store.advisor.status).toBe('error')
    expect(store.advisor.suggestions).toEqual([])
    expect(store.advisor.error?.code).toBe('MODEL_UNAVAILABLE')
  })
})

describe('云端聊天', () => {
  function chatResponse(init: RequestInit, answer: string) {
    return {
      contractVersion: '1.0',
      requestId: String((JSON.parse(String(init.body)) as Record<string, unknown>)['requestId']),
      projectId: PROJECT_ID,
      projectRevision: 5,
      source: 'model',
      fallbackReason: null,
      answer,
    }
  }

  it('发送成功后入列提问与回答；第二次提问会带上历史', async () => {
    const captured: Captured[] = []
    const base = cloudRoutes(fixtures())
    let round = 0
    installFetch((url, init) => {
      if (url.includes('/api/advisor/chat')) {
        captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        round += 1
        return jsonResponse(chatResponse(init, round === 1 ? '先补齐潮位序列' : '再跑一次基线'))
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const first = await store.sendChat({ question: '下一步做什么？' })
    expect(first.ok).toBe(true)
    expect(store.chat.status).toBe('ready')
    expect(store.chat.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(store.chat.messages[0]!.text).toBe('下一步做什么？')
    expect(store.chat.messages[1]!.text).toBe('先补齐潮位序列')

    const second = await store.sendChat({ question: '然后呢？' })
    expect(second.ok).toBe(true)
    const history = captured[1]!.body['chatHistory'] as Array<Record<string, unknown>>
    expect(history).toHaveLength(2)
    expect(history[0]!['role']).toBe('user')
    expect(history[1]!['text']).toBe('先补齐潮位序列')
    // 契约 23.7：聊天同样走 v3 并携带阶段上下文；历史由客户端回传（服务端不落库）
    expect(captured[1]!.body['promptVersion']).toBe('advisor-chat-v3')
    expect(captured[0]!.body['promptVersion']).toBe('advisor-chat-v3')
    expect((captured[0]!.body['milestoneContext'] as Record<string, unknown>)['milestoneId']).toBe('ms_1')
    expect(store.chat.contextAttached).toBe(true)
  })

  it('同一时刻只允许一个在途提问', async () => {
    const base = cloudRoutes(fixtures())
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installFetch(async (url, init) => {
      if (url.includes('/api/advisor/chat')) {
        await gate
        return jsonResponse(chatResponse(init, '慢慢来'))
      }
      return base(url, init) ?? jsonResponse({}, 404)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const first = store.sendChat({ question: '第一问' })
    await Promise.resolve()
    const second = await store.sendChat({ question: '第二问' })

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('DUPLICATE_REQUEST')
    release()
    expect((await first).ok).toBe(true)
    expect(store.chat.messages).toHaveLength(2)
  })

  it('请求失败保留待重发的问题，重试复用原文不重复入列', async () => {
    const base = cloudRoutes(fixtures())
    let fail = true
    let attempts = 0
    installFetch((url, init) => {
      if (url.includes('/api/advisor/chat')) {
        attempts += 1
        if (fail) return jsonResponse({ code: 'MODEL_UNAVAILABLE', message: '模型服务暂不可用', retryable: false }, 503)
        return jsonResponse(chatResponse(init, '这次成功了'))
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const failed = await store.sendChat({ question: '数据清洗卡住了怎么办？' })
    expect(failed.ok).toBe(false)
    expect(store.chat.status).toBe('error')
    expect(store.chat.messages).toEqual([])
    expect(store.chat.pendingQuestion).toBe('数据清洗卡住了怎么办？')

    fail = false
    const retried = await store.retryChat()

    expect(retried.ok).toBe(true)
    expect(attempts).toBe(2)
    expect(store.chat.messages.map((message) => message.text)).toEqual(['数据清洗卡住了怎么办？', '这次成功了'])
    expect(store.chat.pendingQuestion).toBeNull()
  })

  it('切换项目 / 退出登录清空聊天，迟到的回答不会串项目', async () => {
    const base = cloudRoutes(fixtures())
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installFetch(async (url, init) => {
      if (url.includes('/api/advisor/chat')) {
        await gate
        return jsonResponse(chatResponse(init, '迟到的回答'))
      }
      return base(url, init) ?? jsonResponse({}, 404)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    const pending = store.sendChat({ question: '这一步怎么做？' })
    await Promise.resolve()

    store.reset()
    release()
    const result = await pending

    expect(result.ok).toBe(false)
    expect(store.chat.messages).toEqual([])
    expect(store.chat.status).toBe('idle')
  })

  it('问题为空或超长时本地拒绝', async () => {
    const store = await openStore()

    const blank = await store.sendChat({ question: '   ' })
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.code).toBe('INVALID_INPUT')

    const tooLong = await store.sendChat({ question: '啊'.repeat(2001) })
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.code).toBe('INVALID_INPUT')
    expect(store.chat.messages).toEqual([])
  })

  it('契约 23.7：回答里的 citations 按服务端回填的真实字段保存，提问自身不带引用', async () => {
    const base = cloudRoutes(fixtures())
    installFetch((url, init) => {
      if (url.includes('/api/advisor/chat')) {
        return jsonResponse({
          ...chatResponse(init, '按《实验手册》第 10–24 行，先确认四个字段口径。'),
          promptVersion: 'advisor-chat-v3',
          milestoneRevision: 3,
          citations: [
            {
              materialId: 'mat_1',
              materialName: '实验手册.md',
              materialVersion: 1,
              segmentId: 'seg_0',
              startLine: 10,
              endLine: 24,
              itemId: 'it_1',
            },
          ],
        })
      }
      return base(url, init) ?? jsonResponse({}, 404)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.sendChat({ question: '这四个字段怎么定？' })

    expect(result.ok).toBe(true)
    const assistant = store.chat.messages[1]!
    expect(assistant.role).toBe('assistant')
    expect(assistant.citations).toEqual([
      {
        materialId: 'mat_1',
        materialName: '实验手册.md',
        materialVersion: 1,
        segmentId: 'seg_0',
        startLine: 10,
        endLine: 24,
        itemId: 'it_1',
      },
    ])
    // 契约 23.7：提问没有材料依据，不得暗示存在引用
    expect(store.chat.messages[0]!.citations).toEqual([])
  })

  it('契约 23.1：版本组合不成立时按 CONTRACT_VERSION_MISMATCH 呈现，不降级重发', async () => {
    const base = cloudRoutes(fixtures())
    let attempts = 0
    installFetch((url, init) => {
      if (url.includes('/api/advisor/chat')) {
        attempts += 1
        return jsonResponse(
          {
            code: 'CONTRACT_VERSION_MISMATCH',
            message: '使用 v3 提示词时必须携带 milestoneContext',
            retryable: false,
          },
          400,
        )
      }
      return base(url, init) ?? jsonResponse({}, 404)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.sendChat({ question: '下一步做什么？' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('CONTRACT_VERSION_MISMATCH')
    expect(attempts).toBe(1)
    expect(store.chat.status).toBe('error')
    expect(store.chat.messages).toEqual([])
    expect(store.chat.pendingQuestion).toBe('下一步做什么？')
  })
})

describe('空白项目 / 非进行中阶段', () => {
  it('没有当前阶段时发 v3 + 全 null 的空上下文（契约 23.2 规则 2）', async () => {
    const captured: Captured[] = []
    const base = cloudRoutes({
      project: makeCloudProject({
        projectId: PROJECT_ID,
        projectRevision: 5,
        currentMilestoneId: null,
        milestones: [],
      }),
      tasks: [],
      evidence: [],
      progress: [],
    })
    installFetch((url, init) => {
      if (url.includes('/api/advisor/recommendations')) {
        captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        return jsonResponse({
          contractVersion: '1.0',
          requestId: String((JSON.parse(String(init.body)) as Record<string, unknown>)['requestId']),
          projectId: PROJECT_ID,
          projectRevision: 5,
          source: 'model',
          fallbackReason: null,
          cached: false,
          promptVersion: 'mvp-prompt-v3',
          milestoneRevision: null,
          suggestions: [],
        })
      }
      return base(url, init) ?? jsonResponse({}, 404)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.refreshAdvisor()

    expect(result.ok).toBe(true)
    const body = captured[0]!.body
    expect(body['promptVersion']).toBe('mvp-prompt-v3')
    expect(body['currentMilestone']).toBeNull()
    expect(body['milestoneContext']).toEqual({
      milestoneId: null,
      currentMilestone: null,
      milestoneRevision: null,
      milestoneGoal: null,
      milestoneDoneCriteria: null,
      milestoneStatus: null,
      milestoneTasks: [],
      recentProgress: [],
      milestoneEvidence: [],
    })
  })

  it('当前阶段已完成时上下文全空，顶层 currentMilestone 同步为 null（不出现半空组合）', async () => {
    const captured: Captured[] = []
    const base = cloudRoutes({
      project: makeCloudProject({
        projectId: PROJECT_ID,
        projectRevision: 5,
        currentMilestoneId: 'ms_1',
        milestones: [
          makeCloudMilestone({
            milestoneId: 'ms_1',
            status: 'completed',
            completedAt: '2026-10-20T00:00:00.000Z',
            taskStats: { total: 0, done: 0, doing: 0, todo: 0, archived: 0, progress: 0 },
          }),
        ],
      }),
      tasks: [],
      evidence: [],
      progress: [],
    })
    installFetch((url, init) => {
      if (url.includes('/api/advisor/recommendations')) {
        captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
        return jsonResponse({
          contractVersion: '1.0',
          requestId: String((JSON.parse(String(init.body)) as Record<string, unknown>)['requestId']),
          projectId: PROJECT_ID,
          projectRevision: 5,
          source: 'model',
          fallbackReason: null,
          cached: false,
          promptVersion: 'mvp-prompt-v3',
          milestoneRevision: null,
          suggestions: [],
        })
      }
      return base(url, init) ?? jsonResponse({}, 404)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.refreshAdvisor()

    expect(result.ok).toBe(true)
    const body = captured[0]!.body
    const context = body['milestoneContext'] as Record<string, unknown>
    expect(context['milestoneId']).toBeNull()
    expect(context['milestoneStatus']).toBeNull()
    expect(body['currentMilestone']).toBeNull()
  })
})
