import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TestClient,
  createMilestone,
  createProject,
  createTask,
  createTestClient,
  envelope,
  getProjectRevision,
  registerUser,
  uuid,
  type LoggedInUser,
} from './v3-support.js'

/**
 * 项目隔离、阶段状态机、任务关联与统计（契约 22.1～22.3）
 */

let client: TestClient
let alice: LoggedInUser
let bob: LoggedInUser

before(async () => {
  client = await createTestClient()
  alice = await registerUser(client, { account: 'alice_2026' })
  bob = await registerUser(client, { account: 'bob_2026' })
})

after(async () => {
  await client.close()
})

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

test('用户 A 无法读取或写入用户 B 的项目', async () => {
  const project = await createProject(client, alice)
  const read = await client.request(`/api/projects/${project.projectId}`, { cookie: bob.cookie })
  const readBody = await jsonOf(read)
  assert.equal(read.status, 404)
  assert.equal(readBody.code, 'PROJECT_NOT_FOUND')

  const write = await client.request(`/api/projects/${project.projectId}/milestones`, {
    method: 'POST',
    cookie: bob.cookie,
    body: envelope(project.projectId, project.projectRevision, { name: '越权阶段' }),
  })
  assert.equal(write.status, 404)
  assert.equal((await jsonOf(write)).code, 'PROJECT_NOT_FOUND')

  const list = await client.request('/api/projects', { cookie: bob.cookie })
  const listBody = (await list.json()) as { data: { projects: Array<{ projectId: string }> } }
  assert.equal(listBody.data.projects.some((item) => item.projectId === project.projectId), false)

  // 同一用户跨项目引用实体也必须拒绝
  const otherProject = await createProject(client, alice, { name: '另一个项目' })
  const foreignMilestone = await createMilestone(
    client,
    alice,
    otherProject.projectId,
    otherProject.projectRevision,
    { name: '另一个项目的阶段' },
  )
  const crossProjectTask = await client.request(`/api/projects/${project.projectId}/tasks`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, project.projectRevision, {
      title: '跨项目阶段引用',
      milestoneId: foreignMilestone.milestoneId,
    }),
  })
  assert.equal(crossProjectTask.status, 404)
  assert.equal((await jsonOf(crossProjectTask)).code, 'RESOURCE_NOT_FOUND')
})

test('创建项目为空白项目，不自动注入阶段或任务', async () => {
  const project = await createProject(client, alice)
  const response = await client.request(`/api/projects/${project.projectId}`, { cookie: alice.cookie })
  const body = (await response.json()) as {
    data: { project: { milestones: unknown[]; taskStats: { total: number }; currentMilestoneId: string | null } }
  }
  assert.deepEqual(body.data.project.milestones, [])
  assert.equal(body.data.project.taskStats.total, 0)
  assert.equal(body.data.project.currentMilestoneId, null)
})

