/**
 * 云端项目 → 工作台只读视图
 * ----------------------------------------------------------------------------
 * 现有工作台组件（流程条、里程碑、项目地图、最近证据）读的是本地 `Project` 结构。
 * V3 接线不重做这些组件，只在这里把**服务端已确认**的云端数据映射成同形的只读视图：
 *
 * - 里程碑状态/进度直接取服务端 `taskStats`，不在前端按本地任务重算；
 * - 任务来自 cloud store 的 `refreshTasks`（契约 22.3，分页拉全）；未 hydrate 时为空数组，不伪造；
 * - 证据按服务端返回的 `active` 记录展示，红色已撤回记录不展示；
 * - 疑问、材料、聊天在 V3 store 里没有读取端点，这里保持空数组，不伪造内容。
 *
 * 该视图只用于展示，不能写回 cloud store，也不能交给本地 action 修改。
 */
import { deriveEvidenceViews } from '@/domain/activity'
import { normalizeProjectProfile } from '@/domain/materials'
import { deriveStepViews } from '@/domain/progress'
import type {
  CloudEvidence,
  CloudMilestone,
  CloudProject,
  CloudTask,
  Evidence,
  Milestone,
  Project,
  Task,
} from '@/types/platform'
import { PROJECT_SCHEMA_VERSION } from '@/types/platform'

function displayTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shortOf(project: CloudProject): string {
  const short = project.short?.trim() ?? ''
  if (short !== '') return short
  return [...project.name].slice(0, 8).join('')
}

function milestoneStatusOf(milestone: CloudMilestone): Milestone['s'] {
  if (milestone.status === 'completed') return 'done'
  if (milestone.status === 'active') return 'cur'
  return 'todo'
}

function milestoneSubOf(milestone: CloudMilestone): string {
  if (milestone.status === 'completed') return '已完成'
  if (milestone.status === 'active') {
    return milestone.taskStats.total > 0
      ? `${milestone.taskStats.done}/${milestone.taskStats.total} 任务`
      : '暂无任务'
  }
  return '未开始'
}

function toMilestoneView(milestone: CloudMilestone): Milestone {
  return {
    t: milestone.name,
    s: milestoneStatusOf(milestone),
    p: milestone.status === 'completed' ? 100 : milestone.taskStats.progress,
    sub: milestoneSubOf(milestone),
  }
}

function toTaskView(task: CloudTask): Task {
  return {
    id: task.taskId,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    doneCriteria: task.doneCriteria.trim() === '' ? null : task.doneCriteria,
    // 契约 2.2：V3 任务没有展示负责人字段，这里不编造
    owner: null,
    suggestedOwner: null,
    milestone: task.milestoneName,
    why: null,
    draftKey: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

function toEvidenceRecord(item: CloudEvidence): Evidence {
  return {
    id: item.evidenceId,
    projectId: item.projectId,
    submissionId: item.submissionId ?? '',
    taskId: item.taskId,
    didWhat: item.didWhat,
    foundWhat: item.foundWhat.trim() === '' ? null : item.foundWhat,
    stillUnsure: item.stillUnsure,
    attachmentName: item.attachmentName,
    // V3 证据没有作者展示字段
    author: null,
    createdAt: item.createdAt,
  }
}

/**
 * 把 cloud store 的当前项目映射成工作台可读的 `Project` 视图。
 * 传入的任务/证据必须是同一项目、已通过 store 归属校验的数据。
 */
export function toWorkbenchProjectView(
  project: CloudProject,
  tasks: CloudTask[],
  evidence: CloudEvidence[],
): Project {
  const activeMilestones = project.milestones
    .filter((item) => item.archivedAt === null)
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt))

  const activeTasks = tasks
    .filter((item) => item.projectId === project.projectId && item.archivedAt === null)
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.localeCompare(b.createdAt))

  const activeEvidence = evidence.filter(
    (item) => item.projectId === project.projectId && item.status === 'active',
  )

  const memberNames = project.profile.memberNames
  const stats = project.taskStats

  const view: Project = {
    projectId: project.projectId,
    name: project.name,
    short: shortOf(project),
    projectRevision: project.projectRevision,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    group: 'V3 云端项目',
    members: memberNames.length > 0 ? `${memberNames.length} 名成员` : '成员信息待完善',
    updated: `最近更新：${displayTime(project.updatedAt)}`,
    ms: activeMilestones.map(toMilestoneView),
    banner:
      stats.total > 0
        ? `云端项目：${activeMilestones.length} 个阶段，${stats.total} 个任务，已完成 ${stats.done} 个。`
        : `云端项目：${activeMilestones.length} 个阶段，暂无任务。`,
    papers: [],
    weekly: [0, 0, 0, 0],
    materials: [],
    chat: [],
    aiPapers: [],
    tasks: activeTasks.map(toTaskView),
    evidenceRecords: activeEvidence.map(toEvidenceRecord),
    doubtRecords: [],
    profile: normalizeProjectProfile(project.profile),
    materialRecords: [],
    materialSegments: [],
    understandingBlocks: [],
    // 下面三项由 derive* 投影重建，先占位
    steps: [],
    evidence: [],
    doubts: [],
  }

  view.steps = deriveStepViews(view)
  view.evidence = deriveEvidenceViews(view)
  return view
}
