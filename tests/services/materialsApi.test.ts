import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildUnderstandingRequest,
  buildMaterialUploadRequest,
  bytesToBase64,
  fetchMaterialUnderstanding,
  isStaleMaterialResponse,
  uploadMaterial,
} from '@/services/materialsApi'
import { buildAdvisorChatRequest, buildAdvisorRequest } from '@/services/advisorApi'
import type { MaterialsUnderstandingRequest, MaterialUploadRequest } from '@/domain/recommendation'
import { draftFixture } from '../fixtures/project'

/**
 * 材料接口适配层（契约 15 / 16）
 * ----------------------------------------------------------------------------
 * 只断言两件事：发出去的请求体符合契约；响应与失败被正确翻译成前端领域结果。
 * 所有请求都用 `fetchImpl` 注入假实现，不走网络。
 */

const PROJECT_ID = 'prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031'
const REQUEST_ID = '5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90'
const MATERIAL_ID = 'mat_9b1e7c2f'

const MATERIAL = {
  materialId: MATERIAL_ID,
  projectId: PROJECT_ID,
  name: '实验手册.md',
  type: 'md',
  size: 2048,
  encoding: 'utf-8',
  state: 'parsed',
  version: 1,
  createdAt: '2026-10-12T10:12:00+08:00',
  updatedAt: '2026-10-12T10:12:00+08:00',
  failureReason: null,
}

const SEGMENTS = [{ segmentId: 'seg_0', index: 0, startLine: 1, endLine: 8, text: '# 实验手册' }]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function uploadRequest(overrides: Partial<MaterialUploadRequest> = {}): MaterialUploadRequest {
  return {
    ...buildMaterialUploadRequest({
      projectId: PROJECT_ID,
      projectRevision: 12,
      materialId: MATERIAL_ID,
      version: 1,
      name: '实验手册.md',
      contentBase64: 'IyDlrp7pqozmiYvlhowK',
      requestId: REQUEST_ID,
    }),
    ...overrides,
  }
}

