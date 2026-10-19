import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TestClient,
  createProject,
  createTestClient,
  envelope,
  registerUser,
  uuid,
  type LoggedInUser,
} from './v3-support.js'
import { migrate } from '../src/v3/migrations.js'

/**
 * V3 材料写链路：
 * POST /materials
 * POST /materials/{id}/archive
 * POST /materials/{id}/restore
 * POST /materials/{id}/reparse
 */

let client: TestClient
let user: LoggedInUser

before(async () => {
  client = await createTestClient()
  user = await registerUser(client, { account: `material_write_${Date.now()}` })
})

after(async () => {
  await client.close()
})

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString('base64')
}

function uploadBody(
  _projectId: string,
  projectRevision: number,
  content: string | Buffer,
  options: { name?: string; idempotencyKey?: string } = {},
): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: options.idempotencyKey ?? `mat-up-${uuid().slice(0, 22)}`,
    projectRevision,
    name: options.name ?? '材料.md',
    contentBase64: b64(content),
  }
}

async function upload(
  projectId: string,
  projectRevision: number,
  content: string | Buffer,
  options: { name?: string; idempotencyKey?: string } = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await client.request(`/api/projects/${projectId}/materials`, {
    method: 'POST',
    cookie: user.cookie,
    body: uploadBody(projectId, projectRevision, content, options),
  })
  return { response, body: (await response.json()) as Record<string, unknown> }
}

function seedMaterialWithoutContent(projectId: string, materialId: string): void {
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO materials
         (material_id, material_version, project_id, user_id, name, type, size, encoding,
          status, revision, sha256, failure_reason, created_at, updated_at, archived_at,
          content_text)
       VALUES (?, 1, ?, ?, '旧材料.md', 'md', 10, 'utf-8', 'parsed', 1, NULL, NULL,
               '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL, NULL)`,
    )
    .run(materialId, projectId, user.userId)
}

async function projectRevision(projectId: string): Promise<number> {
  const response = await client.request(`/api/projects/${projectId}`, { cookie: user.cookie })
  const body = (await response.json()) as { projectRevision: number }
  return body.projectRevision
}

function countRows(sql: string, ...params: unknown[]): number {
  return (
    client.runtime.getDb().prepare(sql).get(...params) as { count: number }
  ).count
}

test('迁移 v2 可重复执行，materials.content_text 与索引存在', () => {
  const db = client.runtime.getDb()
  const versions = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>
  assert.deepEqual(versions.map((row) => row.version), [1, 2])

  const columns = db.prepare('PRAGMA table_info(materials)').all() as Array<{ name: string }>
  assert.equal(columns.some((column) => column.name === 'content_text'), true)
  const indexes = db.prepare('PRAGMA index_list(materials)').all() as Array<{ name: string }>
  assert.equal(indexes.some((index) => index.name === 'idx_materials_project_sha256'), true)

  migrate(db)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count,
    2,
  )
})

test('正常上传：materials、segments、content_text 写入正确，projectRevision +1', async () => {
  const project = await createProject(client, user, { name: '材料上传项目' })
  const content = '第一段正文\n\n第二段正文'
  const { response, body } = await upload(project.projectId, project.projectRevision, content)
  const material = (body.data as { material: Record<string, unknown> }).material

  assert.equal(response.status, 200)
  assert.equal(material.status, 'parsed')
  assert.equal(material.materialVersion, 1)
  assert.equal(material.isCurrent, true)
  assert.equal(material.readOnly, false)
  assert.equal(body.projectRevision, project.projectRevision + 1)
  assert.equal((body.data as { deduplicated: boolean }).deduplicated, false)
  assert.ok((body.data as { segmentCount: number }).segmentCount >= 1)
  assert.equal(
    (body.data as { segments: unknown[] }).segments.length,
    Math.min(20, (body.data as { segmentCount: number }).segmentCount),
  )

  const row = client.runtime
    .getDb()
    .prepare('SELECT * FROM materials WHERE material_id = ? AND material_version = 1')
    .get(material.materialId as string) as {
    content_text: string
    status: string
    sha256: string
  }
  assert.equal(row.content_text, content)
  assert.equal(row.status, 'parsed')
  assert.equal(row.sha256.length, 64)
  assert.equal(
    countRows(
      'SELECT COUNT(*) AS count FROM material_segments WHERE material_id = ? AND material_version = 1',
      material.materialId,
    ),
    (body.data as { segmentCount: number }).segmentCount,
  )
  assert.equal(await projectRevision(project.projectId), project.projectRevision + 1)
})

