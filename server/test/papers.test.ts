import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMilestone,
  createProject,
  createTestClient,
  registerUser,
  uuid,
  type LoggedInUser,
  type TestClient,
} from './v3-support.js'
import type { FetchLike } from '../src/advisor/types.js'

/**
 * GET /api/papers/search（契约第 29 节）
 * ----------------------------------------------------------------------------
 * 全部通过注入 fetch 与临时 SQLite 运行，**不发真实 OpenAlex 请求**。
 * 覆盖正常映射、去重/过滤/截断、项目权限、参数校验、超时重试、429 降级、
 * 缺配置 503 与 requestId 重放。
 */

interface Json {
  [key: string]: unknown
}

const OPENALEX_MAILTO = 'papers@example.com'
const MILESTONE_NAME = '数据获取与预处理'
const QUERY = '极端风浪'

let client: TestClient
let user: LoggedInUser
let project: { projectId: string; projectRevision: number }
let fetchCalls: string[] = []
let responder: (url: string, init: RequestInit) => Promise<Response> = async () => {
  throw new Error('responder 未设置')
}

const fetchImpl: FetchLike = async (url, init) => {
  fetchCalls.push(url)
  return responder(url, init)
}

function openAlexWork(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'https://openalex.org/W1',
    doi: '10.1016/j.oceaneng.2024.118xxx',
    display_name: 'Wave height forecasting with machine learning',
    publication_year: 2024,
    cited_by_count: 37,
    authorships: [{ author: { display_name: 'Li W.' } }, { author: { display_name: 'Chen X.' } }],
    primary_location: { source: { display_name: 'Ocean Engineering' } },
    open_access: { oa_url: 'https://example.org/paper' },
    ...overrides,
  }
}

function openAlexResponse(works: unknown[]): Response {
  return new Response(JSON.stringify({ results: works }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function search(
  overrides: {
    query?: string
    limit?: number | string
    requestId?: string
    projectId?: string
    contractVersion?: string
  } = {},
  cookie = user.cookie,
): Promise<{ status: number; body: Json }> {
  const params = new URLSearchParams({
    contractVersion: overrides.contractVersion ?? '3.0',
    requestId: overrides.requestId ?? uuid(),
    projectId: overrides.projectId ?? project.projectId,
    query: overrides.query ?? QUERY,
    limit: String(overrides.limit ?? 5),
  })
  const response = await client.request(`/api/papers/search?${params.toString()}`, { cookie })
  return { status: response.status, body: (await response.json()) as Json }
}

before(async () => {
  client = await createTestClient({
    papersConfig: { mailto: OPENALEX_MAILTO, timeoutMs: 50, missing: [] },
    papersFetchImpl: fetchImpl,
  })
  user = await registerUser(client, { account: `papers_${Date.now().toString().slice(-10)}` })
  project = await createProject(client, user, { name: '极端风浪分析项目' })
  await createMilestone(client, user, project.projectId, project.projectRevision, {
    name: MILESTONE_NAME,
  })
})

after(async () => {
  await client.close()
})

test('正常检索返回规范化论文结果', async () => {
  fetchCalls = []
  responder = async () => openAlexResponse([openAlexWork()])

  const { status, body } = await search({ limit: 2 })

  assert.equal(status, 200)
  assert.equal(body.source, 'openalex')
  assert.equal(body.notice, null)
  const papers = body.papers as Array<Record<string, unknown>>
  assert.equal(papers.length, 1)
  assert.deepEqual(papers[0], {
    title: 'Wave height forecasting with machine learning',
    authors: ['Li W.', 'Chen X.'],
    year: 2024,
    venue: 'Ocean Engineering',
    doi: '10.1016/j.oceaneng.2024.118xxx',
    openAccessUrl: 'https://example.org/paper',
    citedByCount: 37,
  })

  assert.equal(fetchCalls.length, 1)
  const upstreamUrl = new URL(fetchCalls[0] as string)
  assert.equal(upstreamUrl.origin + upstreamUrl.pathname, 'https://api.openalex.org/works')
  assert.equal(
    upstreamUrl.searchParams.get('search'),
    `极端风浪分析项目 ${MILESTONE_NAME} ${QUERY}`,
  )
  assert.equal(upstreamUrl.searchParams.get('per-page'), '2')
  assert.equal(upstreamUrl.searchParams.get('mailto'), OPENALEX_MAILTO)
})

test('同 DOI 去重、无标题条目过滤、超过 limit 截断', async () => {
  fetchCalls = []
  responder = async () =>
    openAlexResponse([
      openAlexWork({ id: 'W1', doi: '10.1/dup', display_name: '第一篇' }),
      openAlexWork({ id: 'W2', doi: '10.1/dup', display_name: '重复 DOI' }),
      openAlexWork({ id: 'W3', display_name: '' }),
      openAlexWork({ id: 'W4', doi: '10.1/third', display_name: '第三篇' }),
      openAlexWork({ id: 'W5', doi: '10.1/fourth', display_name: '第四篇' }),
    ])

  const { status, body } = await search({ limit: 2 })
  const papers = body.papers as Array<Record<string, unknown>>

  assert.equal(status, 200)
  assert.deepEqual(
    papers.map((paper) => paper.title),
    ['第一篇', '第三篇'],
  )
})

test('projectId 不属于当前用户返回 404 PROJECT_NOT_FOUND', async () => {
  fetchCalls = []
  const otherUser = await registerUser(client, { account: `papers_other_${Date.now().toString().slice(-9)}` })
  const otherProject = await createProject(client, otherUser, { name: '他人项目' })

  const { status, body } = await search({ projectId: otherProject.projectId })

  assert.equal(status, 404)
  assert.equal(body.code, 'PROJECT_NOT_FOUND')
  assert.equal(fetchCalls.length, 0)
})

test('query 为空 / 超长、limit 越界返回 400 INVALID_INPUT', async () => {
  fetchCalls = []

  const empty = await search({ query: '' })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'INVALID_INPUT')

  const tooLong = await search({ query: 'x'.repeat(201) })
  assert.equal(tooLong.status, 400)
  assert.equal(tooLong.body.code, 'INVALID_INPUT')

  const lowLimit = await search({ limit: 0 })
  assert.equal(lowLimit.status, 400)
  assert.equal(lowLimit.body.code, 'INVALID_INPUT')

  const highLimit = await search({ limit: 11 })
  assert.equal(highLimit.status, 400)
  assert.equal(highLimit.body.code, 'INVALID_INPUT')

  assert.equal(fetchCalls.length, 0)
})

test('上游超时重试一次后降级为 200 + fallback + 中文 notice', async () => {
  fetchCalls = []
  responder = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'))
      })
    })

  const { status, body } = await search({ query: '超时降级方向' })

  assert.equal(status, 200)
  assert.equal(body.source, 'fallback')
  assert.deepEqual(body.papers, [])
  assert.match(String(body.notice), /响应太慢/)
  assert.doesNotMatch(String(body.notice), /http|PAPERS_/)
  assert.equal(fetchCalls.length, 2)
})