function understandingRequest(
  overrides: Partial<MaterialsUnderstandingRequest> = {},
): MaterialsUnderstandingRequest {
  return {
    ...buildUnderstandingRequest({
      projectId: PROJECT_ID,
      projectRevision: 13,
      projectName: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
      requestId: REQUEST_ID,
      material: {
        materialId: MATERIAL_ID,
        name: '实验手册.md',
        type: 'md',
        version: 1,
        segments: [{ segmentId: 'seg_0', startLine: 1, endLine: 8, text: '# 实验手册' }],
      },
    }),
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

/* -------------------------------------------------------------- base64 */

describe('bytesToBase64（契约 15.1）', () => {
  it('与标准 base64 编码结果一致，覆盖三种补位情况', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 7, 10]) {
      const bytes = new Uint8Array(Array.from({ length }, (_, index) => (index * 37 + 5) % 256))
      const expected = Buffer.from(bytes).toString('base64')
      expect(bytesToBase64(bytes)).toBe(expected)
    }
  })

  it('中文 UTF-8 字节按原始字节编码（GBK 文件不会先在浏览器里被破坏）', () => {
    const bytes = new TextEncoder().encode('实验手册')
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})

/* ---------------------------------------------------------- 请求组装 */

describe('请求体组装（契约 15.0 / 15.1 / 15.2）', () => {
  it('上传请求：字段齐全、contractVersion 固定 1.0，且不带任何密钥类字段', () => {
    const body = JSON.stringify(uploadRequest())
    expect(JSON.parse(body)).toMatchObject({
      contractVersion: '1.0',
      requestId: REQUEST_ID,
      projectId: PROJECT_ID,
      projectRevision: 12,
      materialId: MATERIAL_ID,
      version: 1,
      name: '实验手册.md',
      contentBase64: 'IyDlrp7pqozmiYvlhowK',
    })
    // 契约 7.4：前端不持有密钥，Network 标签里也不能出现
    expect(body.toLowerCase()).not.toContain('apikey')
    expect(body.toLowerCase()).not.toContain('authorization')
    expect(body.toLowerCase()).not.toContain('token')
  })

  it('理解请求：promptVersion 固定为 material-understanding-v1，且只发片段', () => {
    const request = understandingRequest()
    expect(request.promptVersion).toBe('material-understanding-v1')
    expect(request.material.segments[0]).toEqual({
      segmentId: 'seg_0',
      startLine: 1,
      endLine: 8,
      text: '# 实验手册',
    })
    // 上传接口不接受的三个字段不能出现在理解请求之外的地方
    expect(Object.keys(request).sort()).toEqual(
      [
        'contractVersion',
        'material',
        'projectId',
        'projectName',
        'projectRevision',
        'promptVersion',
        'requestId',
      ].sort(),
    )
  })
})

/* ------------------------------------------------------ POST /api/materials */

describe('fetchMaterialUpload（契约 15.1）', () => {
  it('成功：返回材料元数据与分段', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(_url)).toContain('/api/materials')
      expect(init?.method).toBe('POST')
      return jsonResponse({
        contractVersion: '1.0',
        requestId: REQUEST_ID,
        projectId: PROJECT_ID,
        projectRevision: 12,
        material: MATERIAL,
        segmentCount: 1,
        segments: SEGMENTS,
      })
    })

    const result = await uploadMaterial(uploadRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.material.materialId).toBe(MATERIAL_ID)
    expect(result.data.segmentCount).toBe(1)
    expect(result.data.segments).toHaveLength(1)
  })

  it('过期响应（projectRevision 对不上）整份丢弃，返回 STALE_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        contractVersion: '1.0',
        requestId: REQUEST_ID,
        projectId: PROJECT_ID,
        projectRevision: 99,
        material: MATERIAL,
        segmentCount: 1,
        segments: SEGMENTS,
      }),
    )

    const result = await uploadMaterial(uploadRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('STALE_RESPONSE')
  })

  it('requestId 对不上按串包丢弃', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        contractVersion: '1.0',
        requestId: 'another-request-id',
        projectId: PROJECT_ID,
        projectRevision: 12,
        material: MATERIAL,
        segmentCount: 1,
        segments: SEGMENTS,
      }),
    )

    const result = await uploadMaterial(uploadRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('STALE_RESPONSE')
  })

  it('契约错误码原样返回（材料过大不重试）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          contractVersion: '1.0',
          requestId: REQUEST_ID,
          code: 'MATERIAL_TOO_LARGE',
          message: '文件超过 1 MB 上限，请压缩或拆分后再上传',
          retryable: false,
          retryAfterSeconds: null,
        },
        400,
      ),
    )

    const result = await uploadMaterial(uploadRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('MATERIAL_TOO_LARGE')
      expect(result.error.retryable).toBe(false)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('响应缺少必需字段按 NETWORK_ERROR 处理，不静默使用残缺数据', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ contractVersion: '1.0', requestId: REQUEST_ID, projectId: PROJECT_ID, projectRevision: 12 }),
    )

    const result = await uploadMaterial(uploadRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_ERROR')
      expect(result.error.cause).toBe('invalid-response')
    }
  })

  it('segmentCount 与 segments 条数不一致时整份丢弃（契约 15.1）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        contractVersion: '1.0',
        requestId: REQUEST_ID,
        projectId: PROJECT_ID,
        projectRevision: 12,
        material: MATERIAL,
        segmentCount: 3,
        segments: SEGMENTS,
      }),
    )

    const result = await uploadMaterial(uploadRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_ERROR')
      expect(result.error.cause).toBe('invalid-response')
    }
  })

  it('网络失败按 NETWORK_ERROR 处理', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    const result = await uploadMaterial(uploadRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NETWORK_ERROR')
  })

  it('retryable 失败自动重试 1 次（契约 15.4）', async () => {
    vi.useFakeTimers()
    let attempt = 0
    const fetchImpl = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        return jsonResponse(
          {
            contractVersion: '1.0',
            requestId: REQUEST_ID,
            code: 'MODEL_UNAVAILABLE',
            message: '上游故障',
            retryable: true,
            retryAfterSeconds: null,
          },
          503,
        )
      }
      return jsonResponse({
        contractVersion: '1.0',
        requestId: REQUEST_ID,
        projectId: PROJECT_ID,
        projectRevision: 12,
        material: MATERIAL,
        segmentCount: 1,
        segments: SEGMENTS,
      })
    })

    const pending = uploadMaterial(uploadRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending

    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

/* ------------------------------------------ POST /api/materials/understanding */

describe('fetchMaterialUnderstanding（契约 15.2）', () => {
  function successBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      contractVersion: '1.0',
      requestId: REQUEST_ID,
      projectId: PROJECT_ID,
      projectRevision: 13,
      materialId: MATERIAL_ID,
      materialVersion: 1,
      promptVersion: 'material-understanding-v1',
      source: 'model',
      fallbackReason: null,
      notice: null,
      draft: draftFixture({ goalCandidates: draftFixture().goalCandidates }),
      ...overrides,
    }
  }

  it('model 响应：五块草稿齐全', async () => {
    const fetchImpl = vi.fn(async (_url: string) => {
      expect(String(_url)).toContain('/api/materials/understanding')
      return jsonResponse(successBody())
    })

    const result = await fetchMaterialUnderstanding(understandingRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.data.draft).sort()).toEqual(
      ['dataNotes', 'goalCandidates', 'methodNotes', 'openQuestions', 'outcomeCandidates'].sort(),
    )
    expect(result.data.draft.goalCandidates[0].sources[0].segmentId).toBe('seg_0')
  })

  it('fallback 响应：允许四块为空，notice 是中文说明', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        successBody({
          source: 'fallback',
          fallbackReason: 'MODEL_TIMEOUT',
          notice: '模型调用超时，未生成理解草稿；材料已解析成功，可以先手动登记要点，稍后重新生成。',
          draft: {
            goalCandidates: [],
            outcomeCandidates: [],
            dataNotes: [],
            methodNotes: [],
            openQuestions: [],
          },
        }),
      ),
    )

    const result = await fetchMaterialUnderstanding(understandingRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.source).toBe('fallback')
    expect(result.data.fallbackReason).toBe('MODEL_TIMEOUT')
    expect(result.data.notice).toContain('超时')
  })

  it('缺少某一块（契约 8.4 契约违规）按 NETWORK_ERROR 处理', async () => {
    const body = successBody()
    delete (body.draft as Record<string, unknown>).dataNotes
    const fetchImpl = vi.fn(async () => jsonResponse(body))

    const result = await fetchMaterialUnderstanding(understandingRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NETWORK_ERROR')
  })

  it('过期响应整份丢弃', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody({ projectRevision: 14 })))

    const result = await fetchMaterialUnderstanding(understandingRequest(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('STALE_RESPONSE')
  })

  it('响应指向别的材料（请求期间被换版）时整份丢弃（契约 4.7 / 14.5.3-4）', async () => {
    for (const override of [{ materialId: 'mat_other' }, { materialVersion: 2 }]) {
      const fetchImpl = vi.fn(async () => jsonResponse(successBody(override)))

      const result = await fetchMaterialUnderstanding(understandingRequest(), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('STALE_RESPONSE')
        // 过期响应属于静默丢弃，store 不会给用户弹错误提示
        expect(isStaleMaterialResponse(result.error)).toBe(true)
      }
    }
  })
})

