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
 * 理解条目来源完整性：没有可验证材料来源的条目不能被确认。
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

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

interface SeedSegment {
  segmentId: string
  text: string
  startLine?: number
  endLine?: number
}

function seedMaterial(
  projectId: string,
  materialId: string,
  segments: SeedSegment[] = [
    { segmentId: 'seg_valid', text: '真实存在的材料片段', startLine: 3, endLine: 5 },
  ],
): void {
  const db = client.runtime.getDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO materials
       (material_id, material_version, project_id, user_id, name, type, size, encoding,
        status, revision, sha256, failure_reason, created_at, updated_at, archived_at)
     VALUES (?, 1, ?, ?, '来源测试.md', 'md', 100, 'utf-8', 'parsed', 1, NULL, NULL, ?, ?, NULL)`,
  ).run(materialId, projectId, user.userId, now, now)
  const insertSegment = db.prepare(
    `INSERT INTO material_segments
       (material_id, material_version, segment_id, idx, start_line, end_line, text, char_count, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  )
  segments.forEach((segment, index) => {
    insertSegment.run(
      materialId,
      segment.segmentId,
      index,
      segment.startLine ?? index + 1,
      segment.endLine ?? index + 1,
      segment.text,
      [...segment.text].length,
      now,
    )
  })
}

function seedItem(options: {
  projectId: string
  materialId: string
  itemId: string
  status: 'pending' | 'modified' | 'confirmed' | 'archived'
  sources: unknown
  text?: string
  revision?: number
}): void {
  const now = new Date().toISOString()
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO understanding_items
         (item_id, client_item_id, project_id, material_id, material_version, kind, text,
          original_text, sources_json, status, source, revision, created_at, updated_at,
          confirmed_at, confirmed_by_user_id, removed_at)
       VALUES (?, NULL, ?, ?, 1, 'goalCandidates', ?, ?, ?, ?, 'migration', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.itemId,
      options.projectId,
      options.materialId,
      options.text ?? '理解正文',
      options.text ?? '理解正文',
      JSON.stringify(options.sources),
      options.status,
      options.revision ?? 1,
      now,
      now,
      options.status === 'confirmed' ? now : null,
      options.status === 'confirmed' ? user.userId : null,
      options.status === 'archived' ? now : null,
    )
}

function confirmBody(
  projectId: string,
  projectRevision: number,
  itemId: string,
  expectedRevision: number,
  idempotencyKey = `confirm-${uuid().slice(0, 22)}`,
): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey,
    projectId,
    projectRevision,
    materialVersion: 1,
    itemId,
    expectedRevision,
  }
}

function confirmAllBody(
  projectId: string,
  projectRevision: number,
  items: Array<{ itemId: string; expectedRevision: number }>,
  idempotencyKey = `confirm-all-${uuid().slice(0, 22)}`,
): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey,
    projectId,
    projectRevision,
    materialVersion: 1,
    items,
  }
}

async function itemRow(itemId: string): Promise<{
  status: string
  revision: number
  confirmed_at: string | null
  confirmed_by_user_id: string | null
  sources_json: string
}> {
  return client.runtime
    .getDb()
    .prepare(
      `SELECT status, revision, confirmed_at, confirmed_by_user_id, sources_json
         FROM understanding_items WHERE item_id = ?`,
    )
    .get(itemId) as {
    status: string
    revision: number
    confirmed_at: string | null
    confirmed_by_user_id: string | null
    sources_json: string
  }
}

async function projectRevision(projectId: string): Promise<number> {
  const response = await client.request(`/api/projects/${projectId}`, { cookie: user.cookie })
  const body = (await response.json()) as { projectRevision: number }
  return body.projectRevision
}

