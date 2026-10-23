/**
 * V3 账号会话 store（契约 21）。
 *
 * - 启动时显式区分 loading / authenticated / unauthenticated / error；
 * - Cookie 由浏览器管理，本 store 不读写任何令牌，也不写入 localStorage；
 * - 登录成功后加载项目列表；用户切换时清空云端项目状态，防止数据串号；
 * - 退出只清理内存云端状态，绝不删除 `scp.mvp.projects` 中的本地项目。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  fetchCurrentUser,
  isUnauthorized,
  loginAccount,
  logoutAccount,
  registerAccount,
  type AuthSession,
} from '@/services/authApi'
import { listProjects } from '@/services/projectsApi'
import { makeV3Error, type V3ApiError } from '@/services/v3Http'
import type { ActionResult } from '@/domain/recommendation'
import type { AuthSnapshot, AuthStatus, CloudProjectSummary, V3User } from '@/types/platform'
import { useCloudStore } from './cloud'
import { useMigrationStore } from './migration'

export type ProjectsLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SessionApiOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function failure<T = never>(error: V3ApiError): ActionResult<T> {
  return { ok: false, code: error.code, message: error.message }
}

function emptyAuth(status: AuthStatus): AuthSnapshot {
  return { status, user: null, sessionExpiresAt: null }
}

export const useSessionStore = defineStore('session', () => {
  const auth = ref<AuthSnapshot>(emptyAuth('idle'))
  const projects = ref<CloudProjectSummary[]>([])
  const projectsStatus = ref<ProjectsLoadStatus>('idle')
  const projectsError = ref<{ code: string; message: string } | null>(null)

  const isAuthenticated = computed(() => auth.value.status === 'authenticated' && auth.value.user !== null)
  const currentUserId = computed(() => auth.value.user?.userId ?? null)
  const status = computed(() => auth.value.status)

  let epoch = 0
  let activeUserId: string | null = null
  let restoreInFlight: Promise<ActionResult<AuthSnapshot>> | null = null

  function cloudStore() {
    return useCloudStore()
  }

  function resetCloudState(): void {
    cloudStore().reset()
    // 退出/切换账号时丢弃迁移内存态与在途响应；持久化 migrationId 保留以便重试
    useMigrationStore().reset()
  }

  function clearSession(): void {
    epoch += 1
    activeUserId = null
    auth.value = emptyAuth('unauthenticated')
    projects.value = []
    projectsStatus.value = 'idle'
    projectsError.value = null
    resetCloudState()
  }

  function applySession(session: AuthSession): void {
    if (activeUserId !== null && activeUserId !== session.user.userId) {
      projects.value = []
      projectsStatus.value = 'idle'
      projectsError.value = null
      resetCloudState()
    }
    activeUserId = session.user.userId
    auth.value = {
      status: 'authenticated',
      user: session.user,
      sessionExpiresAt: session.sessionExpiresAt,
    }
  }

  async function loadProjects(options: SessionApiOptions = {}): Promise<ActionResult<CloudProjectSummary[]>> {
    if (auth.value.status !== 'authenticated' || activeUserId === null) {
      return failure(makeV3Error('UNAUTHORIZED'))
    }
    const token = epoch
    const userId = activeUserId
    projectsStatus.value = 'loading'
    projectsError.value = null

    const result = await listProjects({
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    })

    if (token !== epoch || userId !== activeUserId) {
      return failure(makeV3Error('STALE_RESPONSE'))
    }
    if (!result.ok) {
      if (isUnauthorized(result.error)) {
        clearSession()
      } else {
        // 网络失败不清空已有项目列表，避免用户看到“无项目”的假象
        projectsStatus.value = 'error'
        projectsError.value = { code: result.error.code, message: result.error.message }
      }
      return failure(result.error)
    }

    projects.value = result.data.projects
    projectsStatus.value = 'ready'
    return { ok: true, data: result.data.projects }
  }

  /**
   * 启动时调用。401 → unauthenticated；网络失败 → error（不能伪装成未登录）。
   */
  async function restoreSession(options: SessionApiOptions = {}): Promise<ActionResult<AuthSnapshot>> {
    if (restoreInFlight !== null) return restoreInFlight

    const token = epoch + 1
    epoch = token
    auth.value = { ...auth.value, status: 'loading' }
    projectsError.value = null

    const run = (async (): Promise<ActionResult<AuthSnapshot>> => {
      const result = await fetchCurrentUser({
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      })

      if (token !== epoch) {
        return failure(makeV3Error('STALE_RESPONSE'))
      }
      if (!result.ok) {
        if (isUnauthorized(result.error)) {
          clearSession()
          return failure(result.error)
        }
        // 网络/服务异常：保留已登录用户（若有），明确暴露错误
        auth.value = { ...auth.value, status: 'error' }
        return failure(result.error)
      }

      applySession(result.data)
      const projectsResult = await loadProjects(options)
      if (token !== epoch || activeUserId !== result.data.user.userId) {
        return failure(makeV3Error('STALE_RESPONSE'))
      }
      return projectsResult.ok || auth.value.status === 'authenticated'
        ? { ok: true, data: { ...auth.value } }
        : failure(makeV3Error(auth.value.status === 'error' ? 'NETWORK_ERROR' : 'UNAUTHORIZED'))
    })()

    restoreInFlight = run
    try {
      return await run
    } finally {
      if (restoreInFlight === run) restoreInFlight = null
    }
  }

  /** 登录成功后立即加载当前用户项目；不实现登录 UI */
  async function login(
    account: string,
    password: string,
    options: SessionApiOptions = {},
  ): Promise<ActionResult<AuthSnapshot>> {
    const token = epoch + 1
    epoch = token
    auth.value = { ...auth.value, status: 'loading' }

    const result = await loginAccount(account, password, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    })
    if (token !== epoch) return failure(makeV3Error('STALE_RESPONSE'))
    if (!result.ok) {
      auth.value = { ...auth.value, status: 'unauthenticated' }
      return failure(result.error)
    }

    applySession(result.data)
    await loadProjects(options)
    if (token !== epoch || activeUserId !== result.data.user.userId) {
      return failure(makeV3Error('STALE_RESPONSE'))
    }
    return { ok: true, data: { ...auth.value } }
  }

  async function register(
    input: { account: string; displayName: string; password: string; inviteCode: string },
    options: SessionApiOptions = {},
  ): Promise<ActionResult<AuthSnapshot>> {
    const token = epoch + 1
    epoch = token
    auth.value = { ...auth.value, status: 'loading' }

    const result = await registerAccount(input, options)
    if (token !== epoch) return failure(makeV3Error('STALE_RESPONSE'))
    if (!result.ok) {
      auth.value = { ...auth.value, status: 'unauthenticated' }
      return failure(result.error)
    }

    applySession(result.data)
    await loadProjects(options)
    if (token !== epoch || activeUserId !== result.data.user.userId) {
      return failure(makeV3Error('STALE_RESPONSE'))
    }
    return { ok: true, data: { ...auth.value } }
  }

  /**
   * 退出：即使服务端失败，也清理内存会话；但绝不删除本地项目。
   * 网络失败照实返回，UI 可提示“已退出本机登录，但服务器会话可能仍有效”。
   */
  async function logout(options: SessionApiOptions = {}): Promise<ActionResult<{ loggedOut: true }>> {
    const result = await logoutAccount({
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    })
    clearSession()
    return result.ok ? { ok: true, data: result.data } : failure(result.error)
  }

  /** 任一 V3 接口返回 401 时由 UI/调用方通知 store 清理内存态 */
  function noteUnauthorized(message?: string): void {
    clearSession()
    if (message !== undefined) {
      auth.value = { status: 'unauthenticated', user: null, sessionExpiresAt: null }
    }
  }

  /** 供测试/应用启动时重置内存态；不会触碰 localStorage */
  function resetInMemory(): void {
    epoch += 1
    activeUserId = null
    auth.value = emptyAuth('idle')
    projects.value = []
    projectsStatus.value = 'idle'
    projectsError.value = null
    restoreInFlight = null
    resetCloudState()
  }

  function cachedUser(): V3User | null {
    return auth.value.user
  }

  return {
    auth,
    status,
    projects,
    projectsStatus,
    projectsError,
    isAuthenticated,
    currentUserId,
    restoreSession,
    loadProjects,
    login,
    register,
    logout,
    noteUnauthorized,
    resetInMemory,
    cachedUser,
  }
})
