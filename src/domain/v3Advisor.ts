/**
 * V3 阶段化建议/聊天上下文（契约 23.2 / 23.3）。
 *
 * 这里只做纯函数映射，不发请求：
 * - 只取**当前阶段**（planned / active）的任务、进展、证据；
 * - 已完成任务也保留，服务端据此避免重复推荐；
 * - 已完成/已归档阶段不作为当前阶段；
 * - 只把 `status === 'confirmed'` 且材料版本有效的理解条目转成 confirmedMaterials；
 *   pending / modified 永远不会进入可信上下文。
 */
import {
  MAX_CONFIRMED_MATERIALS,
  MAX_CONFIRMED_SEGMENTS,
  MAX_CONFIRMED_TOTAL_LENGTH,
  MATERIAL_TYPES,
} from '@/domain/materials'
import type {
  ConfirmedMaterial,
  EvidenceSnapshot,
  MilestoneContext,
  MilestoneTaskSnapshot,
  ProgressSnapshot,
  TaskSnapshot,
  UnderstandingSegmentInput,
} from '@/domain/recommendation'
import type {
  CloudEvidence,
  CloudMaterial,
  CloudMaterialSegment,
  CloudMilestone,
  CloudTask,
  CloudUnderstandingItem,
  ProgressRecord,
} from '@/types/platform'

export const MAX_MILESTONE_CONTEXT_TASKS = 50
export const MAX_MILESTONE_CONTEXT_PROGRESS = 20
export const MAX_MILESTONE_CONTEXT_EVIDENCE = 20

export interface MilestoneContextSource {
  projectId: string
  currentMilestoneId: string | null
  milestones: CloudMilestone[]
  tasks: CloudTask[]
  progress: ProgressRecord[]
  evidence: CloudEvidence[]
}

function clampText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null
  const text = value.trim()
  if (text === '') return null
  return [...text].length > max ? [...text].slice(0, max).join('') : text
}

function emptyContext(): MilestoneContext {
  return {
    milestoneId: null,
    currentMilestone: null,
    milestoneRevision: null,
    milestoneGoal: null,
    milestoneDoneCriteria: null,
    milestoneStatus: null,
    milestoneTasks: [],
    recentProgress: [],
    milestoneEvidence: [],
  }
}

/**
 * 构造 `milestoneContext`。空白项目返回全 null 的空上下文，
 * 不根据任务/证据反推一个“当前阶段”。
 */
export function buildMilestoneContext(source: MilestoneContextSource): MilestoneContext {
  const currentId = source.currentMilestoneId
  if (currentId === null) return emptyContext()

  const milestone = source.milestones.find((item) => item.milestoneId === currentId)
  if (milestone === undefined) return emptyContext()
  if (milestone.archivedAt !== null) return emptyContext()
  if (milestone.status !== 'planned' && milestone.status !== 'active') return emptyContext()

  const milestoneTasks: MilestoneTaskSnapshot[] = source.tasks
    .filter(
      (task) =>
        task.projectId === source.projectId &&
        task.milestoneId === currentId &&
        task.archivedAt === null,
    )
    .slice(0, MAX_MILESTONE_CONTEXT_TASKS)
    .map((task) => ({
      taskId: task.taskId,
      title: clampText(task.title, 60) ?? '',
      status: task.status,
      doneCriteria: clampText(task.doneCriteria, 200),
      owner: null,
      milestone: clampText(task.milestoneName ?? milestone.name, 60),
      updatedAt: task.updatedAt,
    }))

  const recentProgress: ProgressSnapshot[] = source.progress
    .filter((item) => item.milestoneId === currentId && item.status === 'active')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, MAX_MILESTONE_CONTEXT_PROGRESS)
    .map((item) => ({
      progressId: item.progressId,
      summary: clampText(item.summary, 1_000) ?? '',
      milestoneId: item.milestoneId,
      taskId: item.taskId,
      occurredAt: item.occurredAt,
    }))

  const milestoneEvidence: EvidenceSnapshot[] = source.evidence
    .filter(
      (item) =>
        item.projectId === source.projectId &&
        item.milestoneId === currentId &&
        item.status === 'active',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_MILESTONE_CONTEXT_EVIDENCE)
    .map((item) => ({
      evidenceId: item.evidenceId,
      submissionId: item.submissionId ?? '',
      taskId: item.taskId,
      didWhat: clampText(item.didWhat, 300) ?? '',
      foundWhat: clampText(item.foundWhat, 500),
      stillUnsure: clampText(item.stillUnsure, 500),
      author: null,
      createdAt: item.createdAt,
    }))

  return {
    milestoneId: milestone.milestoneId,
    currentMilestone: clampText(milestone.name, 60),
    milestoneRevision: milestone.revision,
    milestoneGoal: clampText(milestone.goal, 300),
    milestoneDoneCriteria: clampText(milestone.doneCriteria, 300),
    milestoneStatus: milestone.status,
    milestoneTasks,
    recentProgress,
    milestoneEvidence,
  }
}