test('阶段：创建、编辑、激活、完成、重开、归档、恢复', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '数据获取与预处理',
  })
  assert.equal(milestone.projectRevision, 2)

  const patch = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}`,
    {
      method: 'PATCH',
      cookie: alice.cookie,
      body: envelope(project.projectId, milestone.projectRevision, {
        expectedRevision: milestone.revision,
        goal: '拿到可复现的样例数据',
      }),
    },
  )
  assert.equal(patch.status, 200)
  const patched = (await patch.json()) as {
    projectRevision: number
    data: { milestone: { revision: number; goal: string } }
  }
  assert.equal(patched.projectRevision, 3)
  assert.equal(patched.data.milestone.revision, 2)
  assert.equal(patched.data.milestone.goal, '拿到可复现的样例数据')

  const activate = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/activate`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, patched.projectRevision, { expectedRevision: 2 }),
    },
  )
  const activated = (await activate.json()) as {
    projectRevision: number
    data: { milestone: { status: string; revision: number } }
  }
  assert.equal(activated.data.milestone.status, 'active')
  assert.equal(activated.data.milestone.revision, 3)

  const complete = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/complete`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, activated.projectRevision, { expectedRevision: 3 }),
    },
  )
  const completed = (await complete.json()) as {
    projectRevision: number
    data: { milestone: { status: string; completedAt: string | null; revision: number } }
  }
  assert.equal(completed.data.milestone.status, 'completed')
  assert.notEqual(completed.data.milestone.completedAt, null)

  const reopen = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/reopen`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, completed.projectRevision, { expectedRevision: 4 }),
    },
  )
  assert.equal(reopen.status, 200)
  const reopened = (await reopen.json()) as {
    projectRevision: number
    data: { milestone: { status: string; completedAt: string | null; revision: number } }
  }
  assert.equal(reopened.data.milestone.status, 'active')
  assert.equal(reopened.data.milestone.completedAt, null)

  // completed → active 是唯一 reopen 路径；active 再 reopen 属于非法转换
  const activeReopen = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/reopen`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, reopened.projectRevision, { expectedRevision: 5 }),
    },
  )
  assert.equal(activeReopen.status, 409)
  assert.equal((await jsonOf(activeReopen)).code, 'INVALID_STATE_TRANSITION')

  const archive = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/archive`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, reopened.projectRevision, { expectedRevision: 5 }),
    },
  )
  const archived = (await archive.json()) as {
    projectRevision: number
    data: { milestone: { status: string; archivedAt: string | null; revision: number } }
  }
  assert.equal(archived.data.milestone.status, 'archived')
  assert.notEqual(archived.data.milestone.archivedAt, null)

  const restore = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/restore`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, archived.projectRevision, { expectedRevision: 6 }),
    },
  )
  const restored = (await restore.json()) as {
    data: { milestone: { status: string; archivedAt: string | null } }
  }
  assert.equal(restored.data.milestone.status, 'active')
  assert.equal(restored.data.milestone.archivedAt, null)
})

test('归档阶段不能新增任务或提交证据，但历史证据仍可查询', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '将被归档的阶段',
  })
  const seededTask = await createTask(client, alice, project.projectId, milestone.projectRevision, {
    title: '归档前任务',
    milestoneId: milestone.milestoneId,
  })
  const seededEvidence = await client.request(`/api/projects/${project.projectId}/evidence`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, seededTask.projectRevision, {
      taskId: seededTask.taskId,
      milestoneId: milestone.milestoneId,
      didWhat: '归档前提交的证据正文不得进入日志',
    }),
  })
  const seeded = (await seededEvidence.json()) as { projectRevision: number }
  assert.equal(seededEvidence.status, 200)

  const archive = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}/archive`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, seeded.projectRevision, {
        expectedRevision: milestone.revision,
      }),
    },
  )
  const archived = (await archive.json()) as { projectRevision: number }
  assert.equal(archive.status, 200)

  const task = await client.request(`/api/projects/${project.projectId}/tasks`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, archived.projectRevision, {
      title: '归档后新增任务',
      milestoneId: milestone.milestoneId,
    }),
  })
  assert.equal(task.status, 409)
  assert.equal((await jsonOf(task)).code, 'MILESTONE_ARCHIVED')

  const evidence = await client.request(`/api/projects/${project.projectId}/evidence`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, archived.projectRevision, {
      taskId: null,
      milestoneId: milestone.milestoneId,
      didWhat: '归档后提交证据',
    }),
  })
  assert.equal(evidence.status, 409)
  assert.equal((await jsonOf(evidence)).code, 'MILESTONE_ARCHIVED')

  const hidden = await client.request(
    `/api/projects/${project.projectId}/evidence?milestoneId=${milestone.milestoneId}`,
    { cookie: alice.cookie },
  )
  const hiddenBody = (await hidden.json()) as { data: { evidence: unknown[] } }
  assert.equal(hiddenBody.data.evidence.length, 0)

  const history = await client.request(
    `/api/projects/${project.projectId}/evidence?milestoneId=${milestone.milestoneId}&includeArchived=true`,
    { cookie: alice.cookie },
  )
  const historyBody = (await history.json()) as {
    data: { evidence: Array<{ milestoneNameSnapshot: string }> }
  }
  assert.equal(historyBody.data.evidence.length, 1)
  assert.equal(historyBody.data.evidence[0]?.milestoneNameSnapshot, '将被归档的阶段')

  const list = await client.request(
    `/api/projects/${project.projectId}/milestones?includeArchived=true`,
    { cookie: alice.cookie },
  )
  const listBody = (await list.json()) as {
    data: { milestones: Array<{ milestoneId: string; archivedAt: string | null }> }
  }
  assert.equal(listBody.data.milestones[0]?.milestoneId, milestone.milestoneId)
  assert.notEqual(listBody.data.milestones[0]?.archivedAt, null)

  assert.equal(client.logger.text().includes('归档前提交的证据正文不得进入日志'), false)
  assert.equal(client.logger.text().includes('/api/projects/'), false)
})

