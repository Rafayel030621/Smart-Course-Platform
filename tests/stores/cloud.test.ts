import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCloudStore } from '@/stores/cloud'
import type { CloudEvidence, CloudMilestone, CloudProject, CloudTask, ProgressRecord } from '@/types/platform'
import {
  echoEnvelope,
  emptyProfile,
  installFetch,
  jsonResponse,
  makeCloudMilestone,
  makeCloudProject,
  makeCloudTask,
  makeEvidence,
  makeProgress,
  readEnvelope,
  requestBody,
} from '../support/v3Fixtures'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface ProjectFixture {
  project: CloudProject
  evidence?: CloudEvidence[]
  progress?: ProgressRecord[]
}

function routeRead(
  url: string,
  method: string,
  fixtures: Record<string, ProjectFixture>,
): Response | undefined {
  for (const [projectId, fixture] of Object.entries(fixtures)) {
    const base = `/api/projects/${projectId}`
    if (method === 'GET' && url.endsWith(base)) {
      return jsonResponse(readEnvelope({ project: fixture.project }, projectId, fixture.project.projectRevision))
    }
    if (method === 'GET' && url.includes(`${base}/evidence`)) {
      return jsonResponse(
        readEnvelope({ evidence: fixture.evidence ?? [], nextCursor: null }, projectId, fixture.project.projectRevision),
      )
    }
    if (method === 'GET' && url.includes(`${base}/progress`)) {
      return jsonResponse(
        readEnvelope({ progress: fixture.progress ?? [], nextCursor: null }, projectId, fixture.project.projectRevision),
      )
    }
  }
  return undefined
}

function stats(overrides: Partial<CloudMilestone['taskStats']> = {}): CloudMilestone['taskStats'] {
  return { total: 0, done: 0, doing: 0, todo: 0, archived: 0, progress: 0, ...overrides }
}

