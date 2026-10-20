import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlatformStore } from '@/stores/platform'
import { useCloudStore } from '@/stores/cloud'
import { useSessionStore } from '@/stores/session'
import { useWorkbenchStore } from '@/stores/workbench'
import { savePersistedState } from '@/stores/persistence'
import {
  emptyProfile,
  installFetch,
  jsonResponse,
  makeCloudProject,
  makeProjectSummary,
  makeUser,
  readEnvelope,
  requestBody,
} from '../support/v3Fixtures'
import { makeProject } from '../domain/fixtures'

const LOCAL_PROJECTS_KEY = 'scp.mvp.projects'
const USER = makeUser()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function meResponse() {
  return jsonResponse({
    requestId: null,
    user: USER,
    sessionExpiresAt: '2026-10-26T02:30:00.000Z',
  })
}

function listResponse(projects = [makeProjectSummary()]) {
  return jsonResponse({
    contractVersion: '3.0',
    projectId: null,
    projectRevision: null,
    data: { projects },
  })
}

/** 带阶段与一个任务的云端项目（任务统计由服务端给出） */
function projectFixture(projectId: string, name: string) {
  return makeCloudProject({
    projectId,
    name,
    milestones: [],
    currentMilestoneId: null,
    taskStats: { total: 0, done: 0, doing: 0, todo: 0, progress: 0 },
  })
}

function readRoutes(fixture: ReturnType<typeof projectFixture>, projectId: string): Response {
  return jsonResponse(readEnvelope({ project: fixture }, projectId, fixture.projectRevision))
}

function seedLocalProject(): void {
  const project = makeProject({
    projectId: 'prj_local_1',
    name: '本地项目',
    projectRevision: 3,
  })
  const result = savePersistedState([project], project.projectId)
  expect(result.ok).toBe(true)
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('启动会话只初始化一次', () => {
  it('并发与重复调用只请求一次 /api/auth/me，并加载云端项目', async () => {
    const fetchMock = installFetch((url) => {
      if (url.endsWith('/api/auth/me')) return meResponse()
      if (url.endsWith('/api/projects')) return listResponse()
      return undefined
    })
    const platform = usePlatformStore()

    const [first, second] = await Promise.all([platform.initialize(), platform.initialize()])
    const third = await platform.initialize()

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(third.ok).toBe(true)
    expect(platform.initialized).toBe(true)
    expect(platform.authStatus).toBe('authenticated')
    expect(platform.isCloudSource).toBe(true)
    expect(platform.cloudProjects).toHaveLength(1)
    expect(platform.cloudChoices[0]?.value).toBe('cloud:prj_1')

    const meCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/api/auth/me'),
    )
    expect(meCalls).toHaveLength(1)
  })

  it('未登录：不加载云端项目，本地项目原样保留', async () => {
    seedLocalProject()
    const localBefore = localStorage.getItem(LOCAL_PROJECTS_KEY)
    const fetchMock = installFetch((url) => {
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ code: 'UNAUTHORIZED', message: '登录状态已失效' }, 401)
      }
      return undefined
    })
    const platform = usePlatformStore()

    const result = await platform.initialize()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNAUTHORIZED')
    expect(platform.authStatus).toBe('unauthenticated')
    expect(platform.projectsStatus).toBe('idle')
    expect(platform.cloudProjects).toEqual([])
    expect(platform.isCloudSource).toBe(false)
    expect(platform.hasLocalProjects).toBe(true)
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).toBe(localBefore)

    const projectCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/api/projects'),
    )
    expect(projectCalls).toHaveLength(0)
  })

  it('启动网络失败：进入 error、不请求项目列表、不伪装成未登录', async () => {
    seedLocalProject()
    const localBefore = localStorage.getItem(LOCAL_PROJECTS_KEY)
    const fetchMock = installFetch((url) => {
      if (url.endsWith('/api/auth/me')) throw new TypeError('network down')
      return undefined
    })
    const platform = usePlatformStore()

    const result = await platform.initialize()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NETWORK_ERROR')
    expect(platform.authStatus).toBe('error')
    expect(platform.initError?.code).toBe('NETWORK_ERROR')
    expect(platform.cloudProjects).toEqual([])
    expect(platform.isCloudSource).toBe(false)
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).toBe(localBefore)
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/projects')),
    ).toHaveLength(0)
  })
})

