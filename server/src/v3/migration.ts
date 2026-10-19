import type { IncomingMessage, ServerResponse } from 'node:http'
import { transaction, type V3Database } from './db.js'
import { loadProject, normalizeNameKey, parseProfile, recalcCurrentMilestone } from './domain.js'
import { V3Error, V3_CONTRACT_VERSION } from './errors.js'
import {
  bodyReadError,
  MIGRATION_BODY_LIMIT,
  readJsonBody,
  requireContractVersion,
  requireIdempotencyKey,
  requireRecord,
  requireRequestId,
  sendV3Json,
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/**
 * 本地项目迁移（docs/contracts.md 第 24 节）
 * ----------------------------------------------------------------------------
 * - 必须 userConfirmed:true，确认时间 30 分钟内
 * - 单事务迁移项目/阶段/任务/证据/进展/材料/分段/理解草稿/疑问/聊天
 * - 同一 (userId, clientProjectId) 不重复创建项目
 * - 迁移成功前不删除任何本地数据；服务端不接触 localStorage
 */

const LIMITS = {
  milestones: 50,
  tasks: 500,
  evidence: 1000,
  progress: 500,
  materials: 50,
  segmentsPerMaterial: 200,
  understandingItems: 500,
  doubts: 500,
  chats: 500,
}

const CONFIRMATION_WINDOW_MS = 30 * 60 * 1000
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000

const MATERIAL_KINDS = new Set(['goalCandidates', 'outcomeCandidates', 'dataNotes', 'methodNotes', 'openQuestions'])
class WarningCollector {
  private readonly entries = new Map<string, { code: string; message: string; count: number }>()

  add(code: string, message: string, count = 1): void {
    const existing = this.entries.get(code)
    if (existing === undefined) this.entries.set(code, { code, message, count })
    else existing.count += count
  }

  list(): Array<{ code: string; message: string; count: number }> {
    return [...this.entries.values()]
  }
}

function migrationInvalid(): V3Error {
  return new V3Error('MIGRATION_INVALID_DATA')
}

function readRecord(value: unknown, _field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw migrationInvalid()
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, _field: string, max: number): string {
  if (typeof value !== 'string') throw migrationInvalid()
  const trimmed = value.trim()
  if (trimmed === '' || [...trimmed].length > max) throw migrationInvalid()
  return trimmed
}

function readNullableString(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw migrationInvalid()
  const trimmed = value.trim()
  if (trimmed === '') return null
  if ([...trimmed].length > max) throw migrationInvalid()
  return trimmed
}

function readArray(value: unknown, max: number, required = true): unknown[] {
  if (value === undefined || value === null) {
    if (required) throw migrationInvalid()
    return []
  }
  if (!Array.isArray(value)) throw migrationInvalid()
  if (value.length > max) throw new V3Error('MIGRATION_TOO_LARGE')
  return value
}

function readIso(value: unknown, fallback: string | null = null): string | null {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') throw migrationInvalid()
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw migrationInvalid()
  return date.toISOString()
}

function readInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw migrationInvalid()
  return value
}

function readTimestamp(value: unknown, fallback: string): string {
  return readIso(value, fallback) ?? fallback
}

/* --------------------------------------------------------------- 校验结构 */

interface MilestoneInput {
  clientId: string
  name: string
  goal: string | null
  doneCriteria: string | null
  dueAt: string | null
  status: string
  orderIndex: number
}

interface TaskInput {
  clientId: string
  milestoneClientId: string | null
  title: string
  doneCriteria: string | null
  status: string
  createdAt: string
  updatedAt: string
}

interface EvidenceInput {
  clientId: string
  submissionId: string | null
  taskClientId: string | null
  milestoneClientId: string | null
  didWhat: string
  foundWhat: string | null
  stillUnsure: string | null
  attachmentName: string | null
  createdAt: string
}

interface ProgressInput {
  clientId: string
  summary: string
  milestoneClientId: string | null
  taskClientId: string | null
  occurredAt: string
}

interface DoubtInput {
  clientId: string
  text: string
  status: string
  sourceEvidenceClientId: string | null
  createdAt: string
  resolvedAt: string | null
}

interface SegmentInput {
  segmentId: string
  index: number
  startLine: number
  endLine: number
  text: string
}

interface UnderstandingInput {
  clientId: string
  clientItemId: string | null
  kind: string
  text: string
  sourceSegmentIds: string[]
  status: string
}

