import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADVISOR_RECOMMENDATIONS_PATH,
  MAX_SUGGESTIONS,
  buildAdvisorRequest,
  buildRecommendationId,
  createRequestId,
  fetchRecommendations,
  isStaleResponseError,
  shouldFallbackToLocalRule,
  toRecommendations,
} from '@/services/advisorApi'
import { DEFAULT_API_BASE_URL } from '@/services/http'
import {
  CONTRACT_VERSION,
  DEFAULT_PROMPT_VERSION,
  type AdvisorApiError,
  type AdvisorRecommendationsFailure,
  type AdvisorRecommendationsRequest,
  type AdvisorRecommendationsSuccess,
  type Suggestion,
} from '@/domain/recommendation'

const REQUEST_ID = '9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043'
const PROJECT_ID = 'prj_1'
const REVISION = 3

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    title: '把分辨率缺口写成待确认事项',
    whyNow: '刚提交的证据已经指出这个差距',
    doneCriteria: '一页说明 + 结论',
    existingTaskId: null,
    basisEvidenceIds: [],
    basisDoubtIds: [],
    ...overrides,
  }
}

function makeRequest(overrides: Partial<AdvisorRecommendationsRequest> = {}): AdvisorRecommendationsRequest {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: REQUEST_ID,
    projectId: PROJECT_ID,
    projectRevision: REVISION,
    projectName: '测试项目',
    currentMilestone: '选题确认与文献调研',
    confirmedContext: [],
    tasks: [],
    evidence: [],
    doubts: [],
    promptVersion: DEFAULT_PROMPT_VERSION,
    forceRefresh: false,
    ...overrides,
  }
}

function successBody(
  overrides: Partial<AdvisorRecommendationsSuccess> = {},
): AdvisorRecommendationsSuccess {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: REQUEST_ID,
    projectId: PROJECT_ID,
    projectRevision: REVISION,
    source: 'model',
    fallbackReason: null,
    cached: false,
    promptVersion: DEFAULT_PROMPT_VERSION,
    suggestions: [makeSuggestion()],
    ...overrides,
  }
}

function failureBody(
  code: AdvisorRecommendationsFailure['code'],
  retryable: boolean,
): AdvisorRecommendationsFailure {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: REQUEST_ID,
    code,
    message: '测试错误',
    retryable,
    retryAfterSeconds: null,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 永不返回的 fetch：只有收到 abort 才拒绝 */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    const abort = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal?.aborted === true) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort)
  })

/** 取出 fetch 收到的请求体 */
function sentBody(fetchImpl: ReturnType<typeof vi.fn>): AdvisorRecommendationsRequest {
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  return JSON.parse(String(init.body)) as AdvisorRecommendationsRequest
}

function expectError(result: Awaited<ReturnType<typeof fetchRecommendations>>): AdvisorApiError {
  if (result.ok) throw new Error('期望失败结果，但收到了成功结果')
  return result.error
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('buildAdvisorRequest：请求体组装（契约 4.1）', () => {
  it('填好契约要求的固定字段与默认值', () => {
    const request = buildAdvisorRequest({
      projectId: PROJECT_ID,
      projectRevision: REVISION,
      projectName: '测试项目',
      currentMilestone: null,
      tasks: [],
      evidence: [],
      doubts: [],
    })

    expect(request.contractVersion).toBe('1.0')
    expect(request.projectId).toBe(PROJECT_ID)
    expect(request.projectRevision).toBe(REVISION)
    expect(request.currentMilestone).toBeNull()
    expect(request.confirmedContext).toEqual([])
    expect(request.promptVersion).toBe('mvp-prompt-v1')
    expect(request.forceRefresh).toBe(false)
    expect(typeof request.requestId).toBe('string')
    expect(request.requestId.length).toBeGreaterThan(0)
  })

  it('尊重调用方传入的 requestId / promptVersion / forceRefresh / confirmedContext', () => {
    const request = buildAdvisorRequest({
      projectId: PROJECT_ID,
      projectRevision: REVISION,
      projectName: 'P',
      currentMilestone: 'M',
      tasks: [],
      evidence: [],
      doubts: [],
      requestId: 'fixed-id',
      promptVersion: 'mvp-prompt-v2',
      forceRefresh: true,
      confirmedContext: ['已确认范围：先做西北太平洋'],
    })

    expect(request.requestId).toBe('fixed-id')
    expect(request.promptVersion).toBe('mvp-prompt-v2')
    expect(request.forceRefresh).toBe(true)
    expect(request.confirmedContext).toEqual(['已确认范围：先做西北太平洋'])
  })

  it('createRequestId 每次生成不同的非空标识', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createRequestId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id.length).toBeGreaterThan(10)
  })
})

