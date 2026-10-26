import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockProvider } from '../src/advisor/mockProvider.js'
import { silentLogger, type AdvisorProvider, type UnderstandingProviderInput } from '../src/advisor/types.js'
import { createMaterialsService } from '../src/materials/understanding.js'
import {
  createProject,
  createTestClient,
  registerUser,
  uuid,
  type LoggedInUser,
  type TestClient,
} from './v3-support.js'

/**
 * POST /api/materials/understanding-v3（契约 31）
 * ----------------------------------------------------------------------------
 * 使用临时 SQLite、注入 provider，不发真实模型请求。
 * 所有材料名、行号、正文都应来自数据库，而不是请求体。
 */

interface Json {
  [key: string]: unknown
}

interface RecordedProvider {
  provider: AdvisorProvider
  calls: number
  inputs: UnderstandingProviderInput[]
}

function recordingProvider(): RecordedProvider {
  const state: RecordedProvider = {
    calls: 0,
    inputs: [],
    provider: {
      name: 'understanding-v3-test',
      async generate() {
        throw new Error('not used')
      },
      async generateUnderstanding(input: UnderstandingProviderInput) {
        state.calls += 1
        state.inputs.push(input)
        const first = input.segments[0]
        const segmentIds = first === undefined ? [] : [first.segmentId]
        return {
          draft: {
            goalCandidates: [{ text: `《${input.materialName}》的项目目标`, segmentIds }],
            outcomeCandidates: [{ text: `《${input.materialName}》的预期产出`, segmentIds }],
            dataNotes: [{ text: `《${input.materialName}》的数据说明`, segmentIds }],
            methodNotes: [{ text: `《${input.materialName}》的方法说明`, segmentIds }],
            openQuestions: [{ text: `《${input.materialName}》还需确认的问题`, segmentIds }],
          },
        }
      },
    },
  }
  return state
}

function fallbackProvider(): AdvisorProvider {
  return createMockProvider({ mode: 'throw' })
}

async function setup(provider: AdvisorProvider): Promise<{
  client: TestClient
  user: LoggedInUser
  project: { projectId: string; projectRevision: number }
}> {
  const client = await createTestClient({
    materialsService: createMaterialsService({ provider, logger: silentLogger }),
  })
  const user = await registerUser(client, { account: `und3_${Date.now().toString().slice(-10)}` })
  const project = await createProject(client, user, { name: 'V3 材料理解项目' })
  return { client, user, project }
}

interface SeedOptions {
  materialId: string
  version?: number
  name?: string
  status?: 'parsed' | 'archived'
  archivedAt?: string | null
  segments: Array<{ segmentId: string; startLine: number; endLine: number; text: string }>
  confirmed?: boolean
}

