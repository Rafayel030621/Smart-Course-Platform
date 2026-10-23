import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCloudStore } from '@/stores/cloud'
import { useWorkbenchStore } from '@/stores/workbench'
import { STORAGE_KEY_PROJECTS, savePersistedState } from '@/stores/persistence'
import { makeProject } from '../domain/fixtures'
import type { CloudEvidence, CloudProject, ProgressRecord } from '@/types/platform'
import {
  echoEnvelope,
  emptyProfile,
  installFetch,
  jsonResponse,
  makeCloudMilestone,
  makeCloudProject,
  makeCloudTask,
  makeEvidence,
  makeMilestoneStats,
  makeProgress,
  readEnvelope,
  requestBody,
} from '../support/v3Fixtures'

function baseProject(overrides: Partial<CloudProject> = {}): CloudProject {
  return makeCloudProject({
    projectId: 'prj_1',
    projectRevision: 1,
    currentMilestoneId: 'ms_1',
    milestones: [
      makeCloudMilestone({
        milestoneId: 'ms_1',
        revision: 1,
        status: 'active',
        taskStats: makeMilestoneStats(),
      }),
    ],
    taskStats: { total: 0, done: 0, doing: 0, todo: 0, progress: 0 },
    ...overrides,
  })
}

/** GET 读取路由；写路由交给每个测试的 handler */
function routesFor(
  project: CloudProject,
  evidence: CloudEvidence[] = [],
  progress: ProgressRecord[] = [],
) {
  return (url: string, init: RequestInit): Response | undefined => {
    if (init.method !== 'GET') return undefined
    if (url.endsWith(`/api/projects/${project.projectId}`)) {
      return jsonResponse(readEnvelope({ project }, project.projectId, project.projectRevision))
    }
    if (url.includes(`/api/projects/${project.projectId}/evidence`)) {
      return jsonResponse(
        readEnvelope({ evidence, nextCursor: null }, project.projectId, project.projectRevision),
      )
    }
    if (url.includes(`/api/projects/${project.projectId}/progress`)) {
      return jsonResponse(
        readEnvelope({ progress, nextCursor: null }, project.projectId, project.projectRevision),
      )
    }
    return undefined
  }
}

function installRoutes(
  project: CloudProject,
  writes: (url: string, init: RequestInit) => Response | undefined,
  evidence: CloudEvidence[] = [],
  progress: ProgressRecord[] = [],
) {
  const read = routesFor(project, evidence, progress)
  return installFetch((url, init) => read(url, init) ?? writes(url, init))
}

