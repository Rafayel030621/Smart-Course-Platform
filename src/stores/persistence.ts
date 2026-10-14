import type {
  Doubt,
  Evidence,
  Material,
  MaterialEncoding,
  MaterialSegment,
  MaterialSourceRef,
  MaterialState,
  MaterialType,
  Project,
  Task,
  UnderstandingBlock,
  UnderstandingBlockKind,
  UnderstandingBlockStatus,
} from '@/types/platform'
import { PROJECT_SCHEMA_VERSION } from '@/types/platform'
import {
  MATERIAL_TYPES,
  UNDERSTANDING_BLOCK_ORDER,
  materialNeedsReupload,
  materialTypeFromFileName,
  normalizeProjectProfile,
  understandingBlockKey,
} from '@/domain/materials'

/**
 * 项目状态的 localStorage 持久化
 * ----------------------------------------------------------------------------
 * 只做四件事：存、取、迁移、以及把坏数据清掉。
 *
 * 硬约束：
 *   1. 只保存项目状态，**不保存任何密钥、模型配置或后端地址**（契约 7.4）；
 *   2. 读到的东西一律不可信：JSON 坏了、字段缺了、版本比当前还新，都按「丢弃」处理，
 *      绝不让半截数据进 store；
 *   3. 写入失败（配额满 / 隐私模式禁用）返回 `STORAGE_FULL`，由 action 决定怎么提示；
 *   4. `schemaVersion` 只用于本地结构迁移，不进任何请求体（契约 2.1）。
 */

/** 项目列表的存储键 */
export const STORAGE_KEY_PROJECTS = 'scp.mvp.projects'
/** 当前选中项目的存储键 */
export const STORAGE_KEY_CURRENT_PROJECT_ID = 'scp.mvp.currentProjectId'

/** 当前结构版本。结构不兼容变更时 +1，并在 `migrateProject` 里补一条分支 */
export const CURRENT_SCHEMA_VERSION = PROJECT_SCHEMA_VERSION

export interface PersistedState {
  projects: Project[]
  currentProjectId: string | null
}

export type SaveResult = { ok: true } | { ok: false; code: 'STORAGE_FULL'; message: string }

interface ProjectsEnvelope {
  schemaVersion: number
  projects: unknown[]
}

/* ------------------------------------------------------------------ 底层读写 */

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || window.localStorage === undefined) return null
    return window.localStorage
  } catch {
    // 某些隐私模式下访问 localStorage 会直接抛错
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumberArray(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback]
  return value.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : 0))
}

/* -------------------------------------------------------------------- 归一化 */