function migrationPayload(options: {
  materialId: string
  segments?: Array<{ segmentId: string; text: string }>
  items: Array<{
    clientId: string
    text: string
    originalText?: string
    sourceSegmentIds?: string[]
    status: string
  }>
}): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: `migrate-${uuid().slice(0, 22)}`,
    migrationId: `mig_${uuid().replace(/-/g, '').slice(0, 24)}`,
    userConfirmed: true,
    userConfirmedAt: new Date().toISOString(),
    source: {
      schemaVersion: 3,
      clientProjectId: `prj_src_${uuid().replace(/-/g, '').slice(0, 16)}`,
    },
    localProject: {
      name: '来源迁移项目',
      short: '来源',
      projectRevision: 1,
      profile: {
        goal: null,
        expectedOutcome: null,
        memberNames: [],
        researchPeriod: null,
        scope: null,
        outOfScope: null,
      },
      milestones: [],
      tasks: [],
      evidence: [],
      progress: [],
      doubts: [],
      materials: [
        {
          clientId: options.materialId,
          name: '来源.md',
          type: 'md',
          size: 100,
          encoding: 'utf-8',
          status: 'parsed',
          version: 1,
          createdAt: '2026-10-19T00:00:00.000Z',
          updatedAt: '2026-10-19T00:00:00.000Z',
          segments: (options.segments ?? [
            { segmentId: 'seg_migrated', text: '迁移后的真实片段' },
          ]).map((segment, index) => ({
            segmentId: segment.segmentId,
            index,
            startLine: index + 1,
            endLine: index + 2,
            text: segment.text,
          })),
          understandingItems: options.items.map((item) => ({
            clientId: item.clientId,
            kind: 'goalCandidates',
            text: item.text,
            originalText: item.originalText ?? item.text,
            sourceSegmentIds: item.sourceSegmentIds ?? [],
            status: item.status,
          })),
        },
      ],
      chats: [],
    },
  }
}

async function migrate(payload: Record<string, unknown>): Promise<{
  projectId: string
  materialId: string
  itemIds: Record<string, string>
  warnings: Array<{ code: string; count: number }>
}> {
  const response = await client.request('/api/projects/migrate-local', {
    method: 'POST',
    cookie: user.cookie,
    body: payload,
  })
  const body = (await response.json()) as {
    projectId: string
    idMap: { materials: Record<string, string>; understandingItems: Record<string, string> }
    warnings: Array<{ code: string; count: number }>
  }
  assert.equal(response.status, 200)
  return {
    projectId: body.projectId,
    materialId: body.idMap.materials[(payload.localProject as { materials: Array<{ clientId: string }> }).materials[0]?.clientId as string] as string,
    itemIds: body.idMap.understandingItems,
    warnings: body.warnings,
  }
}

