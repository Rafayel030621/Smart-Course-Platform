/**
 * 本地项目 → V3 云端迁移载荷（契约 24.2 / 24.3 / 24.3.1）。
 *
 * 硬性规则：
 * - 只有用户显式确认后才允许发请求（store 负责）；
 * - 构建过程只读 localStorage，不删除、不覆盖原始项目；
 * - 展示投影（steps/evidence/doubts）与旧占位材料不读取；
 * - 不伪造 progress（当前 Project 没有独立进展字段，固定 `[]`）；
 * - 理解条目状态原样保留，绝不把 pending/modified 提升为 confirmed；
 * - schemaVersion 缺失/过低/过高都在本地拦截并给中文提示。
 */
import { normalizeProjectProfile } from '@/domain/materials'
import {
  CURRENT_SCHEMA_VERSION,
  STORAGE_KEY_PROJECTS,
  migrateProject,
} from '@/stores/persistence'
import type {
  LocalMigrationBlockReason,
  LocalMigrationCandidate,
  LocalMigrationChatMessageInput,
  LocalMigrationDoubtInput,
  LocalMigrationEvidenceInput,
  LocalMigrationMaterialInput,
  LocalMigrationMaterialSegmentInput,
  LocalMigrationMilestoneInput,
  LocalMigrationProjectInput,
  LocalMigrationRecord,
  LocalMigrationRequest,
  LocalMigrationTaskInput,
  LocalMigrationUnderstandingItemInput,
  Project,
} from '@/types/platform'
import { V3_CONTRACT_VERSION } from '@/types/platform'
import { v3Message } from '@/services/v3Http'

/** 迁移幂等记录键；只保存 migrationId/状态，不保存任何会话令牌 */
export const STORAGE_KEY_MIGRATIONS = 'scp.v3.migrations'
/** 服务端确认窗口：30 分钟（契约 24.2） */
export const MIGRATION_CONFIRMATION_WINDOW_MS = 30 * 60 * 1000

const LIMITS = {
  milestones: 50,
  tasks: 500,
  evidence: 1000,
  materials: 50,
  doubts: 500,
  chats: 500,
  understandingItems: 500,
} as const

export interface InspectedLocalProject {
  localProjectId: string
  name: string
  short: string
  schemaVersion: number
  project: Project | null
  blockReason: LocalMigrationBlockReason | null
  errorMessage: string | null
}

export interface LocalProjectInspection {
  storageAvailable: boolean
  projects: InspectedLocalProject[]
  currentProjectId: string | null
}

export type MigrationBuildFailureCode =
  | 'MIGRATION_DATA_OUTDATED'
  | 'MIGRATION_VERSION_UNSUPPORTED'
  | 'MIGRATION_INVALID_DATA'
  | 'MIGRATION_TOO_LARGE'
  | 'MIGRATION_NOT_CONFIRMED'
  | 'MIGRATION_CONFIRMATION_EXPIRED'

export type MigrationBuildResult =
  | { ok: true; request: LocalMigrationRequest }
  | { ok: false; code: MigrationBuildFailureCode; message: string }

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

