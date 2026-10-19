import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthRateLimiter, resolveClientIp } from '../src/v3/rateLimiter.js'
import { sanitizeLogFields } from '../src/v3/logger.js'
import {
  TestClient,
  createMilestone,
  createProject,
  createTask,
  createTestClient,
  envelope,
  registerBody,
  registerUser,
  sessionFrom,
  uuid,
  PASSWORD,
} from './v3-support.js'

/**
 * 合并前缺陷回归：
 * - 跨操作/跨实体/跨 method 幂等
 * - 注册重试恢复与会话失败回滚
 * - 归档阶段绕过
 * - 限流并发/窗口/清理
 * - 日志探针
 * - 同名阶段恢复
 * - 迁移 originalText
 */

let client: TestClient

before(async () => {
  client = await createTestClient()
})

after(async () => {
  await client.close()
})

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

async function projectRevisionOf(projectId: string, cookie: string): Promise<number> {
  const response = await client.request(`/api/projects/${projectId}`, { cookie })
  const body = (await response.json()) as { projectRevision: number }
  return body.projectRevision
}

function count(sql: string, ...params: Array<string | number>): number {
  return (
    client.runtime.getDb().prepare(sql).get(...params) as { count: number }
  ).count
}

/* ------------------------------------------------------- 幂等指纹绑定 */

test('同一 key 跨 action 返回 IDEMPOTENCY_CONFLICT，不误重放 activate 结果', async () => {
  const user = await registerUser(client, { account: `idem_action_${Date.now()}` })
  const project = await createProject(client, user)
  const milestone = await createMilestone(client, user, project.projectId, project.projectRevision, {
    name: '跨操作阶段',
  })
  const sharedBody = envelope(project.projectId, milestone.projectRevision, {
    expectedRevision: milestone.revision,
  })

  const activate = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/activate`,
    { method: 'POST', cookie: user.cookie, body: sharedBody },
  )
  assert.equal(activate.status, 200)
  const activated = (await activate.json()) as { projectRevision: number }

  const archive = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/archive`,
    { method: 'POST', cookie: user.cookie, body: sharedBody },
  )
  const archiveBody = await jsonOf(archive)
  assert.equal(archive.status, 409)
  assert.equal(archiveBody.code, 'IDEMPOTENCY_CONFLICT')

  const list = await client.request(`/api/projects/${project.projectId}/milestones`, {
    cookie: user.cookie,
  })
  const listBody = (await list.json()) as {
    data: { milestones: Array<{ status: string; revision: number }> }
    projectRevision: number
  }
  assert.equal(listBody.data.milestones[0]?.status, 'active')
  assert.equal(listBody.data.milestones[0]?.revision, milestone.revision + 1)
  assert.equal(listBody.projectRevision, activated.projectRevision)
})

test('同一 key 跨实体返回冲突，资源目标不同的成功响应不会串用', async () => {
  const user = await registerUser(client, { account: `idem_entity_${Date.now()}` })
  const project = await createProject(client, user)
  const first = await createTask(client, user, project.projectId, project.projectRevision, {
    title: '任务甲',
  })
  const second = await createTask(client, user, project.projectId, first.projectRevision, {
    title: '任务乙',
  })

  const body = envelope(project.projectId, second.projectRevision, {
    expectedRevision: first.revision,
    title: '改名甲',
  })
  const patchFirst = await client.request(
    `/api/projects/${project.projectId}/tasks/${first.taskId}`,
    { method: 'PATCH', cookie: user.cookie, body },
  )
  assert.equal(patchFirst.status, 200)

  const patchSecond = await client.request(
    `/api/projects/${project.projectId}/tasks/${second.taskId}`,
    { method: 'PATCH', cookie: user.cookie, body },
  )
  const conflict = await jsonOf(patchSecond)
  assert.equal(patchSecond.status, 409)
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT')

  const db = client.runtime.getDb()
  const secondRow = db
    .prepare('SELECT title, revision FROM tasks WHERE task_id = ?')
    .get(second.taskId) as { title: string; revision: number }
  assert.equal(secondRow.title, '任务乙')
  assert.equal(secondRow.revision, 1)
})