describe('fetchRecommendations：成功路径', () => {
  it('POST 到契约路径，且在地址栏上不带 /api 重复拼接', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody()))

    const result = await fetchRecommendations(makeRequest(), { fetchImpl })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${DEFAULT_API_BASE_URL}${ADVISOR_RECOMMENDATIONS_PATH}`)
    expect(init.method).toBe('POST')
    expect(result.ok).toBe(true)
  })

  it('请求体就是契约 DTO（序列化后逐字段一致）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody()))
    const request = makeRequest({ forceRefresh: true })

    await fetchRecommendations(request, { fetchImpl })

    expect(sentBody(fetchImpl)).toEqual(request)
  })

  it('解析模型响应：source / fallbackReason / cached / promptVersion 原样保留', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody({ source: 'model' })))

    const result = await fetchRecommendations(makeRequest(), { fetchImpl })

    if (!result.ok) throw new Error('期望成功结果')
    expect(result.data.source).toBe('model')
    expect(result.data.fallbackReason).toBeNull()
    expect(result.data.cached).toBe(false)
    expect(result.data.promptVersion).toBe(DEFAULT_PROMPT_VERSION)
  })

  it('解析服务端 fallback 响应（契约 4.4）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        successBody({
          source: 'fallback',
          fallbackReason: 'MODEL_TIMEOUT',
          suggestions: [makeSuggestion({ existingTaskId: 'tsk_1' })],
        }),
      ),
    )

    const result = await fetchRecommendations(makeRequest(), { fetchImpl })

    if (!result.ok) throw new Error('期望成功结果')
    expect(result.data.source).toBe('fallback')
    expect(result.data.fallbackReason).toBe('MODEL_TIMEOUT')
    expect(result.data.suggestions[0]?.existingTaskId).toBe('tsk_1')
  })

  it('本地展示字段不进入请求体（owner 为 null，无 why / suggestedOwner）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody()))

    await fetchRecommendations(
      makeRequest({
        tasks: [
          {
            taskId: 'tsk_1',
            title: 'T',
            status: 'todo',
            doneCriteria: null,
            owner: null,
            milestone: null,
            updatedAt: '2026-09-26T08:30:00.000Z',
          },
        ],
      }),
      { fetchImpl },
    )

    const body = sentBody(fetchImpl)
    expect(body.tasks[0]?.owner).toBeNull()
    expect(body.tasks[0]).not.toHaveProperty('why')
    expect(body.tasks[0]).not.toHaveProperty('suggestedOwner')
  })
})

describe('fetchRecommendations：失败路径与错误码映射', () => {
  it('契约失败响应保留 code / retryable / retryAfterSeconds', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...failureBody('RATE_LIMITED', true), retryAfterSeconds: 30 }, 429),
    )

    const result = await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })
    const error = expectError(result)

    expect(error.code).toBe('RATE_LIMITED')
    expect(error.retryable).toBe(true)
    expect(error.retryAfterSeconds).toBe(30)
    expect(error.cause).toBe('http')
  })

  it('retryable 字段缺失时按错误码表兜底', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { contractVersion: '1.0', requestId: REQUEST_ID, code: 'MODEL_NOT_CONFIGURED', message: 'x', retryAfterSeconds: null },
        503,
      ),
    )

    const result = await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })

    expect(expectError(result).retryable).toBe(false)
  })

  it('2xx 但响应体不是合法 JSON 时按 NETWORK_ERROR / invalid-json 处理', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }))

    const result = await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })
    const error = expectError(result)

    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.cause).toBe('invalid-json')
  })

  it('非 2xx 且响应体不是合法 JSON 时归为 http（先看状态码）', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }))

    const result = await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })
    const error = expectError(result)

    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.cause).toBe('http')
  })

  it('HTTP 错误但没有契约错误体时按 NETWORK_ERROR 处理', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }, 500))

    const result = await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })
    const error = expectError(result)

    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.cause).toBe('http')
  })

  it('网络层失败按 NETWORK_ERROR 处理', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('fetch failed'))

    const result = await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })
    const error = expectError(result)

    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.cause).toBe('network')
    expect(error.retryable).toBe(true)
  })

  it('超时按 NETWORK_ERROR 处理（契约 7.5）', async () => {
    vi.useFakeTimers()

    const pending = fetchRecommendations(makeRequest(), {
      timeoutMs: 50,
      fetchImpl: hangingFetch,
      retry: false,
    })
    await vi.advanceTimersByTimeAsync(50)

    const error = expectError(await pending)
    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.cause).toBe('timeout')
  })

  it('成功响应缺少必需字段按契约违规处理（契约 8.4）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ contractVersion: '1.0', requestId: REQUEST_ID, projectId: PROJECT_ID }),
    )

    const result = await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })
    const error = expectError(result)

    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.cause).toBe('invalid-response')
  })

  it('建议里 existingTaskId 缺失（不是 null）也判为契约违规', async () => {
    const broken = successBody()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ...broken,
        suggestions: [
          {
            title: 'T',
            whyNow: 'W',
            doneCriteria: 'D',
            basisEvidenceIds: [],
            basisDoubtIds: [],
          },
        ],
      }),
    )

    const result = await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })

    expect(expectError(result).cause).toBe('invalid-response')
  })

  it('已取消的请求直接返回 aborted，不重试', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn(hangingFetch)

    const result = await fetchRecommendations(makeRequest(), {
      signal: controller.signal,
      fetchImpl,
    })

    expect(expectError(result).cause).toBe('aborted')
    expect(expectError(result).retryable).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('fetchRecommendations：过期响应丢弃（契约 4.7 第 1~3 条）', () => {
  it('requestId 对不上时判为过期', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody({ requestId: 'other-id' })))

    const error = expectError(await fetchRecommendations(makeRequest(), { fetchImpl, retry: false }))

    expect(error.code).toBe('STALE_RESPONSE')
    expect(isStaleResponseError(error)).toBe(true)
    expect(shouldFallbackToLocalRule(error)).toBe(false)
  })

  it('projectId 对不上时判为过期', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody({ projectId: 'prj_other' })))

    const error = expectError(await fetchRecommendations(makeRequest(), { fetchImpl, retry: false }))

    expect(error.code).toBe('STALE_RESPONSE')
  })

  it('projectRevision 对不上时判为过期', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(successBody({ projectRevision: REVISION + 1 })))

    const error = expectError(await fetchRecommendations(makeRequest(), { fetchImpl, retry: false }))

    expect(error.code).toBe('STALE_RESPONSE')
  })
})

describe('fetchRecommendations：重试策略（契约 4.0）', () => {
  it('可重试失败自动重试 1 次，成功后返回成功结果', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(failureBody('MODEL_UNAVAILABLE', true), 503))
      .mockResolvedValueOnce(jsonResponse(successBody()))

    const pending = fetchRecommendations(makeRequest(), { fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)

    const result = await pending

    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('只重试一次，第二次仍失败就返回失败', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () => jsonResponse(failureBody('MODEL_UNAVAILABLE', true), 503))

    const pending = fetchRecommendations(makeRequest(), { fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)

    const error = expectError(await pending)

    expect(error.code).toBe('MODEL_UNAVAILABLE')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('确定性失败（retryable = false）不重试', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(failureBody('INVALID_INPUT', false), 400))

    const error = expectError(await fetchRecommendations(makeRequest(), { fetchImpl }))

    expect(error.code).toBe('INVALID_INPUT')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retry: false 时透传选项，不发起第二次请求', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(failureBody('MODEL_UNAVAILABLE', true), 503))

    await fetchRecommendations(makeRequest(), { fetchImpl, retry: false })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('toRecommendations：响应 → 领域对象（契约 2.5(b)）', () => {
  it('补上本地字段：id / source / requestId / projectRevision / generatedAt', () => {
    const result = toRecommendations(successBody())

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: `rec_${REQUEST_ID}_0`,
      source: 'model',
      requestId: REQUEST_ID,
      projectRevision: REVISION,
    })
    expect(typeof result[0]?.generatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(String(result[0]?.generatedAt)))).toBe(false)
  })

  it('fallback 响应同样保留 source 与本地字段', () => {
    const result = toRecommendations(
      successBody({ source: 'fallback', fallbackReason: 'MODEL_TIMEOUT' }),
    )

    expect(result[0]?.source).toBe('fallback')
  })

  it(`最多保留 ${MAX_SUGGESTIONS} 条建议（契约 4.6）`, () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 3 }, (_, index) =>
      makeSuggestion({ title: `建议 ${index}` }),
    )

    expect(toRecommendations(successBody({ suggestions: many }))).toHaveLength(MAX_SUGGESTIONS)
  })

  it('依据 ID 数组逐个复制，不与响应共享引用', () => {
    const suggestions = [makeSuggestion({ basisEvidenceIds: ['evd_1'], basisDoubtIds: ['dbt_1'] })]
    const result = toRecommendations(successBody({ suggestions }))

    result[0]?.basisEvidenceIds.push('evd_2')

    expect(suggestions[0]?.basisEvidenceIds).toEqual(['evd_1'])
  })
})

describe('buildRecommendationId（契约 2.5(b)）', () => {
  it('服务端建议用 rec_<requestId>_<index>', () => {
    expect(buildRecommendationId('model', REQUEST_ID, REVISION, 2)).toBe(`rec_${REQUEST_ID}_2`)
    expect(buildRecommendationId('fallback', REQUEST_ID, REVISION, 0)).toBe(`rec_${REQUEST_ID}_0`)
  })

  it('本地规则或没有 requestId 时用 rec_local_<revision>_<index>', () => {
    expect(buildRecommendationId('local-rule', null, REVISION, 1)).toBe(`rec_local_${REVISION}_1`)
    expect(buildRecommendationId('model', null, REVISION, 1)).toBe(`rec_local_${REVISION}_1`)
  })
})

describe('结果判断辅助', () => {
  it('只有 STALE_RESPONSE 才被判定为过期响应', () => {
    expect(isStaleResponseError({ ...emptyError(), code: 'STALE_RESPONSE' })).toBe(true)
    expect(isStaleResponseError({ ...emptyError(), code: 'NETWORK_ERROR' })).toBe(false)
  })

  it('除过期响应外都要切到本地规则兜底（契约 5.1）', () => {
    expect(shouldFallbackToLocalRule({ ...emptyError(), code: 'STALE_RESPONSE' })).toBe(false)
    expect(shouldFallbackToLocalRule({ ...emptyError(), code: 'NETWORK_ERROR' })).toBe(true)
    expect(shouldFallbackToLocalRule({ ...emptyError(), code: 'MODEL_TIMEOUT' })).toBe(true)
  })
})

function emptyError(): AdvisorApiError {
  return {
    code: 'NETWORK_ERROR',
    message: '',
    retryable: true,
    retryAfterSeconds: null,
    requestId: null,
    cause: 'network',
  }
}
