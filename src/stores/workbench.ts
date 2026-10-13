import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  Doubt,
  Evidence,
  Material,
  MaterialItemType,
  MaterialReadState,
  MaterialSegment,
  NewTaskDraft,
  Project,
  ProjectProfile,
  Task,
  Template,
  UnderstandingBlock,
  UnderstandingBlockStatus,
} from '@/types/platform'
import { PROJECT_SCHEMA_VERSION } from '@/types/platform'
import { TEMPLATES, TOPICS } from '@/data/topics'
// 论文方向只从这一个入口取：现在返回模板预置内容，接入后端后换实现即可，页面无需改动
import { generateDirection, genericDirections, presetDirections } from '@/services/papers'
// 建议请求：适配层负责 HTTP 与契约校验，mvpFallbacks 负责后端不可用时的本地兜底
import {
  buildAdvisorChatRequest,
  buildAdvisorRequest,
  createRequestId,
  fetchAdvisorChat,
  fetchRecommendations,
  isStaleResponseError,
  shouldFallbackToLocalRule,
  toRecommendations,
} from '@/services/advisorApi'
import { buildLocalRecommendations } from '@/data/mvpFallbacks'
// v2：材料与理解草稿（契约 13 / 14）
import {
  buildUnderstandingRequest,
  buildMaterialUploadRequest,
  bytesToBase64,
  fetchMaterialUnderstanding,
  isStaleMaterialResponse,
  // 与 store 里旧页面的 `uploadMaterial(typeLabel, name)` 包装同名，这里用别名区分
  uploadMaterial as requestMaterialUpload,
} from '@/services/materialsApi'
import {
  MAX_MATERIAL_NAME_LENGTH,
  MATERIAL_MAX_BYTES,
  UNDERSTANDING_BLOCK_ORDER,
  allSegmentsOf,
  buildConfirmedContext,
  buildConfirmedMaterials,
  buildProjectProfile,
  confirmedBlocksOf,
  createMaterialId,
  emptyProjectProfile,
  findMaterial,
  isMaterialInOtherProject,
  materialReadStates,
  materialTypeFromFileName,
  normalizeBlockContent,
  normalizeProjectProfile,
  pendingBlocksOf,
  modifiedBlocksOf,
  segmentsOfMaterial,
  selectUnderstandingSegments,
  statusAfterUnconfirm,
  understandingBlockKey,
  understandingBlocksOf,
  validateProjectProfileInput,
} from '@/domain/materials'
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
  AdvisorChatMessage,
  AdvisorFallbackReason,
  AdvisorOutcome,
  ClaimTaskInput,
  ClaimTaskResult,
  ConfirmAllUnderstandingInput,
  ConfirmAllUnderstandingResult,
  CreateProjectInput,
  CreateProjectResult,
  DeleteUnderstandingBlockResult,
  LegacyCreateProjectInput,
  LegacyEvidenceInput,
  ModifyUnderstandingBlockInput,
  Recommendation,
  RecommendationSource,
  RecordUnderstandingInput,
  RecordUnderstandingResult,
  RegisterMaterialInput,
  RegisterMaterialResult,
  RequestUnderstandingInput,
  RequestUnderstandingResult,
  ResolveDoubtResult,
  SelectProjectResult,
  SubmitEvidenceInput,
  SubmitEvidenceResult,
  UnderstandingBlockIdInput,
  UnderstandingBlockResult,
  UpdateProjectProfileInput,
  UpdateProjectProfileResult,
  UploadMaterialFileInput,
  UploadMaterialFileResult,
} from '@/domain/recommendation'
import {
  MATERIAL_ERROR_MESSAGES,
  MAX_EVIDENCE_DID_WHAT_LENGTH,
  MAX_EVIDENCE_FOUND_WHAT_LENGTH,
  MAX_EVIDENCE_UNSURE_LENGTH,
  describeAdvisorFailure,
  localFailure,
} from '@/domain/recommendation'
import { loadPersistedState, savePersistedState } from '@/stores/persistence'

/** 近 4 周的时间标签，与 mockup 一致 */
export const WEEK_LABELS = ['8.31-9.6', '9.7-9.13', '9.14-9.20', '9.21-9.27']