test('迁移：空来源数组的 confirmed 条目降为 pending，并返回来源缺失警告', async () => {
  const payload = migrationPayload({
    materialId: 'mat_empty_sources',
    items: [
      {
        clientId: 'item_empty',
        text: '没有来源的条目',
        sourceSegmentIds: [],
        status: 'confirmed',
      },
    ],
  })
  const migrated = await migrate(payload)
  const itemId = migrated.itemIds.item_empty as string
  const row = await itemRow(itemId)

  assert.equal(row.status, 'pending')
  assert.equal(row.confirmed_at, null)
  assert.equal(row.confirmed_by_user_id, null)
  assert.equal(row.sources_json, '[]')
  assert.equal(
    migrated.warnings.some((warning) => warning.code === 'UNDERSTANDING_SOURCE_MISSING'),
    true,
  )

  const confirm = await client.request(
    `/api/projects/${migrated.projectId}/materials/${migrated.materialId}/understanding/items/${itemId}/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: confirmBody(migrated.projectId, 1, itemId, 1),
    },
  )
  const confirmBodyJson = await jsonOf(confirm)
  assert.equal(confirm.status, 409)
  assert.equal(confirmBodyJson.code, 'DRAFT_SOURCE_MISSING')

  const after = await itemRow(itemId)
  assert.equal(after.status, 'pending')
  assert.equal(after.revision, 1)
  assert.equal(await projectRevision(migrated.projectId), 1)
})

test('历史 confirmed 条目若没有有效来源，单条确认也不能返回成功', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_legacy_confirmed')
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_legacy_confirmed',
    itemId: 'item_legacy_confirmed',
    status: 'confirmed',
    sources: [],
  })

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_legacy_confirmed/understanding/items/item_legacy_confirmed/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: confirmBody(project.projectId, project.projectRevision, 'item_legacy_confirmed', 1),
    },
  )
  assert.equal(response.status, 409)
  assert.equal((await jsonOf(response)).code, 'DRAFT_SOURCE_MISSING')
  const row = await itemRow('item_legacy_confirmed')
  assert.equal(row.status, 'confirmed')
  assert.equal(row.revision, 1)
  assert.equal(await projectRevision(project.projectId), project.projectRevision)
})

test('迁移：全部来源失效的条目降为 pending，再次确认被拒绝', async () => {
  const payload = migrationPayload({
    materialId: 'mat_invalid_sources',
    items: [
      {
        clientId: 'item_invalid',
        text: '来源全部失效的条目',
        sourceSegmentIds: ['seg_missing_1', 'seg_missing_2'],
        status: 'confirmed',
      },
    ],
  })
  const migrated = await migrate(payload)
  const itemId = migrated.itemIds.item_invalid as string
  const row = await itemRow(itemId)

  assert.equal(row.status, 'pending')
  assert.equal(row.sources_json, '[]')
  assert.equal(
    migrated.warnings.some((warning) => warning.code === 'UNDERSTANDING_SOURCE_MISSING'),
    true,
  )

  const confirm = await client.request(
    `/api/projects/${migrated.projectId}/materials/${migrated.materialId}/understanding/items/${itemId}/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: confirmBody(migrated.projectId, 1, itemId, 1),
    },
  )
  assert.equal(confirm.status, 409)
  assert.equal((await jsonOf(confirm)).code, 'DRAFT_SOURCE_MISSING')
  assert.equal((await itemRow(itemId)).status, 'pending')
})

test('单条确认：有真实来源可确认，响应来源行号取数据库而非 sources_json', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_valid_single')
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_valid_single',
    itemId: 'item_valid_single',
    status: 'pending',
    sources: [
      {
        materialId: 'mat_wrong',
        materialVersion: 99,
        segmentId: 'seg_valid',
        startLine: 999,
        endLine: 1000,
      },
    ],
  })

  const body = confirmBody(project.projectId, project.projectRevision, 'item_valid_single', 1)
  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_valid_single/understanding/items/item_valid_single/confirm`,
    { method: 'POST', cookie: user.cookie, body },
  )
  const confirmed = (await response.json()) as {
    projectRevision: number
    data: { item: { status: string; revision: number; sources: Array<{ startLine: number; endLine: number; segmentId: string }> } }
  }
  assert.equal(response.status, 200)
  assert.equal(confirmed.data.item.status, 'confirmed')
  assert.equal(confirmed.data.item.revision, 2)
  assert.equal(confirmed.data.item.sources.length, 1)
  assert.equal(confirmed.data.item.sources[0]?.segmentId, 'seg_valid')
  assert.equal(confirmed.data.item.sources[0]?.startLine, 3)
  assert.equal(confirmed.data.item.sources[0]?.endLine, 5)

  const retry = await client.request(
    `/api/projects/${project.projectId}/materials/mat_valid_single/understanding/items/item_valid_single/confirm`,
    { method: 'POST', cookie: user.cookie, body },
  )
  const retryBody = (await retry.json()) as { replayed: boolean; projectRevision: number }
  assert.equal(retry.status, 200)
  assert.equal(retryBody.replayed, true)
  assert.equal(retryBody.projectRevision, confirmed.projectRevision)
})

test('整份确认：任一条目无有效来源则整单 409，所有条目与版本不变', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_confirm_all_mixed')
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_confirm_all_mixed',
    itemId: 'item_all_valid',
    status: 'pending',
    sources: [{ segmentId: 'seg_valid' }],
  })
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_confirm_all_mixed',
    itemId: 'item_all_invalid',
    status: 'pending',
    sources: [],
  })

  const idempotencyKey = `confirm-all-${uuid().slice(0, 22)}`
  const body = confirmAllBody(
    project.projectId,
    project.projectRevision,
    [
      { itemId: 'item_all_valid', expectedRevision: 1 },
      { itemId: 'item_all_invalid', expectedRevision: 1 },
    ],
    idempotencyKey,
  )
  const beforeIdempotency = (
    client.runtime.getDb().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as {
      count: number
    }
  ).count

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_confirm_all_mixed/understanding/confirm-all`,
    { method: 'POST', cookie: user.cookie, body },
  )
  assert.equal(response.status, 409)
  assert.equal((await jsonOf(response)).code, 'DRAFT_SOURCE_MISSING')

  const validRow = await itemRow('item_all_valid')
  const invalidRow = await itemRow('item_all_invalid')
  assert.equal(validRow.status, 'pending')
  assert.equal(validRow.revision, 1)
  assert.equal(validRow.confirmed_at, null)
  assert.equal(validRow.confirmed_by_user_id, null)
  assert.equal(invalidRow.status, 'pending')
  assert.equal(invalidRow.revision, 1)
  assert.equal(await projectRevision(project.projectId), project.projectRevision)
  assert.equal(
    (
      client.runtime.getDb().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as {
        count: number
      }
    ).count,
    beforeIdempotency,
  )
})