function seedMaterial(
  client: TestClient,
  projectId: string,
  userId: string,
  options: SeedOptions,
): void {
  const db = client.runtime.getDb()
  const now = '2026-10-20T00:00:00.000Z'
  const version = options.version ?? 1
  const name = options.name ?? `${options.materialId}.md`
  db.prepare(
    `INSERT INTO materials
       (material_id, material_version, project_id, user_id, name, type, size, encoding,
        status, revision, sha256, failure_reason, created_at, updated_at, archived_at,
        content_text)
     VALUES (?, ?, ?, ?, ?, 'md', 100, 'utf-8', ?, 1, NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    options.materialId,
    version,
    projectId,
    userId,
    name,
    options.status ?? 'parsed',
    now,
    now,
    options.archivedAt ?? null,
    options.segments.map((segment) => segment.text).join('\n'),
  )

  const insertSegment = db.prepare(
    `INSERT INTO material_segments
       (material_id, material_version, segment_id, idx, start_line, end_line, text,
        char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  options.segments.forEach((segment, index) => {
    insertSegment.run(
      options.materialId,
      version,
      segment.segmentId,
      index,
      segment.startLine,
      segment.endLine,
      segment.text,
      segment.text.length,
      now,
    )
  })

  if (options.confirmed !== false) {
    db.prepare(
      `INSERT INTO understanding_items
         (item_id, client_item_id, project_id, material_id, material_version, kind, text,
          original_text, sources_json, status, source, revision, created_at, updated_at,
          confirmed_at, confirmed_by_user_id, removed_at)
       VALUES (?, NULL, ?, ?, ?, 'data', '已确认字段', '已确认字段', ?, 'confirmed', 'ai', 1,
               ?, ?, ?, ?, NULL)`,
    ).run(
      `uitem_${options.materialId}_${version}`,
      projectId,
      options.materialId,
      version,
      JSON.stringify(options.segments.map((segment) => ({ segmentId: segment.segmentId }))),
      now,
      now,
      now,
      userId,
    )
  }
}

function segmentRequest(
  materialId: string,
  segmentId: string,
  version = 1,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { materialId, version, segmentId, ...extra }
}

async function post(
  client: TestClient,
  body: Record<string, unknown>,
  cookie: string | null,
): Promise<{ status: number; body: Json }> {
  const response = await client.request('/api/materials/understanding-v3', {
    method: 'POST',
    cookie,
    body,
  })
  return { status: response.status, body: (await response.json()) as Json }
}

function requestBody(
  projectId: string,
  projectRevision: number,
  segments: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: `und3-${uuid().slice(0, 20)}`,
    projectId,
    projectRevision,
    promptVersion: 'material-understanding-v3',
    segments,
    ...overrides,
  }
}

test('confirmed 片段正常生成五块草稿，sources 来自数据库', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_a',
      name: '权威材料A.md',
      segments: [
        { segmentId: 'seg_a1', startLine: 10, endLine: 12, text: '权威正文 A' },
        { segmentId: 'seg_a2', startLine: 20, endLine: 21, text: '权威正文 A2' },
      ],
    })
    const response = await post(
      client,
      requestBody(
        project.projectId,
        project.projectRevision,
        [
          segmentRequest('mat_a', 'seg_a1', 1, {
            name: '伪造名称.md',
            startLine: 999,
            endLine: 1000,
            text: '伪造正文',
          }),
        ],
      ),
      user.cookie,
    )

    assert.equal(response.status, 200)
    assert.equal(response.body.source, 'model')
    assert.equal(response.body.projectRevision, project.projectRevision)
    assert.equal(response.body.promptVersion, 'material-understanding-v3')
    assert.equal(response.body.materialId, undefined)
    assert.equal(response.body.materialVersion, undefined)
    const draft = response.body.draft as Record<string, Array<Record<string, unknown>>>
    for (const block of [
      'goalCandidates',
      'outcomeCandidates',
      'dataNotes',
      'methodNotes',
      'openQuestions',
    ]) {
      assert.equal(Array.isArray(draft[block]), true)
    }
    const first = draft.goalCandidates[0] as {
      itemId: string
      sources: Array<Record<string, unknown>>
    }
    assert.match(first.itemId, /^cnd_goal_/)
    assert.equal(first.sources[0]?.materialName, '权威材料A.md')
    assert.equal(first.sources[0]?.startLine, 10)
    assert.equal(first.sources[0]?.endLine, 12)
  } finally {
    await client.close()
  }
})

test('请求夹带的正文与行号被丢弃，模型输入使用数据库权威内容', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_a',
      name: '权威材料A.md',
      segments: [
        { segmentId: 'seg_a1', startLine: 10, endLine: 12, text: '数据库权威正文' },
      ],
    })
    const response = await post(
      client,
      requestBody(project.projectId, project.projectRevision, [
        segmentRequest('mat_a', 'seg_a1', 1, {
          name: '客户端伪造名称.md',
          startLine: 999,
          endLine: 1000,
          text: '客户端伪造正文',
        }),
      ]),
      user.cookie,
    )

    assert.equal(response.status, 200)
    assert.equal(recorder.calls, 1)
    assert.equal(recorder.inputs[0]?.materialName, '权威材料A.md')
    assert.equal(recorder.inputs[0]?.segments[0]?.startLine, 10)
    assert.equal(recorder.inputs[0]?.segments[0]?.endLine, 12)
    assert.equal(recorder.inputs[0]?.segments[0]?.text, '数据库权威正文')
  } finally {
    await client.close()
  }
})

