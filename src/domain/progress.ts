import type { Milestone, Project, SuggestedStep, Task } from '@/types/platform'
import type { TaskSnapshot } from '@/domain/recommendation'

/**
 * 进度与任务状态（纯函数）
 * ----------------------------------------------------------------------------
 * 任务状态现在直接读结构化模型 `Project.tasks`（契约 2.2），不再从模板步骤反推：
 *
 *   - taskId 在任务创建时生成并持久化，不按数组下标派生；
 *   - status 由认领 / 确认完成两个动作改变；
 *   - 里程碑进度由该里程碑下**已完成**任务数量推导，认领不影响进度；
 *   - projectRevision 直接读 `Project.projectRevision`（契约 2.6 的递增整数）。
 *
 * 本文件另外负责把 `tasks` 投影成旧页面仍在读的 `steps`（SuggestedStep）。
 * 真实数据只有 `Project.tasks` 一份，`steps` 是只读视图。
 *
 * 全部是纯函数：不读系统时钟（时间由调用方传入）、不写任何状态
 * （`syncMilestones` 例外，它按约定就地更新传入的里程碑数组）。
 */

/** 契约 4.1：单次请求最多带 100 条任务（含已完成） */
export const MAX_TASK_SNAPSHOTS = 100

/* ------------------------------------------------------------------ ID 生成 */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const ID_TOKEN_LENGTH = 12

/**
 * 生成一段随机字符串。
 * 只用于生成不透明 ID：不参与任何安全判断，也不需要抗碰撞。
 */
function randomToken(length: number): string {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  let token = ''
  for (let index = 0; index < length; index += 1) {
    token += ID_ALPHABET[bytes[index] % ID_ALPHABET.length]
  }
  return token
}

/**
 * 契约 2 通用约定：`<前缀>_<可打印字符串>`，长度 ≤ 64。
 * ID 只在**创建时**生成一次并随项目一起持久化。
 */
export function createId(prefix: 'prj' | 'tsk' | 'evd' | 'dbt'): string {
  return `${prefix}_${randomToken(ID_TOKEN_LENGTH)}`
}

export function createProjectId(): string {
  return createId('prj')
}

export function createTaskId(): string {
  return createId('tsk')
}

export function createEvidenceId(): string {
  return createId('evd')
}

export function createDoubtId(): string {
  return createId('dbt')
}

/* ------------------------------------------------------------------ 读取器 */

/** 项目稳定 ID。旧内存态可能还没有该字段，此时回退到空串由调用方处理 */
export function deriveProjectId(project: Project): string {
  return typeof project.projectId === 'string' ? project.projectId : ''
}

/** 契约 2.6：projectRevision 是项目字段里的递增整数，不再是状态摘要 */
export function computeProjectRevision(project: Project): number {
  const revision = project.projectRevision
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 1 ? revision : 1
}

/** 当前里程碑：优先取进行中的，其次取第一个未完成的 */
export function currentMilestone(project: Project): Milestone | undefined {
  return project.ms.find((item) => item.s === 'cur') ?? project.ms.find((item) => item.s !== 'done')
}

/** 契约 4.1 的 currentMilestone 字段 */
export function currentMilestoneName(project: Project): string | null {
  return currentMilestone(project)?.t ?? null
}

/** 已经开始（doing 或 done）的任务数。旧页面用它估算「已认领几步」 */
export function claimedStepCount(project: Project): number {
  return tasksOf(project).filter((task) => task.status !== 'todo').length
}

/** 安全读取任务数组：持久化数据可能缺字段 */
export function tasksOf(project: Project): Task[] {
  return Array.isArray(project.tasks) ? project.tasks : []
}

function normalizeNullable(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

/* ---------------------------------------------------------------- 任务快照 */

/**
 * 契约 4.1 / 9-14：把**该项目全部任务**映射成快照，含已完成的。
 * 不发已完成任务，服务端就无法执行「已完成任务不得再推荐」。
 */
export function deriveTaskSnapshots(project: Project, reference: Date): TaskSnapshot[] {
  const fallbackIso = reference.toISOString()

  return tasksOf(project)
    .slice(0, MAX_TASK_SNAPSHOTS)
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      doneCriteria: normalizeNullable(task.doneCriteria),
      owner: normalizeNullable(task.owner),
      milestone: normalizeNullable(task.milestone),
      updatedAt: isValidIso(task.updatedAt) ? task.updatedAt : fallbackIso,
    }))
}

export function isValidIso(value: string | null | undefined): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/* -------------------------------------------------------------- 里程碑推导 */

/**
 * 按任务完成情况就地更新里程碑状态与进度。
 *
 * 规则：
 *   - 里程碑下没有任务 → 保持原样（模板里未开始的里程碑不受影响）；
 *   - 全部任务 done → 里程碑 done，进度 100；
 *   - 否则第一个未完成的里程碑是 cur，其余是 todo；
 *   - 进度 = 已完成数 / 该里程碑任务总数，**认领不增加进度**。
 */
export function syncMilestones(project: Project): void {
  const tasks = tasksOf(project)
  const milestones: Milestone[] = Array.isArray(project.ms) ? project.ms : []
  let currentAssigned = false

  for (const milestone of milestones) {
    const related = tasks.filter((task) => task.milestone === milestone.t)
    if (related.length === 0) continue

    const doneCount = related.filter((task) => task.status === 'done').length
    const progress = Math.round((doneCount / related.length) * 100)

    if (doneCount === related.length) {
      milestone.s = 'done'
      milestone.p = 100
      continue
    }

    milestone.s = currentAssigned ? 'todo' : 'cur'
    milestone.p = progress
    currentAssigned = true
  }

  // 所有任务都做完了、且没有未完成任务可标记时，保证仍然有一个「进行中」的里程碑，
  // 否则 `currentMilestoneName` 会取不到值
  if (!currentAssigned) {
    const next = milestones.find((item) => item.s !== 'done')
    if (next !== undefined) next.s = 'cur'
  }
}

/* ---------------------------------------------------------------- 旧页面投影 */

/**
 * `Project.steps` 的兼容投影：旧页面（中栏步骤卡、项目地图）仍在读它。
 * 顺序与 `tasks` 一致，新任务追加在末尾。
 */
export function deriveStepViews(project: Project): SuggestedStep[] {
  return tasksOf(project).map((task) => ({
    t: task.title,
    // 只取展示字段：契约 2.2 的 owner 本轮恒为 null，不能拿它做展示
    owner: normalizeNullable(task.suggestedOwner) ?? '待定',
    why: normalizeNullable(task.why) ?? '',
    done: normalizeNullable(task.doneCriteria) ?? '',
  }))
}