describe('登录后加载项目', () => {
  it('登录成功才请求 /api/projects，并切换到云端来源', async () => {
    let projectCalls = 0
    installFetch((url, init) => {
      if (url.endsWith('/api/auth/login')) {
        const body = requestBody(init)
        return jsonResponse({
          contractVersion: '3.0',
          requestId: body['requestId'],
          user: USER,
          sessionExpiresAt: '2026-10-26T02:30:00.000Z',
          replayed: false,
        })
      }
      if (url.endsWith('/api/projects')) {
        projectCalls += 1
        return listResponse()
      }
      return undefined
    })
    const platform = usePlatformStore()

    expect(projectCalls).toBe(0)
    const result = await platform.login('student01', 'pw')

    expect(result.ok).toBe(true)
    expect(platform.authStatus).toBe('authenticated')
    expect(platform.isCloudSource).toBe(true)
    expect(platform.cloudProjects).toHaveLength(1)
    expect(projectCalls).toBe(1)
  })
})

describe('云端项目列表与切换', () => {
  it('刷新失败不清空已有列表', async () => {
    let projectCalls = 0
    installFetch((url) => {
      if (url.endsWith('/api/auth/me')) return meResponse()
      if (url.endsWith('/api/projects')) {
        projectCalls += 1
        if (projectCalls === 1) return listResponse()
        throw new TypeError('offline')
      }
      return undefined
    })
    const platform = usePlatformStore()
    await platform.initialize()
    expect(platform.cloudProjects).toHaveLength(1)

    const result = await platform.refreshCloudProjects()

    expect(result.ok).toBe(false)
    expect(platform.projectsStatus).toBe('error')
    expect(platform.cloudProjects).toHaveLength(1)
    expect(platform.projectsError?.code).toBe('NETWORK_ERROR')
  })

  it('未登录时拒绝切换云端项目，且不发请求', async () => {
    const fetchMock = installFetch(() => undefined)
    const platform = usePlatformStore()

    const result = await platform.selectCloudProject('prj_1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNAUTHORIZED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('不在当前用户项目列表里的 ID 不发请求（防跨用户）', async () => {
    installFetch((url) => {
      if (url.endsWith('/api/auth/me')) return meResponse()
      if (url.endsWith('/api/projects')) return listResponse()
      return undefined
    })
    const platform = usePlatformStore()
    await platform.initialize()
    vi.stubGlobal('fetch', vi.fn())

    const result = await platform.selectCloudProject('prj_other_user')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PROJECT_NOT_FOUND')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('切换项目的迟到响应被丢弃，只保留最后一次选择', async () => {
    const projectA = projectFixture('prj_a', '项目 A')
    const projectB = projectFixture('prj_b', '项目 B')
    const detailA = deferred<Response>()
    installFetch((url, init) => {
      if (url.endsWith('/api/auth/me')) return meResponse()
      if (url.endsWith('/api/projects')) {
        return listResponse([
          makeProjectSummary({ projectId: 'prj_a', name: '项目 A' }),
          makeProjectSummary({ projectId: 'prj_b', name: '项目 B' }),
        ])
      }
      if (init.method === 'GET' && url.endsWith('/api/projects/prj_a')) return detailA.promise
      if (init.method === 'GET' && url.endsWith('/api/projects/prj_b')) {
        return readRoutes(projectB, 'prj_b')
      }
      if (url.includes('/api/projects/prj_a/evidence') || url.includes('/api/projects/prj_a/progress')) {
        return jsonResponse(readEnvelope({ evidence: [], progress: [], nextCursor: null }, 'prj_a', 1))
      }
      if (url.includes('/api/projects/prj_b/evidence')) {
        return jsonResponse(readEnvelope({ evidence: [], nextCursor: null }, 'prj_b', 1))
      }
      if (url.includes('/api/projects/prj_b/progress')) {
        return jsonResponse(readEnvelope({ progress: [], nextCursor: null }, 'prj_b', 1))
      }
      return undefined
    })
    const platform = usePlatformStore()
    const cloud = useCloudStore()
    await platform.initialize()

    const first = platform.selectCloudProject('prj_a')
    await vi.waitFor(() => expect(cloud.sync.projectId).toBe('prj_a'))
    const second = await platform.selectCloudProject('prj_b')
    expect(second.ok).toBe(true)

    detailA.resolve(readRoutes(projectA, 'prj_a'))
    const stale = await first

    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('STALE_RESPONSE')
    expect(cloud.project?.projectId).toBe('prj_b')
    expect(platform.cloudProjectView?.name).toBe('项目 B')
  })
})

describe('退出登录', () => {
  it('只清会话与云端状态，不删除本地项目，并回到本地来源', async () => {
    seedLocalProject()
    const localBefore = localStorage.getItem(LOCAL_PROJECTS_KEY)
    installFetch((url, init) => {
      if (url.endsWith('/api/auth/me')) return meResponse()
      if (url.endsWith('/api/projects')) return listResponse()
      if (init.method === 'GET' && url.endsWith('/api/projects/prj_1')) {
        return jsonResponse(
          readEnvelope({ project: projectFixture('prj_1', '云端项目') }, 'prj_1', 1),
        )
      }
      if (url.includes('/api/projects/prj_1/evidence')) {
        return jsonResponse(readEnvelope({ evidence: [], nextCursor: null }, 'prj_1', 1))
      }
      if (url.includes('/api/projects/prj_1/progress')) {
        return jsonResponse(readEnvelope({ progress: [], nextCursor: null }, 'prj_1', 1))
      }
      if (url.endsWith('/api/auth/logout')) return jsonResponse({ loggedOut: true })
      return undefined
    })
    const platform = usePlatformStore()
    const session = useSessionStore()
    const cloud = useCloudStore()
    const workbench = useWorkbenchStore()
    await platform.initialize()
    await platform.selectCloudProject('prj_1')
    expect(cloud.project?.projectId).toBe('prj_1')

    const result = await platform.logout()

    expect(result.ok).toBe(true)
    expect(session.status).toBe('unauthenticated')
    expect(platform.cloudProjects).toEqual([])
    expect(cloud.project).toBeNull()
    expect(platform.isCloudSource).toBe(false)
    expect(platform.cloudProjectView).toBeNull()
    expect(workbench.projects.map((item) => item.projectId)).toEqual(['prj_local_1'])
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).toBe(localBefore)
  })
})

