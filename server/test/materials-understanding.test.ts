import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/index.js'
import { createAdvisorService } from '../src/advisor/service.js'
import { createRuleFallback } from '../src/advisor/fallback.js'
import { createMockProvider } from '../src/advisor/mockProvider.js'
import { MAX_NOTE_LENGTH, MAX_SUMMARY_NOTES, createMaterialsService } from '../src/materials/understanding.js'
import { silentLogger, type AdvisorLogger, type AdvisorProvider } from '../src/advisor/types.js'
import type { MaterialsUnderstandingInput } from '../src/materials/types.js'
import type { ServerConfig } from '../src/config.js'

/**
 * POST /api/materials/understanding 的集成测试（契约 15.2 / 15.3 / 16）
 * ----------------------------------------------------------------------------
 * 覆盖四条路径：模型成功、模型超时、输出非法、未配置密钥；
 * 模型调用全部用 mock / 注入 provider，不发真实网络请求，不占 8080。
 */

const PATH = '/api/materials/understanding'

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  serviceName: 'course-platform-api',
  contractVersion: '1.0',
}

const SUCCESS_KEYS = [
  'contractVersion',
  'draft',
  'fallbackReason',
  'materialId',
  'materialVersion',
  'notice',
  'projectId',
  'projectRevision',
  'promptVersion',
  'requestId',
  'source',
]

function understandingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    promptVersion: 'material-understanding-v1',
    requestId: '9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043',
    projectId: 'prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031',
    projectRevision: 13,
    projectName: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
    material: {
      materialId: 'mat_9b1e7c2f',
      name: '实验手册.md',
      type: 'md',
      version: 1,
      segments: [
        {
          segmentId: 'seg_0',
          startLine: 1,
          endLine: 4,
          text: '本实验使用 ERA5 海浪场数据，任务是复现识别流程。',
        },
        { segmentId: 'seg_1', startLine: 6, endLine: 9, text: '字段包括有效波高、风速、时间与经纬度。' },
      ],
    },
    ...overrides,
  }
}

interface RunningApp {
  baseUrl: string
  stop: () => Promise<void>
}