function open(store: ReturnType<typeof useCloudStore>, projectId = 'prj_1') {
  return store.openProject(projectId)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('空白项目', () => {
  it('创建项目不注入阶段模板；请求体没有 milestones 字段', async () => {
    const blank = makeCloudProject({
      projectId: 'prj_new',
      projectRevision: 1,
      currentMilestoneId: null,
      milestones: [],
      taskStats: { total: 0, done: 0, doing: 0, todo: 0, progress: 0 },
    })
    let body: Record<string, unknown> | null = null
    installFetch((url, init) => {
      if (init.method === 'POST' && url.endsWith('/api/projects')) {
        body = requestBody(init)
        return jsonResponse(echoEnvelope(init, { project: blank }, { projectId: 'prj_new', projectRevision: 1 }))
      }
      return undefined
    })
    const store = useCloudStore()

    const result = await store.createProject({ name: '空白项目', profile: emptyProfile() })

    expect(result.ok).toBe(true)
    expect(store.milestones).toEqual([])
    expect(store.project?.milestones).toEqual([])
    expect(store.currentMilestoneId).toBeNull()
    expect(body).not.toBeNull()
    expect(body).not.toHaveProperty('milestones')
    expect(body).not.toHaveProperty('milestoneTemplate')
  })

  it('服务端擅自注入阶段时拒绝提交状态', async () => {
    const injected = makeCloudProject({
      projectId: 'prj_bad',
      projectRevision: 1,
      milestones: [makeCloudMilestone()],
    })
    installFetch((url, init) => {
      if (init.method === 'POST' && url.endsWith('/api/projects')) {
        return jsonResponse(echoEnvelope(init, { project: injected }, { projectId: 'prj_bad', projectRevision: 1 }))
      }
      return undefined
    })
    const store = useCloudStore()

    const result = await store.createProject({ name: '空白项目', profile: emptyProfile() })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_RESPONSE')
    expect(store.project).toBeNull()
    expect(store.milestones).toEqual([])
  })
})

describe('阶段动作', () => {
  it('createMilestone 成功后才写入；并发重复调用只发一次请求', async () => {
    const fixture: ProjectFixture = {
      project: makeCloudProject({ projectId: 'prj_1', projectRevision: 1, milestones: [], currentMilestoneId: null }),
    }
    const pending = deferred<Response>()
    let postCount = 0
    let postInit: RequestInit | null = null
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixture })
      if (read !== undefined) return read
      if (init.method === 'POST' && url.endsWith('/api/projects/prj_1/milestones')) {
        postCount += 1
        postInit = init
        return pending.promise
      }
      return undefined
    })
    const store = useCloudStore()
    await open(store)

    const first = store.createMilestone({ name: '数据获取与预处理', goal: '拿到样例数据' })
    const secondResult = await store.createMilestone({ name: '数据获取与预处理', goal: '拿到样例数据' })
    expect(secondResult.ok).toBe(false)
    if (!secondResult.ok) expect(secondResult.code).toBe('DUPLICATE_REQUEST')

    const created = makeCloudMilestone({ milestoneId: 'ms_new', name: '数据获取与预处理' })
    if (postInit === null) throw new Error('没有捕获到阶段创建请求')
    pending.resolve(
      jsonResponse(
        echoEnvelope(postInit, { milestone: created }, { projectId: 'prj_1', projectRevision: 2 }),
      ),
    )
    const result = await first
    expect(result.ok).toBe(true)
    expect(postCount).toBe(1)
    expect(store.milestones.map((item) => item.milestoneId)).toEqual(['ms_new'])
    expect(store.projectRevision).toBe(2)
  })

  it('跨项目阶段 ID 被拒绝，且不发请求', async () => {
    const fixtureA: ProjectFixture = {
      project: makeCloudProject({ projectId: 'prj_1', projectRevision: 1, milestones: [makeCloudMilestone()] }),
    }
    const fixtureB: ProjectFixture = {
      project: makeCloudProject({ projectId: 'prj_2', projectRevision: 1, milestones: [], currentMilestoneId: null }),
    }
    let writeCount = 0
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixtureA, prj_2: fixtureB })
      if (read !== undefined) return read
      if ((init.method ?? 'GET') !== 'GET') {
        writeCount += 1
        return jsonResponse({ code: 'INVALID_REQUEST' }, 400)
      }
      return undefined
    })
    const store = useCloudStore()
    await open(store, 'prj_1')
    await open(store, 'prj_2')

    const update = await store.updateMilestone({ milestoneId: 'ms_1', expectedRevision: 1, name: '改名' })
    expect(update.ok).toBe(false)
    if (!update.ok) expect(update.code).toBe('PROJECT_MISMATCH')

    const task = await store.createTask({ title: '新任务', milestoneId: 'ms_1' })
    expect(task.ok).toBe(false)
    if (!task.ok) expect(task.code).toBe('PROJECT_MISMATCH')
    expect(writeCount).toBe(0)
  })

  it('重复阶段名在本地拦截', async () => {
    const fixture: ProjectFixture = {
      project: makeCloudProject({ projectId: 'prj_1', projectRevision: 1, milestones: [makeCloudMilestone()] }),
    }
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixture })
      if (read !== undefined) return read
      return undefined
    })
    const store = useCloudStore()
    await open(store)

    const result = await store.createMilestone({ name: ' 数据获取与预处理 ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MILESTONE_NAME_CONFLICT')
  })
})

