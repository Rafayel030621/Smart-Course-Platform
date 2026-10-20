import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TestClient,
  createProject,
  createTestClient,
  envelope,
  registerUser,
  type LoggedInUser,
} from './v3-support.js'

/**
 * 加固包：
 * - 归档项目写保护
 * - 项目级 readOnly
 * - 片段读取的 projectId 维度
 */

let client: TestClient
let user: LoggedInUser

before(async () => {
  client = await createTestClient()
  user = await registerUser(client, { account: `archive_hard_${Date.now()}` })
})

after(async () => {
  await client.close()
})

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

function seedMilestone(projectId: string, milestoneId: string, name: string): void {
  const now = '2026-10-01T00:00:00.000Z'
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO milestones
         (milestone_id, project_id, user_id, name, name_key, goal, done_criteria, due_at,
          status, order_index, source, revision, created_at, updated_at, completed_at,
          archived_at, archived_from_status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'active', 0, 'manual', 1, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(milestoneId, projectId, user.userId, name, name.toLowerCase(), now, now, user.userId)
}

function seedTask(projectId: string, taskId: string, milestoneId: string): void {
  const now = '2026-10-01T00:00:00.000Z'
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO tasks
         (task_id, project_id, milestone_id, user_id, title, done_criteria, status,
          assignee_user_id, order_index, source, revision, created_at, updated_at,
          started_at, completed_at, archived_at, created_by_user_id)
       VALUES (?, ?, ?, ?, '归档保护任务', NULL, 'todo', NULL, 0, 'manual', 1, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(taskId, projectId, milestoneId, user.userId, now, now, user.userId)
}

function seedMaterial(
  projectId: string,
  materialId: string,
  version = 1,
  segmentId = 'seg_hard',
): void {
  const now = '2026-10-01T00:00:00.000Z'
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO materials
         (material_id, material_version, project_id, user_id, name, type, size, encoding,
          status, revision, sha256, failure_reason, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, '加固材料.md', 'md', 100, 'utf-8', 'parsed', 1, NULL, NULL, ?, ?, NULL)`,
    )
    .run(materialId, version, projectId, user.userId, now, now)
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO material_segments
         (material_id, material_version, segment_id, idx, start_line, end_line, text, char_count, created_at)
       VALUES (?, ?, ?, 0, 1, 2, '真实片段', 4, ?)`,
    )
    .run(materialId, version, segmentId, now)
}

function seedItem(projectId: string, materialId: string, itemId: string): void {
  const now = '2026-10-01T00:00:00.000Z'
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO understanding_items
         (item_id, client_item_id, project_id, material_id, material_version, kind, text,
          original_text, sources_json, status, source, revision, created_at, updated_at,
          confirmed_at, confirmed_by_user_id, removed_at)
       VALUES (?, NULL, ?, ?, 1, 'goalCandidates', '加固条目', '加固条目',
               '[{"segmentId":"seg_hard","materialId":"forged","materialVersion":99,"startLine":999}]',
               'pending', 'migration', 1, ?, ?, NULL, NULL, NULL)`,
    )
    .run(itemId, projectId, materialId, now, now)
}

function seedEvidence(projectId: string, evidenceId: string): void {
  const now = '2026-10-01T00:00:00.000Z'
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO evidence
         (evidence_id, project_id, task_id, milestone_id, milestone_name_snapshot, user_id,
          submission_id, did_what, found_what, still_unsure, attachment_name, status,
          author_user_id, revision, created_at, updated_at, redacted_at)
       VALUES (?, ?, NULL, NULL, NULL, ?, 'sub_hardening_01', '加固证据', NULL, NULL, NULL,
               'active', ?, 1, ?, ?, NULL)`,
    )
    .run(evidenceId, projectId, user.userId, user.userId, now, now)
}