describe('云端项目创建', () => {
  it('未登录拒绝创建，且不发请求', async () => {
    const fetchMock = installFetch(() => undefined)
    const platform = usePlatformStore()

    const result = await platform.createCloudProject({ name: '新项目', profile: emptyProfile() })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNAUTHORIZED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('登录后创建成功会刷新项目列表', async () => {
    let created = false
    installFetch((url, init) => {
      if (url.endsWith('/api/auth/me')) return meResponse()
      if (url.endsWith('/api/projects') && init.method === 'POST') {
        created = true
        const body = requestBody(init)
        return jsonResponse({
          contractVersion: '3.0',
          requestId: body['requestId'],
          projectId: 'prj_new',
          projectRevision: 1,
          replayed: false,
          data: {
            project: makeCloudProject({
              projectId: 'prj_new',
              name: '新项目',
              projectRevision: 1,
              ownerUserId: USER.userId,
              currentMilestoneId: null,
              currentMilestone: null,
              milestones: [],
              taskStats: { total: 0, done: 0, doing: 0, todo: 0, progress: 0 },
            }),
          },
        })
      }
      if (url.endsWith('/api/projects')) {
        return listResponse([makeProjectSummary({ projectId: 'prj_new', name: '新项目' })])
      }
      return undefined
    })
    const platform = usePlatformStore()
    await platform.initialize()
    expect(platform.hasCloudProjects).toBe(true)

    const result = await platform.createCloudProject({ name: '新项目', profile: emptyProfile() })

    expect(result.ok).toBe(true)
    expect(created).toBe(true)
    expect(platform.isCloudSource).toBe(true)
    expect(platform.cloudProjects.map((item) => item.projectId)).toEqual(['prj_new'])
  })
})

describe('本地迁移只能显式触发', () => {
  it('启动与只读检测都不发迁移请求；确认失败保留本地数据', async () => {
    seedLocalProject()
    const localBefore = localStorage.getItem(LOCAL_PROJECTS_KEY)
    let migrateCalls = 0
    installFetch((url) => {
      if (url.endsWith('/api/auth/me')) return meResponse()
      if (url.endsWith('/api/projects')) return listResponse([])
      if (url.endsWith('/api/projects/migrate-local')) {
        migrateCalls += 1
        throw new TypeError('timeout')
      }
      return undefined
    })
    const platform = usePlatformStore()

    await platform.initialize()
    expect(migrateCalls).toBe(0)

    const candidates = platform.detectLocalMigration()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.status).toBe('pending-confirmation')
    expect(migrateCalls).toBe(0)

    const result = await platform.confirmLocalMigration('prj_local_1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NETWORK_ERROR')
    expect(migrateCalls).toBe(1)
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).toBe(localBefore)
    expect(platform.cloudProjects).toEqual([])
  })
})
