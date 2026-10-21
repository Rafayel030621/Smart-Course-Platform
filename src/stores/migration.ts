/**
 * 本地项目迁移 store（契约 24）。
 *
 * 状态机：idle → pending-confirmation → migrating → succeeded / failed。
 * - 检测只读，不发请求；
 * - 只有 `userConfirmed: true` 的显式调用才会 POST；
 * - 成功前绝不删除/覆盖 localStorage；成功后也只记录迁移结果；
 * - 失败/超时保留原数据，重试复用同一 migrationId；
 * - 用户退出或切换账号时，过期响应不写回状态。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  buildLocalMigrationRequest,
  getOrCreateMigrationId,
  inspectLocalProjects,
  loadMigrationRecords,
  saveMigrationRecord,
  toMigrationCandidates,
  type InspectedLocalProject,
} from '@/domain/localMigration'
import { migrateLocalProject } from '@/services/projectsApi'
import { makeV3Error, type V3ApiError } from '@/services/v3Http'
import type { ActionResult } from '@/domain/recommendation'
import type {
  LocalMigrationCandidate,
  LocalMigrationRecord,
  LocalMigrationResponse,
  LocalMigrationStatus,
} from '@/types/platform'

export interface MigrateOptions {
  /** 必须由用户在页面上明确确认后才传 true */
  userConfirmed: boolean
  now?: Date
  appVersion?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function failure<T = never>(error: V3ApiError): ActionResult<T> {
  return { ok: false, code: error.code, message: error.message }
}

function blockedError(candidate: LocalMigrationCandidate): V3ApiError {
  switch (candidate.blockReason) {
    case 'schema-outdated':
      return makeV3Error('MIGRATION_DATA_OUTDATED')
    case 'schema-unsupported':
      return makeV3Error('MIGRATION_VERSION_UNSUPPORTED')
    default:
      return makeV3Error('MIGRATION_INVALID_DATA')
  }
}

function overallStatus(candidates: LocalMigrationCandidate[]): LocalMigrationStatus {
  if (candidates.length === 0) return 'idle'
  if (candidates.some((item) => item.status === 'migrating')) return 'migrating'
  if (candidates.some((item) => item.status === 'pending-confirmation')) return 'pending-confirmation'
  if (candidates.some((item) => item.status === 'failed')) return 'failed'
  if (candidates.every((item) => item.status === 'succeeded')) return 'succeeded'
  return 'blocked'
}