describe('任务 / 进展 / 证据', () => {
  function makeFixture(): ProjectFixture {
    return {
      project: makeCloudProject({
        projectId: 'prj_1',
        projectRevision: 1,
        currentMilestoneId: 'ms_1',
        milestones: [
          makeCloudMilestone({ milestoneId: 'ms_1', status: 'active', taskStats: stats({ total: 1, doing: 1 }) }),
          makeCloudMilestone({ milestoneId: 'ms_2', name: '方法对比', orderIndex: 1, status: 'planned' }),
        ],
      }),
      evidence: [makeEvidence()],
      progress: [makeProgress()],
    }
  }

  it('createTask → linkTask → submitProgress → attachEvidence 全链路更新本地投影', async () => {
    const fixture = makeFixture()
    let task: CloudTask | null = null
    let evidence = fixture.evidence![0]!
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixture })
      if (read !== undefined) return read
      const method = init.method ?? 'GET'
      const body = requestBody(init)
      requests.push({ url, body })

      if (method === 'POST' && url.endsWith('/api/projects/prj_1/tasks')) {
        task = makeCloudTask({ taskId: 'tsk_new', projectId: 'prj_1', milestoneId: 'ms_1', revision: 1 })
        return jsonResponse(
          echoEnvelope(init, { task, milestoneStats: stats({ total: 2, doing: 2 }) }, { projectId: 'prj_1', projectRevision: 2 }),
        )
      }
      if (method === 'POST' && url.includes('/tasks/tsk_new/link-milestone')) {
        task = { ...task!, milestoneId: 'ms_2', milestoneName: '方法对比', revision: 2 }
        return jsonResponse(
          echoEnvelope(init, { task, milestoneStats: stats({ total: 1, doing: 1 }) }, { projectId: 'prj_1', projectRevision: 3 }),
        )
      }
      if (method === 'POST' && url.endsWith('/api/projects/prj_1/progress')) {
        const progress = makeProgress({ progressId: 'prg_new', summary: String(body['summary']) })
        return jsonResponse(
          echoEnvelope(init, { progress, milestoneStats: stats({ total: 1, done: 1 }) }, { projectId: 'prj_1', projectRevision: 4 }),
        )
      }
      if (method === 'POST' && url.includes('/evidence/evd_1/links')) {
        evidence = { ...evidence, taskId: 'tsk_new', milestoneId: 'ms_2', revision: 2 }
        return jsonResponse(
          echoEnvelope(init, { evidence, milestoneStats: stats({ total: 1, done: 1 }) }, { projectId: 'prj_1', projectRevision: 5 }),
        )
      }
      return undefined
    })
    const store = useCloudStore()
    const opened = await open(store)
    if (!opened.ok) throw new Error(`${opened.code}: ${opened.message}`)
    expect(opened.ok).toBe(true)

    const created = await store.createTask({ title: '跑通下载链路', milestoneId: 'ms_1' })
    expect(created.ok).toBe(true)
    expect(store.tasks).toHaveLength(1)
    expect(requests[0]!.body['requestId']).toMatch(UUID_V4)

    const linked = await store.linkTaskToMilestone({
      taskId: 'tsk_new',
      milestoneId: 'ms_2',
      expectedRevision: 1,
    })
    expect(linked.ok).toBe(true)
    expect(store.tasks[0]!.milestoneId).toBe('ms_2')

    const progressed = await store.submitProgress({
      milestoneId: 'ms_2',
      taskId: 'tsk_new',
      summary: '完成样例数据下载',
      evidenceIds: ['evd_1'],
    })
    expect(progressed.ok).toBe(true)
    expect(store.progress[0]!.progressId).toBe('prg_new')

    const attached = await store.attachEvidenceToTask({
      evidenceId: 'evd_1',
      taskId: 'tsk_new',
      milestoneId: 'ms_2',
      expectedRevision: 1,
    })
    expect(attached.ok).toBe(true)
    expect(store.evidence[0]!.taskId).toBe('tsk_new')
    expect(store.projectRevision).toBe(5)
  })

  it('未知任务不伪造通过：返回 TASKS_NOT_AVAILABLE，不发写请求', async () => {
    const fixture = makeFixture()
    let writes = 0
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixture })
      if (read !== undefined) return read
      if ((init.method ?? 'GET') !== 'GET') writes += 1
      return undefined
    })
    const store = useCloudStore()
    await open(store)

    const result = await store.linkTaskToMilestone({ taskId: 'tsk_unknown', milestoneId: 'ms_2', expectedRevision: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TASKS_NOT_AVAILABLE')
    expect(writes).toBe(0)
  })

  it('写失败不产生半更新，错误映射为中文', async () => {
    const fixture = makeFixture()
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixture })
      if (read !== undefined) return read
      if (init.method === 'POST' && url.endsWith('/api/projects/prj_1/tasks')) {
        return jsonResponse({ code: 'INTERNAL', message: '内部错误' }, 500)
      }
      return undefined
    })
    const store = useCloudStore()
    await open(store)

    const result = await store.createTask({ title: '会失败的任务', milestoneId: 'ms_1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INTERNAL')
      expect(result.message).toContain('服务内部错误')
    }
    expect(store.tasks).toEqual([])
    expect(store.lastError?.code).toBe('INTERNAL')
  })

  it('切换项目后，旧项目证据的关联请求被拒绝', async () => {
    const fixtureA = makeFixture()
    const fixtureB: ProjectFixture = {
      project: makeCloudProject({ projectId: 'prj_2', projectRevision: 1, milestones: [], currentMilestoneId: null }),
    }
    let writes = 0
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixtureA, prj_2: fixtureB })
      if (read !== undefined) return read
      if ((init.method ?? 'GET') !== 'GET') writes += 1
      return undefined
    })
    const store = useCloudStore()
    await open(store, 'prj_1')
    await open(store, 'prj_2')

    const result = await store.attachEvidenceToTask({
      evidenceId: 'evd_1',
      taskId: 'tsk_1',
      milestoneId: 'ms_1',
      expectedRevision: 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PROJECT_MISMATCH')
    expect(writes).toBe(0)
  })

  it('证据 revision 不匹配时本地拒绝', async () => {
    const fixture = makeFixture()
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixture })
      if (read !== undefined) return read
      return undefined
    })
    const store = useCloudStore()
    await open(store)

    const result = await store.attachEvidenceToTask({
      evidenceId: 'evd_1',
      taskId: 'tsk_unknown',
      milestoneId: 'ms_1',
      expectedRevision: 99,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_REVISION')
  })
})

