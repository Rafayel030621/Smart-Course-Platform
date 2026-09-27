import type { Doubt, Evidence, EvidenceItem, Project } from '@/types/platform'
import type { DoubtSnapshot, EvidenceSnapshot } from '@/domain/recommendation'

/**
 * 活跃度与时间计算（纯函数）
 * ----------------------------------------------------------------------------
 * 证据与疑问现在直接读结构化模型（`Project.evidenceRecords` / `Project.doubtRecords`）：
 *
 *   - 快照用真实 `evidenceId` / `submissionId` / `taskId` / `doubtId`；
 *   - 时间字段保存 ISO 字符串，展示格式化在投影里做，不再硬编码「09-23」；
 *   - 证据按 `createdAt` 倒序，最多发最近 30 条（契约 4.1）；
 *   - 疑问只发 `status === 'open'` 的（契约 4.1 / 9-14）。
 *
 * `Project.evidence`（EvidenceItem[]）与 `Project.doubts`（string[]）是给旧页面的
 * **只读投影**，由本文件的 `deriveEvidenceViews` / `deriveDoubtTexts` 重建。
 */

/** 契约 4.1：证据最多发最近 30 条 */
export const MAX_EVIDENCE_SNAPSHOTS = 30
/** 契约 4.1：疑问最多发 30 条 */
export const MAX_DOUBT_SNAPSHOTS = 30

/* ------------------------------------------------------------------ 工具 */

/** 安全读取证据数组 */
export function evidencesOf(project: Project): Evidence[] {
  return Array.isArray(project.evidenceRecords) ? project.evidenceRecords : []
}

/** 安全读取疑问数组 */
export function doubtsOf(project: Project): Doubt[] {
  return Array.isArray(project.doubtRecords) ? project.doubtRecords : []
}

function normalizeNullable(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

/** 解析不出时间时按 0 处理，保证排序稳定 */
function timestampOf(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** 时间倒序：最新的排在最前 */
function byCreatedAtDesc<T extends { createdAt: string }>(a: T, b: T): number {
  return timestampOf(b.createdAt) - timestampOf(a.createdAt)
}

/** ISO → `MM-DD HH:mm`（本地时区）。旧页面的时间线直接读这个字符串 */
export function toDisplayTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* ---------------------------------------------------------------- 请求快照 */

/**
 * 契约 4.1：EvidenceSnapshot 数组。
 * 按 `createdAt` 倒序取最近 `MAX_EVIDENCE_SNAPSHOTS` 条，ID 全部来自本项目。
 */
export function deriveEvidenceSnapshots(project: Project, reference: Date): EvidenceSnapshot[] {
  const fallbackIso = reference.toISOString()

  return [...evidencesOf(project)]
    .sort(byCreatedAtDesc)
    .slice(0, MAX_EVIDENCE_SNAPSHOTS)
    .map((item) => ({
      evidenceId: item.id,
      submissionId: item.submissionId,
      taskId: normalizeNullable(item.taskId),
      didWhat: item.didWhat,
      foundWhat: normalizeNullable(item.foundWhat),
      stillUnsure: normalizeNullable(item.stillUnsure),
      author: normalizeNullable(item.author),
      createdAt: isValidIso(item.createdAt) ? item.createdAt : fallbackIso,
    }))
}

/** 契约 4.1：只发 `status === 'open'` 的疑问 */
export function deriveDoubtSnapshots(project: Project, reference: Date): DoubtSnapshot[] {
  const fallbackIso = reference.toISOString()

  return doubtsOf(project)
    .filter((item) => item.status === 'open')
    .slice(0, MAX_DOUBT_SNAPSHOTS)
    .map((item) => ({
      doubtId: item.id,
      text: item.text,
      status: item.status,
      sourceEvidenceId: normalizeNullable(item.sourceEvidenceId),
      createdAt: isValidIso(item.createdAt) ? item.createdAt : fallbackIso,
    }))
}

/* ---------------------------------------------------------------- 旧页面投影 */

/** 一条证据拼成旧时间线用的文本：`【任务名】完成了什么；发现：…；待定：…；附件：…` */
export function composeEvidenceText(project: Project, evidence: Evidence): string {
  const task =
    evidence.taskId === null
      ? undefined
      : (project.tasks ?? []).find((item) => item.id === evidence.taskId)
  const label = task === undefined ? '其他进展' : task.title

  const parts = [evidence.didWhat]
  const foundWhat = normalizeNullable(evidence.foundWhat)
  const stillUnsure = normalizeNullable(evidence.stillUnsure)
  const attachmentName = normalizeNullable(evidence.attachmentName)
  if (foundWhat !== null) parts.push(`发现：${foundWhat}`)
  if (stillUnsure !== null) parts.push(`待定：${stillUnsure}`)
  if (attachmentName !== null) parts.push(`附件：${attachmentName}`)

  return `【${label}】${parts.join('；')}`
}

/** `Project.evidence` 的兼容投影：按时间倒序，最新的在最前 */
export function deriveEvidenceViews(project: Project): EvidenceItem[] {
  return [...evidencesOf(project)]
    .sort(byCreatedAtDesc)
    .map((item) => ({
      time: toDisplayTime(item.createdAt),
      text: composeEvidenceText(project, item),
      who: normalizeNullable(item.author) ?? '我 · 刚提交',
    }))
}

/** `Project.doubts` 的兼容投影：只保留未解决疑问的文本，顺序与 `openDoubts` 一致 */
export function deriveDoubtTexts(project: Project): string[] {
  return doubtsOf(project)
    .filter((item) => item.status === 'open')
    .map((item) => item.text)
}

function isValidIso(value: string | null | undefined): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}