test('整份确认：全部有真实来源时成功，重放不重复写入', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_confirm_all_valid')
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_confirm_all_valid',
    itemId: 'item_all_valid_a',
    status: 'pending',
    sources: [{ segmentId: 'seg_valid' }],
  })
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_confirm_all_valid',
    itemId: 'item_all_valid_b',
    status: 'modified',
    sources: [{ segmentId: 'seg_valid' }],
  })

  const body = confirmAllBody(project.projectId, project.projectRevision, [
    { itemId: 'item_all_valid_a', expectedRevision: 1 },
    { itemId: 'item_all_valid_b', expectedRevision: 1 },
  ])
  const first = await client.request(
    `/api/projects/${project.projectId}/materials/mat_confirm_all_valid/understanding/confirm-all`,
    { method: 'POST', cookie: user.cookie, body },
  )
  const firstBody = (await first.json()) as {
    projectRevision: number
    data: { changed: boolean; confirmedCount: number; items: Array<{ status: string; revision: number }> }
  }
  assert.equal(first.status, 200)
  assert.equal(firstBody.data.changed, true)
  assert.equal(firstBody.data.confirmedCount, 2)
  assert.deepEqual(
    firstBody.data.items.map((item) => item.status),
    ['confirmed', 'confirmed'],
  )

  const replay = await client.request(
    `/api/projects/${project.projectId}/materials/mat_confirm_all_valid/understanding/confirm-all`,
    { method: 'POST', cookie: user.cookie, body },
  )
  const replayBody = (await replay.json()) as {
    replayed: boolean
    projectRevision: number
    data: { changed: boolean }
  }
  assert.equal(replay.status, 200)
  assert.equal(replayBody.replayed, true)
  assert.equal(replayBody.data.changed, true)
  assert.equal(replayBody.projectRevision, firstBody.projectRevision)
  assert.equal((await itemRow('item_all_valid_a')).revision, 2)
  assert.equal((await itemRow('item_all_valid_b')).revision, 2)
})

