import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/index.js'
import { silentLogger } from '../src/advisor/types.js'
import { MATERIAL_LIMITS } from '../src/materials/validation.js'
import type { ServerConfig } from '../src/config.js'

/**
 * POST /api/materials 的集成测试（契约 15.1）
 * ----------------------------------------------------------------------------
 * 通过真实 HTTP 服务（随机端口）验证上传、拒绝与错误响应。
 * 该接口不调用模型，因此不需要注入 provider；不占 8080，也不触碰 18080。
 */

const PATH = '/api/materials'

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  serviceName: 'course-platform-api',
  contractVersion: '1.0',
}

const SUCCESS_KEYS = [
  'contractVersion',
  'material',
  'projectId',
  'projectRevision',
  'requestId',
  'segmentCount',
  'segments',
]

const FAILURE_KEYS = [
  'code',
  'contractVersion',
  'message',
  'requestId',
  'retryAfterSeconds',
  'retryable',
]

function base64Of(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function uploadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: '5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90',
    projectId: 'prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031',
    projectRevision: 12,
    materialId: 'mat_9b1e7c2f',
    version: 1,
    name: '实验手册.md',
    contentBase64: base64Of('# 实验手册\n本实验使用 ERA5 海浪场数据。\n\n## 数据说明\n字段包括时间与经纬度。'),
    ...overrides,
  }
}

let server: Server
let baseUrl: string

before(async () => {
  server = createApp(config, { logger: silentLogger })
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://${config.host}:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

async function post(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('合法 md 上传成功：返回元数据与分段，不返回内部信息', async () => {
  const response = await post(uploadBody())
  const body = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(body).sort(), SUCCESS_KEYS)

  const material = body.material as Record<string, unknown>
  assert.equal(material.materialId, 'mat_9b1e7c2f')
  assert.equal(material.projectId, 'prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031')
  assert.equal(material.type, 'md')
  assert.equal(material.encoding, 'utf-8')
  assert.equal(material.state, 'parsed')
  assert.equal(material.version, 1)
  assert.equal(material.failureReason, null)
  assert.equal(typeof material.size, 'number')
  assert.match(String(material.createdAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(material.createdAt, material.updatedAt)

  const segments = body.segments as Array<Record<string, unknown>>
  assert.equal(body.segmentCount, segments.length)
  assert.ok(segments.length >= 1)
  assert.equal(segments[0].segmentId, 'seg_0')
  assert.equal(segments[0].index, 0)
  assert.equal(typeof segments[0].startLine, 'number')

  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('GBK 编码的 txt 上传成功，encoding 标记为 gbk', async () => {
  const gbkBytes = Buffer.concat([
    Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
    Buffer.from('\n\n', 'utf8'),
    Buffer.from([0xca, 0xfd, 0xbe, 0xdd]),
  ])
  const response = await post(uploadBody({ name: '数据说明.txt', contentBase64: gbkBytes.toString('base64') }))
  const body = (await response.json()) as { material: { encoding: string; type: string } }

  assert.equal(response.status, 200)
  assert.equal(body.material.type, 'txt')
  assert.equal(body.material.encoding, 'gbk')
})

test('非 md/txt 文件返回 400 与中文提示，且不回显正文', async () => {
  const response = await post(uploadBody({ name: '秘密数据.csv', contentBase64: base64Of('TOP_SECRET_TEXT') }))
  const body = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 400)
  assert.deepEqual(Object.keys(body).sort(), FAILURE_KEYS)
  assert.equal(body.code, 'UNSUPPORTED_MATERIAL_TYPE')
  assert.match(String(body.message), /md、txt/)
  assert.match(String(body.message), /CSV/)
  assert.equal(body.retryable, false)
  assert.equal(body.retryAfterSeconds, null)
  assert.equal(body.requestId, '5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90')
  assert.doesNotMatch(JSON.stringify(body), /TOP_SECRET_TEXT/)
})

test('空文件返回 EMPTY_MATERIAL', async () => {
  const response = await post(uploadBody({ contentBase64: '' }))
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(response.status, 400)
  assert.equal(body.code, 'EMPTY_MATERIAL')
  assert.match(String(body.message), /空/)
})

test('超过 1 MB 返回 MATERIAL_TOO_LARGE', async () => {
  const bytes = Buffer.alloc(MATERIAL_LIMITS.maxFileBytes + 1, 0x61)
  const response = await post(uploadBody({ contentBase64: bytes.toString('base64') }))
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(response.status, 400)
  assert.equal(body.code, 'MATERIAL_TOO_LARGE')
  assert.equal(body.retryable, false)
})

test('请求体超过 2 MB 时返回 INVALID_INPUT', async () => {
  const bytes = Buffer.alloc(1_600_000, 0x61)
  const response = await post(uploadBody({ contentBase64: bytes.toString('base64') }))
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(response.status, 400)
  assert.equal(body.code, 'INVALID_INPUT')
  assert.match(String(body.message), /字节上限/)
})

test('非法 base64 返回 INVALID_INPUT', async () => {
  const response = await post(uploadBody({ contentBase64: '###' }))
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(response.status, 400)
  assert.equal(body.code, 'INVALID_INPUT')
  assert.match(String(body.message), /base64/)
})

test('请求体不是合法 JSON 时 requestId 为 null', async () => {
  const response = await post('{"contractVersion":')
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(response.status, 400)
  assert.equal(body.code, 'INVALID_INPUT')
  assert.equal(body.requestId, null)
})

test('非 POST 方法返回 405 且带 Allow 头', async () => {
  const response = await fetch(`${baseUrl}${PATH}`)
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
})

test('Content-Type 不是 JSON 时返回 INVALID_INPUT', async () => {
  const response = await fetch(`${baseUrl}${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(uploadBody()),
  })
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(response.status, 400)
  assert.equal(body.code, 'INVALID_INPUT')
  assert.match(String(body.message), /Content-Type/)
})

test('CORS：允许来源的预检返回 204，其他来源返回 403', async () => {
  const preflight = await fetch(`${baseUrl}${PATH}`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://course.xinxian-music.xyz',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://course.xinxian-music.xyz')
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS')

  const denied = await fetch(`${baseUrl}${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify(uploadBody()),
  })
  assert.equal(denied.status, 403)
})