function normalizeTask(raw: unknown, projectId: string, nowIso: string): Task | null {
  if (!isPlainObject(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (id === null || title === '') return null

  const status = raw.status === 'doing' || raw.status === 'done' ? raw.status : 'todo'

  return {
    id,
    projectId,
    title,
    status,
    doneCriteria: asNullableString(raw.doneCriteria),
    // 契约 2.2：MVP 无成员名单，线上 owner 恒为 null
    owner: null,
    // 旧数据里模板的「成员A」存在 owner 上，迁移到展示字段
    suggestedOwner: asNullableString(raw.suggestedOwner ?? raw.owner),
    milestone: asNullableString(raw.milestone),
    why: asNullableString(raw.why),
    createdAt: asString(raw.createdAt, nowIso),
    updatedAt: asString(raw.updatedAt, nowIso),
  }
}

function normalizeEvidence(raw: unknown, projectId: string, nowIso: string): Evidence | null {
  if (!isPlainObject(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  const didWhat = typeof raw.didWhat === 'string' ? raw.didWhat.trim() : ''
  if (id === null || didWhat === '') return null

  return {
    id,
    projectId,
    submissionId: asString(raw.submissionId, id),
    taskId: asNullableString(raw.taskId),
    didWhat,
    foundWhat: asNullableString(raw.foundWhat),
    stillUnsure: asNullableString(raw.stillUnsure),
    attachmentName: asNullableString(raw.attachmentName),
    author: asNullableString(raw.author),
    createdAt: asString(raw.createdAt, nowIso),
  }
}

function normalizeDoubt(raw: unknown, projectId: string, nowIso: string): Doubt | null {
  if (!isPlainObject(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (id === null || text === '') return null

  return {
    id,
    projectId,
    text,
    status: raw.status === 'resolved' ? 'resolved' : 'open',
    sourceEvidenceId: asNullableString(raw.sourceEvidenceId),
    createdAt: asString(raw.createdAt, nowIso),
    resolvedAt: asNullableString(raw.resolvedAt),
  }
}

/* ------------------------------------------- v2 / v3 归一化（契约 13 / 14） */

const MATERIAL_ENCODINGS: readonly MaterialEncoding[] = ['utf-8', 'gbk']
const MATERIAL_STATES: readonly MaterialState[] = ['parsed', 'parse_failed']
const UNDERSTANDING_STATUSES: readonly UnderstandingBlockStatus[] = ['pending', 'confirmed', 'modified']

function asInteger(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : fallback
}

function asNullableInteger(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null
}

/**
 * 契约 14.1：材料元数据。
 *
 * `materialId` / `name` 缺失或类型不对就整条丢弃——没有 ID 的材料无法被引用；
 * `type` / `size` / `encoding` / `state` 允许为 `null`（旧数据迁移来的「仅登记」材料
 * 从未经过服务端），此时 `needsReupload` 为 true，界面上提示重新上传。
 */
function normalizeMaterial(raw: unknown, projectId: string, nowIso: string): Material | null {
  if (!isPlainObject(raw)) return null

  const materialId = typeof raw.materialId === 'string' && raw.materialId !== '' ? raw.materialId : null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (materialId === null || name === '') return null

  const type =
    typeof raw.type === 'string' && (MATERIAL_TYPES as readonly string[]).includes(raw.type)
      ? (raw.type as MaterialType)
      : materialTypeFromFileName(name)
  const encoding =
    typeof raw.encoding === 'string' && MATERIAL_ENCODINGS.includes(raw.encoding as MaterialEncoding)
      ? (raw.encoding as MaterialEncoding)
      : null
  const state =
    typeof raw.state === 'string' && MATERIAL_STATES.includes(raw.state as MaterialState)
      ? (raw.state as MaterialState)
      : null

  return {
    materialId,
    projectId,
    name,
    type,
    size: asNullableInteger(raw.size, 1),
    encoding,
    state,
    version: asInteger(raw.version, 1, 1),
    createdAt: asString(raw.createdAt, nowIso),
    updatedAt: asString(raw.updatedAt, nowIso),
    failureReason: asNullableString(raw.failureReason),
    // 具体是否要重传由片段数决定，收集完片段后再统一修正
    needsReupload: state !== 'parsed',
  }
}

/**
 * 旧占位材料（`Project.materials` 的 `{ name, type }`）→ 「仅登记」材料。
 *
 * v1 模板给每个项目预置了一条材料占位；v2 的材料白名单只有 md / txt，这些占位
 * 大多不是 md / txt，因此转成 `state: null` + `needsReupload: true` 的材料记录，
 * 界面上提示「仅登记，待重新上传」，原始 `Project.materials` 保持不动。
 * `materialId` 由下标稳定派生，重复迁移不会产生第二条。
 */
function legacyMaterialsOf(
  raw: Record<string, unknown>,
  projectId: string,
  nowIso: string,
  existing: Material[],
): Material[] {
  const additions: Material[] = []

  asArray(raw.materials).forEach((item, index) => {
    if (!isPlainObject(item)) return
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (name === '') return
    const materialId = `mat_legacy_${index + 1}`
    if (existing.some((material) => material.materialId === materialId)) return
    if (additions.some((material) => material.materialId === materialId)) return

    additions.push({
      materialId,
      projectId,
      name,
      type: materialTypeFromFileName(name),
      size: null,
      encoding: null,
      state: null,
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      failureReason: null,
      needsReupload: true,
    })
  })

  return additions
}

/**
 * 收集材料片段。
 *
 * 兼容两种持久化形态：
 *   - v3：扁平数组，每条自带 `materialId` / `materialVersion`；
 *   - v2：`{ [materialId]: Segment[] }` 映射（片段本身没有归属字段）。
 *
 * 非当前版本、或材料不是 `parsed` 的片段一律丢弃（契约 14.5 第 4 条）。
 */
function collectSegments(raw: Record<string, unknown>, materials: Material[]): MaterialSegment[] {
  const byId = new Map(materials.map((material) => [material.materialId, material]))
  const result: MaterialSegment[] = []
  const seen = new Set<string>()

  const push = (candidate: MaterialSegment | null): void => {
    if (candidate === null) return
    const material = byId.get(candidate.materialId)
    if (material === undefined || material.version !== candidate.materialVersion) return
    if (material.state !== 'parsed') return
    const key = `${candidate.materialId}#${candidate.materialVersion}#${candidate.segmentId}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(candidate)
  }

  const table = raw.materialSegments
  if (Array.isArray(table)) {
    for (const item of table) {
      if (!isPlainObject(item)) continue
      push(
        normalizeSegment(
          item,
          asString(item.materialId, ''),
          asInteger(item.materialVersion, 1, 1),
        ),
      )
    }
  } else if (isPlainObject(table)) {
    for (const material of materials) {
      for (const item of asArray(table[material.materialId])) {
        push(normalizeSegment(item, material.materialId, material.version))
      }
    }
  }

  return result
}

function normalizeSegment(
  raw: unknown,
  materialId: string,
  materialVersion: number,
): MaterialSegment | null {
  if (!isPlainObject(raw)) return null
  const segmentId = typeof raw.segmentId === 'string' && raw.segmentId !== '' ? raw.segmentId : null
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (segmentId === null || text === '' || materialId === '') return null

  const startLine = asInteger(raw.startLine, 1, 1)
  const endLine = Math.max(startLine, asInteger(raw.endLine, startLine, 1))

  return {
    segmentId,
    materialId,
    materialVersion,
    index: asInteger(raw.index, 0, 0),
    startLine,
    endLine,
    text,
  }
}

function normalizeSourceRef(raw: unknown): MaterialSourceRef | null {
  if (!isPlainObject(raw)) return null
  const materialId = typeof raw.materialId === 'string' && raw.materialId !== '' ? raw.materialId : null
  const segmentId = typeof raw.segmentId === 'string' && raw.segmentId !== '' ? raw.segmentId : null
  if (materialId === null || segmentId === null) return null

  const startLine = asInteger(raw.startLine, 1, 1)
  const endLine = Math.max(startLine, asInteger(raw.endLine, startLine, 1))

  return {
    materialId,
    materialName: asString(raw.materialName, materialId),
    materialVersion: asInteger(raw.materialVersion, 1, 1),
    segmentId,
    startLine,
    endLine,
  }
}

/**
 * 契约 14.3：理解草稿条目。
 *
 * - 块名接受 `kind`（v3）与 `block`（v2）；
 * - 正文接受 `content`（v3）与 `text`（v2）；
 * - 块名不在五块内、正文为空、或来源全部无效（条目必须有 1～3 条来源）就丢弃。
 */
function normalizeUnderstandingBlock(raw: unknown, nowIso: string): UnderstandingBlock | null {
  if (!isPlainObject(raw)) return null

  const materialId = typeof raw.materialId === 'string' && raw.materialId !== '' ? raw.materialId : null
  const itemId = typeof raw.itemId === 'string' && raw.itemId !== '' ? raw.itemId : null
  const kindRaw = typeof raw.kind === 'string' ? raw.kind : raw.block
  const kind =
    typeof kindRaw === 'string' && UNDERSTANDING_BLOCK_ORDER.includes(kindRaw as UnderstandingBlockKind)
      ? (kindRaw as UnderstandingBlockKind)
      : null
  if (materialId === null || itemId === null || kind === null) return null

  const contentRaw = typeof raw.content === 'string' ? raw.content : raw.text
  const content = typeof contentRaw === 'string' ? contentRaw.trim() : ''
  if (content === '') return null

  const sources = asArray(raw.sources)
    .map((item) => normalizeSourceRef(item))
    .filter((item): item is MaterialSourceRef => item !== null)
    .slice(0, 3)
  if (sources.length === 0) return null

  const status =
    typeof raw.status === 'string' && UNDERSTANDING_STATUSES.includes(raw.status as UnderstandingBlockStatus)
      ? (raw.status as UnderstandingBlockStatus)
      : 'pending'

  const materialVersion = asInteger(raw.materialVersion, 1, 1)
  const originalRaw = typeof raw.originalContent === 'string' ? raw.originalContent : raw.originalText

  return {
    // 旧数据可能只有服务端 itemId：本地 id 由 (materialId, kind, itemId) 稳定派生
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : understandingBlockKey(materialId, kind, itemId),
    itemId,
    kind,
    materialId,
    materialVersion,
    content,
    sources,
    status,
    originalContent: asString(originalRaw, content),
    createdAt: asString(raw.createdAt, nowIso),
    updatedAt: asString(raw.updatedAt, nowIso),
  }
}

/**
 * 迁移并归一化一个项目。
 * 返回 null 表示这条数据不可用，调用方直接丢弃（不能让半截数据进 store）。
 *
 * 迁移策略：
 *   - `schemaVersion` 高于当前版本 → 来自更新的代码，**返回 null**；
 *   - `schemaVersion` 缺失或低于当前版本 → 按当前结构补齐缺失字段（v1 → v2 → v3）；
 *   - 逐条记录归一化，坏记录丢弃、好记录保留，不会因为一条坏数据丢掉整个项目；
 *   - 迁移是幂等的：同一份数据迁移两次结果完全一致（v3 数据再跑一遍不改动任何字段）。
 */
export function migrateProject(raw: unknown): Project | null {
  if (!isPlainObject(raw)) return null

  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version > CURRENT_SCHEMA_VERSION) return null

  const projectId = typeof raw.projectId === 'string' && raw.projectId !== '' ? raw.projectId : null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (projectId === null || name === '') return null

  const nowIso = new Date().toISOString()
  const revision = typeof raw.projectRevision === 'number' && raw.projectRevision >= 1
    ? Math.floor(raw.projectRevision)
    : 1

  const project = raw as unknown as Project

  /* ---- v2 / v3：材料（契约 14） ---- */

  // 同一 materialId 只保留最新版本一条：旧数据里可能出现多版本并存
  const materialRecords: Material[] = []
  for (const item of asArray(raw.materialRecords)) {
    const material = normalizeMaterial(item, projectId, nowIso)
    if (material === null) continue
    const index = materialRecords.findIndex((entry) => entry.materialId === material.materialId)
    if (index === -1) {
      materialRecords.push(material)
      continue
    }
    if (material.version > materialRecords[index].version) materialRecords[index] = material
  }

  // v1 的占位材料转成「仅登记」记录（v3 数据里已存在同 id，不会重复添加）
  materialRecords.push(...legacyMaterialsOf(raw, projectId, nowIso, materialRecords))

  const materialSegments = collectSegments(raw, materialRecords)

  // 片段数决定「是否要重新上传」：没有片段的材料无法生成理解草稿
  const segmentCountByMaterial = new Map<string, number>()
  for (const segment of materialSegments) {
    segmentCountByMaterial.set(
      segment.materialId,
      (segmentCountByMaterial.get(segment.materialId) ?? 0) + 1,
    )
  }
  const materials = materialRecords.map((material) => ({
    ...material,
    needsReupload: materialNeedsReupload(
      material,
      segmentCountByMaterial.get(material.materialId) ?? 0,
    ),
  }))

  // 契约 14.5 第 4 条：材料过期（已删或已升版）的草稿引用一律作废
  const understandingBlocks = asArray(raw.understandingBlocks ?? raw.understandingItems)
    .map((item) => normalizeUnderstandingBlock(item, nowIso))
    .filter((item): item is UnderstandingBlock => {
      if (item === null) return false
      const material = materials.find((entry) => entry.materialId === item.materialId)
      return material !== undefined && material.version === item.materialVersion
    })

  return {
    ...project,
    projectId,
    name,
    short: asString(raw.short, name),
    group: asString(raw.group, ''),
    members: asString(raw.members, ''),
    updated: asString(raw.updated, ''),
    banner: asString(raw.banner, ''),
    projectRevision: revision,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ms: asArray(raw.ms) as Project['ms'],
    papers: asArray(raw.papers) as Project['papers'],
    weekly: asNumberArray(raw.weekly, [0, 0, 0, 0]),
    materials: asArray(raw.materials) as Project['materials'],
    chat: asArray(raw.chat) as Project['chat'],
    aiPapers: asArray(raw.aiPapers) as Project['aiPapers'],
    tasks: asArray(raw.tasks)
      .map((item) => normalizeTask(item, projectId, nowIso))
      .filter((item): item is Task => item !== null),
    evidenceRecords: asArray(raw.evidenceRecords)
      .map((item) => normalizeEvidence(item, projectId, nowIso))
      .filter((item): item is Evidence => item !== null),
    doubtRecords: asArray(raw.doubtRecords)
      .map((item) => normalizeDoubt(item, projectId, nowIso))
      .filter((item): item is Doubt => item !== null),
    // v1 项目没有这些字段：全部补默认值，缺失的只是空，不是 undefined
    profile: normalizeProjectProfile(raw.profile),
    materialRecords: materials,
    materialSegments,
    understandingBlocks,
    // 下面三个是兼容投影，读进来后由 store 的 syncProjectView 重建
    steps: [],
    evidence: [],
    doubts: [],
  }
}

/* ---------------------------------------------------------------------- 读 */

/**
 * 取出项目数组。返回 null 表示这份数据不能用，调用方会直接清空。
 * 外层信封的 `schemaVersion` 高于当前版本时同样判为不可用——那是更新版本的代码写的，
 * 当前版本无法安全解析。
 */
function extractProjectList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!isPlainObject(parsed)) return null
  if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return null
  }
  if (Array.isArray(parsed.projects)) return parsed.projects
  return null
}

function readCurrentProjectId(): string | null {
  const raw = readRaw(STORAGE_KEY_CURRENT_PROJECT_ID)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'string' && parsed !== '' ? parsed : null
  } catch {
    return null
  }
}

/** 刷新恢复：读不到、读坏了就返回空状态，并把坏数据清掉 */
export function loadPersistedState(): PersistedState {
  const raw = readRaw(STORAGE_KEY_PROJECTS)
  if (raw === null) return { projects: [], currentProjectId: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearPersistedState()
    return { projects: [], currentProjectId: null }
  }

  const list = extractProjectList(parsed)
  if (list === null) {
    clearPersistedState()
    return { projects: [], currentProjectId: null }
  }

  const projects: Project[] = []
  for (const item of list) {
    const migrated = migrateProject(item)
    if (migrated !== null) projects.push(migrated)
  }

  // 当前项目 id 指向的项目已经不存在时，回退到第一个；没有项目则为空
  const storedId = readCurrentProjectId()
  const currentProjectId =
    storedId !== null && projects.some((item) => item.projectId === storedId)
      ? storedId
      : (projects[0]?.projectId ?? null)

  return { projects, currentProjectId }
}

/* ---------------------------------------------------------------------- 写 */

/** 保存项目列表与当前项目。写入失败返回 `STORAGE_FULL` */
export function savePersistedState(projects: Project[], currentProjectId: string | null): SaveResult {
  const storage = getStorage()
  if (storage === null) {
    return { ok: false, code: 'STORAGE_FULL', message: '本地存储不可用，改动没有保存' }
  }

  const envelope: ProjectsEnvelope = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    // 只序列化状态字段；投影字段由读取后重建，不占存储
    projects: projects.map((project) => ({
      ...project,
      steps: [],
      evidence: [],
      doubts: [],
    })),
  }

  try {
    storage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(envelope))
    storage.setItem(STORAGE_KEY_CURRENT_PROJECT_ID, JSON.stringify(currentProjectId))
    return { ok: true }
  } catch {
    return { ok: false, code: 'STORAGE_FULL', message: '本地存储已满，改动没有保存' }
  }
}

/** 清空本地状态。只在数据损坏或用户主动重置时使用 */
export function clearPersistedState(): void {
  const storage = getStorage()
  if (storage === null) return
  try {
    storage.removeItem(STORAGE_KEY_PROJECTS)
    storage.removeItem(STORAGE_KEY_CURRENT_PROJECT_ID)
  } catch {
    // 清不掉也不影响内存态，忽略
  }
}