test('迁移：空字符串、普通空格、Tab/换行/全角空格片段都不算有效来源', async () => {
  const segments = [
    { segmentId: 'seg_empty', text: '' },
    { segmentId: 'seg_spaces', text: '   ' },
    { segmentId: 'seg_whitespace', text: '\t\n\r\u3000' },
    { segmentId: 'seg_valid', text: '真实存在的材料片段' },
  ]
  const payload = migrationPayload({
    materialId: 'mat_blank_segments',
    segments,
    items: [
      { clientId: 'item_empty_text', text: '空正文来源', sourceSegmentIds: ['seg_empty'], status: 'confirmed' },
      { clientId: 'item_spaces_text', text: '普通空格来源', sourceSegmentIds: ['seg_spaces'], status: 'confirmed' },
      { clientId: 'item_ws_text', text: '混合空白来源', sourceSegmentIds: ['seg_whitespace'], status: 'confirmed' },
      {
        clientId: 'item_mixed_source',
        text: '混合有效来源',
        sourceSegmentIds: ['seg_empty', 'seg_valid'],
        status: 'confirmed',
      },
      {
        clientId: 'item_archived_blank',
        text: '归档条目',
        sourceSegmentIds: ['seg_whitespace'],
        status: 'archived',
      },
    ],
  })
  const migrated = await migrate(payload)

  assert.equal((await itemRow(migrated.itemIds.item_empty_text as string)).status, 'pending')
  assert.equal((await itemRow(migrated.itemIds.item_spaces_text as string)).status, 'pending')
  assert.equal((await itemRow(migrated.itemIds.item_ws_text as string)).status, 'pending')
  assert.equal((await itemRow(migrated.itemIds.item_archived_blank as string)).status, 'archived')

  const mixed = await itemRow(migrated.itemIds.item_mixed_source as string)
  assert.equal(mixed.status, 'confirmed')
  const mixedSources = JSON.parse(mixed.sources_json) as Array<{ segmentId: string }>
  assert.deepEqual(mixedSources.map((source) => source.segmentId), ['seg_valid'])
  assert.equal(
    migrated.warnings.some((warning) => warning.code === 'UNDERSTANDING_SOURCE_MISSING'),
    true,
  )

  // 原始正文必须原样保留，不能为校验改写材料片段
  const storedSegments = client.runtime
    .getDb()
    .prepare('SELECT text FROM material_segments WHERE material_id = ? ORDER BY idx')
    .all(migrated.materialId) as Array<{ text: string }>
  assert.deepEqual(
    storedSegments.map((segment) => segment.text),
    segments.map((segment) => segment.text),
  )

  const confirmEmpty = await client.request(
    `/api/projects/${migrated.projectId}/materials/${migrated.materialId}/understanding/items/${migrated.itemIds.item_empty_text}/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: confirmBody(migrated.projectId, 1, migrated.itemIds.item_empty_text as string, 1),
    },
  )
  assert.equal(confirmEmpty.status, 409)
  assert.equal((await jsonOf(confirmEmpty)).code, 'DRAFT_SOURCE_MISSING')
})

test('单条确认：空字符串、普通空格、Tab/换行/全角空格均拒绝，混合来源可确认', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_blank_confirm', [
    { segmentId: 'seg_empty', text: '' },
    { segmentId: 'seg_spaces', text: '   ' },
    { segmentId: 'seg_whitespace', text: '\t\n\r\u3000' },
    { segmentId: 'seg_valid', text: '真实存在的材料片段', startLine: 7, endLine: 9 },
  ])
  const invalidItems: Array<[string, string]> = [
    ['item_empty', 'seg_empty'],
    ['item_spaces', 'seg_spaces'],
    ['item_whitespace', 'seg_whitespace'],
  ]
  for (const [itemId, segmentId] of invalidItems) {
    seedItem({
      projectId: project.projectId,
      materialId: 'mat_blank_confirm',
      itemId,
      status: 'pending',
      sources: [{ segmentId }],
    })
  }
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_blank_confirm',
    itemId: 'item_mixed',
    status: 'pending',
    sources: [{ segmentId: 'seg_empty' }, { segmentId: 'seg_valid' }],
  })

  for (const [itemId] of invalidItems) {
    const response = await client.request(
      `/api/projects/${project.projectId}/materials/mat_blank_confirm/understanding/items/${itemId}/confirm`,
      {
        method: 'POST',
        cookie: user.cookie,
        body: confirmBody(project.projectId, 1, itemId, 1),
      },
    )
    assert.equal(response.status, 409)
    assert.equal((await jsonOf(response)).code, 'DRAFT_SOURCE_MISSING')
    const row = await itemRow(itemId)
    assert.equal(row.status, 'pending')
    assert.equal(row.revision, 1)
  }
  assert.equal(await projectRevision(project.projectId), 1)

  const mixed = await client.request(
    `/api/projects/${project.projectId}/materials/mat_blank_confirm/understanding/items/item_mixed/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: confirmBody(project.projectId, 1, 'item_mixed', 1),
    },
  )
  const mixedBody = (await mixed.json()) as {
    projectRevision: number
    data: { item: { status: string; sources: Array<{ segmentId: string; startLine: number; endLine: number }> } }
  }
  assert.equal(mixed.status, 200)
  assert.equal(mixedBody.data.item.status, 'confirmed')
  assert.deepEqual(
    mixedBody.data.item.sources.map((source) => source.segmentId),
    ['seg_valid'],
  )
  assert.equal(mixedBody.data.item.sources[0]?.startLine, 7)
  assert.equal(mixedBody.data.item.sources[0]?.endLine, 9)
})

