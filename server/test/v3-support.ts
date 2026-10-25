import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../src/index.js'
import { silentLogger, type FetchLike } from '../src/advisor/types.js'
import type { PapersConfig } from '../src/config.js'
import type { ServerConfig } from '../src/config.js'
import { createV3Runtime, hashInviteCode, type V3Runtime } from '../src/v3/runtime.js'
import type { V3Logger, SafeLogFields } from '../src/v3/logger.js'

/**
 * V3 集成测试支撑
 * ----------------------------------------------------------------------------
 * 每个测试文件使用独立临时数据库；不写 server/data，也不触碰生产配置。
 */

export const ALLOWED_ORIGIN = 'http://localhost:5173'
export const INVITE_CODE = 'INVITE-2026-ABCD'
export const TEST_INVITE_HASH = hashInviteCode(INVITE_CODE)
export const PASSWORD = 'correct-horse-battery-staple'

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  serviceName: 'course-platform-api',
  contractVersion: '1.0',
}

export interface CapturedLog {
  level: 'info' | 'warn'
  message: string
  fields: SafeLogFields | undefined
}

export class CapturingLogger implements V3Logger {
  readonly entries: CapturedLog[] = []

  info(message: string, fields?: SafeLogFields): void {
    this.entries.push({ level: 'info', message, fields })
  }

  warn(message: string, fields?: SafeLogFields): void {
    this.entries.push({ level: 'warn', message, fields })
  }

  text(): string {
    return JSON.stringify(this.entries)
  }
}

export interface TestClient {
  baseUrl: string
  runtime: V3Runtime
  logger: CapturingLogger
  server: Server
  close(): Promise<void>
  request(
    pathname: string,
    options?: {
      method?: string
      body?: unknown
      cookie?: string | null
      origin?: string | null
      contentType?: string | null
      headers?: Record<string, string>
    },
  ): Promise<Response>
}

export async function createTestClient(
  options: {
    sessionTtlMs?: number
    secureCookies?: boolean
    rateLimit?: {
      maxAccountAttempts?: number
      maxIpAttempts?: number
      windowMs?: number
      maxEntries?: number
    }
    trustProxyHops?: number
    papersConfig?: PapersConfig
    papersFetchImpl?: FetchLike
  } = {},
): Promise<TestClient> {
  const dir = mkdtempSync(path.join(tmpdir(), 'scp-v3-test-'))
  const logger = new CapturingLogger()
  const runtime = createV3Runtime({
    databasePath: path.join(dir, 'test.sqlite'),
    allowedOrigins: [ALLOWED_ORIGIN],
    secureCookies: options.secureCookies ?? false,
    inviteCodeHashes: [TEST_INVITE_HASH],
    sessionTtlMs: options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000,
    passwordRounds: 4,
    rateLimit: options.rateLimit,
    // 测试显式固定为 0，避免开发者本机 SCP_TRUST_PROXY_HOPS 影响限流键
    trustProxyHops: options.trustProxyHops ?? 0,
    logger,
  })
  const server = createApp(config, {
    logger: silentLogger,
    v3Runtime: runtime,
    papersConfig: options.papersConfig,
    papersFetchImpl: options.papersFetchImpl,
  })
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://${config.host}:${address.port}`

  return {
    baseUrl,
    runtime,
    logger,
    server,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      runtime.close()
      rmSync(dir, { recursive: true, force: true })
    },
    request(pathname, options = {}) {
      const method = options.method ?? 'GET'
      const headers: Record<string, string> = { ...(options.headers ?? {}) }
      if (method !== 'GET' && method !== 'HEAD') {
        const contentType = options.contentType === undefined ? 'application/json' : options.contentType
        if (contentType !== null) headers['Content-Type'] = contentType
      }
      const origin = options.origin === undefined ? ALLOWED_ORIGIN : options.origin
      if (origin !== null) headers.Origin = origin
      if (options.cookie !== undefined && options.cookie !== null) {
        headers.Cookie = `scp_session=${options.cookie}`
      }
      return fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body:
          options.body === undefined
            ? undefined
            : typeof options.body === 'string'
              ? options.body
              : JSON.stringify(options.body),
      })
    },
  }
}

/** 从 Set-Cookie 头中提取 scp_session 值 */
export function sessionFrom(response: Response): string {
  const header = response.headers.get('set-cookie')
  if (header === null) throw new Error('missing set-cookie')
  const match = /scp_session=([^;]+)/.exec(header)
  if (match === null) throw new Error('missing session cookie')
  return match[1] as string
}

