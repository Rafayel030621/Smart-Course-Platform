import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/index.js'
import type { AdvisorService } from '../src/advisor/service.js'
import {
  silentLogger,
  type AdvisorChatRequest,
  type AdvisorRequest,
  type ConfirmedMaterial,
} from '../src/advisor/types.js'
import type { ServerConfig } from '../src/config.js'
import { createProject, createTestClient, registerUser, type LoggedInUser } from './v3-support.js'

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  serviceName: 'course-platform-api',
  contractVersion: '1.0',
}

let client: Awaited<ReturnType<typeof createTestClient>>
let user: LoggedInUser
let projectId: string
let spyServer: ReturnType<typeof createApp>
let spyBase: string
let captured: ConfirmedMaterial[] = []
let calls = 0

const spyService: AdvisorService = {
  providerName: 'gate-spy',
  timeoutMs: 1000,
  async recommend(request: AdvisorRequest) {
    calls += 1
    captured = request.confirmedMaterials ?? []
    return {
      ok: true,
      source: 'model',
      fallbackReason: null,
      cached: false,
      suggestions: [
        {
          title: '核对字段',
          whyNow: '依据当前材料',
          doneCriteria: '写出一页说明',
          existingTaskId: null,
          basisEvidenceIds: [],
          basisDoubtIds: [],
        },
      ],
    }
  },
  async chat(_request: AdvisorChatRequest) {
    calls += 1
    return { ok: true, source: 'model', fallbackReason: null, answer: '请核对字段。' }
  },
}

function nowIso(): string {
  return '2026-10-20T00:00:00.000Z'
}

function seedMaterial(
  id: string,
  version: number,
  status: string,
  archivedAt: string | null,
): void {
  const db = client.runtime.getDb()
  db.prepare(
    `INSERT INTO materials
       (material_id, material_version, project_id, user_id, name, type, size, encoding,
        status, revision, sha256, failure_reason, created_at, updated_at, archived_at,
        content_text)
     VALUES (?, ?, ?, ?, ?, 'md', 100, 'utf-8', ?, 1, NULL, NULL, ?, ?, ?, 'DB 正文')`,
  ).run(id, version, projectId, user.userId, `${id}.md`, status, nowIso(), nowIso(), archivedAt)
  db.prepare(
    `INSERT INTO material_segments
       (material_id, material_version, segment_id, idx, start_line, end_line, text,
        char_count, created_at)
     VALUES (?, ?, 'seg_gate', 0, 10, 12, '服务端权威正文', 8, ?)`,
  ).run(id, version, nowIso())
}

function seedUnderstanding(materialId: string, version: number, status: string): void {
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO understanding_items
         (item_id, client_item_id, project_id, material_id, material_version, kind, text,
          original_text, sources_json, status, source, revision, created_at, updated_at,
          confirmed_at, confirmed_by_user_id, removed_at)
       VALUES (?, NULL, ?, ?, ?, 'data', '字段口径', '字段口径',
               '[{"segmentId":"seg_gate"}]', ?, 'ai', 1, ?, ?, ?, ?, NULL)`,
    )
    .run(
      `uitem_${randomUUID()}`,
      projectId,
      materialId,
      version,
      status,
      nowIso(),
      nowIso(),
      status === 'confirmed' ? nowIso() : null,
      status === 'confirmed' ? user.userId : null,
    )
}

function blankContext(): Record<string, unknown> {
  return {
    milestoneId: null,
    currentMilestone: null,
    milestoneRevision: null,
    milestoneGoal: null,
    milestoneDoneCriteria: null,
    milestoneStatus: null,
    milestoneTasks: [],
    recentProgress: [],
    milestoneEvidence: [],
  }
}

function recommendationBody(material: Record<string, unknown>): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: randomUUID(),
    projectId,
    projectRevision: 1,
    projectName: '材料门禁项目',
    currentMilestone: null,
    confirmedContext: [],
    tasks: [],
    evidence: [],
    doubts: [],
    promptVersion: 'mvp-prompt-v3',
    forceRefresh: false,
    milestoneContext: blankContext(),
    confirmedMaterials: [material],
  }
}

function clientMaterial(materialId: string, version = 1): Record<string, unknown> {
  return {
    materialId,
    name: '客户端伪造材料名.md',
    type: 'md',
    version,
    segments: [
      {
        segmentId: 'seg_gate',
        startLine: 999,
        endLine: 1000,
        text: '客户端伪造正文',
      },
    ],
  }
}

async function post(body: unknown): Promise<Response> {
  return fetch(`${spyBase}/api/advisor/recommendations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

before(async () => {
  client = await createTestClient()
  user = await registerUser(client)
  const project = await createProject(client, user, { name: '材料门禁项目' })
  projectId = project.projectId

  seedMaterial('mat_confirmed', 1, 'parsed', null)
  seedUnderstanding('mat_confirmed', 1, 'confirmed')
  seedMaterial('mat_pending', 1, 'parsed', null)
  seedUnderstanding('mat_pending', 1, 'pending')
  seedMaterial('mat_old', 2, 'parsed', null)
  seedMaterial('mat_archived', 1, 'archived', nowIso())

  spyServer = createApp(config, {
    logger: silentLogger,
    v3Runtime: client.runtime,
    advisorService: spyService,
  })
  await new Promise<void>((resolve) => spyServer.listen(0, config.host, resolve))
  const address = spyServer.address() as AddressInfo
  spyBase = `http://${address.address}:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) =>
    spyServer.close((error) => (error ? reject(error) : resolve())),
  )
  await client.close()
})

test('客户端伪造材料名、行号、正文被数据库权威值覆盖', async () => {
  calls = 0
  const response = await post(recommendationBody(clientMaterial('mat_confirmed')))
  assert.equal(response.status, 200)
  assert.equal(calls, 1)
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.name, 'mat_confirmed.md')
  assert.equal(captured[0]?.segments[0]?.startLine, 10)
  assert.equal(captured[0]?.segments[0]?.endLine, 12)
  assert.equal(captured[0]?.segments[0]?.text, '服务端权威正文')
})

test('未确认片段返回 400 UNCONFIRMED_MATERIAL，不调用模型', async () => {
  calls = 0
  const response = await post(recommendationBody(clientMaterial('mat_pending')))
  assert.equal(response.status, 400)
  assert.equal((await response.json() as { code: string }).code, 'UNCONFIRMED_MATERIAL')
  assert.equal(calls, 0)
})

test('旧版本材料返回 409 MATERIAL_VERSION_OUTDATED，不调用模型', async () => {
  calls = 0
  const response = await post(recommendationBody(clientMaterial('mat_old', 1)))
  assert.equal(response.status, 409)
  assert.equal((await response.json() as { code: string }).code, 'MATERIAL_VERSION_OUTDATED')
  assert.equal(calls, 0)
})

test('归档材料返回 409 MATERIAL_VERSION_OUTDATED，不调用模型', async () => {
  calls = 0
  const response = await post(recommendationBody(clientMaterial('mat_archived')))
  assert.equal(response.status, 409)
  assert.equal((await response.json() as { code: string }).code, 'MATERIAL_VERSION_OUTDATED')
  assert.equal(calls, 0)
})
