import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiCompatibleProvider } from '../src/advisor/openaiCompatibleProvider.js'
import {
  AdvisorProviderError,
  type AdvisorLogger,
  type AdvisorRequest,
  type FetchLike,
  type ModelEndpoint,
  type UnderstandingProviderInput,
} from '../src/advisor/types.js'

/**
 * 模型 JSON 输出的容错提取测试
 * ----------------------------------------------------------------------------
 * 覆盖四种真实形态：纯 JSON、```json 围栏、前置说明文字、尾部说明文字；
 * 再覆盖纯非法内容仍按 INVALID_MODEL_OUTPUT 处理，以及 warn 日志只带片段与长度。
 * 全部通过注入 fetch，不发真实网络请求。
 */

const endpoint: ModelEndpoint = {
  url: 'https://model.example.com/v1/chat/completions',
  apiKey: 'sk-test-fake-key-for-assertions-only',
  model: 'demo-model',
  timeoutMs: 1_000,
}

const request: AdvisorRequest = {
  requestId: '9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043',
  projectId: 'prj_demo',
  projectRevision: 3,
  projectName: '极端风浪事件智能分析系统',
  currentMilestone: '选题确认与文献调研',
  confirmedContext: ['目标：构建识别与预警的原型系统'],
  tasks: [],
  evidence: [],
  doubts: [],
  promptVersion: 'mvp-prompt-v1',
  forceRefresh: false,
}

const understandingInput: UnderstandingProviderInput = {
  materialName: '实验手册.md',
  materialType: 'md',
  materialVersion: 1,
  projectName: null,
  segments: [
    { segmentId: 'seg_0', startLine: 10, endLine: 12, text: '重点是有效波高、风速、时间、经纬度。' },
  ],
}

const validSuggestion = {
  title: '先把进行中的任务收尾',
  whyNow: '它是当前唯一进行中的任务，收尾之后后续判断才有稳定前提。',
  doneCriteria: '补齐一页调研笔记并提交一条证据',
  existingTaskId: null,
  basisEvidenceIds: [],
  basisDoubtIds: [],
}

function contentResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function recordingLogger(): { entries: string[]; logger: AdvisorLogger } {
  const entries: string[] = []
  return {
    entries,
    logger: {
      warn(message, detail) {
        entries.push(`${message} ${JSON.stringify(detail ?? {})}`)
      },
    },
  }
}

function providerFor(content: string, logger: AdvisorLogger) {
  const fetchImpl: FetchLike = async () => contentResponse(content)
  return createOpenAiCompatibleProvider({ endpoint, fetchImpl, logger })
}

function suggestionJson(): string {
  return JSON.stringify({ suggestions: [validSuggestion] })
}

function draftJson(): string {
  return JSON.stringify({
    draft: {
      goalCandidates: [{ text: '材料写到的项目目标', segmentIds: ['seg_0'] }],
    },
  })
}

test('pure JSON can be parsed', async () => {
  const provider = providerFor(suggestionJson(), { warn() {} })
  const output = await provider.generate(request)
  assert.deepEqual(output.suggestions, [validSuggestion])
})

test('json fenced JSON can be parsed', async () => {
  const provider = providerFor(`\`\`\`json\n${suggestionJson()}\n\`\`\``, { warn() {} })
  const output = await provider.generate(request)
  assert.deepEqual(output.suggestions, [validSuggestion])
})

test('prose before JSON can be parsed', async () => {
  const provider = providerFor(`好的，结果如下：\n${suggestionJson()}\n请查收。`, { warn() {} })
  const output = await provider.generate(request)
  assert.deepEqual(output.suggestions, [validSuggestion])
})

test('prose after JSON can be parsed', async () => {
  const provider = providerFor(`${suggestionJson()}\n如果需要，我可以再解释每一步。`, { warn() {} })
  const output = await provider.generate(request)
  assert.deepEqual(output.suggestions, [validSuggestion])
})

test('invalid content still returns INVALID_MODEL_OUTPUT', async () => {
  const provider = providerFor('这不是 JSON，也没有可截取的 JSON 主体。', { warn() {} })
  await assert.rejects(provider.generate(request), (error: unknown) => {
    assert.ok(error instanceof AdvisorProviderError)
    assert.equal(error.reason, 'INVALID_MODEL_OUTPUT')
    return true
  })
})

test('parse failure warns with preview and length', async () => {
  const content = `模型说明：${'x'.repeat(200)}`
  const { entries, logger } = recordingLogger()
  const provider = providerFor(content, logger)

  await assert.rejects(provider.generate(request), (error: unknown) => {
    assert.ok(error instanceof AdvisorProviderError)
    return true
  })

  const logged = entries.join('\n')
  assert.match(logged, /模型返回的 content 不是合法 JSON/)
  assert.match(logged, new RegExp(`"contentLength":${content.length}`))
  assert.match(logged, /"contentPreview":"模型说明：x{100}/)
  assert.doesNotMatch(logged, /x{121}/)
})

test('materials understanding uses the same JSON extractor', async () => {
  const provider = providerFor(`理解结果：\n${draftJson()}`, { warn() {} })
  const output = await provider.generateUnderstanding?.(understandingInput)
  assert.ok(output !== undefined)
  assert.deepEqual(output.draft, {
    draft: {
      goalCandidates: [{ text: '材料写到的项目目标', segmentIds: ['seg_0'] }],
    },
  })
})