test('未确认片段返回 400 UNCONFIRMED_MATERIAL', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_pending',
      segments: [{ segmentId: 'seg_p', startLine: 1, endLine: 2, text: '未确认正文' }],
      confirmed: false,
    })
    const response = await post(
      client,
      requestBody(project.projectId, project.projectRevision, [
        segmentRequest('mat_pending', 'seg_p'),
      ]),
      user.cookie,
    )
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'UNCONFIRMED_MATERIAL')
    assert.equal(recorder.calls, 0)
  } finally {
    await client.close()
  }
})

test('旧版本材料返回 409 MATERIAL_VERSION_OUTDATED', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_old',
      version: 2,
      segments: [{ segmentId: 'seg_old', startLine: 1, endLine: 2, text: '当前版本正文' }],
    })
    const response = await post(
      client,
      requestBody(project.projectId, project.projectRevision, [
        segmentRequest('mat_old', 'seg_old', 1),
      ]),
      user.cookie,
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'MATERIAL_VERSION_OUTDATED')
    assert.equal(recorder.calls, 0)
  } finally {
    await client.close()
  }
})

test('归档材料返回 409 MATERIAL_VERSION_OUTDATED', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_archived',
      status: 'archived',
      archivedAt: '2026-10-21T00:00:00.000Z',
      segments: [{ segmentId: 'seg_arch', startLine: 1, endLine: 2, text: '归档正文' }],
    })
    const response = await post(
      client,
      requestBody(project.projectId, project.projectRevision, [
        segmentRequest('mat_archived', 'seg_arch'),
      ]),
      user.cookie,
    )
    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'MATERIAL_VERSION_OUTDATED')
    assert.equal(recorder.calls, 0)
  } finally {
    await client.close()
  }
})

test('模型不可用返回 200 + fallback + 空五块 + 中文 notice', async () => {
  const { client, user, project } = await setup(fallbackProvider())
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_a',
      segments: [{ segmentId: 'seg_a1', startLine: 1, endLine: 2, text: '正文' }],
    })
    const response = await post(
      client,
      requestBody(project.projectId, project.projectRevision, [
        segmentRequest('mat_a', 'seg_a1'),
      ]),
      user.cookie,
    )
    assert.equal(response.status, 200)
    assert.equal(response.body.source, 'fallback')
    assert.equal(typeof response.body.notice, 'string')
    assert.match(String(response.body.notice), /模型|理解|稍后/)
    const draft = response.body.draft as Record<string, unknown[]>
    for (const block of [
      'goalCandidates',
      'outcomeCandidates',
      'dataNotes',
      'methodNotes',
      'openQuestions',
    ]) {
      assert.deepEqual(draft[block], [])
    }
  } finally {
    await client.close()
  }
})

test('未登录返回 401', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_a',
      segments: [{ segmentId: 'seg_a1', startLine: 1, endLine: 2, text: '正文' }],
    })
    const response = await post(
      client,
      requestBody(project.projectId, project.projectRevision, [
        segmentRequest('mat_a', 'seg_a1'),
      ]),
      null,
    )
    assert.equal(response.status, 401)
    assert.equal(recorder.calls, 0)
  } finally {
    await client.close()
  }
})