export const useMigrationStore = defineStore('migration', () => {
  const candidates = ref<LocalMigrationCandidate[]>([])
  const status = ref<LocalMigrationStatus>('idle')
  const activeLocalProjectId = ref<string | null>(null)
  const lastResult = ref<LocalMigrationResponse | null>(null)
  const error = ref<{ code: string; message: string } | null>(null)
  const storageAvailable = ref(true)
  const records = ref<Record<string, LocalMigrationRecord>>({})
  const inspecting = ref(false)

  let epoch = 0
  let abortController = new AbortController()
  const inFlight = new Map<string, Promise<ActionResult<LocalMigrationResponse>>>()

  const activeCandidate = computed(
    () => candidates.value.find((item) => item.localProjectId === activeLocalProjectId.value) ?? null,
  )
  const pendingCandidates = computed(() =>
    candidates.value.filter((item) => item.status === 'pending-confirmation'),
  )
  const hasLocalProjects = computed(() => candidates.value.length > 0)

  function applyCandidates(list: LocalMigrationCandidate[]): void {
    candidates.value = list
    status.value = overallStatus(list)
    if (
      activeLocalProjectId.value === null ||
      !list.some((item) => item.localProjectId === activeLocalProjectId.value)
    ) {
      activeLocalProjectId.value =
        list.find((item) => item.status === 'pending-confirmation')?.localProjectId ??
        list.find((item) => item.status === 'failed')?.localProjectId ??
        list[0]?.localProjectId ??
        null
    }
  }

  /** 只读检测，不触发任何上传 */
  function detect(): LocalMigrationCandidate[] {
    inspecting.value = true
    try {
      const inspection = inspectLocalProjects()
      storageAvailable.value = inspection.storageAvailable
      records.value = loadMigrationRecords()
      applyCandidates(toMigrationCandidates(inspection, records.value))
      return candidates.value
    } finally {
      inspecting.value = false
    }
  }

  function select(projectId: string | null): void {
    activeLocalProjectId.value = projectId
    if (projectId !== null) {
      error.value = null
      status.value = overallStatus(candidates.value)
    }
  }

  function getInspected(projectId: string): InspectedLocalProject | null {
    return inspectLocalProjects().projects.find((item) => item.localProjectId === projectId) ?? null
  }

  async function runMigration(
    projectId: string,
    options: MigrateOptions,
  ): Promise<ActionResult<LocalMigrationResponse>> {
    if (options.userConfirmed !== true) {
      return failure(makeV3Error('MIGRATION_NOT_CONFIRMED'))
    }
    const candidate = candidates.value.find((item) => item.localProjectId === projectId)
    if (candidate === undefined) {
      return failure(makeV3Error('MIGRATION_INVALID_DATA'))
    }
    if (candidate.blockReason !== null) {
      const blocked = blockedError(candidate)
      error.value = { code: blocked.code, message: blocked.message }
      status.value = 'blocked'
      return failure(blocked)
    }
    if (candidate.status === 'succeeded') {
      // 已成功过：直接返回已有云端项目，不再重复创建
      return {
        ok: true,
        data: {
          contractVersion: '3.0',
          requestId: '',
          projectId: candidate.cloudProjectId ?? '',
          projectRevision: 1,
          migrationId: candidate.migrationId ?? '',
          status: 'completed',
          replayed: true,
          deduplicated: true,
          appliedChanges: false,
          idMap: {
            milestones: {},
            tasks: {},
            evidence: {},
            progress: {},
            materials: {},
            understandingItems: {},
            doubts: {},
            chats: {},
          },
          counts: {
            milestones: 0,
            tasks: 0,
            evidence: 0,
            progress: 0,
            materials: 0,
            materialSegments: 0,
            understandingItems: 0,
            doubts: 0,
            chatMessages: 0,
          },
          warnings: [],
          importedAt: records.value[projectId]?.importedAt ?? new Date().toISOString(),
        },
      }
    }

    const existing = inFlight.get(projectId)
    if (existing !== undefined) return existing

    const run = executeMigration(projectId, options)
    inFlight.set(projectId, run)
    try {
      return await run
    } finally {
      if (inFlight.get(projectId) === run) inFlight.delete(projectId)
    }
  }

  async function executeMigration(
    projectId: string,
    options: MigrateOptions,
  ): Promise<ActionResult<LocalMigrationResponse>> {
    const inspected = getInspected(projectId)
    if (inspected === null || inspected.project === null) {
      const invalid = makeV3Error('MIGRATION_INVALID_DATA')
      error.value = { code: invalid.code, message: invalid.message }
      status.value = 'failed'
      return failure(invalid)
    }

    const migrationId = getOrCreateMigrationId(projectId)
    const confirmedAt = options.now ?? new Date()
    const built = buildLocalMigrationRequest(inspected.project, inspected.schemaVersion, {
      migrationId,
      userConfirmedAt: confirmedAt.toISOString(),
      now: confirmedAt,
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    })
    if (!built.ok) {
      error.value = { code: built.code, message: built.message }
      status.value = 'failed'
      return failure({ ...makeV3Error(built.code), message: built.message })
    }

    const token = epoch
    activeLocalProjectId.value = projectId
    status.value = 'migrating'
    error.value = null
    lastResult.value = null
    abortController.abort()
    abortController = new AbortController()
    const signal = options.signal ?? abortController.signal

    saveMigrationRecord({
      clientProjectId: projectId,
      migrationId,
      status: 'migrating',
      cloudProjectId: null,
      importedAt: null,
      updatedAt: new Date().toISOString(),
    })

    const result = await migrateLocalProject(
      built.request as unknown as Record<string, unknown>,
      {
        userConfirmedAt: confirmedAt.toISOString(),
        idempotencyKey: migrationId,
        requestId: undefined,
        signal,
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      },
    )

    if (token !== epoch) {
      // 用户退出/切换：不标记成功，也不删除本地数据；下次同 migrationId 可安全重试
      return failure(makeV3Error('STALE_RESPONSE'))
    }

    if (!result.ok) {
      error.value = { code: result.error.code, message: result.error.message }
      saveMigrationRecord({
        clientProjectId: projectId,
        migrationId,
        status: 'failed',
        cloudProjectId: null,
        importedAt: null,
        updatedAt: new Date().toISOString(),
      })
      records.value = loadMigrationRecords()
      candidates.value = candidates.value.map((item) =>
        item.localProjectId === projectId ? { ...item, status: 'failed', errorMessage: result.error.message } : item,
      )
      status.value = overallStatus(candidates.value)
      return failure(result.error)
    }

    // 只有服务端 completed 响应才允许标记成功
    saveMigrationRecord({
      clientProjectId: projectId,
      migrationId,
      status: 'succeeded',
      cloudProjectId: result.data.projectId,
      importedAt: result.data.importedAt,
      updatedAt: new Date().toISOString(),
    })
    records.value = loadMigrationRecords()
    lastResult.value = result.data
    candidates.value = candidates.value.map((item) =>
      item.localProjectId === projectId
        ? {
            ...item,
            status: 'succeeded',
            migrationId,
            cloudProjectId: result.data.projectId,
            errorMessage: null,
          }
        : item,
    )
    status.value = overallStatus(candidates.value)
    return { ok: true, data: result.data }
  }

  /** 用户点击“确认迁移” */
  async function confirmMigration(
    projectId: string,
    options: Omit<MigrateOptions, 'userConfirmed'> = {},
  ): Promise<ActionResult<LocalMigrationResponse>> {
    return runMigration(projectId, { ...options, userConfirmed: true })
  }

  /** 失败后重试：复用同一 migrationId */
  async function retryMigration(
    projectId: string,
    options: Omit<MigrateOptions, 'userConfirmed'> = {},
  ): Promise<ActionResult<LocalMigrationResponse>> {
    return runMigration(projectId, { ...options, userConfirmed: true })
  }

  function reset(): void {
    epoch += 1
    abortController.abort()
    abortController = new AbortController()
    candidates.value = []
    status.value = 'idle'
    activeLocalProjectId.value = null
    lastResult.value = null
    error.value = null
    records.value = {}
    inFlight.clear()
  }

  return {
    candidates,
    status,
    activeLocalProjectId,
    activeCandidate,
    pendingCandidates,
    hasLocalProjects,
    lastResult,
    error,
    storageAvailable,
    records,
    inspecting,
    detect,
    select,
    confirmMigration,
    retryMigration,
    reset,
  }
})