interface MaterialInput {
  clientId: string
  name: string
  type: string
  size: number
  encoding: string
  status: string
  version: number
  createdAt: string
  updatedAt: string
  segments: SegmentInput[]
  items: UnderstandingInput[]
}

interface ChatInput {
  clientId: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string | null
  source: string | null
  fallbackReason: string | null
}

interface ParsedMigration {
  migrationId: string
  clientProjectId: string
  name: string
  short: string
  profile: ReturnType<typeof parseProfile>
  localRevision: number
  milestones: MilestoneInput[]
  tasks: TaskInput[]
  evidence: EvidenceInput[]
  progress: ProgressInput[]
  doubts: DoubtInput[]
  materials: MaterialInput[]
  chats: ChatInput[]
  warnings: WarningCollector
}

function parseMilestones(raw: unknown[]): MilestoneInput[] {
  const ids = new Set<string>()
  return raw.map((entry, index) => {
    const record = readRecord(entry, 'milestones')
    const clientId = readString(record.clientId, 'milestones.clientId', 64)
    if (ids.has(clientId)) throw migrationInvalid()
    ids.add(clientId)
    const status = record.status
    if (
      status !== 'planned' &&
      status !== 'active' &&
      status !== 'completed' &&
      status !== 'archived'
    ) {
      throw migrationInvalid()
    }
    return {
      clientId,
      name: readString(record.name, 'milestones.name', 60),
      goal: readNullableString(record.goal, 300),
      doneCriteria: readNullableString(record.doneCriteria, 300),
      dueAt: readIso(record.dueAt),
      status,
      orderIndex: readInteger(record.orderIndex, index),
    }
  })
}

function parseTasks(raw: unknown[], milestoneIds: Set<string>): TaskInput[] {
  const ids = new Set<string>()
  return raw.map((entry) => {
    const record = readRecord(entry, 'tasks')
    const clientId = readString(record.clientId, 'tasks.clientId', 64)
    if (ids.has(clientId)) throw migrationInvalid()
    ids.add(clientId)
    const milestoneClientId = readNullableString(record.milestoneClientId, 64)
    if (milestoneClientId !== null && !milestoneIds.has(milestoneClientId)) throw migrationInvalid()
    if (record.status !== 'todo' && record.status !== 'doing' && record.status !== 'done') {
      throw migrationInvalid()
    }
    return {
      clientId,
      milestoneClientId,
      title: readString(record.title, 'tasks.title', 60),
      doneCriteria: readNullableString(record.doneCriteria, 200),
      status: record.status,
      createdAt: readTimestamp(record.createdAt, new Date().toISOString()),
      updatedAt: readTimestamp(record.updatedAt, new Date().toISOString()),
    }
  })
}

function parseEvidence(
  raw: unknown[],
  taskIds: Set<string>,
  milestoneIds: Set<string>,
): EvidenceInput[] {
  const ids = new Set<string>()
  return raw.map((entry) => {
    const record = readRecord(entry, 'evidence')
    const clientId = readString(record.clientId, 'evidence.clientId', 64)
    if (ids.has(clientId)) throw migrationInvalid()
    ids.add(clientId)
    const taskClientId = readNullableString(record.taskClientId, 64)
    if (taskClientId !== null && !taskIds.has(taskClientId)) throw migrationInvalid()
    const milestoneClientId = readNullableString(record.milestoneClientId, 64)
    if (milestoneClientId !== null && !milestoneIds.has(milestoneClientId)) throw migrationInvalid()
    const submissionId = readNullableString(record.submissionId, 64)
    if (submissionId !== null && !/^[\x21-\x7E]{8,64}$/.test(submissionId)) throw migrationInvalid()
    return {
      clientId,
      submissionId,
      taskClientId,
      milestoneClientId,
      didWhat: readString(record.didWhat, 'evidence.didWhat', 300),
      foundWhat: readNullableString(record.foundWhat, 500),
      stillUnsure: readNullableString(record.stillUnsure, 500),
      attachmentName: readNullableString(record.attachmentName, 200),
      createdAt: readTimestamp(record.createdAt, new Date().toISOString()),
    }
  })
}

