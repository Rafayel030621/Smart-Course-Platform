import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TestClient,
  createTestClient,
  registerUser,
  uuid,
  type LoggedInUser,
} from './v3-support.js'

/**
 * 本地项目迁移（契约第 24 节）
 */

let client: TestClient
let user: LoggedInUser
let otherUser: LoggedInUser

before(async () => {
  client = await createTestClient()
  user = await registerUser(client, { account: 'migrator_2026' })
  otherUser = await registerUser(client, { account: 'other_2026' })
})

after(async () => {
  await client.close()
})

function migrationId(): string {
  return `mig_${uuid().replace(/-/g, '').slice(0, 24)}`
}

function clientProjectId(): string {
  return `prj_local_${uuid().replace(/-/g, '').slice(0, 16)}`
}

function migrationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: `migrate-${uuid().slice(0, 22)}`,
    migrationId: migrationId(),
    userConfirmed: true,
    userConfirmedAt: new Date().toISOString(),
    source: {
      schemaVersion: 3,
      clientProjectId: clientProjectId(),
      appVersion: 'v2.2',
      exportedAt: new Date().toISOString(),
    },
    localProject: {
      name: '迁移项目',
      short: '迁移',
      projectRevision: 12,
      profile: {
        goal: '迁移目标',
        expectedOutcome: '迁移结果',
        memberNames: ['张同学'],
        researchPeriod: '第 3 周',
        scope: '范围',
        outOfScope: '不做实时系统',
      },
      milestones: [
        {
          clientId: 'ms_local_1',
          name: '数据获取',
          goal: '拿到样例数据',
          doneCriteria: '样例可下载',
          dueAt: null,
          status: 'active',
          orderIndex: 0,
        },
      ],
      tasks: [
        {
          clientId: 'tsk_local_1',
          milestoneClientId: 'ms_local_1',
          title: '下载数据',
          doneCriteria: '能读出变量',
          status: 'doing',
          createdAt: '2026-10-15T08:00:00.000Z',
          updatedAt: '2026-10-18T09:20:00.000Z',
        },
      ],
      evidence: [
        {
          clientId: 'evd_local_1',
          submissionId: 'submission-migrate-1',
          taskClientId: 'tsk_local_1',
          milestoneClientId: 'ms_local_1',
          didWhat: '下载了样例数据',
          foundWhat: '字段完整',
          stillUnsure: '分辨率',
          attachmentName: null,
          createdAt: '2026-10-19T02:30:00.000Z',
        },
      ],
      progress: [
        {
          clientId: 'prg_local_1',
          summary: '完成样例下载',
          milestoneClientId: 'ms_local_1',
          taskClientId: 'tsk_local_1',
          occurredAt: '2026-10-19T02:20:00.000Z',
        },
      ],
      doubts: [
        {
          clientId: 'dbt_local_1',
          text: '分辨率是否足够',
          status: 'open',
          sourceEvidenceClientId: 'evd_local_1',
          createdAt: '2026-10-19T02:30:00.000Z',
        },
      ],
      materials: [
        {
          clientId: 'mat_local_1',
          name: '实验手册.md',
          type: 'md',
          size: 2048,
          encoding: 'utf-8',
          status: 'parsed',
          version: 1,
          createdAt: '2026-10-15T08:00:00.000Z',
          updatedAt: '2026-10-15T08:00:00.000Z',
          segments: [
            { segmentId: 'seg_0', index: 0, startLine: 1, endLine: 8, text: '# 实验手册\n使用 ERA5 数据。' },
          ],
          understandingItems: [
            {
              clientId: 'cnd_local_1',
              clientItemId: 'cnd_goal_0',
              kind: 'goalCandidates',
              text: '使用 ERA5 数据复现流程',
              originalText: '使用 ERA5 数据复现流程',
              sourceSegmentIds: ['seg_0'],
              status: 'confirmed',
            },
            {
              clientId: 'cnd_local_2',
              clientItemId: 'cnd_goal_1',
              kind: 'goalCandidates',
              text: '待确认条目',
              originalText: '待确认条目',
              sourceSegmentIds: ['seg_0'],
              status: 'pending',
            },
          ],
        },
        {
          clientId: 'mat_local_2',
          name: '数据表.xlsx',
          type: 'xlsx',
          size: 1024,
          encoding: 'utf-8',
          status: 'parsed',
          version: 1,
          createdAt: '2026-10-15T08:00:00.000Z',
          updatedAt: '2026-10-15T08:00:00.000Z',
          segments: [],
          understandingItems: [],
        },
      ],
      chats: [
        { clientId: 'msg_local_1', role: 'user', text: '我下一步做什么？' },
        { clientId: 'msg_local_2', role: 'assistant', text: '先完成数据下载。', source: 'model' },
      ],
    },
    ...overrides,
  }
}