function readRaw(key: string): string | null {
  const storage = getStorage()
  if (storage === null) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): boolean {
  const storage = getStorage()
  if (storage === null) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function codepointLength(value: string): number {
  return [...value].length
}

function normalizeMilestoneName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function toIso(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function truncate(value: string, max: number): string {
  return codepointLength(value) <= max ? value : [...value].slice(0, max).join('')
}

function nullableText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return truncate(trimmed, max)
}

function migrationFailure(
  code: MigrationBuildFailureCode,
  message?: string,
): { ok: false; code: MigrationBuildFailureCode; message: string } {
  return { ok: false, code, message: message ?? v3Message(code) }
}

/**
 * 只读检查本地项目。不会清理损坏数据，也不会写入任何内容。
 * 与 `loadPersistedState` 的区别：这里保留原始 schemaVersion，供迁移版本校验。
 */
export function inspectLocalProjects(): LocalProjectInspection {
  const storage = getStorage()
  if (storage === null) {
    return { storageAvailable: false, projects: [], currentProjectId: null }
  }

  const raw = readRaw(STORAGE_KEY_PROJECTS)
  if (raw === null) {
    return { storageAvailable: true, projects: [], currentProjectId: null }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { storageAvailable: true, projects: [], currentProjectId: null }
  }

  let list: unknown[]
  let envelopeVersion: number | null = null
  if (Array.isArray(parsed)) {
    list = parsed
  } else {
    const record = asRecord(parsed)
    const projects = record !== null && Array.isArray(record['projects']) ? record['projects'] : null
    if (record === null || projects === null) {
      return { storageAvailable: true, projects: [], currentProjectId: null }
    }
    list = projects
    const version = record['schemaVersion']
    envelopeVersion = typeof version === 'number' && Number.isInteger(version) ? version : null
  }

  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const item of list) {
    const record = asRecord(item)
    const projectId = record !== null && typeof record['projectId'] === 'string' ? record['projectId'] : null
    if (projectId === null) continue
    if (seen.has(projectId)) duplicates.add(projectId)
    seen.add(projectId)
  }

  const projects: InspectedLocalProject[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === null) continue
    const projectId = typeof record['projectId'] === 'string' ? record['projectId'] : null
    const name = typeof record['name'] === 'string' ? record['name'] : ''
    const short = typeof record['short'] === 'string' ? record['short'] : ''
    const projectVersion =
      typeof record['schemaVersion'] === 'number' && Number.isInteger(record['schemaVersion'])
        ? record['schemaVersion']
        : null
    const schemaVersion = projectVersion ?? envelopeVersion ?? 0

    let blockReason: LocalMigrationBlockReason | null = null
    let errorMessage: string | null = null
    let project: Project | null = null

    if (projectId === null || projectId.trim() === '' || name.trim() === '') {
      blockReason = 'malformed'
      errorMessage = '本地项目缺少 ID 或名称，已跳过'
    } else if (duplicates.has(projectId)) {
      blockReason = 'duplicate-id'
      errorMessage = '本地存在重复项目 ID，请先导出备份后重试'
    } else if (schemaVersion < 1) {
      blockReason = 'schema-outdated'
      errorMessage = v3Message('MIGRATION_DATA_OUTDATED')
    } else if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      blockReason = 'schema-unsupported'
      errorMessage = v3Message('MIGRATION_VERSION_UNSUPPORTED')
    } else {
      project = migrateProject(record)
      if (project === null) {
        blockReason = 'malformed'
        errorMessage = v3Message('MIGRATION_INVALID_DATA')
      }
    }

    projects.push({
      localProjectId: projectId ?? '',
      name: name.trim(),
      short: short.trim(),
      schemaVersion,
      project,
      blockReason,
      errorMessage,
    })
  }

  let currentProjectId: string | null = null
  const rawCurrent = readRaw('scp.mvp.currentProjectId')
  if (rawCurrent !== null) {
    try {
      const value = JSON.parse(rawCurrent) as unknown
      currentProjectId = typeof value === 'string' ? value : null
    } catch {
      currentProjectId = null
    }
  }

  return { storageAvailable: true, projects, currentProjectId }
}

/** 把检查结果转换成 UI 可用的候选；合并持久化迁移记录 */
export function toMigrationCandidates(
  inspection: LocalProjectInspection,
  records: Record<string, LocalMigrationRecord> = loadMigrationRecords(),
): LocalMigrationCandidate[] {
  return inspection.projects.map((item) => {
    const record = records[item.localProjectId]
    const status = item.blockReason !== null
      ? 'blocked'
      : record?.status === 'succeeded'
        ? 'succeeded'
        : record?.status === 'failed'
          ? 'failed'
          : 'pending-confirmation'
    return {
      localProjectId: item.localProjectId,
      name: item.name,
      short: item.short,
      schemaVersion: item.schemaVersion,
      taskCount: item.project?.tasks.length ?? 0,
      evidenceCount: item.project?.evidenceRecords.length ?? 0,
      doubtCount: item.project?.doubtRecords.length ?? 0,
      materialCount: item.project?.materialRecords.length ?? 0,
      chatCount: item.project?.chat.length ?? 0,
      status,
      migrationId: record?.migrationId ?? null,
      cloudProjectId: record?.cloudProjectId ?? null,
      blockReason: item.blockReason,
      errorMessage: item.errorMessage,
    }
  })
}

/* --------------------------------------------------------------- 迁移记录 */

