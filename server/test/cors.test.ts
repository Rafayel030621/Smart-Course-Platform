import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/index.js'
import { createAdvisorService } from '../src/advisor/service.js'
import { createMockProvider } from '../src/advisor/mockProvider.js'
import { createRuleFallback } from '../src/advisor/fallback.js'
import { silentLogger, type AdvisorProvider } from '../src/advisor/types.js'
import type { ServerConfig } from '../src/config.js'

const ALLOWED_ORIGINS = [
  'https://course.xinxian-music.xyz',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const
const DENIED_ORIGIN = 'https://example.com'
const PATH = '/api/advisor/recommendations'
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  serviceName: 'course-platform-api',
  contractVersion: '1.0',
}

const body = {
  contractVersion: '1.0',
  requestId: '9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043',
  projectId: 'prj_cors_check',
  projectRevision: 1,
  projectName: 'CORS 验收',
  currentMilestone: '首轮 MVP',
  confirmedContext: ['验证跨域请求'],
  tasks: [
    {
      taskId: 'tsk_cors_check',
      title: '完成跨域验收',
      status: 'doing',
      doneCriteria: 'OPTIONS 和 POST 都能正确处理',
      owner: null,
      milestone: '首轮 MVP',
      updatedAt: '2026-09-25T10:00:00+08:00',
    },
  ],
  evidence: [],
  doubts: [],
  promptVersion: 'mvp-prompt-v1',
  forceRefresh: false,
}

let server: Server
let baseUrl: string

before(async () => {
  const provider: AdvisorProvider = createMockProvider()
  server = createApp(config, {
    logger: silentLogger,
    advisorService: createAdvisorService({
      provider,
      fallback: createRuleFallback(),
      logger: silentLogger,
    }),
  })
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://${config.host}:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

for (const allowedOrigin of ALLOWED_ORIGINS) {
  test(`允许的 OPTIONS 预检返回 204：${allowedOrigin}`, async () => {
    const response = await fetch(`${baseUrl}${PATH}`, {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    })

    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin)
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type')
    assert.equal(response.headers.get('vary'), 'Origin')
  })
}

for (const allowedOrigin of ALLOWED_ORIGINS) {
  test(`允许来源的 POST 返回模型建议：${allowedOrigin}`, async () => {
    const response = await fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: allowedOrigin },
      body: JSON.stringify(body),
    })
    const result = (await response.json()) as { source: string; suggestions: unknown[] }

    assert.equal(response.status, 200)
    assert.equal(result.source, 'model')
    assert.ok(result.suggestions.length >= 1 && result.suggestions.length <= 3)
    assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin)
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type')
  })
}

test('拒绝其他来源的预检和 POST，且不返回通配 CORS 头', async () => {
  const preflight = await fetch(`${baseUrl}${PATH}`, {
    method: 'OPTIONS',
    headers: {
      Origin: DENIED_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  })
  assert.equal(preflight.status, 403)
  assert.equal(preflight.headers.get('access-control-allow-origin'), null)

  const post = await fetch(`${baseUrl}${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: DENIED_ORIGIN },
    body: JSON.stringify(body),
  })
  assert.equal(post.status, 403)
  assert.equal(post.headers.get('access-control-allow-origin'), null)
  assert.notEqual(post.headers.get('access-control-allow-origin'), '*')
})
