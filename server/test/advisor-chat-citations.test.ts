import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../src/index.js'
import { createAdvisorService } from '../src/advisor/service.js'
import { createRuleFallback } from '../src/advisor/fallback.js'
import type { AdvisorLogger, AdvisorProvider } from '../src/advisor/types.js'
import type { ServerConfig } from '../src/config.js'
import { createV3Runtime } from '../src/v3/runtime.js'

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  serviceName: 'course-platform-api',
  contractVersion: '1.0',
}

const CONFIRMED_SEGMENTS = [
  { segmentId: 'seg_1', startLine: 10, endLine: 12, text: '有效波高与风速字段说明。' },
  { segmentId: 'seg_2', startLine: 20, endLine: 24, text: '时间是逐小时，经纬度是网格中心。' },
  { segmentId: 'seg_3', startLine: 30, endLine: 31, text: '缺失率需要单独记录。' },
  { segmentId: 'seg_4', startLine: 40, endLine: 41, text: '样例数据覆盖 2024 年 1 月。' },
  { segmentId: 'seg_5', startLine: 50, endLine: 52, text: '浮标数据用于交叉验证。' },
  { segmentId: 'seg_6', startLine: 60, endLine: 62, text: '分辨率是 0.5 度。' },
]
const UNCONFIRMED_SEGMENT = { segmentId: 'seg_pending', startLine: 70, endLine: 72, text: '尚未确认的片段。' }

const projectId = 'prj_chat_citations'
const materialId = 'mat_chat_citations'
let tempDir: string
let server: ReturnType<typeof createApp>
let baseUrl: string
let nextAnswer = ''
const warnings: Array<{ message: string; detail?: Record<string, unknown> }> = []

const logger: AdvisorLogger = {
  warn(message, detail) {
    warnings.push({ message, detail })
  },
}

const provider: AdvisorProvider = {
  name: 'chat-citations-test',
  async generate() {
    throw new Error('not used')
  },
  async generateChat() {
    return { answer: nextAnswer }
  },
}

function seed(): ReturnType<typeof createV3Runtime> {
  tempDir = mkdtempSync(path.join(tmpdir(), 'advisor-chat-citations-'))
  const runtime = createV3Runtime({ databasePath: path.join(tempDir, 'v3.sqlite') })
  const db = runtime.getDb()
  const now = '2026-10-24T00:00:00.000Z'
  const userId = 'usr_chat_citations'

  db.prepare(
    `INSERT INTO users
       (user_id, account, account_normalized, display_name, password_hash, password_algo,
        status, role, revision, created_at, updated_at)
     VALUES (?, 'chatcite', 'chatcite', '引用测试', 'x', 'bcrypt', 'active', 'student', 1, ?, ?)`,
  ).run(userId, now, now)
  db.prepare(
    `INSERT INTO projects
       (project_id, owner_user_id, name, short, profile_json, status, visibility,
        project_revision, current_milestone_id, last_activity_at, created_at, updated_at,
        created_by_user_id)
     VALUES (?, ?, '聊天引用测试', '引用测试', '{}', 'active', 'private', 1, 'ms_chat', ?, ?, ?, ?)`,
  ).run(projectId, userId, now, now, now, userId)
  db.prepare(
    `INSERT INTO milestones
       (milestone_id, project_id, user_id, name, name_key, goal, done_criteria, due_at,
        status, order_index, source, revision, created_at, updated_at, completed_at,
        archived_at, archived_from_status, created_by_user_id)
     VALUES ('ms_chat', ?, ?, '数据获取与预处理', '数据获取与预处理', '拿到数据', '字段完整',
             NULL, 'active', 0, 'manual', 1, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(projectId, userId, now, now, userId)
  db.prepare(
    `INSERT INTO materials
       (material_id, material_version, project_id, user_id, name, type, size, encoding,
        status, revision, sha256, failure_reason, created_at, updated_at, archived_at,
        content_text)
     VALUES (?, 1, ?, ?, '实验手册.md', 'md', 100, 'utf-8', 'parsed', 1, NULL, NULL, ?, ?, NULL, '')`,
  ).run(materialId, projectId, userId, now, now)

  const insertSegment = db.prepare(
    `INSERT INTO material_segments
       (material_id, material_version, segment_id, idx, start_line, end_line, text,
        char_count, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  )
  CONFIRMED_SEGMENTS.forEach((segment, index) => {
    insertSegment.run(
      materialId,
      segment.segmentId,
      index,
      segment.startLine,
      segment.endLine,
      segment.text,
      [...segment.text].length,
      now,
    )
  })
  insertSegment.run(
    materialId,
    UNCONFIRMED_SEGMENT.segmentId,
    CONFIRMED_SEGMENTS.length,
    UNCONFIRMED_SEGMENT.startLine,
    UNCONFIRMED_SEGMENT.endLine,
    UNCONFIRMED_SEGMENT.text,
    [...UNCONFIRMED_SEGMENT.text].length,
    now,
  )

  const insertUnderstanding = db.prepare(
    `INSERT INTO understanding_items
       (item_id, client_item_id, project_id, material_id, material_version, kind, text,
        original_text, sources_json, status, source, revision, created_at, updated_at,
        confirmed_at, confirmed_by_user_id, removed_at)
     VALUES (?, NULL, ?, ?, 1, 'goalCandidates', '字段说明', '字段说明', ?, 'confirmed', 'ai', 1,
             ?, ?, ?, ?, NULL)`,
  )
  CONFIRMED_SEGMENTS.forEach((segment, index) => {
    insertUnderstanding.run(
      `uitem_${index}`,
      projectId,
      materialId,
      JSON.stringify([{ segmentId: segment.segmentId }]),
      now,
      now,
      now,
      userId,
    )
  })
  db.prepare(
    `INSERT INTO understanding_items
       (item_id, client_item_id, project_id, material_id, material_version, kind, text,
        original_text, sources_json, status, source, revision, created_at, updated_at,
        confirmed_at, confirmed_by_user_id, removed_at)
     VALUES ('uitem_pending', NULL, ?, ?, 1, 'goalCandidates', '待确认', '待确认', ?, 'pending', 'ai', 1,
             ?, ?, NULL, NULL, NULL)`,
  ).run(
    projectId,
    materialId,
    JSON.stringify([{ segmentId: UNCONFIRMED_SEGMENT.segmentId }]),
    now,
    now,
  )
  return runtime
}

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req_chat_citations',
    projectId,
    projectRevision: 1,
    projectName: '聊天引用测试',
    currentMilestone: '数据获取与预处理',
    tasks: [],
    evidence: [],
    doubts: [],
    chatHistory: [],
    question: '当前阶段下一步做什么？',
    promptVersion: 'advisor-chat-v3',
    milestoneContext: {
      milestoneId: 'ms_chat',
      currentMilestone: '数据获取与预处理',
      milestoneRevision: 1,
      milestoneGoal: '拿到数据',
      milestoneDoneCriteria: '字段完整',
      milestoneStatus: 'active',
      milestoneTasks: [],
      recentProgress: [],
      milestoneEvidence: [],
    },
    confirmedMaterials: [
      {
        materialId,
        name: '客户端伪造名称.md',
        type: 'md',
        version: 1,
        segments: CONFIRMED_SEGMENTS.map((segment) => ({
          segmentId: segment.segmentId,
          startLine: 999,
          endLine: 999,
          text: '客户端伪造正文',
        })),
      },
    ],
    ...overrides,
  }
}

