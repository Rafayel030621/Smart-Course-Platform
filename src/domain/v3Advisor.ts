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
} from '@/domain/materials'
import type {
  ConfirmedMaterial,
  EvidenceSnapshot,
  MilestoneContext,
  MilestoneTaskSnapshot,
  ProgressSnapshot,
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
 * 额外门槛：
 * - 条目 status 必须是 confirmed；
 * - 材料必须存在且处于 parsed 状态；
 * - 条目版本必须是材料当前版本；
 * - 来源片段必须属于同一 materialId + version；
 * - 最多 3 份材料、20 条片段、8,000 字。
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
    const material = materialById.get(item.materialId)
    if (material === undefined || material.status !== 'parsed') continue
    if (material.version !== item.materialVersion) continue
    const key = `${item.materialId}@${item.materialVersion}`
    const set = referencedByMaterial.get(key) ?? new Set<string>()
    for (const segmentId of item.sourceSegmentIds) {
      const segment = segmentMap.get(`${key}:${segmentId}`)
      if (segment === undefined) continue
      set.add(segmentId)
    }
    referencedByMaterial.set(key, set)
  }

  const result: ConfirmedMaterial[] = []
  let totalSegments = 0
  let totalChars = 0

  const orderedMaterials = [...materials]
    .filter((material) => material.status === 'parsed' && material.type !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  for (const material of orderedMaterials) {
    if (result.length >= MAX_CONFIRMED_MATERIALS) break
    const referenced = referencedByMaterial.get(`${material.materialId}@${material.version}`)
    if (referenced === undefined || referenced.size === 0) continue

    const materialSegments: UnderstandingSegmentInput[] = []
    for (const segment of segments) {
      if (segment.materialId !== material.materialId) continue
      if (segment.materialVersion !== material.version) continue
      if (!referenced.has(segment.segmentId)) continue
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
      type: material.type,
      version: material.version,
      segments: materialSegments,
    })
  }

  return result
}