test('整份确认：引用空正文/纯空白片段的条目导致整单失败，无部分写入', async () => {
  const project = await createProject(client, user)
  seedMaterial(project.projectId, 'mat_blank_confirm_all', [
    { segmentId: 'seg_valid', text: '真实存在的材料片段' },
    { segmentId: 'seg_blank', text: '\t\n\r\u3000' },
  ])
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_blank_confirm_all',
    itemId: 'item_all_normal',
    status: 'pending',
    sources: [{ segmentId: 'seg_valid' }],
  })
  seedItem({
    projectId: project.projectId,
    materialId: 'mat_blank_confirm_all',
    itemId: 'item_all_blank',
    status: 'pending',
    sources: [{ segmentId: 'seg_blank' }],
  })
  const beforeIdempotency = (
    client.runtime.getDb().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as {
      count: number
    }
  ).count

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_blank_confirm_all/understanding/confirm-all`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: confirmAllBody(project.projectId, project.projectRevision, [
        { itemId: 'item_all_normal', expectedRevision: 1 },
        { itemId: 'item_all_blank', expectedRevision: 1 },
      ]),
    },
  )
  assert.equal(response.status, 409)
  assert.equal((await jsonOf(response)).code, 'DRAFT_SOURCE_MISSING')

  for (const itemId of ['item_all_normal', 'item_all_blank']) {
    const row = await itemRow(itemId)
    assert.equal(row.status, 'pending')
    assert.equal(row.revision, 1)
    assert.equal(row.confirmed_at, null)
    assert.equal(row.confirmed_by_user_id, null)
  }
  assert.equal(await projectRevision(project.projectId), project.projectRevision)
  assert.equal(
    (
      client.runtime.getDb().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as {
        count: number
      }
    ).count,
    beforeIdempotency,
  )
})

test('迁移：来源失效的 archived 条目保持 archived，确认与整份确认都不能复活', async () => {
  const payload = migrationPayload({
    materialId: 'mat_archived_sources',
    items: [
      {
        clientId: 'item_archived_invalid',
        text: '已移除且没有来源',
        sourceSegmentIds: [],
        status: 'archived',
      },
    ],
  })
  const migrated = await migrate(payload)
  const itemId = migrated.itemIds.item_archived_invalid as string
  const row = await itemRow(itemId)
  assert.equal(row.status, 'archived')

  const confirm = await client.request(
    `/api/projects/${migrated.projectId}/materials/${migrated.materialId}/understanding/items/${itemId}/confirm`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: confirmBody(migrated.projectId, 1, itemId, 1),
    },
  )
  assert.equal(confirm.status, 409)
  assert.equal((await jsonOf(confirm)).code, 'DRAFT_ITEM_ARCHIVED')

  const confirmAll = await client.request(
    `/api/projects/${migrated.projectId}/materials/${migrated.materialId}/understanding/confirm-all`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: confirmAllBody(migrated.projectId, 1, [{ itemId, expectedRevision: 1 }]),
    },
  )
  assert.equal(confirmAll.status, 409)
  assert.equal((await jsonOf(confirmAll)).code, 'DRAFT_ITEM_ARCHIVED')
  assert.equal((await itemRow(itemId)).status, 'archived')
  assert.equal((await itemRow(itemId)).revision, 1)
  assert.equal(await projectRevision(migrated.projectId), 1)
})
