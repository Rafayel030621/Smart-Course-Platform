import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/index.js'
import { createAdvisorService } from '../src/advisor/service.js'
import { createRuleFallback } from '../src/advisor/fallback.js'
import { createMockProvider } from '../src/advisor/mockProvider.js'
import { silentLogger } from '../src/advisor/types.js'
import type { ServerConfig } from '../src/config.js'

const config: ServerConfig = { host: '127.0.0.1', port: 0, serviceName: 'course-platform-api', contractVersion: '1.0' }
const path = '/api/advisor/chat'
const body = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: '1.0', promptVersion: 'advisor-chat-v1', requestId: 'chat_test_1', projectId: 'prj_chat', projectRevision: 1,
  projectName: '聊天测试项目', currentMilestone: 'MVP', tasks: [], evidence: [], doubts: [], chatHistory: [{ role: 'user', text: '之前的问题' }], question: '下一步应该做什么？', ...overrides,
})
let server: ReturnType<typeof createApp>; let baseUrl: string
before(async () => { server = createApp(config, { logger: silentLogger, advisorService: createAdvisorService({ provider: createMockProvider(), fallback: createRuleFallback(), logger: silentLogger }) }); await new Promise<void>((resolve) => server.listen(0, config.host, resolve)); baseUrl = `http://${(server.address() as AddressInfo).address}:${(server.address() as AddressInfo).port}` })
after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) })
async function post(payload: unknown, init: RequestInit = {}) { return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...init.headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload), ...init }) }

test('正常模型回答返回 200 和 model', async () => { const response = await post(body()); const result = await response.json() as Record<string, unknown>; assert.equal(response.status, 200); assert.equal(result.source, 'model'); assert.equal(result.fallbackReason, null); assert.equal(typeof result.answer, 'string') })
test('非法 JSON、空问题、历史超限和非法 revision 返回 400', async () => { assert.equal((await post('{')).status, 400); assert.equal((await post(body({ question: ' ' }))).status, 400); assert.equal((await post(body({ chatHistory: Array.from({ length: 21 }, () => ({ role: 'user', text: 'x' })) }))).status, 400); assert.equal((await post(body({ projectRevision: 0 }))).status, 400) })
test('GET 返回 405，OPTIONS 返回 CORS 204', async () => { const get = await fetch(`${baseUrl}${path}`); assert.equal(get.status, 405); const preflight = await fetch(`${baseUrl}${path}`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } }); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173') })
test('其他来源被拒绝且不返回通配符 CORS', async () => { const response = await fetch(`${baseUrl}${path}`, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' } }); assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null) })
test('模型不可用、超时和非法输出安全 fallback', async () => { for (const [mode, expected] of [['throw', 'MODEL_UNAVAILABLE'], ['slow', 'MODEL_TIMEOUT'], ['invalid', 'INVALID_MODEL_OUTPUT']] as const) { const app = createApp(config, { logger: silentLogger, advisorService: createAdvisorService({ provider: createMockProvider({ mode, delayMs: 100 }), fallback: createRuleFallback(), timeoutMs: 10, logger: silentLogger }) }); await new Promise<void>((resolve) => app.listen(0, config.host, resolve)); const address = app.address() as AddressInfo; const response = await fetch(`http://${address.address}:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) }); const result = await response.json() as Record<string, unknown>; assert.equal(response.status, 200); assert.equal(result.source, 'fallback'); assert.equal(result.fallbackReason, expected); assert.doesNotMatch(JSON.stringify(result), /MODEL_API_KEY|node_modules|[A-Za-z]:\\|mock provider 模拟上游故障/); await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve())) } })
test('回答响应不泄露密钥、路径或上游原文', async () => { const response = await post(body()); const text = await response.text(); assert.doesNotMatch(text, /MODEL_API_KEY|node_modules|[A-Za-z]:\\|Bearer /) })
