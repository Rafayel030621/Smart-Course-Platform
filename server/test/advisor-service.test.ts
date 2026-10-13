import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdvisorService } from '../src/advisor/service.js'
import { createRuleFallback, buildRuleSuggestions } from '../src/advisor/fallback.js'
import { createMockProvider, buildMockSuggestions } from '../src/advisor/mockProvider.js'
import { LIMITS, normalizeSuggestions, parseAdvisorRequest } from '../src/advisor/validation.js'
import {
  AdvisorProviderError,
  silentLogger,
  type AdvisorChatRequest,
  type AdvisorRequest,
  type AdvisorProvider,
} from '../src/advisor/types.js'

/**
 * 校验层与服务层的单元测试
 * ----------------------------------------------------------------------------
 * 直接调用模块函数，不起 HTTP 服务：验证"不补默认值"、"能修就修/不能修就丢"、
 * 以及 provider/兜底各种失败组合下服务层给出的结论。
 */

const validRequest: AdvisorRequest = {
  requestId: '9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043',
  projectId: 'prj_1',
  projectRevision: 3,
  projectName: '测试项目',
  currentMilestone: '选题确认与文献调研',
  confirmedContext: ['目标：做一件事'],
  tasks: [
    {
      taskId: 'tsk_doing',
      title: '进行中的任务',
      status: 'doing',
      doneCriteria: '留下一条证据',
      owner: null,
      milestone: '选题确认与文献调研',
      updatedAt: '2026-09-25T10:12:00+08:00',
    },
    {
      taskId: 'tsk_done',
      title: '已完成的任务',
      status: 'done',
      doneCriteria: null,
      owner: null,
      milestone: null,
      updatedAt: '2026-09-24T10:00:00+08:00',
    },
  ],
  evidence: [
    {
      evidenceId: 'evd_1',
      submissionId: 'sub_1',
      taskId: 'tsk_doing',
      didWhat: '做了一件事',
      foundWhat: null,
      stillUnsure: null,
      author: null,
      createdAt: '2026-09-25T10:05:00+08:00',
    },
  ],
  doubts: [
    {
      doubtId: 'dbt_1',
      text: '一个还没解决的问题',
      status: 'open',
      sourceEvidenceId: 'evd_1',
      createdAt: '2026-09-25T10:05:00+08:00',
    },
  ],
  promptVersion: 'mvp-prompt-v1',
  forceRefresh: false,
}

const validChatRequest: AdvisorChatRequest = {
  requestId: 'chat_service_test_1',
  projectId: 'prj_1',
  projectRevision: 3,
  projectName: '测试项目',
  currentMilestone: '选题确认与文献调研',
  tasks: validRequest.tasks,
  evidence: validRequest.evidence,
  doubts: validRequest.doubts,
  chatHistory: [{ role: 'user', text: '之前的问题' }],
  question: '下一步应该做什么？',
  promptVersion: 'advisor-chat-v1',
}

/** 线格式的请求体：validRequest 是校验之后的结构，所以这里补上顶层才有的 contractVersion */
function rawRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { contractVersion: '1.0', ...validRequest, ...overrides }
}

/* --------------------------------------------------------------- 请求校验 */

describe('请求校验', () => {
  test('合法请求通过，未知字段被忽略', () => {
    const result = parseAdvisorRequest(rawRequest({ planDraft: { anything: 1 } }))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.projectId, 'prj_1')
      assert.equal(result.value.tasks.length, 2)
    }
  })

  test('缺少 forceRefresh 时失败，不补默认值', () => {
    const body = rawRequest()
    delete body.forceRefresh
    const result = parseAdvisorRequest(body)

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.issues.some((issue) => issue.includes('forceRefresh')))
    }
  })

  test('currentMilestone 允许为 null', () => {
    const result = parseAdvisorRequest(rawRequest({ currentMilestone: null }))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.currentMilestone, null)
  })

  test('任务状态不在枚举内时失败', () => {
    const tasks = [{ ...validRequest.tasks[0], status: 'started' }]
    const result = parseAdvisorRequest(rawRequest({ tasks }))
    assert.equal(result.ok, false)
  })

  test('时间不是 ISO 格式时失败', () => {
    const tasks = [{ ...validRequest.tasks[0], updatedAt: '2026/09/25 10:12' }]
    const result = parseAdvisorRequest(rawRequest({ tasks }))
    assert.equal(result.ok, false)
  })

  test('confirmedContext 超过条数上限时失败', () => {
    const result = parseAdvisorRequest(
      rawRequest({ confirmedContext: Array.from({ length: 11 }, () => '一条已确认事实') }),
    )
    assert.equal(result.ok, false)
  })
})

/* --------------------------------------------------------------- 输出校验 */