test('跨用户项目返回 404 PROJECT_NOT_FOUND', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_a',
      segments: [{ segmentId: 'seg_a1', startLine: 1, endLine: 2, text: '正文' }],
    })
    const other = await registerUser(client, { account: `und3_o_${Date.now().toString().slice(-9)}` })
    const otherProject = await createProject(client, other, { name: '他人项目' })

    const response = await post(
      client,
      requestBody(otherProject.projectId, otherProject.projectRevision, [
        segmentRequest('mat_a', 'seg_a1'),
      ]),
      user.cookie,
    )
    assert.equal(response.status, 404)
    assert.equal(response.body.code, 'PROJECT_NOT_FOUND')
    assert.equal(recorder.calls, 0)
  } finally {
    await client.close()
  }
})

test('同 requestId/idempotencyKey 重放不重复调用模型', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_a',
      segments: [{ segmentId: 'seg_a1', startLine: 1, endLine: 2, text: '正文' }],
    })
    const body = requestBody(project.projectId, project.projectRevision, [
      segmentRequest('mat_a', 'seg_a1'),
    ])
    const first = await post(client, body, user.cookie)
    const second = await post(client, body, user.cookie)

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.deepEqual(second.body, first.body)
    assert.equal(recorder.calls, 1)
  } finally {
    await client.close()
  }
})

test('promptVersion 错误、segments 为空或超过 100 条返回 400', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_a',
      segments: [{ segmentId: 'seg_a1', startLine: 1, endLine: 2, text: '正文' }],
    })

    const wrongVersion = await post(
      client,
      requestBody(
        project.projectId,
        project.projectRevision,
        [segmentRequest('mat_a', 'seg_a1')],
        { promptVersion: 'material-understanding-v1' },
      ),
      user.cookie,
    )
    assert.equal(wrongVersion.status, 400)

    const empty = await post(
      client,
      requestBody(project.projectId, project.projectRevision, []),
      user.cookie,
    )
    assert.equal(empty.status, 400)

    const tooMany = await post(
      client,
      requestBody(
        project.projectId,
        project.projectRevision,
        Array.from({ length: 101 }, (_, index) => segmentRequest('mat_a', `seg_${index}`)),
      ),
      user.cookie,
    )
    assert.equal(tooMany.status, 400)
    assert.equal(recorder.calls, 0)
  } finally {
    await client.close()
  }
})

test('多材料 segments 分别回填来源，合并为一份五块草稿', async () => {
  const recorder = recordingProvider()
  const { client, user, project } = await setup(recorder.provider)
  try {
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_a',
      name: '材料甲.md',
      segments: [{ segmentId: 'seg_a1', startLine: 3, endLine: 5, text: '甲正文' }],
    })
    seedMaterial(client, project.projectId, user.userId, {
      materialId: 'mat_b',
      name: '材料乙.md',
      segments: [{ segmentId: 'seg_b1', startLine: 8, endLine: 9, text: '乙正文' }],
    })
    const response = await post(
      client,
      requestBody(project.projectId, project.projectRevision, [
        segmentRequest('mat_a', 'seg_a1'),
        segmentRequest('mat_b', 'seg_b1'),
      ]),
      user.cookie,
    )

    assert.equal(response.status, 200)
    assert.equal(recorder.calls, 2)
    const draft = response.body.draft as {
      goalCandidates: Array<{ itemId: string; sources: Array<Record<string, unknown>> }>
    }
    assert.equal(draft.goalCandidates.length, 2)
    assert.deepEqual(
      draft.goalCandidates.map((item) => item.itemId),
      ['cnd_goal_0', 'cnd_goal_1'],
    )
    assert.equal(draft.goalCandidates[0]?.sources[0]?.materialName, '材料甲.md')
    assert.equal(draft.goalCandidates[0]?.sources[0]?.startLine, 3)
    assert.equal(draft.goalCandidates[1]?.sources[0]?.materialName, '材料乙.md')
    assert.equal(draft.goalCandidates[1]?.sources[0]?.startLine, 8)
  } finally {
    await client.close()
  }
})