function parseProgress(
  raw: unknown[],
  taskIds: Set<string>,
  milestoneIds: Set<string>,
): ProgressInput[] {
  const ids = new Set<string>()
  return raw.map((entry) => {
    const record = readRecord(entry, 'progress')
    const clientId = readString(record.clientId, 'progress.clientId', 64)
    if (ids.has(clientId)) throw migrationInvalid()
    ids.add(clientId)
    const taskClientId = readNullableString(record.taskClientId, 64)
    if (taskClientId !== null && !taskIds.has(taskClientId)) throw migrationInvalid()
    const milestoneClientId = readNullableString(record.milestoneClientId, 64)
    if (milestoneClientId !== null && !milestoneIds.has(milestoneClientId)) throw migrationInvalid()
    return {
      clientId,
      summary: readString(record.summary, 'progress.summary', 1000),
      milestoneClientId,
      taskClientId,
      occurredAt: readTimestamp(record.occurredAt, new Date().toISOString()),
    }
  })
}

function parseDoubts(raw: unknown[], evidenceIds: Set<string>): DoubtInput[] {
  const ids = new Set<string>()
  return raw.map((entry) => {
    const record = readRecord(entry, 'doubts')
    const clientId = readString(record.clientId, 'doubts.clientId', 64)
    if (ids.has(clientId)) throw migrationInvalid()
    ids.add(clientId)
    const status = record.status
    if (status !== 'open' && status !== 'resolved' && status !== 'archived') throw migrationInvalid()
    const sourceEvidenceClientId = readNullableString(record.sourceEvidenceClientId, 64)
    if (sourceEvidenceClientId !== null && !evidenceIds.has(sourceEvidenceClientId)) {
      throw migrationInvalid()
    }
    return {
      clientId,
      text: readString(record.text, 'doubts.text', 500),
      status,
      sourceEvidenceClientId,
      createdAt: readTimestamp(record.createdAt, new Date().toISOString()),
      resolvedAt: readIso(record.resolvedAt),
    }
  })
}

function parseMaterials(
  raw: unknown[],
  warnings: WarningCollector,
): MaterialInput[] {
  const ids = new Set<string>()
  return raw.map((entry) => {
    const record = readRecord(entry, 'materials')
    const clientId = readString(record.clientId, 'materials.clientId', 64)
    if (ids.has(clientId)) throw migrationInvalid()
    ids.add(clientId)

    const name = readString(record.name, 'materials.name', 200)
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : 'unknown'
    const version = Math.max(1, readInteger(record.version, 1))
    const size = Math.max(0, readInteger(record.size, 0))
    const encoding = record.encoding === 'gbk' ? 'gbk' : 'utf-8'
    const createdAt = readTimestamp(record.createdAt, new Date().toISOString())
    const updatedAt = readTimestamp(record.updatedAt, createdAt)
    const rawStatus = typeof record.status === 'string' ? record.status : 'registered'
    const rawSegments = readArray(record.segments, LIMITS.segmentsPerMaterial, false)
    const rawItems = readArray(record.understandingItems, LIMITS.understandingItems, false)

    const supported = (type === 'md' || type === 'txt') && size <= 1024 * 1024
    if (!supported) {
      if (size > 1024 * 1024) warnings.add('MATERIAL_TOO_LARGE_SKIPPED', '材料超过 1 MB，已跳过正文迁移')
      else warnings.add('UNSUPPORTED_MATERIAL_SKIPPED', '当前不支持该材料格式，仅保留文件元数据')
      return {
        clientId,
        name,
        type,
        size,
        encoding,
        status: 'unsupported',
        version,
        createdAt,
        updatedAt,
        segments: [],
        items: [],
      }
    }

    const segments: SegmentInput[] = []
    const segmentIds = new Set<string>()
    let invalidSegment = false
    for (const rawSegment of rawSegments) {
      const segment = readRecord(rawSegment, 'materials.segments')
      const segmentId = readString(segment.segmentId, 'segments.segmentId', 64)
      if (segmentIds.has(segmentId)) throw migrationInvalid()
      segmentIds.add(segmentId)
      if (typeof segment.text !== 'string' || [...segment.text].length > 2000) {
        invalidSegment = true
        continue
      }
      segments.push({
        segmentId,
        index: readInteger(segment.index, segments.length),
        startLine: Math.max(1, readInteger(segment.startLine, 1)),
        endLine: Math.max(1, readInteger(segment.endLine, 1)),
        text: segment.text,
      })
    }

    if (invalidSegment) {
      warnings.add('MATERIAL_INVALID_SKIPPED', '材料分段超过 2,000 字，已跳过该材料')
      return {
        clientId,
        name,
        type,
        size,
        encoding,
        status: 'registered',
        version,
        createdAt,
        updatedAt,
        segments: [],
        items: [],
      }
    }

    if (segments.length === 0 && rawStatus !== 'registered') {
      warnings.add('MATERIAL_INVALID_SKIPPED', '材料缺少有效正文，已跳过')
      return {
        clientId,
        name,
        type,
        size,
        encoding,
        status: 'registered',
        version,
        createdAt,
        updatedAt,
        segments: [],
        items: [],
      }
    }

    const items: UnderstandingInput[] = []
    const itemIds = new Set<string>()
    for (const rawItem of rawItems) {
      const item = readRecord(rawItem, 'materials.understandingItems')
      const itemClientId = readString(item.clientId, 'understandingItems.clientId', 64)
      if (itemIds.has(itemClientId)) throw migrationInvalid()
      itemIds.add(itemClientId)
      if (typeof item.kind !== 'string' || !MATERIAL_KINDS.has(item.kind)) throw migrationInvalid()
      const sourceSegmentIdsRaw = readArray(item.sourceSegmentIds, 3, false)
      const sourceSegmentIds = sourceSegmentIdsRaw.map((value) => {
        if (typeof value !== 'string') throw migrationInvalid()
        return value
      })
      const missing = sourceSegmentIds.some((id) => !segmentIds.has(id))
      if (missing) warnings.add('UNDERSTANDING_SOURCE_MISSING', '部分理解条目来源片段缺失，已退回待确认')
      const status =
        item.status === 'archived'
          ? 'archived'
          : missing
            ? 'pending'
            : item.status === 'confirmed' || item.status === 'modified'
              ? item.status
              : 'pending'
      items.push({
        clientId: itemClientId,
        clientItemId: readNullableString(item.clientItemId, 64),
        kind: item.kind,
        text: readString(item.text, 'understandingItems.text', 300),
        sourceSegmentIds: sourceSegmentIds.filter((id) => segmentIds.has(id)),
        status,
      })
    }

    return {
      clientId,
      name,
      type,
      size,
      encoding,
      status:
        rawStatus === 'archived'
          ? 'archived'
          : rawStatus === 'parse_failed'
            ? 'parse_failed'
            : segments.length > 0
              ? 'parsed'
              : 'registered',
      version,
      createdAt,
      updatedAt,
      segments,
      items,
    }
  })
}

