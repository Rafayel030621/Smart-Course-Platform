import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TestClient,
  createProject,
  createTestClient,
  registerUser,
  type LoggedInUser,
} from './v3-support.js'

/**
 * PR2B 第一阶段只读接口：
 * - GET /tasks、GET /tasks/{id}
 * - GET /materials、GET /materials/{id}
 * - GET /materials/{id}/segments
 * - GET /materials/{id}/understanding
 */

let client: TestClient
let user: LoggedInUser
let other: LoggedInUser

before(async () => {
  client = await createTestClient()
  user = await registerUser(client, { account: `reader_${Date.now()}` })
  other = await registerUser(client, { account: `other_reader_${Date.now()}` })
})

after(async () => {
  await client.close()
})

function seedMilestone(options: {
  projectId: string
  milestoneId: string
  name: string
  status?: 'planned' | 'active' | 'completed' | 'archived'
  archived?: boolean
  orderIndex?: number
  createdAt?: string
}): void {
  const status = options.status ?? 'active'
  const now = options.createdAt ?? '2026-10-01T00:00:00.000Z'
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO milestones
         (milestone_id, project_id, user_id, name, name_key, goal, done_criteria, due_at,
          status, order_index, source, revision, created_at, updated_at, completed_at,
          archived_at, archived_from_status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'manual', 1, ?, ?, NULL, ?, NULL, ?)`,
    )
    .run(
      options.milestoneId,
      options.projectId,
      user.userId,
      options.name,
      options.name.toLowerCase(),
      status,
      options.orderIndex ?? 0,
      now,
      now,
      options.archived === true ? '2026-10-02T00:00:00.000Z' : null,
      user.userId,
    )
}

function seedTask(options: {
  projectId: string
  taskId: string
  title: string
  milestoneId: string | null
  status?: 'todo' | 'doing' | 'done'
  archived?: boolean
  createdAt: string
}): void {
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO tasks
         (task_id, project_id, milestone_id, user_id, title, done_criteria, status,
          assignee_user_id, order_index, source, revision, created_at, updated_at,
          started_at, completed_at, archived_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 0, 'manual', 1, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      options.taskId,
      options.projectId,
      options.milestoneId,
      user.userId,
      options.title,
      options.status ?? 'todo',
      options.createdAt,
      options.createdAt,
      options.archived === true ? '2026-10-05T00:00:00.000Z' : null,
      user.userId,
    )
}

function seedMaterial(options: {
  projectId: string
  materialId: string
  version: number
  name: string
  status?: string
  updatedAt: string
  archived?: boolean
}): void {
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO materials
         (material_id, material_version, project_id, user_id, name, type, size, encoding,
          status, revision, sha256, failure_reason, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, 'md', 100, 'utf-8', ?, 1, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      options.materialId,
      options.version,
      options.projectId,
      user.userId,
      options.name,
      options.status ?? 'parsed',
      options.updatedAt,
      options.updatedAt,
      options.archived === true ? '2026-10-06T00:00:00.000Z' : null,
    )
}

function seedSegment(options: {
  materialId: string
  version: number
  segmentId: string
  index: number
  startLine: number
  endLine: number
  text: string
}): void {
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO material_segments
         (material_id, material_version, segment_id, idx, start_line, end_line, text, char_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z')`,
    )
    .run(
      options.materialId,
      options.version,
      options.segmentId,
      options.index,
      options.startLine,
      options.endLine,
      options.text,
      [...options.text].length,
    )
}