async function postChat(overrides: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/advisor/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody(overrides)),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

before(async () => {
  const runtime = seed()
  server = createApp(config, {
    logger,
    v3Runtime: runtime,
    advisorService: createAdvisorService({
      provider,
      fallback: createRuleFallback(),
      logger,
    }),
  })
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://${address.address}:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  rmSync(tempDir, { recursive: true, force: true })
})

test('合法引用按数据库回填材料名、版本与行号', async () => {
  nextAnswer = '先核对字段说明。\n{"segmentIds":["m1:seg_1","m1:seg_2"]}'
  const { status, body } = await postChat()

  assert.equal(status, 200)
  assert.equal(body.source, 'model')
  const citations = body.citations as Array<Record<string, unknown>>
  assert.equal(citations.length, 2)
  assert.deepEqual(citations[0], {
    materialId,
    materialName: '实验手册.md',
    materialVersion: 1,
    segmentId: 'seg_1',
    startLine: 10,
    endLine: 12,
    itemId: null,
  })
  assert.equal(citations[1]?.startLine, 20)
  assert.equal(citations[1]?.endLine, 24)
  assert.equal(body.answer, '先核对字段说明。')
})

test('未知 segmentId 被剔除，answer 仍保留', async () => {
  nextAnswer = '这条回答仍然要保留。\n{"segmentIds":["m1:seg_missing"]}'
  const { status, body } = await postChat()

  assert.equal(status, 200)
  assert.equal(body.answer, '这条回答仍然要保留。')
  assert.deepEqual(body.citations, [])
  assert.ok(warnings.some((entry) => entry.message.includes('聊天引用未知或未确认')))
})

test('模型输出非法引用 JSON 时 citations=[] 且 answer 正常', async () => {
  nextAnswer = '解析失败也不能丢掉这条回答。\n{"segmentIds":["m1:seg_1"'
  const { status, body } = await postChat()

  assert.equal(status, 200)
  assert.equal(body.answer, '解析失败也不能丢掉这条回答。')
  assert.deepEqual(body.citations, [])
})

test('引用超过 5 条时截断到 5 条', async () => {
  nextAnswer = '最多只保留五条引用。\n{"segmentIds":["m1:seg_1","m1:seg_2","m1:seg_3","m1:seg_4","m1:seg_5","m1:seg_6"]}'
  const { status, body } = await postChat()

  assert.equal(status, 200)
  const citations = body.citations as Array<Record<string, unknown>>
  assert.equal(citations.length, 5)
  assert.deepEqual(citations.map((item) => item.segmentId), ['seg_1', 'seg_2', 'seg_3', 'seg_4', 'seg_5'])
})

test('引用指向未确认片段时被剔除，answer 仍保留', async () => {
  nextAnswer = '未确认片段不能作为依据。\n{"segmentIds":["m1:seg_pending"]}'
  const { status, body } = await postChat()

  assert.equal(status, 200)
  assert.equal(body.answer, '未确认片段不能作为依据。')
  assert.deepEqual(body.citations, [])
  assert.ok(warnings.some((entry) => entry.message.includes('聊天引用未知或未确认')))
})