async function openProject(project = baseProject()): Promise<ReturnType<typeof useCloudStore>> {
  const store = useCloudStore()
  const result = await store.openProject(project.projectId)
  expect(result.ok).toBe(true)
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('项目资料与项目状态（契约 22.1）', () => {
  it('PATCH 项目资料成功后才更新，失败保留原状态', async () => {
    const project = baseProject()
    let mode: 'ok' | 'conflict' | 'offline' = 'ok'
    let lastBody: Record<string, unknown> | null = null
    const fetchMock = installRoutes(project, (url, init) => {
      if (!url.endsWith('/api/projects/prj_1') || init.method !== 'PATCH') return undefined
      if (mode === 'offline') throw new TypeError('offline')
      if (mode === 'conflict') {
        return jsonResponse({ code: 'STALE_REVISION', message: '项目版本已变化' }, 409)
      }
      lastBody = requestBody(init)
      const revision = Number(lastBody['projectRevision'])
      return jsonResponse(
        echoEnvelope(init, 
          { project: { ...project, name: String(lastBody['name']), projectRevision: revision + 1 } },
          { projectRevision: revision + 1 },
        ),
      )
    })
    const store = await openProject(project)

    const ok = await store.updateProject({ name: '新的项目名' })
    expect(ok.ok).toBe(true)
    expect(lastBody?.['projectRevision']).toBe(1)
    expect(lastBody?.['expectedRevision']).toBeUndefined()
    expect(store.project?.name).toBe('新的项目名')
    expect(store.projectRevision).toBe(2)

    mode = 'conflict'
    const rejected = await store.updateProject({ name: '不应生效' })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('STALE_REVISION')
    expect(store.project?.name).toBe('新的项目名')
    expect(store.lastError?.code).toBe('STALE_REVISION')

    mode = 'offline'
    const offline = await store.updateProject({ name: '网络失败也不生效' })
    expect(offline.ok).toBe(false)
    if (!offline.ok) expect(offline.code).toBe('NETWORK_ERROR')
    expect(store.project?.name).toBe('新的项目名')
    expect(fetchMock).toHaveBeenCalled()

    // 网络恢复后可直接重试，不丢已有状态
    mode = 'ok'
    const retried = await store.updateProject({ name: '重试成功' })
    expect(retried.ok).toBe(true)
    expect(lastBody?.['projectRevision']).toBe(2)
    expect(store.project?.name).toBe('重试成功')
    expect(store.projectRevision).toBe(3)
  })

  it('跨项目 ID 直接拒绝，不发请求', async () => {
    const project = baseProject()
    const fetchMock = installRoutes(project, () => undefined)
    const store = await openProject(project)

    const result = await store.updateProject({ projectId: 'prj_other', name: '别的项目' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PROJECT_MISMATCH')
    const writes = fetchMock.mock.calls.filter(([, init]) => init.method !== 'GET')
    expect(writes).toHaveLength(0)
  })

  it('归档后禁止继续写入；restore 只对已归档项目发请求', async () => {
    const project = baseProject()
    let action: string | null = null
    installRoutes(project, (url, init) => {
      const match = /\/api\/projects\/prj_1\/(archive|restore|delete|restore-deleted)$/.exec(url)
      if (match === null || init.method !== 'POST') return undefined
      action = match[1]!
      const nextStatus = action === 'delete' ? 'deleted' : 'archived'
      return jsonResponse(
        echoEnvelope(init, 
          {
            project: {
              ...project,
              status: action === 'restore' ? 'active' : nextStatus,
              projectRevision: 2,
            },
          },
          { projectRevision: 2 },
        ),
      )
    })
    const store = await openProject(project)

    const archived = await store.archiveProject()
    expect(archived.ok).toBe(true)
    expect(action).toBe('archive')
    expect(store.project?.status).toBe('archived')

    const blocked = await store.createMilestone({ name: '归档后不能创建' })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.code).toBe('PROJECT_ARCHIVED')
    expect(action).toBe('archive')

    const restored = await store.restoreProject()
    expect(restored.ok).toBe(true)
    expect(action).toBe('restore')
    expect(store.project?.status).toBe('active')
  })
})

describe('云端与本地数据隔离', () => {
  it('云端写入不修改本地项目与 localStorage', async () => {
    const local = makeProject({ projectId: 'prj_local_1', name: '本地项目' })
    expect(savePersistedState([local], local.projectId).ok).toBe(true)
    const before = localStorage.getItem(STORAGE_KEY_PROJECTS)
    const workbench = useWorkbenchStore()
    expect(workbench.projects.map((item) => item.name)).toEqual(['本地项目'])

    const project = baseProject()
    installRoutes(project, (url, init) => {
      if (!url.endsWith('/api/projects/prj_1') || init.method !== 'PATCH') return undefined
      return jsonResponse(
        echoEnvelope(init, { project: { ...project, name: '云端改名', projectRevision: 2 } }, {
          projectRevision: 2,
        }),
      )
    })
    const store = await openProject(project)

    const result = await store.updateProject({ name: '云端改名' })

    expect(result.ok).toBe(true)
    expect(store.project?.name).toBe('云端改名')
    expect(localStorage.getItem(STORAGE_KEY_PROJECTS)).toBe(before)
    expect(workbench.projects.map((item) => item.name)).toEqual(['本地项目'])
  })
})

describe('阶段状态动作（契约 22.2）', () => {
  it('archive / restore 使用 expectedRevision，并按服务端结果重算当前阶段', async () => {
    const project = baseProject()
    const sent: Array<{ url: string; body: Record<string, unknown> }> = []
    installRoutes(project, (url, init) => {
      if (init.method !== 'POST' || !url.includes('/milestones/ms_1/')) return undefined
      const body = requestBody(init)
      sent.push({ url, body })
      const restored = url.endsWith('/restore')
      return jsonResponse(
        echoEnvelope(init, 
          {
            milestone: {
              ...project.milestones[0]!,
              status: restored ? 'active' : 'archived',
              revision: 2,
              archivedAt: restored ? null : '2026-10-19T03:00:00.000Z',
            },
          },
          { projectRevision: 2, changed: true },
        ),
      )
    })
    const store = await openProject(project)

    const archived = await store.archiveMilestone({ milestoneId: 'ms_1', expectedRevision: 1 })
    expect(archived.ok).toBe(true)
    expect(sent[0]?.url).toContain('/milestones/ms_1/archive')
    expect(sent[0]?.body['expectedRevision']).toBe(1)
    expect(store.project?.milestones).toEqual([])
    expect(store.currentMilestoneId).toBeNull()

    const restoreTarget = store.milestones.find((item) => item.milestoneId === 'ms_1')
    const restored = await store.restoreMilestone({
      milestoneId: 'ms_1',
      expectedRevision: restoreTarget?.revision ?? 2,
    })
    expect(restored.ok).toBe(true)
    expect(store.project?.milestones.map((item) => item.milestoneId)).toEqual(['ms_1'])
    expect(store.currentMilestoneId).toBe('ms_1')
  })

  it('新建 active 阶段后当前阶段随之更新，AI 上下文立刻拿到它', async () => {
    const project = baseProject({ currentMilestoneId: null, milestones: [] })
    installRoutes(project, (url, init) => {
      if (init.method !== 'POST' || !url.endsWith(`/api/projects/${project.projectId}/milestones`)) {
        return undefined
      }
      return jsonResponse(
        echoEnvelope(
          init,
          {
            milestone: makeCloudMilestone({
              milestoneId: 'ms_new',
              name: '数据获取与预处理',
              status: 'active',
              revision: 1,
              taskStats: makeMilestoneStats(),
            }),
          },
          { projectRevision: 2 },
        ),
      )
    })
    const store = await openProject(project)
    expect(store.currentMilestoneId).toBeNull()

    const created = await store.createMilestone({ name: '数据获取与预处理', status: 'active' })

    expect(created.ok).toBe(true)
    // 契约 22.2：currentMilestoneId = 第一个 active（创建响应只回 milestone，本地按同一规则重算）
    expect(store.currentMilestoneId).toBe('ms_new')
    const context = store.buildAdvisorContext()
    expect(context.ok).toBe(true)
    if (context.ok) expect(context.data.milestoneId).toBe('ms_new')
  })

  it('版本不一致时本地拒绝，服务端 409 也不改状态', async () => {
    const project = baseProject()
    let requests = 0
    installRoutes(project, (url, init) => {
      if (init.method !== 'POST' || !url.includes('/milestones/ms_1/complete')) return undefined
      requests += 1
      return jsonResponse({ code: 'INVALID_STATE_TRANSITION', message: '阶段状态不允许该操作' }, 409)
    })
    const store = await openProject(project)

    const stale = await store.completeMilestone({ milestoneId: 'ms_1', expectedRevision: 9 })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('STALE_REVISION')
    expect(requests).toBe(0)

    const rejected = await store.completeMilestone({ milestoneId: 'ms_1', expectedRevision: 1 })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('INVALID_STATE_TRANSITION')
    expect(requests).toBe(1)
    expect(store.milestones[0]?.status).toBe('active')
  })
})

describe('任务写动作（契约 22.3）', () => {
  it('创建任务只允许 todo/doing；更新与状态动作使用 expectedRevision', async () => {
    const project = baseProject()
    const task = makeCloudTask({
      taskId: 'tsk_1',
      projectId: 'prj_1',
      milestoneId: 'ms_1',
      revision: 1,
      status: 'todo',
    })
    let created = false
    const sent: Array<{ url: string; body: Record<string, unknown> }> = []
    installRoutes(project, (url, init) => {
      if (url.endsWith('/api/projects/prj_1/tasks') && init.method === 'POST') {
        created = true
        return jsonResponse(
          echoEnvelope(init, 
            {
              task,
              milestoneStats: makeMilestoneStats({ total: 1, todo: 1 }),
            },
            { projectRevision: 2 },
          ),
        )
      }
      if (url.endsWith('/api/projects/prj_1/tasks/tsk_1') && init.method === 'PATCH') {
        const body = requestBody(init)
        sent.push({ url, body })
        return jsonResponse(
          echoEnvelope(init, 
            {
              task: { ...task, title: String(body['title']), revision: 2 },
              milestoneStats: makeMilestoneStats({ total: 1, todo: 1 }),
            },
            { projectRevision: 3 },
          ),
        )
      }
      if (url.includes('/api/projects/prj_1/tasks/tsk_1/') && init.method === 'POST') {
        const body = requestBody(init)
        sent.push({ url, body })
        const action = url.split('/').pop()
        const status = action === 'start' ? 'doing' : action === 'complete' ? 'done' : 'done'
        return jsonResponse(
          echoEnvelope(init, 
            {
              task: { ...task, status, revision: 3 },
              milestoneStats: makeMilestoneStats({ total: 1, done: 1 }),
            },
            { projectRevision: 4 },
          ),
        )
      }
      return undefined
    })
    const store = await openProject(project)

    const invalid = await store.createTask({
      title: '非法状态',
      milestoneId: 'ms_1',
      status: 'done' as never,
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.code).toBe('INVALID_INPUT')
    expect(created).toBe(false)

    const result = await store.createTask({ title: '新任务', milestoneId: 'ms_1' })
    expect(result.ok).toBe(true)
    expect(store.tasks).toHaveLength(1)

    const firstUpdate = store.updateTask({
      taskId: 'tsk_1',
      expectedRevision: 1,
      title: '改名后的任务',
    })
    const duplicate = await store.updateTask({
      taskId: 'tsk_1',
      expectedRevision: 1,
      title: '重复提交',
    })
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.code).toBe('DUPLICATE_REQUEST')
    const renamed = await firstUpdate
    expect(renamed.ok).toBe(true)
    expect(sent.filter((item) => item.url.endsWith('/tasks/tsk_1'))).toHaveLength(1)
    expect(sent[0]?.body['expectedRevision']).toBe(1)
    expect(store.tasks[0]?.title).toBe('改名后的任务')

    const started = await store.startTask({ taskId: 'tsk_1', expectedRevision: 2 })
    expect(started.ok).toBe(true)
    expect(sent[1]?.url).toContain('/tasks/tsk_1/start')
    expect(store.tasks[0]?.status).toBe('doing')

    const stale = await store.completeTask({ taskId: 'tsk_1', expectedRevision: 1 })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('STALE_REVISION')
  })

  it('切换项目后，旧任务的更新响应被丢弃', async () => {
    const projectA = baseProject()
    const projectB = baseProject({
      projectId: 'prj_2',
      name: '项目二',
      projectRevision: 5,
    })
    const task = makeCloudTask({ taskId: 'tsk_1', projectId: 'prj_1', revision: 1 })
    let resolvePatch!: (value: Response) => void
    let patchInit: RequestInit | null = null
    const patch = new Promise<Response>((resolve) => {
      resolvePatch = resolve
    })
    const readA = routesFor(projectA)
    const readB = routesFor(projectB)
    installFetch((url, init) => {
      if (url.endsWith('/api/projects/prj_1/tasks') && init.method === 'POST') {
        return jsonResponse(echoEnvelope(init, { task, milestoneStats: null }, { projectRevision: 2 }))
      }
      if (url.endsWith('/api/projects/prj_1/tasks/tsk_1') && init.method === 'PATCH') {
        patchInit = init
        return patch
      }
      return readA(url, init) ?? readB(url, init) ?? undefined
    })
    const store = useCloudStore()
    await store.openProject('prj_1')
    await store.createTask({ title: '旧项目任务', milestoneId: 'ms_1' })

    const pending = store.updateTask({ taskId: 'tsk_1', expectedRevision: 1, title: '迟到改名' })
    await store.openProject('prj_2')
    resolvePatch(
      jsonResponse(
        echoEnvelope(patchInit!, 
          { task: { ...task, title: '迟到改名', revision: 2 }, milestoneStats: null },
          { projectId: 'prj_1', projectRevision: 3 },
        ),
      ),
    )
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_RESPONSE')
    expect(store.project?.projectId).toBe('prj_2')
    expect(store.project?.name).toBe('项目二')
    expect(store.tasks.every((item) => item.projectId === 'prj_2')).toBe(true)
  })
})

describe('证据写入（契约 22.5）', () => {
  it('创建证据按契约字段提交；completeTask 必须带任务版本', async () => {
    const project = baseProject()
    const task = makeCloudTask({
      taskId: 'tsk_1',
      projectId: 'prj_1',
      milestoneId: 'ms_1',
      revision: 4,
      status: 'doing',
    })
    const evidence = makeEvidence({ evidenceId: 'evd_new', revision: 1 })
    let requests = 0
    let lastBody: Record<string, unknown> | null = null
    installRoutes(project, (url, init) => {
      if (url.endsWith('/api/projects/prj_1/tasks') && init.method === 'POST') {
        return jsonResponse(echoEnvelope(init, { task, milestoneStats: null }, { projectRevision: 2 }))
      }
      if (!url.endsWith('/api/projects/prj_1/evidence') || init.method !== 'POST') return undefined
      requests += 1
      lastBody = requestBody(init)
      return jsonResponse(
        echoEnvelope(init, 
          {
            evidence,
            doubt: {
              doubtId: 'dbt_1',
              text: '分辨率是否够用',
              status: 'open',
              sourceEvidenceId: 'evd_new',
              createdAt: '2026-10-19T03:00:00.000Z',
            },
            task: { ...task, status: 'done', revision: 5 },
            milestoneStats: makeMilestoneStats({ total: 1, done: 1 }),
          },
          { projectRevision: 5 },
        ),
      )
    })
    const store = await openProject(project)
    await store.createTask({ title: '提交证据的任务', milestoneId: 'ms_1' })

    const missingRevision = await store.createEvidence({
      taskId: 'tsk_1',
      milestoneId: 'ms_1',
      didWhat: '下载了样例数据',
      completeTask: true,
    })
    expect(missingRevision.ok).toBe(false)
    if (!missingRevision.ok) expect(missingRevision.code).toBe('INVALID_INPUT')
    expect(requests).toBe(0)

    const stale = await store.createEvidence({
      taskId: 'tsk_1',
      milestoneId: 'ms_1',
      didWhat: '下载了样例数据',
      completeTask: true,
      expectedTaskRevision: 99,
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('STALE_REVISION')
    expect(requests).toBe(0)

    const created = await store.createEvidence({
      taskId: 'tsk_1',
      milestoneId: 'ms_1',
      didWhat: '下载了样例数据',
      foundWhat: '字段完整',
      stillUnsure: '分辨率是否够用',
      attachmentName: 'sample.csv',
      completeTask: true,
      expectedTaskRevision: 4,
    })

    expect(created.ok).toBe(true)
    expect(requests).toBe(1)
    expect(lastBody?.['taskId']).toBe('tsk_1')
    expect(lastBody?.['milestoneId']).toBe('ms_1')
    expect(lastBody?.['didWhat']).toBe('下载了样例数据')
    expect(lastBody?.['foundWhat']).toBe('字段完整')
    expect(lastBody?.['completeTask']).toBe(true)
    expect(lastBody?.['expectedTaskRevision']).toBe(4)
    expect(store.evidence.map((item) => item.evidenceId)).toContain('evd_new')
    expect(store.tasks[0]?.status).toBe('done')
    if (created.ok) expect(created.data.doubt?.status).toBe('open')
  })

  it('证据关联允许 taskId / milestoneId 为 null，失败不清空已有证据', async () => {
    const evidence = makeEvidence({ evidenceId: 'evd_1', revision: 1 })
    const progress = makeProgress({ progressId: 'prg_1' })
    const project = baseProject()
    let body: Record<string, unknown> | null = null
    let fail = false
    installRoutes(
      project,
      (url, init) => {
        if (!url.endsWith('/evidence/evd_1/links') || init.method !== 'POST') return undefined
        if (fail) return jsonResponse({ code: 'EVIDENCE_REVISION_MISMATCH', message: '证据版本已变化' }, 409)
        body = requestBody(init)
        return jsonResponse(
          echoEnvelope(init, 
            {
              evidence: { ...evidence, taskId: null, milestoneId: null, revision: 2 },
              milestoneStats: null,
            },
            { projectRevision: 2 },
          ),
        )
      },
      [evidence],
      [progress],
    )
    const store = await openProject(project)

    const unlinked = await store.attachEvidenceToTask({
      evidenceId: 'evd_1',
      taskId: null,
      milestoneId: null,
      expectedRevision: 1,
    })
    expect(unlinked.ok).toBe(true)
    expect(body?.['taskId']).toBeNull()
    expect(body?.['milestoneId']).toBeNull()

    fail = true
    const rejected = await store.attachEvidenceToTask({
      evidenceId: 'evd_1',
      taskId: null,
      milestoneId: null,
      expectedRevision: 2,
    })
    expect(rejected.ok).toBe(false)
    expect(store.evidence).toHaveLength(1)
    expect(store.progress).toHaveLength(1)
    expect(store.evidence[0]?.evidenceId).toBe('evd_1')
  })
})

describe('AI 阶段上下文（契约 23.2）', () => {
  it('任务统计为 0 时返回完整空任务上下文；统计不完整时拒绝', async () => {
    const project = baseProject()
    installRoutes(project, () => undefined)
    const store = await openProject(project)

    const empty = store.buildAdvisorContext()
    expect(empty.ok).toBe(true)
    if (empty.ok) {
      expect(empty.data.milestoneId).toBe('ms_1')
      expect(empty.data.milestoneTasks).toEqual([])
    }

    const withTasks = baseProject({
      projectRevision: 2,
      milestones: [
        makeCloudMilestone({
          milestoneId: 'ms_1',
          revision: 2,
          status: 'active',
          taskStats: makeMilestoneStats({ total: 1, doing: 1 }),
        }),
      ],
    })
    installRoutes(withTasks, () => undefined)
    const second = await openProject(withTasks)
    const incomplete = second.buildAdvisorContext()
    expect(incomplete.ok).toBe(false)
    if (!incomplete.ok) expect(incomplete.code).toBe('TASKS_NOT_AVAILABLE')
  })
})

describe('创建项目', () => {
  it('服务端返回的项目所有者与当前用户不一致时拒绝', async () => {
    const project = baseProject({
      ownerUserId: 'usr_other',
      currentMilestoneId: null,
      milestones: [],
      taskStats: { total: 0, done: 0, doing: 0, todo: 0, progress: 0 },
    })
    installFetch((url, init) => {
      if (url.endsWith('/api/projects') && init.method === 'POST') {
        return jsonResponse(echoEnvelope(init, { project }, { projectRevision: 1 }))
      }
      return undefined
    })
    const store = useCloudStore()

    const result = await store.createProject(
      { name: '越权项目', profile: emptyProfile() },
      { expectedOwnerUserId: 'usr_1' },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PROJECT_NOT_FOUND')
    expect(store.project).toBeNull()
  })
})
