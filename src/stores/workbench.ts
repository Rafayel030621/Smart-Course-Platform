import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  Doubt,
  Evidence,
  MaterialType,
  NewTaskDraft,
  Project,
  Task,
  Template,
} from '@/types/platform'
import { PROJECT_SCHEMA_VERSION } from '@/types/platform'
import { TEMPLATES, TOPICS } from '@/data/topics'
// 论文方向只从这一个入口取：现在返回模板预置内容，接入后端后换实现即可，页面无需改动
import { generateDirection, genericDirections, presetDirections } from '@/services/papers'
// 建议请求：适配层负责 HTTP 与契约校验，mvpFallbacks 负责后端不可用时的本地兜底
import {
  buildAdvisorRequest,
  createRequestId,
  fetchRecommendations,
  isStaleResponseError,
  shouldFallbackToLocalRule,
  toRecommendations,
} from '@/services/advisorApi'
import { buildLocalRecommendations } from '@/data/mvpFallbacks'
import {
  deriveDoubtSnapshots,
  deriveDoubtTexts,
  deriveEvidenceSnapshots,
  deriveEvidenceViews,
} from '@/domain/activity'
import {
  computeProjectRevision,
  createDoubtId,
  createEvidenceId,
  createProjectId,
  createTaskId,
  currentMilestoneName,
  deriveStepViews,
  deriveTaskSnapshots,
  syncMilestones,
} from '@/domain/progress'
import type {
  ActionResult,
  AdvisorApiError,
  AdvisorFallbackReason,
  AdvisorOutcome,
  ClaimTaskInput,
  ClaimTaskResult,
  CreateProjectInput,
  CreateProjectResult,
  LegacyCreateProjectInput,
  LegacyEvidenceInput,
  Recommendation,
  RecommendationSource,
  ResolveDoubtResult,
  SelectProjectResult,
  SubmitEvidenceInput,
  SubmitEvidenceResult,
} from '@/domain/recommendation'
import {
  MAX_EVIDENCE_DID_WHAT_LENGTH,
  MAX_EVIDENCE_FOUND_WHAT_LENGTH,
  MAX_EVIDENCE_UNSURE_LENGTH,
  localFailure,
} from '@/domain/recommendation'
import { loadPersistedState, savePersistedState } from '@/stores/persistence'

/** 近 4 周的时间标签，与 mockup 一致 */
export const WEEK_LABELS = ['8.31-9.6', '9.7-9.13', '9.14-9.20', '9.21-9.27']

/** 中文序号，用于里程碑编号 */
export const CHINESE_NUM = ['①', '②', '③', '④', '⑤', '⑥']

/** 答疑模式下的回复池：给方向，不给答案 */
const AI_REPLIES = [
  '项目刚启动，建议先按推荐的步骤走——完成任何一步后记得提交证据，我会据此更新状态并给出下一步。',
  '这个问题可以先用「论文推荐」页的检索提示词查一查，把文献结论带回组内讨论，调研结论本身就是很好的第一条证据。',
  '我不直接给答案，但提示一个方向：先想清楚这个问题影响哪个里程碑的决策——如果影响启动方向就值得现在花时间；如果只是细节，先记下来往前走。',
  '如果想深入了解某个具体方向，可以去「论文推荐」页让 AI 生成针对性的检索提示词。',
]

/** 建议请求的状态机（契约 5.3） */
export type AiStatus = 'idle' | 'loading' | 'model' | 'fallback' | 'local-rule' | 'error'

/**
 * 单个项目的建议状态。
 * 按项目分开存：切换项目时天然隔离，旧响应不会串写到新项目。
 * 只在内存里——建议是「上一次请求的结果」，不需要持久化。
 */
interface AdvisorState {
  status: AiStatus
  suggestions: Recommendation[]
  /** 失败原因，留给界面层映射文案；不要把技术错误直接当成用户文案 */
  error: AdvisorApiError | null
  /** 这批建议对应的请求与项目版本 */
  requestId: string | null
  projectRevision: number
  cached: boolean
  fallbackReason: AdvisorFallbackReason | null
}

function emptyAdvisorState(): AdvisorState {
  return {
    status: 'idle',
    suggestions: [],
    error: null,
    requestId: null,
    projectRevision: 0,
    cached: false,
    fallbackReason: null,
  }
}

/* ------------------------------------------------------------------ 工具 */

function nowIso(): string {
  return new Date().toISOString()
}

function isBlank(value: string | null | undefined): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

function normalizeNullable(value: string | null | undefined): string | null {
  return isBlank(value) ? null : (value as string).trim()
}

/**
 * 把真实状态（`tasks` / `evidenceRecords` / `doubtRecords`）投影成旧页面读的字段。
 * 每次本地写入成功后调用：**真实数据只有一份**，这三个数组永远是派生结果。
 */
function syncProjectView(project: Project): void {
  if (!Array.isArray(project.tasks)) project.tasks = []
  if (!Array.isArray(project.evidenceRecords)) project.evidenceRecords = []
  if (!Array.isArray(project.doubtRecords)) project.doubtRecords = []

  syncMilestones(project)
  project.steps = deriveStepViews(project)
  project.evidence = deriveEvidenceViews(project)
  project.doubts = deriveDoubtTexts(project)
}