test('同一 key 跨 method/操作返回冲突，正常重试仍重放', async () => {
  const user = await registerUser(client, { account: `idem_method_${Date.now()}` })
  const project = await createProject(client, user)
  const milestone = await createMilestone(client, user, project.projectId, project.projectRevision, {
    name: '跨方法阶段',
  })

  const postBody = envelope(project.projectId, milestone.projectRevision, {
    expectedRevision: milestone.revision,
    goal: '通过 POST 完成',
  })
  const complete = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/complete`,
    { method: 'POST', cookie: user.cookie, body: postBody },
  )
  assert.equal(complete.status, 200)

  const patch = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}`,
    { method: 'PATCH', cookie: user.cookie, body: postBody },
  )
  assert.equal(patch.status, 409)
  assert.equal((await jsonOf(patch)).code, 'IDEMPOTENCY_CONFLICT')

  const retry = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/complete`,
    { method: 'POST', cookie: user.cookie, body: postBody },
  )
  const replay = (await retry.json()) as { replayed: boolean; projectRevision: number }
  assert.equal(retry.status, 200)
  assert.equal(replay.replayed, true)
})

/* ------------------------------------------------------- 注册恢复与会话 */

test('注册响应丢失后同 key 重试：验证密码和邀请码后恢复登录', async () => {
  const body = registerBody({ account: `recover_${Date.now()}` })
  const first = await client.request('/api/auth/register', { method: 'POST', body })
  assert.equal(first.status, 200)
  const firstCookie = sessionFrom(first)
  const firstBody = (await first.json()) as { user: { userId: string }; replayed?: boolean }
  assert.equal(firstBody.replayed, false)

  const retry = await client.request('/api/auth/register', { method: 'POST', body })
  assert.equal(retry.status, 200)
  const retryBody = (await retry.json()) as {
    user: { userId: string }
    replayed: boolean
    recovered: boolean
  }
  const retryCookie = sessionFrom(retry)
  assert.equal(retryBody.user.userId, firstBody.user.userId)
  assert.equal(retryBody.replayed, true)
  assert.equal(retryBody.recovered, true)
  assert.notEqual(retryCookie, firstCookie)

  const me = await client.request('/api/auth/me', { cookie: retryCookie })
  assert.equal(me.status, 200)

  const changedDisplay = await client.request('/api/auth/register', {
    method: 'POST',
    body: { ...body, displayName: '李同学' },
  })
  assert.equal(changedDisplay.status, 409)
  assert.equal((await jsonOf(changedDisplay)).code, 'IDEMPOTENCY_CONFLICT')

  const counts = client.runtime
    .getDb()
    .prepare('SELECT COUNT(*) AS count FROM users WHERE account_normalized = ?')
    .get((body.account as string).toLowerCase()) as { count: number }
  assert.equal(counts.count, 1)
})

test('注册重试携带错误密码或错误邀请码被拒绝，不签发会话', async () => {
  const body = registerBody({ account: `recover_bad_${Date.now()}` })
  const first = await client.request('/api/auth/register', { method: 'POST', body })
  assert.equal(first.status, 200)

  const wrongPassword = await client.request('/api/auth/register', {
    method: 'POST',
    body: { ...body, password: 'wrong-password-123' },
  })
  assert.equal(wrongPassword.status, 409)
  assert.equal((await jsonOf(wrongPassword)).code, 'REGISTER_REJECTED')
  assert.equal(wrongPassword.headers.get('set-cookie'), null)

  const wrongInvite = await client.request('/api/auth/register', {
    method: 'POST',
    body: { ...body, inviteCode: 'WRONG-INVITE-CODE' },
  })
  assert.equal(wrongInvite.status, 409)
  assert.equal((await jsonOf(wrongInvite)).code, 'REGISTER_REJECTED')
  assert.equal(wrongInvite.headers.get('set-cookie'), null)

  const duplicateNewKey = await client.request('/api/auth/register', {
    method: 'POST',
    body: { ...body, idempotencyKey: `register-${uuid().slice(0, 20)}` },
  })
  assert.equal(duplicateNewKey.status, 409)
  assert.equal((await jsonOf(duplicateNewKey)).code, 'REGISTER_REJECTED')
})

test('登录轮换会话失败时整体回滚，旧会话仍然可用', async () => {
  const user = await registerUser(client, { account: `rollback_${Date.now()}` })
  const db = client.runtime.getDb()
  db.exec(
    "CREATE TRIGGER fail_session_insert BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'forced'); END",
  )
  try {
    const login = await client.request('/api/auth/login', {
      method: 'POST',
      cookie: user.cookie,
      body: {
        contractVersion: '3.0',
        requestId: uuid(),
        account: user.account,
        password: PASSWORD,
      },
    })
    assert.equal(login.status, 500)
    assert.equal((await jsonOf(login)).code, 'INTERNAL')

    const oldSession = await client.request('/api/auth/me', { cookie: user.cookie })
    assert.equal(oldSession.status, 200)
    const sessions = db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND status = 'active'")
      .get(user.userId) as { count: number }
    assert.equal(sessions.count, 1)
  } finally {
    db.exec('DROP TRIGGER fail_session_insert')
  }
})

/* ------------------------------------------------------------- 限流 */

test('并发错误登录在 bcrypt 前预占预算，超限直接 429；窗口后可恢复', async () => {
  const limiterClient = await createTestClient({
    rateLimit: { maxAccountAttempts: 5, maxIpAttempts: 100, windowMs: 600, maxEntries: 100 },
  })
  try {
    const user = await registerUser(limiterClient, { account: `burst_${Date.now()}` })
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        limiterClient.request('/api/auth/login', {
          method: 'POST',
          body: {
            contractVersion: '3.0',
            requestId: uuid(),
            account: user.account,
            password: 'wrong-password-123',
          },
        }),
      ),
    )
    const statuses = attempts.map((response) => response.status)
    assert.equal(statuses.filter((status) => status === 401).length, 5)
    assert.equal(statuses.filter((status) => status === 429).length, 3)

    const rateLimited = attempts.find((response) => response.status === 429)
    const rateBody = (await rateLimited?.json()) as { code: string; retryAfterSeconds: number }
    assert.equal(rateBody.code, 'RATE_LIMITED')
    assert.ok(rateBody.retryAfterSeconds > 0)

    await new Promise((resolve) => setTimeout(resolve, 700))
    const recovered = await limiterClient.request('/api/auth/login', {
      method: 'POST',
      body: {
        contractVersion: '3.0',
        requestId: uuid(),
        account: user.account,
        password: PASSWORD,
      },
    })
    assert.equal(recovered.status, 200)
  } finally {
    await limiterClient.close()
  }
})

test('持续更换账号受 IP 预算约束', async () => {
  const limiterClient = await createTestClient({
    rateLimit: { maxAccountAttempts: 5, maxIpAttempts: 3, windowMs: 5_000, maxEntries: 100 },
  })
  try {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        limiterClient.request('/api/auth/login', {
          method: 'POST',
          body: {
            contractVersion: '3.0',
            requestId: uuid(),
            account: `spray_${index}_${Date.now()}`,
            password: 'wrong-password-123',
          },
        }),
      ),
    )
    const statuses = attempts.map((response) => response.status)
    assert.equal(statuses.filter((status) => status === 401).length, 3)
    assert.equal(statuses.filter((status) => status === 429).length, 3)
  } finally {
    await limiterClient.close()
  }
})

test('默认不信任 X-Forwarded-For，只有显式可信跳数才使用', () => {
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.8' },
  } as unknown as Parameters<typeof resolveClientIp>[0]
  assert.equal(resolveClientIp(request, 0), '127.0.0.1')
  assert.equal(resolveClientIp(request, 1), '198.51.100.8')
  assert.equal(resolveClientIp(request, 2), '203.0.113.9')

  const spoofed = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': 'not-an-ip, 999.999.999.999' },
  } as unknown as Parameters<typeof resolveClientIp>[0]
  assert.equal(resolveClientIp(spoofed, 1), '127.0.0.1')
})

test('限流记录有容量上限并清理过期项', () => {
  const limiter = new AuthRateLimiter({
    maxAccountAttempts: 100,
    maxIpAttempts: 100,
    windowMs: 50,
    maxEntries: 2,
  })
  for (let index = 0; index < 10; index += 1) {
    limiter.reserve('10.0.0.1', `account_${index}`, 1000 + index)
  }
  assert.ok(limiter.size <= 2)

  limiter.reserve('10.0.0.2', 'new_account', 2000)
  assert.ok(limiter.size <= 2)
})

/* ------------------------------------------------------------- 日志探针 */

test('非法 requestId 与未知 auth 路径不把客户端文字写进日志', async () => {
  const probe = 'PROBE_SECRET_<script>alert(1)</script>'
  const invalid = await client.request('/api/auth/register', {
    method: 'POST',
    body: {
      ...registerBody(),
      requestId: probe,
    },
  })
  assert.equal(invalid.status, 400)

  const unknownPath = await client.request(`/api/auth/${encodeURIComponent(probe)}`, {
    method: 'POST',
    body: { contractVersion: '3.0', requestId: uuid() },
  })
  assert.equal(unknownPath.status, 404)

  const logs = client.logger.text()
  assert.equal(logs.includes('PROBE_SECRET'), false)
  assert.equal(logs.includes('<script>'), false)
  assert.equal(logs.includes('/api/auth/'), false)
  assert.equal(logs.includes('auth.unknown'), true)
})

test('日志字段有长度边界且不会序列化对象', () => {
  const sanitized = sanitizeLogFields({
    category: 'auth.register',
    long: 'x'.repeat(1000),
    nested: { password: 'secret' } as never,
    'bad key': 'value',
  })
  assert.equal(sanitized?.category, 'auth.register')
  assert.equal((sanitized?.long as string).length, 120)
  assert.equal(sanitized?.nested, null)
  assert.equal(sanitized?.['bad key'], undefined)
})

/* --------------------------------------------------- 归档阶段绕过 */

test('任务属于归档阶段时，漏传 milestoneId 也不能提交证据或完成任务', async () => {
  const user = await registerUser(client, { account: `archive_bypass_${Date.now()}` })
  const project = await createProject(client, user)
  const milestone = await createMilestone(client, user, project.projectId, project.projectRevision, {
    name: '已归档阶段',
  })
  const task = await createTask(client, user, project.projectId, milestone.projectRevision, {
    title: '阶段内任务',
    milestoneId: milestone.milestoneId,
  })

  const archive = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/archive`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, task.projectRevision, {
        expectedRevision: milestone.revision,
      }),
    },
  )
  const archived = (await archive.json()) as { projectRevision: number }
  assert.equal(archive.status, 200)

  const beforeEvidence = count('SELECT COUNT(*) AS count FROM evidence WHERE project_id = ?', project.projectId)
  const beforeDoubt = count('SELECT COUNT(*) AS count FROM doubts WHERE project_id = ?', project.projectId)

  const evidence = await client.request(`/api/projects/${project.projectId}/evidence`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(project.projectId, archived.projectRevision, {
      taskId: task.taskId,
      milestoneId: null,
      didWhat: '试图绕过归档',
      stillUnsure: '不应写入',
      completeTask: true,
      expectedTaskRevision: task.revision,
    }),
  })
  assert.equal(evidence.status, 409)
  assert.equal((await jsonOf(evidence)).code, 'MILESTONE_ARCHIVED')

  assert.equal(count('SELECT COUNT(*) AS count FROM evidence WHERE project_id = ?', project.projectId), beforeEvidence)
  assert.equal(count('SELECT COUNT(*) AS count FROM doubts WHERE project_id = ?', project.projectId), beforeDoubt)
  const taskRow = client.runtime
    .getDb()
    .prepare('SELECT status, revision FROM tasks WHERE task_id = ?')
    .get(task.taskId) as { status: string; revision: number }
  assert.equal(taskRow.status, 'todo')
  assert.equal(taskRow.revision, task.revision)
  assert.equal(
    await projectRevisionOf(project.projectId, user.cookie),
    archived.projectRevision,
  )
})