async function withProvider<T>(
  provider: AdvisorProvider,
  run: (app: RunningApp) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const materialsService = createMaterialsService({
    provider,
    timeoutMs: options.timeoutMs,
    logger: silentLogger,
  })
  const app = createApp(config, {
    logger: silentLogger,
    advisorService: createAdvisorService({ provider, fallback: createRuleFallback(), logger: silentLogger }),
    materialsService,
  })
  await new Promise<void>((resolve) => app.listen(0, config.host, resolve))
  const address = app.address() as AddressInfo

  try {
    return await run({
      baseUrl: `http://${config.host}:${address.port}`,
      stop: () =>
        new Promise<void>((resolve, reject) => {
          app.close((error) => (error ? reject(error) : resolve()))
        }),
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function post(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/* ------------------------------------------------------------- 模型成功 */

test('模型成功：source=model，来源回填材料名与行号', async () => {
  await withProvider(createMockProvider(), async (app) => {
    const response = await post(app.baseUrl, understandingBody())
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(body).sort(), SUCCESS_KEYS)
    assert.equal(body.source, 'model')
    assert.equal(body.fallbackReason, null)
    assert.equal(body.notice, null)
    assert.equal(body.promptVersion, 'material-understanding-v1')
    assert.equal(body.materialId, 'mat_9b1e7c2f')
    assert.equal(body.materialVersion, 1)

    const draft = body.draft as Record<string, Array<Record<string, unknown>>>
    assert.ok(draft.goalCandidates.length >= 1)

    const first = draft.goalCandidates[0]
    assert.match(String(first.itemId), /^cnd_[a-z]+_\d+$/)
    const source = (first.sources as Array<Record<string, unknown>>)[0]
    assert.equal(source.materialId, 'mat_9b1e7c2f')
    assert.equal(source.materialName, '实验手册.md')
    assert.equal(source.materialVersion, 1)
    assert.equal(source.segmentId, 'seg_0')
    assert.equal(source.startLine, 1)
    assert.equal(source.endLine, 4)

    // 第二个片段的引用同样按请求回填材料名、版本与行号（seg_1 是 6-9 行）
    const secondSource = (draft.dataNotes[0].sources as Array<Record<string, unknown>>)[0]
    assert.equal(secondSource.materialName, '实验手册.md')
    assert.equal(secondSource.materialVersion, 1)
    assert.equal(secondSource.segmentId, 'seg_1')
    assert.equal(secondSource.startLine, 6)
    assert.equal(secondSource.endLine, 9)

    for (const items of Object.values(draft)) {
      assert.ok(items.length <= 5)
    }
  })
})

/* ------------------------------------------------------------- 失败兜底 */

test('模型超时：返回 200 + fallback，空草稿与中文说明', async () => {
  await withProvider(
    createMockProvider({ mode: 'slow', delayMs: 200 }),
    async (app) => {
      const response = await post(app.baseUrl, understandingBody())
      const body = (await response.json()) as Record<string, unknown>

      assert.equal(response.status, 200)
      assert.equal(body.source, 'fallback')
      assert.equal(body.fallbackReason, 'MODEL_TIMEOUT')
      assert.match(String(body.notice), /超时/)

      const draft = body.draft as Record<string, unknown[]>
      assert.deepEqual(draft, {
        goalCandidates: [],
        outcomeCandidates: [],
        dataNotes: [],
        methodNotes: [],
        openQuestions: [],
      })
    },
    { timeoutMs: 20 },
  )
})

test('模型输出为空：判定非法输出并走兜底，不回显原始文本', async () => {
  await withProvider(createMockProvider({ mode: 'empty' }), async (app) => {
    const response = await post(app.baseUrl, understandingBody())
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200)
    assert.equal(body.source, 'fallback')
    assert.equal(body.fallbackReason, 'INVALID_MODEL_OUTPUT')
    assert.match(String(body.notice), /不合法|未生成理解草稿/)
  })
})

test('模型未配置：fallbackReason=MODEL_NOT_CONFIGURED', async () => {
  await withProvider(createMockProvider({ mode: 'not-configured' }), async (app) => {
    const response = await post(app.baseUrl, understandingBody())
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200)
    assert.equal(body.source, 'fallback')
    assert.equal(body.fallbackReason, 'MODEL_NOT_CONFIGURED')
    assert.match(String(body.notice), /模型密钥/)
  })
})

test('上游故障：fallbackReason=MODEL_UNAVAILABLE', async () => {
  await withProvider(createMockProvider({ mode: 'throw' }), async (app) => {
    const response = await post(app.baseUrl, understandingBody())
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(response.status, 200)
    assert.equal(body.fallbackReason, 'MODEL_UNAVAILABLE')
  })
})

/* --------------------------------------------------------- 输出清理规则 */

test('未知片段引用被剔除；没有来源的条目被丢弃，其余保留', async () => {
  const provider: AdvisorProvider = {
    name: 'partial-valid',
    async generate() {
      return { suggestions: [] }
    },
    async generateUnderstanding() {
      return {
        draft: {
          goalCandidates: [
            { text: '材料里描述了项目要做的事情', segmentIds: ['seg_0', 'seg_missing'] },
            { text: '没有来源的候选内容', segmentIds: ['seg_missing'] },
          ],
          outcomeCandidates: [],
          dataNotes: [],
          methodNotes: [],
          openQuestions: [],
        },
      }
    },
  }

  await withProvider(provider, async (app) => {
    const response = await post(app.baseUrl, understandingBody())
    const body = (await response.json()) as Record<string, unknown>
    const draft = body.draft as Record<string, Array<Record<string, unknown>>>

    assert.equal(response.status, 200)
    assert.equal(body.source, 'model')
    assert.equal(draft.goalCandidates.length, 1)
    const sources = draft.goalCandidates[0].sources as Array<Record<string, unknown>>
    assert.equal(sources.length, 1)
    assert.equal(sources[0].segmentId, 'seg_0')
    assert.doesNotMatch(JSON.stringify(body), /没有来源的候选内容|seg_missing/)
  })
})

test('输出包含内部字段名或非中文时进入兜底且不回显原文', async () => {
  const provider: AdvisorProvider = {
    name: 'leaky-understanding',
    async generate() {
      return { suggestions: [] }
    },
    async generateUnderstanding() {
      return {
        draft: {
          goalCandidates: [{ text: '请检查 segmentId 与 draft 字段', segmentIds: ['seg_0'] }],
          outcomeCandidates: [],
          dataNotes: [],
          methodNotes: [],
          openQuestions: [],
        },
      }
    },
  }

  await withProvider(provider, async (app) => {
    const response = await post(app.baseUrl, understandingBody())
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200)
    assert.equal(body.source, 'fallback')
    assert.equal(body.fallbackReason, 'INVALID_MODEL_OUTPUT')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    // 兜底文本与草稿都不回显模型原文（"draft" 是协议键名，不属于回显）
    assert.doesNotMatch(String(body.notice), /segmentId|请检查/)
    assert.doesNotMatch(JSON.stringify(body.draft), /segmentId|请检查/)
  })
})

test('纯英文候选文本视为非法进入兜底', async () => {
  const provider: AdvisorProvider = {
    name: 'english-understanding',
    async generate() {
      return { suggestions: [] }
    },
    async generateUnderstanding() {
      return {
        draft: {
          goalCandidates: [{ text: 'Define the project goal clearly', segmentIds: ['seg_0'] }],
          outcomeCandidates: [],
          dataNotes: [],
          methodNotes: [],
          openQuestions: [],
        },
      }
    },
  }

  await withProvider(provider, async (app) => {
    const response = await post(app.baseUrl, understandingBody())
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.source, 'fallback')
    assert.equal(body.fallbackReason, 'INVALID_MODEL_OUTPUT')
    assert.doesNotMatch(JSON.stringify(body), /Define the project goal/)
  })
})