/**
 * 工作台状态
 * ----------------------------------------------------------------------------
 * 多项目：可以创建多个项目并在左栏切换。数据保存在 localStorage，刷新后恢复。
 *
 * 结构（契约 2）：
 *   - 真实状态：`Project.tasks` / `evidenceRecords` / `doubtRecords`
 *   - 兼容投影：`Project.steps` / `evidence` / `doubts`（只读，由 syncProjectView 重建）
 */
export const useWorkbenchStore = defineStore('workbench', () => {
  const restored = loadPersistedState()

  const projects = ref<Project[]>(restored.projects)
  const curIdx = ref(-1)
  /** 是否停在「创建项目」界面 */
  const creating = ref(true)
  const toastText = ref('')
  const toastVisible = ref(false)

  // 恢复上次选中的项目；没有就落在第一个
  for (const project of projects.value) syncProjectView(project)
  if (restored.currentProjectId !== null) {
    const index = projects.value.findIndex((item) => item.projectId === restored.currentProjectId)
    curIdx.value = index >= 0 ? index : (projects.value.length > 0 ? 0 : -1)
  } else if (projects.value.length > 0) {
    curIdx.value = 0
  }
  creating.value = projects.value.length === 0

  let toastTimer: number | undefined
  let replyIdx = 0

  const current = computed<Project | undefined>(() =>
    curIdx.value >= 0 ? projects.value[curIdx.value] : undefined,
  )
  const hasProject = computed(() => Boolean(current.value))

  /* ------------------------------------------------------------ 建议状态 */

  /** 每个项目一份建议状态，key 是 projectId */
  const advisorByProject = ref<Record<string, AdvisorState>>({})
  /** 在途请求序号：只有最后一次请求的响应才允许写入 */
  let inFlightToken = 0
  /** 在途请求的控制器：新请求会取消上一次（契约 4.7 第 4 条） */
  let inFlightAbort: AbortController | null = null

  /** 当前项目的 projectId */
  const currentProjectId = computed<string | null>(() => current.value?.projectId ?? null)

  /** 当前项目的建议状态；没有项目或还没请求过时是空状态 */
  const advisor = computed<AdvisorState>(() => {
    const projectId = currentProjectId.value
    if (projectId === null) return emptyAdvisorState()
    return advisorByProject.value[projectId] ?? emptyAdvisorState()
  })

  /** 页面直接用的三个读法：状态 / 建议列表 / 失败原因 */
  const aiStatus = computed<AiStatus>(() => advisor.value.status)
  const recommendations = computed<Recommendation[]>(() => advisor.value.suggestions)
  const aiError = computed<AdvisorApiError | null>(() => advisor.value.error)

  /** 只替换目标项目的那一份状态，不碰其他项目 */
  function patchAdvisor(projectId: string, patch: Partial<AdvisorState>): void {
    const previous = advisorByProject.value[projectId] ?? emptyAdvisorState()
    advisorByProject.value = {
      ...advisorByProject.value,
      [projectId]: { ...previous, ...patch },
    }
  }

  /* ------------------------------------------------------------ 提示条 */

  function toast(message: string) {
    toastText.value = message
    toastVisible.value = true
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (toastVisible.value = false), 2600)
  }

  /* ---------------------------------------------------------------- 持久化 */

  /** 当前选中项目的 id；没有项目时为 null */
  function persistedCurrentProjectId(): string | null {
    return currentProjectId.value
  }

  /**
   * 写入 localStorage。
   * 返回 false 表示存储不可用或已满（契约 3.3 的 `STORAGE_FULL`）。
   */
  function persist(): boolean {
    const result = savePersistedState(projects.value, persistedCurrentProjectId())
    return result.ok
  }

  /**
   * 先改内存再落盘；落盘失败就整体回滚，避免出现「内存里有、刷新后没了」的半截状态。
   * 变更函数里可以调用 `bumpRevision`。
   */
  type CommitResult = { ok: true } | { ok: false; code: 'STORAGE_FULL'; message: string }

  function commit(project: Project, mutate: () => void): CommitResult {
    const snapshot = JSON.parse(JSON.stringify(project)) as Project

    mutate()
    syncProjectView(project)

    if (!persist()) {
      // 回滚：把快照的字段拷回同一个对象，保持响应性
      Object.assign(project, snapshot)
      return { ok: false, code: 'STORAGE_FULL', message: '本地存储空间不足，改动没有保存' }
    }

    return { ok: true }
  }

  /* ---------------------------------------------------------- 创建项目 */

  function showCreate() {
    creating.value = true
    window.scrollTo(0, 0)
  }

  /** 自定义题目的通用模板，字段与 mockup 一致，名称按输入插值 */
  function customTemplate(name: string): Template {
    return {
      short: name.length > 8 ? `${name.slice(0, 8)}…` : name,
      ms: [
        { t: '选题确认与文献调研', s: 'cur', p: 10, sub: '刚启动' },
        { t: '数据获取与预处理', s: 'todo', p: 0, sub: '未开始' },
        { t: '核心方法 / 模型实现', s: 'todo', p: 0, sub: '未开始' },
        { t: '分析与验证', s: 'todo', p: 0, sub: '未开始' },
        { t: '系统集成与结题报告', s: 'todo', p: 0, sub: '未开始' },
      ],
      doubts: ['项目的具体范围和技术路线还没有和指导老师确认'],
      banner:
        '项目刚启动。建议先把三件事定下来：研究目标的一句话描述、主流方法的文献调研、数据或工具的可获取性验证。上传实验手册后，我可以按手册要求进一步细化步骤。',
      steps: [
        {
          t: '用一句话写清项目目标与预期产出',
          owner: '成员A',
          why: '目标不清是所有后续分歧的根源。一句话目标（为谁、解决什么、产出什么）能让全组对齐，也是 AI 追踪进度的基准。',
          done: '一句话目标 + 预期产出清单，全组确认。',
        },
        {
          t: '完成主流方法的文献调研',
          owner: '成员B',
          why: '不了解现有方法就动手，大概率走弯路。用「论文推荐」页的检索提示词查 5-8 篇相关文献。',
          done: '调研笔记：2-3 类主流方法 + 各自优缺点 + 初步倾向。',
        },
        {
          t: '验证数据 / 工具的可获取性',
          owner: '成员C',
          why: '大数据项目最常见的失败原因是数据拿不到或环境搭不起来，第一周必须验证。',
          done: '确认数据来源或工具链可用，附验证记录。',
        },
      ],
      papers: genericDirections(name),
    }
  }

  /** 把旧表单入参统一成契约入参。新旧入口都走这一条路径，不存在第二套逻辑 */
  function normalizeCreateInput(
    input: CreateProjectInput | LegacyCreateProjectInput,
  ): CreateProjectInput {
    const legacy = input as Partial<LegacyCreateProjectInput>
    const modern = input as Partial<CreateProjectInput>

    const topicId = modern.topicId ?? legacy.topic ?? ''
    const rawMembers = modern.members ?? legacy.members
    const members =
      typeof rawMembers === 'number'
        ? rawMembers
        : Number.parseInt(String(rawMembers ?? '').replace(/[^\d]/g, ''), 10) || 0

    return {
      topicId,
      customName: modern.customName ?? legacy.customName ?? '',
      members,
      manualName: modern.manualName ?? legacy.manual ?? null,
      dataName: modern.dataName ?? legacy.data ?? null,
    }
  }

  /**
   * 契约 3.2：createProject。
   * 生成 projectId / projectRevision=1 / schemaVersion，并把模板步骤实例化成结构化任务。
   */
  function createProject(
    input: CreateProjectInput | LegacyCreateProjectInput,
  ): ActionResult<CreateProjectResult> {
    const normalized = normalizeCreateInput(input)

    if (normalized.topicId === '') {
      toast('请先选择项目题目')
      return localFailure('INVALID_INPUT', '请先选择项目题目')
    }

    let name: string
    let tpl: Template

    if (normalized.topicId === '__custom__') {
      name = (normalized.customName ?? '').trim()
      if (name === '') {
        toast('请填写自定义项目名称')
        return localFailure('INVALID_INPUT', '请填写自定义项目名称')
      }
      tpl = customTemplate(name)
    } else {
      const found: Template | undefined = TEMPLATES[normalized.topicId]
      if (found === undefined) {
        toast('没有找到这个题目，请重新选择')
        return localFailure('NOT_FOUND', '没有找到这个题目，请重新选择')
      }
      name = normalized.topicId
      tpl = found
    }

    const projectId = createProjectId()
    const timestamp = nowIso()
    const milestone = tpl.ms.find((item) => item.s === 'cur')?.t ?? tpl.ms[0]?.t ?? null

    const tasks: Task[] = tpl.steps.map((step) => ({
      id: createTaskId(),
      projectId,
      title: step.t,
      status: 'todo',
      doneCriteria: normalizeNullable(step.done),
      // 契约 2.2：MVP 无成员名单，线上 owner 恒为 null
      owner: null,
      // 模板里的「成员A / 成员B」只作为旧页面的展示内容
      suggestedOwner: normalizeNullable(step.owner),
      milestone,
      why: normalizeNullable(step.why),
      createdAt: timestamp,
      updatedAt: timestamp,
    }))

    const doubtRecords: Doubt[] = tpl.doubts.map((text) => ({
      id: createDoubtId(),
      projectId,
      text,
      status: 'open',
      sourceEvidenceId: null,
      createdAt: timestamp,
      resolvedAt: null,
    }))

    const memberCount = normalized.members > 0 ? normalized.members : 3

    const project: Project = {
      ...JSON.parse(JSON.stringify(tpl)),
      // 覆盖模板里的 papers：论文方向的唯一来源，便于日后换成后端接口
      papers: presetDirections({ topic: normalized.topicId, projectName: name }),
      projectId,
      projectRevision: 1,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name,
      group: `第 ${projects.value.length + 1} 组`,
      members: `${memberCount} 名成员`,
      updated: '项目创建于今天 · 等待第一条证据',
      tasks,
      evidenceRecords: [],
      doubtRecords,
      evidence: [],
      doubts: [],
      steps: [],
      weekly: [0, 0, 0, 0],
      materials: [],
      chat: [
        {
          who: 'AI 顾问',
          me: false,
          text: `你好，我是「${tpl.short}」项目的顾问。项目刚启动，我已为你们生成了最初的步骤（见上方推荐）。上传实验手册或数据集后，我会解析内容让步骤追踪更精准。有问题随时问我。`,
        },
      ],
      aiPapers: [],
    }

    const manualName = normalizeNullable(normalized.manualName)
    const dataName = normalizeNullable(normalized.dataName)
    if (manualName !== null) project.materials.push({ name: manualName, type: '实验手册' })
    if (dataName !== null) project.materials.push({ name: dataName, type: '数据集' })

    syncProjectView(project)
    projects.value = [...projects.value, project]
    curIdx.value = projects.value.length - 1
    creating.value = false

    if (!persist()) {
      // 回滚：新项目没有落到磁盘，就不要留在列表里
      projects.value = projects.value.filter((item) => item.projectId !== projectId)
      curIdx.value = projects.value.length - 1
      creating.value = projects.value.length === 0
      toast('本地存储空间不足，项目没有保存')
      return localFailure('STORAGE_FULL', '本地存储空间不足，项目没有保存')
    }

    window.scrollTo(0, 0)
    toast(
      project.materials.length
        ? `项目已创建，AI 已解析 ${project.materials.length} 份材料并开始追踪步骤`
        : '项目已创建，AI 已生成启动步骤',
    )

    return { ok: true, data: { projectId, projectRevision: project.projectRevision } }
  }

  /**
   * 契约 3.2：selectProject。
   * 同时兼容旧的数组下标：页面暂时还在传 index。
   */
  function selectProject(input: string | number): ActionResult<SelectProjectResult> {
    const index =
      typeof input === 'number'
        ? input
        : projects.value.findIndex((item) => item.projectId === input)

    const project = projects.value[index]
    if (project === undefined) {
      return localFailure('NOT_FOUND', '项目不存在')
    }

    // 切换项目：取消上一次在途建议请求，避免旧响应写入新项目
    inFlightAbort?.abort()
    inFlightAbort = null
    inFlightToken += 1

    // 先改内存再落盘；落盘失败就回到原来的项目，避免「内存里选了 A，磁盘上记着 B」
    const previousIdx = curIdx.value
    curIdx.value = index
    creating.value = false

    if (!persist()) {
      curIdx.value = previousIdx
      creating.value = projects.value.length === 0
      toast('本地存储不可用，项目切换没有保存')
      return localFailure('STORAGE_FULL', '本地存储不可用，项目切换没有保存')
    }

    return { ok: true, data: { projectId: project.projectId, projectRevision: project.projectRevision } }
  }

  /* ---------------------------------------------------------- 材料上传 */

  /**
   * 写盘失败就撤销这次内存改动，避免「内存里有、刷新后没了」。
   * 只用于不递增 projectRevision 的展示性写入。
   */
  function persistOrRollback(revert: () => void): boolean {
    if (persist()) return true
    revert()
    return false
  }

  function uploadMaterial(type: MaterialType, fileName: string) {
    const project = current.value
    if (project === undefined) return
    project.materials.push({ name: fileName, type })
    // 材料名不影响建议，因此不递增 projectRevision
    if (!persistOrRollback(() => project.materials.pop())) {
      toast('本地存储不可用，材料没有保存')
      return
    }
    if (type === '实验手册') toast('AI 已解析实验手册，将按手册要求校准里程碑与完成标志')
    else if (type === '数据集') toast('AI 已登记数据集，「数据获取与预处理」阶段将按此追踪')
    else toast('材料已上传，AI 已纳入项目状态')
  }

  /* -------------------------------------------------------- 认领任务 */

  function findTaskEverywhere(taskId: string): { project: Project; task: Task } | null {
    for (const project of projects.value) {
      const task = (project.tasks ?? []).find((item) => item.id === taskId)
      if (task !== undefined) return { project, task }
    }
    return null
  }

  /**
   * 契约 3.2：claimTask。
   *
   * - `{ taskId }`：`todo → doing`，**不增加任何完成比例**；
   * - `{ draft }`：新任务候选，前端生成任务并直接置为 `doing`，`projectRevision + 1`；
   * - 两者互斥，同时出现或都不出现按 `INVALID_INPUT` 处理。
   */
  function claimTask(input: ClaimTaskInput): ActionResult<ClaimTaskResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法认领任务')
    }

    const withTaskId = input as { taskId?: string }
    const withDraft = input as { draft?: NewTaskDraft }
    const hasTaskId = typeof withTaskId.taskId === 'string' && withTaskId.taskId !== ''
    const hasDraft = withDraft.draft !== undefined && withDraft.draft !== null

    if (hasTaskId === hasDraft) {
      return localFailure('INVALID_INPUT', '认领任务时需要且只需要提供 taskId 或 draft')
    }

    // ---- 新任务候选 ----
    if (hasDraft) {
      const draft = withDraft.draft as NewTaskDraft
      const title = typeof draft.title === 'string' ? draft.title.trim() : ''
      if (title === '') {
        return localFailure('INVALID_INPUT', '任务标题不能为空')
      }

      const timestamp = nowIso()
      const taskId = createTaskId()
      const task: Task = {
        id: taskId,
        projectId: project.projectId,
        title,
        status: 'doing',
        doneCriteria: normalizeNullable(draft.doneCriteria),
        owner: null,
        suggestedOwner: null,
        milestone: currentMilestoneName(project),
        why: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const saved = commit(project, () => {
        project.tasks.push(task)
        project.tasks = [...project.tasks]
        project.projectRevision += 1
        project.updated = `最近更新：新增任务「${title}」`
      })

      if (!saved.ok) return saved

      toast(`已新增任务「${title}」，完成后请提交证据`)
      return {
        ok: true,
        data: { taskId, status: 'doing', projectRevision: project.projectRevision },
      }
    }

    // ---- 认领已有任务 ----
    const taskId = withTaskId.taskId as string
    const hit = findTaskEverywhere(taskId)
    if (hit === null) {
      return localFailure('NOT_FOUND', '任务不存在')
    }
    if (hit.project.projectId !== project.projectId) {
      return localFailure('PROJECT_MISMATCH', '该任务属于另一个项目')
    }

    const task = hit.task
    if (task.status === 'done') {
      toast('该任务已完成')
      return localFailure('TASK_NOT_CLAIMABLE', '该任务已完成')
    }

    // 已经是 doing：幂等，不改变状态、不递增 revision
    if (task.status === 'doing') {
      return {
        ok: true,
        data: { taskId, status: 'doing', projectRevision: project.projectRevision },
      }
    }

    const saved = commit(project, () => {
      task.status = 'doing'
      task.updatedAt = nowIso()
      project.tasks = [...project.tasks]
      project.projectRevision += 1
      project.updated = `最近更新：认领了任务「${task.title}」`
    })

    if (!saved.ok) return saved

    toast(`已认领任务「${task.title}」，完成后请提交证据`)
    return { ok: true, data: { taskId, status: 'doing', projectRevision: project.projectRevision } }
  }

  /** 旧页面兼容 wrapper：把步骤下标翻译成 taskId，业务逻辑只在 claimTask 里 */
  function claimStep(stepIndex: number): ActionResult<ClaimTaskResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法认领任务')
    }
    const task: Task | undefined = (project.tasks ?? [])[stepIndex]
    if (task === undefined) {
      return localFailure('NOT_FOUND', '任务不存在')
    }
    return claimTask({ taskId: task.id })
  }

  function askAboutStep(stepIndex: number) {
    const project = current.value
    if (project === undefined) return
    const step = project.steps[stepIndex]
    if (step === undefined) return
    project.chat.push({
      who: '我',
      me: true,
      text: `关于步骤 ${stepIndex + 1}「${step.t}」，我想先了解：${step.why.slice(0, 40)}…该怎么开始？`,
    })
    project.chat.push({
      who: 'AI 顾问',
      me: false,
      text: `这一步的完成标志是「${step.done}」。建议先做其中的文献部分——用「论文推荐」页的提示词检索，把结论整理成一页笔记，那就是最初的证据。`,
    })
    if (!persistOrRollback(() => project.chat.splice(-2, 2))) {
      toast('本地存储不可用，提问没有保存')
      return
    }
    toast('已就该步骤向 AI 提问')
  }

  /* -------------------------------------------------------- 解决疑问 */

  function openDoubtsOf(project: Project): Doubt[] {
    return (project.doubtRecords ?? []).filter((item) => item.status === 'open')
  }

  /**
   * 契约 3.2：resolveDoubt。
   * 同时兼容旧下标：下标定位的是**未解决疑问**列表（与页面 `project.doubts` 顺序一致）。
   * 重复解决返回 `ALREADY_RESOLVED`（静默成功语义：不报错、不改状态、不递增 revision）。
   */
  function resolveDoubt(input: string | number): ActionResult<ResolveDoubtResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法处理疑问')
    }

    const doubt: Doubt | undefined =
      typeof input === 'number'
        ? openDoubtsOf(project)[input]
        : (project.doubtRecords ?? []).find((item) => item.id === input)

    if (doubt === undefined) {
      // 可能是别的项目里的 id
      const elsewhere =
        typeof input === 'string' &&
        projects.value.some(
          (item) => item.projectId !== project.projectId &&
            (item.doubtRecords ?? []).some((entry) => entry.id === input),
        )
      return elsewhere
        ? localFailure('PROJECT_MISMATCH', '该疑问属于另一个项目')
        : localFailure('NOT_FOUND', '疑问不存在')
    }

    if (doubt.status === 'resolved') {
      // 契约 3.3：重复解决是静默成功，不报错也不改状态
      return { ok: true, data: { doubtId: doubt.id, projectRevision: project.projectRevision } }
    }

    const saved = commit(project, () => {
      doubt.status = 'resolved'
      doubt.resolvedAt = nowIso()
      project.doubtRecords = [...project.doubtRecords]
      project.projectRevision += 1
      project.updated = `最近更新：解决了疑问「${doubt.text.slice(0, 20)}…」`
    })

    if (!saved.ok) return saved

    toast('疑问已标记解决')
    return { ok: true, data: { doubtId: doubt.id, projectRevision: project.projectRevision } }
  }

  /* ---------------------------------------------------------------- 问答 */

  function sendChat(text: string) {
    const project = current.value
    if (project === undefined || text.trim() === '') return
    const message = { who: '我', me: true, text: text.trim() }
    project.chat.push(message)
    if (!persistOrRollback(() => project.chat.pop())) {
      toast('本地存储不可用，消息没有保存')
      return
    }
    const reply = AI_REPLIES[replyIdx % AI_REPLIES.length]
    replyIdx += 1
    window.setTimeout(() => {
      project.chat.push({ who: 'AI 顾问', me: false, text: reply })
      // 回复是展示内容：写盘失败只撤销这一条，不影响已经发出的提问
      persistOrRollback(() => project.chat.pop())
    }, 600)
  }

  /* -------------------------------------------------------- 提交证据 */

  /**
   * 契约 3.2：submitEvidence 返回里的任务状态。
   * `null` 表示这条证据没有关联任务，或关联的任务仍未被认领（记录进展不会推进状态）。
   */
  function taskStatusOf(task: Task | null): 'doing' | 'done' | null {
    if (task === null) return null
    if (task.status === 'done') return 'done'
    return task.status === 'doing' ? 'doing' : null
  }

  /** 旧表单的「步骤 N · 标题」→ taskId；「其他进展」→ null */
  function resolveLegacyTaskId(project: Project, stepLabel: string): string | null {
    const matched = /^步骤\s*(\d+)/.exec(stepLabel.trim())
    if (matched === null) return null
    const index = Number(matched[1]) - 1
    return (project.tasks ?? [])[index]?.id ?? null
  }

  /** 旧表单入参 → 契约入参。旧表单没有 complete / submissionId，按「记录进展」处理 */
  function normalizeEvidenceInput(
    project: Project,
    input: SubmitEvidenceInput | LegacyEvidenceInput,
  ): SubmitEvidenceInput {
    const legacy = input as Partial<LegacyEvidenceInput>
    if (typeof legacy.stepLabel !== 'string') {
      const modern = input as SubmitEvidenceInput
      return {
        submissionId: typeof modern.submissionId === 'string' && modern.submissionId !== ''
          ? modern.submissionId
          : createRequestId(),
        taskId: normalizeNullable(modern.taskId),
        didWhat: modern.didWhat ?? '',
        foundWhat: normalizeNullable(modern.foundWhat),
        stillUnsure: normalizeNullable(modern.stillUnsure),
        attachmentName: normalizeNullable(modern.attachmentName),
        complete: modern.complete === true,
      }
    }

    // 旧表单没有「解决了哪个问题」对应的契约字段，并入「发现了什么」，不丢内容
    const foundParts = [legacy.foundWhat ?? '', legacy.solved ?? '']
      .map((item) => item.trim())
      .filter((item) => item !== '')

    return {
      submissionId: createRequestId(),
      taskId: resolveLegacyTaskId(project, legacy.stepLabel),
      didWhat: legacy.didWhat ?? '',
      foundWhat: foundParts.length > 0 ? foundParts.join('；') : null,
      stillUnsure: normalizeNullable(legacy.unsure),
      attachmentName: normalizeNullable(legacy.attachment),
      complete: false,
    }
  }

  /**
   * 契约 3.2：submitEvidence。
   *
   * - `complete: false`：只保存证据（必要时生成 open 疑问），**不把任务置为 done**；
   * - `complete: true`：校验必填后把 `doing` 任务置为 `done`，进度由已完成任务重新推导；
   * - `submissionId` 是幂等键，重复提交不重复写入、不重复建疑问、不重复加活跃度、不递增 revision；
   * - 证据先落盘成功，再去请求建议；建议失败不回滚证据（契约 5.2）。
   */
  async function submitEvidence(
    input: SubmitEvidenceInput | LegacyEvidenceInput,
  ): Promise<ActionResult<SubmitEvidenceResult>> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法提交证据')
    }

    const normalized = normalizeEvidenceInput(project, input)

    const didWhat = normalized.didWhat.trim()
    if (didWhat === '') {
      toast('请先写清「完成了什么」')
      return localFailure('INVALID_INPUT', '请先写清「完成了什么」')
    }
    if (didWhat.length > MAX_EVIDENCE_DID_WHAT_LENGTH) {
      toast(`「完成了什么」最多 ${MAX_EVIDENCE_DID_WHAT_LENGTH} 字`)
      return localFailure('INVALID_INPUT', `「完成了什么」最多 ${MAX_EVIDENCE_DID_WHAT_LENGTH} 字`)
    }
    const lengthChecks: Array<{ value: string | null; limit: number; label: string }> = [
      { value: normalized.foundWhat ?? null, limit: MAX_EVIDENCE_FOUND_WHAT_LENGTH, label: '「发现了什么」' },
      { value: normalized.stillUnsure ?? null, limit: MAX_EVIDENCE_UNSURE_LENGTH, label: '「还有什么不确定」' },
    ]
    for (const check of lengthChecks) {
      if (check.value !== null && check.value.length > check.limit) {
        toast(`${check.label}最多 ${check.limit} 字`)
        return localFailure('INVALID_INPUT', `${check.label}最多 ${check.limit} 字`)
      }
    }

    // 任务归属校验
    let task: Task | null = null
    if (normalized.taskId !== null) {
      const hit = findTaskEverywhere(normalized.taskId)
      if (hit === null) {
        return localFailure('NOT_FOUND', '任务不存在')
      }
      if (hit.project.projectId !== project.projectId) {
        return localFailure('PROJECT_MISMATCH', '该任务属于另一个项目')
      }
      task = hit.task
    }

    if (normalized.complete && task === null) {
      return localFailure('INVALID_INPUT', '确认完成时需要指定一个任务')
    }
    // 契约 3.2：确认完成只做 doing → done。todo 任务必须先认领，不做隐式推进
    if (normalized.complete && task !== null && task.status === 'todo') {
      return localFailure('INVALID_INPUT', '确认完成前需要先认领该任务')
    }

    // ---- 幂等：同一个 submissionId 已经写过就直接返回 ----
    const existing = (project.evidenceRecords ?? []).find(
      (item) => item.submissionId === normalized.submissionId,
    )
    if (existing !== undefined) {
      return {
        ok: true,
        data: {
          evidenceId: existing.id,
          submissionId: existing.submissionId,
          deduplicated: true,
          doubtId: null,
          taskStatus: taskStatusOf(task),
          projectRevision: project.projectRevision,
        },
      }
    }

    const timestamp = nowIso()
    const evidence: Evidence = {
      id: createEvidenceId(),
      projectId: project.projectId,
      submissionId: normalized.submissionId,
      taskId: normalized.taskId,
      didWhat,
      foundWhat: normalized.foundWhat ?? null,
      stillUnsure: normalized.stillUnsure ?? null,
      attachmentName: normalized.attachmentName ?? null,
      author: null,
      createdAt: timestamp,
    }

    let doubtId: string | null = null
    const saved = commit(project, () => {
      project.evidenceRecords.push(evidence)
      project.evidenceRecords = [...project.evidenceRecords]

      // 还有什么不确定 → 同时生成一条 open 疑问
      if (evidence.stillUnsure !== null) {
        const doubt: Doubt = {
          id: createDoubtId(),
          projectId: project.projectId,
          text: evidence.stillUnsure,
          status: 'open',
          sourceEvidenceId: evidence.id,
          createdAt: timestamp,
          resolvedAt: null,
        }
        project.doubtRecords.push(doubt)
        project.doubtRecords = [...project.doubtRecords]
        doubtId = doubt.id
      }

      // 确认完成：只做 doing → done；进度由 syncMilestones 按已完成任务重新推导
      if (normalized.complete && task !== null && task.status === 'doing') {
        task.status = 'done'
        task.updatedAt = timestamp
        project.tasks = [...project.tasks]
      }

      // 提交证据 = 本周有活跃
      if (project.weekly.length > 0) project.weekly[project.weekly.length - 1] += 1

      project.projectRevision += 1
      project.updated = `最近更新：提交了证据 · 共 ${project.evidenceRecords.length} 条`
    })

    if (!saved.ok) return saved

    const taskStatus = taskStatusOf(task)
    const result: SubmitEvidenceResult = {
      evidenceId: evidence.id,
      submissionId: evidence.submissionId,
      deduplicated: false,
      doubtId,
      taskStatus,
      projectRevision: project.projectRevision,
    }

    toast(normalized.complete ? '证据已提交，任务已标记完成' : '证据已提交，AI 已更新项目状态')

    // 契约 5.2：证据先落盘，再请求建议；建议失败不回滚证据、不改 revision
    await refreshRecommendations()

    return { ok: true, data: result }
  }

  /* ------------------------------------------------------ 论文推荐 */

  function askPaperAi(topic: string) {
    const project = current.value
    if (project === undefined) {
      toast('请先创建项目')
      return
    }
    if (topic.trim() === '') {
      toast('先描述一下你想了解的方向')
      return
    }
    const curMs = (project.ms.find((m) => m.s === 'cur') || { t: '当前阶段' }).t
    project.aiPapers.unshift(
      generateDirection({
        projectName: project.name,
        shortName: project.short,
        currentMilestone: curMs,
        ask: topic,
      }),
    )
    if (!persistOrRollback(() => project.aiPapers.shift())) {
      toast('本地存储不可用，检索方向没有保存')
      return
    }
    toast('AI 已生成专属检索提示词')
  }

  /* -------------------------------------------------------- 建议请求流程 */

  /** 把未预期异常收敛成界面可用的失败原因：只记类型名，不外泄技术细节 */
  function toUnexpectedError(error: unknown): AdvisorApiError {
    console.warn('[advisor] 建议流程出现未预期异常', error instanceof Error ? error.name : 'unknown')
    return {
      code: 'NETWORK_ERROR',
      message: '建议请求未能完成',
      retryable: true,
      retryAfterSeconds: null,
      requestId: null,
      cause: 'network',
    }
  }

  /**
   * 契约 3.2：refreshRecommendations。
   *
   * 流程：组装快照 → 记录发起时的 projectId / projectRevision → 调用适配层
   *      → 校验响应是否过期 → 写入状态；后端失败时改用本地规则（source=local-rule），
   *      本地规则也给不出建议才进入 error。
   *
   * 三条不变量：只改建议状态（不动任务、证据、疑问、revision），不抛未处理异常，过期响应不改任何状态。
   */
  async function refreshRecommendations(
    options: { forceRefresh?: boolean } = {},
  ): Promise<ActionResult<AdvisorOutcome>> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法请求建议')
    }

    // 发起请求时的快照与身份：响应用它们判断是否已经过期
    const reference = new Date()
    const projectId = project.projectId
    const projectRevision = computeProjectRevision(project)
    const currentMilestone = currentMilestoneName(project)
    const tasks = deriveTaskSnapshots(project, reference)
    const evidence = deriveEvidenceSnapshots(project, reference)
    const doubts = deriveDoubtSnapshots(project, reference)
    const generatedAt = reference.toISOString()

    const request = buildAdvisorRequest({
      projectId,
      projectRevision,
      projectName: project.name,
      currentMilestone,
      tasks,
      evidence,
      doubts,
      forceRefresh: options.forceRefresh ?? false,
    })

    // 本地规则与请求体同源：后端不可用时，兜底建议必须基于同一份快照
    const localInput = { generatedAt, projectRevision, currentMilestone, tasks, evidence, doubts }

    // 新请求作废前一次在途请求
    inFlightAbort?.abort()
    const controller = new AbortController()
    inFlightAbort = controller
    inFlightToken += 1
    const token = inFlightToken

    patchAdvisor(projectId, {
      status: 'loading',
      suggestions: [],
      error: null,
      requestId: request.requestId,
      projectRevision,
      cached: false,
      fallbackReason: null,
    })

    /** 丢弃过期响应：当前项目的状态一律不动（契约 4.7 补充约定 1） */
    const discard = (): ActionResult<AdvisorOutcome> => {
      // 项目已经切走时，把它自己的 loading 收尾，避免切回来看到永远转圈的状态
      if (currentProjectId.value !== projectId) {
        const state = advisorByProject.value[projectId]
        if (state?.status === 'loading' && state.requestId === request.requestId) {
          patchAdvisor(projectId, { status: 'idle', requestId: null })
        }
      }
      return localFailure('STALE_RESPONSE', '该建议响应已过期，已丢弃')
    }

    /** 契约 5.1：后端失败 → 本地规则；本地规则也空 → error */
    const fallbackToLocalRule = (error: AdvisorApiError): ActionResult<AdvisorOutcome> => {
      const suggestions = buildLocalRecommendations(localInput)

      if (suggestions.length > 0) {
        patchAdvisor(projectId, {
          status: 'local-rule',
          suggestions,
          // 失败原因留给界面层映射文案
          error,
          cached: false,
          fallbackReason: null,
          requestId: null,
          projectRevision,
        })
        return {
          ok: true,
          data: {
            source: 'local-rule',
            suggestions,
            cached: false,
            fallbackReason: null,
            requestId: null,
          },
        }
      }

      patchAdvisor(projectId, {
        status: 'error',
        suggestions: [],
        error,
        requestId: null,
        projectRevision,
      })
      // 保留适配层给出的原始 code（如果是过期响应就用 STALE_RESPONSE），
      // 页面可以从 `aiError.code` 拿到同一个值，这里不做二次映射
      return { ok: false, code: error.code, message: error.message }
    }

    try {
      // 契约 4.0：可重试的失败在适配层自动重试 1 次
      const result = await fetchRecommendations(request, { signal: controller.signal })

      // 过期判断（契约 4.7 第 1~4 条）
      if (token !== inFlightToken) return discard()
      if (currentProjectId.value !== projectId) return discard()
      if (computeProjectRevision(project) !== projectRevision) return discard()

      if (result.ok) {
        const parsed = toRecommendations(result.data)

        // 契约 4.7 第 1~3 条：requestId / projectId / projectRevision 三项都要对得上
        if (
          result.data.requestId !== request.requestId ||
          result.data.projectId !== projectId ||
          result.data.projectRevision !== projectRevision
        ) {
          return discard()
        }

        // 契约 4.6：已完成任务不得出现在建议里。服务端已校验，前端再兜一次：
        // 指向 done 任务的建议整条丢弃；全部被丢完则按本地规则兜底
        const doneTaskIds = new Set(
          tasks.filter((task) => task.status === 'done').map((task) => task.taskId),
        )
        // 契约 4.6：依据 ID 必须落在本次请求里，否则页面会指向一条不存在的证据/疑问
        const knownEvidenceIds = new Set(evidence.map((item) => item.evidenceId))
        const knownDoubtIds = new Set(doubts.map((item) => item.doubtId))

        const suggestions = parsed
          .filter((item) => item.existingTaskId === null || !doneTaskIds.has(item.existingTaskId))
          .map((item) => ({
            ...item,
            basisEvidenceIds: item.basisEvidenceIds.filter((id) => knownEvidenceIds.has(id)),
            basisDoubtIds: item.basisDoubtIds.filter((id) => knownDoubtIds.has(id)),
          }))

        if (suggestions.length === 0) {
          console.warn('[advisor] 建议全部指向已完成任务，改用本地规则')
          return fallbackToLocalRule({
            code: 'INVALID_MODEL_OUTPUT',
            message: '本次建议都指向已完成的任务',
            retryable: false,
            retryAfterSeconds: null,
            requestId: result.data.requestId,
            cause: 'invalid-response',
          })
        }

        const source: RecommendationSource = result.data.source
        const status: AiStatus = source === 'model' ? 'model' : 'fallback'

        patchAdvisor(projectId, {
          status,
          suggestions,
          error: null,
          cached: result.data.cached,
          fallbackReason: result.data.fallbackReason,
          requestId: result.data.requestId,
          projectRevision,
        })

        return {
          ok: true,
          data: {
            source,
            suggestions,
            cached: result.data.cached,
            fallbackReason: result.data.fallbackReason,
            requestId: result.data.requestId,
          },
        }
      }

      // 适配层已判定的过期响应：静默丢弃，不提示用户
      if (isStaleResponseError(result.error) || !shouldFallbackToLocalRule(result.error)) {
        return discard()
      }

      return fallbackToLocalRule(result.error)
    } catch (unexpected) {
      return fallbackToLocalRule(toUnexpectedError(unexpected))
    } finally {
      if (inFlightAbort === controller) inFlightAbort = null
    }
  }

  return {
    projects,
    curIdx,
    creating,
    toastText,
    toastVisible,
    current,
    hasProject,
    topics: TOPICS,
    toast,
    showCreate,
    // 契约 3.2 的六个 action
    createProject,
    selectProject,
    claimTask,
    submitEvidence,
    resolveDoubt,
    refreshRecommendations,
    // 旧页面兼容 wrapper：内部一律调用上面的新 action
    claimStep,
    uploadMaterial,
    askAboutStep,
    sendChat,
    askPaperAi,
    // 建议请求（契约 3.2）：状态 + 读取器 + action
    advisor,
    aiStatus,
    recommendations,
    aiError,
  }
})
