import type { Milestone, NewTaskDraft, Project, SuggestedStep, Task } from '@/types/platform'
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
 *
 * `mat` 是 v2 新增的材料前缀（契约 14.1，前端生成）；`ublk` 是理解草稿条目的
 * **本地**前缀——服务端的 `itemId` 只在单次响应内唯一，本地还需要一个项目内唯一的
 * 稳定 id（契约 14.3）。
 */
export function createId(prefix: 'prj' | 'tsk' | 'evd' | 'dbt' | 'mat' | 'ublk'): string {
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

function isBlankText(value: string | null | undefined): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

/**
 * 契约 3.2 约束 4：同一项目内字段完全相同的 `draft` 重复提交必须幂等。
 *
 * 用规范化后的 draft 内容生成稳定键：字段顺序固定、ID 数组排序后再参与拼接，
 * 因此「同一组引用、书写顺序不同」也会命中同一条任务；
 * 标题、完成标志、来源请求与两组依据任一不同都会生成不同的键，不会误合并不同任务。
 *
 * **输入是纯数据**，所以 domain 层与 store 层用的是同一份实现（只有一处规则）。
 */
export function draftKeyOf(draft: NewTaskDraft): string {
  const normalizeIds = (value: string[] | null | undefined): string[] => {
    if (!Array.isArray(value)) return []
    return value.map((item) => String(item)).sort()
  }

  return JSON.stringify([
    draft.title.trim(),
    isBlankText(draft.doneCriteria) ? null : (draft.doneCriteria as string).trim(),
    isBlankText(draft.requestId) ? null : draft.requestId,
    normalizeIds(draft.basisEvidenceIds),
    normalizeIds(draft.basisDoubtIds),
  ])
}

/**
 * 「这条建议是否已经认领」的判断依据。
 *
 * 只用两种稳定标识，**不用数组下标**（任务顺序会随插入变化）：
 *   1. 建议自带 `existingTaskId` → 直接在项目任务里按 id 找，任务已进入项目（doing / done）即算已认领；
 *   2. `existingTaskId === null` 的候选建议 → 用 `draftKeyOf` 生成幂等键，
 *      在项目任务里找同键的 draft 任务。
 *
 * 兜底规则：重新获取建议后 `requestId` 会变（draftKey 随之变化），AI 也可能给出同标题的
 * 新候选建议。因此最后再按标题匹配一次：**同标题且已经进入项目（doing / done）** 就算已认领。
 * 宁可提示「已认领」，也不要在项目里凭空多出一条同名任务。
 * 还没认领（todo）的同名任务不在此列——那种情况仍应显示可认领。
 */
export interface ClaimCandidate {
  existingTaskId: string | null
  title: string
  doneCriteria: string | null
  requestId: string | null
  basisEvidenceIds: string[]
  basisDoubtIds: string[]
}

/** 建议对应的「已认领任务」；返回 null 表示这条建议还没进入项目 */
export function findClaimedTaskFor(project: Project, suggestion: ClaimCandidate): Task | null {
  const tasks = tasksOf(project)

  if (suggestion.existingTaskId !== null) {
    const task = tasks.find((item) => item.id === suggestion.existingTaskId)
    return task !== undefined && task.status !== 'todo' ? task : null
  }

  const key = draftKeyOf({
    title: suggestion.title,
    doneCriteria: suggestion.doneCriteria ?? '',
    requestId: suggestion.requestId,
    basisEvidenceIds: suggestion.basisEvidenceIds,
    basisDoubtIds: suggestion.basisDoubtIds,
  })
  const byKey = tasks.find((item) => item.draftKey === key)
  if (byKey !== undefined) return byKey.status === 'todo' ? null : byKey

  const title = suggestion.title.trim()
  if (title === '') return null

  const byTitle = tasks.find((item) => item.title.trim() === title && item.status !== 'todo')
  return byTitle ?? null
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
 * `Project.steps` 的兼容投影：中栏「AI 项目顾问」步骤卡与项目地图仍在读它。
 * 顺序与 `tasks` 一致，新任务追加在末尾。
 *
 * 除了展示文案，还带上 `taskId` 与 `status`：
 * 页面据此显示「进行中 / 未开始 / 已完成」，并按 taskId 认领或提问——不使用数组下标。
 */
export function deriveStepViews(project: Project): SuggestedStep[] {
  return tasksOf(project).map((task) => ({
    t: task.title,
    // 只取展示字段：契约 2.2 的 owner 本轮恒为 null，不能拿它做展示
    owner: normalizeNullable(task.suggestedOwner) ?? '待定',
    why: normalizeNullable(task.why) ?? '',
    done: normalizeNullable(task.doneCriteria) ?? '',
    taskId: task.id,
    status: task.status,
  }))
}

/** 任务状态 → 界面上的人话（进行中 / 未开始 / 已完成） */
export function taskStatusText(status: Task['status'] | undefined): string {
  if (status === 'doing') return '进行中'
  if (status === 'done') return '已完成'
  return '未开始'
}

/**
 * 里程碑状态 → 界面上的人话。
 * 注意里程碑用的是 `cur`（进行中），与任务的 `doing` 不同，不能复用 taskStatusText。
 */
export function milestoneStatusText(status: Project['ms'][number]['s'] | undefined): string {
  if (status === 'done') return '已完成'
  if (status === 'cur') return '进行中'
  return '未开始'
}
