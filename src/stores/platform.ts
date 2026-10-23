/**
 * V3 平台接线层（会话 + 云端项目 + 本地项目 + 显式迁移）
 * ----------------------------------------------------------------------------
 * 职责只有“协调”，不新增业务规则：
 *   - `initialize()` 是**唯一**的启动入口：确认会话一次，已登录才加载云端项目；
 *   - 云端项目列表/当前项目来自 session 与 cloud store，本地项目继续由 workbench 管理；
 *   - 两种项目来源用 `source` 显式区分，视图据此切换，绝不把两边数据混成一个列表；
 *   - 退出只清会话与云端内存态，本地项目（localStorage）不动；
 *   - 迁移只提供显式入口：检测是只读的，用户确认后才发请求。
 *
 * 认证 UI 与迁移确认界面不在本层实现；本层只保证“调用时机”和“数据归属”正确。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  useCloudStore,
  type CloudStoreOptions,
  type CreateCloudProjectInput,
} from './cloud'
import { useMigrationStore, type MigrateOptions } from './migration'
import { useSessionStore, type SessionApiOptions } from './session'
import { useWorkbenchStore } from './workbench'
import { toWorkbenchProjectView } from '@/domain/cloudView'
import { makeV3Error, type V3ApiError } from '@/services/v3Http'
import type { ActionResult } from '@/domain/recommendation'
import type {
  AuthSnapshot,
  CloudProject,
  CloudProjectSummary,
  LocalMigrationCandidate,
  LocalMigrationResponse,
  Project,
  V3User,
} from '@/types/platform'

export type ProjectSource = 'local' | 'cloud'

export interface ProjectChoice {
  /** 云端项目带 `cloud:` 前缀；本地项目沿用稳定 projectId，避免两种来源同名 */
  value: string
  label: string
}

export const CLOUD_PROJECT_PREFIX = 'cloud:'

function failure<T = never>(error: V3ApiError): ActionResult<T> {
  return { ok: false, code: error.code, message: error.message }
}