test('任务阶段与显式 milestoneId 不一致时拒绝，且不留部分写入', async () => {
  const user = await registerUser(client, { account: `stage_mismatch_${Date.now()}` })
  const project = await createProject(client, user)
  const first = await createMilestone(client, user, project.projectId, project.projectRevision, {
    name: '阶段一',
  })
  const second = await createMilestone(client, user, project.projectId, first.projectRevision, {
    name: '阶段二',
  })
  const task = await createTask(client, user, project.projectId, second.projectRevision, {
    title: '属于阶段一',
    milestoneId: first.milestoneId,
  })

  const before = count('SELECT COUNT(*) AS count FROM evidence WHERE project_id = ?', project.projectId)
  const response = await client.request(`/api/projects/${project.projectId}/evidence`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(project.projectId, task.projectRevision, {
      taskId: task.taskId,
      milestoneId: second.milestoneId,
      didWhat: '跨阶段提交',
    }),
  })
  assert.equal(response.status, 400)
  assert.equal((await jsonOf(response)).code, 'INVALID_INPUT')
  assert.equal(count('SELECT COUNT(*) AS count FROM evidence WHERE project_id = ?', project.projectId), before)
  assert.equal(await projectRevisionOf(project.projectId, user.cookie), task.projectRevision)
})