describe('输出校验', () => {
  test('超长文本被截断而不是丢弃建议', () => {
    const result = normalizeSuggestions(
      {
        suggestions: [
          {
            title: 'x'.repeat(LIMITS.suggestionTitleLength + 20),
            whyNow: '理由',
            doneCriteria: '标志',
            existingTaskId: null,
            basisEvidenceIds: [],
            basisDoubtIds: [],
          },
        ],
      },
      validRequest,
    )

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.suggestions.length, 1)
      assert.equal(result.suggestions[0].title.length, LIMITS.suggestionTitleLength)
    }
  })

  test('空 title 的那条被丢弃，其余保留', () => {
    const result = normalizeSuggestions(
      {
        suggestions: [
          { title: '   ', whyNow: '理由', doneCriteria: '标志', basisEvidenceIds: [], basisDoubtIds: [] },
          { title: '保留', whyNow: '理由', doneCriteria: '标志', basisEvidenceIds: [], basisDoubtIds: [] },
        ],
      },
      validRequest,
    )

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.suggestions.length, 1)
      assert.equal(result.suggestions[0].title, '保留')
    }
  })

  test('全部被丢弃时判整份非法', () => {
    const result = normalizeSuggestions(
      { suggestions: [{ title: '', whyNow: '', doneCriteria: '' }] },
      validRequest,
    )
    assert.equal(result.ok, false)
  })

  test('未知引用被剔除，依据数组仍存在', () => {
    const result = normalizeSuggestions(
      {
        suggestions: [
          {
            title: '标题',
            whyNow: '理由',
            doneCriteria: '标志',
            existingTaskId: null,
            basisEvidenceIds: ['evd_1', 'evd_missing'],
            basisDoubtIds: ['dbt_missing'],
          },
        ],
      },
      validRequest,
    )

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.suggestions[0].basisEvidenceIds, ['evd_1'])
      assert.deepEqual(result.suggestions[0].basisDoubtIds, [])
    }
  })

  test('指向已完成任务的建议被丢弃', () => {
    const result = normalizeSuggestions(
      {
        suggestions: [
          {
            title: '已完成任务',
            whyNow: '理由',
            doneCriteria: '标志',
            existingTaskId: 'tsk_done',
            basisEvidenceIds: [],
            basisDoubtIds: [],
          },
        ],
      },
      validRequest,
    )
    assert.equal(result.ok, false)
  })

  test('suggestions 不是数组时判非法', () => {
    assert.equal(normalizeSuggestions({ suggestions: 'nope' }, validRequest).ok, false)
    assert.equal(normalizeSuggestions(null, validRequest).ok, false)
  })
})

/* ----------------------------------------------------------------- 兜底 */

describe('规则兜底', () => {
  test('至少能根据进行中的任务产出一条建议', () => {
    const suggestions = buildRuleSuggestions(validRequest)
    assert.ok(suggestions.length >= 1)
    assert.equal(suggestions[0].existingTaskId, 'tsk_doing')
  })

  test('空项目也能产出一条合法建议', () => {
    const empty: AdvisorRequest = {
      ...validRequest,
      tasks: [],
      evidence: [],
      doubts: [],
      currentMilestone: null,
      confirmedContext: [],
    }
    const suggestions = buildRuleSuggestions(empty)
    assert.equal(suggestions.length, 1)
    assert.ok(suggestions[0].whyNow.length > 0)
  })

  test('mock provider 的建议稳定且引用都来自请求', () => {
    const first = buildMockSuggestions(validRequest)
    const second = buildMockSuggestions(validRequest)
    assert.deepEqual(first, second)
    assert.ok(first.length >= 1 && first.length <= 3)

    const taskIds = new Set(validRequest.tasks.map((task) => task.taskId))
    for (const suggestion of first) {
      if (suggestion.existingTaskId !== null) {
        assert.ok(taskIds.has(suggestion.existingTaskId))
        assert.notEqual(suggestion.existingTaskId, 'tsk_done')
      }
    }
  })
})

/* --------------------------------------------------------------- 服务层 */

