/**
 * 论文检索 store 单测（契约第 29 节，V5）
 * ----------------------------------------------------------------------------
 * 说明：本测试只基于契约第 29 节的 **mock 响应**，不代表真实联调通过。
 * 用例不发起任何真实 HTTP 请求；OpenAlex 真检索、上游超时降级、Cookie 会话
 * 都必须在接真实后端时另行验证。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCloudStore } from '@/stores/cloud'
import { PAPERS_SEARCH_PATH } from '@/services/papersApi'
import {
  cloudRoutes,
  installFetch,
  jsonResponse,
  makeCloudMilestone,
  makeCloudProject,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const OTHER_PROJECT_ID = 'prj_2'
const REQUEST_ID = '3f1d9c8a-5b2e-4f7a-9c1d-8e2b4a6c0d11'
const RETRY_REQUEST_ID = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function project(projectId: string) {
  return makeCloudProject({
    projectId,
    projectRevision: 3,
    currentMilestoneId: 'ms_1',
    milestones: [makeCloudMilestone({ milestoneId: 'ms_1' })],
  })
}

function paper(title: string, openAccessUrl: string | null = null) {
  return {
    title,
    authors: ['Li W.'],
    year: 2024,
    venue: 'Ocean Engineering',
    doi: '10.1016/j.oceaneng.2024.118000',
    openAccessUrl,
    citedByCount: 37,
  }
}

function isPapersRequest(url: string): boolean {
  return (url.split('?')[0] ?? url).endsWith(PAPERS_SEARCH_PATH)
}

function paramsOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams
}

/** 模拟真实后端：回显请求里的 requestId / projectId */
function papersPayload(
  url: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const params = paramsOf(url)
  return {
    contractVersion: '3.0',
    requestId: params.get('requestId'),
    projectId: params.get('projectId'),
    source: 'openalex',
    notice: null,
    papers: [paper('波浪高度预测综述')],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const baseFor = (projectId: string) => cloudRoutes({ project: project(projectId) })

/** 两个项目的读取路由 + 可插拔的论文检索路由 */
function installRoutes(
  onPapers: (url: string, init: RequestInit) => Response | Promise<Response> | undefined = (
    url,
  ) => jsonResponse(papersPayload(url)),
) {
  const base1 = baseFor(PROJECT_ID)
  const base2 = baseFor(OTHER_PROJECT_ID)
  return installFetch((url, init) => {
    if (isPapersRequest(url)) return onPapers(url, init)
    return base1(url, init) ?? base2(url, init)
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('加载态流转（契约 29.1）', () => {
  it('未加载 → 加载中 → 成功，并记录方向与 requestId', async () => {
    const gate = deferred<Response>()
    installRoutes(() => gate.promise)
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    expect(store.papers.status).toBe('idle')
    expect(store.papers.papers).toEqual([])

    const pending = store.searchPapers({
      query: ' 波浪预测 ',
      limit: 3,
      requestId: REQUEST_ID,
    })
    // 第一个 await 之前就进入加载中：界面能立刻切到「检索中」
    expect(store.papers.status).toBe('loading')
    expect(store.papers.requestId).toBe(REQUEST_ID)
    expect(store.papers.query).toBe('波浪预测')

    gate.resolve(
      jsonResponse({
        contractVersion: '3.0',
        requestId: REQUEST_ID,
        projectId: PROJECT_ID,
        source: 'openalex',
        notice: null,
        papers: [paper('波浪高度预测综述', 'https://example.org/oa')],
      }),
    )
    const result = await pending

    expect(result.ok).toBe(true)
    expect(store.papers.status).toBe('ready')
    expect(store.papers.source).toBe('openalex')
    expect(store.papers.notice).toBeNull()
    expect(store.papers.papers).toHaveLength(1)
    expect(store.papers.papers[0]?.openAccessUrl).toBe('https://example.org/oa')
    expect(store.papers.error).toBeNull()
    expect(store.papers.loadedAt).not.toBeNull()
  })

  it('加载中保留上一份结果，不清空已展示数据', async () => {
    const gate = deferred<Response>()
    let calls = 0
    installRoutes((url) => {
      calls += 1
      if (calls === 1) return jsonResponse(papersPayload(url))
      return gate.promise
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    await store.searchPapers({ query: '方向一', requestId: REQUEST_ID })
    expect(store.papers.papers).toHaveLength(1)

    const pending = store.searchPapers({ query: '方向二', requestId: RETRY_REQUEST_ID })

    expect(store.papers.status).toBe('loading')
    expect(store.papers.papers).toHaveLength(1)
    expect(store.papers.query).toBe('方向二')

    gate.resolve(
      jsonResponse({
        contractVersion: '3.0',
        requestId: RETRY_REQUEST_ID,
        projectId: PROJECT_ID,
        source: 'openalex',
        notice: null,
        papers: [],
      }),
    )
    await pending
    expect(store.papers.status).toBe('ready')
    expect(store.papers.papers).toEqual([])
  })
})

describe('降级（契约 29.1 规则 4 / 29.4）', () => {
  it('source 为 fallback 时状态是降级并保留中文 notice，不是普通零结果', async () => {
    const notice = '论文检索暂时不可用（上游超时），请稍后重试'
    installRoutes((url) =>
      jsonResponse(papersPayload(url, { source: 'fallback', notice, papers: [] })),
    )
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.searchPapers({ query: '方向', requestId: REQUEST_ID })

    expect(result.ok).toBe(true)
    expect(store.papers.status).toBe('fallback')
    expect(store.papers.status).not.toBe('ready')
    expect(store.papers.source).toBe('fallback')
    expect(store.papers.notice).toBe(notice)
    expect(store.papers.papers).toEqual([])
  })
})

describe('失败处理', () => {
  it('失败不清空已展示数据，只标记错误', async () => {
    let failNext = false
    installRoutes((url) => {
      if (failNext) {
        return jsonResponse(
          { contractVersion: '3.0', code: 'PAPERS_UPSTREAM_ERROR', message: '上游未配置' },
          503,
        )
      }
      return jsonResponse(papersPayload(url))
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    await store.searchPapers({ query: '方向', requestId: REQUEST_ID })
    expect(store.papers.papers).toHaveLength(1)

    failNext = true
    const failed = await store.searchPapers({ query: '方向', requestId: RETRY_REQUEST_ID })

    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.code).toBe('PAPERS_UPSTREAM_ERROR')
      expect(failed.message).toBe('论文检索服务暂时不可用，请稍后重试')
    }
    expect(store.papers.status).toBe('error')
    expect(store.papers.papers).toHaveLength(1)
    expect(store.papers.error?.code).toBe('PAPERS_UPSTREAM_ERROR')
    expect(store.papers.requestId).toBe(RETRY_REQUEST_ID)
  })

  it('项目未加载时返回 NOT_LOADED，不发请求', async () => {
    const mock = installRoutes()
    const store = useCloudStore()

    const result = await store.searchPapers({ query: '方向', requestId: REQUEST_ID })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_LOADED')
    expect(mock).not.toHaveBeenCalled()
  })

  it('projectId 与当前项目不一致时返回 PROJECT_MISMATCH', async () => {
    installRoutes()
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.searchPapers({
      projectId: OTHER_PROJECT_ID,
      query: '方向',
      requestId: REQUEST_ID,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PROJECT_MISMATCH')
    expect(store.papers.status).toBe('idle')
  })
})

describe('请求标识与重试', () => {
  it('同一 requestId 重试复用同一个值，且每次都真的发请求（不做前端缓存）', async () => {
    const urls: string[] = []
    installRoutes((url) => {
      urls.push(url)
      return jsonResponse(papersPayload(url))
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    await store.searchPapers({ query: '方向', requestId: REQUEST_ID })
    await store.searchPapers({ query: '方向', requestId: REQUEST_ID })

    expect(urls).toHaveLength(2)
    expect(paramsOf(urls[0]!).get('requestId')).toBe(REQUEST_ID)
    expect(paramsOf(urls[1]!).get('requestId')).toBe(REQUEST_ID)
  })

  it('调用方不传 requestId 时由 store 生成 UUID', async () => {
    const urls: string[] = []
    installRoutes((url) => {
      urls.push(url)
      return jsonResponse(papersPayload(url))
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    await store.searchPapers({ query: '方向' })

    const sent = paramsOf(urls[0]!).get('requestId') ?? ''
    expect(sent).toMatch(UUID_PATTERN)
    expect(store.papers.requestId).toBe(sent)
  })
})

describe('项目切换与迟到响应', () => {
  it('切换项目后丢弃在途响应，不与新项目状态串台', async () => {
    const gate = deferred<Response>()
    installRoutes((url) => {
      const params = paramsOf(url)
      if (params.get('projectId') === PROJECT_ID) return gate.promise
      return jsonResponse(papersPayload(url))
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const pending = store.searchPapers({ query: '方向', requestId: REQUEST_ID })
    expect(store.papers.status).toBe('loading')

    await store.openProject(OTHER_PROJECT_ID)
    expect(store.papers.status).toBe('idle')
    expect(store.papers.papers).toEqual([])

    gate.resolve(
      jsonResponse({
        contractVersion: '3.0',
        requestId: REQUEST_ID,
        projectId: PROJECT_ID,
        source: 'openalex',
        notice: null,
        papers: [paper('旧项目的论文')],
      }),
    )
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_RESPONSE')
    expect(store.papers.status).toBe('idle')
    expect(store.papers.papers).toEqual([])
    expect(store.papers.requestId).toBeNull()
  })

  it('重新打开新项目后可以独立检索，旧结果不残留', async () => {
    installRoutes((url) => jsonResponse(papersPayload(url)))
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    await store.searchPapers({ query: '方向', requestId: REQUEST_ID })
    expect(store.papers.papers).toHaveLength(1)

    await store.openProject(OTHER_PROJECT_ID)
    expect(store.papers.status).toBe('idle')
    expect(store.papers.papers).toEqual([])

    await store.searchPapers({ query: '方向', requestId: RETRY_REQUEST_ID })
    expect(store.papers.status).toBe('ready')
    expect(store.papers.requestId).toBe(RETRY_REQUEST_ID)
  })

  it('reset 后清空论文状态，并丢弃迟到响应', async () => {
    const gate = deferred<Response>()
    let calls = 0
    installRoutes((url) => {
      calls += 1
      if (calls === 1) return jsonResponse(papersPayload(url))
      return gate.promise
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    await store.searchPapers({ query: '方向', requestId: REQUEST_ID })

    const pending = store.searchPapers({ query: '方向', requestId: RETRY_REQUEST_ID })
    store.reset()
    expect(store.papers.status).toBe('idle')
    expect(store.papers.papers).toEqual([])

    gate.resolve(
      jsonResponse({
        contractVersion: '3.0',
        requestId: RETRY_REQUEST_ID,
        projectId: PROJECT_ID,
        source: 'openalex',
        notice: null,
        papers: [paper('迟到的论文')],
      }),
    )
    const result = await pending

    expect(result.ok).toBe(false)
    expect(store.papers.status).toBe('idle')
    expect(store.papers.papers).toEqual([])
  })
})
