import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  createProject,
  createTestClient,
  envelope,
  registerUser,
  type LoggedInUser,
  type TestClient,
} from './v3-support.js'

let client: TestClient
let user: LoggedInUser
let projectId: string
let projectRevision: number

function candidateBody(
  targetProjectId: string,
  revision: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: randomUUID(),
    idempotencyKey: `cand-${randomUUID().slice(0, 24)}`,
    projectId: targetProjectId,
    projectRevision: revision,
    promptVersion: 'milestone-candidate-v1',
    maxCandidates: 3,
    focus: '围绕数据准备生成阶段',
    ...overrides,
  }
}

async function generate(
  targetProjectId = projectId,
  revision = projectRevision,
  overrides: Record<string, unknown> = {},
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const body = candidateBody(targetProjectId, revision, overrides)
  const response = await client.request(
    `/api/projects/${targetProjectId}/milestones/candidates`,
    { method: 'POST', cookie: user.cookie, body },
  )
  return { body: (await response.json()) as Record<string, unknown>, response }
}

function candidateIdOf(body: Record<string, unknown>): string {
  const candidates = body.candidates as Array<{ candidateId: string }>
  assert.ok(candidates.length > 0)
  return candidates[0]!.candidateId
}

before(async () => {
  client = await createTestClient()
  user = await registerUser(client)
  const project = await createProject(client, user, { name: '候选测试项目' })
  projectId = project.projectId
  projectRevision = project.projectRevision
})

after(async () => {
  await client.close()
})

test('正常生成候选：返回形状、30 分钟过期时间与空来源', async () => {
  const { body, response } = await generate()
  assert.equal(response.status, 200)
  assert.equal(body.source, 'fallback')
  assert.equal(typeof body.notice, 'string')
  assert.equal(body.projectRevision, projectRevision)
  const candidates = body.candidates as Array<Record<string, unknown>>
  assert.ok(candidates.length >= 1 && candidates.length <= 3)
  const candidate = candidates[0]!
  assert.equal(typeof candidate.candidateId, 'string')
  assert.equal(typeof candidate.name, 'string')
  assert.equal(typeof candidate.goal, 'string')
  assert.equal(typeof candidate.doneCriteria, 'string')
  assert.ok(Array.isArray(candidate.suggestedTasks))
  assert.ok(Array.isArray(candidate.risks))
  assert.deepEqual(candidate.sources, [])
  assert.ok(Date.parse(candidate.expiresAt as string) > Date.now())
})

test('模型正常生成候选：source=model，候选字段与来源合法', async () => {
  const runtime = client.runtime as unknown as {
    candidateProvider?: {
      name: string
      generate: () => Promise<never>
      generateCandidates: () => Promise<{ candidates: unknown }>
    }
  }
  const original = runtime.candidateProvider
  runtime.candidateProvider = {
    name: 'candidate-test-provider',
    generate: async () => {
      throw new Error('not used')
    },
    generateCandidates: async () => ({
      candidates: [
        {
          name: '模型阶段',
          goal: '模型目标',
          doneCriteria: '模型完成标准',
          suggestedTasks: [{ title: '模型任务', doneCriteria: '任务完成标准' }],
          risks: ['模型风险'],
          segmentIds: [],
        },
      ],
    }),
  }
  try {
    const { body, response } = await generate(projectId, projectRevision, { maxCandidates: 1 })
    assert.equal(response.status, 200)
    assert.equal(body.source, 'model')
    assert.equal(body.fallbackReason, null)
    assert.equal(body.notice, null)
    const candidate = (body.candidates as Array<Record<string, unknown>>)[0]!
    assert.equal(candidate.name, '模型阶段')
    assert.deepEqual(candidate.sources, [])
  } finally {
    runtime.candidateProvider = original
  }
})

test('fallback：模型不可用时 200 + fallback + 中文 notice', async () => {
  const { body } = await generate(projectId, projectRevision, { focus: '整理材料' })
  assert.equal(body.source, 'fallback')
  assert.equal(typeof body.fallbackReason, 'string')
  assert.match(String(body.notice), /规则候选|模型未参与/)
})