/* ------------------------------------------------------------- 请求校验 */

test('片段超过 100 条时返回 400，不做静默截断', async () => {
  await withProvider(createMockProvider(), async (app) => {
    const segments = Array.from({ length: 101 }, (_, index) => ({
      segmentId: `seg_${index}`,
      startLine: index + 1,
      endLine: index + 1,
      text: `第 ${index} 段内容`,
    }))
    const body = understandingBody()
    const material = body.material as Record<string, unknown>

    const response = await post(app.baseUrl, { ...body, material: { ...material, segments } })
    const result = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 400)
    assert.equal(result.code, 'INVALID_INPUT')
    assert.match(String(result.message), /最多 100 条/)
    assert.equal(result.retryable, false)
    assert.equal(result.requestId, '9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043')
  })
})

test('重复 segmentId 返回 400 INVALID_INPUT', async () => {
  await withProvider(createMockProvider(), async (app) => {
    const body = understandingBody()
    const material = body.material as Record<string, unknown>
    const segments = [
      { segmentId: 'seg_0', startLine: 1, endLine: 4, text: '第一段内容' },
      { segmentId: 'seg_0', startLine: 6, endLine: 9, text: '重复编号的第二段内容' },
    ]

    const response = await post(app.baseUrl, { ...body, material: { ...material, segments } })
    const result = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 400)
    assert.equal(result.code, 'INVALID_INPUT')
    assert.match(String(result.message), /重复/)
    assert.equal(result.retryable, false)
  })
})

test('promptVersion 不受支持时返回 400', async () => {
  await withProvider(createMockProvider(), async (app) => {
    const response = await post(app.baseUrl, understandingBody({ promptVersion: 'mvp-prompt-v2' }))
    const body = (await response.json()) as Record<string, unknown>
    assert.equal(response.status, 400)
    assert.equal(body.code, 'INVALID_INPUT')
    assert.match(String(body.message), /material-understanding-v1/)
  })
})

test('非 POST 方法与非法 JSON 的响应结构正确', async () => {
  await withProvider(createMockProvider(), async (app) => {
    const get = await fetch(`${app.baseUrl}${PATH}`)
    assert.equal(get.status, 405)
    assert.equal(get.headers.get('allow'), 'POST')

    const bad = await post(app.baseUrl, '{"contractVersion":')
    const badBody = (await bad.json()) as Record<string, unknown>
    assert.equal(bad.status, 400)
    assert.equal(badBody.code, 'INVALID_INPUT')
    assert.equal(badBody.requestId, null)
  })
})

/* --------------------------------------------- 日志卫生（回归，契约 12.2） */

