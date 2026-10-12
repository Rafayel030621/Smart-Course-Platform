import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/index.js'
import { createAdvisorService } from '../src/advisor/service.js'
import { createRuleFallback } from '../src/advisor/fallback.js'
import { buildMockSuggestions } from '../src/advisor/mockProvider.js'
import { createMaterialsService } from '../src/materials/understanding.js'
import { buildChatMessages, buildMessages } from '../src/advisor/prompt.js'
import { parseAdvisorChatRequest, parseAdvisorRequest } from '../src/advisor/validation.js'
import {
  silentLogger,
  type AdvisorChatRequest,
  type AdvisorProvider,
  type AdvisorRequest,
} from '../src/advisor/types.js'
import type { ServerConfig } from '../src/config.js'

/**
 * v2（M2-A）建议 / 聊天接口的最小材料接入
 * ----------------------------------------------------------------------------
 * 覆盖：可选字段解析、v1/v2 版本门禁、上限、提示词序列化，以及"未确认草稿不进请求体"。
 * 模型调用全部用注入 provider，不发真实网络请求。
 */

const MATERIAL_SEGMENT_TEXT = '主要字段：有效波高、风速、时间、经纬度。'

function confirmedMaterial(): Record<string, unknown> {
  return {
    materialId: 'mat_9b1e7c2f',
    name: '实验手册.md',
    type: 'md',
    version: 1,
    segments: [
      { segmentId: 'seg_1', startLine: 10, endLine: 24, text: MATERIAL_SEGMENT_TEXT },
    ],
  }
}

function profile(): Record<string, unknown> {
  return {
    goal: '构建极端风浪事件识别与预警的原型系统',
    expectedOutcome: '可交互原型 + 不超过 4 页的会议论文',
    memberNames: ['张同学', '李同学'],
    researchPeriod: '第 3 周至第 14 周',
    scope: '先做西北太平洋',
    outOfScope: '不做移动端',
  }
}

function recommendationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: '9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043',
    projectId: 'prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031',
    projectRevision: 14,
    projectName: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
    currentMilestone: '数据获取与预处理',
    confirmedContext: [],
    tasks: [
      {
        taskId: 'tsk_doing',
        title: '调研极端风浪事件的定义与识别方法',
        status: 'doing',
        doneCriteria: '一页调研笔记',
        owner: null,
        milestone: '数据获取与预处理',
        updatedAt: '2026-09-25T10:12:00+08:00',
      },
    ],
    evidence: [],
    doubts: [],
    promptVersion: 'mvp-prompt-v1',
    forceRefresh: false,
    ...overrides,
  }
}

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    promptVersion: 'advisor-chat-v1',
    requestId: 'chat_materials_1',
    projectId: 'prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031',
    projectRevision: 14,
    projectName: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
    currentMilestone: '数据获取与预处理',
    tasks: [],
    evidence: [],
    doubts: [],
    chatHistory: [{ role: 'user', text: '之前的问题' }],
    question: '材料里提到的数据字段够用吗？',
    ...overrides,
  }
}

/* --------------------------------------------------------------- 请求校验 */