async function migrate(
  body: Record<string, unknown>,
  cookie = user.cookie,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await client.request('/api/projects/migrate-local', {
    method: 'POST',
    cookie,
    body,
  })
  return { response, body: (await response.json()) as Record<string, unknown> }
}

function projectCount(): number {
  return (
    client.runtime.getDb().prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }
  ).count
}

test('迁移成功：单事务写入全部实体，返回 idMap、counts 与警告', async () => {
  const before = projectCount()
  const payload = migrationPayload()
  const { response, body } = await migrate(payload)

  assert.equal(response.status, 200)
  assert.equal(body.contractVersion, '3.0')
  assert.equal(body.status, 'completed')
  assert.equal(body.replayed, false)
  assert.equal(body.deduplicated, false)
  assert.equal(body.appliedChanges, true)
  assert.equal(body.projectRevision, 1)

  const counts = body.counts as Record<string, number>
  assert.deepEqual(counts, {
    milestones: 1,
    tasks: 1,
    evidence: 1,
    progress: 1,
    materials: 2,
    materialSegments: 1,
    understandingItems: 2,
    doubts: 1,
    chatMessages: 2,
  })

  const idMap = body.idMap as Record<string, Record<string, string>>
  assert.match(idMap.milestones.ms_local_1 as string, /^ms_/)
  assert.match(idMap.tasks.tsk_local_1 as string, /^tsk_/)
  assert.match(idMap.materials.mat_local_1 as string, /^mat_/)

  const warnings = body.warnings as Array<{ code: string }>
  assert.equal(warnings.some((item) => item.code === 'UNSUPPORTED_MATERIAL_SKIPPED'), true)
  assert.equal(projectCount(), before + 1)

  const project = await client.request(`/api/projects/${body.projectId as string}`, {
    cookie: user.cookie,
  })
  const projectBody = (await project.json()) as {
    data: { project: { milestones: Array<{ status: string; taskStats: { total: number } }>; taskStats: { total: number } } }
  }
  assert.equal(projectBody.data.project.taskStats.total, 1)
  assert.equal(projectBody.data.project.milestones[0]?.taskStats.total, 1)
  assert.equal(projectBody.data.project.milestones[0]?.status, 'active')

  const db = client.runtime.getDb()
  const unsupported = db
    .prepare("SELECT status, type FROM materials WHERE name = '数据表.xlsx'")
    .get() as { status: string; type: string }
  assert.equal(unsupported.status, 'unsupported')
  assert.equal(unsupported.type, 'xlsx')

  const confirmed = db
    .prepare("SELECT status FROM understanding_items WHERE text = '使用 ERA5 数据复现流程'")
    .get() as { status: string }
  assert.equal(confirmed.status, 'confirmed')
  const pending = db
    .prepare("SELECT status FROM understanding_items WHERE text = '待确认条目'")
    .get() as { status: string }
  assert.equal(pending.status, 'pending')
})

