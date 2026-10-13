import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiCompatibleProvider } from '../src/advisor/openaiCompatibleProvider.js'
import { createAdvisorService } from '../src/advisor/service.js'
import { createRuleFallback } from '../src/advisor/fallback.js'
import {
  AdvisorProviderError,
  silentLogger,
  type AdvisorProvider,
  type AdvisorChatRequest,
  type AdvisorRequest,
  type FetchLike,
  type ModelEndpoint,
} from '../src/advisor/types.js'

/**
 * 真实 provider（OpenAI 兼容）的单元测试
 * ----------------------------------------------------------------------------
 * 全部通过依赖注入替换 fetch：**本文件不发任何真实网络请求**。
 * 这里用的 apiKey 是明显的假值，只用于断言"不会被记录/回传"，不是真实凭证。
 */

const TEST_API_KEY = 'sk-test-fake-key-for-assertions-only'

const baseEndpoint: ModelEndpoint = {
  url: 'https://model.example.com/v1/chat/completions',
  apiKey: TEST_API_KEY,
  model: 'demo-model',
  timeoutMs: 1_000,
}

function endpointWith(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return { ...baseEndpoint, ...overrides }
}

const request: AdvisorRequest = {
  requestId: '9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043',
  projectId: 'prj_demo',
  projectRevision: 3,
  projectName: '极端风浪事件智能分析',
  currentMilestone: '选题确认与文献调研',
  confirmedContext: ['目标：构建识别与预警的原型系统'],
  tasks: [
    {
      taskId: 'tsk_1',
      title: '调研极端风浪事件的定义与识别方法',
      status: 'doing',
      doneCriteria: '一页调研笔记',
      owner: null,
      milestone: '选题确认与文献调研',
      updatedAt: '2026-09-25T10:12:00+08:00',
    },
  ],
  evidence: [
    {
      evidenceId: 'evd_1',
      submissionId: 'sub_1',
      taskId: 'tsk_1',
      didWhat: '查了 6 篇关于阈值方法的文献',
      foundWhat: '多数研究用第 95 百分位',
      stillUnsure: null,
      author: '张三',
      createdAt: '2026-09-25T10:05:00+08:00',
    },
  ],
  doubts: [
    {
      doubtId: 'dbt_1',
      text: 'ERA5 分辨率缺口怎么处理',
      status: 'open',
      sourceEvidenceId: 'evd_1',
      createdAt: '2026-09-25T10:05:00+08:00',
    },
  ],
  promptVersion: 'mvp-prompt-v1',
  forceRefresh: false,
}

const validSuggestion = {
  title: '先把进行中的任务收尾',
  whyNow: '它是当前唯一进行中的任务，收尾之后后续判断才有稳定前提。',
  doneCriteria: '补齐一页调研笔记并提交一条证据',
  existingTaskId: 'tsk_1',
  basisEvidenceIds: ['evd_1'],
  basisDoubtIds: [],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 模型正常返回：content 里装着建议 JSON */
function modelPayload(suggestions: unknown): unknown {
  return { choices: [{ message: { role: 'assistant', content: JSON.stringify({ suggestions }) } }] }
}

function contentPayload(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] }
}

interface RecordedCall {
  url: string
  init: RequestInit
}

function recordingFetch(responder: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const call: RecordedCall = { url, init }
    calls.push(call)
    return responder(call)
  }
  return { calls, fetchImpl }
}

function recordingLogger() {
  const entries: string[] = []
  return {
    entries,
    logger: {
      warn(message: string, detail?: Record<string, unknown>) {
        entries.push(`${message} ${JSON.stringify(detail ?? {})}`)
      },
    },
  }
}

async function expectProviderError(
  run: () => Promise<unknown>,
  reason: string,
): Promise<AdvisorProviderError> {
  let captured: AdvisorProviderError | null = null
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AdvisorProviderError, `期望 AdvisorProviderError，实际是 ${String(error)}`)
    captured = error
    return true
  })
  const error = captured as AdvisorProviderError | null
  if (error === null) throw new Error('没有捕获到错误')
  assert.equal(error.reason, reason)
  return error
}

/* ------------------------------------------------------ 1. 请求形态 */

test('按完整 URL 发请求，带上 Authorization 与规定请求体', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(modelPayload([validSuggestion])))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  const output = await provider.generate(request)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, baseEndpoint.url)
  assert.equal(calls[0].init.method, 'POST')

  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers.authorization, `Bearer ${TEST_API_KEY}`)

  const body = JSON.parse(String(calls[0].init.body)) as {
    model: string
    temperature: number
    messages: Array<{ role: string; content: string }>
  }
  assert.equal(body.model, 'demo-model')
  assert.equal(body.temperature, 0.2)
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'system')
  assert.match(body.messages[0].content, /JSON/)
  assert.equal(body.messages[1].role, 'user')

  // 项目数据被序列化进 user 消息
  assert.match(body.messages[1].content, /tsk_1/)
  assert.match(body.messages[1].content, /dbt_1/)

  assert.deepEqual(output.suggestions, [validSuggestion])
})