function parseChats(raw: unknown[], warnings: WarningCollector): ChatInput[] {
  if (raw.length > LIMITS.chats) {
    warnings.add(
      'CHAT_HISTORY_TRUNCATED',
      '聊天记录超过 500 条，仅保留最近 500 条',
      raw.length - LIMITS.chats,
    )
  }
  const kept = raw.slice(-LIMITS.chats)
  const ids = new Set<string>()
  return kept.map((entry, index) => {
    const record = readRecord(entry, 'chats')
    const clientId =
      typeof record.clientId === 'string' && record.clientId !== ''
        ? record.clientId
        : `chat_local_${index}`
    if (ids.has(clientId)) throw migrationInvalid()
    ids.add(clientId)
    if (record.role !== 'user' && record.role !== 'assistant') throw migrationInvalid()
    const text = readString(record.text, 'chats.text', 4000)
    return {
      clientId,
      role: record.role,
      text,
      createdAt: readIso(record.createdAt),
      source: typeof record.source === 'string' ? record.source : null,
      fallbackReason: typeof record.fallbackReason === 'string' ? record.fallbackReason : null,
    }
  })
}

function parseMigration(body: Record<string, unknown>, now: Date): ParsedMigration {
  const migrationId = body.migrationId
  if (typeof migrationId !== 'string' || !/^mig_[A-Za-z0-9_-]{4,60}$/.test(migrationId)) {
    throw migrationInvalid()
  }

  if (body.userConfirmed !== true) throw new V3Error('MIGRATION_NOT_CONFIRMED')
  const confirmedAt = readIso(body.userConfirmedAt)
  if (confirmedAt === null) throw migrationInvalid()
  const diff = now.getTime() - new Date(confirmedAt).getTime()
  if (diff > CONFIRMATION_WINDOW_MS) throw new V3Error('MIGRATION_CONFIRMATION_EXPIRED')
  if (diff < -FUTURE_TOLERANCE_MS) throw new V3Error('MIGRATION_CONFIRMATION_EXPIRED')

  const source = readRecord(body.source, 'source')
  if (typeof source.schemaVersion !== 'number' || !Number.isInteger(source.schemaVersion) || source.schemaVersion < 1) {
    throw new V3Error('MIGRATION_DATA_OUTDATED')
  }
  if (source.schemaVersion > 3) throw new V3Error('MIGRATION_VERSION_UNSUPPORTED')
  const clientProjectId = readString(source.clientProjectId, 'source.clientProjectId', 64)

  const local = readRecord(body.localProject, 'localProject')
  const name = readString(local.name, 'localProject.name', 120)
  const shortRaw = readNullableString(local.short, 20)
  const short = shortRaw ?? [...name].slice(0, 12).join('')

  let profile: ReturnType<typeof parseProfile>
  try {
    profile = parseProfile(local.profile)
  } catch {
    throw migrationInvalid()
  }

  const warnings = new WarningCollector()
  const milestones = parseMilestones(readArray(local.milestones, LIMITS.milestones))
  const milestoneIds = new Set(milestones.map((item) => item.clientId))
  const tasks = parseTasks(readArray(local.tasks, LIMITS.tasks), milestoneIds)
  const taskIds = new Set(tasks.map((item) => item.clientId))
  const evidence = parseEvidence(readArray(local.evidence, LIMITS.evidence), taskIds, milestoneIds)
  const evidenceIds = new Set(evidence.map((item) => item.clientId))
  const progress = parseProgress(readArray(local.progress, LIMITS.progress, false), taskIds, milestoneIds)
  const doubts = parseDoubts(readArray(local.doubts, LIMITS.doubts), evidenceIds)
  const materials = parseMaterials(readArray(local.materials, LIMITS.materials), warnings)
  // 聊天可超过 500 条：读取后只保留最近 500 条并返回警告
  const chats = parseChats(readArray(local.chats, 100_000, false), warnings)
  const understandingTotal = materials.reduce((total, material) => total + material.items.length, 0)
  if (understandingTotal > LIMITS.understandingItems) throw new V3Error('MIGRATION_TOO_LARGE')

  return {
    migrationId,
    clientProjectId,
    name,
    short,
    profile,
    localRevision: Math.max(0, readInteger(local.projectRevision, 0)),
    milestones,
    tasks,
    evidence,
    progress,
    doubts,
    materials,
    chats,
    warnings,
  }
}