function seedProgress(projectId: string, progressId: string): void {
  const now = '2026-10-01T00:00:00.000Z'
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO progress_records
         (progress_id, project_id, milestone_id, task_id, user_id, summary, evidence_ids_json,
          occurred_at, status, supersedes_progress_id, author_user_id, revision,
          created_at, updated_at, archived_at)
       VALUES (?, ?, NULL, NULL, ?, '加固进展', '[]', ?, 'active', NULL, ?, 1, ?, ?, NULL)`,
    )
    .run(progressId, projectId, user.userId, now, user.userId, now, now)
}

async function archiveProject(projectId: string, revision: number): Promise<number> {
  const response = await client.request(`/api/projects/${projectId}/archive`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, revision),
  })
  assert.equal(response.status, 200)
  return ((await response.json()) as { projectRevision: number }).projectRevision
}

test('归档项目所有领域写接口返回 PROJECT_ARCHIVED，读取仍可用，restore 例外', async () => {
  const project = await createProject(client, user, { name: '归档写保护项目' })
  const projectId = project.projectId
  seedMilestone(projectId, 'ms_hard', '加固阶段')
  seedTask(projectId, 'tsk_hard', 'ms_hard')
  seedMaterial(projectId, 'mat_hard')
  seedItem(projectId, 'mat_hard', 'cnd_hard')
  seedEvidence(projectId, 'evd_hard')
  seedProgress(projectId, 'prg_hard')

  const archivedRevision = await archiveProject(projectId, project.projectRevision)
  const idempotencyAfterArchive = (
    client.runtime.getDb().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as {
      count: number
    }
  ).count

  const base = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    envelope(projectId, archivedRevision, extra)
  const draftBase = (itemId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    contractVersion: '3.0',
    requestId: '7d5c2e0f-3a1b-4c8d-9e6f-2b4a8c1d5e70',
    idempotencyKey: `draft-hard-${Math.random().toString(36).slice(2, 12)}`,
    projectId,
    projectRevision: archivedRevision,
    materialVersion: 1,
    itemId,
    expectedRevision: 1,
    ...extra,
  })

  const requests: Array<{ name: string; method: string; path: string; body: Record<string, unknown> }> = [
    {
      name: '项目编辑',
      method: 'PATCH',
      path: `/api/projects/${projectId}`,
      body: base({ name: '不应保存的新名字' }),
    },
    {
      name: '项目再次归档',
      method: 'POST',
      path: `/api/projects/${projectId}/archive`,
      body: base(),
    },
    {
      name: '阶段创建',
      method: 'POST',
      path: `/api/projects/${projectId}/milestones`,
      body: base({ name: '不应创建的阶段' }),
    },
    {
      name: '阶段编辑',
      method: 'PATCH',
      path: `/api/projects/${projectId}/milestones/ms_hard`,
      body: base({ expectedRevision: 1, goal: '不应保存' }),
    },
    {
      name: '阶段完成',
      method: 'POST',
      path: `/api/projects/${projectId}/milestones/ms_hard/complete`,
      body: base({ expectedRevision: 1 }),
    },
    {
      name: '阶段恢复',
      method: 'POST',
      path: `/api/projects/${projectId}/milestones/ms_hard/restore`,
      body: base({ expectedRevision: 1 }),
    },
    {
      name: '任务创建',
      method: 'POST',
      path: `/api/projects/${projectId}/tasks`,
      body: base({ title: '不应创建的任务' }),
    },
    {
      name: '任务编辑',
      method: 'PATCH',
      path: `/api/projects/${projectId}/tasks/tsk_hard`,
      body: base({ expectedRevision: 1, title: '不应改名' }),
    },
    {
      name: '任务开始',
      method: 'POST',
      path: `/api/projects/${projectId}/tasks/tsk_hard/start`,
      body: base({ expectedRevision: 1 }),
    },
    {
      name: '任务关联阶段',
      method: 'POST',
      path: `/api/projects/${projectId}/tasks/tsk_hard/link-milestone`,
      body: base({ expectedRevision: 1, milestoneId: null }),
    },
    {
      name: '证据创建',
      method: 'POST',
      path: `/api/projects/${projectId}/evidence`,
      body: base({ taskId: null, milestoneId: null, didWhat: '不应写入证据' }),
    },
    {
      name: '证据关联',
      method: 'POST',
      path: `/api/projects/${projectId}/evidence/evd_hard/links`,
      body: base({ expectedRevision: 1, taskId: null, milestoneId: null }),
    },
    {
      name: '进展创建',
      method: 'POST',
      path: `/api/projects/${projectId}/progress`,
      body: base({ summary: '不应写入进展' }),
    },
    {
      name: '进展更正',
      method: 'POST',
      path: `/api/projects/${projectId}/progress/prg_hard/supersede`,
      body: base({ expectedRevision: 1, summary: '不应更正' }),
    },
    {
      name: '草稿确认',
      method: 'POST',
      path: `/api/projects/${projectId}/materials/mat_hard/understanding/items/cnd_hard/confirm`,
      body: draftBase('cnd_hard'),
    },
    {
      name: '草稿编辑',
      method: 'PATCH',
      path: `/api/projects/${projectId}/materials/mat_hard/understanding/items/cnd_hard`,
      body: draftBase('cnd_hard', { text: '不应修改' }),
    },
    {
      name: '草稿移除',
      method: 'POST',
      path: `/api/projects/${projectId}/materials/mat_hard/understanding/items/cnd_hard/remove`,
      body: draftBase('cnd_hard'),
    },
    {
      name: '草稿撤销',
      method: 'POST',
      path: `/api/projects/${projectId}/materials/mat_hard/understanding/items/cnd_hard/undo`,
      body: draftBase('cnd_hard'),
    },
    {
      name: '整份确认',
      method: 'POST',
      path: `/api/projects/${projectId}/materials/mat_hard/understanding/confirm-all`,
      body: draftBase('cnd_hard', { items: [{ itemId: 'cnd_hard', expectedRevision: 1 }] }),
    },
  ]

  for (const request of requests) {
    const response = await client.request(request.path, {
      method: request.method,
      cookie: user.cookie,
      body: request.body,
    })
    assert.equal(response.status, 409, request.name)
    const body = await jsonOf(response)
    assert.equal(body.code, 'PROJECT_ARCHIVED', request.name)
    assert.equal(body.message, '项目已归档，请先恢复再编辑', request.name)
  }

  const db = client.runtime.getDb()
  assert.equal(
    (db.prepare('SELECT name FROM projects WHERE project_id = ?').get(projectId) as { name: string }).name,
    '归档写保护项目',
  )
  const task = db.prepare('SELECT status, revision FROM tasks WHERE task_id = ?').get('tsk_hard') as {
    status: string
    revision: number
  }
  assert.equal(task.status, 'todo')
  assert.equal(task.revision, 1)
  const item = db
    .prepare('SELECT status, revision FROM understanding_items WHERE item_id = ?')
    .get('cnd_hard') as { status: string; revision: number }
  assert.equal(item.status, 'pending')
  assert.equal(item.revision, 1)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM evidence WHERE project_id = ?').get(projectId) as { count: number }).count,
    1,
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM progress_records WHERE project_id = ?').get(projectId) as { count: number }).count,
    1,
  )
  assert.equal(
    (db.prepare('SELECT project_revision FROM projects WHERE project_id = ?').get(projectId) as { project_revision: number }).project_revision,
    archivedRevision,
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count,
    idempotencyAfterArchive,
  )

  for (const path of [
    `/api/projects/${projectId}`,
    `/api/projects/${projectId}/milestones`,
    `/api/projects/${projectId}/tasks`,
    `/api/projects/${projectId}/materials`,
    `/api/projects/${projectId}/materials/mat_hard`,
    `/api/projects/${projectId}/materials/mat_hard/segments`,
    `/api/projects/${projectId}/materials/mat_hard/understanding`,
  ]) {
    const response = await client.request(path, { cookie: user.cookie })
    assert.equal(response.status, 200, path)
  }

  const restore = await client.request(`/api/projects/${projectId}/restore`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, archivedRevision),
  })
  assert.equal(restore.status, 200)
  const restored = (await restore.json()) as { projectRevision: number }
  const createAfterRestore = await client.request(`/api/projects/${projectId}/tasks`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, restored.projectRevision, { title: '恢复后可创建' }),
  })
  assert.equal(createAfterRestore.status, 200)
})

test('归档项目 delete 例外；归档项目材料读取 readOnly=true 且 isCurrent=true', async () => {
  const project = await createProject(client, user, { name: '归档只读项目' })
  const projectId = project.projectId
  seedMaterial(projectId, 'mat_readonly')
  seedItem(projectId, 'mat_readonly', 'cnd_readonly')
  const archivedRevision = await archiveProject(projectId, project.projectRevision)

  const materials = await client.request(`/api/projects/${projectId}/materials`, {
    cookie: user.cookie,
  })
  const materialsBody = (await materials.json()) as {
    data: { materials: Array<{ materialId: string; readOnly: boolean; isCurrent: boolean }> }
  }
  const listed = materialsBody.data.materials.find((item) => item.materialId === 'mat_readonly')
  assert.equal(listed?.readOnly, true)
  assert.equal(listed?.isCurrent, true)

  const material = await client.request(
    `/api/projects/${projectId}/materials/mat_readonly`,
    { cookie: user.cookie },
  )
  const materialBody = (await material.json()) as {
    data: { material: { readOnly: boolean; isCurrent: boolean } }
  }
  assert.equal(materialBody.data.material.readOnly, true)
  assert.equal(materialBody.data.material.isCurrent, true)

  const segments = await client.request(
    `/api/projects/${projectId}/materials/mat_readonly/segments`,
    { cookie: user.cookie },
  )
  const segmentsBody = (await segments.json()) as {
    data: { readOnly: boolean; isCurrent: boolean }
  }
  assert.equal(segmentsBody.data.readOnly, true)
  assert.equal(segmentsBody.data.isCurrent, true)

  const understanding = await client.request(
    `/api/projects/${projectId}/materials/mat_readonly/understanding`,
    { cookie: user.cookie },
  )
  const understandingBody = (await understanding.json()) as {
    data: { readOnly: boolean; isCurrent: boolean }
  }
  assert.equal(understandingBody.data.readOnly, true)
  assert.equal(understandingBody.data.isCurrent, true)
  assert.equal(
    (
      client.runtime
        .getDb()
        .prepare('SELECT project_revision FROM projects WHERE project_id = ?')
        .get(projectId) as { project_revision: number }
    ).project_revision,
    archivedRevision,
  )

  const remove = await client.request(`/api/projects/${projectId}/delete`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, archivedRevision),
  })
  assert.equal(remove.status, 200)
  const readDeleted = await client.request(`/api/projects/${projectId}`, {
    cookie: user.cookie,
  })
  assert.equal(readDeleted.status, 404)
})

test('片段查询按 materials.project_id 和版本隔离，不串项目或孤儿片段', async () => {
  const projectA = await createProject(client, user, { name: '片段项目 A' })
  const projectB = await createProject(client, user, { name: '片段项目 B' })
  // 当前 schema 的 materials 主键是 (material_id, material_version)，
  // 因此同一 materialId 可以存在于两个项目，但版本号不能相同；用不同版本验证隔离。
  seedMaterial(projectA.projectId, 'mat_shared_segments', 1, 'seg_project_a')
  seedMaterial(projectB.projectId, 'mat_shared_segments', 2, 'seg_project_b')
  const db = client.runtime.getDb()
  db.prepare(
    `INSERT INTO material_segments
       (material_id, material_version, segment_id, idx, start_line, end_line, text, char_count, created_at)
     VALUES ('mat_shared_segments', 3, 'seg_orphan', 0, 1, 2, '无材料行的孤儿片段', 7, '2026-10-01T00:00:00.000Z')`,
  ).run()

  const a = await client.request(
    `/api/projects/${projectA.projectId}/materials/mat_shared_segments/segments`,
    { cookie: user.cookie },
  )
  const aBody = (await a.json()) as {
    data: { materialVersion: number; segments: Array<{ segmentId: string }> }
  }
  assert.equal(aBody.data.materialVersion, 1)
  assert.deepEqual(
    aBody.data.segments.map((segment) => segment.segmentId),
    ['seg_project_a'],
  )

  const b = await client.request(
    `/api/projects/${projectB.projectId}/materials/mat_shared_segments/segments`,
    { cookie: user.cookie },
  )
  const bBody = (await b.json()) as {
    data: { materialVersion: number; segments: Array<{ segmentId: string }> }
  }
  assert.equal(bBody.data.materialVersion, 2)
  assert.deepEqual(
    bBody.data.segments.map((segment) => segment.segmentId),
    ['seg_project_b'],
  )

  const crossVersion = await client.request(
    `/api/projects/${projectA.projectId}/materials/mat_shared_segments?version=2`,
    { cookie: user.cookie },
  )
  assert.equal(crossVersion.status, 404)
})