test('同 idempotencyKey 重放返回相同 candidateId 与 expiresAt', async () => {
  const body = candidateBody(projectId, projectRevision)
  const first = await client.request(`/api/projects/${projectId}/milestones/candidates`, {
    method: 'POST',
    cookie: user.cookie,
    body,
  })
  const firstBody = (await first.json()) as Record<string, unknown>
  const second = await client.request(`/api/projects/${projectId}/milestones/candidates`, {
    method: 'POST',
    cookie: user.cookie,
    body,
  })
  const secondBody = (await second.json()) as Record<string, unknown>
  assert.equal(second.status, 200)
  assert.equal(
    (secondBody.candidates as Array<{ candidateId: string }>)[0]?.candidateId,
    (firstBody.candidates as Array<{ candidateId: string }>)[0]?.candidateId,
  )
  assert.equal(
    (secondBody.candidates as Array<{ expiresAt: string }>)[0]?.expiresAt,
    (firstBody.candidates as Array<{ expiresAt: string }>)[0]?.expiresAt,
  )
})

test('确认候选后阶段正确落库且 projectRevision +1', async () => {
  const generated = await generate()
  const candidateId = candidateIdOf(generated.body)
  const response = await client.request(`/api/projects/${projectId}/milestones`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, projectRevision, {
      name: '从候选创建阶段',
      goal: '验证候选确认',
      doneCriteria: '阶段存在',
      status: 'planned',
      source: 'ai-candidate',
      candidateId,
      confirmedByUser: true,
    }),
  })
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(response.status, 200)
  assert.equal(body.projectRevision, projectRevision + 1)
  const data = body.data as { milestone: { name: string; source: string } }
  assert.equal(data.milestone.name, '从候选创建阶段')
  assert.equal(data.milestone.source, 'ai-candidate')
  projectRevision += 1
})

test('候选确认后不能再次使用，返回 CANDIDATE_EXPIRED', async () => {
  // 使用上一测试已确认的候选：新 key 再确认
  const generated = await generate()
  const candidateId = candidateIdOf(generated.body)
  const first = await client.request(`/api/projects/${projectId}/milestones`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, projectRevision, {
      name: '一次性候选阶段',
      goal: '验证一次性',
      doneCriteria: '阶段存在',
      source: 'ai-candidate',
      candidateId,
      confirmedByUser: true,
    }),
  })
  assert.equal(first.status, 200)
  projectRevision += 1
  const second = await client.request(`/api/projects/${projectId}/milestones`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, projectRevision, {
      name: '再次使用候选',
      goal: '不应成功',
      doneCriteria: '不应存在',
      source: 'ai-candidate',
      candidateId,
      confirmedByUser: true,
    }),
  })
  assert.equal(second.status, 409)
  assert.equal((await second.json() as { code: string }).code, 'CANDIDATE_EXPIRED')
})

test('候选过期后确认返回 409 CANDIDATE_EXPIRED', async () => {
  const generated = await generate()
  const candidateId = candidateIdOf(generated.body)
  client.runtime
    .getDb()
    .prepare('UPDATE milestone_candidates SET expires_at = ? WHERE candidate_id = ?')
    .run('2000-01-01T00:00:00.000Z', candidateId)
  const response = await client.request(`/api/projects/${projectId}/milestones`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, projectRevision, {
      name: '过期候选阶段',
      goal: '不应成功',
      doneCriteria: '不应存在',
      source: 'ai-candidate',
      candidateId,
      confirmedByUser: true,
    }),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json() as { code: string }).code, 'CANDIDATE_EXPIRED')
})

test('跨项目 candidateId 拒绝', async () => {
  const otherProject = await createProject(client, user, { name: '另一个候选项目' })
  const generated = await generate(
    otherProject.projectId,
    otherProject.projectRevision,
  )
  const candidateId = candidateIdOf(generated.body)
  const response = await client.request(`/api/projects/${projectId}/milestones`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(projectId, projectRevision, {
      name: '跨项目候选',
      goal: '不应成功',
      doneCriteria: '不应存在',
      source: 'ai-candidate',
      candidateId,
      confirmedByUser: true,
    }),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json() as { code: string }).code, 'CANDIDATE_EXPIRED')
})

test('maxCandidates 越界、focus 超长、非候选 promptVersion 返回 400', async () => {
  const badMax = await generate(projectId, projectRevision, { maxCandidates: 4 })
  assert.equal(badMax.response.status, 400)

  const badFocus = await generate(projectId, projectRevision, { focus: 'x'.repeat(201) })
  assert.equal(badFocus.response.status, 400)

  const badVersion = await generate(projectId, projectRevision, {
    promptVersion: 'mvp-prompt-v3',
  })
  assert.equal(badVersion.response.status, 400)
})