test('证据重新关联和进展更正同样不能绕过任务已归档阶段', async () => {
  const user = await registerUser(client, { account: `archive_links_${Date.now()}` })
  const project = await createProject(client, user)
  const milestone = await createMilestone(client, user, project.projectId, project.projectRevision, {
    name: '关联归档阶段',
  })
  const task = await createTask(client, user, project.projectId, milestone.projectRevision, {
    title: '关联任务',
    milestoneId: milestone.milestoneId,
  })
  const evidence = await client.request(`/api/projects/${project.projectId}/evidence`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(project.projectId, task.projectRevision, {
      taskId: task.taskId,
      didWhat: '归档前证据',
    }),
  })
  const evidenceBody = (await evidence.json()) as {
    projectRevision: number
    data: { evidence: { evidenceId: string; revision: number; milestoneNameSnapshot: string } }
  }
  const progress = await client.request(`/api/projects/${project.projectId}/progress`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(project.projectId, evidenceBody.projectRevision, {
      summary: '归档前进展',
      taskId: task.taskId,
      milestoneId: milestone.milestoneId,
    }),
  })
  const progressBody = (await progress.json()) as {
    projectRevision: number
    data: { progress: { progressId: string; revision: number } }
  }

  const archive = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/archive`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, progressBody.projectRevision, {
        expectedRevision: milestone.revision,
      }),
    },
  )
  const archived = (await archive.json()) as { projectRevision: number }
  assert.equal(archive.status, 200)

  const relink = await client.request(
    `/api/projects/${project.projectId}/evidence/${evidenceBody.data.evidence.evidenceId}/links`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, archived.projectRevision, {
        expectedRevision: evidenceBody.data.evidence.revision,
        taskId: task.taskId,
        milestoneId: null,
      }),
    },
  )
  assert.equal(relink.status, 409)
  assert.equal((await jsonOf(relink)).code, 'MILESTONE_ARCHIVED')

  const progressCountBefore = count(
    'SELECT COUNT(*) AS count FROM progress_records WHERE project_id = ?',
    project.projectId,
  )
  const newProgress = await client.request(`/api/projects/${project.projectId}/progress`, {
    method: 'POST',
    cookie: user.cookie,
    body: envelope(project.projectId, archived.projectRevision, {
      taskId: task.taskId,
      milestoneId: null,
      summary: '归档后新增进展',
    }),
  })
  assert.equal(newProgress.status, 409)
  assert.equal((await jsonOf(newProgress)).code, 'MILESTONE_ARCHIVED')
  assert.equal(
    count('SELECT COUNT(*) AS count FROM progress_records WHERE project_id = ?', project.projectId),
    progressCountBefore,
  )

  const supersede = await client.request(
    `/api/projects/${project.projectId}/progress/${progressBody.data.progress.progressId}/supersede`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, archived.projectRevision, {
        expectedRevision: progressBody.data.progress.revision,
        taskId: task.taskId,
        milestoneId: null,
        summary: '归档后更正',
      }),
    },
  )
  assert.equal(supersede.status, 409)
  assert.equal((await jsonOf(supersede)).code, 'MILESTONE_ARCHIVED')

  const progressRow = client.runtime
    .getDb()
    .prepare('SELECT status, revision, summary FROM progress_records WHERE progress_id = ?')
    .get(progressBody.data.progress.progressId) as {
    status: string
    revision: number
    summary: string
  }
  assert.equal(progressRow.status, 'active')
  assert.equal(progressRow.revision, progressBody.data.progress.revision)
  assert.equal(progressRow.summary, '归档前进展')

  const evidenceRow = client.runtime
    .getDb()
    .prepare('SELECT milestone_name_snapshot FROM evidence WHERE evidence_id = ?')
    .get(evidenceBody.data.evidence.evidenceId) as { milestone_name_snapshot: string }
  assert.equal(evidenceRow.milestone_name_snapshot, '关联归档阶段')
  assert.equal(await projectRevisionOf(project.projectId, user.cookie), archived.projectRevision)
})

/* ------------------------------------------- 同名阶段恢复冲突 */

test('恢复归档阶段遇到同名阶段返回 409，改名后可恢复', async () => {
  const user = await registerUser(client, { account: `restore_conflict_${Date.now()}` })
  const project = await createProject(client, user)
  const oldMilestone = await createMilestone(client, user, project.projectId, project.projectRevision, {
    name: '同名阶段',
  })
  const archive = await client.request(
    `/api/projects/${project.projectId}/milestones/${oldMilestone.milestoneId}/archive`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, oldMilestone.projectRevision, {
        expectedRevision: oldMilestone.revision,
      }),
    },
  )
  const archived = (await archive.json()) as { projectRevision: number }
  assert.equal(archive.status, 200)

  const newMilestone = await createMilestone(client, user, project.projectId, archived.projectRevision, {
    name: '同名阶段',
  })

  const projectBefore = await projectRevisionOf(project.projectId, user.cookie)
  const restoreBody = envelope(project.projectId, projectBefore, {
    expectedRevision: oldMilestone.revision + 1,
  })
  const restore = await client.request(
    `/api/projects/${project.projectId}/milestones/${oldMilestone.milestoneId}/restore`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: restoreBody,
    },
  )
  assert.equal(restore.status, 409)
  assert.equal((await jsonOf(restore)).code, 'MILESTONE_NAME_CONFLICT')
  assert.equal(await projectRevisionOf(project.projectId, user.cookie), projectBefore)

  const failedAgain = await client.request(
    `/api/projects/${project.projectId}/milestones/${oldMilestone.milestoneId}/restore`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: restoreBody,
    },
  )
  assert.equal(failedAgain.status, 409)
  assert.equal((await jsonOf(failedAgain)).code, 'MILESTONE_NAME_CONFLICT')

  const db = client.runtime.getDb()
  const oldRow = db
    .prepare('SELECT status, revision FROM milestones WHERE milestone_id = ?')
    .get(oldMilestone.milestoneId) as { status: string; revision: number }
  assert.equal(oldRow.status, 'archived')
  assert.equal(oldRow.revision, oldMilestone.revision + 1)

  const rename = await client.request(
    `/api/projects/${project.projectId}/milestones/${newMilestone.milestoneId}`,
    {
      method: 'PATCH',
      cookie: user.cookie,
      body: envelope(project.projectId, projectBefore, {
        expectedRevision: newMilestone.revision,
        name: '同名阶段-新',
      }),
    },
  )
  assert.equal(rename.status, 200)
  const renamed = (await rename.json()) as { projectRevision: number }

  const retry = await client.request(
    `/api/projects/${project.projectId}/milestones/${oldMilestone.milestoneId}/restore`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: envelope(project.projectId, renamed.projectRevision, {
        expectedRevision: oldMilestone.revision + 1,
      }),
    },
  )
  const retried = (await retry.json()) as { data: { milestone: { status: string } } }
  assert.equal(retry.status, 200)
  assert.equal(retried.data.milestone.status, 'planned')
})

/* ------------------------------------------- 迁移 originalText */

test('迁移分别保留 text/originalText，undo 按原文比较回到 pending 或 modified', async () => {
  const user = await registerUser(client, { account: `migrate_original_${Date.now()}` })
  const migrationId = `mig_${uuid().replace(/-/g, '').slice(0, 24)}`
  const payload = {
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: `migrate-${uuid().slice(0, 22)}`,
    migrationId,
    userConfirmed: true,
    userConfirmedAt: new Date().toISOString(),
    source: {
      schemaVersion: 3,
      clientProjectId: `prj_orig_${uuid().replace(/-/g, '').slice(0, 16)}`,
    },
    localProject: {
      name: '原文迁移项目',
      short: '原文',
      projectRevision: 3,
      profile: { goal: null, expectedOutcome: null, memberNames: [], researchPeriod: null, scope: null, outOfScope: null },
      milestones: [],
      tasks: [],
      evidence: [],
      progress: [],
      doubts: [],
      materials: [
        {
          clientId: 'mat_orig_1',
          name: '理解.md',
          type: 'md',
          size: 100,
          encoding: 'utf-8',
          status: 'parsed',
          version: 1,
          createdAt: '2026-10-19T00:00:00.000Z',
          updatedAt: '2026-10-19T00:00:00.000Z',
          segments: [{ segmentId: 'seg_0', index: 0, startLine: 1, endLine: 2, text: '原文' }],
          understandingItems: [
            {
              clientId: 'item_modified',
              kind: 'goalCandidates',
              text: '学生改过的文本',
              originalText: '原始文本',
              sourceSegmentIds: ['seg_0'],
              status: 'confirmed',
            },
            {
              clientId: 'item_unchanged',
              kind: 'goalCandidates',
              text: '原始文本',
              originalText: '原始文本',
              sourceSegmentIds: ['seg_0'],
              status: 'confirmed',
            },
            {
              clientId: 'item_legacy',
              kind: 'goalCandidates',
              text: '旧数据文本',
              sourceSegmentIds: ['seg_0'],
              status: 'confirmed',
            },
          ],
        },
      ],
      chats: [],
    },
  }

  const migrated = await client.request('/api/projects/migrate-local', {
    method: 'POST',
    cookie: user.cookie,
    body: payload,
  })
  const migratedBody = (await migrated.json()) as {
    projectId: string
    idMap: { materials: Record<string, string>; understandingItems: Record<string, string> }
    warnings: Array<{ code: string }>
  }
  assert.equal(migrated.status, 200)
  assert.equal(
    migratedBody.warnings.some((warning) => warning.code === 'UNDERSTANDING_ORIGINAL_TEXT_MISSING'),
    true,
  )

  const db = client.runtime.getDb()
  const modifiedId = migratedBody.idMap.understandingItems.item_modified as string
  const unchangedId = migratedBody.idMap.understandingItems.item_unchanged as string
  const legacyId = migratedBody.idMap.understandingItems.item_legacy as string
  const modifiedRow = db
    .prepare('SELECT text, original_text, status FROM understanding_items WHERE item_id = ?')
    .get(modifiedId) as { text: string; original_text: string; status: string }
  const unchangedRow = db
    .prepare('SELECT text, original_text, status FROM understanding_items WHERE item_id = ?')
    .get(unchangedId) as { text: string; original_text: string; status: string }
  const legacyRow = db
    .prepare('SELECT text, original_text, status FROM understanding_items WHERE item_id = ?')
    .get(legacyId) as { text: string; original_text: string; status: string }

  assert.equal(modifiedRow.text, '学生改过的文本')
  assert.equal(modifiedRow.original_text, '原始文本')
  assert.equal(modifiedRow.status, 'confirmed')
  assert.equal(unchangedRow.original_text, '原始文本')
  assert.equal(legacyRow.original_text, '旧数据文本')
  assert.equal(legacyRow.status, 'pending')

  const materialId = migratedBody.idMap.materials.mat_orig_1 as string
  const undoBody = (itemId: string, projectRevision: number): Record<string, unknown> => ({
    contractVersion: '3.0',
    requestId: uuid(),
    idempotencyKey: `undo-${uuid().slice(0, 24)}`,
    projectId: migratedBody.projectId,
    projectRevision,
    materialVersion: 1,
    itemId,
    expectedRevision: 1,
  })

  const undoModified = await client.request(
    `/api/projects/${migratedBody.projectId}/materials/${materialId}/understanding/items/${modifiedId}/undo`,
    { method: 'POST', cookie: user.cookie, body: undoBody(modifiedId, 1) },
  )
  const undoModifiedBody = (await undoModified.json()) as {
    projectRevision: number
    data: { item: { status: string; revision: number } }
  }
  assert.equal(undoModified.status, 200)
  assert.equal(undoModifiedBody.data.item.status, 'modified')
  assert.equal(undoModifiedBody.data.item.revision, 2)

  const undoUnchanged = await client.request(
    `/api/projects/${migratedBody.projectId}/materials/${materialId}/understanding/items/${unchangedId}/undo`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: undoBody(unchangedId, undoModifiedBody.projectRevision),
    },
  )
  const undoUnchangedBody = (await undoUnchanged.json()) as {
    projectRevision: number
    data: { item: { status: string } }
  }
  assert.equal(undoUnchanged.status, 200)
  assert.equal(undoUnchangedBody.data.item.status, 'pending')

  const undoLegacy = await client.request(
    `/api/projects/${migratedBody.projectId}/materials/${materialId}/understanding/items/${legacyId}/undo`,
    {
      method: 'POST',
      cookie: user.cookie,
      body: undoBody(legacyId, undoUnchangedBody.projectRevision),
    },
  )
  const undoLegacyBody = (await undoLegacy.json()) as {
    projectRevision: number
    data: { changed: boolean; item: { status: string } }
  }
  assert.equal(undoLegacy.status, 200)
  assert.equal(undoLegacyBody.data.changed, false)
  assert.equal(undoLegacyBody.data.item.status, 'pending')
  assert.equal(undoLegacyBody.projectRevision, undoUnchangedBody.projectRevision)
})
