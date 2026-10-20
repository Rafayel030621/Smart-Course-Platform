import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '@/stores/session'
import { useCloudStore } from '@/stores/cloud'
import {
  installFetch,
  jsonResponse,
  makeProjectSummary,
  makeUser,
  requestBody,
} from '../support/v3Fixtures'

const USER_A = makeUser()
const USER_B = makeUser({ userId: 'usr_2', account: 'student02', displayName: '王同学' })
const LOCAL_PROJECTS_KEY = 'scp.mvp.projects'
const LOCAL_PROJECTS_VALUE = JSON.stringify({
  schemaVersion: 3,
  projects: [{ projectId: 'prj_local_1', name: '本地项目', schemaVersion: 3 }],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function listResponse(projects: ReturnType<typeof makeProjectSummary>[] = [makeProjectSummary()]) {
  return jsonResponse({
    contractVersion: '3.0',
    projectId: null,
    projectRevision: null,
    data: { projects },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('V3 启动鉴权', () => {
  it('GET /api/auth/me 成功：进入 authenticated 并加载当前用户项目', async () => {
    localStorage.setItem(LOCAL_PROJECTS_KEY, LOCAL_PROJECTS_VALUE)
    const fetchMock = installFetch((url) => {
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({
          requestId: null,
          user: USER_A,
          sessionExpiresAt: '2026-10-26T02:30:00.000Z',
        })
      }
      if (url.endsWith('/api/projects')) return listResponse()
      return undefined
    })
    const store = useSessionStore()

    const result = await store.restoreSession()

    expect(result.ok).toBe(true)
    expect(store.status).toBe('authenticated')
    expect(store.currentUserId).toBe(USER_A.userId)
    expect(store.projects).toHaveLength(1)
    expect(store.projectsStatus).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const meInit = fetchMock.mock.calls[0]![1] as RequestInit
    expect(meInit.credentials).toBe('include')
    expect(JSON.stringify(meInit.headers)).not.toContain('authorization')
    expect(JSON.stringify(meInit.headers)).not.toContain('cookie')

    // 不写任何会话令牌/身份到 localStorage
    const keys = Object.keys(localStorage)
    expect(keys).toEqual([LOCAL_PROJECTS_KEY])
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).toBe(LOCAL_PROJECTS_VALUE)
  })

  it('401：明确进入 unauthenticated，不把失败伪装成网络错误', async () => {
    installFetch((url) => {
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ code: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录' }, 401)
      }
      return undefined
    })
    const store = useSessionStore()

    const result = await store.restoreSession()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNAUTHORIZED')
    expect(store.status).toBe('unauthenticated')
    expect(store.projects).toEqual([])
    expect(store.projectsStatus).toBe('idle')
  })

  it('网络失败：进入 error，不伪装成未登录，也不清空本地项目', async () => {
    localStorage.setItem(LOCAL_PROJECTS_KEY, LOCAL_PROJECTS_VALUE)
    installFetch((url) => {
      if (url.endsWith('/api/auth/me')) throw new TypeError('network down')
      return undefined
    })
    const store = useSessionStore()

    const result = await store.restoreSession()

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NETWORK_ERROR')
    expect(store.status).toBe('error')
    expect(store.auth.user).toBeNull()
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).toBe(LOCAL_PROJECTS_VALUE)
  })
})

describe('退出登录', () => {
  it('清理内存会话与云端项目，但不删除 localStorage 本地项目', async () => {
    localStorage.setItem(LOCAL_PROJECTS_KEY, LOCAL_PROJECTS_VALUE)
    installFetch((url) => {
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({
          requestId: null,
          user: USER_A,
          sessionExpiresAt: '2026-10-26T02:30:00.000Z',
        })
      }
      if (url.endsWith('/api/projects')) return listResponse()
      if (url.endsWith('/api/auth/logout')) return jsonResponse({ loggedOut: true })
      return undefined
    })
    const store = useSessionStore()
    const cloud = useCloudStore()
    await store.restoreSession()
    expect(store.status).toBe('authenticated')

    const result = await store.logout()

    expect(result.ok).toBe(true)
    expect(store.status).toBe('unauthenticated')
    expect(store.auth.user).toBeNull()
    expect(store.projects).toEqual([])
    expect(cloud.project).toBeNull()
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).toBe(LOCAL_PROJECTS_VALUE)

    const keys = Object.keys(localStorage)
    expect(keys).toEqual([LOCAL_PROJECTS_KEY])
  })

  it('服务端退出失败时仍清理内存态，但如实返回中文错误', async () => {
    installFetch((url) => {
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({
          requestId: null,
          user: USER_A,
          sessionExpiresAt: '2026-10-26T02:30:00.000Z',
        })
      }
      if (url.endsWith('/api/projects')) return listResponse([])
      if (url.endsWith('/api/auth/logout')) throw new TypeError('offline')
      return undefined
    })
    const store = useSessionStore()
    await store.restoreSession()

    const result = await store.logout()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('NETWORK_ERROR')
      expect(result.message).toContain('无法连接')
    }
    expect(store.status).toBe('unauthenticated')
  })
})

describe('用户切换的数据隔离', () => {
  it('旧用户的项目列表迟到时不覆盖新用户数据', async () => {
    const projectsA = deferred<Response>()
    let projectCalls = 0
    installFetch((url, init) => {
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({
          requestId: null,
          user: USER_A,
          sessionExpiresAt: '2026-10-26T02:30:00.000Z',
        })
      }
      if (url.endsWith('/api/auth/login')) {
        const body = requestBody(init)
        return jsonResponse({
          contractVersion: '3.0',
          requestId: body['requestId'],
          user: USER_B,
          sessionExpiresAt: '2026-10-26T02:30:00.000Z',
          replayed: false,
        })
      }
      if (url.endsWith('/api/projects')) {
        projectCalls += 1
        if (projectCalls === 1) return projectsA.promise
        return listResponse([makeProjectSummary({ projectId: 'prj_b', name: 'B 的项目' })])
      }
      return undefined
    })
    const store = useSessionStore()

    const restore = store.restoreSession()
    await vi.waitFor(() => expect(projectCalls).toBe(1))
    const login = await store.login('student02', 'pw')
    expect(login.ok).toBe(true)
    expect(store.currentUserId).toBe(USER_B.userId)
    expect(store.projects.map((item) => item.projectId)).toEqual(['prj_b'])

    projectsA.resolve(listResponse([makeProjectSummary({ projectId: 'prj_a', name: 'A 的项目' })]))

    const stale = await restore
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('STALE_RESPONSE')
    expect(store.currentUserId).toBe(USER_B.userId)
    expect(store.projects.map((item) => item.projectId)).toEqual(['prj_b'])
  })
})
