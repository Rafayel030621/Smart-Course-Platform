/**
 * 论文检索真实 HTTP 联调（opt-in，仅 loopback）
 * ----------------------------------------------------------------------------
 * 背景：PR #42 已把 `GET /api/papers/search` 合入 main，但第一批只交付了 mock 单测。
 * 本文件补上「前端 client ↔ 真实后端」的确定性往返，覆盖契约第 29 节的失败路径。
 *
 * 只跑**不依赖外网**的路径（本地后端故意不配置 OPENALEX_MAILTO）：
 *   1. 未配置 OPENALEX_MAILTO → 503 `PAPERS_UPSTREAM_ERROR`；
 *   2. query 越界 / 缺失参数 / limit 越界 → 400 `INVALID_INPUT`；
 *   3. 跨用户项目 → 404 `PROJECT_NOT_FOUND`；
 *   4. 契约版本与错误信封字段形状。
 *
 * **明确标注**：真实 OpenAlex 命中（`source: "openalex"`）、上游超时/5xx 触发的
 * `200 + source: "fallback"`，都属于**人工验收范围**，不在本自动套件内——它们要么依赖
 * 外网，要么依赖上游故障注入，跑进 CI 只会变成不可判定的用例。
 *
 * 与环境变量的关系：`OPENALEX_MAILTO` 是**后端进程**的环境变量，不是前端 harness 的输入，
 * 因此 `tests/support/v3LocalHarness.ts` 无需修改；本套件只要求后端启动时不要设置它。
 * 运行方式见 docs/integration-v3-local.md 第 4 节。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlatformStore } from '@/stores/platform'
import { logoutAccount } from '@/services/authApi'
import { PAPERS_SEARCH_PATH, searchPapers } from '@/services/papersApi'
import {
  HAS_INVITE_CODE,
  LOCAL_BASE_URL,
  SKIP_REASON,
  TEST_ACCOUNT,
  TEST_MARKER,
  TEST_PASSWORD,
  installLocalFetchGuard,
  localRequest,
  must,
  newRequestId,
  type LocalFetchGuard,
} from '../support/v3LocalHarness'

const RUN = LOCAL_BASE_URL !== '' && HAS_INVITE_CODE
const INVITE_CODE = (process.env.V3_LOCAL_INVITE_CODE ?? '').trim()

if (!RUN) console.info(SKIP_REASON)

let guard: LocalFetchGuard | null = null
let platform: ReturnType<typeof usePlatformStore>

/** 账号 A 的项目：用于本套件全部正向身份下的用例 */
let ownerProjectId = ''
/** 账号 B：只用于跨用户越权校验 */
let otherAccount = ''

interface RawResponse {
  status: number
  body: Record<string, unknown>
}

/**
 * 直接对本地后端发检索请求。
 * 传 null 表示「故意不带这个参数」，用于缺失参数用例。
 */
async function searchRaw(
  params: Record<string, string | null>,
): Promise<RawResponse> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) query.set(key, value)
  }
  const suffix = query.toString()
  const response = await localRequest(
    suffix === '' ? PAPERS_SEARCH_PATH : `${PAPERS_SEARCH_PATH}?${suffix}`,
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** 一套合法基础参数，用例只覆盖自己关心的字段 */
function baseParams(overrides: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    projectId: ownerProjectId,
    query: '极端风浪事件识别',
    contractVersion: '3.0',
    requestId: newRequestId(),
    ...overrides,
  }
}

async function registerAccount(account: string): Promise<void> {
  const response = await localRequest('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contractVersion: '3.0',
      requestId: newRequestId(),
      idempotencyKey: `it-papers-register-${account}`,
      account,
      password: TEST_PASSWORD,
      displayName: '论文检索联调用户',
      inviteCode: INVITE_CODE,
    }),
  })
  expect(response.status, `注册失败：HTTP ${response.status}`).toBeLessThan(300)
  must(await platform.initialize(), `初始化会话（${account}）`)
  expect(platform.authStatus).toBe('authenticated')
}

