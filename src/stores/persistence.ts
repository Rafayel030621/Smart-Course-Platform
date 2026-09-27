import type { Doubt, Evidence, Project, Task } from '@/types/platform'
import { PROJECT_SCHEMA_VERSION } from '@/types/platform'

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

/**
 * 迁移并归一化一个项目。
 * 返回 null 表示这条数据不可用，调用方直接丢弃（不能让半截数据进 store）。
 *
 * 迁移策略：
 *   - `schemaVersion` 高于当前版本 → 来自更新的代码，**返回 null**；
 *   - `schemaVersion` 缺失或低于当前版本 → 按当前结构补齐缺失字段（本轮只有 v1）；
 *   - 逐条记录归一化，坏记录丢弃、好记录保留，不会因为一条坏数据丢掉整个项目。
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
