import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TestClient,
  createProject,
  createTestClient,
  registerUser,
  uuid,
  type LoggedInUser,
} from './v3-support.js'

/**
 * 材料理解草稿五动作（契约 22.7 / v3.2）
 */

let client: TestClient
let user: LoggedInUser

before(async () => {
  client = await createTestClient()
  user = await registerUser(client)
})

after(async () => {
  await client.close()
})

interface SeedItem {
  itemId: string
  text: string
  originalText: string
  status: 'pending' | 'modified' | 'confirmed' | 'archived'
  revision: number
}

function seedMaterial(
  projectId: string,
  materialId: string,
  items: SeedItem[],
  version = 1,
): void {
  const db = client.runtime.getDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO materials
       (material_id, material_version, project_id, user_id, name, type, size, encoding,
        status, revision, sha256, failure_reason, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, '实验手册.md', 'md', 1024, 'utf-8', 'parsed', 1, NULL, NULL, ?, ?, NULL)`,
  ).run(materialId, version, projectId, user.userId, now, now)

  db.prepare(
    `INSERT OR IGNORE INTO material_segments
       (material_id, material_version, segment_id, idx, start_line, end_line, text, char_count, created_at)
     VALUES (?, ?, 'seg_0', 0, 1, 8, '# 实验手册', 6, ?)`,
  ).run(materialId, version, now)

  for (const item of items) {
    db.prepare(
      `INSERT INTO understanding_items
         (item_id, client_item_id, project_id, material_id, material_version, kind, text,
          original_text, sources_json, status, source, revision, created_at, updated_at,
          confirmed_at, confirmed_by_user_id, removed_at)
       VALUES (?, NULL, ?, ?, ?, 'goalCandidates', ?, ?, ?, ?, 'migration', ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.itemId,
      projectId,
      materialId,
      version,
      item.text,
      item.originalText,
      JSON.stringify([{ materialId, materialVersion: version, segmentId: 'seg_0' }]),
      item.status,
      item.revision,
      now,
      now,
      item.status === 'confirmed' ? now : null,
      item.status === 'confirmed' ? user.userId : null,
      item.status === 'archived' ? now : null,
    )
  }
}

function draftBody(
  projectId: string,
  projectRevision: number,
  materialVersion: number,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: `draft-${uuid().slice(0, 22)}`,
    projectId,
    projectRevision,
    materialVersion,
    ...extra,
  }
}

async function latestRevision(projectId: string): Promise<number> {
  const response = await client.request(`/api/projects/${projectId}`, { cookie: user.cookie })
  const body = (await response.json()) as { projectRevision: number }
  return body.projectRevision
}