/**
 * 契约 23.3：只把已确认的理解条目转成请求材料。
 *
 * 额外门槛（任何一条不满足就不进上下文）：
 * - 条目 status 必须是 confirmed（pending / modified / archived 一律不发）；
 * - 条目引用的材料必须存在且处于 parsed 状态，且是**当前版本**（`isCurrent`）；
 * - 条目来源的 `materialVersion` 必须等于材料当前版本，片段必须属于同一 materialId + version；
 * - 只发 md/txt（上传白名单）；迁移来的 csv/xlsx/pdf/docx 材料不进 AI 上下文；
 * - 最多 3 份材料、20 条片段、8,000 字。
 *
 * 服务端目前**不做**二次复核（contract 23.3 的 v3 门禁未实现），所以这段过滤是唯一的护栏。
 */
export function selectConfirmedMaterials(
  items: CloudUnderstandingItem[],
  segments: CloudMaterialSegment[],
  materials: CloudMaterial[],
): ConfirmedMaterial[] {
  const materialById = new Map(materials.map((item) => [item.materialId, item]))
  const segmentMap = new Map<string, CloudMaterialSegment>()
  for (const segment of segments) {
    segmentMap.set(`${segment.materialId}@${segment.materialVersion}:${segment.segmentId}`, segment)
  }

  const referencedByMaterial = new Map<string, Set<string>>()
  for (const item of items) {
    if (item.status !== 'confirmed') continue
    for (const source of item.sources) {
      const material = materialById.get(source.materialId)
      if (material === undefined) continue
      if (material.status !== 'parsed' || !material.isCurrent) continue
      if (material.materialVersion !== source.materialVersion) continue
      if (!isConfirmedMaterialType(material.type)) continue
      const key = `${source.materialId}@${source.materialVersion}`
      const segment = segmentMap.get(`${key}:${source.segmentId}`)
      if (segment === undefined) continue
      const set = referencedByMaterial.get(key) ?? new Set<string>()
      set.add(source.segmentId)
      referencedByMaterial.set(key, set)
    }
  }

  const result: ConfirmedMaterial[] = []
  let totalSegments = 0
  let totalChars = 0

  const orderedMaterials = [...materials]
    .filter((material) => material.status === 'parsed' && material.isCurrent && isConfirmedMaterialType(material.type))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  for (const material of orderedMaterials) {
    if (result.length >= MAX_CONFIRMED_MATERIALS) break
    const referenced = referencedByMaterial.get(`${material.materialId}@${material.materialVersion}`)
    if (referenced === undefined || referenced.size === 0) continue

    const materialSegments: UnderstandingSegmentInput[] = []
    const ordered = segments
      .filter(
        (segment) =>
          segment.materialId === material.materialId &&
          segment.materialVersion === material.materialVersion &&
          referenced.has(segment.segmentId),
      )
      .sort((a, b) => a.index - b.index)
    for (const segment of ordered) {
      if (totalSegments >= MAX_CONFIRMED_SEGMENTS) break
      if (totalChars + segment.text.length > MAX_CONFIRMED_TOTAL_LENGTH) break
      totalSegments += 1
      totalChars += segment.text.length
      materialSegments.push({
        segmentId: segment.segmentId,
        startLine: segment.startLine,
        endLine: segment.endLine,
        text: segment.text,
      })
    }

    if (materialSegments.length === 0) continue
    result.push({
      materialId: material.materialId,
      name: material.name,
      type: material.type as ConfirmedMaterial['type'],
      version: material.materialVersion,
      segments: materialSegments,
    })
  }

  return result
}

function isConfirmedMaterialType(type: string): boolean {
  return (MATERIAL_TYPES as readonly string[]).includes(type)
}

/* ------------------------------------------------ 建议 / 聊天请求快照 */

/** 契约 4.1：顶层 `tasks` 与阶段上下文一致，包含已完成任务，排除归档任务 */
export function buildTaskSnapshots(tasks: CloudTask[], projectId: string): TaskSnapshot[] {
  return tasks
    .filter((task) => task.projectId === projectId && task.archivedAt === null)
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt))
    .slice(0, MAX_MILESTONE_CONTEXT_TASKS)
    .map((task) => ({
      taskId: task.taskId,
      title: clampText(task.title, 60) ?? '',
      status: task.status,
      doneCriteria: clampText(task.doneCriteria, 200),
      owner: null,
      milestone: clampText(task.milestoneName, 60),
      updatedAt: task.updatedAt,
    }))
}

/** 契约 4.1：顶层 `evidence` 只发 active 记录，按 createdAt 倒序 */
export function buildEvidenceSnapshots(evidence: CloudEvidence[], projectId: string): EvidenceSnapshot[] {
  return evidence
    .filter((item) => item.projectId === projectId && item.status === 'active')
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_MILESTONE_CONTEXT_EVIDENCE)
    .map((item) => ({
      evidenceId: item.evidenceId,
      submissionId: item.submissionId ?? '',
      taskId: item.taskId,
      didWhat: clampText(item.didWhat, 300) ?? '',
      foundWhat: clampText(item.foundWhat, 500),
      stillUnsure: clampText(item.stillUnsure, 500),
      author: null,
      createdAt: item.createdAt,
    }))
}

/** 契约 23.2：`milestoneContext` 与顶层 `currentMilestone` 必须一致（两者都非空时） */
export function milestoneContextTitle(context: MilestoneContext): string | null {
  return context.currentMilestone
}