test('聊天 provider 发送项目状态、历史和问题，并返回纯文本答案', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(contentPayload('请先核对已有证据，再决定下一步。')))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })
  const chatRequest: AdvisorChatRequest = {
    requestId: 'chat_1', projectId: 'prj_1', projectRevision: 2, projectName: '测试项目', currentMilestone: 'MVP',
    tasks: [], evidence: [], doubts: [], chatHistory: [{ role: 'user', text: '之前的问题' }], question: '下一步是什么？', promptVersion: 'advisor-chat-v1',
  }
  const output = await provider.generateChat?.(chatRequest)
  assert.equal(output?.answer, '请先核对已有证据，再决定下一步。')
  const sent = JSON.parse(String(calls[0].init.body)) as { messages: Array<{ content: string }> }
  const combined = sent.messages.map((message) => message.content).join('\n')
  assert.match(combined, /prj_1/)
  assert.match(combined, /之前的问题/)
  assert.match(combined, /下一步是什么/)
})

test('URL 原样使用，不自行拼接 /v1/chat/completions 之类的路径', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(modelPayload([validSuggestion])))
  const provider = createOpenAiCompatibleProvider({
    endpoint: endpointWith({ url: 'https://gateway.internal/model' }),
    fetchImpl,
  })

  await provider.generate(request)

  assert.equal(calls[0].url, 'https://gateway.internal/model')
})

test('脱敏：不把 submissionId 与 author 发给模型', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(modelPayload([validSuggestion])))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  await provider.generate(request)

  const parsedBody = JSON.parse(String(calls[0].init.body)) as {
    messages: Array<{ role: string; content: string }>
  }
  const userContent = parsedBody.messages[1].content
  assert.doesNotMatch(userContent, /sub_1/)
  assert.doesNotMatch(userContent, /张三/)
})

/* ------------------------------------------------------ 2. 正常解析 */

test('解析 choices[0].message.content 里的 JSON', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(modelPayload([validSuggestion])))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  const output = await provider.generate(request)
  assert.deepEqual(output.suggestions, [validSuggestion])
})

test('content 是裸数组时也接受（元素合法性仍交给输出校验层）', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(contentPayload(JSON.stringify([validSuggestion]))))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  const output = await provider.generate(request)
  assert.deepEqual(output.suggestions, [validSuggestion])
})

test('content 被 ```json 围栏包住时剥掉围栏再解析', async () => {
  const fenced = '```json\n' + JSON.stringify({ suggestions: [validSuggestion] }) + '\n```'
  const { fetchImpl } = recordingFetch(() => jsonResponse(contentPayload(fenced)))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  const output = await provider.generate(request)
  assert.deepEqual(output.suggestions, [validSuggestion])
})

test('provider 不做字段校验：缺 suggestions 的对象原样交给输出校验层', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(contentPayload(JSON.stringify({ foo: 'bar' }))))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  const output = await provider.generate(request)
  assert.equal(output.suggestions, undefined)
})

/* ------------------------------------------------------ 3. 非法内容 */

test('content 不是合法 JSON → INVALID_MODEL_OUTPUT', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(contentPayload('这不是 JSON')))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  await expectProviderError(() => provider.generate(request), 'INVALID_MODEL_OUTPUT')
})

test('content 是 JSON 但不是对象/数组 → 交给输出校验层判非法', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(contentPayload('"just a string"')))
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  const output = await provider.generate(request)
  assert.equal(output.suggestions, undefined)
})

/* ------------------------------------------------ 4. 结构不完整 */

test('响应缺少 choices[0].message.content → INVALID_MODEL_OUTPUT', async () => {
  const cases: unknown[] = [
    {},
    { choices: [] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: 42 } }] },
  ]

  for (const payload of cases) {
    const { fetchImpl } = recordingFetch(() => jsonResponse(payload))
    const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })
    await expectProviderError(() => provider.generate(request), 'INVALID_MODEL_OUTPUT')
  }
})

test('上游返回的不是 JSON → INVALID_MODEL_OUTPUT', async () => {
  const { fetchImpl } = recordingFetch(
    () => new Response('<html>gateway error</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  )
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  await expectProviderError(() => provider.generate(request), 'INVALID_MODEL_OUTPUT')
})

/* ------------------------------------------------------ 5. 非 2xx */

test('非 2xx → MODEL_UNAVAILABLE', async () => {
  for (const status of [400, 429, 500, 503]) {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ error: 'upstream says no' }, status))
    const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })
    await expectProviderError(() => provider.generate(request), 'MODEL_UNAVAILABLE')
  }
})

test('网络错误 → MODEL_UNAVAILABLE', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new TypeError('fetch failed')
  }
  const provider = createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl })

  await expectProviderError(() => provider.generate(request), 'MODEL_UNAVAILABLE')
})

/* -------------------------------------------------------- 6. 超时 */