test('上传校验：扩展名、大小、NUL、空文件', async () => {
  const project = await createProject(client, user, { name: '材料校验项目' })
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['扩展名', uploadBody(project.projectId, project.projectRevision, 'abc', { name: 'a.csv' }), 'UNSUPPORTED_MATERIAL_TYPE'],
    [
      '超 1 MB',
      uploadBody(project.projectId, project.projectRevision, Buffer.alloc(1_048_577, 0x61)),
      'MATERIAL_TOO_LARGE',
    ],
    [
      'NUL',
      uploadBody(project.projectId, project.projectRevision, Buffer.from([0x61, 0x00, 0x62])),
      'UNSUPPORTED_MATERIAL_TYPE',
    ],
    [
      '空文件',
      uploadBody(project.projectId, project.projectRevision, '   '),
      'EMPTY_MATERIAL',
    ],
  ]

  for (const [label, body, code] of cases) {
    const response = await client.request(`/api/projects/${project.projectId}/materials`, {
      method: 'POST',
      cookie: user.cookie,
      body,
    })
    assert.equal(response.status, 400, label)
    assert.equal((await jsonOf(response)).code, code, label)
  }
  assert.equal(
    countRows('SELECT COUNT(*) AS count FROM materials WHERE project_id = ?', project.projectId),
    0,
  )
  assert.equal(
    countRows(
      `SELECT COUNT(*) AS count FROM material_segments s
         JOIN materials m ON m.material_id = s.material_id AND m.material_version = s.material_version
        WHERE m.project_id = ?`,
      project.projectId,
    ),
    0,
  )
})

test('GBK 正确解码；非法 UTF-8/GBK 字节返回 MATERIAL_ENCODING_UNREADABLE', async () => {
  const project = await createProject(client, user, { name: '材料编码项目' })
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0xca, 0xc0, 0xbd, 0xe7])
  const first = await upload(project.projectId, project.projectRevision, gbk)
  const material = (first.body.data as { material: { materialId: string } }).material

  assert.equal(first.response.status, 200)
  const row = client.runtime
    .getDb()
    .prepare('SELECT encoding, content_text FROM materials WHERE material_id = ?')
    .get(material.materialId) as { encoding: string; content_text: string }
  assert.equal(row.encoding, 'gbk')
  assert.equal(row.content_text, '你好\n世界')

  const invalid = await upload(
    project.projectId,
    (first.body as { projectRevision: number }).projectRevision,
    Buffer.from([0xff, 0xfe, 0xfd]),
    { name: 'bad.txt' },
  )
  assert.equal(invalid.response.status, 400)
  assert.equal(invalid.body.code, 'MATERIAL_ENCODING_UNREADABLE')
})

test('同 idempotencyKey 重放不新增行；不同 key 同 sha256 去重', async () => {
  const project = await createProject(client, user, { name: '材料幂等项目' })
  const key = `mat-replay-${uuid().slice(0, 20)}`
  const body = uploadBody(project.projectId, project.projectRevision, '去重材料正文', {
    name: 'dedup.md',
    idempotencyKey: key,
  })
  const first = await client.request(`/api/projects/${project.projectId}/materials`, {
    method: 'POST',
    cookie: user.cookie,
    body,
  })
  const firstBody = (await first.json()) as {
    projectRevision: number
    data: { material: { materialId: string; materialVersion: number }; deduplicated: boolean }
  }
  assert.equal(first.status, 200)

  const replay = await client.request(`/api/projects/${project.projectId}/materials`, {
    method: 'POST',
    cookie: user.cookie,
    body,
  })
  const replayBody = (await replay.json()) as {
    replayed: boolean
    projectRevision: number
    data: { material: { materialId: string }; deduplicated: boolean }
  }
  assert.equal(replay.status, 200)
  assert.equal(replayBody.replayed, true)
  assert.equal(replayBody.projectRevision, firstBody.projectRevision)
  assert.equal(replayBody.data.material.materialId, firstBody.data.material.materialId)

  const conflict = await client.request(`/api/projects/${project.projectId}/materials`, {
    method: 'POST',
    cookie: user.cookie,
    body: uploadBody(project.projectId, firstBody.projectRevision, '同 key 不同内容', {
      name: 'conflict.md',
      idempotencyKey: key,
    }),
  })
  assert.equal(conflict.status, 409)
  assert.equal((await jsonOf(conflict)).code, 'IDEMPOTENCY_CONFLICT')

  const dedupKey = `mat-dedup-${uuid().slice(0, 20)}`
  const dedup = await client.request(`/api/projects/${project.projectId}/materials`, {
    method: 'POST',
    cookie: user.cookie,
    body: uploadBody(project.projectId, firstBody.projectRevision, '去重材料正文', {
      name: 'dedup-again.md',
      idempotencyKey: dedupKey,
    }),
  })
  const dedupBody = (await dedup.json()) as {
    projectRevision: number
    data: { material: { materialId: string; materialVersion: number }; deduplicated: boolean }
  }
  assert.equal(dedup.status, 200)
  assert.equal(dedupBody.data.deduplicated, true)
  assert.equal(dedupBody.data.material.materialId, firstBody.data.material.materialId)
  assert.equal(dedupBody.data.material.materialVersion, firstBody.data.material.materialVersion)
  assert.equal(dedupBody.projectRevision, firstBody.projectRevision)
  assert.equal(
    countRows('SELECT COUNT(*) AS count FROM materials WHERE project_id = ?', project.projectId),
    1,
  )
})

