import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../src/index.js'
import type { AdvisorService } from '../src/advisor/service.js'
import { silentLogger, type AdvisorChatRequest, type AdvisorRequest } from '../src/advisor/types.js'
import type { ServerConfig } from '../src/config.js'
import { createV3Runtime } from '../src/v3/runtime.js'

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  serviceName: 'course-platform-api',
  contractVersion: '1.0',
}

const now = '2026-10-20T00:00:00.000Z'

let calls = 0
const service: AdvisorService = {
  providerName: 'spy',
  timeoutMs: 1000,
  async recommend(_request: AdvisorRequest) {
    calls += 1
    return {
      ok: true,
      source: 'model',
      fallbackReason: null,
      cached: false,
      suggestions: [
        {
          title: '核对数据字段',
          whyNow: '当前阶段需要确认字段口径',
          doneCriteria: '写出一页字段说明',
          existingTaskId: null,
          basisEvidenceIds: [],
          basisDoubtIds: [],
          basisMaterialRefs: [],
        },
      ],
    }
  },
  async chat(_request: AdvisorChatRequest) {
    calls += 1
    return {
      ok: true,
      source: 'model',
      fallbackReason: null,
      answer: '先核对字段口径。',
    }
  },
}

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestoneId: 'ms_a',
    currentMilestone: '阶段 A',
    milestoneRevision: 3,
    milestoneGoal: '完成阶段 A',
    milestoneDoneCriteria: '交付物齐全',
    milestoneStatus: 'active',
    milestoneTasks: [
      {
        taskId: 'tsk_a',
        title: '任务 A',
        status: 'done',
        doneCriteria: '能验证',
        owner: null,
        milestone: '阶段 A',
        updatedAt: now,
      },
    ],
    recentProgress: [
      {
        progressId: 'prg_a',
        summary: '完成 A',
        milestoneId: 'ms_a',
        taskId: 'tsk_a',
        occurredAt: now,
      },
    ],
    milestoneEvidence: [
      {
        evidenceId: 'evd_a',
        submissionId: 'sub_a',
        taskId: 'tsk_a',
        didWhat: '下载 A',
        foundWhat: '字段完整',
        stillUnsure: null,
        author: null,
        createdAt: now,
      },
    ],
    ...overrides,
  }
}

function recommendationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req_boundary_rec',
    projectId: 'prj_a',
    projectRevision: 5,
    projectName: '边界测试项目',
    currentMilestone: '阶段 A',
    confirmedContext: [],
    tasks: [],
    evidence: [],
    doubts: [],
    promptVersion: 'mvp-prompt-v3',
    forceRefresh: false,
    milestoneContext: context(),
    ...overrides,
  }
}

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'req_boundary_chat',
    projectId: 'prj_a',
    projectRevision: 5,
    projectName: '边界测试项目',
    currentMilestone: '阶段 A',
    tasks: [],
    evidence: [],
    doubts: [],
    chatHistory: [],
    question: '下一步做什么？',
    promptVersion: 'advisor-chat-v3',
    milestoneContext: context(),
    ...overrides,
  }
}

function seed(runtime: ReturnType<typeof createV3Runtime>): void {
  const db = runtime.getDb()
  const user = 'usr_boundary'
  db.prepare(
    `INSERT INTO users
       (user_id, account, account_normalized, display_name, password_hash, password_algo,
        status, role, revision, created_at, updated_at)
     VALUES (?, 'boundary', 'boundary', '边界测试', 'x', 'bcrypt', 'active', 'student', 1, ?, ?)`,
  ).run(user, now, now)

  const insertProject = db.prepare(
    `INSERT INTO projects
       (project_id, owner_user_id, name, short, profile_json, status, visibility,
        project_revision, current_milestone_id, last_activity_at, created_at, updated_at,
        created_by_user_id)
     VALUES (?, ?, ?, ?, '{}', 'active', 'private', 5, ?, ?, ?, ?, ?)`,
  )
  insertProject.run('prj_a', user, '项目 A', 'A', 'ms_a', now, now, now, user)
  insertProject.run('prj_b', user, '项目 B', 'B', 'ms_b', now, now, now, user)

  const insertMilestone = db.prepare(
    `INSERT INTO milestones
       (milestone_id, project_id, user_id, name, name_key, goal, done_criteria, due_at,
        status, order_index, source, revision, created_at, updated_at, completed_at,
        archived_at, archived_from_status, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, '目标', '标准', NULL, 'active', 0, 'manual', 1, ?, ?, NULL,
             ?, NULL, ?)`,
  )
  insertMilestone.run('ms_a', 'prj_a', user, '阶段 A', '阶段 A', now, now, null, user)
  insertMilestone.run('ms_b', 'prj_b', user, '阶段 B', '阶段 B', now, now, null, user)
  insertMilestone.run('ms_archived', 'prj_a', user, '归档阶段', '归档阶段', now, now, now, user)

  const insertTask = db.prepare(
    `INSERT INTO tasks
       (task_id, project_id, milestone_id, user_id, title, done_criteria, status,
        assignee_user_id, order_index, source, revision, created_at, updated_at,
        started_at, completed_at, archived_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, '能验证', 'todo', NULL, 0, 'manual', 1, ?, ?, NULL, NULL, NULL, ?)`,
  )
  insertTask.run('tsk_a', 'prj_a', 'ms_a', user, '任务 A', now, now, user)
  insertTask.run('tsk_b', 'prj_b', 'ms_b', user, '任务 B', now, now, user)

  const insertEvidence = db.prepare(
    `INSERT INTO evidence
       (evidence_id, project_id, task_id, milestone_id, milestone_name_snapshot, user_id,
        submission_id, did_what, found_what, still_unsure, attachment_name, status,
        author_user_id, revision, created_at, updated_at, redacted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '做了什么', '发现了什么', NULL, NULL, 'active', ?, 1, ?, ?, NULL)`,
  )
  insertEvidence.run('evd_a', 'prj_a', 'tsk_a', 'ms_a', '阶段 A', user, 'sub_a', user, now, now)
  insertEvidence.run(
    'evd_wrong_stage',
    'prj_a',
    'tsk_a',
    'ms_b',
    '阶段 B',
    user,
    'sub_wrong_stage',
    user,
    now,
    now,
  )

  const insertProgress = db.prepare(
    `INSERT INTO progress_records
       (progress_id, project_id, milestone_id, task_id, user_id, summary, evidence_ids_json,
        occurred_at, status, supersedes_progress_id, author_user_id, revision,
        created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, '完成了什么', '[]', ?, 'active', NULL, ?, 1, ?, ?, NULL)`,
  )
  insertProgress.run('prg_a', 'prj_a', 'ms_a', 'tsk_a', user, now, user, now, now)
  insertProgress.run('prg_b', 'prj_b', 'ms_b', 'tsk_b', user, now, user, now, now)
}