/* --------------------------------------------------------------- 写入事务 */

interface IdMap {
  milestones: Record<string, string>
  tasks: Record<string, string>
  evidence: Record<string, string>
  progress: Record<string, string>
  materials: Record<string, string>
  understandingItems: Record<string, string>
  doubts: Record<string, string>
  chats: Record<string, string>
}

interface Counts {
  milestones: number
  tasks: number
  evidence: number
  progress: number
  materials: number
  materialSegments: number
  understandingItems: number
  doubts: number
  chatMessages: number
}

interface MigrationResult {
  projectId: string
  idMap: IdMap
  counts: Counts
  warnings: Array<{ code: string; message: string; count: number }>
  importedAt: string
}

function writeMigration(
  db: V3Database,
  userId: string,
  parsed: ParsedMigration,
  now: Date,
  nowText: string,
): MigrationResult {
  const projectId = newId('prj', now.getTime())

  db.prepare(
    `INSERT INTO projects
       (project_id, owner_user_id, name, short, profile_json, status, visibility,
        project_revision, current_milestone_id, last_activity_at, created_at, updated_at,
        archived_at, deleted_at, purge_after, migrated_from_revision, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, 'active', 'private', 1, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    projectId,
    userId,
    parsed.name,
    parsed.short,
    JSON.stringify(parsed.profile),
    nowText,
    nowText,
    nowText,
    parsed.localRevision,
    userId,
  )

  const idMap: IdMap = {
    milestones: {},
    tasks: {},
    evidence: {},
    progress: {},
    materials: {},
    understandingItems: {},
    doubts: {},
    chats: {},
  }
  const counts: Counts = {
    milestones: 0,
    tasks: 0,
    evidence: 0,
    progress: 0,
    materials: 0,
    materialSegments: 0,
    understandingItems: 0,
    doubts: 0,
    chatMessages: 0,
  }

  const milestoneNames = new Map<string, string>()
  for (const milestone of parsed.milestones) {
    const id = newId('ms', now.getTime())
    idMap.milestones[milestone.clientId] = id
    milestoneNames.set(milestone.clientId, milestone.name)
    const completedAt = milestone.status === 'completed' ? nowText : null
    const archivedAt = milestone.status === 'archived' ? nowText : null
    db.prepare(
      `INSERT INTO milestones
         (milestone_id, project_id, user_id, name, name_key, goal, done_criteria, due_at,
          status, order_index, source, revision, created_at, updated_at, completed_at,
          archived_at, archived_from_status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration', 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      userId,
      milestone.name,
      normalizeNameKey(milestone.name),
      milestone.goal,
      milestone.doneCriteria,
      milestone.dueAt,
      milestone.status,
      milestone.orderIndex,
      nowText,
      nowText,
      completedAt,
      archivedAt,
      archivedAt === null ? null : 'planned',
      userId,
    )
    counts.milestones += 1
  }

  for (const task of parsed.tasks) {
    const id = newId('tsk', now.getTime())
    idMap.tasks[task.clientId] = id
    const milestoneId =
      task.milestoneClientId === null ? null : idMap.milestones[task.milestoneClientId] ?? null
    db.prepare(
      `INSERT INTO tasks
         (task_id, project_id, milestone_id, user_id, title, done_criteria, status,
          assignee_user_id, order_index, source, revision, created_at, updated_at,
          started_at, completed_at, archived_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'migration', 1, ?, ?, NULL, ?, NULL, ?)`,
    ).run(
      id,
      projectId,
      milestoneId,
      userId,
      task.title,
      task.doneCriteria,
      task.status,
      counts.tasks,
      task.createdAt,
      task.updatedAt,
      task.status === 'done' ? task.updatedAt : null,
      userId,
    )
    counts.tasks += 1
  }

  for (const item of parsed.evidence) {
    const id = newId('evd', now.getTime())
    idMap.evidence[item.clientId] = id
    const taskId = item.taskClientId === null ? null : idMap.tasks[item.taskClientId] ?? null
    const milestoneId =
      item.milestoneClientId === null ? null : idMap.milestones[item.milestoneClientId] ?? null
    const milestoneName =
      item.milestoneClientId === null ? null : milestoneNames.get(item.milestoneClientId) ?? null
    const submissionId = item.submissionId ?? newId('sub', now.getTime())
    db.prepare(
      `INSERT INTO evidence
         (evidence_id, project_id, task_id, milestone_id, milestone_name_snapshot, user_id,
          submission_id, did_what, found_what, still_unsure, attachment_name, status,
          author_user_id, revision, created_at, updated_at, redacted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, NULL)`,
    ).run(
      id,
      projectId,
      taskId,
      milestoneId,
      milestoneName,
      userId,
      submissionId,
      item.didWhat,
      item.foundWhat,
      item.stillUnsure,
      item.attachmentName,
      userId,
      item.createdAt,
      item.createdAt,
    )
    counts.evidence += 1
  }

  for (const item of parsed.progress) {
    const id = newId('prg', now.getTime())
    idMap.progress[item.clientId] = id
    const milestoneId =
      item.milestoneClientId === null ? null : idMap.milestones[item.milestoneClientId] ?? null
    const taskId = item.taskClientId === null ? null : idMap.tasks[item.taskClientId] ?? null
    db.prepare(
      `INSERT INTO progress_records
         (progress_id, project_id, milestone_id, task_id, user_id, summary, evidence_ids_json,
          occurred_at, status, supersedes_progress_id, author_user_id, revision,
          created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'active', NULL, ?, 1, ?, ?, NULL)`,
    ).run(id, projectId, milestoneId, taskId, userId, item.summary, item.occurredAt, userId, nowText, nowText)
    counts.progress += 1
  }

  for (const material of parsed.materials) {
    const materialId = newId('mat', now.getTime())
    idMap.materials[material.clientId] = materialId
    db.prepare(
      `INSERT INTO materials
         (material_id, material_version, project_id, user_id, name, type, size, encoding,
          status, revision, sha256, failure_reason, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?, ?)`,
    ).run(
      materialId,
      material.version,
      projectId,
      userId,
      material.name,
      material.type,
      material.size,
      material.encoding,
      material.status,
      material.createdAt,
      material.updatedAt,
      material.status === 'archived' ? nowText : null,
    )
    counts.materials += 1

    for (const segment of material.segments) {
      db.prepare(
        `INSERT INTO material_segments
           (material_id, material_version, segment_id, idx, start_line, end_line, text, char_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        materialId,
        material.version,
        segment.segmentId,
        segment.index,
        segment.startLine,
        segment.endLine,
        segment.text,
        [...segment.text].length,
        material.createdAt,
      )
      counts.materialSegments += 1
    }

    for (const item of material.items) {
      const itemId = newId('cnd', now.getTime())
      idMap.understandingItems[item.clientId] = itemId
      const sources = item.sourceSegmentIds.map((segmentId) => {
        const segment = material.segments.find((entry) => entry.segmentId === segmentId)
        return {
          materialId,
          materialVersion: material.version,
          segmentId,
          startLine: segment?.startLine ?? 1,
          endLine: segment?.endLine ?? 1,
        }
      })
      const confirmed = item.status === 'confirmed'
      db.prepare(
        `INSERT INTO understanding_items
           (item_id, client_item_id, project_id, material_id, material_version, kind, text,
            original_text, sources_json, status, source, revision, created_at, updated_at,
            confirmed_at, confirmed_by_user_id, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration', 1, ?, ?, ?, ?, ?)`,
      ).run(
        itemId,
        item.clientItemId,
        projectId,
        materialId,
        material.version,
        item.kind,
        item.text,
        item.text,
        JSON.stringify(sources),
        item.status,
        material.createdAt,
        nowText,
        confirmed ? nowText : null,
        confirmed ? userId : null,
        item.status === 'archived' ? nowText : null,
      )
      counts.understandingItems += 1
    }
  }

  for (const doubt of parsed.doubts) {
    const id = newId('dbt', now.getTime())
    idMap.doubts[doubt.clientId] = id
    const sourceEvidenceId =
      doubt.sourceEvidenceClientId === null
        ? null
        : idMap.evidence[doubt.sourceEvidenceClientId] ?? null
    db.prepare(
      `INSERT INTO doubts
         (doubt_id, project_id, milestone_id, task_id, user_id, text, status,
          source_evidence_id, revision, created_at, updated_at, resolved_at, resolved_by_user_id)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      userId,
      doubt.text,
      doubt.status,
      sourceEvidenceId,
      doubt.createdAt,
      nowText,
      doubt.resolvedAt,
      doubt.resolvedAt === null ? null : userId,
    )
    counts.doubts += 1
  }

  if (parsed.chats.length > 0) {
    const chatId = newId('chat', now.getTime())
    let lastMessageAt: string | null = null
    const messages = parsed.chats.map((message, index) => {
      const messageId = newId('msg', now.getTime())
      idMap.chats[message.clientId] = messageId
      const createdAt = message.createdAt ?? new Date(now.getTime() + index).toISOString()
      lastMessageAt = createdAt
      return { message, messageId, createdAt }
    })

    db.prepare(
      `INSERT INTO chat_sessions
         (chat_id, project_id, milestone_id, user_id, title, status, chat_revision,
          message_count, last_message_at, created_at, updated_at, archived_at)
       VALUES (?, ?, NULL, ?, NULL, 'active', ?, ?, ?, ?, ?, NULL)`,
    ).run(
      chatId,
      projectId,
      userId,
      messages.length + 1,
      messages.length,
      lastMessageAt,
      nowText,
      nowText,
    )

    for (const [index, entry] of messages.entries()) {
      db.prepare(
        `INSERT INTO chat_messages
           (message_id, chat_id, project_id, sequence, role, content, source, fallback_reason,
            prompt_version, request_id, project_revision_at_send, citations_json, client_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, '[]', NULL, ?)`,
      ).run(
        entry.messageId,
        chatId,
        projectId,
        index + 1,
        entry.message.role,
        entry.message.text,
        entry.message.source,
        entry.message.fallbackReason,
        entry.createdAt,
      )
      counts.chatMessages += 1
    }
  }

  recalcCurrentMilestone(db, projectId)

  return {
    projectId,
    idMap,
    counts,
    warnings: parsed.warnings.list(),
    importedAt: nowText,
  }
}

/* ----------------------------------------------------------------- 路由 */

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, MIGRATION_BODY_LIMIT))
  } catch (error) {
    throw bodyReadError(error)
  }
}

export async function handleMigrateLocal(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
): Promise<void> {
  const body = await readBody(req)
  requireContractVersion(body)
  const requestId = requireRequestId(body)
  const idempotencyKey = requireIdempotencyKey(body)
  if (typeof body.migrationId !== 'string' || !/^mig_[A-Za-z0-9_-]{4,60}$/.test(body.migrationId)) {
    throw migrationInvalid()
  }
  if (body.userConfirmed !== true) throw new V3Error('MIGRATION_NOT_CONFIRMED')

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint(body)

  const replay = lookupIdempotent(db, userId, idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  // 同一 migrationId 永久幂等（即使 24 小时幂等记录已清理）
  const sameMigration = db
    .prepare('SELECT * FROM local_migrations WHERE user_id = ? AND migration_id = ?')
    .get(userId, body.migrationId) as
    | {
        request_hash: string
        response_json: string
      }
    | undefined
  if (sameMigration !== undefined) {
    if (sameMigration.request_hash !== fingerprint) throw new V3Error('IDEMPOTENCY_CONFLICT')
    const stored = JSON.parse(sameMigration.response_json) as Record<string, unknown>
    stored.replayed = true
    sendV3Json(res, 200, stored)
    return
  }

  // 同一 clientProjectId 只迁移一次
  const source = body.source
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const clientProjectId = (source as Record<string, unknown>).clientProjectId
    if (typeof clientProjectId === 'string') {
      const existing = db
        .prepare('SELECT * FROM local_migrations WHERE user_id = ? AND client_project_id = ?')
        .get(userId, clientProjectId) as
        | {
            project_id: string
            id_map_json: string
            counts_json: string
            warnings_json: string
            imported_at: string
            request_hash: string
          }
        | undefined
      if (existing !== undefined) {
        const project = loadProject(db, userId, existing.project_id, { includeDeleted: true })
        const warnings = JSON.parse(existing.warnings_json) as Array<Record<string, unknown>>
        if (existing.request_hash !== fingerprint) {
          warnings.push({
            code: 'LOCAL_CHANGES_NOT_APPLIED',
            message: '云端已存在该项目，本次本地改动未覆盖云端',
            count: 1,
          })
        }
        const payload = {
          contractVersion: V3_CONTRACT_VERSION,
          requestId,
          projectId: existing.project_id,
          projectRevision: project.project_revision,
          migrationId: body.migrationId,
          status: 'completed',
          replayed: false,
          deduplicated: true,
          appliedChanges: false,
          idMap: JSON.parse(existing.id_map_json) as unknown,
          counts: JSON.parse(existing.counts_json) as unknown,
          warnings,
          importedAt: existing.imported_at,
        }
        transaction(db, () => {
          saveIdempotent(db, userId, idempotencyKey, fingerprint, 200, payload, nowText)
        })
        sendV3Json(res, 200, payload)
        return
      }
    }
  }

  const parsed = parseMigration(body, now)

  let result: MigrationResult
  try {
    result = transaction(db, () => {
      const written = writeMigration(db, userId, parsed, now, nowText)
      const payload = {
        contractVersion: V3_CONTRACT_VERSION,
        requestId,
        projectId: written.projectId,
        projectRevision: 1,
        migrationId: parsed.migrationId,
        status: 'completed',
        replayed: false,
        deduplicated: false,
        appliedChanges: true,
        idMap: written.idMap,
        counts: written.counts,
        warnings: written.warnings,
        importedAt: written.importedAt,
      }
      db.prepare(
        `INSERT INTO local_migrations
           (user_id, migration_id, client_project_id, project_id, request_hash, status,
            id_map_json, counts_json, warnings_json, response_json, imported_at)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        parsed.migrationId,
        parsed.clientProjectId,
        written.projectId,
        fingerprint,
        JSON.stringify(written.idMap),
        JSON.stringify(written.counts),
        JSON.stringify(written.warnings),
        JSON.stringify(payload),
        written.importedAt,
      )
      saveIdempotent(db, userId, idempotencyKey, fingerprint, 200, payload, nowText)
      return { ...written, projectId: written.projectId }
    })
  } catch (error) {
    if (error instanceof V3Error) throw error
    throw new V3Error('MIGRATION_INVALID_DATA')
  }

  sendV3Json(res, 200, {
    contractVersion: V3_CONTRACT_VERSION,
    requestId,
    projectId: result.projectId,
    projectRevision: 1,
    migrationId: parsed.migrationId,
    status: 'completed',
    replayed: false,
    deduplicated: false,
    appliedChanges: true,
    idMap: result.idMap,
    counts: result.counts,
    warnings: result.warnings,
    importedAt: result.importedAt,
  })
}

export async function handleMigrationStatus(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  migrationId: string,
): Promise<void> {
  const db = runtime.getDb()
  const row = db
    .prepare('SELECT * FROM local_migrations WHERE user_id = ? AND migration_id = ?')
    .get(auth.user.user_id, migrationId) as
    | { status: string; project_id: string; imported_at: string }
    | undefined
  if (row === undefined) throw new V3Error('RESOURCE_NOT_FOUND')

  sendV3Json(res, 200, {
    contractVersion: V3_CONTRACT_VERSION,
    migrationId,
    status: row.status,
    projectId: row.project_id,
    importedAt: row.imported_at,
  })
}