/** 捕获 warn 调用的 logger：用于断言敏感文本不落日志 */
function recordingLogger(): {
  logger: AdvisorLogger
  entries: Array<{ message: string; detail: Record<string, unknown> }>
} {
  const entries: Array<{ message: string; detail: Record<string, unknown> }> = []
  return {
    entries,
    logger: {
      warn(message, detail) {
        entries.push({ message, detail: detail ?? {} })
      },
    },
  }
}

function serviceLevelInput(): MaterialsUnderstandingInput {
  return {
    requestId: 'log_check_1',
    projectId: 'prj_1',
    projectRevision: 2,
    projectName: null,
    promptVersion: 'material-understanding-v1',
    material: {
      materialId: 'mat_log',
      name: '实验手册.md',
      type: 'md',
      version: 1,
      segments: [{ segmentId: 'seg_0', startLine: 1, endLine: 2, text: '一段材料内容' }],
    },
  }
}

/** 模型返回一个夹带敏感长文本的未知 segmentId，外加一个合法引用 */
function leakyProvider(): AdvisorProvider {
  const sensitive = `SK-${'A'.repeat(500)}-不应进入日志的材料正文`
  return {
    name: 'unknown-ref',
    async generate() {
      return { suggestions: [] }
    },
    async generateUnderstanding() {
      return {
        draft: {
          goalCandidates: [{ text: '材料中提到了这一步要完成的目标', segmentIds: [sensitive, 'seg_0'] }],
          outcomeCandidates: [],
          dataNotes: [],
          methodNotes: [],
          openQuestions: [],
        },
      }
    },
  }
}

test('未知引用不把原始 segmentId 写入日志（回归）', async () => {
  const { logger, entries } = recordingLogger()
  const service = createMaterialsService({ provider: leakyProvider(), logger, timeoutMs: 1000 })
  const result = await service.understand(serviceLevelInput())

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'model')
    assert.equal(result.draft.goalCandidates.length, 1)
    assert.equal(result.draft.goalCandidates[0].sources[0].segmentId, 'seg_0')
  }

  const joined = entries.map((entry) => `${entry.message} ${JSON.stringify(entry.detail)}`).join('\n')
  assert.match(joined, /unknownSegmentReferenceCount/)
  assert.match(joined, /droppedItemCount/)
  assert.doesNotMatch(joined, /SK-A{3,}/)
  assert.doesNotMatch(joined, /不应进入日志的材料正文/)
  assert.doesNotMatch(joined, /seg_0/) // 合法引用也不以原始编号形式落日志

  const notes = entries.flatMap((entry) =>
    Array.isArray(entry.detail.notes) ? (entry.detail.notes as string[]) : [],
  )
  assert.ok(notes.length <= MAX_SUMMARY_NOTES)
  assert.ok(notes.every((note) => note.length <= MAX_NOTE_LENGTH))
})

test('全部条目因未知引用被丢弃时走兜底，日志仍不含原始编号', async () => {
  const sensitive = `MAT-${'B'.repeat(400)}-敏感正文`
  const provider: AdvisorProvider = {
    name: 'all-unknown-ref',
    async generate() {
      return { suggestions: [] }
    },
    async generateUnderstanding() {
      return {
        draft: {
          goalCandidates: [{ text: '材料中写到的目标', segmentIds: [sensitive] }],
          outcomeCandidates: [],
          dataNotes: [],
          methodNotes: [],
          openQuestions: [],
        },
      }
    },
  }

  const { logger, entries } = recordingLogger()
  const service = createMaterialsService({ provider, logger, timeoutMs: 1000 })
  const result = await service.understand(serviceLevelInput())

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'fallback')
    assert.equal(result.fallbackReason, 'INVALID_MODEL_OUTPUT')
  }

  const joined = JSON.stringify(entries)
  assert.doesNotMatch(joined, /MAT-B{3,}/)
  assert.doesNotMatch(joined, /敏感正文/)

  const withUnknown = entries.find((entry) => entry.detail.unknownSegmentReferenceCount !== undefined)
  assert.equal(withUnknown?.detail.unknownSegmentReferenceCount, 1)
  assert.ok(Number(withUnknown?.detail.droppedItemCount) >= 1)
})