test('confirmDraftItem：pending → confirmed，revision 与 projectRevision 各 +1', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_confirm01', [
    { itemId: 'cnd_confirm01', text: '原始候选', originalText: '原始候选', status: 'pending', revision: 1 },
  ])

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_confirm01/understanding/items/cnd_confirm01/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, project.projectRevision, 1, {
        itemId: 'cnd_confirm01',
        expectedRevision: 1,
      }),
    },
  )
  const body = (await response.json()) as {
    projectRevision: number
    data: { changed: boolean; item: { status: string; revision: number; confirmedByUserId: string } }
  }
  assert.equal(response.status, 200)
  assert.equal(body.data.changed, true)
  assert.equal(body.data.item.status, 'confirmed')
  assert.equal(body.data.item.revision, 2)
  assert.equal(body.data.item.confirmedByUserId, user.userId)
  assert.equal(body.projectRevision, project.projectRevision + 1)

  const repeat = await client.request(
    `/api/projects/${project.projectId}/materials/mat_confirm01/understanding/items/cnd_confirm01/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, body.projectRevision, 1, {
        itemId: 'cnd_confirm01',
        expectedRevision: 2,
      }),
    },
  )
  const repeatBody = (await repeat.json()) as { projectRevision: number; data: { changed: boolean } }
  assert.equal(repeatBody.data.changed, false)
  assert.equal(repeatBody.projectRevision, body.projectRevision)
})

test('undoDraftItem：text 与 originalText 相同回到 pending，不同回到 modified', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_undo01', [
    { itemId: 'cnd_undo_same', text: '原文', originalText: '原文', status: 'confirmed', revision: 2 },
    { itemId: 'cnd_undo_diff', text: '改过的文本', originalText: '原文', status: 'confirmed', revision: 3 },
    { itemId: 'cnd_undo_pending', text: '原文', originalText: '原文', status: 'pending', revision: 1 },
  ])
  let revision = project.projectRevision

  const same = await client.request(
    `/api/projects/${project.projectId}/materials/mat_undo01/understanding/items/cnd_undo_same/undo`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, revision, 1, {
        itemId: 'cnd_undo_same',
        expectedRevision: 2,
      }),
    },
  )
  const sameBody = (await same.json()) as {
    projectRevision: number
    data: { changed: boolean; item: { status: string; revision: number; confirmedAt: string | null; confirmedByUserId: string | null } }
  }
  assert.equal(sameBody.data.item.status, 'pending')
  assert.equal(sameBody.data.item.revision, 3)
  assert.equal(sameBody.data.item.confirmedAt, null)
  assert.equal(sameBody.data.item.confirmedByUserId, null)
  revision = sameBody.projectRevision

  const diff = await client.request(
    `/api/projects/${project.projectId}/materials/mat_undo01/understanding/items/cnd_undo_diff/undo`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, revision, 1, {
        itemId: 'cnd_undo_diff',
        expectedRevision: 3,
      }),
    },
  )
  const diffBody = (await diff.json()) as {
    projectRevision: number
    data: { item: { status: string; revision: number } }
  }
  assert.equal(diffBody.data.item.status, 'modified')
  assert.equal(diffBody.data.item.revision, 4)
  revision = diffBody.projectRevision

  const noop = await client.request(
    `/api/projects/${project.projectId}/materials/mat_undo01/understanding/items/cnd_undo_pending/undo`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, revision, 1, {
        itemId: 'cnd_undo_pending',
        expectedRevision: 1,
      }),
    },
  )
  const noopBody = (await noop.json()) as { projectRevision: number; data: { changed: boolean } }
  assert.equal(noopBody.data.changed, false)
  assert.equal(noopBody.projectRevision, revision)
})

test('editDraftItem：已确认条目修改后回到 modified 并清空确认信息', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_edit01', [
    { itemId: 'cnd_edit01', text: '原文本', originalText: '原文本', status: 'confirmed', revision: 2 },
  ])

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_edit01/understanding/items/cnd_edit01`,
    {
      method: 'PATCH',
      cookie: user.cookie,
      body: draftBody(project.projectId, project.projectRevision, 1, {
        itemId: 'cnd_edit01',
        expectedRevision: 2,
        text: '新的理解文本',
      }),
    },
  )
  const body = (await response.json()) as {
    projectRevision: number
    data: { changed: boolean; item: { status: string; revision: number; text: string; confirmedAt: string | null } }
  }
  assert.equal(body.data.changed, true)
  assert.equal(body.data.item.status, 'modified')
  assert.equal(body.data.item.text, '新的理解文本')
  assert.equal(body.data.item.confirmedAt, null)
  assert.equal(body.data.item.revision, 3)

  const sameText = await client.request(
    `/api/projects/${project.projectId}/materials/mat_edit01/understanding/items/cnd_edit01`,
    {
      method: 'PATCH',
      cookie: user.cookie,
      body: draftBody(project.projectId, body.projectRevision, 1, {
        itemId: 'cnd_edit01',
        expectedRevision: 3,
        text: '新的理解文本',
      }),
    },
  )
  const sameBody = (await sameText.json()) as { projectRevision: number; data: { changed: boolean } }
  assert.equal(sameBody.data.changed, false)
  assert.equal(sameBody.projectRevision, body.projectRevision)
})