test('任务可以暂不归属阶段，之后关联阶段并重算两边统计', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '目标阶段',
  })
  const task = await createTask(client, alice, project.projectId, milestone.projectRevision, {
    title: '先放项目待办',
  })

  const link = await client.request(
    `/api/projects/${project.projectId}/tasks/${task.taskId}/link-milestone`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, task.projectRevision, {
        expectedRevision: task.revision,
        milestoneId: milestone.milestoneId,
      }),
    },
  )
  const linked = (await link.json()) as {
    projectRevision: number
    data: {
      task: { milestoneId: string | null; milestoneName: string | null }
      sourceMilestoneStats: { total: number } | null
      targetMilestoneStats: { total: number; todo: number }
    }
  }
  assert.equal(link.status, 200)
  assert.equal(linked.data.task.milestoneId, milestone.milestoneId)
  assert.equal(linked.data.task.milestoneName, '目标阶段')
  assert.equal(linked.data.sourceMilestoneStats, null)
  assert.equal(linked.data.targetMilestoneStats.total, 1)
  assert.equal(linked.data.targetMilestoneStats.todo, 1)

  const list = await client.request(`/api/projects/${project.projectId}/milestones`, {
    cookie: alice.cookie,
  })
  const listBody = (await list.json()) as {
    data: { milestones: Array<{ taskStats: { total: number } }> }
  }
  assert.equal(listBody.data.milestones[0]?.taskStats.total, 1)
})

test('任务完成与归档更新阶段统计，归档任务不计入分母', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '统计阶段',
  })
  const first = await createTask(client, alice, project.projectId, milestone.projectRevision, {
    title: '任务一',
    milestoneId: milestone.milestoneId,
  })
  const second = await createTask(client, alice, project.projectId, first.projectRevision, {
    title: '任务二',
    milestoneId: milestone.milestoneId,
  })

  const complete = await client.request(
    `/api/projects/${project.projectId}/tasks/${first.taskId}/complete`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, second.projectRevision, { expectedRevision: first.revision }),
    },
  )
  const completed = (await complete.json()) as {
    projectRevision: number
    data: { task: { status: string; completedAt: string | null }; milestoneStats: { total: number; done: number; progress: number } }
  }
  assert.equal(completed.data.task.status, 'done')
  assert.notEqual(completed.data.task.completedAt, null)
  assert.deepEqual(completed.data.milestoneStats, {
    total: 2,
    done: 1,
    doing: 0,
    todo: 1,
    archived: 0,
    progress: 50,
  })

  const archive = await client.request(
    `/api/projects/${project.projectId}/tasks/${second.taskId}/archive`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, completed.projectRevision, {
        expectedRevision: second.revision,
      }),
    },
  )
  const archived = (await archive.json()) as {
    projectRevision: number
    data: { milestoneStats: { total: number; archived: number; progress: number } }
  }
  assert.equal(archived.data.milestoneStats.total, 1)
  assert.equal(archived.data.milestoneStats.archived, 1)
  assert.equal(archived.data.milestoneStats.progress, 100)

  const archivedTaskStart = await client.request(
    `/api/projects/${project.projectId}/tasks/${second.taskId}/start`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, archived.projectRevision, {
        expectedRevision: second.revision + 1,
      }),
    },
  )
  assert.equal(archivedTaskStart.status, 409)
  assert.equal((await jsonOf(archivedTaskStart)).code, 'TASK_ARCHIVED')
})