describe('v2 可选字段校验', () => {
  test('旧请求（v1，无新字段）行为不变', () => {
    const result = parseAdvisorRequest(recommendationBody())
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.projectProfile, null)
      assert.deepEqual(result.value.confirmedMaterials, [])
    }
  })

  test('v1 携带 confirmedMaterials 时被拒绝', () => {
    const result = parseAdvisorRequest(recommendationBody({ confirmedMaterials: [confirmedMaterial()] }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes('v2')))
  })

  test('v1 携带 projectProfile 时被拒绝', () => {
    const result = parseAdvisorRequest(recommendationBody({ projectProfile: profile() }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.includes('v2')))
  })

  test('v2 携带项目基本信息与材料摘录时通过，字段被完整解析', () => {
    const result = parseAdvisorRequest(
      recommendationBody({
        promptVersion: 'mvp-prompt-v2',
        projectProfile: profile(),
        confirmedMaterials: [confirmedMaterial()],
      }),
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.projectProfile?.goal, '构建极端风浪事件识别与预警的原型系统')
      assert.deepEqual(result.value.projectProfile?.memberNames, ['张同学', '李同学'])
      assert.equal(result.value.confirmedMaterials?.length, 1)
      assert.equal(result.value.confirmedMaterials?.[0].segments[0].segmentId, 'seg_1')
    }
  })

  test('confirmedMaterials 超过上限时被拒绝', () => {
    const tooManyMaterials = Array.from({ length: 4 }, () => confirmedMaterial())
    assert.equal(parseAdvisorRequest(recommendationBody({ promptVersion: 'mvp-prompt-v2', confirmedMaterials: tooManyMaterials })).ok, false)

    const tooManySegments = [{
      ...confirmedMaterial(),
      segments: Array.from({ length: 21 }, (_, index) => ({
        segmentId: `seg_${index}`,
        startLine: index + 1,
        endLine: index + 1,
        text: '一段内容',
      })),
    }]
    assert.equal(parseAdvisorRequest(recommendationBody({ promptVersion: 'mvp-prompt-v2', confirmedMaterials: tooManySegments })).ok, false)

    const tooMuchText = [{
      ...confirmedMaterial(),
      segments: Array.from({ length: 5 }, (_, index) => ({
        segmentId: `seg_${index}`,
        startLine: index + 1,
        endLine: index + 1,
        text: '甲'.repeat(2000),
      })),
    }]
    assert.equal(parseAdvisorRequest(recommendationBody({ promptVersion: 'mvp-prompt-v2', confirmedMaterials: tooMuchText })).ok, false)
  })

  test('projectProfile 字段超长或成员过多时被拒绝', () => {
    const longGoal = { ...profile(), goal: '甲'.repeat(301) }
    assert.equal(parseAdvisorRequest(recommendationBody({ promptVersion: 'mvp-prompt-v2', projectProfile: longGoal })).ok, false)

    const manyMembers = { ...profile(), memberNames: Array.from({ length: 11 }, (_, index) => `成员${index}`) }
    assert.equal(parseAdvisorRequest(recommendationBody({ promptVersion: 'mvp-prompt-v2', projectProfile: manyMembers })).ok, false)
  })

  test('聊天请求里的未确认草稿字段被忽略，不进入模型上下文', () => {
    const body = chatBody({
      understandingDraft: { goalCandidates: [{ text: '尚未确认的聊天草稿内容' }] },
    })
    const result = parseAdvisorChatRequest(body)
    assert.equal(result.ok, true)

    if (result.ok) {
      const messages = buildChatMessages(result.value)
      assert.doesNotMatch(messages[1].content, /尚未确认的聊天草稿内容/)
    }
  })

  test('聊天接口同样执行版本门禁', () => {
    assert.equal(parseAdvisorChatRequest(chatBody({ confirmedMaterials: [confirmedMaterial()] })).ok, false)
    assert.equal(parseAdvisorChatRequest(chatBody({ promptVersion: 'advisor-chat-v2', confirmedMaterials: [confirmedMaterial()] })).ok, true)
  })

  test('未确认草稿类未知字段被忽略，也不进入模型上下文', () => {
    const body = recommendationBody({
      // 模拟前端误把未确认草稿塞进请求体：应当被忽略，不参与提示词
      understandingDraft: { goalCandidates: [{ text: '尚未确认的草稿内容' }] },
      draftStatus: 'pending',
    })
    const result = parseAdvisorRequest(body)
    assert.equal(result.ok, true)

    if (result.ok) {
      const messages = buildMessages(result.value)
      assert.doesNotMatch(messages[1].content, /尚未确认的草稿内容/)
    }
  })
})

/* --------------------------------------------------------------- 提示词 */

describe('提示词序列化', () => {
  function parsedV2Request(): AdvisorRequest {
    const result = parseAdvisorRequest(
      recommendationBody({
        promptVersion: 'mvp-prompt-v2',
        projectProfile: profile(),
        confirmedMaterials: [confirmedMaterial()],
      }),
    )
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('请求应当通过校验')
    return result.value
  }

  test('v2 请求：材料名、行号与项目基本信息进入提示词，使用中文标签', () => {
    const messages = buildMessages(parsedV2Request())
    assert.match(messages[0].content, /已确认材料摘录/)
    assert.match(messages[1].content, /已确认项目基本信息/)
    assert.match(messages[1].content, /项目目标/)
    assert.match(messages[1].content, /实验手册\.md/)
    assert.match(messages[1].content, /10-24/)
    assert.match(messages[1].content, /有效波高/)
  })

  test('v1 请求：提示词与 v1.3 一致，不包含材料与基本信息', () => {
    const result = parseAdvisorRequest(recommendationBody())
    assert.equal(result.ok, true)
    if (!result.ok) return

    const messages = buildMessages(result.value)
    assert.doesNotMatch(messages[0].content, /已确认材料摘录/)
    assert.doesNotMatch(messages[1].content, /实验手册\.md|项目目标/)
  })

  test('聊天 v2：上下文包含材料摘录；聊天 v1 不含', () => {
    const v2 = parseAdvisorChatRequest(
      chatBody({ promptVersion: 'advisor-chat-v2', projectProfile: profile(), confirmedMaterials: [confirmedMaterial()] }),
    )
    assert.equal(v2.ok, true)
    if (v2.ok) {
      const messages = buildChatMessages(v2.value)
      assert.match(messages[1].content, /已确认材料摘录/)
      assert.match(messages[1].content, /实验手册\.md/)
    }

    const v1 = parseAdvisorChatRequest(chatBody())
    assert.equal(v1.ok, true)
    if (v1.ok) {
      const messages = buildChatMessages(v1.value)
      assert.doesNotMatch(messages[1].content, /实验手册\.md/)
    }
  })
})