describe('项目切换与过期响应', () => {
  it('切换项目后，旧项目的写响应被丢弃', async () => {
    const fixtureA: ProjectFixture = {
      project: makeCloudProject({ projectId: 'prj_1', projectRevision: 1, milestones: [makeCloudMilestone()] }),
    }
    const fixtureB: ProjectFixture = {
      project: makeCloudProject({ projectId: 'prj_2', projectRevision: 1, milestones: [], currentMilestoneId: null }),
    }
    const pending = deferred<Response>()
    let postInit: RequestInit | null = null
    installFetch((url, init) => {
      const read = routeRead(url, init.method ?? 'GET', { prj_1: fixtureA, prj_2: fixtureB })
      if (read !== undefined) return read
      if (init.method === 'POST' && url.endsWith('/api/projects/prj_1/tasks')) {
        postInit = init
        return pending.promise
      }
      return undefined
    })
    const store = useCloudStore()
    await open(store, 'prj_1')

    const create = store.createTask({ title: '旧项目任务', milestoneId: 'ms_1' })
    await open(store, 'prj_2')
    if (postInit === null) throw new Error('没有捕获到任务创建请求')
    pending.resolve(
      jsonResponse(
        echoEnvelope(
          postInit,
          { task: makeCloudTask({ taskId: 'tsk_late' }), milestoneStats: stats() },
          { projectId: 'prj_1', projectRevision: 2 },
        ),
      ),
    )

    const result = await create
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_RESPONSE')
    expect(store.project?.projectId).toBe('prj_2')
    expect(store.tasks).toEqual([])
  })

  it('缺少 timeline 端点时显式返回阻塞错误，不发请求', async () => {
    let calls = 0
    installFetch(() => {
      calls += 1
      return undefined
    })
    const store = useCloudStore()
    const result = store.loadTimeline()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TIMELINE_NOT_AVAILABLE')
    expect(calls).toBe(0)
    expect(store.contractBlockers.length).toBeGreaterThan(0)
  })
})