test('超时 → MODEL_TIMEOUT（AbortController 中断请求）', async () => {
  let aborted = false
  const hangingFetch: FetchLike = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      })
    })

  const provider = createOpenAiCompatibleProvider({
    endpoint: endpointWith({ timeoutMs: 20 }),
    fetchImpl: hangingFetch,
  })

  const error = await expectProviderError(() => provider.generate(request), 'MODEL_TIMEOUT')
  assert.equal(aborted, true)
  assert.match(error.message, /20/)
})

/* ---------------------------------------------------- 7. 缺少配置 */

test('缺少 URL / Key / 模型名 → MODEL_NOT_CONFIGURED，且不发起任何请求', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse(modelPayload([validSuggestion])))
  const provider = createOpenAiCompatibleProvider({
    endpoint: null,
    missingEnvNames: ['MODEL_API_URL', 'MODEL_API_KEY', 'MODEL_NAME'],
    fetchImpl,
  })

  const error = await expectProviderError(() => provider.generate(request), 'MODEL_NOT_CONFIGURED')
  assert.equal(calls.length, 0)
  assert.match(error.message, /MODEL_API_KEY/)
})

/* ------------------------------------------------------ 8. 不泄露 */

test('日志与错误信息都不含 API Key，也不含上游响应原文', async () => {
  const UPSTREAM_MARKER = 'UPSTREAM-BODY-MARKER-DO-NOT-LEAK'
  const { entries, logger } = recordingLogger()
  const { fetchImpl } = recordingFetch(() => jsonResponse({ message: UPSTREAM_MARKER }, 500))

  const provider = createOpenAiCompatibleProvider({
    endpoint: endpointWith({ apiKey: TEST_API_KEY }),
    fetchImpl,
    logger,
  })

  const error = await expectProviderError(() => provider.generate(request), 'MODEL_UNAVAILABLE')
  const logged = entries.join('\n')

  assert.doesNotMatch(error.message, /sk-test-/)
  assert.doesNotMatch(logged, /sk-test-/)
  assert.doesNotMatch(logged, /Bearer/)
  assert.doesNotMatch(logged, new RegExp(UPSTREAM_MARKER))
  assert.doesNotMatch(logged, /at .+:\d+:\d+/) // 堆栈帧
  assert.ok(entries.length > 0, '应当留下一条服务端日志')
})

test('超时与结构异常的日志同样不含 API Key', async () => {
  const { entries, logger } = recordingLogger()
  const { fetchImpl } = recordingFetch(() => jsonResponse({}))
  const provider = createOpenAiCompatibleProvider({
    endpoint: endpointWith({ apiKey: TEST_API_KEY }),
    fetchImpl,
    logger,
  })

  await expectProviderError(() => provider.generate(request), 'INVALID_MODEL_OUTPUT')
  assert.doesNotMatch(entries.join('\n'), /sk-test-/)
})

/* ------------------------------------------- 9. 与 service 层串联 */

function serviceWith(provider: AdvisorProvider) {
  return createAdvisorService({ provider, fallback: createRuleFallback(), logger: silentLogger })
}

test('模型返回合法建议 → source=model', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(modelPayload([validSuggestion])))
  const service = serviceWith(createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl }))

  const result = await service.recommend(request)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'model')
    assert.equal(result.fallbackReason, null)
    assert.equal(result.suggestions.length, 1)
  }
})

test('模型内容非法 → 服务端兜底，fallbackReason=INVALID_MODEL_OUTPUT', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(contentPayload('nope')))
  const service = serviceWith(createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl }))

  const result = await service.recommend(request)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'fallback')
    assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT')
    assert.ok(result.suggestions.length >= 1)
  }
})

test('上游 5xx → 服务端兜底，fallbackReason=MODEL_UNAVAILABLE', async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({ error: 'boom' }, 502))
  const service = serviceWith(createOpenAiCompatibleProvider({ endpoint: endpointWith(), fetchImpl }))

  const result = await service.recommend(request)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'fallback')
    assert.equal(result.fallbackReason, 'MODEL_UNAVAILABLE')
  }
})

test('缺少模型配置 → 服务端兜底，fallbackReason=MODEL_NOT_CONFIGURED', async () => {
  const provider = createOpenAiCompatibleProvider({
    endpoint: null,
    missingEnvNames: ['MODEL_API_KEY'],
  })
  const result = await serviceWith(provider).recommend(request)

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'fallback')
    assert.equal(result.fallbackReason, 'MODEL_NOT_CONFIGURED')
  }
})

test('缺配置且兜底也失败 → 返回最终失败码 MODEL_NOT_CONFIGURED（不可重试）', async () => {
  const provider = createOpenAiCompatibleProvider({ endpoint: null, missingEnvNames: ['MODEL_API_KEY'] })
  const service = createAdvisorService({
    provider,
    fallback: () => ({ suggestions: [] }),
    logger: silentLogger,
  })

  const result = await service.recommend(request)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'MODEL_NOT_CONFIGURED')
    assert.equal(result.retryable, false)
  }
})