function seedItem(options: {
  projectId: string
  materialId: string
  version: number
  itemId: string
  text: string
  status: 'pending' | 'modified' | 'confirmed' | 'archived'
  sources: unknown
  createdAt: string
}): void {
  client.runtime
    .getDb()
    .prepare(
      `INSERT INTO understanding_items
         (item_id, client_item_id, project_id, material_id, material_version, kind, text,
          original_text, sources_json, status, source, revision, created_at, updated_at,
          confirmed_at, confirmed_by_user_id, removed_at)
       VALUES (?, NULL, ?, ?, ?, 'goalCandidates', ?, ?, ?, ?, 'migration', 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.itemId,
      options.projectId,
      options.materialId,
      options.version,
      options.text,
      options.text,
      JSON.stringify(options.sources),
      options.status,
      options.createdAt,
      options.createdAt,
      options.status === 'confirmed' ? '2026-10-01T01:00:00.000Z' : null,
      options.status === 'confirmed' ? user.userId : null,
      options.status === 'archived' ? '2026-10-02T00:00:00.000Z' : null,
    )
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

async function collectPages(
  startPath: string,
  cookie: string,
): Promise<Array<Record<string, unknown>>> {
  const collected: Array<Record<string, unknown>> = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
    const response = await client.request(`${startPath}${suffix}`, { cookie })
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      data: { tasks?: Array<Record<string, unknown>>; materials?: Array<Record<string, unknown>>; segments?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>>; nextCursor: string | null }
    }
    const list = body.data.tasks ?? body.data.materials ?? body.data.segments ?? body.data.items ?? []
    collected.push(...list)
    cursor = body.data.nextCursor
    if (cursor === null) return collected
  }
  throw new Error('pagination did not terminate')
}

async function projectRevisionOf(projectId: string, cookie: string): Promise<number> {
  const response = await client.request(`/api/projects/${projectId}`, { cookie })
  const body = (await response.json()) as { projectRevision: number }
  return body.projectRevision
}

async function createReadableProject(): Promise<string> {
  const project = await createProject(client, user, {
    name: `读取项目-${Math.random().toString(36).slice(2, 8)}`,
  })
  return project.projectId
}

test('读接口要求登录；跨用户项目 404，同用户跨项目实体 404', async () => {
  const projectId = await createReadableProject()
  const otherProject = await createReadableProject()

  seedMilestone({
    projectId,
    milestoneId: 'ms_read_auth',
    name: `读取阶段-${projectId.slice(-6)}`,
  })
  seedMaterial({
    projectId,
    materialId: 'mat_read_auth',
    version: 1,
    name: 'auth.md',
    updatedAt: '2026-10-10T00:00:00.000Z',
  })
  seedTask({
    projectId,
    taskId: 'tsk_read_auth',
    title: '读取任务',
    milestoneId: 'ms_read_auth',
    createdAt: '2026-10-10T00:00:00.000Z',
  })
  seedMilestone({
    projectId: otherProject,
    milestoneId: 'ms_other_project',
    name: `其他阶段-${otherProject.slice(-6)}`,
  })

  const paths = [
    `/api/projects/${projectId}/tasks`,
    `/api/projects/${projectId}/tasks/tsk_read_auth`,
    `/api/projects/${projectId}/materials`,
    `/api/projects/${projectId}/materials/mat_read_auth`,
    `/api/projects/${projectId}/materials/mat_read_auth/segments`,
    `/api/projects/${projectId}/materials/mat_read_auth/understanding`,
  ]

  for (const path of paths) {
    const unauth = await client.request(path)
    assert.equal(unauth.status, 401, path)
    assert.equal((await jsonOf(unauth)).code, 'UNAUTHORIZED')
  }

  for (const path of paths) {
    const crossUser = await client.request(path, { cookie: other.cookie })
    assert.equal(crossUser.status, 404, path)
    assert.equal((await jsonOf(crossUser)).code, 'PROJECT_NOT_FOUND')
  }

  const crossProjectTask = await client.request(
    `/api/projects/${projectId}/tasks/tsk_read_auth`,
    { cookie: user.cookie },
  )
  assert.equal(crossProjectTask.status, 200)

  const wrongProjectTask = await client.request(
    `/api/projects/${otherProject}/tasks/tsk_read_auth`,
    { cookie: user.cookie },
  )
  assert.equal(wrongProjectTask.status, 404)
  assert.equal((await jsonOf(wrongProjectTask)).code, 'RESOURCE_NOT_FOUND')

  const wrongProjectMaterial = await client.request(
    `/api/projects/${otherProject}/materials/mat_read_auth`,
    { cookie: user.cookie },
  )
  assert.equal(wrongProjectMaterial.status, 404)
  assert.equal((await jsonOf(wrongProjectMaterial)).code, 'RESOURCE_NOT_FOUND')

  const wrongMilestone = await client.request(
    `/api/projects/${projectId}/tasks?milestoneId=ms_other_project`,
    { cookie: user.cookie },
  )
  assert.equal(wrongMilestone.status, 404)
  assert.equal((await jsonOf(wrongMilestone)).code, 'RESOURCE_NOT_FOUND')
})

test('任务列表默认排除归档任务和归档阶段任务，includeArchived 可读取', async () => {
  const projectId = await createReadableProject()
  seedMilestone({ projectId, milestoneId: 'ms_task_active', name: `任务阶段-${projectId.slice(-6)}` })
  seedMilestone({
    projectId,
    milestoneId: 'ms_task_archived',
    name: `归档阶段-${projectId.slice(-6)}`,
    status: 'archived',
    archived: true,
  })
  seedTask({
    projectId,
    taskId: 'tsk_normal',
    title: '普通任务',
    milestoneId: 'ms_task_active',
    status: 'doing',
    createdAt: '2026-10-01T00:00:00.000Z',
  })
  seedTask({
    projectId,
    taskId: 'tsk_archived',
    title: '归档任务',
    milestoneId: 'ms_task_active',
    status: 'done',
    archived: true,
    createdAt: '2026-10-02T00:00:00.000Z',
  })
  seedTask({
    projectId,
    taskId: 'tsk_in_archived_milestone',
    title: '归档阶段任务',
    milestoneId: 'ms_task_archived',
    status: 'todo',
    createdAt: '2026-10-03T00:00:00.000Z',
  })
  seedTask({
    projectId,
    taskId: 'tsk_unassigned',
    title: '未归属任务',
    milestoneId: null,
    status: 'todo',
    createdAt: '2026-10-04T00:00:00.000Z',
  })

  const before = await projectRevisionOf(projectId, user.cookie)
  const defaultList = await client.request(`/api/projects/${projectId}/tasks`, {
    cookie: user.cookie,
  })
  const defaultBody = (await defaultList.json()) as {
    data: { tasks: Array<{ taskId: string; status: string; milestoneName: string | null }>; nextCursor: string | null }
  }
  assert.equal(defaultList.status, 200)
  assert.deepEqual(
    defaultBody.data.tasks.map((task) => task.taskId),
    ['tsk_unassigned', 'tsk_normal'],
  )
  assert.equal(defaultBody.data.tasks[1]?.status, 'doing')
  assert.equal(defaultBody.data.tasks[1]?.milestoneName, `任务阶段-${projectId.slice(-6)}`)

  const all = await client.request(`/api/projects/${projectId}/tasks?includeArchived=true`, {
    cookie: user.cookie,
  })
  const allBody = (await all.json()) as { data: { tasks: Array<{ taskId: string }> } }
  assert.deepEqual(
    allBody.data.tasks.map((task) => task.taskId),
    ['tsk_unassigned', 'tsk_in_archived_milestone', 'tsk_archived', 'tsk_normal'],
  )

  const filtered = await client.request(
    `/api/projects/${projectId}/tasks?milestoneId=ms_task_active`,
    { cookie: user.cookie },
  )
  const filteredBody = (await filtered.json()) as { data: { tasks: Array<{ taskId: string }> } }
  assert.deepEqual(filteredBody.data.tasks.map((task) => task.taskId), ['tsk_normal'])

  const filteredAll = await client.request(
    `/api/projects/${projectId}/tasks?milestoneId=ms_task_active&includeArchived=true`,
    { cookie: user.cookie },
  )
  const filteredAllBody = (await filteredAll.json()) as { data: { tasks: Array<{ taskId: string }> } }
  assert.deepEqual(
    filteredAllBody.data.tasks.map((task) => task.taskId),
    ['tsk_archived', 'tsk_normal'],
  )

  const doing = await client.request(`/api/projects/${projectId}/tasks?status=doing`, {
    cookie: user.cookie,
  })
  const doingBody = (await doing.json()) as { data: { tasks: Array<{ taskId: string }> } }
  assert.deepEqual(doingBody.data.tasks.map((task) => task.taskId), ['tsk_normal'])

  assert.equal(await projectRevisionOf(projectId, user.cookie), before)
})

test('单任务读取：归档任务和归档阶段任务默认 404，includeArchived=true 可读取', async () => {
  const projectId = await createReadableProject()
  seedMilestone({ projectId, milestoneId: 'ms_single_task', name: `单任务阶段-${projectId.slice(-6)}` })
  seedMilestone({
    projectId,
    milestoneId: 'ms_single_task_archived',
    name: `单任务归档阶段-${projectId.slice(-6)}`,
    status: 'archived',
    archived: true,
  })
  seedTask({
    projectId,
    taskId: 'tsk_single_active',
    title: '可读任务',
    milestoneId: 'ms_single_task',
    createdAt: '2026-10-01T00:00:00.000Z',
  })
  seedTask({
    projectId,
    taskId: 'tsk_single_archived',
    title: '归档任务',
    milestoneId: 'ms_single_task',
    archived: true,
    createdAt: '2026-10-02T00:00:00.000Z',
  })
  seedTask({
    projectId,
    taskId: 'tsk_single_in_archived',
    title: '归档阶段任务',
    milestoneId: 'ms_single_task_archived',
    createdAt: '2026-10-03T00:00:00.000Z',
  })

  const active = await client.request(
    `/api/projects/${projectId}/tasks/tsk_single_active`,
    { cookie: user.cookie },
  )
  assert.equal(active.status, 200)
  assert.equal(((await active.json()) as { data: { task: { taskId: string } } }).data.task.taskId, 'tsk_single_active')

  for (const taskId of ['tsk_single_archived', 'tsk_single_in_archived']) {
    const hidden = await client.request(`/api/projects/${projectId}/tasks/${taskId}`, {
      cookie: user.cookie,
    })
    assert.equal(hidden.status, 404)
    assert.equal((await jsonOf(hidden)).code, 'RESOURCE_NOT_FOUND')

    const visible = await client.request(
      `/api/projects/${projectId}/tasks/${taskId}?includeArchived=true`,
      { cookie: user.cookie },
    )
    assert.equal(visible.status, 200)
  }
})

test('任务列表分页稳定且校验 limit/cursor', async () => {
  const projectId = await createReadableProject()
  for (let index = 0; index < 4; index += 1) {
    seedTask({
      projectId,
      taskId: `tsk_page_${index}`,
      title: `分页任务 ${index}`,
      milestoneId: null,
      createdAt: `2026-10-0${index + 1}T00:00:00.000Z`,
    })
  }
  const all = await collectPages(
    `/api/projects/${projectId}/tasks?limit=1`,
    user.cookie,
  )
  assert.deepEqual(
    all.map((task) => task.taskId),
    ['tsk_page_3', 'tsk_page_2', 'tsk_page_1', 'tsk_page_0'],
  )

  const tooLarge = await client.request(`/api/projects/${projectId}/tasks?limit=101`, {
    cookie: user.cookie,
  })
  assert.equal(tooLarge.status, 400)
  assert.equal((await jsonOf(tooLarge)).code, 'INVALID_INPUT')

  const badCursor = await client.request(
    `/api/projects/${projectId}/tasks?cursor=not-a-cursor`,
    { cookie: user.cookie },
  )
  assert.equal(badCursor.status, 400)
  assert.equal((await jsonOf(badCursor)).code, 'INVALID_INPUT')
})

test('材料列表默认当前版本、排除归档；单材料旧版本只读', async () => {
  const projectId = await createReadableProject()
  seedMaterial({
    projectId,
    materialId: 'mat_versions',
    version: 1,
    name: '多版本.md',
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  seedMaterial({
    projectId,
    materialId: 'mat_versions',
    version: 2,
    name: '多版本.md',
    updatedAt: '2026-10-03T00:00:00.000Z',
  })
  seedMaterial({
    projectId,
    materialId: 'mat_archived',
    version: 1,
    name: '归档材料.md',
    updatedAt: '2026-10-02T00:00:00.000Z',
    archived: true,
    status: 'archived',
  })
  seedMaterial({
    projectId,
    materialId: 'mat_current_c',
    version: 1,
    name: '当前材料.md',
    updatedAt: '2026-10-05T00:00:00.000Z',
  })

  const before = await projectRevisionOf(projectId, user.cookie)
  const list = await client.request(`/api/projects/${projectId}/materials`, {
    cookie: user.cookie,
  })
  const listBody = (await list.json()) as {
    data: { materials: Array<{ materialId: string; materialVersion: number; isCurrent: boolean }>; nextCursor: string | null }
  }
  assert.equal(list.status, 200)
  assert.deepEqual(
    listBody.data.materials.map((material) => material.materialId),
    ['mat_current_c', 'mat_versions'],
  )
  assert.equal(listBody.data.materials[1]?.materialVersion, 2)
  assert.equal(listBody.data.materials[1]?.isCurrent, true)

  const withArchived = await client.request(
    `/api/projects/${projectId}/materials?includeArchived=true`,
    { cookie: user.cookie },
  )
  const withArchivedBody = (await withArchived.json()) as {
    data: { materials: Array<{ materialId: string }> }
  }
  assert.deepEqual(
    withArchivedBody.data.materials.map((material) => material.materialId),
    ['mat_current_c', 'mat_versions', 'mat_archived'],
  )

  const current = await client.request(
    `/api/projects/${projectId}/materials/mat_versions`,
    { cookie: user.cookie },
  )
  const currentBody = (await current.json()) as {
    data: { material: { materialVersion: number; isCurrent: boolean; readOnly: boolean } }
  }
  assert.equal(currentBody.data.material.materialVersion, 2)
  assert.equal(currentBody.data.material.isCurrent, true)
  assert.equal(currentBody.data.material.readOnly, false)

  const old = await client.request(
    `/api/projects/${projectId}/materials/mat_versions?version=1`,
    { cookie: user.cookie },
  )
  const oldBody = (await old.json()) as {
    data: { material: { materialVersion: number; isCurrent: boolean; readOnly: boolean; status: string } }
  }
  assert.equal(old.status, 200)
  assert.equal(oldBody.data.material.materialVersion, 1)
  assert.equal(oldBody.data.material.isCurrent, false)
  assert.equal(oldBody.data.material.readOnly, true)

  const missingVersion = await client.request(
    `/api/projects/${projectId}/materials/mat_versions?version=99`,
    { cookie: user.cookie },
  )
  assert.equal(missingVersion.status, 404)

  const archivedDefault = await client.request(
    `/api/projects/${projectId}/materials/mat_archived`,
    { cookie: user.cookie },
  )
  assert.equal(archivedDefault.status, 404)

  const archivedVisible = await client.request(
    `/api/projects/${projectId}/materials/mat_archived?includeArchived=true`,
    { cookie: user.cookie },
  )
  const archivedBody = (await archivedVisible.json()) as {
    data: { material: { readOnly: boolean; archivedAt: string | null } }
  }
  assert.equal(archivedVisible.status, 200)
  assert.equal(archivedBody.data.material.readOnly, true)
  assert.notEqual(archivedBody.data.material.archivedAt, null)

  assert.equal(await projectRevisionOf(projectId, user.cookie), before)
})

test('材料列表分页校验 limit/cursor', async () => {
  const projectId = await createReadableProject()
  for (let index = 0; index < 3; index += 1) {
    seedMaterial({
      projectId,
      materialId: `mat_page_${index}`,
      version: 1,
      name: `分页材料 ${index}.md`,
      updatedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
    })
  }
  const all = await collectPages(
    `/api/projects/${projectId}/materials?limit=1`,
    user.cookie,
  )
  assert.deepEqual(
    all.map((material) => material.materialId),
    ['mat_page_2', 'mat_page_1', 'mat_page_0'],
  )

  const tooLarge = await client.request(`/api/projects/${projectId}/materials?limit=101`, {
    cookie: user.cookie,
  })
  assert.equal(tooLarge.status, 400)
  assert.equal((await jsonOf(tooLarge)).code, 'INVALID_INPUT')
})

test('片段读取只返回指定 materialId + version，旧版本只读且排序稳定', async () => {
  const projectId = await createReadableProject()
  seedMaterial({
    projectId,
    materialId: 'mat_segments',
    version: 1,
    name: '片段.md',
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  seedMaterial({
    projectId,
    materialId: 'mat_segments',
    version: 2,
    name: '片段.md',
    updatedAt: '2026-10-02T00:00:00.000Z',
  })
  seedSegment({
    materialId: 'mat_segments',
    version: 1,
    segmentId: 'seg_old',
    index: 0,
    startLine: 1,
    endLine: 2,
    text: '旧版本片段',
  })
  seedSegment({
    materialId: 'mat_segments',
    version: 2,
    segmentId: 'seg_v2_b',
    index: 1,
    startLine: 20,
    endLine: 22,
    text: '新版本片段 B',
  })
  seedSegment({
    materialId: 'mat_segments',
    version: 2,
    segmentId: 'seg_v2_a',
    index: 0,
    startLine: 10,
    endLine: 12,
    text: '新版本片段 A',
  })

  const current = await client.request(
    `/api/projects/${projectId}/materials/mat_segments/segments`,
    { cookie: user.cookie },
  )
  const currentBody = (await current.json()) as {
    data: {
      materialVersion: number
      isCurrent: boolean
      readOnly: boolean
      segments: Array<{ segmentId: string; index: number; startLine: number; status: string; text: string }>
      nextCursor: string | null
    }
  }
  assert.equal(current.status, 200)
  assert.equal(currentBody.data.materialVersion, 2)
  assert.equal(currentBody.data.readOnly, false)
  assert.deepEqual(
    currentBody.data.segments.map((segment) => segment.segmentId),
    ['seg_v2_a', 'seg_v2_b'],
  )
  assert.equal(currentBody.data.segments[0]?.startLine, 10)
  assert.equal(currentBody.data.segments[0]?.status, 'active')

  const old = await client.request(
    `/api/projects/${projectId}/materials/mat_segments/segments?version=1`,
    { cookie: user.cookie },
  )
  const oldBody = (await old.json()) as {
    data: { materialVersion: number; readOnly: boolean; segments: Array<{ segmentId: string; status: string }> }
  }
  assert.equal(old.status, 200)
  assert.equal(oldBody.data.materialVersion, 1)
  assert.equal(oldBody.data.readOnly, true)
  assert.deepEqual(oldBody.data.segments.map((segment) => segment.segmentId), ['seg_old'])
  assert.equal(oldBody.data.segments[0]?.status, 'superseded')

  const paged = await collectPages(
    `/api/projects/${projectId}/materials/mat_segments/segments?limit=1`,
    user.cookie,
  )
  assert.deepEqual(paged.map((segment) => segment.segmentId), ['seg_v2_a', 'seg_v2_b'])

  const tooLarge = await client.request(
    `/api/projects/${projectId}/materials/mat_segments/segments?limit=201`,
    { cookie: user.cookie },
  )
  assert.equal(tooLarge.status, 400)
})

test('理解草稿只返回指定版本，来源行号从数据库回填，归档默认隐藏', async () => {
  const projectId = await createReadableProject()
  seedMaterial({
    projectId,
    materialId: 'mat_items',
    version: 1,
    name: '草稿.md',
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  seedMaterial({
    projectId,
    materialId: 'mat_items',
    version: 2,
    name: '草稿.md',
    updatedAt: '2026-10-02T00:00:00.000Z',
  })
  seedSegment({
    materialId: 'mat_items',
    version: 1,
    segmentId: 'seg_item_old',
    index: 0,
    startLine: 1,
    endLine: 2,
    text: '旧版本条目来源',
  })
  seedSegment({
    materialId: 'mat_items',
    version: 2,
    segmentId: 'seg_item_a',
    index: 0,
    startLine: 30,
    endLine: 32,
    text: '新版本条目来源 A',
  })
  seedSegment({
    materialId: 'mat_items',
    version: 2,
    segmentId: 'seg_item_b',
    index: 1,
    startLine: 40,
    endLine: 42,
    text: '新版本条目来源 B',
  })
  seedItem({
    projectId,
    materialId: 'mat_items',
    version: 2,
    itemId: 'cnd_normal',
    text: '正常条目',
    status: 'pending',
    sources: [
      {
        materialId: 'mat_forged',
        materialVersion: 99,
        segmentId: 'seg_item_a',
        startLine: 999,
        endLine: 1000,
      },
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
  })
  seedItem({
    projectId,
    materialId: 'mat_items',
    version: 2,
    itemId: 'cnd_archived',
    text: '归档条目',
    status: 'archived',
    sources: [{ segmentId: 'seg_item_b' }],
    createdAt: '2026-10-02T00:00:00.000Z',
  })
  seedItem({
    projectId,
    materialId: 'mat_items',
    version: 1,
    itemId: 'cnd_version1',
    text: '旧版本条目',
    status: 'pending',
    sources: [{ segmentId: 'seg_item_old' }],
    createdAt: '2026-10-03T00:00:00.000Z',
  })

  const before = await projectRevisionOf(projectId, user.cookie)
  const current = await client.request(
    `/api/projects/${projectId}/materials/mat_items/understanding`,
    { cookie: user.cookie },
  )
  const currentBody = (await current.json()) as {
    data: {
      materialVersion: number
      readOnly: boolean
      items: Array<{
        itemId: string
        sources: Array<{ materialId: string; materialVersion: number; segmentId: string; startLine: number; endLine: number }>
      }>
      nextCursor: string | null
    }
  }
  assert.equal(current.status, 200)
  assert.equal(currentBody.data.materialVersion, 2)
  assert.equal(currentBody.data.readOnly, false)
  assert.deepEqual(currentBody.data.items.map((item) => item.itemId), ['cnd_normal'])
  const source = currentBody.data.items[0]?.sources[0]
  assert.equal(source?.materialId, 'mat_items')
  assert.equal(source?.materialVersion, 2)
  assert.equal(source?.segmentId, 'seg_item_a')
  assert.equal(source?.startLine, 30)
  assert.equal(source?.endLine, 32)

  const withArchived = await client.request(
    `/api/projects/${projectId}/materials/mat_items/understanding?includeArchived=true`,
    { cookie: user.cookie },
  )
  const archivedBody = (await withArchived.json()) as {
    data: { items: Array<{ itemId: string; status: string }> }
  }
  assert.deepEqual(
    archivedBody.data.items.map((item) => item.itemId),
    ['cnd_normal', 'cnd_archived'],
  )
  assert.equal(archivedBody.data.items[1]?.status, 'archived')

  const old = await client.request(
    `/api/projects/${projectId}/materials/mat_items/understanding?version=1`,
    { cookie: user.cookie },
  )
  const oldBody = (await old.json()) as {
    data: { materialVersion: number; readOnly: boolean; items: Array<{ itemId: string; sources: Array<{ segmentId: string }> }> }
  }
  assert.equal(old.status, 200)
  assert.equal(oldBody.data.materialVersion, 1)
  assert.equal(oldBody.data.readOnly, true)
  assert.deepEqual(oldBody.data.items.map((item) => item.itemId), ['cnd_version1'])
  assert.equal(oldBody.data.items[0]?.sources[0]?.segmentId, 'seg_item_old')

  const paged = await collectPages(
    `/api/projects/${projectId}/materials/mat_items/understanding?includeArchived=true&limit=1`,
    user.cookie,
  )
  assert.deepEqual(paged.map((item) => item.itemId), ['cnd_normal', 'cnd_archived'])

  const tooLarge = await client.request(
    `/api/projects/${projectId}/materials/mat_items/understanding?limit=201`,
    { cookie: user.cookie },
  )
  assert.equal(tooLarge.status, 400)

  assert.equal(await projectRevisionOf(projectId, user.cookie), before)
})

test('归档项目可读，软删除项目 404；读取不递增版本、不写幂等记录', async () => {
  const archivedProject = await createReadableProject()
  const deletedProject = await createReadableProject()
  const db = client.runtime.getDb()
  const idempotencyBefore = (
    db.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }
  ).count

  seedMaterial({
    projectId: archivedProject,
    materialId: 'mat_archived_project',
    version: 1,
    name: '归档项目材料.md',
    updatedAt: '2026-10-01T00:00:00.000Z',
  })
  seedTask({
    projectId: archivedProject,
    taskId: 'tsk_archived_project',
    title: '归档项目任务',
    milestoneId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
  })

  const archive = await client.request(`/api/projects/${archivedProject}/archive`, {
    method: 'POST',
    cookie: user.cookie,
    body: {
      contractVersion: '3.0',
      requestId: '2f8c2d0e-8f1b-4c6a-9f5d-2a7e4b1c9d30',
      idempotencyKey: `archive-read-${Date.now()}`,
      projectId: archivedProject,
      projectRevision: 1,
    },
  })
  assert.equal(archive.status, 200)
  const archivedRevision = ((await archive.json()) as { projectRevision: number }).projectRevision

  const tasks = await client.request(`/api/projects/${archivedProject}/tasks`, {
    cookie: user.cookie,
  })
  assert.equal(tasks.status, 200)
  const materials = await client.request(`/api/projects/${archivedProject}/materials`, {
    cookie: user.cookie,
  })
  assert.equal(materials.status, 200)
  assert.equal(await projectRevisionOf(archivedProject, user.cookie), archivedRevision)

  const remove = await client.request(`/api/projects/${deletedProject}/delete`, {
    method: 'POST',
    cookie: user.cookie,
    body: {
      contractVersion: '3.0',
      requestId: '5b1d0a9c-6e2f-4b8a-8c3d-7f4e1a2b6c91',
      idempotencyKey: `delete-read-${Date.now()}`,
      projectId: deletedProject,
      projectRevision: 1,
    },
  })
  assert.equal(remove.status, 200)
  for (const path of [
    `/api/projects/${deletedProject}/tasks`,
    `/api/projects/${deletedProject}/materials`,
  ]) {
    const response = await client.request(path, { cookie: user.cookie })
    assert.equal(response.status, 404)
    assert.equal((await jsonOf(response)).code, 'PROJECT_NOT_FOUND')
  }

  assert.equal(
    (
      db.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }
    ).count,
    idempotencyBefore + 2,
  )
})