test('证据关联任务和阶段，completeTask 只递增一次项目版本', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '证据阶段',
  })
  const task = await createTask(client, alice, project.projectId, milestone.projectRevision, {
    title: '需要证据的任务',
    milestoneId: milestone.milestoneId,
  })

  const response = await client.request(`/api/projects/${project.projectId}/evidence`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, task.projectRevision, {
      submissionId: 'submission-0001',
      taskId: task.taskId,
      milestoneId: milestone.milestoneId,
      didWhat: '下载了样例数据',
      foundWhat: '字段完整',
      stillUnsure: '分辨率是否足够',
      completeTask: true,
      expectedTaskRevision: task.revision,
    }),
  })
  const body = (await response.json()) as {
    projectRevision: number
    data: {
      evidence: { evidenceId: string; milestoneNameSnapshot: string; taskId: string }
      doubt: { doubtId: string; text: string } | null
      task: { status: string; revision: number } | null
      milestoneStats: { done: number; total: number }
    }
  }
  assert.equal(response.status, 200)
  assert.equal(body.projectRevision, task.projectRevision + 1)
  assert.equal(body.data.evidence.milestoneNameSnapshot, '证据阶段')
  assert.equal(body.data.evidence.taskId, task.taskId)
  assert.equal(body.data.doubt?.text, '分辨率是否足够')
  assert.equal(body.data.task?.status, 'done')
  assert.equal(body.data.task?.revision, task.revision + 1)
  assert.equal(body.data.milestoneStats.done, 1)

  const evidenceList = await client.request(
    `/api/projects/${project.projectId}/evidence?milestoneId=${milestone.milestoneId}`,
    { cookie: alice.cookie },
  )
  const listBody = (await evidenceList.json()) as { data: { evidence: Array<{ evidenceId: string }> } }
  assert.equal(listBody.data.evidence.length, 1)
  assert.equal(listBody.data.evidence[0]?.evidenceId, body.data.evidence.evidenceId)
})

test('同键同请求体幂等重放：replayed=true 且不重复写入', async () => {
  const project = await createProject(client, alice)
  const body = envelope(project.projectId, project.projectRevision, {
    name: '幂等阶段',
    goal: null,
    doneCriteria: null,
    dueAt: null,
  })

  const first = await client.request(`/api/projects/${project.projectId}/milestones`, {
    method: 'POST',
    cookie: alice.cookie,
    body,
  })
  const firstBody = (await first.json()) as { projectRevision: number; data: { milestone: { milestoneId: string } } }

  const second = await client.request(`/api/projects/${project.projectId}/milestones`, {
    method: 'POST',
    cookie: alice.cookie,
    body,
  })
  const secondBody = (await second.json()) as {
    replayed: boolean
    projectRevision: number
    data: { milestone: { milestoneId: string } }
  }
  assert.equal(second.status, 200)
  assert.equal(secondBody.replayed, true)
  assert.equal(secondBody.projectRevision, firstBody.projectRevision)
  assert.equal(secondBody.data.milestone.milestoneId, firstBody.data.milestone.milestoneId)

  const list = await client.request(`/api/projects/${project.projectId}/milestones`, {
    cookie: alice.cookie,
  })
  const listBody = (await list.json()) as { data: { milestones: unknown[] } }
  assert.equal(listBody.data.milestones.length, 1)

  const conflictBody = { ...body, name: '同键不同内容' }
  const conflict = await client.request(`/api/projects/${project.projectId}/milestones`, {
    method: 'POST',
    cookie: alice.cookie,
    body: conflictBody,
  })
  assert.equal(conflict.status, 409)
  assert.equal((await jsonOf(conflict)).code, 'IDEMPOTENCY_CONFLICT')
})