/* ------------------------------------------------------- 建议接口 v2 字段 */

describe('buildAdvisorRequest（契约 13.2 / 17.1 / 17.4）', () => {
  const base = {
    projectId: PROJECT_ID,
    projectRevision: 14,
    projectName: '项目名',
    currentMilestone: null,
    tasks: [],
    evidence: [],
    doubts: [],
    requestId: REQUEST_ID,
  }

  it('不带 v2 内容时不出现新字段，promptVersion 取当前版本（mvp-prompt-v2）', () => {
    const request = buildAdvisorRequest({ ...base, projectProfile: null, confirmedMaterials: [] })
    expect(request.promptVersion).toBe('mvp-prompt-v2')
    expect('projectProfile' in request).toBe(false)
    expect('confirmedMaterials' in request).toBe(false)
    expect(request.confirmedContext).toEqual([])
  })

  it('显式传入的 promptVersion 原样保留（不静默改写，交给服务端校验）', () => {
    const request = buildAdvisorRequest({
      ...base,
      promptVersion: 'mvp-prompt-v1',
      projectProfile: { goal: '目标', expectedOutcome: null, memberNames: [], researchPeriod: null, scope: null, outOfScope: null },
    })
    expect(request.promptVersion).toBe('mvp-prompt-v1')
  })

  it('带 projectProfile / confirmedMaterials 时字段按契约序列化', () => {
    const profile = {
      goal: '目标',
      expectedOutcome: null,
      memberNames: [],
      researchPeriod: null,
      scope: null,
      outOfScope: null,
    }

    const withProfile = buildAdvisorRequest({ ...base, projectProfile: profile })
    expect(withProfile.projectProfile).toEqual(profile)

    const withMaterials = buildAdvisorRequest({
      ...base,
      confirmedMaterials: [
        {
          materialId: MATERIAL_ID,
          name: '实验手册.md',
          type: 'md',
          version: 1,
          segments: [{ segmentId: 'seg_0', startLine: 1, endLine: 8, text: '正文' }],
        },
      ],
    })
    expect(withMaterials.confirmedMaterials).toHaveLength(1)
  })
})