let requestCounter = 0

export function uuid(): string {
  requestCounter += 1
  const hex = createHash('sha256').update(`${Date.now()}-${requestCounter}-${Math.random()}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function envelope(projectId: string, projectRevision: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: `test-${uuid().slice(0, 24)}`,
    projectId,
    projectRevision,
    ...extra,
  }
}

export function registerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: `register-${uuid().slice(0, 20)}`,
    account: `student_${Math.random().toString(36).slice(2, 10)}`,
    password: PASSWORD,
    displayName: '张同学',
    inviteCode: INVITE_CODE,
    ...overrides,
  }
}

export interface LoggedInUser {
  cookie: string
  userId: string
  account: string
}

export async function registerUser(
  client: TestClient,
  overrides: Record<string, unknown> = {},
): Promise<LoggedInUser> {
  const body = registerBody(overrides)
  const response = await client.request('/api/auth/register', { method: 'POST', body })
  if (response.status !== 200) {
    throw new Error(`register failed: ${response.status} ${await response.text()}`)
  }
  const parsed = (await response.json()) as { user: { userId: string; account: string } }
  return {
    cookie: sessionFrom(response),
    userId: parsed.user.userId,
    account: parsed.user.account,
  }
}

export async function createProject(
  client: TestClient,
  user: LoggedInUser,
  overrides: Record<string, unknown> = {},
): Promise<{ projectId: string; projectRevision: number }> {
  const response = await client.request('/api/projects', {
    method: 'POST',
    cookie: user.cookie,
    body: {
      contractVersion: '3.0',
      requestId: uuid(),
      idempotencyKey: `project-${uuid().slice(0, 20)}`,
      name: '面向海洋环境安全保障的极端风浪分析系统',
      short: '极端风浪',
      profile: { goal: '构建原型系统', memberNames: ['张同学'] },
      ...overrides,
    },
  })
  if (response.status !== 200) {
    throw new Error(`create project failed: ${response.status} ${await response.text()}`)
  }
  const parsed = (await response.json()) as { projectId: string; projectRevision: number }
  return { projectId: parsed.projectId, projectRevision: parsed.projectRevision }
}

export async function getProjectRevision(
  client: TestClient,
  user: LoggedInUser,
  projectId: string,
): Promise<number> {
  const response = await client.request(`/api/projects/${projectId}`, { cookie: user.cookie })
  const parsed = (await response.json()) as { projectRevision: number }
  return parsed.projectRevision
}

export async function createMilestone(
  client: TestClient,
  user: LoggedInUser,
  projectId: string,
  projectRevision: number,
  overrides: Record<string, unknown> = {},
): Promise<{ milestoneId: string; revision: number; projectRevision: number }> {
  const response = await client.request(`/api/projects/${projectId}/milestones`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, projectRevision, {
      name: `阶段-${Math.random().toString(36).slice(2, 8)}`,
      goal: '阶段目标',
      doneCriteria: '阶段完成标准',
      dueAt: null,
      ...overrides,
    }),
  })
  if (response.status !== 200) {
    throw new Error(`create milestone failed: ${response.status} ${await response.text()}`)
  }
  const parsed = (await response.json()) as {
    data: { milestone: { milestoneId: string; revision: number } }
    projectRevision: number
  }
  return {
    milestoneId: parsed.data.milestone.milestoneId,
    revision: parsed.data.milestone.revision,
    projectRevision: parsed.projectRevision,
  }
}

export async function createTask(
  client: TestClient,
  user: LoggedInUser,
  projectId: string,
  projectRevision: number,
  overrides: Record<string, unknown> = {},
): Promise<{ taskId: string; revision: number; projectRevision: number }> {
  const response = await client.request(`/api/projects/${projectId}/tasks`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, projectRevision, {
      title: `任务-${Math.random().toString(36).slice(2, 8)}`,
      doneCriteria: '完成标准',
      milestoneId: null,
      ...overrides,
    }),
  })
  if (response.status !== 200) {
    throw new Error(`create task failed: ${response.status} ${await response.text()}`)
  }
  const parsed = (await response.json()) as {
    data: { task: { taskId: string; revision: number } }
    projectRevision: number
  }
  return {
    taskId: parsed.data.task.taskId,
    revision: parsed.data.task.revision,
    projectRevision: parsed.projectRevision,
  }
}
