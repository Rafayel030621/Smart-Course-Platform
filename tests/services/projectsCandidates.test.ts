import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateMilestoneCandidates } from '@/services/projectsApi'
import { resetIdempotencyCache } from '@/services/v3Http'
import { MILESTONE_CANDIDATE_PROMPT_VERSION } from '@/domain/recommendation'
import { installFetch, jsonResponse, requestBody } from '../support/v3Fixtures'

function candidateResponse(requestId: unknown): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId,
    projectId: 'prj_1',
    projectRevision: 2,
    promptVersion: MILESTONE_CANDIDATE_PROMPT_VERSION,
    source: 'model',
    fallbackReason: null,
    notice: null,
    candidates: [
      {
        candidateId: 'cand_1',
        name: '数据获取与预处理',
        goal: '拿到可复现的样例数据',
        doneCriteria: '样例数据可下载',
        suggestedTasks: [{ title: '下载样例数据', doneCriteria: '能读出关键变量' }],
        risks: [],
        sources: [
          {
            materialId: 'mat_1',
            materialName: '实验手册.md',
            materialVersion: 1,
            segmentId: 'seg_1',
            startLine: 1,
            endLine: 8,
            itemId: null,
          },
        ],
        expiresAt: '2026-10-24T10:00:00.000Z',
      },
    ],
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  resetIdempotencyCache()
})

describe('generateMilestoneCandidates（契约 23.7）', () => {
  it('请求体带 projectId，默认 maxCandidates=2，并解析顶层候选响应', async () => {
    const bodies: Array<Record<string, unknown>> = []
    installFetch((url, init) => {
      if (!url.endsWith('/api/projects/prj_1/milestones/candidates') || init.method !== 'POST') {
        return undefined
      }
      const body = requestBody(init)
      bodies.push(body)
      return jsonResponse(candidateResponse(body['requestId']))
    })

    const result = await generateMilestoneCandidates('prj_1', {
      projectRevision: 2,
      promptVersion: MILESTONE_CANDIDATE_PROMPT_VERSION,
      focus: '数据获取',
    })

    expect(result.ok).toBe(true)
    expect(bodies[0]?.['projectId']).toBe('prj_1')
    expect(bodies[0]?.['projectRevision']).toBe(2)
    expect(bodies[0]?.['promptVersion']).toBe(MILESTONE_CANDIDATE_PROMPT_VERSION)
    expect(bodies[0]?.['maxCandidates']).toBe(2)
    expect(bodies[0]?.['focus']).toBe('数据获取')
    if (result.ok) {
      expect(result.data.source).toBe('model')
      expect(result.data.candidates[0]?.candidateId).toBe('cand_1')
      expect(result.data.candidates[0]?.sources[0]?.materialName).toBe('实验手册.md')
    }
  })

  it('同一次点击重试复用 idempotencyKey 与 requestId，并映射 CANDIDATE_EXPIRED', async () => {
    const bodies: Array<Record<string, unknown>> = []
    installFetch((url, init) => {
      if (!url.endsWith('/api/projects/prj_1/milestones/candidates') || init.method !== 'POST') {
        return undefined
      }
      const body = requestBody(init)
      bodies.push(body)
      return jsonResponse(candidateResponse(body['requestId']))
    })

    const input = {
      projectRevision: 2,
      promptVersion: MILESTONE_CANDIDATE_PROMPT_VERSION,
      maxCandidates: 1 as const,
    }
    await generateMilestoneCandidates('prj_1', input)
    await generateMilestoneCandidates('prj_1', input)

    expect(bodies[1]?.['idempotencyKey']).toBe(bodies[0]?.['idempotencyKey'])
    expect(bodies[1]?.['requestId']).toBe(bodies[0]?.['requestId'])

    vi.unstubAllGlobals()
    installFetch(() => jsonResponse({
      contractVersion: '3.0',
      requestId: null,
      projectId: 'prj_1',
      code: 'CANDIDATE_EXPIRED',
      message: '候选阶段已过期，请重新生成',
      retryable: false,
    }, 409))
    const expired = await generateMilestoneCandidates('prj_1', input)
    expect(expired.ok).toBe(false)
    if (!expired.ok) {
      expect(expired.error.code).toBe('CANDIDATE_EXPIRED')
      expect(expired.error.message).toContain('候选阶段已过期')
    }
  })
})