/* ------------------------------------------------------- 聊天请求 v2 字段 */

describe('buildAdvisorChatRequest（契约 6.4 / 17.4）', () => {
  const base = {
    projectId: PROJECT_ID,
    projectRevision: 14,
    projectName: '项目名',
    currentMilestone: null,
    tasks: [],
    evidence: [],
    doubts: [],
    question: '我下一步做什么？',
    requestId: REQUEST_ID,
  }

  it('promptVersion 固定 advisor-chat-v2；聊天不发 confirmedContext', () => {
    const request = buildAdvisorChatRequest(base)
    expect(request.promptVersion).toBe('advisor-chat-v2')
    expect('confirmedContext' in request).toBe(false)
    expect('projectProfile' in request).toBe(false)
    expect('confirmedMaterials' in request).toBe(false)
    expect(request.chatHistory).toEqual([])
  })

  it('聊天历史裁剪：丢掉空文本、只留最近 20 条、逐条截断到 2,000 字', () => {
    const history = [
      { role: 'user' as const, text: '   ' },
      ...Array.from({ length: 25 }, (_, index) => ({
        role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        text: `第 ${index} 条`,
      })),
      { role: 'assistant' as const, text: 'x'.repeat(2500) },
    ]

    const request = buildAdvisorChatRequest({ ...base, chatHistory: history })

    expect(request.chatHistory).toHaveLength(20)
    expect(request.chatHistory.at(-1)?.text).toHaveLength(2000)
    expect(request.chatHistory.some((message) => message.text.trim() === '')).toBe(false)
  })

  it('问题超长截断到 2,000 字', () => {
    const request = buildAdvisorChatRequest({ ...base, question: 'x'.repeat(2100) })
    expect(request.question).toHaveLength(2000)
  })

  it('超长项目名 / 里程碑只按契约上限截断，不让整个请求被 400 拒绝（契约 4.1 / 15.2）', () => {
    const longName = '长'.repeat(200)
    const advisor = buildAdvisorRequest({ ...base, projectName: longName })
    expect(advisor.projectName).toHaveLength(120)

    const chat = buildAdvisorChatRequest({
      ...base,
      projectName: longName,
      question: '问题',
      currentMilestone: '里'.repeat(90),
    })
    expect(chat.projectName).toHaveLength(120)
    expect(String(chat.currentMilestone)).toHaveLength(60)

    const understanding = buildUnderstandingRequest({
      projectId: PROJECT_ID,
      projectRevision: 1,
      projectName: longName,
      material: {
        materialId: MATERIAL_ID,
        name: '实验手册.md',
        type: 'md',
        version: 1,
        segments: [{ segmentId: 'seg_0', startLine: 1, endLine: 1, text: '正文' }],
      },
    })
    expect(understanding.projectName).toHaveLength(120)
  })
})