/* --------------------------------------------------------------- HTTP */

interface RecordingProvider {
  provider: AdvisorProvider
  advisorRequests: AdvisorRequest[]
  chatRequests: AdvisorChatRequest[]
}

function recordingProvider(): RecordingProvider {
  const advisorRequests: AdvisorRequest[] = []
  const chatRequests: AdvisorChatRequest[] = []
  const provider: AdvisorProvider = {
    name: 'recording',
    async generate(request) {
      advisorRequests.push(request)
      return { suggestions: buildMockSuggestions(request) }
    },
    async generateChat(request) {
      chatRequests.push(request)
      return { answer: '请先依据已确认的材料摘录核对数据字段，再决定下一步。' }
    },
  }
  return { provider, advisorRequests, chatRequests }
}

const testConfig: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  serviceName: 'course-platform-api',
  contractVersion: '1.0',
}

async function withRecording<T>(run: (baseUrl: string, recorder: RecordingProvider) => Promise<T>): Promise<T> {
  const recorder = recordingProvider()
  const app = createApp(testConfig, {
    logger: silentLogger,
    advisorService: createAdvisorService({ provider: recorder.provider, fallback: createRuleFallback(), logger: silentLogger }),
    materialsService: createMaterialsService({ provider: recorder.provider, logger: silentLogger }),
  })
  await new Promise<void>((resolve) => app.listen(0, testConfig.host, resolve))
  const address = app.address() as AddressInfo

  try {
    return await run(`http://${testConfig.host}:${address.port}`, recorder)
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('建议接口 v2 + 材料摘录：200 source=model，provider 收到的请求带已确认片段', async () => {
  await withRecording(async (baseUrl, recorder) => {
    const response = await postJson(baseUrl, '/api/advisor/recommendations', recommendationBody({
      promptVersion: 'mvp-prompt-v2',
      projectProfile: profile(),
      confirmedMaterials: [confirmedMaterial()],
    }))
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200)
    assert.equal(body.source, 'model')
    assert.equal(recorder.advisorRequests.length, 1)
    assert.equal(recorder.advisorRequests[0].confirmedMaterials?.[0].segments[0].text, MATERIAL_SEGMENT_TEXT)
    assert.equal(recorder.advisorRequests[0].projectProfile?.goal, '构建极端风浪事件识别与预警的原型系统')
  })
})

test('建议接口 v1 + 材料摘录：400 INVALID_INPUT', async () => {
  await withRecording(async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/advisor/recommendations', recommendationBody({
      confirmedMaterials: [confirmedMaterial()],
    }))
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(response.status, 400)
    assert.equal(body.code, 'INVALID_INPUT')
    assert.equal(body.retryable, false)
  })
})

test('聊天接口 v2 + 材料摘录：200 source=model，请求带已确认片段', async () => {
  await withRecording(async (baseUrl, recorder) => {
    const response = await postJson(baseUrl, '/api/advisor/chat', chatBody({
      promptVersion: 'advisor-chat-v2',
      confirmedMaterials: [confirmedMaterial()],
    }))
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200)
    assert.equal(body.source, 'model')
    assert.equal(recorder.chatRequests.length, 1)
    assert.equal(recorder.chatRequests[0].confirmedMaterials?.[0].segments[0].segmentId, 'seg_1')
  })
})

test('聊天接口 v1 + 材料摘录：400 INVALID_INPUT', async () => {
  await withRecording(async (baseUrl) => {
    const response = await postJson(baseUrl, '/api/advisor/chat', chatBody({ confirmedMaterials: [confirmedMaterial()] }))
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(response.status, 400)
    assert.equal(body.code, 'INVALID_INPUT')
  })
})