test('项目版本与实体版本冲突返回 409 STALE_REVISION', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '版本阶段',
  })
  const currentRevision = await getProjectRevision(client, alice, project.projectId)

  const staleProject = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}`,
    {
      method: 'PATCH',
      cookie: alice.cookie,
      body: envelope(project.projectId, currentRevision - 1, {
        expectedRevision: milestone.revision,
        goal: '过期项目版本',
      }),
    },
  )
  const staleProjectBody = (await staleProject.json()) as Record<string, unknown>
  assert.equal(staleProject.status, 409)
  assert.equal(staleProjectBody.code, 'STALE_REVISION')
  assert.equal(staleProjectBody.currentProjectRevision, currentRevision)

  const staleEntity = await client.request(
    `/api/projects/${project.projectId}/milestones/${milestone.milestoneId}`,
    {
      method: 'PATCH',
      cookie: alice.cookie,
      body: envelope(project.projectId, currentRevision, {
        expectedRevision: milestone.revision + 10,
        goal: '过期实体版本',
      }),
    },
  )
  const staleEntityBody = (await staleEntity.json()) as Record<string, unknown>
  assert.equal(staleEntity.status, 409)
  assert.equal(staleEntityBody.code, 'STALE_REVISION')
  assert.equal(staleEntityBody.currentEntityRevision, milestone.revision)
})

test('阶段重名返回 MILESTONE_NAME_CONFLICT；排序非法返回 INVALID_ORDER', async () => {
  const project = await createProject(client, alice)
  const first = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '唯一阶段',
  })
  const duplicate = await client.request(`/api/projects/${project.projectId}/milestones`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, first.projectRevision, {
      name: '  唯一阶段  ',
      goal: null,
      doneCriteria: null,
      dueAt: null,
    }),
  })
  assert.equal(duplicate.status, 409)
  assert.equal((await jsonOf(duplicate)).code, 'MILESTONE_NAME_CONFLICT')

  const second = await createMilestone(client, alice, project.projectId, first.projectRevision, {
    name: '第二阶段',
  })
  const invalid = await client.request(`/api/projects/${project.projectId}/milestones/reorder`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, second.projectRevision, {
      order: [first.milestoneId],
    }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await jsonOf(invalid)).code, 'INVALID_ORDER')

  const valid = await client.request(`/api/projects/${project.projectId}/milestones/reorder`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, second.projectRevision, {
      order: [second.milestoneId, first.milestoneId],
    }),
  })
  const validBody = (await valid.json()) as {
    data: { milestones: Array<{ milestoneId: string; orderIndex: number }> }
  }
  assert.equal(valid.status, 200)
  assert.deepEqual(
    validBody.data.milestones.map((item) => item.milestoneId),
    [second.milestoneId, first.milestoneId],
  )
  assert.deepEqual(
    validBody.data.milestones.map((item) => item.orderIndex),
    [0, 1],
  )
})

test('归档阶段重名允许，因为唯一约束只作用未归档阶段', async () => {
  const project = await createProject(client, alice)
  const first = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '可复用名称',
  })
  const archive = await client.request(
    `/api/projects/${project.projectId}/milestones/${first.milestoneId}/archive`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, first.projectRevision, { expectedRevision: first.revision }),
    },
  )
  const archived = (await archive.json()) as { projectRevision: number }

  const second = await createMilestone(client, alice, project.projectId, archived.projectRevision, {
    name: '可复用名称',
  })
  assert.equal(second.milestoneId.length > 0, true)
})

test('任务开始、完成、重开（doing/todo）不自动改变阶段状态', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '任务动作阶段',
  })
  const task = await createTask(client, alice, project.projectId, milestone.projectRevision, {
    title: '动作任务',
    milestoneId: milestone.milestoneId,
  })

  const start = await client.request(
    `/api/projects/${project.projectId}/tasks/${task.taskId}/start`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, task.projectRevision, { expectedRevision: task.revision }),
    },
  )
  const started = (await start.json()) as {
    projectRevision: number
    data: { task: { status: string; startedAt: string | null; revision: number } }
  }
  assert.equal(started.data.task.status, 'doing')
  assert.notEqual(started.data.task.startedAt, null)

  const complete = await client.request(
    `/api/projects/${project.projectId}/tasks/${task.taskId}/complete`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, started.projectRevision, {
        expectedRevision: started.data.task.revision,
      }),
    },
  )
  const completed = (await complete.json()) as {
    projectRevision: number
    data: { task: { status: string; revision: number } }
  }
  assert.equal(completed.data.task.status, 'done')

  const reopen = await client.request(
    `/api/projects/${project.projectId}/tasks/${task.taskId}/reopen`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, completed.projectRevision, {
        expectedRevision: completed.data.task.revision,
        targetStatus: 'todo',
      }),
    },
  )
  const reopened = (await reopen.json()) as {
    projectRevision: number
    data: { task: { status: string; completedAt: string | null; revision: number } }
  }
  assert.equal(reopened.data.task.status, 'todo')
  assert.equal(reopened.data.task.completedAt, null)

  const milestoneList = await client.request(
    `/api/projects/${project.projectId}/milestones`,
    { cookie: alice.cookie },
  )
  const milestoneBody = (await milestoneList.json()) as {
    data: { milestones: Array<{ status: string }> }
  }
  assert.equal(milestoneBody.data.milestones[0]?.status, 'planned')
})

test('进展只追加、不改变任务状态，更正生成 superseded 记录', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '进展阶段',
  })
  const task = await createTask(client, alice, project.projectId, milestone.projectRevision, {
    title: '进展任务',
    milestoneId: milestone.milestoneId,
  })

  const created = await client.request(`/api/projects/${project.projectId}/progress`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, task.projectRevision, {
      summary: '完成样例下载',
      milestoneId: milestone.milestoneId,
      taskId: task.taskId,
      evidenceIds: [],
    }),
  })
  const createdBody = (await created.json()) as {
    projectRevision: number
    data: { progress: { progressId: string; revision: number; status: string } }
  }
  assert.equal(created.status, 200)
  assert.equal(createdBody.data.progress.status, 'active')

  const taskAfterProgress = await client.request(
    `/api/projects/${project.projectId}/tasks/${task.taskId}`,
    { cookie: alice.cookie },
  )
  // 没有单任务 GET 接口；通过阶段统计确认任务仍是 todo
  const milestones = await client.request(`/api/projects/${project.projectId}/milestones`, {
    cookie: alice.cookie,
  })
  const milestonesBody = (await milestones.json()) as {
    data: { milestones: Array<{ taskStats: { todo: number; doing: number; done: number } }> }
  }
  assert.equal(taskAfterProgress.status, 404)
  assert.equal(milestonesBody.data.milestones[0]?.taskStats.todo, 1)
  assert.equal(milestonesBody.data.milestones[0]?.taskStats.doing, 0)
  assert.equal(milestonesBody.data.milestones[0]?.taskStats.done, 0)

  const list = await client.request(`/api/projects/${project.projectId}/progress`, {
    cookie: alice.cookie,
  })
  const listBody = (await list.json()) as { data: { progress: Array<{ progressId: string }> } }
  assert.equal(listBody.data.progress.length, 1)
  assert.equal(listBody.data.progress[0]?.progressId, createdBody.data.progress.progressId)

  const supersede = await client.request(
    `/api/projects/${project.projectId}/progress/${createdBody.data.progress.progressId}/supersede`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: envelope(project.projectId, createdBody.projectRevision, {
        expectedRevision: createdBody.data.progress.revision,
        summary: '更正：完成样例下载与字段核对',
      }),
    },
  )
  const superseded = (await supersede.json()) as {
    projectRevision: number
    data: {
      progress: { progressId: string; status: string; supersedesProgressId: string }
      supersededProgressId: string
    }
  }
  assert.equal(superseded.data.progress.status, 'active')
  assert.equal(
    superseded.data.progress.supersedesProgressId,
    createdBody.data.progress.progressId,
  )

  const after = await client.request(`/api/projects/${project.projectId}/progress`, {
    cookie: alice.cookie,
  })
  const afterBody = (await after.json()) as {
    data: { progress: Array<{ progressId: string; status: string }> }
  }
  assert.equal(afterBody.data.progress.length, 2)
  assert.equal(
    afterBody.data.progress.find((item) => item.progressId === createdBody.data.progress.progressId)
      ?.status,
    'superseded',
  )
})

test('项目归档、恢复、软删除与恢复删除', async () => {
  const project = await createProject(client, alice)
  const archive = await client.request(`/api/projects/${project.projectId}/archive`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, project.projectRevision),
  })
  const archived = (await archive.json()) as {
    projectRevision: number
    data: { project: { status: string; archivedAt: string | null } }
  }
  assert.equal(archive.status, 200)
  assert.equal(archived.data.project.status, 'archived')
  assert.notEqual(archived.data.project.archivedAt, null)

  const defaultList = await client.request('/api/projects', { cookie: alice.cookie })
  const defaultBody = (await defaultList.json()) as { data: { projects: Array<{ projectId: string }> } }
  assert.equal(defaultBody.data.projects.some((item) => item.projectId === project.projectId), false)

  const archivedList = await client.request('/api/projects?includeArchived=true', {
    cookie: alice.cookie,
  })
  const archivedListBody = (await archivedList.json()) as {
    data: { projects: Array<{ projectId: string; status: string }> }
  }
  assert.equal(
    archivedListBody.data.projects.find((item) => item.projectId === project.projectId)?.status,
    'archived',
  )

  const restore = await client.request(`/api/projects/${project.projectId}/restore`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, archived.projectRevision),
  })
  const restored = (await restore.json()) as { projectRevision: number }
  assert.equal(restore.status, 200)

  const remove = await client.request(`/api/projects/${project.projectId}/delete`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, restored.projectRevision),
  })
  const deleted = (await remove.json()) as { projectRevision: number }
  assert.equal(remove.status, 200)

  const readDeleted = await client.request(`/api/projects/${project.projectId}`, {
    cookie: alice.cookie,
  })
  assert.equal(readDeleted.status, 404)

  const repeatDelete = await client.request(`/api/projects/${project.projectId}/delete`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, deleted.projectRevision),
  })
  const repeated = (await repeatDelete.json()) as { changed: boolean; projectRevision: number }
  assert.equal(repeatDelete.status, 200)
  assert.equal(repeated.changed, false)
  assert.equal(repeated.projectRevision, deleted.projectRevision)

  const restoreDeleted = await client.request(`/api/projects/${project.projectId}/restore-deleted`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, deleted.projectRevision),
  })
  assert.equal(restoreDeleted.status, 200)
  const readRestored = await client.request(`/api/projects/${project.projectId}`, {
    cookie: alice.cookie,
  })
  assert.equal(readRestored.status, 200)
})

test('证据链接变更校验 expectedRevision，重复设置相同关联幂等', async () => {
  const project = await createProject(client, alice)
  const milestone = await createMilestone(client, alice, project.projectId, project.projectRevision, {
    name: '链接阶段',
  })
  const evidence = await client.request(`/api/projects/${project.projectId}/evidence`, {
    method: 'POST',
    cookie: alice.cookie,
    body: envelope(project.projectId, milestone.projectRevision, {
      taskId: null,
      milestoneId: null,
      didWhat: '先提交无关联证据',
    }),
  })
  const evidenceBody = (await evidence.json()) as {
    projectRevision: number
    data: { evidence: { evidenceId: string; revision: number } }
  }

  const linkBody = envelope(project.projectId, evidenceBody.projectRevision, {
    expectedRevision: evidenceBody.data.evidence.revision,
    taskId: null,
    milestoneId: milestone.milestoneId,
  })
  const link = await client.request(
    `/api/projects/${project.projectId}/evidence/${evidenceBody.data.evidence.evidenceId}/links`,
    { method: 'POST', cookie: alice.cookie, body: linkBody },
  )
  const linked = (await link.json()) as {
    projectRevision: number
    changed: boolean
    data: { evidence: { revision: number; milestoneNameSnapshot: string } }
  }
  assert.equal(linked.changed, true)
  assert.equal(linked.data.evidence.milestoneNameSnapshot, '链接阶段')
  assert.equal(linked.data.evidence.revision, evidenceBody.data.evidence.revision + 1)

  const repeat = await client.request(
    `/api/projects/${project.projectId}/evidence/${evidenceBody.data.evidence.evidenceId}/links`,
    {
      method: 'POST',
      cookie: alice.cookie,
      body: {
        ...linkBody,
        idempotencyKey: `repeat-${uuid().slice(0, 20)}`,
        projectRevision: linked.projectRevision,
        expectedRevision: linked.data.evidence.revision,
      },
    },
  )
  const repeated = (await repeat.json()) as { changed: boolean; projectRevision: number }
  assert.equal(repeated.changed, false)
  assert.equal(repeated.projectRevision, linked.projectRevision)
})