let server: ReturnType<typeof createApp>
let baseUrl: string
let tempDir: string

before(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'advisor-v3-boundaries-'))
  const runtime = createV3Runtime({ databasePath: path.join(tempDir, 'v3.sqlite') })
  seed(runtime)
  server = createApp(config, {
    logger: silentLogger,
    v3Runtime: runtime,
    advisorService: service,
  })
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://${address.address}:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  rmSync(tempDir, { recursive: true, force: true })
})

async function post(
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function expectBoundaryFailure(payload: Record<string, unknown>): Promise<void> {
  calls = 0
  const result = await post('/api/advisor/recommendations', payload)
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'INVALID_INPUT')
  assert.equal(calls, 0, '边界校验失败时不得调用模型')
}

describe('契约 23.2 项目级边界', () => {
  test('任务跨项目：400 INVALID_INPUT，不调用模型', async () => {
    await expectBoundaryFailure(
      recommendationBody({
        milestoneContext: context({
          milestoneTasks: [
            {
              taskId: 'tsk_b',
              title: '任务 B',
              status: 'todo',
              doneCriteria: '能验证',
              owner: null,
              milestone: '阶段 B',
              updatedAt: now,
            },
          ],
        }),
      }),
    )
  })

  test('证据跨阶段：400 INVALID_INPUT，不调用模型', async () => {
    await expectBoundaryFailure(
      recommendationBody({
        milestoneContext: context({
          milestoneEvidence: [
            {
              evidenceId: 'evd_wrong_stage',
              submissionId: 'sub_wrong_stage',
              taskId: 'tsk_a',
              didWhat: '做了什么',
              foundWhat: '发现了什么',
              stillUnsure: null,
              author: null,
              createdAt: now,
            },
          ],
        }),
      }),
    )
  })

  test('进展跨项目：400 INVALID_INPUT，不调用模型', async () => {
    await expectBoundaryFailure(
      recommendationBody({
        milestoneContext: context({
          recentProgress: [
            {
              progressId: 'prg_b',
              summary: 'B 的进展',
              milestoneId: 'ms_b',
              taskId: 'tsk_b',
              occurredAt: now,
            },
          ],
        }),
      }),
    )
  })

  test('归档阶段：400 INVALID_INPUT，不调用模型', async () => {
    await expectBoundaryFailure(
      recommendationBody({
        currentMilestone: '归档阶段',
        milestoneContext: context({
          milestoneId: 'ms_archived',
          currentMilestone: '归档阶段',
          milestoneTasks: [],
          recentProgress: [],
          milestoneEvidence: [],
        }),
      }),
    )
  })

  test('全部合法：200，调用模型一次', async () => {
    calls = 0
    const result = await post('/api/advisor/recommendations', recommendationBody())
    assert.equal(result.status, 200)
    assert.equal(calls, 1)
  })
})

describe('契约 23.6 / 23.7 v3 响应字段', () => {
  test('建议 v3 每条 suggestion 带 basisMaterialRefs=[]', async () => {
    const result = await post('/api/advisor/recommendations', recommendationBody())
    assert.equal(result.status, 200)
    const suggestions = result.body.suggestions as Array<Record<string, unknown>>
    assert.deepEqual(suggestions[0]?.basisMaterialRefs, [])
  })

  test('聊天 v3 带 milestoneRevision 与 citations=[]', async () => {
    const result = await post('/api/advisor/chat', chatBody())
    assert.equal(result.status, 200)
    assert.equal(result.body.milestoneRevision, 3)
    assert.deepEqual(result.body.citations, [])
  })

  test('建议/聊天 v2 不出现 v3 响应字段', async () => {
    const recommendation = await post(
      '/api/advisor/recommendations',
      recommendationBody({ promptVersion: 'mvp-prompt-v2', milestoneContext: undefined }),
    )
    assert.equal(recommendation.status, 200)
    const suggestions = recommendation.body.suggestions as Array<Record<string, unknown>>
    assert.equal('basisMaterialRefs' in (suggestions[0] ?? {}), false)
    assert.equal('milestoneRevision' in recommendation.body, false)

    const chat = await post(
      '/api/advisor/chat',
      chatBody({ promptVersion: 'advisor-chat-v2', milestoneContext: undefined }),
    )
    assert.equal(chat.status, 200)
    assert.equal('milestoneRevision' in chat.body, false)
    assert.equal('citations' in chat.body, false)
  })
})