describe.skipIf(!RUN)('论文检索真实 HTTP（仅 loopback，不访问外网）', () => {
  beforeAll(async () => {
    setActivePinia(createPinia())
    guard = installLocalFetchGuard()
    platform = usePlatformStore()

    await registerAccount(TEST_ACCOUNT)
    const created = must(
      await platform.createCloudProject({
        name: `[${TEST_MARKER}] papers v5`,
        profile: {
          goal: '验证论文检索接口的真实失败路径',
          expectedOutcome: '503 / 400 / 404 与错误信封形状可断言',
          memberNames: ['论文检索联调用户'],
          researchPeriod: '2026-10',
          scope: '仅本地临时数据库',
          outOfScope: '不访问 OpenAlex',
        },
      }),
      '创建项目',
    )
    ownerProjectId = created.data.projectId
    expect(ownerProjectId).toMatch(/^prj_/)
  }, 60_000)

  afterAll(() => {
    guard?.uninstall()
    console.info(
      `[${TEST_MARKER}] papers 联调数据（不会自动清理）：` +
        JSON.stringify({ ownerProjectId, otherAccount }),
    )
  })

  it('未配置 OPENALEX_MAILTO：503 PAPERS_UPSTREAM_ERROR，且错误信封字段齐全', async () => {
    const requestId = newRequestId()
    const { status, body } = await searchRaw(baseParams({ requestId }))

    expect(status).toBe(503)
    expect(body['contractVersion']).toBe('3.0')
    expect(body['requestId']).toBe(requestId)
    expect(body['code']).toBe('PAPERS_UPSTREAM_ERROR')
    expect(typeof body['message']).toBe('string')
    expect(String(body['message'])).toContain('论文检索')
    expect(typeof body['retryable']).toBe('boolean')
    expect(body['retryAfterSeconds']).toBeNull()
    // 失败响应不是成功包络：不得携带 data / source / papers
    expect(body['data']).toBeUndefined()
    expect(body['source']).toBeUndefined()
    expect(body['papers']).toBeUndefined()
  })

  it('前端 client 把 503 归一化为中文错误，不泄露服务端细节', async () => {
    const result = await searchPapers({ projectId: ownerProjectId, query: '极端风浪事件识别' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PAPERS_UPSTREAM_ERROR')
    expect(result.error.message).toBe('论文检索服务暂时不可用，请稍后重试')
    expect(result.error.status).toBe(503)
  })

  it('query 边界：200 字放行（走到上游配置检查），201 字被拒 400', async () => {
    const atLimit = await searchRaw(baseParams({ query: '字'.repeat(200) }))
    // 200 字通过长度校验，卡在 mailto 未配置上
    expect(atLimit.status).toBe(503)
    expect(atLimit.body['code']).toBe('PAPERS_UPSTREAM_ERROR')

    const overLimit = await searchRaw(baseParams({ query: '字'.repeat(201) }))
    expect(overLimit.status).toBe(400)
    expect(overLimit.body['code']).toBe('INVALID_INPUT')
    expect(String(overLimit.body['message'])).toContain('200')
  })

  it('query 为空或纯空白被拒 400 INVALID_INPUT', async () => {
    for (const query of ['', '   ']) {
      const response = await searchRaw(baseParams({ query }))
      expect(response.status).toBe(400)
      expect(response.body['code']).toBe('INVALID_INPUT')
      expect(String(response.body['message'])).toContain('query')
    }
  })

  it('limit 边界：10 放行、0 / 11 / 小数被拒 400', async () => {
    const max = await searchRaw(baseParams({ limit: '10' }))
    expect(max.status).toBe(503)

    for (const limit of ['0', '11', '5.5']) {
      const response = await searchRaw(baseParams({ limit }))
      expect(response.status).toBe(400)
      expect(response.body['code']).toBe('INVALID_INPUT')
      expect(String(response.body['message'])).toContain('limit')
    }
  })

  it('缺失必填参数与非法 requestId 都被拒 400', async () => {
    const cases: Array<[string, Record<string, string | null>]> = [
      ['缺 requestId', baseParams({ requestId: null })],
      ['缺 projectId', baseParams({ projectId: null })],
      ['缺 query', baseParams({ query: null })],
      ['缺 contractVersion', baseParams({ contractVersion: null })],
      ['requestId 非 UUID', baseParams({ requestId: 'not-a-uuid' })],
    ]

    for (const [label, params] of cases) {
      const response = await searchRaw(params)
      expect(response.status, label).toBe(400)
      expect(response.body['code'], label).toBe('INVALID_INPUT')
    }
  })

  it('契约版本非 3.0 被拒 400，并指出 contractVersion', async () => {
    const response = await searchRaw(baseParams({ contractVersion: '2.0' }))

    expect(response.status).toBe(400)
    expect(response.body['code']).toBe('INVALID_INPUT')
    expect(String(response.body['message'])).toContain('contractVersion')
  })

  it('退出登录后访问返回 401 UNAUTHORIZED，不进入业务逻辑', async () => {
    must(await logoutAccount(), '退出登录')

    const response = await searchRaw(baseParams())

    expect(response.status).toBe(401)
    expect(response.body['code']).toBe('UNAUTHORIZED')
    expect(response.body['data']).toBeUndefined()
  })

  it('跨用户项目返回 404 PROJECT_NOT_FOUND（不泄露项目是否存在）', async () => {
    otherAccount = `${TEST_ACCOUNT}_b`
    // 注册第二个账号会顶掉当前会话：以下断言全部以账号 B 的身份执行
    await registerAccount(otherAccount)

    const raw = await searchRaw(
      baseParams({ projectId: ownerProjectId, query: '极端风浪事件识别' }),
    )
    expect(raw.status).toBe(404)
    expect(raw.body['code']).toBe('PROJECT_NOT_FOUND')

    const result = await searchPapers({ projectId: ownerProjectId, query: '极端风浪事件识别' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PROJECT_NOT_FOUND')
    expect(result.error.message).toBe('项目不存在或已被删除')
    expect(result.error.status).toBe(404)
  })

  it('确实只访问了 loopback，没有外部请求', () => {
    const requests = guard?.requests ?? []
    expect(requests.length).toBeGreaterThan(0)
    for (const url of requests) {
      const parsed = new URL(url)
      expect(['127.0.0.1', 'localhost', '::1', '[::1]']).toContain(parsed.hostname)
      expect(parsed.pathname === PAPERS_SEARCH_PATH || parsed.pathname.startsWith('/api/')).toBe(true)
    }
  })
})