test('confirmAllDraft：包含 archived 条目整单 409，不写入、不递增版本', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_all01', [
    { itemId: 'cnd_all_pending', text: '待确认', originalText: '待确认', status: 'pending', revision: 1 },
    { itemId: 'cnd_all_confirmed', text: '已确认', originalText: '已确认', status: 'confirmed', revision: 2 },
    { itemId: 'cnd_all_archived', text: '已移除', originalText: '已移除', status: 'archived', revision: 3 },
  ])
  const before = await latestRevision(project.projectId)

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_all01/understanding/confirm-all`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, before, 1, {
        items: [
          { itemId: 'cnd_all_pending', expectedRevision: 1 },
          { itemId: 'cnd_all_confirmed', expectedRevision: 2 },
          { itemId: 'cnd_all_archived', expectedRevision: 3 },
        ],
      }),
    },
  )
  assert.equal(response.status, 409)
  assert.equal(((await response.json()) as { code: string }).code, 'DRAFT_ITEM_ARCHIVED')
  assert.equal(await latestRevision(project.projectId), before)

  const db = client.runtime.getDb()
  const archived = db
    .prepare('SELECT status, revision FROM understanding_items WHERE item_id = ?')
    .get('cnd_all_archived') as { status: string; revision: number }
  assert.equal(archived.status, 'archived')
  assert.equal(archived.revision, 3)
})

test('confirmAllDraft：成功时只递增一次 projectRevision，archived 保持不可恢复', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_all02', [
    { itemId: 'cnd_all02_a', text: 'A', originalText: 'A', status: 'pending', revision: 1 },
    { itemId: 'cnd_all02_b', text: 'B', originalText: 'B', status: 'modified', revision: 2 },
    { itemId: 'cnd_all02_c', text: 'C', originalText: 'C', status: 'confirmed', revision: 4 },
    { itemId: 'cnd_all02_archived', text: 'D', originalText: 'D', status: 'archived', revision: 5 },
  ])

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_all02/understanding/confirm-all`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, project.projectRevision, 1, {
        items: [
          { itemId: 'cnd_all02_a', expectedRevision: 1 },
          { itemId: 'cnd_all02_b', expectedRevision: 2 },
          { itemId: 'cnd_all02_c', expectedRevision: 4 },
        ],
      }),
    },
  )
  const body = (await response.json()) as {
    projectRevision: number
    data: { changed: boolean; confirmedCount: number; skippedCount: number; items: Array<{ itemId: string; status: string; revision: number }> }
  }
  assert.equal(response.status, 200)
  assert.equal(body.projectRevision, project.projectRevision + 1)
  assert.equal(body.data.confirmedCount, 2)
  assert.equal(body.data.skippedCount, 1)
  assert.deepEqual(
    body.data.items.map((item) => item.status),
    ['confirmed', 'confirmed', 'confirmed'],
  )

  const archivedResponse = await client.request(
    `/api/projects/${project.projectId}/materials/mat_all02/understanding/items/cnd_all02_archived/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, body.projectRevision, 1, {
        itemId: 'cnd_all02_archived',
        expectedRevision: 5,
      }),
    },
  )
  assert.equal(archivedResponse.status, 409)
  assert.equal(((await archivedResponse.json()) as { code: string }).code, 'DRAFT_ITEM_ARCHIVED')
})

test('材料版本过期返回 MATERIAL_VERSION_OUTDATED', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_version01', [
    { itemId: 'cnd_version01', text: '文本', originalText: '文本', status: 'pending', revision: 1 },
  ])

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_version01/understanding/items/cnd_version01/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, project.projectRevision, 2, {
        itemId: 'cnd_version01',
        expectedRevision: 1,
      }),
    },
  )
  assert.equal(response.status, 409)
  assert.equal(((await response.json()) as { code: string }).code, 'MATERIAL_VERSION_OUTDATED')
})

test('itemId 不属于该材料返回 RESOURCE_NOT_FOUND', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_scope01', [
    { itemId: 'cnd_scope01', text: '文本', originalText: '文本', status: 'pending', revision: 1 },
  ])
  seedMaterial(project.projectId, 'mat_scope02', [
    { itemId: 'cnd_scope02', text: '文本', originalText: '文本', status: 'pending', revision: 1 },
  ])

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_scope01/understanding/items/cnd_scope02/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, project.projectRevision, 1, {
        itemId: 'cnd_scope02',
        expectedRevision: 1,
      }),
    },
  )
  assert.equal(response.status, 404)
  assert.equal(((await response.json()) as { code: string }).code, 'RESOURCE_NOT_FOUND')
})

test('草稿动作的 expectedRevision 冲突返回 STALE_REVISION', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_rev01', [
    { itemId: 'cnd_rev01', text: '文本', originalText: '文本', status: 'pending', revision: 2 },
  ])
  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_rev01/understanding/items/cnd_rev01/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: draftBody(project.projectId, project.projectRevision, 1, {
        itemId: 'cnd_rev01',
        expectedRevision: 1,
      }),
    },
  )
  const body = (await response.json()) as { code: string; currentEntityRevision: number }
  assert.equal(response.status, 409)
  assert.equal(body.code, 'STALE_REVISION')
  assert.equal(body.currentEntityRevision, 2)
})
