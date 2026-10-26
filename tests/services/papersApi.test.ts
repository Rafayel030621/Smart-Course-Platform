/**
 * 论文检索 API client 单测（契约第 29 节，V5）
 * ----------------------------------------------------------------------------
 * 说明：本测试只基于契约第 29 节的 **mock 响应**，不代表真实联调通过。
 * 后端 `GET /api/papers/search` 的实现（PR #42）虽已合入 main，但这里的用例
 * 不发起任何真实 HTTP 请求，真实联调（OpenAlex、超时降级、Cookie 会话）仍需单独验证。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PAPERS_FALLBACK_NOTICE,
  PAPERS_SEARCH_DEFAULT_LIMIT,
  PAPERS_SEARCH_MAX_LIMIT,
  PAPERS_SEARCH_PATH,
  buildPapersSearchQuery,
  parsePapersResponse,
  searchPapers,
} from '@/services/papersApi'
import { installFetch, jsonResponse } from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const REQUEST_ID = '3f1d9c8a-5b2e-4f7a-9c1d-8e2b4a6c0d11'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function paperDto(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Wave height forecasting with transformer models',
    authors: ['Li W.', 'Chen X.'],
    year: 2024,
    venue: 'Ocean Engineering',
    doi: '10.1016/j.oceaneng.2024.118000',
    openAccessUrl: 'https://example.org/oa/118000',
    citedByCount: 37,
    ...overrides,
  }
}

function papersResponse(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: '3.0',
    requestId: REQUEST_ID,
    projectId: PROJECT_ID,
    source: 'openalex',
    notice: null,
    papers: [paperDto()],
    ...overrides,
  }
}

function isSearchRequest(url: string): boolean {
  return (url.split('?')[0] ?? url).endsWith(PAPERS_SEARCH_PATH)
}

function searchParamsOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('请求构造（契约 29.2）', () => {
  it('只携带契约定义的 5 个 Query 字段，不带 projectName / currentMilestone', async () => {
    let captured: URLSearchParams | null = null
    installFetch((url) => {
      captured = searchParamsOf(url)
      return jsonResponse(papersResponse())
    })

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '波浪预测',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(true)
    const params = captured!
    expect([...params.keys()].sort()).toEqual([
      'contractVersion',
      'limit',
      'projectId',
      'query',
      'requestId',
    ])
    expect(params.get('projectId')).toBe(PROJECT_ID)
    expect(params.get('query')).toBe('波浪预测')
    expect(params.get('contractVersion')).toBe('3.0')
    expect(params.get('requestId')).toBe(REQUEST_ID)
  })

  it('limit 默认 5、上限 10', async () => {
    const limits: string[] = []
    installFetch((url) => {
      limits.push(searchParamsOf(url).get('limit') ?? '')
      return jsonResponse(papersResponse())
    })

    await searchPapers({ projectId: PROJECT_ID, query: '方向', requestId: REQUEST_ID })
    await searchPapers({ projectId: PROJECT_ID, query: '方向', limit: 10, requestId: REQUEST_ID })

    expect(PAPERS_SEARCH_DEFAULT_LIMIT).toBe(5)
    expect(PAPERS_SEARCH_MAX_LIMIT).toBe(10)
    expect(limits).toEqual(['5', '10'])
  })

  it('query 去掉首尾空白再提交', async () => {
    let captured: URLSearchParams | null = null
    installFetch((url) => {
      captured = searchParamsOf(url)
      return jsonResponse(papersResponse())
    })

    await searchPapers({ projectId: PROJECT_ID, query: '  波浪预测  ', requestId: REQUEST_ID })

    expect(captured!.get('query')).toBe('波浪预测')
  })

  it('不传 requestId 时生成 UUID 并随请求发出', async () => {
    let captured: URLSearchParams | null = null
    installFetch((url) => {
      captured = searchParamsOf(url)
      return jsonResponse({ ...papersResponse(), requestId: searchParamsOf(url).get('requestId') })
    })

    const result = await searchPapers({ projectId: PROJECT_ID, query: '方向' })

    const sent = captured!.get('requestId') ?? ''
    expect(sent).toMatch(UUID_PATTERN)
    expect(result.ok).toBe(true)
  })

  it('buildPapersSearchQuery 不含契约之外的字段', () => {
    const query = buildPapersSearchQuery({
      projectId: PROJECT_ID,
      query: '方向',
      limit: 5,
      requestId: REQUEST_ID,
    })
    expect(Object.keys(query).sort()).toEqual([
      'contractVersion',
      'limit',
      'projectId',
      'query',
      'requestId',
    ])
  })
})

describe('参数边界（契约 29.2 / 29.4）', () => {
  it('query 1 字与 200 字均可提交', async () => {
    const mock = installFetch(() => jsonResponse(papersResponse()))

    const one = await searchPapers({ projectId: PROJECT_ID, query: 'a', requestId: REQUEST_ID })
    const full = await searchPapers({
      projectId: PROJECT_ID,
      query: '字'.repeat(200),
      requestId: REQUEST_ID,
    })

    expect(one.ok).toBe(true)
    expect(full.ok).toBe(true)
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('query 长度按 UTF-16 码元计（契约 v4.1 §29.2）：emoji 每个算 2 个码元', async () => {
    const mock = installFetch(() => jsonResponse(papersResponse()))
    const emoji = '🌊'

    // 100 个 emoji = 200 码元 → 放行
    const allowed = await searchPapers({
      projectId: PROJECT_ID,
      query: emoji.repeat(100),
      requestId: REQUEST_ID,
    })
    expect(allowed.ok).toBe(true)

    // 101 个 emoji = 202 码元 → 本地拒绝，不发请求
    const rejected = await searchPapers({
      projectId: PROJECT_ID,
      query: emoji.repeat(101),
      requestId: REQUEST_ID,
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('INVALID_INPUT')
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('query 为空、纯空白、201 字时本地拒绝且不发请求', async () => {
    const mock = installFetch(() => jsonResponse(papersResponse()))

    for (const query of ['', '   ', '字'.repeat(201)]) {
      const result = await searchPapers({ projectId: PROJECT_ID, query, requestId: REQUEST_ID })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_INPUT')
        expect(result.error.message).toBe('检索方向需为 1–200 字')
      }
    }
    expect(mock).not.toHaveBeenCalled()
  })

  it('limit 越界（0 / 11 / 小数）本地拒绝且不发请求', async () => {
    const mock = installFetch(() => jsonResponse(papersResponse()))

    for (const limit of [0, 11, 5.5, -1]) {
      const result = await searchPapers({
        projectId: PROJECT_ID,
        query: '方向',
        limit,
        requestId: REQUEST_ID,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT')
    }
    expect(mock).not.toHaveBeenCalled()
  })

  it('projectId 为空或 requestId 不是 UUID 时本地拒绝', async () => {
    const mock = installFetch(() => jsonResponse(papersResponse()))

    const noProject = await searchPapers({ projectId: '  ', query: '方向', requestId: REQUEST_ID })
    const badRequestId = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: 'not-a-uuid',
    })

    expect(noProject.ok).toBe(false)
    expect(badRequestId.ok).toBe(false)
    if (!badRequestId.ok) expect(badRequestId.error.code).toBe('INVALID_INPUT')
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('响应解析（契约 29.3）', () => {
  it('解析正常响应，openAccessUrl 为 null 时原样保留', async () => {
    installFetch(() =>
      jsonResponse(papersResponse({ papers: [paperDto({ openAccessUrl: null, year: null })] })),
    )

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.source).toBe('openalex')
    expect(result.data.notice).toBeNull()
    expect(result.data.papers).toHaveLength(1)
    expect(result.data.papers[0]).toEqual({
      title: 'Wave height forecasting with transformer models',
      authors: ['Li W.', 'Chen X.'],
      year: null,
      venue: 'Ocean Engineering',
      doi: '10.1016/j.oceaneng.2024.118000',
      openAccessUrl: null,
      citedByCount: 37,
    })
  })

  it('source 为 fallback 时保留中文 notice 与空数组', async () => {
    const notice = '论文检索暂时不可用（上游超时），请稍后重试'
    installFetch(() => jsonResponse(papersResponse({ source: 'fallback', notice, papers: [] })))

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.source).toBe('fallback')
    expect(result.data.notice).toBe(notice)
    expect(result.data.papers).toEqual([])
  })

  it('fallback 缺 notice 时补中文兜底文案，不返回静默空列表', async () => {
    installFetch(() => jsonResponse(papersResponse({ source: 'fallback', notice: null, papers: [] })))

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.notice).toBe(PAPERS_FALLBACK_NOTICE)
  })

  it('单条论文缺标题或字段类型错时丢弃该条，不影响其余结果', () => {
    const parsed = parsePapersResponse(
      papersResponse({
        papers: [paperDto({ title: '   ' }), paperDto({ title: '有效论文' }), paperDto({ authors: 'Li W.' })],
      }),
      { requestId: REQUEST_ID, projectId: PROJECT_ID },
    )

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.papers).toHaveLength(1)
    expect(parsed.data.papers[0]?.title).toBe('有效论文')
  })

  it('contractVersion 不是 3.0 时归一化为 CONTRACT_VERSION_MISMATCH', () => {
    const parsed = parsePapersResponse(papersResponse({ contractVersion: '2.0' }), {
      requestId: REQUEST_ID,
      projectId: PROJECT_ID,
    })

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('CONTRACT_VERSION_MISMATCH')
  })

  it('响应 projectId 与请求不一致时视为过期响应', () => {
    const parsed = parsePapersResponse(papersResponse({ projectId: 'prj_other' }), {
      requestId: REQUEST_ID,
      projectId: PROJECT_ID,
    })

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('STALE_RESPONSE')
  })

  it('source 取值不在契约枚举内时报 INVALID_RESPONSE', () => {
    const parsed = parsePapersResponse(papersResponse({ source: 'crossref' }), {
      requestId: REQUEST_ID,
      projectId: PROJECT_ID,
    })

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('INVALID_RESPONSE')
  })
})

describe('失败路径中文映射（契约 29.4）', () => {
  it('404 PROJECT_NOT_FOUND', async () => {
    installFetch(() =>
      jsonResponse({ contractVersion: '3.0', code: 'PROJECT_NOT_FOUND', message: '项目不存在' }, 404),
    )

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PROJECT_NOT_FOUND')
    expect(result.error.message).toBe('项目不存在或已被删除')
  })

  it('400 INVALID_INPUT', async () => {
    installFetch(() =>
      jsonResponse({ contractVersion: '3.0', code: 'INVALID_INPUT', message: 'bad query' }, 400),
    )

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INVALID_INPUT')
    expect(result.error.message).toBe('输入内容不合法，请检查后重试')
  })

  it('503 PAPERS_UPSTREAM_ERROR（OPENALEX_MAILTO 未配置）', async () => {
    installFetch(() =>
      jsonResponse(
        { contractVersion: '3.0', code: 'PAPERS_UPSTREAM_ERROR', message: 'upstream disabled' },
        503,
      ),
    )

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PAPERS_UPSTREAM_ERROR')
    expect(result.error.message).toBe('论文检索服务暂时不可用，请稍后重试')
  })

  it('限流走通用 RATE_LIMITED，契约中不存在 PAPERS_RATE_LIMITED', async () => {
    installFetch(() =>
      jsonResponse({ contractVersion: '3.0', code: 'RATE_LIMITED', message: 'slow down' }, 429),
    )

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('RATE_LIMITED')
    expect(result.error.code).not.toBe('PAPERS_RATE_LIMITED')
    expect(result.error.message).toBe('操作过于频繁，请稍后再试')
  })

  it('网络失败映射 NETWORK_ERROR 且可重试', async () => {
    installFetch(() => {
      throw new Error('boom')
    })

    const result = await searchPapers({
      projectId: PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NETWORK_ERROR')
    expect(result.error.retryable).toBe(true)
  })

  it('解析阶段直接抛错（isSearchRequest 命中的路径）不会进入其它接口', async () => {
    const mock = installFetch((url) => {
      expect(isSearchRequest(url)).toBe(true)
      return jsonResponse(papersResponse())
    })

    await searchPapers({ projectId: PROJECT_ID, query: '方向', requestId: REQUEST_ID })
    expect(mock).toHaveBeenCalledTimes(1)
  })
})