test('归档项目上传返回 PROJECT_ARCHIVED，且不产生材料行', async () => {
  const project = await createProject(client, user, { name: '归档材料项目' })
  const archive = await client.request(`/api/projects/${project.projectId}/archive`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(project.projectId, project.projectRevision),
  })
  const archived = (await archive.json()) as { projectRevision: number }
  assert.equal(archive.status, 200)

  const blocked = await upload(project.projectId, archived.projectRevision, '不应写入')
  assert.equal(blocked.response.status, 409)
  assert.equal(blocked.body.code, 'PROJECT_ARCHIVED')
  assert.equal(
    countRows('SELECT COUNT(*) AS count FROM materials WHERE project_id = ?', project.projectId),
    0,
  )
  assert.equal(
    countRows('SELECT COUNT(*) AS count FROM idempotency_records WHERE response_json LIKE ?', '%不应写入%'),
    0,
  )
})

test('reparse 生成 version+1，旧版本只读，新版本 isCurrent=true', async () => {
  const project = await createProject(client, user, { name: '材料重解析项目' })
  const first = await upload(project.projectId, project.projectRevision, '重新解析正文')
  const materialId = (first.body.data as { material: { materialId: string } }).material.materialId
  const firstRevision = first.body.projectRevision as number

  const reparse = await client.request(
    `/api/projects/${project.projectId}/materials/${materialId}/reparse`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, firstRevision),
    },
  )
  const reparseBody = (await reparse.json()) as {
    projectRevision: number
    data: {
      material: { materialId: string; materialVersion: number; isCurrent: boolean; readOnly: boolean }
      segmentCount: number
    }
  }
  assert.equal(reparse.status, 200)
  assert.equal(reparseBody.data.material.materialId, materialId)
  assert.equal(reparseBody.data.material.materialVersion, 2)
  assert.equal(reparseBody.data.material.isCurrent, true)
  assert.equal(reparseBody.data.material.readOnly, false)
  assert.equal(reparseBody.projectRevision, firstRevision + 1)

  const old = await client.request(
    `/api/projects/${project.projectId}/materials/${materialId}?version=1`,
    { cookie: user.cookie },
  )
  const oldBody = (await old.json()) as {
    data: { material: { materialVersion: number; isCurrent: boolean; readOnly: boolean } }
  }
  assert.equal(oldBody.data.material.materialVersion, 1)
  assert.equal(oldBody.data.material.isCurrent, false)
  assert.equal(oldBody.data.material.readOnly, true)

  assert.equal(
    countRows(
      'SELECT COUNT(*) AS count FROM materials WHERE material_id = ?',
      materialId,
    ),
    2,
  )
})

test('reparse 迁移旧材料 content_text 为 NULL 返回 MATERIAL_CONTENT_UNAVAILABLE', async () => {
  const project = await createProject(client, user, { name: '无原文材料项目' })
  seedMaterialWithoutContent(project.projectId, 'mat_old_no_content')

  const response = await client.request(
    `/api/projects/${project.projectId}/materials/mat_old_no_content/reparse`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, project.projectRevision),
    },
  )
  assert.equal(response.status, 409)
  assert.equal((await jsonOf(response)).code, 'MATERIAL_CONTENT_UNAVAILABLE')
  assert.equal(
    countRows('SELECT COUNT(*) AS count FROM materials WHERE material_id = ?', 'mat_old_no_content'),
    1,
  )
})