/** 中文序号，用于里程碑编号 */
export const CHINESE_NUM = ['①', '②', '③', '④', '⑤', '⑥']

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

  // v2 状态（契约 13 / 14）：旧项目或半截数据先把容器补齐，再谈投影
  if (project.profile === undefined || project.profile === null) project.profile = emptyProjectProfile()
  if (!Array.isArray(project.materialRecords)) project.materialRecords = []
  if (!Array.isArray(project.materialSegments)) project.materialSegments = []
  if (!Array.isArray(project.materials)) project.materials = []
  if (!Array.isArray(project.understandingBlocks)) project.understandingBlocks = []

  // 契约 14.5 第 4 条：材料已删或已升版时，旧版本的草稿引用一律作废
  const currentVersions = new Map(
    project.materialRecords.map((material) => [material.materialId, material.version]),
  )
  const kept = project.understandingBlocks.filter(
    (block) => currentVersions.get(block.materialId) === block.materialVersion,
  )
  if (kept.length !== project.understandingBlocks.length) project.understandingBlocks = kept

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

  /* ------------------------------------------- v2 读取器（契约 13 / 14） */

  /** 契约 13.1：当前项目的项目基本信息（结构化状态，不是一段聊天文本） */
  const basicInfo = computed<ProjectProfile>(() => current.value?.profile ?? emptyProjectProfile())

  /** 契约 13.2：要发出去的 `projectProfile`；全为空时是 `null`（请求体里不出现该字段） */
  const projectProfile = computed<ProjectProfile | null>(() => buildProjectProfile(current.value?.profile))

  /** 契约 14.1：当前项目的材料（每种材料只保留最新版本） */
  const materials = computed<Material[]>(() => current.value?.materialRecords ?? [])

  /** 契约 14.2：当前项目全部材料的**当前版本**片段（自带 materialId / materialVersion） */
  const materialSegments = computed<MaterialSegment[]>(() => {
    const project = current.value
    return project === undefined ? [] : allSegmentsOf(project)
  })

  /** 契约 14.1 备注：材料的本地读取口径（仅登记 / 待确认草稿 / 已确认） */
  const materialReadStateMap = computed<Record<string, MaterialReadState>>(() => {
    const project = current.value
    return project === undefined ? {} : materialReadStates(project)
  })

  /** 契约 14.3：待确认的理解草稿（模型刚生成，学生还没动过） */
  const pendingUnderstandingBlocks = computed<UnderstandingBlock[]>(() => {
    const project = current.value
    return project === undefined ? [] : pendingBlocksOf(project)
  })

  /** 契约 14.3：已修改但**还没再次确认**的理解草稿（同样不是项目事实） */
  const modifiedUnderstandingBlocks = computed<UnderstandingBlock[]>(() => {
    const project = current.value
    return project === undefined ? [] : modifiedBlocksOf(project)
  })

  /** 契约 14.3 / 17.2：已确认的理解草稿（只有这些会进入请求体） */
  const confirmedUnderstandingBlocks = computed<UnderstandingBlock[]>(() => {
    const project = current.value
    return project === undefined ? [] : confirmedBlocksOf(project)
  })

  /** 契约 4.1 / 13.2：已确认的项目事实（不含项目基本信息） */
  const confirmedContext = computed<string[]>(() => {
    const project = current.value
    return project === undefined ? [] : buildConfirmedContext(project)
  })

  /** 契约 17.1：要发出去的 `confirmedMaterials`；没有已确认材料时是空数组 */
  const confirmedMaterials = computed(() => {
    const project = current.value
    return project === undefined ? [] : buildConfirmedMaterials(project)
  })

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
      profile: modern.profile,
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
      profile: normalizeProjectProfile(normalized.profile),
      materialRecords: [],
      materialSegments: [],
      understandingBlocks: [],
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

  function uploadMaterial(type: MaterialItemType, fileName: string) {
    const project = current.value
    if (project === undefined) return
    project.materials.push({ name: fileName, type })
    // 材料名不影响建议，因此不递增 projectRevision
    if (!persistOrRollback(() => project.materials.pop())) {
      toast('本地存储不可用，材料没有保存')
      return
    }
    // 这条是 v1 的「只记文件名」入口，没有内容也没有解析：
    // 文案必须如实说明，不能声称"AI 已解析"（v2 的解析入口是 uploadMaterialFile）。
    toast(
      `已登记${type}「${fileName}」；目前只有 md / txt 会被解析，` +
        '请在「材料与理解草稿」里上传以生成理解草稿',
    )
  }

  /* ========================================================================
   * v2：项目基本信息与材料登记（契约 13 / 14）
   *
   * 责任边界（契约 12.2）：
   *   - 服务端无状态：材料、草稿、确认状态都存在 localStorage；
   *   - 文件内容由前端读原始字节 → base64 再发给后端，后端负责解码、分段与解析；
   *   - 解析失败只影响这一份材料，不阻塞项目，也不动已有数据；
   *   - 未确认的草稿绝不进入建议 / 聊天请求。
   * ====================================================================== */

  /** 定位结果：材料 / 草稿条目在别的项目里时返回 `PROJECT_MISMATCH`（契约 3.3） */
  type Located<T> =
    | { ok: true; value: T }
    | { ok: false; code: 'NOT_FOUND' | 'PROJECT_MISMATCH'; message: string }

  function locateMaterial(materialId: string): Located<Material> {
    const project = current.value
    if (project === undefined) return { ok: false, code: 'NOT_FOUND', message: '还没有项目' }

    const material = findMaterial(project, materialId)
    if (material !== null) return { ok: true, value: material }
    if (isMaterialInOtherProject(projects.value, project.projectId, materialId)) {
      return { ok: false, code: 'PROJECT_MISMATCH', message: '该材料属于另一个项目' }
    }
    return { ok: false, code: 'NOT_FOUND', message: '材料不存在' }
  }

  /** 按**本地** blockId 定位草稿条目；条目不在此项目时返回 `PROJECT_MISMATCH` */
  function locateUnderstandingBlock(blockId: string): Located<UnderstandingBlock> {
    const project = current.value
    if (project === undefined) return { ok: false, code: 'NOT_FOUND', message: '还没有项目' }

    const block = understandingBlocksOf(project).find((entry) => entry.id === blockId)
    if (block !== undefined) return { ok: true, value: block }

    const elsewhere = projects.value.some(
      (entry) =>
        entry.projectId !== project.projectId &&
        understandingBlocksOf(entry).some((candidate) => candidate.id === blockId),
    )
    return elsewhere
      ? { ok: false, code: 'PROJECT_MISMATCH', message: '该理解草稿属于另一个项目' }
      : { ok: false, code: 'NOT_FOUND', message: '理解草稿不存在' }
  }

  /** 归一化后的基本信息是否与已保存的一致（避免无变化时也递增 projectRevision） */
  function sameProfile(a: ProjectProfile, b: ProjectProfile): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
  }

  /**
   * 契约 13.1 / 2.6：保存项目基本信息。
   * 校验在**归一化之前**做：超长要报错并高亮字段，不能静默截断。
   */
  function updateProjectProfile(
    input: UpdateProjectProfileInput,
  ): ActionResult<UpdateProjectProfileResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法保存项目基本信息')
    }

    const invalid = validateProjectProfileInput(input)
    if (invalid !== null) {
      toast(invalid)
      return localFailure('INVALID_INPUT', invalid)
    }

    const profile = normalizeProjectProfile(input)
    if (sameProfile(project.profile, profile)) {
      // 没有变化：不写盘、不递增版本（契约 2.6「何时不变」）
      return { ok: true, data: { projectRevision: project.projectRevision } }
    }

    const saved = commit(project, () => {
      project.profile = profile
      project.projectRevision += 1
      project.updated = '最近更新：补充了项目基本信息'
    })
    if (!saved.ok) return saved

    toast('项目基本信息已保存')
    return { ok: true, data: { projectRevision: project.projectRevision } }
  }

  /** 兼容别名：页面既可调 `updateProjectProfile` 也可调 `updateProjectBasicInfo` */
  function updateProjectBasicInfo(
    input: UpdateProjectProfileInput,
  ): ActionResult<UpdateProjectProfileResult> {
    return updateProjectProfile(input)
  }

  /**
   * 契约 14.1 / 2.6：登记一份材料（本地写入，不访问网络）。
   *
   * - 传入已存在的 `materialId` → 视为重新上传，`version + 1`，旧版本草稿作废；
   * - 只有 `.md` / `.txt` 在白名单内（契约 15.1），其它类型直接返回 `INVALID_INPUT`；
   * - 登记成功后 `projectRevision + 1`。
   */
  function registerMaterial(input: RegisterMaterialInput): ActionResult<RegisterMaterialResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法登记材料')
    }

    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name === '') return localFailure('INVALID_INPUT', '材料名称不能为空')
    if (name.length > MAX_MATERIAL_NAME_LENGTH) {
      return localFailure('INVALID_INPUT', `材料名称最多 ${MAX_MATERIAL_NAME_LENGTH} 字`)
    }

    const type = materialTypeFromFileName(name)
    if (type === null) {
      return localFailure('INVALID_INPUT', '当前只支持 md、txt 文件')
    }

    const explicitId = typeof input.materialId === 'string' && input.materialId !== ''
      ? input.materialId
      : null
    const existing =
      explicitId !== null
        ? findMaterial(project, explicitId)
        : (project.materialRecords.find((material) => material.name === name) ?? null)

    if (explicitId !== null && existing === null) {
      if (isMaterialInOtherProject(projects.value, project.projectId, explicitId)) {
        return localFailure('PROJECT_MISMATCH', '该材料属于另一个项目')
      }
    }

    const materialId = explicitId ?? existing?.materialId ?? createMaterialId()
    const requestedVersion = input.version
    const version =
      typeof requestedVersion === 'number' && Number.isInteger(requestedVersion) && requestedVersion >= 1
        ? requestedVersion
        : (existing?.version ?? 0) + 1

    // 线格式分段 → 本地形态：补上归属字段，index 以响应顺序为准（契约 14.2）
    const segments: MaterialSegment[] = (input.segments ?? []).map((segment, index) => ({
      segmentId: segment.segmentId,
      materialId,
      materialVersion: version,
      index,
      startLine: segment.startLine,
      endLine: segment.endLine,
      text: segment.text,
    }))

    const timestamp = nowIso()
    const state = input.state ?? 'parsed'
    const record: Material = {
      materialId,
      projectId: project.projectId,
      name,
      type,
      size: typeof input.size === 'number' && input.size >= 1 ? Math.floor(input.size) : 1,
      encoding: input.encoding ?? 'utf-8',
      state,
      version,
      // 同一版本重复登记时保留原创建时间，便于材料按创建顺序稳定排序
      createdAt: existing !== null && existing.version === version ? existing.createdAt : timestamp,
      updatedAt: timestamp,
      failureReason: input.failureReason ?? null,
      needsReupload: state !== 'parsed' || segments.length === 0,
    }

    const updated = existing !== null && existing.version !== version

    const saved = commit(project, () => {
      const index = project.materialRecords.findIndex((material) => material.materialId === materialId)
      project.materialRecords =
        index === -1
          ? [...project.materialRecords, record]
          : project.materialRecords.map((material, position) =>
              position === index ? record : material,
            )

      // 片段整体替换：旧版本片段一律丢弃（契约 14.5 第 4 条）
      project.materialSegments = [
        ...project.materialSegments.filter((segment) => segment.materialId !== materialId),
        ...(state === 'parsed' ? segments : []),
      ]

      // 契约 14.5 第 4 条：旧版本的草稿引用视为过期，重新上传后作废
      project.understandingBlocks = project.understandingBlocks.filter(
        (block) => block.materialId !== materialId || block.materialVersion === version,
      )

      project.projectRevision += 1
      project.updated = `最近更新：${updated ? '更新了' : '登记了'}材料「${name}」`
    })
    if (!saved.ok) return saved

    if (record.state === 'parsed') {
      toast(`${updated ? '已更新' : '已登记'}「${name}」，共 ${segments.length} 段，可生成理解草稿`)
    } else {
      toast(`「${name}」解析失败：${record.failureReason ?? '请检查文件内容'}`)
    }

    return {
      ok: true,
      data: {
        materialId,
        version,
        segmentCount: segments.length,
        projectRevision: project.projectRevision,
        updated,
      },
    }
  }

  /**
   * 契约 15.1：上传并解析材料（读原始字节 → base64 → `POST /api/materials`）。
   *
   * 上传失败不产生材料记录，也不动已有数据；失败原因按契约第 16 节映射成中文提示。
   * 若已有同名材料，视为重新上传：`version + 1`（契约 14.5 第 4 条）。
   */
  async function uploadMaterialFile(
    input: UploadMaterialFileInput,
  ): Promise<ActionResult<UploadMaterialFileResult>> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法上传材料')
    }

    const file = input.file
    const fileName = input.name ?? (typeof File !== 'undefined' && file instanceof File ? file.name : '')
    const name = typeof fileName === 'string' ? fileName.trim() : ''
    if (name === '') return localFailure('INVALID_INPUT', '请先选择要上传的文件')
    if (name.length > MAX_MATERIAL_NAME_LENGTH) {
      return localFailure('INVALID_INPUT', `材料名称最多 ${MAX_MATERIAL_NAME_LENGTH} 字`)
    }
    if (file === undefined) return localFailure('INVALID_INPUT', '没有读到文件内容')

    // 与契约 16 的码一致：本地先挡住明显不合法的文件，省一次必然失败的请求
    if (materialTypeFromFileName(name) === null) {
      const message = MATERIAL_ERROR_MESSAGES.UNSUPPORTED_MATERIAL_TYPE
      toast(message)
      return { ok: false, code: 'UNSUPPORTED_MATERIAL_TYPE', message }
    }

    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await file.arrayBuffer())
    } catch {
      return localFailure('INVALID_INPUT', '读取文件内容失败，请重试')
    }

    if (bytes.byteLength > MATERIAL_MAX_BYTES) {
      const message = MATERIAL_ERROR_MESSAGES.MATERIAL_TOO_LARGE
      toast(message)
      return { ok: false, code: 'MATERIAL_TOO_LARGE', message }
    }
    if (bytes.byteLength === 0) {
      const message = MATERIAL_ERROR_MESSAGES.EMPTY_MATERIAL
      toast(message)
      return { ok: false, code: 'EMPTY_MATERIAL', message }
    }

    const explicitId = typeof input.materialId === 'string' && input.materialId !== ''
      ? input.materialId
      : null
    const existing =
      explicitId !== null
        ? findMaterial(project, explicitId)
        : (project.materialRecords.find((material) => material.name === name) ?? null)
    const materialId = explicitId ?? existing?.materialId ?? createMaterialId()
    const version = (existing?.version ?? 0) + 1

    const requestRevision = computeProjectRevision(project)
    const request = buildMaterialUploadRequest({
      projectId: project.projectId,
      projectRevision: requestRevision,
      materialId,
      version,
      name,
      contentBase64: bytesToBase64(bytes),
    })

    const result = await requestMaterialUpload(request, { signal: input.signal })
    if (!result.ok) {
      // 过期响应：静默丢弃，不改任何状态，也不提示用户
      if (!isStaleMaterialResponse(result.error)) toast(describeAdvisorFailure(result.error))
      return { ok: false, code: result.error.code, message: describeAdvisorFailure(result.error) }
    }

    // 契约 4.7：项目已切换或版本已变化 → 丢弃响应，不写入 store
    if (
      currentProjectId.value !== project.projectId ||
      computeProjectRevision(project) !== requestRevision
    ) {
      return { ok: false, code: 'STALE_RESPONSE', message: '该上传响应已过期，已丢弃' }
    }

    const registered = registerMaterial({
      materialId: result.data.material.materialId,
      name: result.data.material.name,
      version: result.data.material.version,
      size: result.data.material.size,
      encoding: result.data.material.encoding,
      state: result.data.material.state,
      failureReason: result.data.material.failureReason,
      segments: result.data.segments,
    })
    if (!registered.ok) return registered

    const material = findMaterial(project, registered.data.materialId)
    if (material === null) {
      return localFailure('NOT_FOUND', '材料登记后没有找到，请刷新页面')
    }

    return {
      ok: true,
      data: {
        material,
        version: material.version,
        segmentCount: result.data.segmentCount,
        segments: result.data.segments,
        projectRevision: project.projectRevision,
      },
    }
  }

  /* ------------------------------------------------ v2：理解草稿（契约 14.3） */

  /** 草稿内容的稳定摘要：用于判断"重复写入同一份草稿"（幂等，不递增版本） */
  function understandingSummary(blocks: UnderstandingBlock[]): string {
    return blocks
      .map((block) => `${block.id}|${block.status}|${block.content}`)
      .sort()
      .join('\n')
  }

  /**
   * 契约 15.2：请求材料理解草稿（`POST /api/materials/understanding`）。
   *
   * 后端不可用 / 返回错误时**不做本地兜底**：理解草稿必须来自材料，本地编造候选会变成
   * "把猜测写成事实"（契约 15.2 第 2 条明确禁止）。失败就如实报错，材料本身不受影响。
   */
  async function requestUnderstanding(
    input: RequestUnderstandingInput,
  ): Promise<ActionResult<RequestUnderstandingResult>> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法生成理解草稿')
    }

    const located = locateMaterial(input.materialId)
    if (!located.ok) return localFailure(located.code, located.message)

    const material = located.value
    if (material.state !== 'parsed') {
      return localFailure('INVALID_INPUT', '这份材料没有解析成功，无法生成理解草稿')
    }

    const all = segmentsOfMaterial(project, material.materialId)
    const picked =
      input.segmentIds === undefined
        ? all
        : all.filter((segment) => (input.segmentIds as string[]).includes(segment.segmentId))
    // 契约 15.2：默认从第 1 段开始累计，直到片段数或字数达到上限
    const selected = selectUnderstandingSegments(picked)
    if (selected.length === 0) {
      return localFailure('INVALID_INPUT', '这份材料没有可发送的片段')
    }
    if (material.type === null) {
      return localFailure('INVALID_INPUT', '这份材料缺少文件类型，请重新上传后再试')
    }

    const requestRevision = computeProjectRevision(project)
    const request = buildUnderstandingRequest({
      projectId: project.projectId,
      projectRevision: requestRevision,
      projectName: project.name,
      material: {
        materialId: material.materialId,
        name: material.name,
        type: material.type,
        version: material.version,
        segments: selected,
      },
    })

    const result = await fetchMaterialUnderstanding(request, { signal: input.signal })
    if (!result.ok) {
      if (!isStaleMaterialResponse(result.error)) toast(describeAdvisorFailure(result.error))
      return { ok: false, code: result.error.code, message: describeAdvisorFailure(result.error) }
    }

    if (
      currentProjectId.value !== project.projectId ||
      computeProjectRevision(project) !== requestRevision
    ) {
      return { ok: false, code: 'STALE_RESPONSE', message: '该理解响应已过期，已丢弃' }
    }

    const recorded = recordUnderstanding({
      materialId: result.data.materialId,
      materialVersion: result.data.materialVersion,
      draft: result.data.draft,
      notice: result.data.notice,
    })
    if (!recorded.ok) return recorded

    return {
      ok: true,
      data: {
        materialId: result.data.materialId,
        materialVersion: result.data.materialVersion,
        source: result.data.source,
        fallbackReason: result.data.fallbackReason,
        notice: result.data.notice,
        blockCount: recorded.data.blockCount,
        draft: result.data.draft,
        projectRevision: project.projectRevision,
      },
    }
  }

  /**
   * 契约 14.3 / 15.3：把服务端草稿写入本地（不访问网络）。
   *
   * 三条清理规则与 15.3 一致：`text` 为空丢该条；来源剔除后为空丢该条（无来源不可用）；
   * 同一材料当前版本的草稿**整体替换**，并保留学生已经确认过的条目结论。
   *
   * 版本语义：草稿生成本身**不递增** `projectRevision`（契约 2.6 / 14.5 的递增事件列表里
   * 只有材料登记与「确认 / 修改 / 删除 / 整份确认」）；重复写入同一份草稿也不递增。
   */
  function recordUnderstanding(
    input: RecordUnderstandingInput,
  ): ActionResult<RecordUnderstandingResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法保存理解草稿')
    }

    const located = locateMaterial(input.materialId)
    if (!located.ok) return localFailure(located.code, located.message)

    const material = located.value
    if (material.version !== input.materialVersion) {
      return localFailure('STALE_RESPONSE', '材料版本已更新，请重新生成理解草稿')
    }

    const timestamp = nowIso()
    const previousById = new Map(understandingBlocksOf(project).map((block) => [block.id, block]))
    const next: UnderstandingBlock[] = []

    for (const kind of UNDERSTANDING_BLOCK_ORDER) {
      const candidates = input.draft[kind] ?? []
      for (const candidate of candidates) {
        const content = normalizeBlockContent(candidate.text)
        if (content === '') continue

        // 契约 15.3：来源必须在本次材料内且属于当前版本，剔除后为空则整条丢弃
        const sources = (candidate.sources ?? [])
          .filter(
            (source) =>
              source.materialId === material.materialId &&
              source.materialVersion === material.version,
          )
          .slice(0, 3)
        if (sources.length === 0) continue

        const id = understandingBlockKey(material.materialId, kind, candidate.itemId)
        const before = previousById.get(id)

        next.push({
          id,
          itemId: candidate.itemId,
          kind,
          materialId: material.materialId,
          materialVersion: material.version,
          content,
          sources,
          /**
           * 重新生成时的状态继承（契约 17.2：只有学生**实际确认过**的内容才发出去）。
           *
           * 服务端的 `itemId` 只在**本次响应内**唯一（按块内序号生成），两次理解请求的
           * 同名 `itemId` 不代表是同一个候选。所以"已确认"的继承必须**内容一致**：
           *   - 新文案与学生确认过的文案逐字相同 → 保持 `confirmed`；
           *   - 新文案变了 → 回到 `pending`，避免把学生没看过的新文案当成已确认发出去。
           */
          status: before?.status === 'confirmed' && before.content === content ? 'confirmed' : 'pending',
          originalContent: content,
          createdAt: before?.createdAt ?? timestamp,
          updatedAt: timestamp,
        })
      }
    }

    const existingBlocks = understandingBlocksOf(project).filter(
      (block) => block.materialId === material.materialId && block.materialVersion === material.version,
    )
    // 契约 15.2：fallback 时服务端必须给出 notice，界面无论是否写入都要能看到
    const noticeText = typeof input.notice === 'string' ? input.notice.trim() : ''

    if (understandingSummary(existingBlocks) === understandingSummary(next)) {
      // 幂等：同一份草稿重复写入不递增 projectRevision
      if (noticeText !== '') toast(noticeText)
      return {
        ok: true,
        data: {
          materialId: material.materialId,
          blockCount: next.length,
          projectRevision: project.projectRevision,
        },
      }
    }

    const saved = commit(project, () => {
      const others = project.understandingBlocks.filter(
        (block) => block.materialId !== material.materialId || block.materialVersion !== material.version,
      )
      project.understandingBlocks = [...others, ...next]
      // 契约 2.6 / 14.5：递增版本的事件只列了「材料登记」与「草稿条目确认 / 修改 / 删除、
      // 整份确认」，**不含草稿生成**——草稿写入不递增 projectRevision。
      project.updated =
        next.length > 0
          ? `最近更新：生成了 ${next.length} 条理解草稿`
          : '最近更新：这份材料没有生成新的理解草稿'
    })
    if (!saved.ok) return saved

    if (noticeText !== '') {
      toast(noticeText)
    } else if (next.length > 0) {
      toast(`已生成 ${next.length} 条理解草稿，确认后才会用于后续建议`)
    }

    return {
      ok: true,
      data: {
        materialId: material.materialId,
        blockCount: next.length,
        projectRevision: project.projectRevision,
      },
    }
  }

  /**
   * 把一条草稿的状态改成目标值（契约 14.3 / 2.6：确认、撤销确认都按状态变更递增版本）。
   * `commit` 失败时整体回滚，返回值里带失败码。
   */
  function applyBlockStatus(
    block: UnderstandingBlock,
    status: UnderstandingBlockStatus,
    updatedText: string,
  ): ActionResult<UnderstandingBlockResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目')
    }

    const timestamp = nowIso()
    const saved = commit(project, () => {
      project.understandingBlocks = project.understandingBlocks.map((entry) =>
        entry.id === block.id ? { ...entry, status, updatedAt: timestamp } : entry,
      )
      project.projectRevision += 1
      project.updated = updatedText
    })
    if (!saved.ok) return saved

    return {
      ok: true,
      data: { blockId: block.id, status, projectRevision: project.projectRevision },
    }
  }

  /** 契约 14.3 / 2.6：确认单条草稿。重复确认是幂等的（不报错、不改状态、不递增版本） */
  function confirmUnderstandingBlock(
    input: UnderstandingBlockIdInput,
  ): ActionResult<UnderstandingBlockResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法确认理解草稿')
    }

    const located = locateUnderstandingBlock(input.blockId)
    if (!located.ok) return localFailure(located.code, located.message)

    const block = located.value
    if (block.status === 'confirmed') {
      return {
        ok: true,
        data: { blockId: block.id, status: 'confirmed', projectRevision: project.projectRevision },
      }
    }

    const applied = applyBlockStatus(block, 'confirmed', '最近更新：确认了一条理解草稿')
    if (!applied.ok) return applied

    toast('已确认，后续建议会参考这条理解')
    return applied
  }

  /**
   * 撤销确认：把 `confirmed` 退回未确认状态，学生不必先删除再重新生成。
   *
   * 退回到哪个状态按内容判断（契约 14.3 的三种 status 语义）：
   *   - 内容与服务端原文一致 → `pending`（等于还没确认过的候选）；
   *   - 内容被学生改过 → `modified`（保住「这条被改过」的信息）。
   * 未确认的条目调用它是幂等的：不改状态、不递增版本。
   */
  function unconfirmUnderstandingBlock(
    input: UnderstandingBlockIdInput,
  ): ActionResult<UnderstandingBlockResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法撤销确认')
    }

    const located = locateUnderstandingBlock(input.blockId)
    if (!located.ok) return localFailure(located.code, located.message)

    const block = located.value
    if (block.status !== 'confirmed') {
      return {
        ok: true,
        data: { blockId: block.id, status: block.status, projectRevision: project.projectRevision },
      }
    }

    const target = statusAfterUnconfirm(block)
    const applied = applyBlockStatus(
      block,
      target,
      target === 'modified'
        ? '最近更新：撤销确认（这条内容被改过，仍待确认）'
        : '最近更新：撤销确认了一条理解草稿',
    )
    if (!applied.ok) return applied

    toast('已撤销确认，这条理解不会再用于建议，直到你再次确认')
    return applied
  }

  /**
   * 契约 14.3 / 2.6：修改单条草稿正文。
   * 修改后状态是 `modified`——学生要先确认，它才会进入建议与聊天请求（契约 17.2）；
   * 已经确认过的条目被改后同样退回 `modified`，不会"带着旧确认继续下发"。
   */
  function modifyUnderstandingBlock(
    input: ModifyUnderstandingBlockInput,
  ): ActionResult<UnderstandingBlockResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法修改理解草稿')
    }

    const located = locateUnderstandingBlock(input.blockId)
    if (!located.ok) return localFailure(located.code, located.message)

    const content = normalizeBlockContent(input.content)
    if (content === '') {
      return localFailure('INVALID_INPUT', '理解草稿内容不能为空')
    }

    const block = located.value
    if (block.content === content && block.status === 'modified') {
      return {
        ok: true,
        data: { blockId: block.id, status: 'modified', projectRevision: project.projectRevision },
      }
    }

    const timestamp = nowIso()
    const saved = commit(project, () => {
      project.understandingBlocks = project.understandingBlocks.map((entry) =>
        entry.id === block.id
          ? { ...entry, content, status: 'modified', updatedAt: timestamp }
          : entry,
      )
      project.projectRevision += 1
      project.updated = '最近更新：修改了一条理解草稿'
    })
    if (!saved.ok) return saved

    toast('已修改，确认后才会用于后续建议')
    return {
      ok: true,
      data: { blockId: block.id, status: 'modified', projectRevision: project.projectRevision },
    }
  }

  /** 契约 14.3 / 2.6：删除单条草稿 */
  function deleteUnderstandingBlock(
    input: UnderstandingBlockIdInput,
  ): ActionResult<DeleteUnderstandingBlockResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法删除理解草稿')
    }

    const located = locateUnderstandingBlock(input.blockId)
    if (!located.ok) return localFailure(located.code, located.message)

    const block = located.value
    const saved = commit(project, () => {
      project.understandingBlocks = project.understandingBlocks.filter(
        (entry) => entry.id !== block.id,
      )
      project.projectRevision += 1
      project.updated = '最近更新：删除了一条理解草稿'
    })
    if (!saved.ok) return saved

    toast('已删除这条理解草稿')
    return { ok: true, data: { blockId: block.id, projectRevision: project.projectRevision } }
  }

  /** 契约 14.3 / 2.6：整份草稿确认（按材料，只覆盖当前版本） */
  function confirmAllUnderstanding(
    input: ConfirmAllUnderstandingInput,
  ): ActionResult<ConfirmAllUnderstandingResult> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法确认理解草稿')
    }

    const located = locateMaterial(input.materialId)
    if (!located.ok) return localFailure(located.code, located.message)

    const material = located.value
    const targets = understandingBlocksOf(project).filter(
      (block) =>
        block.materialId === material.materialId &&
        block.materialVersion === material.version &&
        block.status !== 'confirmed',
    )

    if (targets.length === 0) {
      // 幂等：没有待确认条目时不改写、不递增版本
      return {
        ok: true,
        data: {
          materialId: material.materialId,
          confirmedCount: 0,
          projectRevision: project.projectRevision,
        },
      }
    }

    const targetIds = new Set(targets.map((block) => block.id))
    const timestamp = nowIso()
    const saved = commit(project, () => {
      project.understandingBlocks = project.understandingBlocks.map((entry) =>
        targetIds.has(entry.id) ? { ...entry, status: 'confirmed', updatedAt: timestamp } : entry,
      )
      project.projectRevision += 1
      project.updated = `最近更新：确认了「${material.name}」的 ${targets.length} 条理解`
    })
    if (!saved.ok) return saved

    toast(`已确认 ${targets.length} 条理解，后续建议会参考它们`)
    return {
      ok: true,
      data: {
        materialId: material.materialId,
        confirmedCount: targets.length,
        projectRevision: project.projectRevision,
      },
    }
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

  /**
   * 旧页面兼容 wrapper：把「步骤 N」翻成一句提问，**走真实聊天接口**。
   *
   * 这里不能直接塞一条预写好的回答：那会让接口故障看起来像"顾问答过了"
   * （契约 6.4 的问答必须真的调用 `POST /api/advisor/chat`）。
   */
  function askAboutStep(stepIndex: number): void {
    const project = current.value
    if (project === undefined) return
    const step = project.steps[stepIndex]
    if (step === undefined) return
    void sendChat(
      `关于步骤 ${stepIndex + 1}「${step.t}」，我想先了解：${step.why.slice(0, 40)}…该怎么开始？`,
    )
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

  /** 聊天状态：与建议状态分开，页面可以独立显示"正在回答"。 */
  const chatLoading = ref(false)
  const chatError = ref<AdvisorApiError | null>(null)
  let chatAbort: AbortController | null = null
  /** 在途聊天序号：只有最后一次请求的响应才允许写入 */
  let chatToken = 0

  /** 取消在途聊天（切换项目、卸载面板时调用），避免旧回答跑到新项目里 */
  function cancelChat(): void {
    chatAbort?.abort()
    chatAbort = null
    chatToken += 1
    chatLoading.value = false
  }

  /** 把顾问回答追加到聊天记录；写盘失败只撤销这一条，不影响已经发出的提问 */
  function appendAssistant(
    text: string,
    source: 'model' | 'fallback' | 'error',
    fallbackReason: string | null,
  ): void {
    const project = current.value
    if (project === undefined) return
    project.chat.push({ who: 'AI 顾问', me: false, text, source, fallbackReason })
    if (!persistOrRollback(() => project.chat.pop())) {
      toast('本地存储不可用，回答没有保存')
    }
  }

  /**
   * 契约 6.4：向顾问提问。
   *
   * 聊天与建议共用同一份项目快照与 v2 字段：
   *   - `projectProfile`（项目基本信息）与 `confirmedMaterials`（**已确认**材料片段）
   *     只在非空时出现，未确认草稿绝不进入请求体（契约 17.2）；
   *   - `promptVersion` 固定 `advisor-chat-v2`（`ADVISOR_CHAT_PROMPT_VERSION`）；
   *   - 响应按 `requestId` / `projectId` / `projectRevision` 三项校验，过期则丢弃；
   *   - 失败时给出可读的中文兜底回答，并保留失败原因供页面展示。
   *
   * 返回 `ActionResult`：页面可以 `void store.sendChat(text)`（只用 toast 与聊天记录），
   * 也可以 `await` 拿到失败码自行处理。
   */
  async function sendChat(
    text: string,
  ): Promise<ActionResult<{ answer: string; source: RecommendationSource }>> {
    const project = current.value
    if (project === undefined) {
      return localFailure('NOT_FOUND', '还没有项目，无法提问')
    }

    const question = text.trim()
    if (question === '') {
      return localFailure('INVALID_INPUT', '请先输入问题')
    }

    const message = { who: '我', me: true, text: question }
    project.chat.push(message)
    // 提问是展示性写入：不递增 projectRevision，写盘失败就撤销这一条
    if (!persistOrRollback(() => project.chat.pop())) {
      toast('本地存储不可用，消息没有保存')
      return localFailure('STORAGE_FULL', '本地存储不可用，消息没有保存')
    }

    // 契约 6.4：历史最多 20 条，按时间正序（当前提问不算历史）
    const chatHistory: AdvisorChatMessage[] = project.chat
      .slice(0, -1)
      .map((entry) => ({
        role: entry.me ? ('user' as const) : ('assistant' as const),
        text: entry.text,
      }))

    const reference = new Date()
    const requestId = createRequestId()
    const requestRevision = computeProjectRevision(project)
    const request = buildAdvisorChatRequest({
      projectId: project.projectId,
      projectRevision: requestRevision,
      projectName: project.name,
      currentMilestone: currentMilestoneName(project),
      tasks: deriveTaskSnapshots(project, reference),
      evidence: deriveEvidenceSnapshots(project, reference),
      doubts: deriveDoubtSnapshots(project, reference),
      question,
      chatHistory,
      // 契约 13.2 / 17.1：只发已确认内容；为空时请求体里不出现这两个字段
      projectProfile: buildProjectProfile(project.profile),
      confirmedMaterials: buildConfirmedMaterials(project),
      requestId,
    })

    // 新提问作废上一次在途请求
    chatAbort?.abort()
    const controller = new AbortController()
    chatAbort = controller
    chatToken += 1
    const token = chatToken
    chatLoading.value = true
    chatError.value = null

    const result = await fetchAdvisorChat(request, { signal: controller.signal })

    // 已经有更新的提问（或项目已切换）时，这次结果一律丢弃
    if (token !== chatToken) {
      return { ok: false, code: 'STALE_RESPONSE', message: '该聊天响应已过期，已丢弃' }
    }

    chatAbort = null
    chatLoading.value = false

    if (!result.ok) {
      chatError.value = result.error
      // 过期响应：静默丢弃，不写聊天记录、不提示用户
      if (isStaleResponseError(result.error)) {
        return { ok: false, code: result.error.code, message: result.error.message }
      }
      // 契约 4.5 / 5.2：失败就如实说失败。
      // 这里**不做**本地假回答——聊天必须真的调用后端，假回复会把接口故障藏起来。
      const reason = describeAdvisorFailure(result.error)
      appendAssistant(
        `顾问暂时回答不了：${reason}你的问题已经保存，稍后可以再问一次。`,
        'error',
        result.error.code,
      )
      toast(reason)
      return { ok: false, code: result.error.code, message: reason }
    }

    // 契约 4.7：项目已切换或状态已变化 → 丢弃响应，不写入聊天记录
    if (
      currentProjectId.value !== project.projectId ||
      computeProjectRevision(project) !== requestRevision
    ) {
      const stale: AdvisorApiError = {
        code: 'STALE_RESPONSE',
        message: '该聊天响应已过期，已丢弃',
        retryable: false,
        retryAfterSeconds: null,
        requestId: result.data.requestId,
        cause: 'stale-response',
      }
      chatError.value = stale
      return { ok: false, code: stale.code, message: stale.message }
    }

    appendAssistant(result.data.answer, result.data.source, result.data.fallbackReason)
    return { ok: true, data: { answer: result.data.answer, source: result.data.source } }
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
      // 契约 13.2 / 17.1：只发学生已确认的内容；未确认草稿绝不进入请求体。
      // 全部为空时这两个字段不会出现在请求体里，行为与 v1.3 完全一致。
      confirmedContext: buildConfirmedContext(project),
      projectProfile: buildProjectProfile(project.profile),
      confirmedMaterials: buildConfirmedMaterials(project),
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
      // 契约 4.7 补充约定 3：旧请求必须结束，不能留下"没有在途请求却永久 loading"。
      // 用 requestId 认领自己那一次 loading：如果已经有更新的请求接管（requestId 不同），
      // 这里就不动它，由新请求负责最终状态。
      const state = advisorByProject.value[projectId]
      if (state?.status === 'loading' && state.requestId === request.requestId) {
        patchAdvisor(projectId, { status: 'idle', requestId: null })
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
    // v2：项目基本信息与材料（契约 13 / 14）
    updateProjectProfile,
    updateProjectBasicInfo,
    registerMaterial,
    uploadMaterialFile,
    requestUnderstanding,
    recordUnderstanding,
    confirmUnderstandingBlock,
    unconfirmUnderstandingBlock,
    modifyUnderstandingBlock,
    deleteUnderstandingBlock,
    confirmAllUnderstanding,
    // 建议请求（契约 3.2）：状态 + 读取器 + action
    advisor,
    aiStatus,
    recommendations,
    aiError,
    // 聊天（契约 6.4）：状态 + 取消
    chatLoading,
    chatError,
    cancelChat,
    // v2 读取器：页面直接读这些，不自己拼状态
    basicInfo,
    projectProfile,
    materials,
    materialSegments,
    materialReadStateMap,
    pendingUnderstandingBlocks,
    modifiedUnderstandingBlocks,
    confirmedUnderstandingBlocks,
    confirmedContext,
    confirmedMaterials,
  }
})