export function loadMigrationRecords(): Record<string, LocalMigrationRecord> {
  const raw = readRaw(STORAGE_KEY_MIGRATIONS)
  if (raw === null) return {}
  try {
    const parsed = asRecord(JSON.parse(raw) as unknown)
    if (parsed === null) return {}
    const result: Record<string, LocalMigrationRecord> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const record = asRecord(value)
      if (record === null) continue
      if (typeof record['migrationId'] !== 'string') continue
      const status = record['status']
      if (status !== 'migrating' && status !== 'succeeded' && status !== 'failed') continue
      result[key] = {
        clientProjectId: key,
        migrationId: record['migrationId'],
        status,
        cloudProjectId: typeof record['cloudProjectId'] === 'string' ? record['cloudProjectId'] : null,
        importedAt: typeof record['importedAt'] === 'string' ? record['importedAt'] : null,
        updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : new Date(0).toISOString(),
      }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * 同一本地项目只生成一次 migrationId，之后失败重试必须复用。
 * 返回 false 表示浏览器存储不可用（仍可在内存中重试，但跨刷新不再幂等）。
 */
export function saveMigrationRecord(record: LocalMigrationRecord): boolean {
  const records = loadMigrationRecords()
  records[record.clientProjectId] = record
  return writeRaw(STORAGE_KEY_MIGRATIONS, JSON.stringify(records))
}

export function newMigrationId(): string {
  const cryptoApi = globalThis.crypto
  const suffix =
    cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
  return `mig_${suffix}`
}

export function getOrCreateMigrationId(clientProjectId: string): string {
  const existing = loadMigrationRecords()[clientProjectId]
  if (existing !== undefined) return existing.migrationId
  const migrationId = newMigrationId()
  saveMigrationRecord({
    clientProjectId,
    migrationId,
    status: 'migrating',
    cloudProjectId: null,
    importedAt: null,
    updatedAt: new Date().toISOString(),
  })
  return migrationId
}

/* --------------------------------------------------------------- 构建载荷 */

/**
 * 把本地项目归一化为契约 24.3 的 DTO。
 *
 * `userConfirmedAt` 必须由用户点击确认时生成；超过 30 分钟直接拒绝，
 * 避免用户在弹窗停留过久后发送服务端会拒绝的请求。
 */
export function buildLocalMigrationRequest(
  project: Project,
  schemaVersion: number,
  options: { migrationId: string; userConfirmedAt: string; now?: Date; appVersion?: string },
): MigrationBuildResult {
  if (schemaVersion < 1) return migrationFailure('MIGRATION_DATA_OUTDATED')
  if (schemaVersion > CURRENT_SCHEMA_VERSION) return migrationFailure('MIGRATION_VERSION_UNSUPPORTED')
  if (!/^mig_[A-Za-z0-9_-]{4,60}$/.test(options.migrationId)) {
    return migrationFailure('MIGRATION_INVALID_DATA', '迁移编号不合法，请刷新后重试')
  }

  const confirmedAt = new Date(options.userConfirmedAt)
  const now = options.now ?? new Date()
  if (Number.isNaN(confirmedAt.getTime())) {
    return migrationFailure('MIGRATION_NOT_CONFIRMED')
  }
  const diff = now.getTime() - confirmedAt.getTime()
  if (diff > MIGRATION_CONFIRMATION_WINDOW_MS || diff < -5 * 60 * 1000) {
    return migrationFailure('MIGRATION_CONFIRMATION_EXPIRED')
  }

  const name = project.name.trim()
  if (name === '' || codepointLength(name) > 120) {
    return migrationFailure('MIGRATION_INVALID_DATA', '项目名称为空或超过 120 字，无法迁移')
  }
  const short = project.short.trim() === '' ? null : truncate(project.short.trim(), 20)

  const nowIso = now.toISOString()
  const milestoneByKey = new Map<string, LocalMigrationMilestoneInput>()
  const milestones: LocalMigrationMilestoneInput[] = []
  const pushMilestone = (nameValue: string, status: LocalMigrationMilestoneInput['status']) => {
    const normalized = normalizeMilestoneName(nameValue)
    if (normalized === '') return null
    const existing = milestoneByKey.get(normalized)
    if (existing !== undefined) return existing
    if (milestones.length >= LIMITS.milestones) return null
    const milestone: LocalMigrationMilestoneInput = {
      clientId: `ms_local_${milestones.length + 1}`,
      name: truncate(normalized, 60),
      goal: null,
      doneCriteria: null,
      dueAt: null,
      status,
      orderIndex: milestones.length,
    }
    milestones.push(milestone)
    milestoneByKey.set(normalized, milestone)
    return milestone
  }

  for (const item of project.ms) {
    if (normalizeMilestoneName(item.t) === '') {
      return migrationFailure('MIGRATION_INVALID_DATA', '存在空名称阶段，无法迁移')
    }
    const status =
      item.s === 'done' ? 'completed' : item.s === 'cur' ? 'active' : 'planned'
    if (pushMilestone(item.t, status) === null) {
      return migrationFailure('MIGRATION_TOO_LARGE')
    }
  }

  const taskMilestone = new Map<string, string | null>()
  const taskIds = new Set<string>()
  const tasks: LocalMigrationTaskInput[] = []
  for (const task of project.tasks) {
    if (taskIds.has(task.id)) {
      return migrationFailure('MIGRATION_INVALID_DATA', '存在重复任务 ID，无法迁移')
    }
    taskIds.add(task.id)
    let milestoneClientId: string | null = null
    if (task.milestone !== null && normalizeMilestoneName(task.milestone) !== '') {
      const normalized = normalizeMilestoneName(task.milestone)
      const milestone =
        milestoneByKey.get(normalized) ?? pushMilestone(normalized, 'planned')
      if (milestone === null) return migrationFailure('MIGRATION_TOO_LARGE')
      milestoneClientId = milestone.clientId
    }
    taskMilestone.set(task.id, milestoneClientId)
    const title = task.title.trim()
    if (title === '' || codepointLength(title) > 60) {
      return migrationFailure('MIGRATION_INVALID_DATA', '任务标题为空或超过 60 字，无法迁移')
    }
    tasks.push({
      clientId: task.id,
      milestoneClientId,
      title,
      doneCriteria: nullableText(task.doneCriteria, 200),
      status: task.status,
      createdAt: toIso(task.createdAt, nowIso),
      updatedAt: toIso(task.updatedAt, nowIso),
    })
  }
  if (tasks.length > LIMITS.tasks) return migrationFailure('MIGRATION_TOO_LARGE')

  const evidenceIds = new Set<string>()
  const evidence: LocalMigrationEvidenceInput[] = []
  for (const item of project.evidenceRecords) {
    if (evidenceIds.has(item.id)) {
      return migrationFailure('MIGRATION_INVALID_DATA', '存在重复证据 ID，无法迁移')
    }
    evidenceIds.add(item.id)
    const didWhat = item.didWhat.trim()
    if (didWhat === '' || codepointLength(didWhat) > 300) {
      return migrationFailure('MIGRATION_INVALID_DATA', '证据正文为空或超过 300 字，无法迁移')
    }
    evidence.push({
      clientId: item.id,
      taskClientId: item.taskId !== null && taskIds.has(item.taskId) ? item.taskId : null,
      milestoneClientId:
        item.taskId !== null ? (taskMilestone.get(item.taskId) ?? null) : null,
      submissionId:
        item.submissionId !== null && /^[\x21-\x7E]{8,64}$/.test(item.submissionId)
          ? item.submissionId
          : null,
      didWhat,
      foundWhat: nullableText(item.foundWhat, 500),
      stillUnsure: nullableText(item.stillUnsure, 500),
      attachmentName: nullableText(item.attachmentName, 200),
      createdAt: toIso(item.createdAt, nowIso),
    })
  }
  if (evidence.length > LIMITS.evidence) return migrationFailure('MIGRATION_TOO_LARGE')

  const doubtIds = new Set<string>()
  const doubts = project.doubtRecords.map((item) => {
    if (doubtIds.has(item.id)) return null
    doubtIds.add(item.id)
    return {
      clientId: item.id,
      text: truncate(item.text.trim(), 500),
      status: item.status,
      sourceEvidenceClientId:
        item.sourceEvidenceId !== null && evidenceIds.has(item.sourceEvidenceId)
          ? item.sourceEvidenceId
          : null,
      createdAt: toIso(item.createdAt, nowIso),
      resolvedAt: item.resolvedAt === null ? null : toIso(item.resolvedAt, nowIso),
    }
  })
  if (doubts.some((item) => item === null)) {
    return migrationFailure('MIGRATION_INVALID_DATA', '存在重复疑问 ID，无法迁移')
  }
  if (doubts.length > LIMITS.doubts) return migrationFailure('MIGRATION_TOO_LARGE')

  const segmentsByMaterial = new Map<string, LocalMigrationMaterialSegmentInput[]>()
  for (const segment of project.materialSegments) {
    const key = `${segment.materialId}@${segment.materialVersion}`
    const list = segmentsByMaterial.get(key) ?? []
    list.push({
      segmentId: segment.segmentId,
      index: segment.index,
      startLine: segment.startLine,
      endLine: segment.endLine,
      text: segment.text,
    })
    segmentsByMaterial.set(key, list)
  }

  const blocksByMaterial = new Map<string, LocalMigrationUnderstandingItemInput[]>()
  for (const block of project.understandingBlocks) {
    const key = `${block.materialId}@${block.materialVersion}`
    const list = blocksByMaterial.get(key) ?? []
    list.push({
      clientId: block.id,
      clientItemId: block.itemId.trim() === '' ? null : block.itemId,
      kind: block.kind,
      text: truncate(block.content.trim(), 300),
      originalText: block.originalContent.trim() === '' ? null : truncate(block.originalContent.trim(), 300),
      sourceSegmentIds: block.sources.map((source) => source.segmentId).slice(0, 3),
      status: block.status,
    })
    blocksByMaterial.set(key, list)
  }

  const materials: LocalMigrationMaterialInput[] = project.materialRecords.map((material) => {
    const type = material.type ?? 'unknown'
    const size = material.size ?? 0
    const supported = (type === 'md' || type === 'txt') && size <= 1024 * 1024
    const status =
      material.state === 'parse_failed'
        ? 'parse_failed'
        : supported
          ? (material.state ?? 'registered')
          : 'unsupported'
    const key = `${material.materialId}@${material.version}`
    return {
      clientId: material.materialId,
      name: truncate(material.name.trim(), 200),
      type,
      size,
      encoding: material.encoding ?? 'utf-8',
      status,
      version: material.version,
      createdAt: toIso(material.createdAt, nowIso),
      updatedAt: toIso(material.updatedAt, nowIso),
      segments: supported ? (segmentsByMaterial.get(key) ?? []) : [],
      understandingItems: supported ? (blocksByMaterial.get(key) ?? []) : [],
    }
  })
  if (materials.length > LIMITS.materials) return migrationFailure('MIGRATION_TOO_LARGE')
  const understandingTotal = materials.reduce(
    (total, material) => total + material.understandingItems.length,
    0,
  )
  if (understandingTotal > LIMITS.understandingItems) return migrationFailure('MIGRATION_TOO_LARGE')

  const chats: LocalMigrationChatMessageInput[] = project.chat
    .slice(-LIMITS.chats)
    .map((message, index) => ({
      clientId: `msg_local_${index + 1}`,
      role: message.me ? 'user' : 'assistant',
      text: truncate(message.text, 4000),
      source: message.source ?? null,
      fallbackReason: message.fallbackReason ?? null,
    }))
  if (chats.some((message) => message.text.trim() === '')) {
    return migrationFailure('MIGRATION_INVALID_DATA', '存在空聊天消息，无法迁移')
  }

  const localProject: LocalMigrationProjectInput = {
    name,
    short,
    projectRevision: project.projectRevision,
    profile: normalizeProjectProfile(project.profile),
    milestones,
    tasks,
    evidence,
    doubts: doubts as LocalMigrationDoubtInput[],
    progress: [],
    materials,
    chats,
  }

  return {
    ok: true,
    request: {
      contractVersion: V3_CONTRACT_VERSION,
      requestId: '',
      idempotencyKey: '',
      migrationId: options.migrationId,
      userConfirmed: true,
      userConfirmedAt: confirmedAt.toISOString(),
      source: {
        schemaVersion,
        clientProjectId: project.projectId,
        ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
        exportedAt: nowIso,
      },
      localProject,
    },
  }
}

/** 当前 UI 需要展示的“待确认/迁移中/成功/失败”状态来源 */
export function migrationStatusLabel(status: LocalMigrationCandidate['status']): string {
  switch (status) {
    case 'idle':
      return '未检测到本地项目'
    case 'pending-confirmation':
      return '待确认迁移'
    case 'migrating':
      return '迁移中'
    case 'succeeded':
      return '迁移成功'
    case 'failed':
      return '迁移失败，可重试'
    case 'blocked':
      return '本地数据暂不能迁移'
  }
}