describe('服务层', () => {
  function serviceWith(provider: AdvisorProvider, fallback = createRuleFallback()) {
    return createAdvisorService({ provider, fallback, logger: silentLogger })
  }

  test('模型成功时返回 source=model 且不带兜底原因', async () => {
    const service = serviceWith(createMockProvider())
    const result = await service.recommend(validRequest)

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'model')
      assert.equal(result.fallbackReason, null)
      assert.equal(result.cached, false)
      assert.ok(result.suggestions.length >= 1)
    }
  })

  test('provider 抛普通错误时归为 MODEL_UNAVAILABLE 并兜底', async () => {
    const service = serviceWith(createMockProvider({ mode: 'throw' }))
    const result = await service.recommend(validRequest)

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'fallback')
      assert.equal(result.fallbackReason, 'MODEL_UNAVAILABLE')
    }
  })

  test('provider 声明未配置密钥时归为 MODEL_NOT_CONFIGURED 并兜底', async () => {
    const provider: AdvisorProvider = {
      name: 'declared',
      async generate() {
        throw new AdvisorProviderError('没有读取到密钥', 'MODEL_NOT_CONFIGURED')
      },
    }
    const result = await serviceWith(provider).recommend(validRequest)

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.fallbackReason, 'MODEL_NOT_CONFIGURED')
  })

  test('provider 输出不是数组时进入 INVALID_MODEL_OUTPUT 兜底', async () => {
    const provider: AdvisorProvider = {
      name: 'garbage',
      async generate() {
        return { suggestions: 'not-an-array' }
      },
    }
    const result = await serviceWith(provider).recommend(validRequest)

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'fallback')
      assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT')
    }
  })

  test('建议模型文本包含内部字段名时进入中文兜底且不回显原文', async () => {
    const leaked = '请先检查 currentMilestone 和 doneCriteria，再继续。'
    const provider: AdvisorProvider = {
      name: 'leaky-suggestions',
      async generate() {
        return { suggestions: [{ title: leaked, whyNow: '当前需要推进', doneCriteria: '提交一条证据' }] }
      },
    }
    const result = await serviceWith(provider).recommend(validRequest)

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'fallback')
      assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT')
      const visibleText = result.suggestions.flatMap((suggestion) => [suggestion.title, suggestion.whyNow, suggestion.doneCriteria]).join('\n')
      assert.doesNotMatch(visibleText, /currentMilestone|doneCriteria/)
    }
  })

  test('纯英文建议文本视为非法并进入中文规则兜底', async () => {
    const provider: AdvisorProvider = {
      name: 'english-suggestions',
      async generate() {
        return {
          suggestions: [{ title: 'Define the next milestone', whyNow: 'The project needs a clear next step', doneCriteria: 'Submit evidence' }],
        }
      },
    }
    const result = await serviceWith(provider).recommend(validRequest)

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'fallback')
      assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT')
      assert.doesNotMatch(JSON.stringify(result), /Define the next milestone|Submit evidence/)
    }
  })

  test('聊天模型文本包含内部字段名时返回中文兜底且不回显原文', async () => {
    const leaked = '请根据 evidence 和 doubts 更新 doneCriteria。'
    const provider: AdvisorProvider = {
      name: 'leaky-chat',
      async generate() {
        return { suggestions: buildMockSuggestions(validRequest) }
      },
      async generateChat() {
        return { answer: leaked }
      },
    }
    const result = await serviceWith(provider).chat(validChatRequest)

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'fallback')
      assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT')
      assert.match(result.answer, /目前无法可靠生成回答/)
      assert.doesNotMatch(result.answer, /evidence|doubts|doneCriteria/)
    }
  })

  test('正常中文聊天模型回答仍返回 source=model', async () => {
    const provider: AdvisorProvider = {
      name: 'chinese-chat',
      async generate() {
        return { suggestions: buildMockSuggestions(validRequest) }
      },
      async generateChat() {
        return { answer: '请先明确当前里程碑，再用一条新证据验证下一步。' }
      },
    }
    const result = await serviceWith(provider).chat(validChatRequest)

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'model')
      assert.equal(result.fallbackReason, null)
      assert.equal(result.answer, '请先明确当前里程碑，再用一条新证据验证下一步。')
    }
  })

  test('纯英文聊天回答视为非法并进入中文兜底', async () => {
    const provider: AdvisorProvider = {
      name: 'english-chat',
      async generate() {
        return { suggestions: buildMockSuggestions(validRequest) }
      },
      async generateChat() {
        return { answer: 'Please check the next step and continue.' }
      },
    }
    const result = await serviceWith(provider).chat(validChatRequest)

    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.source, 'fallback')
      assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT')
      assert.match(result.answer, /目前无法可靠生成回答/)
    }
  })

  test('兜底也产出非法结果时返回最终失败码，且不可重试的原因保持 false', async () => {
    const result = await serviceWith(createMockProvider({ mode: 'not-configured' }), () => ({
      suggestions: [],
    })).recommend(validRequest)

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'MODEL_NOT_CONFIGURED')
      assert.equal(result.retryable, false)
      assert.equal(result.retryAfterSeconds, null)
    }
  })

  test('兜底抛错时同样返回最终失败码', async () => {
    const result = await serviceWith(createMockProvider({ mode: 'throw' }), () => {
      throw new Error('兜底故意失败')
    }).recommend(validRequest)

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'MODEL_UNAVAILABLE')
      assert.equal(result.retryable, true)
    }
  })

  test('provider 超时归为 MODEL_TIMEOUT', async () => {
    const service = createAdvisorService({
      provider: createMockProvider({ mode: 'slow', delayMs: 150 }),
      fallback: createRuleFallback(),
      logger: silentLogger,
      timeoutMs: 20,
    })
    const result = await service.recommend(validRequest)

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.fallbackReason, 'MODEL_TIMEOUT')
  })
})