test('archive/restore 状态机与归档可见性', async () => {
  const project = await createProject(client, user, { name: '材料归档项目' })
  const first = await upload(project.projectId, project.projectRevision, '归档测试正文')
  const materialId = (first.body.data as { material: { materialId: string } }).material.materialId
  const firstRevision = first.body.projectRevision as number

  const archive = await client.request(
    `/api/projects/${project.projectId}/materials/${materialId}/archive`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, firstRevision),
    },
  )
  const archived = (await archive.json()) as {
    projectRevision: number
    data: { material: { status: string; archivedAt: string | null; readOnly: boolean } }
  }
  assert.equal(archive.status, 200)
  assert.equal(archived.data.material.status, 'archived')
  assert.notEqual(archived.data.material.archivedAt, null)
  assert.equal(archived.data.material.readOnly, true)

  const hidden = await client.request(`/api/projects/${project.projectId}/materials`, {
    cookie: user.cookie,
  })
  const hiddenBody = (await hidden.json()) as { data: { materials: Array<{ materialId: string }> } }
  assert.equal(hiddenBody.data.materials.some((item) => item.materialId === materialId), false)

  const visible = await client.request(
    `/api/projects/${project.projectId}/materials?includeArchived=true`,
    { cookie: user.cookie },
  )
  const visibleBody = (await visible.json()) as { data: { materials: Array<{ materialId: string }> } }
  assert.equal(visibleBody.data.materials.some((item) => item.materialId === materialId), true)

  const archiveAgain = await client.request(
    `/api/projects/${project.projectId}/materials/${materialId}/archive`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, archived.projectRevision),
    },
  )
  assert.equal(archiveAgain.status, 409)
  assert.equal((await jsonOf(archiveAgain)).code, 'INVALID_STATE_TRANSITION')

  const restore = await client.request(
    `/api/projects/${project.projectId}/materials/${materialId}/restore`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, archived.projectRevision),
    },
  )
  const restored = (await restore.json()) as {
    projectRevision: number
    data: { material: { status: string; archivedAt: string | null } }
  }
  assert.equal(restore.status, 200)
  assert.equal(restored.data.material.status, 'parsed')
  assert.equal(restored.data.material.archivedAt, null)

  const restoreAgain = await client.request(
    `/api/projects/${project.projectId}/materials/${materialId}/restore`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, restored.projectRevision),
    },
  )
  assert.equal(restoreAgain.status, 409)
  assert.equal((await jsonOf(restoreAgain)).code, 'INVALID_STATE_TRANSITION')
})

test('projectRevision 落后返回 STALE_REVISION，且不产生半条材料', async () => {
  const project = await createProject(client, user, { name: '材料并发项目' })
  const first = await upload(project.projectId, project.projectRevision, '并发基线')
  assert.equal(first.response.status, 200)

  const stale = await upload(project.projectId, project.projectRevision, '并发新内容', {
    name: 'stale.md',
  })
  assert.equal(stale.response.status, 409)
  assert.equal(stale.body.code, 'STALE_REVISION')
  assert.equal(
    countRows('SELECT COUNT(*) AS count FROM materials WHERE project_id = ?', project.projectId),
    1,
  )
})

test('并发上传使用同一 projectRevision：一个成功，一个 STALE_REVISION，不产生半条材料', async () => {
  const project = await createProject(client, user, { name: '材料并发上传项目' })
  const [first, second] = await Promise.all([
    upload(project.projectId, project.projectRevision, '并发内容 A', { name: 'a.md' }),
    upload(project.projectId, project.projectRevision, '并发内容 B', { name: 'b.md' }),
  ])
  const statuses = [first.response.status, second.response.status].sort()
  assert.deepEqual(statuses, [200, 409])
  const failed = first.response.status === 409 ? first : second
  assert.equal(failed.body.code, 'STALE_REVISION')
  assert.equal(
    countRows('SELECT COUNT(*) AS count FROM materials WHERE project_id = ?', project.projectId),
    1,
  )
  assert.equal(await projectRevision(project.projectId), project.projectRevision + 1)
})

test('上传响应最多返回 20 个片段，但 segmentCount 为真实总数', async () => {
  const project = await createProject(client, user, { name: '材料分页响应项目' })
  const paragraphs = Array.from({ length: 21 }, (_, index) =>
    `${String(index).padStart(2, '0')}${'a'.repeat(1998)}`,
  )
  const content = paragraphs.join('\n\n')
  const { response, body } = await upload(project.projectId, project.projectRevision, content, {
    name: 'many.txt',
  })
  const data = body.data as { segments: unknown[]; segmentCount: number }

  assert.equal(response.status, 200)
  assert.equal(data.segmentCount, 21)
  assert.equal(data.segments.length, 20)
})