test('上游 429 降级为 200 + fallback + 中文 notice', async () => {
  fetchCalls = []
  responder = async () =>
    new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })

  const { status, body } = await search({ query: '限流降级方向' })

  assert.equal(status, 200)
  assert.equal(body.source, 'fallback')
  assert.deepEqual(body.papers, [])
  assert.match(String(body.notice), /检索太频繁/)
  assert.equal(fetchCalls.length, 1)
})

test('OPENALEX_MAILTO 未配置返回 503 PAPERS_UPSTREAM_ERROR', async () => {
  fetchCalls = []
  const missingClient = await createTestClient({
    papersConfig: { mailto: null, timeoutMs: 50, missing: ['OPENALEX_MAILTO'] },
    papersFetchImpl: fetchImpl,
  })
  try {
    const missingUser = await registerUser(missingClient, {
      account: `papers_missing_${Date.now().toString().slice(-9)}`,
    })
    const missingProject = await createProject(missingClient, missingUser, { name: '缺配置项目' })
    const params = new URLSearchParams({
      contractVersion: '3.0',
      requestId: uuid(),
      projectId: missingProject.projectId,
      query: QUERY,
      limit: '5',
    })
    const response = await missingClient.request(`/api/papers/search?${params.toString()}`, {
      cookie: missingUser.cookie,
    })
    const body = (await response.json()) as Json

    assert.equal(response.status, 503)
    assert.equal(body.code, 'PAPERS_UPSTREAM_ERROR')
    assert.equal(body.retryable, true)
    assert.doesNotMatch(String(body.message), /OPENALEX_MAILTO/)
    assert.equal(fetchCalls.length, 0)
  } finally {
    await missingClient.close()
  }
})

test('同一 requestId 重放不二次调用上游', async () => {
  fetchCalls = []
  responder = async () => openAlexResponse([openAlexWork({ display_name: '重放论文' })])
  const requestId = uuid()

  const first = await search({ requestId })
  const second = await search({ requestId })

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(second.body, first.body)
  assert.equal(fetchCalls.length, 1)
})