export const usePlatformStore = defineStore('platform', () => {
  const session = useSessionStore()
  const cloud = useCloudStore()
  const migration = useMigrationStore()
  const workbench = useWorkbenchStore()

  /** 当前工作台展示的是哪一类项目；不是“数据副本” */
  const source = ref<ProjectSource>('local')
  /** 本次应用生命周期内是否已经完成过启动会话确认 */
  const initialized = ref(false)
  /** 启动鉴权失败信息（网络/服务端异常）；401 不算错误，是 unauthenticated */
  const initError = ref<{ code: string; message: string } | null>(null)

  let initPromise: Promise<ActionResult<AuthSnapshot>> | null = null
  let lastInitResult: ActionResult<AuthSnapshot> | null = null

  const authStatus = computed(() => session.status)
  const currentUser = computed<V3User | null>(() => session.auth.user)
  const displayName = computed(() => currentUser.value?.displayName ?? '我')
  const isAuthenticated = computed(() => session.isAuthenticated)

  const cloudProjects = computed<CloudProjectSummary[]>(() => session.projects)
  const hasCloudProjects = computed(() => cloudProjects.value.length > 0)
  const projectsStatus = computed(() => session.projectsStatus)
  const projectsError = computed(() => session.projectsError)

  const cloudProject = computed<CloudProject | null>(() => cloud.project)
  const cloudLoading = computed(() => cloud.loadingProject)
  const cloudError = computed(() => cloud.lastError)
  const cloudSync = computed(() => cloud.sync)
  const migrationCandidates = computed(() => migration.candidates)
  const migrationStatus = computed(() => migration.status)
  const migrationError = computed(() => migration.error)
  const migrationActiveCandidate = computed(() => migration.activeCandidate)

  const isCloudSource = computed(() => source.value === 'cloud')

  /** 云端数据的工作台只读视图；没有选中/加载失败时为 null */
  const cloudProjectView = computed<Project | null>(() => {
    const project = cloud.project
    if (project === null) return null
    return toWorkbenchProjectView(project, cloud.tasks, cloud.evidence)
  })

  const localProjects = computed(() => workbench.projects)
  const hasLocalProjects = computed(() => workbench.projects.length > 0)

  const cloudChoices = computed<ProjectChoice[]>(() =>
    cloudProjects.value.map((item) => ({
      value: `${CLOUD_PROJECT_PREFIX}${item.projectId}`,
      label: item.name,
    })),
  )
  const localChoices = computed<ProjectChoice[]>(() =>
    workbench.projects.map((item) => ({ value: item.projectId, label: item.name })),
  )
  const currentChoiceValue = computed(() => {
    if (source.value === 'cloud') {
      return cloud.project === null ? '' : `${CLOUD_PROJECT_PREFIX}${cloud.project.projectId}`
    }
    return workbench.current?.projectId ?? ''
  })

  /**
   * 启动时只执行一次：`/api/auth/me` → 已登录才加载项目。
   * 并发/重复调用复用同一个 Promise；失败后由 `retryInitialize` 显式重试。
   */
  async function initialize(options: SessionApiOptions = {}): Promise<ActionResult<AuthSnapshot>> {
    if (initialized.value && lastInitResult !== null) return lastInitResult
    if (initPromise !== null) return initPromise

    initError.value = null
    initPromise = (async () => {
      const result = await session.restoreSession(options)
      if (!result.ok) {
        initError.value = { code: result.code, message: result.message }
      }
      initialized.value = true
      lastInitResult = result
      if (session.status === 'authenticated') source.value = 'cloud'
      else if (session.status === 'unauthenticated') source.value = 'local'
      return result
    })()

    try {
      return await initPromise
    } finally {
      initPromise = null
    }
  }

  /** 用户显式点“重试”时使用；不会在后台自动重试 */
  async function retryInitialize(options: SessionApiOptions = {}): Promise<ActionResult<AuthSnapshot>> {
    initialized.value = false
    lastInitResult = null
    return initialize(options)
  }

  /** 登录成功后切到云端来源；登录 UI 由页面侧负责 */
  async function login(
    account: string,
    password: string,
    options: SessionApiOptions = {},
  ): Promise<ActionResult<AuthSnapshot>> {
    const result = await session.login(account, password, options)
    if (result.ok) source.value = 'cloud'
    return result
  }

  async function register(
    input: { account: string; displayName: string; password: string; inviteCode: string },
    options: SessionApiOptions = {},
  ): Promise<ActionResult<AuthSnapshot>> {
    const result = await session.register(input, options)
    if (result.ok) source.value = 'cloud'
    return result
  }

  /** 退出：只清会话与云端状态，本地项目原样保留 */
  async function logout(options: SessionApiOptions = {}): Promise<ActionResult<{ loggedOut: true }>> {
    const result = await session.logout(options)
    source.value = 'local'
    return result
  }

  async function refreshCloudProjects(
    options: SessionApiOptions = {},
  ): Promise<ActionResult<CloudProjectSummary[]>> {
    if (!session.isAuthenticated) return failure(makeV3Error('UNAUTHORIZED'))
    return session.loadProjects(options)
  }

  /**
   * 切换云端项目：项目必须属于当前用户的云端列表，避免拿其他用户/其他列表的 ID 直接发请求。
   * cloud store 内部按 epoch 丢弃切换后的迟到响应。
   */
  async function selectCloudProject(
    projectId: string,
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<CloudProject>> {
    if (!session.isAuthenticated) return failure(makeV3Error('UNAUTHORIZED'))
    if (!session.projects.some((item) => item.projectId === projectId)) {
      return failure(makeV3Error('PROJECT_NOT_FOUND'))
    }

    source.value = 'cloud'
    const result = await cloud.openProject(projectId, {
      ...options,
      expectedOwnerUserId: session.currentUserId ?? undefined,
    })
    if (!result.ok && result.code === 'UNAUTHORIZED') {
      session.noteUnauthorized()
    }
    return result
  }

  /**
   * 创建云端项目：profile 由调用方按契约提供，本层不做题目/成员等业务映射。
   * 成功后刷新项目列表并切到云端来源。
   */
  async function createCloudProject(
    input: CreateCloudProjectInput,
    options: CloudStoreOptions = {},
  ): Promise<ActionResult<CloudProject>> {
    if (!session.isAuthenticated) return failure(makeV3Error('UNAUTHORIZED'))
    const result = await cloud.createProject(input, {
      ...options,
      expectedOwnerUserId: session.currentUserId ?? undefined,
    })
    if (result.ok) {
      source.value = 'cloud'
      await session.loadProjects(options)
    }
    return result
  }

  /** 切回本地项目时只改来源，不删除云端缓存，也不触发本地写盘 */
  function useLocalSource(): void {
    source.value = 'local'
  }

  /** 进入云端界面；具体项目仍由页面通过 selectCloudProject 选择 */
  function useCloudSource(): void {
    if (session.isAuthenticated) source.value = 'cloud'
  }

  /** 只读检测本地项目，不发请求；由页面显式触发 */
  function detectLocalMigration(): LocalMigrationCandidate[] {
    return migration.detect()
  }

  /** 用户明确确认后才迁移；失败保留 localStorage，可复用同一 migrationId 重试 */
  async function confirmLocalMigration(
    projectId: string,
    options: Omit<MigrateOptions, 'userConfirmed'> = {},
  ): Promise<ActionResult<LocalMigrationResponse>> {
    const result = await migration.confirmMigration(projectId, options)
    if (result.ok && session.isAuthenticated) {
      // 迁移成功后刷新列表；失败只影响列表状态，不改变迁移结果
      await session.loadProjects(options)
    }
    return result
  }

  async function retryLocalMigration(
    projectId: string,
    options: Omit<MigrateOptions, 'userConfirmed'> = {},
  ): Promise<ActionResult<LocalMigrationResponse>> {
    return migration.retryMigration(projectId, options)
  }

  // 页面侧直接调用 session.login/logout 时，也保持来源与登录态一致；
  // 鉴权失败（error）不切换来源，避免网络抖动把已加载的云端项目藏起来。
  watch(
    () => session.status,
    (status) => {
      if (status === 'authenticated') source.value = 'cloud'
      else if (status === 'unauthenticated') source.value = 'local'
    },
  )

  return {
    /* 来源与状态 */
    source,
    isCloudSource,
    initialized,
    initError,
    authStatus,
    currentUser,
    displayName,
    isAuthenticated,

    /* 云端项目 */
    cloudProjects,
    hasCloudProjects,
    projectsStatus,
    projectsError,
    cloudProject,
    cloudProjectView,
    cloudLoading,
    cloudError,
    cloudSync,
    migrationCandidates,
    migrationStatus,
    migrationError,
    migrationActiveCandidate,

    /* 本地项目 */
    localProjects,
    hasLocalProjects,
    cloudChoices,
    localChoices,
    currentChoiceValue,

    /* 生命周期 */
    initialize,
    retryInitialize,
    login,
    register,
    logout,
    refreshCloudProjects,
    selectCloudProject,
    createCloudProject,
    useLocalSource,
    useCloudSource,

    /* 迁移（只有显式调用） */
    detectLocalMigration,
    confirmLocalMigration,
    retryLocalMigration,
  }
})
