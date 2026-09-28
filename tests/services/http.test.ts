import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  buildUrl,
  requestJson,
  resolveApiBaseUrl,
} from '@/services/http'

/** 构造一个真实 Response，避免依赖手写的假对象 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 构造一份完整的 ImportMetaEnv（Vite 要求 BASE_URL / MODE / DEV / PROD / SSR） */
function fakeEnv(viteApiBaseUrl?: string): ImportMetaEnv {
  return {
    BASE_URL: '/',
    MODE: 'test',
    DEV: false,
    PROD: true,
    SSR: false,
    VITE_API_BASE_URL: viteApiBaseUrl,
  }
}

/** 永不返回的 fetch：只有收到 abort 才拒绝，用于测超时与取消 */
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

function failingFetch(error: unknown): typeof fetch {
  return () => Promise.reject(error)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('地址解析', () => {
  it('buildUrl 用后端基地址拼接相对路径', () => {
    expect(buildUrl('/api/advisor/recommendations')).toBe(
      `${DEFAULT_API_BASE_URL}/api/advisor/recommendations`,
    )
  })

  it('buildUrl 自动补前导斜杠', () => {
    expect(buildUrl('api/x')).toBe(`${DEFAULT_API_BASE_URL}/api/x`)
  })

  it('buildUrl 对已是完整 http(s) 地址的路径原样返回', () => {
    expect(buildUrl('https://example.com/api')).toBe('https://example.com/api')
  })

  it('resolveApiBaseUrl 去掉尾部斜杠，未配置时用默认地址', () => {
    expect(resolveApiBaseUrl(fakeEnv('https://api.example.com/'))).toBe('https://api.example.com')
    expect(resolveApiBaseUrl(fakeEnv('   '))).toBe(DEFAULT_API_BASE_URL)
    expect(resolveApiBaseUrl(fakeEnv())).toBe(DEFAULT_API_BASE_URL)
    expect(resolveApiBaseUrl(undefined)).toBe(DEFAULT_API_BASE_URL)
  })

  it('契约 7.5：默认超时为 20 秒', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000)
  })
})

describe('requestJson：成功路径', () => {
  it('2xx 且响应体是合法 JSON 时返回解析结果', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ hello: 'world' }))

    const result = await requestJson('/x', { fetchImpl })

    expect(result).toEqual({ ok: true, status: 200, data: { hello: 'world' } })
  })

  it('POST 带请求体时发送 JSON 与契约要求的 Content-Type（charset=utf-8）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))

    await requestJson('/api/advisor/recommendations', {
      method: 'POST',
      body: { a: 1 },
      fetchImpl,
    })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${DEFAULT_API_BASE_URL}/api/advisor/recommendations`)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json;charset=utf-8',
    })
  })

  it('不带请求体时不发送 Content-Type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))

    await requestJson('/health', { method: 'GET', fetchImpl })

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBeUndefined()
    expect(init.headers).not.toHaveProperty('content-type')
  })

  it('2xx 但响应体为空时 data 为 null（不当作非法 JSON）', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))

    const result = await requestJson('/x', { fetchImpl })

    expect(result).toEqual({ ok: true, status: 200, data: null })
  })
})

describe('requestJson：失败路径', () => {
  it('非 2xx 归为 http，并带上已解析的错误体', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'INVALID_INPUT' }, 400))

    const result = await requestJson('/x', { method: 'POST', body: {}, fetchImpl })

    expect(result).toEqual({
      ok: false,
      status: 400,
      cause: 'http',
      data: { code: 'INVALID_INPUT' },
    })
  })

  it('2xx 但响应体不是合法 JSON 时归为 invalid-json', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }))

    const result = await requestJson('/x', { fetchImpl })

    expect(result).toEqual({ ok: false, status: 200, cause: 'invalid-json', data: null })
  })

  it('网络层失败归为 network', async () => {
    const result = await requestJson('/x', { fetchImpl: failingFetch(new TypeError('fetch failed')) })

    expect(result).toEqual({ ok: false, status: null, cause: 'network', data: null })
  })

  it('外部信号已取消时立即归为 aborted，不当作网络失败', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await requestJson('/x', {
      signal: controller.signal,
      fetchImpl: hangingFetch,
    })

    expect(result).toEqual({ ok: false, status: null, cause: 'aborted', data: null })
  })

  it('请求进行中取消时归为 aborted', async () => {
    const controller = new AbortController()

    const pending = requestJson('/x', { signal: controller.signal, fetchImpl: hangingFetch })
    controller.abort()

    expect(await pending).toEqual({ ok: false, status: null, cause: 'aborted', data: null })
  })

  it('超过 timeoutMs 归为 timeout（契约 7.5：超时按 NETWORK_ERROR 处理）', async () => {
    vi.useFakeTimers()

    const pending = requestJson('/x', { timeoutMs: 50, fetchImpl: hangingFetch })
    await vi.advanceTimersByTimeAsync(50)

    expect(await pending).toEqual({ ok: false, status: null, cause: 'timeout', data: null })
  })
})