test('同一 migrationId 相同请求体重放，不创建第二个项目；不同内容返回冲突', async () => {
  const payload = migrationPayload()
  const first = await migrate(payload)
  const before = projectCount()

  const second = await migrate(payload)
  assert.equal(second.response.status, 200)
  assert.equal(second.body.replayed, true)
  assert.equal(second.body.projectId, first.body.projectId)
  assert.equal(projectCount(), before)

  const conflict = await migrate({
    ...payload,
    localProject: { ...(payload.localProject as Record<string, unknown>), name: '改名后的项目' },
  })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(projectCount(), before)
})

test('同一 clientProjectId 不同 migrationId 去重，返回已有项目', async () => {
  const payload = migrationPayload()
  const first = await migrate(payload)
  const before = projectCount()

  const second = await migrate({
    ...payload,
    requestId: uuid(),
    idempotencyKey: `migrate-${uuid().slice(0, 22)}`,
    migrationId: migrationId(),
  })
  assert.equal(second.response.status, 200)
  assert.equal(second.body.deduplicated, true)
  assert.equal(second.body.appliedChanges, false)
  assert.equal(second.body.projectId, first.body.projectId)
  assert.equal(projectCount(), before)
  const warnings = second.body.warnings as Array<{ code: string }>
  assert.equal(warnings.some((item) => item.code === 'LOCAL_CHANGES_NOT_APPLIED'), true)
})

test('迁移失败完全回滚：重复 submissionId 不产生半迁移项目', async () => {
  const payload = migrationPayload()
  const local = payload.localProject as Record<string, unknown>
  const evidence = local.evidence as Array<Record<string, unknown>>
  evidence.push({
    ...(evidence[0] as Record<string, unknown>),
    clientId: 'evd_local_duplicate',
  })

  const before = projectCount()
  const { response, body } = await migrate(payload)
  assert.notEqual(response.status, 200)
  assert.equal(body.code, 'MIGRATION_INVALID_DATA')
  assert.equal(projectCount(), before)
})

test('未确认或确认过期拒绝迁移', async () => {
  const notConfirmed = await migrate(migrationPayload({ userConfirmed: false }))
  assert.equal(notConfirmed.response.status, 400)
  assert.equal(notConfirmed.body.code, 'MIGRATION_NOT_CONFIRMED')

  const expired = await migrate(
    migrationPayload({ userConfirmedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() }),
  )
  assert.equal(expired.response.status, 400)
  assert.equal(expired.body.code, 'MIGRATION_CONFIRMATION_EXPIRED')
})

test('schemaVersion 过高或缺失返回对应错误', async () => {
  const tooNew = migrationPayload({
    source: { schemaVersion: 4, clientProjectId: clientProjectId() },
  })
  const high = await migrate(tooNew)
  assert.equal(high.response.status, 409)
  assert.equal(high.body.code, 'MIGRATION_VERSION_UNSUPPORTED')

  const outdated = migrationPayload({
    source: { schemaVersion: 0, clientProjectId: clientProjectId() },
  })
  const low = await migrate(outdated)
  assert.equal(low.response.status, 409)
  assert.equal(low.body.code, 'MIGRATION_DATA_OUTDATED')
})

test('缺失进展字段时不从证据或聊天推测生成进展', async () => {
  const payload = migrationPayload()
  const local = payload.localProject as Record<string, unknown>
  delete local.progress
  const { response, body } = await migrate(payload)
  assert.equal(response.status, 200)
  assert.equal((body.counts as Record<string, number>).progress, 0)
})

test('迁移状态查询只对当前用户可见', async () => {
  const payload = migrationPayload()
  const { body } = await migrate(payload)

  const own = await client.request(`/api/projects/migrations/${payload.migrationId as string}`, {
    cookie: user.cookie,
  })
  const ownBody = (await own.json()) as Record<string, unknown>
  assert.equal(own.status, 200)
  assert.equal(ownBody.projectId, body.projectId)
  assert.equal(ownBody.status, 'completed')

  const other = await client.request(`/api/projects/migrations/${payload.migrationId as string}`, {
    cookie: otherUser.cookie,
  })
  assert.equal(other.status, 404)
  assert.equal(((await other.json()) as { code: string }).code, 'RESOURCE_NOT_FOUND')
})
