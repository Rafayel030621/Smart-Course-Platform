<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AiStatus from '@/components/AiStatus.vue'
import CloudProjectWorkbench from '@/components/CloudProjectWorkbench.vue'
import EvidenceForm from '@/components/EvidenceForm.vue'
import MaterialUploader from '@/components/MaterialUploader.vue'
import ProjectCreate from '@/components/ProjectCreate.vue'
import ProjectProfileForm from '@/components/ProjectProfileForm.vue'
import RecommendationList from '@/components/RecommendationList.vue'
import UnderstandingDraftCard from '@/components/UnderstandingDraftCard.vue'
import {
  materialParseStateText,
  materialReadStateText,
  understandingDraftViewOf,
  type DraftSource,
  type MaterialFileType,
  type UnderstandingDraftView,
} from '@/components/materialTypes'
import { CHINESE_NUM, WEEK_LABELS, useWorkbenchStore } from '@/stores/workbench'
import { usePlatformStore } from '@/stores/platform'
import { deriveDoubtSnapshots, deriveEvidenceSnapshots, toDisplayTime } from '@/domain/activity'
import { deriveTaskSnapshots, findClaimedTaskFor, taskStatusText } from '@/domain/progress'
import {
  MAX_ADVISOR_CHAT_QUESTION_LENGTH,
  type ActionResult,
  type Recommendation,
  type SubmitEvidenceInput,
} from '@/domain/recommendation'
import { blocksOfMaterial, understandingBlockKey } from '@/domain/materials'
import type { ChatMessage, Material, Milestone, SuggestedStep } from '@/types/platform'

/**
 * 工作台
 * ----------------------------------------------------------------------------
 * 没有项目时是创建页；有项目时是三栏工作台：
 *   左栏  我的项目 / 项目资料（真实 MD、TXT 上传）/ 项目基本信息 /
 *         材料理解草稿 / 里程碑进度 / 近 4 周活跃度 / 未解决的疑问
 *   中栏  AI 下一步建议 / AI 项目顾问（步骤与真实状态）/ 项目地图入口 / 向顾问提问
 *   右栏  提交步骤证据 / 最近证据
 *
 * 三条硬规则（本轮验收要求）：
 *   1. 页面**只挂真实运行的组件**：建议区是 `AiStatus` + `RecommendationList`，
 *      证据是 `EvidenceForm`，材料入口是 `MaterialUploader`，草稿是 `UnderstandingDraftCard`；
 *      这里（以及任何组件）都不再提供"只登记文件名"的旧入口。
 *   2. 一切定位都用稳定 ID：认领、提问按真实 `taskId`，草稿按本地 `blockId`，
 *      不按数组下标，也不用页面内存里的 claimedIds 猜持久化状态。
 *   3. 页面只显示自然中文：模型 / 服务端规则 / 本地规则如实区分，
 *      不展示内部字段名、错误码、路径或原始报文。
 */

const store = useWorkbenchStore()
const platform = usePlatformStore()
const router = useRouter()

const project = computed(() => store.current)

/* ------------------------------------------------------------ 流程条 */

const flowNodes = computed(() =>
  (project.value?.ms ?? []).map((m, i) => ({
    ...m,
    label: CHINESE_NUM[i],
    sub: m.s === 'done' ? '已完成' : m.s === 'cur' ? `${m.sub} · ${m.p}%` : '未开始',
  })),
)

/* -------------------------------------------------------- 里程碑徽标 */

function badge(m: Milestone, i: number) {
  if (m.s === 'done') return { cls: 'ms-dot ms-done', text: '✓' }
  if (m.s === 'cur') return { cls: 'ms-dot ms-cur', text: String(i + 1) }
  return { cls: 'ms-dot ms-todo', text: String(i + 1) }
}

/* ------------------------------------------------------------ 活跃度 */

const weekBars = computed(() => {
  const list = project.value?.weekly ?? [0, 0, 0, 0]
  const max = Math.max(...list, 1)
  return list.map((value, i) => ({
    value,
    height: Math.round((value / max) * 70),
    label: WEEK_LABELS[i].slice(5),
    hot: i === list.length - 1,
  }))
})

/* -------------------------------------------------------- 下一步建议 */

/** 服务端规则兜底的原因 → 人话（未知原因不给用户看内部码） */
const FALLBACK_REASON_TEXT: Record<string, string> = {
  MODEL_TIMEOUT: '模型响应超时',
  MODEL_UNAVAILABLE: '模型服务暂时不可用',
  MODEL_NOT_CONFIGURED: '服务端还没接入模型',
  INVALID_MODEL_OUTPUT: '模型返回的内容不符合要求',
  RATE_LIMITED: '请求太频繁',
}

/** 兜底原因码 → 中文；未登记的码返回空串（页面只说"系统规则参考"） */
function fallbackReasonTextOf(code: string | null | undefined): string {
  if (code === null || code === undefined) return ''
  return FALLBACK_REASON_TEXT[code] ?? ''
}

/** 错误码 → 人话（含适配层的前端内部码） */
const ERROR_TEXT: Record<string, string> = {
  INVALID_INPUT: '当前项目数据不符合接口要求',
  RATE_LIMITED: '请求太频繁，稍等再试',
  MODEL_TIMEOUT: '模型响应超时',
  INVALID_MODEL_OUTPUT: '模型返回的内容不符合要求',
  MODEL_UNAVAILABLE: '模型服务暂时不可用',
  MODEL_NOT_CONFIGURED: '服务端还没接入模型',
  NETWORK_ERROR: '连不上后端服务',
  INTERNAL: '服务端内部错误',
  STALE_REVISION: '项目版本和服务端对不上',
  UNAUTHORIZED: '没有通过服务端校验',
}

/**
 * store action 失败码 → 人话（契约 3.3 / 5.2：不把英文错误码直接给用户）。
 * 页面只看 `ok` 和 `code`，不通过 toast 文案判断是否成功。
 */
const ACTION_ERROR_TEXT: Record<string, string> = {
  INVALID_INPUT: '请补充必填信息或检查输入长度',
  NOT_FOUND: '这条内容已经不存在，请刷新后重试',
  PROJECT_MISMATCH: '当前项目已变化，请重新加载',
  TASK_NOT_CLAIMABLE: '该任务已经完成',
  STORAGE_FULL: '本地存储空间不足，当前填写的内容已保留',
  NETWORK_ERROR: '后端暂时不可用',
  STALE_RESPONSE: '这条结果已经过期，请重新获取',
  INTERNAL: '服务端内部错误',
  STALE_REVISION: '项目版本和服务端对不上',
  UNAUTHORIZED: '没有通过服务端校验',
}

/** `ALREADY_RESOLVED` 是静默成功语义：不报错、不弹提示 */
function notifyFailure(result: ActionResult<unknown>): void {
  if (result.ok) return
  if (result.code === 'ALREADY_RESOLVED') return
  store.toast(ACTION_ERROR_TEXT[result.code] ?? '操作没有完成，请稍后再试')
}

const isRequesting = computed(() => store.aiStatus === 'loading')

/** 空白项目：没有任何任务 / 证据 / 疑问 / 材料（只由真实数据判断） */
const isBlankProject = computed(
  () =>
    project.value !== undefined &&
    project.value.tasks.length === 0 &&
    project.value.evidenceRecords.length === 0 &&
    project.value.doubtRecords.length === 0 &&
    (project.value.materialRecords ?? []).length === 0 &&
    (project.value.materials ?? []).length === 0,
)

/** 兜底 / 失败原因：优先用响应里的 fallbackReason，其次用适配层保留的错误码 */
const reasonText = computed(() => {
  const fallbackReason = store.advisor.fallbackReason
  if (fallbackReason !== null) {
    const text = FALLBACK_REASON_TEXT[fallbackReason]
    if (text !== undefined) return text
  }

  const code = store.aiError?.code
  if (code !== undefined) {
    const text = ERROR_TEXT[code]
    if (text !== undefined) return text
  }
  return '原因未知'
})

const statusLine = computed(() => {
  switch (store.aiStatus) {
    case 'idle':
      return '还没有建议。点一下「获取建议」，AI 会结合项目当前状态、最近证据和未解决的疑问，给出 1～3 条下一步建议。'
    case 'loading':
      return '正在分析项目状态…'
    case 'model':
      return '以下建议由 AI 模型生成。展开「依据」可以看到它引用的是哪条证据或疑问。'
    case 'fallback':
      return `模型这次没能给出结果，下面是服务端规则生成的参考建议（原因：${reasonText.value}）。`
    case 'local-rule':
      return `后端这次不可用，下面是本地规则生成的参考建议（原因：${reasonText.value}）。`
    case 'error':
      return `建议没有生成出来：${reasonText.value}。可以重试，也可以先按自己的判断推进。`
    default:
      return ''
  }
})

const aiTone = computed<'neutral' | 'loading' | 'model' | 'fallback' | 'local-rule' | 'error'>(() => {
  switch (store.aiStatus) {
    case 'loading':
      return 'loading'
    case 'model':
      return 'model'
    case 'fallback':
      return 'fallback'
    case 'local-rule':
      return 'local-rule'
    case 'error':
      return 'error'
    default:
      return 'neutral'
  }
})

const statusTag = computed(() => {
  switch (store.aiStatus) {
    case 'idle':
      return '未获取'
    case 'loading':
      return '分析中'
    case 'model':
      return 'AI 模型'
    case 'fallback':
      return '服务端规则'
    case 'local-rule':
      return '本地规则'
    case 'error':
      return '生成失败'
    default:
      return ''
  }
})

const requestLabel = computed(() => {
  if (isBlankProject.value) return '等待项目内容'
  if (isRequesting.value) return '分析中…'
  if (store.aiStatus === 'idle') return '获取建议'
  if (store.aiStatus === 'error' || store.aiStatus === 'local-rule') return '重试'
  return '重新获取'
})

/** 契约 6.1：只有 RATE_LIMITED 会给具体秒数，这里只做一句静态提示，不做倒计时 */
const retryAfterText = computed(() => {
  const seconds = store.aiError?.retryAfterSeconds
  return typeof seconds === 'number' && seconds > 0 ? `建议等待 ${seconds} 秒后再试` : ''
})

/**
 * 获取建议。空白项目不发请求：没有任务、证据、疑问和材料时，
 * 先让用户补内容（store 的本地规则也会给出「先补基本信息」这一条）。
 */
async function requestSuggestions() {
  if (isRequesting.value) return
  if (isBlankProject.value) {
    store.toast('项目还没有内容：先填写项目基本信息，或上传一份 MD / TXT 材料。')
    return
  }

  try {
    const result = await store.refreshRecommendations({ forceRefresh: store.aiStatus !== 'idle' })
    if (!result.ok) notifyFailure(result)
  } catch (error: unknown) {
    // store 内部已处理绝大多数失败，这里只兜住"请求还没发出去就出错"的异常
    console.warn('[建议] 请求未能完成', error instanceof Error ? error.name : 'unknown')
    store.toast('建议请求没能完成，请稍后再试')
  }
}

/* ------------------------------------------------- 建议 → 真实任务状态 */

/**
 * 把建议里的 ID 解析回本地数据。
 * 复用 domain 里那套派生函数（ID 的生成规则只有一处），所以解析结果与发出请求时的 ID 必然一致；
 * 这里不自己解析 ID 字符串。
 */
const derived = computed(() => {
  const p = project.value
  if (!p) return null

  const reference = new Date()
  const tasks = deriveTaskSnapshots(p, reference)
  const evidence = deriveEvidenceSnapshots(p, reference)
  const doubts = deriveDoubtSnapshots(p, reference)

  return {
    /** 任务快照：认领与「确认完成」都用它提供的真实 taskId */
    tasks,
    /** 未解决疑问：列表与依据反查共用同一份（只含 open） */
    doubts,
    /** evidenceId → 可读内容。展示时间由 domain 格式化，页面不自己拼时间 */
    evidenceById: new Map(
      evidence.map((item) => [
        item.evidenceId,
        { id: item.evidenceId, time: toDisplayTime(item.createdAt), text: item.didWhat },
      ]),
    ),
    doubtById: new Map(doubts.map((item) => [item.doubtId, { id: item.doubtId, text: item.text }])),
  }
})

/** 左栏「未解决的疑问」：用结构化疑问的真实 ID（只含 open） */
const openDoubts = computed(() => derived.value?.doubts ?? [])

/** 右栏「最近证据」：结构与后端快照同源 */
const recentEvidence = computed(() => project.value?.evidence ?? [])

/** 切换项目用稳定 projectId，不用数组下标 */
function onSelectProject(projectId: string) {
  const result = store.selectProject(projectId)
  if (!result.ok) notifyFailure(result)
}

type ClaimState = 'claimable' | 'claimed' | 'done' | 'draft'

/**
 * 认领状态只按**当前项目的真实任务状态**判断（不按下标、不看页面内存）：
 *   - 对应的任务已经进入项目（进行中 / 已完成）→ 直接显示真实状态并禁用按钮；
 *   - 还没进入项目 → 显示「认领这一步」。
 * 因此切换项目、刷新页面、重新获取建议之后状态都不会回退。
 */
function claimStateOf(suggestion: Recommendation): ClaimState {
  const p = project.value
  if (p === undefined) return suggestion.existingTaskId === null ? 'draft' : 'claimable'

  const task = findClaimedTaskFor(p, suggestion)
  if (task === null) return suggestion.existingTaskId === null ? 'draft' : 'claimable'
  return task.status === 'done' ? 'done' : 'claimed'
}

const suggestionViews = computed(() =>
  store.recommendations.map((suggestion, index) => {
    const d = derived.value
    return {
      suggestion,
      index,
      claimState: claimStateOf(suggestion),
      evidence:
        d === null
          ? []
          : suggestion.basisEvidenceIds.map(
              (id) => d.evidenceById.get(id) ?? { id, time: '', text: '（本次请求里没有这条证据）' },
            ),
      doubts:
        d === null
          ? []
          : suggestion.basisDoubtIds.map(
              (id) => d.doubtById.get(id) ?? { id, text: '（本次请求里没有这条疑问）' },
            ),
    }
  }),
)

/**
 * 契约 5.4：建议 → 任务。
 * - existingTaskId 非空 → claimTask({ taskId })
 * - existingTaskId 为 null → 新任务候选，claimTask({ draft })，由 store 生成稳定 taskId 并直接置为 doing
 * 页面不判断任务状态、不自己造任务、不碰进度；重复认领由 store 保证幂等。
 */
function claimSuggestion(suggestion: Recommendation) {
  const state = claimStateOf(suggestion)
  if (state === 'claimed' || state === 'done') {
    store.toast(state === 'done' ? '该任务已完成' : '该任务已认领，完成后请提交证据')
    return
  }

  const result =
    suggestion.existingTaskId === null
      ? store.claimTask({
          draft: {
            title: suggestion.title,
            doneCriteria: suggestion.doneCriteria,
            requestId: suggestion.requestId,
            basisEvidenceIds: [...suggestion.basisEvidenceIds],
            basisDoubtIds: [...suggestion.basisDoubtIds],
          },
        })
      : store.claimTask({ taskId: suggestion.existingTaskId })

  if (!result.ok) notifyFailure(result)
}

/** 契约 3.2：resolveDoubt 用真实 doubtId。重复解决（ALREADY_RESOLVED）保持安静 */
function resolveDoubtById(doubtId: string) {
  const result = store.resolveDoubt(doubtId)
  if (!result.ok) notifyFailure(result)
}

/* ------------------------------------------------------- AI 项目顾问步骤 */

/** 顾问区的步骤卡：认领按稳定 taskId（store 内部走同一个 claimTask） */
function claimStep(step: SuggestedStep) {
  if (step.taskId === undefined) {
    store.toast('这一步还没有对应的任务，请重新获取建议')
    return
  }
  if (step.status === 'done') {
    store.toast('该任务已完成')
    return
  }
  if (step.status === 'doing') {
    store.toast('该任务已认领，完成后请提交证据')
    return
  }
  const result = store.claimTask({ taskId: step.taskId })
  if (!result.ok) notifyFailure(result)
}

function stepClaimLabel(step: SuggestedStep): string {
  if (step.status === 'done') return '已完成'
  if (step.status === 'doing') return '已认领 · 进行中'
  return '认领这一步'
}

/** 「就此提问」：按稳定 taskId 定位，走真实聊天接口 */
function askStep(step: SuggestedStep) {
  if (step.taskId === undefined) {
    store.toast('这一步还没有对应的任务，请重新获取建议')
    return
  }
  store.askAboutStep(step.taskId)
}

/* -------------------------------------------------------------- 材料 */

const materialInput = ref<InstanceType<typeof MaterialUploader> | null>(null)

type MaterialStage = 'idle' | 'uploading' | 'parsed' | 'error'
const materialStage = ref<MaterialStage>('idle')
const materialBusy = ref(false)
const materialError = ref<string | null>(null)
const materialNotice = ref<string | null>(null)
/** 失败后保留原始文件，重试复用同一个 File（不重新读盘） */
const lastFailedFile = ref<{ file: File; materialId?: string } | null>(null)

/** 材料行：真实材料记录 + 只登记过文件名的历史条目（正文未读取） */
interface MaterialRow {
  key: string
  name: string
  parseText: string
  readText: string
  versionText: string
  segmentText: string
  canGenerate: boolean
  material: Material | null
}

function segmentCountOf(material: Material): number {
  return store.materialSegments.filter(
    (segment) =>
      segment.materialId === material.materialId && segment.materialVersion === material.version,
  ).length
}

const materialRows = computed<MaterialRow[]>(() => {
  const rows: MaterialRow[] = store.materials.map((material) => {
    const segments = segmentCountOf(material)
    const readState = store.materialReadStateMap[material.materialId] ?? 'registered'
    return {
      key: material.materialId,
      name: material.name,
      parseText:
        material.state === 'parse_failed'
          ? `解析失败：${material.failureReason ?? '请检查文件内容后重试'}`
          : materialParseStateText(material),
      readText: materialReadStateText(readState),
      versionText: material.version > 1 ? `第 ${material.version} 版` : '',
      segmentText: segments > 0 ? `${segments} 个片段` : '',
      canGenerate: material.state === 'parsed' && !material.needsReupload && segments > 0,
      material,
    }
  })

  // 旧数据里只登记过文件名的条目：如实标注"正文未读取"，不冒充已解析
  const known = new Set(rows.map((row) => row.name))
  for (const item of project.value?.materials ?? []) {
    if (known.has(item.name)) continue
    rows.push({
      key: `legacy-${item.name}`,
      name: item.name,
      parseText: '仅登记，正文未读取',
      readText: '仅登记文件名',
      versionText: '',
      segmentText: '',
      canGenerate: false,
      material: null,
    })
  }

  return rows
})

async function uploadFile(payload: { file: File; materialId?: string }): Promise<void> {
  materialBusy.value = true
  materialStage.value = 'uploading'
  materialError.value = null
  materialNotice.value = null
  lastFailedFile.value = { file: payload.file, materialId: payload.materialId }

  try {
    const input: Parameters<typeof store.uploadMaterialFile>[0] = {
      // 直接传原始 File：由 store 的适配层读原始字节再编 base64。
      // 页面**不**调用 file.text()，否则 GBK 字节会被破坏。
      file: payload.file,
      name: payload.file.name,
    }
    if (payload.materialId !== undefined) input.materialId = payload.materialId

    const result = await store.uploadMaterialFile(input)
    if (!result.ok) {
      materialStage.value = 'error'
      materialError.value = result.message
      return
    }

    materialStage.value = 'parsed'
    lastFailedFile.value = null
    materialNotice.value =
      result.data.version > 1
        ? `「${payload.file.name}」已更新到第 ${result.data.version} 版，解析出 ${result.data.segmentCount} 个片段；可以重新生成理解草稿。`
        : `「${payload.file.name}」解析成功，共 ${result.data.segmentCount} 个片段；生成理解草稿后需要逐条确认。`
  } catch (error: unknown) {
    // store 内部已把契约失败转成 ActionResult；这里只兜住"请求还没发出就抛"的异常
    console.warn('[材料] 上传未能完成', error instanceof Error ? error.name : 'unknown')
    materialStage.value = 'error'
    materialError.value = '上传没有完成，请检查网络后重试。'
  } finally {
    materialBusy.value = false
  }
}

function onMaterialUpload(payload: { file: File; type: MaterialFileType; materialId?: string }) {
  void uploadFile({ file: payload.file, materialId: payload.materialId })
}

function retryMaterialUpload() {
  const pending = lastFailedFile.value
  if (pending === null) return
  void uploadFile(pending)
}

/** 材料列表里的「重新上传」：同一个材料 ID 换新版本（version + 1） */
function replaceMaterial(materialId: string) {
  materialInput.value?.chooseReplace(materialId)
}

/* ------------------------------------------- 工作台视图标签（推进 / 资料） */

/**
 * 工作台内部两个视图：
 *   - 项目推进：日常推进（建议、任务、问答、证据、里程碑、疑问、活跃度）；
 *   - 项目资料：项目基本信息、材料列表与**当前材料**的理解草稿。
 *
 * 为什么用标签：原来把基本信息表单和全部材料的草稿都塞在 280px 侧栏，
 * 侧栏无限变长、草稿挤在窄栏里读不了。标签让每一屏只承担一类任务，
 * 资料页因此能拿到主体宽度。
 *
 * 两个面板都用 `hidden` 而不是 `v-if`：切换标签不能卸载组件，
 * 否则未保存的表单输入、草稿编辑文字与聊天输入都会被丢掉。
 */
type WorkbenchTab = 'progress' | 'data'

const TABS: ReadonlyArray<{ key: WorkbenchTab; label: string }> = [
  { key: 'progress', label: '项目推进' },
  { key: 'data', label: '项目资料' },
]

const activeTab = ref<WorkbenchTab>('progress')

function selectTab(tab: WorkbenchTab): void {
  activeTab.value = tab
}

/** 标签页键盘操作：左右方向键循环，Home / End 到首尾（tablist 的标准行为） */
function onTabKeydown(event: KeyboardEvent, index: number): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()

  let next = index
  if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
  if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = TABS.length - 1

  const target = TABS[next]
  if (target === undefined) return
  activeTab.value = target.key
  void nextTick(() => document.getElementById(`wb-tab-${target.key}`)?.focus())
}

/** 当前选中的材料：资料页右栏只展示它的草稿，避免一次展开所有材料的全部条目 */
const selectedMaterialId = ref('')

const selectedMaterial = computed<Material | null>(
  () => store.materials.find((material) => material.materialId === selectedMaterialId.value) ?? null,
)

/** 某一材料的草稿计数（待确认 = 未确认 + 已修改，只有已确认才进 AI 上下文） */
function draftCountsOf(materialId: string): { pending: number; confirmed: number; total: number } {
  const blocks = (project.value?.understandingBlocks ?? []).filter(
    (block) => block.materialId === materialId,
  )
  return {
    pending: blocks.filter((block) => block.status !== 'confirmed').length,
    confirmed: blocks.filter((block) => block.status === 'confirmed').length,
    total: blocks.length,
  }
}

/**
 * 资料摘要：全部从真实状态推导（store 的当前项目读取器），不写死。
 * `materials` 只算 v2 真实上传的材料；只登记过文件名的历史条目单独计数。
 */
const dataSummary = computed(() => ({
  materials: store.materials.length,
  pending: store.pendingUnderstandingBlocks.length + store.modifiedUnderstandingBlocks.length,
  confirmed: store.confirmedUnderstandingBlocks.length,
  legacy: materialRows.value.filter((row) => row.material === null).length,
}))

/** 任务计数：推进页摘要与地图入口共用同一份真实数据 */
const taskCounts = computed(() => {
  const tasks = project.value?.tasks ?? []
  return {
    doing: tasks.filter((task) => task.status === 'doing').length,
    done: tasks.filter((task) => task.status === 'done').length,
    todo: tasks.filter((task) => task.status === 'todo').length,
  }
})

/** 材料列表变化后保证选中的材料仍属于当前项目；失效时选第一份 */
watch(
  () => store.materials.map((material) => material.materialId).join(','),
  () => {
    if (store.materials.some((material) => material.materialId === selectedMaterialId.value)) return
    const first = store.materials[0]
    selectedMaterialId.value = first === undefined ? '' : first.materialId
  },
  { immediate: true },
)

function selectMaterial(materialId: string): void {
  selectedMaterialId.value = materialId
}

/** 还有待确认内容的材料（优先打开它）；没有则退到第一份材料 */
function firstMaterialToConfirm(): Material | null {
  const materials = store.materials
  const hit = materials.find((material) => draftCountsOf(material.materialId).pending > 0)
  return hit ?? materials[0] ?? null
}

/** 「去确认」：切到项目资料、选中那条材料，并把材料详情滚进视野 */
async function goConfirmMaterials(): Promise<void> {
  const target = firstMaterialToConfirm()
  activeTab.value = 'data'
  if (target !== null) selectedMaterialId.value = target.materialId
  await nextTick()
  const detail = document.getElementById('wb-data-detail')
  detail?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/**
 * 未提交的草稿编辑按 **项目 + 材料 + 材料版本** 隔离：
 * 切换材料时卡片把没保存的文字交回来，切回**同一份材料同一版本**时才还给卡片，
 * 不静默丢弃用户已经打好的内容。
 *
 * 两个边界：
 *   - 材料重新上传（version + 1）后旧缓存失效：旧版本的文字不能落到新版本的条目上；
 *   - 缓存里同时记住条目原文 `original`，条目被删除或被重新生成替换后不再恢复
 *     （卡片会再比对一次原文，双保险）。
 */
interface PendingDraftEdit {
  itemId: string
  text: string
  /** 缓存时该条目的原文 */
  original: string
}

const pendingDraftEdits = ref<Record<string, PendingDraftEdit>>({})

function pendingEditKey(materialId: string, materialVersion: number): string {
  return `${project.value?.projectId ?? ''}::${materialId}::${materialVersion}`
}

function pendingEditOf(material: Material | null): PendingDraftEdit | null {
  if (material === null) return null
  return pendingDraftEdits.value[pendingEditKey(material.materialId, material.version)] ?? null
}

function rememberAbortedEdit(payload: {
  materialId: string
  materialVersion: number
  itemId: string
  text: string
  original: string
}): void {
  if (payload.text.trim() === '') return
  pendingDraftEdits.value = {
    ...pendingDraftEdits.value,
    [pendingEditKey(payload.materialId, payload.materialVersion)]: {
      itemId: payload.itemId,
      text: payload.text,
      original: payload.original,
    },
  }
  store.toast('这条修改还没有保存，已保留；切回这份材料可以继续改。')
}

/**
 * 清掉某份材料当前版本的缓存：确认、撤销确认、删除、保存修改、重新生成之后，
 * 那段未提交文字已经不再适用，留着会让旧内容复活。
 */
function clearRememberedEdit(materialId: string, materialVersion: number): void {
  const key = pendingEditKey(materialId, materialVersion)
  if (pendingDraftEdits.value[key] === undefined) return
  const next = { ...pendingDraftEdits.value }
  delete next[key]
  pendingDraftEdits.value = next
}

/** 提交修改：先清掉「保留的未提交编辑」，再走原有的按 blockId 提交 */
function onDraftEdited(payload: {
  materialId: string
  materialVersion: number
  itemId: string
  text: string
}): void {
  // 缓存由 editDraftItem 在**写入成功之后**清理：失败时用户切回来还能接着改
  editDraftItem(payload)
}

/* --------------------------------------------------- 材料理解草稿（M2-A） */

type UnderstandingPhase = 'idle' | 'loading' | 'done' | 'error'

interface UnderstandingState {
  phase: UnderstandingPhase
  source: DraftSource | null
  notice: string | null
  errorText: string | null
}

/** 草稿请求状态按「材料 + 版本」存：换材料 / 换版本后旧结果不会被应用到新对象 */
const understandingByKey = ref<Record<string, UnderstandingState>>({})

function understandingKeyOf(material: Material): string {
  return `${material.materialId}@${material.version}`
}

function understandingStateOf(material: Material): UnderstandingState {
  return (
    understandingByKey.value[understandingKeyOf(material)] ?? {
      phase: 'idle',
      source: null,
      notice: null,
      errorText: null,
    }
  )
}

function patchUnderstanding(key: string, patch: UnderstandingState): void {
  understandingByKey.value = { ...understandingByKey.value, [key]: patch }
}

async function generateUnderstanding(material: Material): Promise<void> {
  const key = understandingKeyOf(material)
  patchUnderstanding(key, { phase: 'loading', source: null, notice: null, errorText: null })

  try {
    const result = await store.requestUnderstanding({ materialId: material.materialId })

    // 结果只应用到发起时的那个材料版本；期间换项目 / 换版本就丢弃
    const latest = store.materials.find((item) => item.materialId === material.materialId)
    if (latest === undefined || latest.version !== material.version) return

    if (!result.ok) {
      patchUnderstanding(key, {
        phase: 'error',
        source: null,
        notice: null,
        errorText: result.message,
      })
      return
    }

    patchUnderstanding(key, {
      phase: 'done',
      source: result.data.source,
      notice: result.data.notice,
      errorText: null,
    })

    // 重新生成是整体替换：上一版草稿的未提交文字不再适用，避免挂到被替换的条目上
    clearRememberedEdit(material.materialId, material.version)
  } catch (error: unknown) {
    console.warn('[材料] 理解请求未能完成', error instanceof Error ? error.name : 'unknown')
    patchUnderstanding(key, {
      phase: 'error',
      source: null,
      notice: null,
      errorText: '生成理解草稿没有完成，请稍后重试。',
    })
  }
}

/**
 * 当前材料的草稿投影：资料页只渲染**这一份**材料的草稿，
 * 不再把每份材料的全部条目一次性铺开（那正是原来把窄栏撑爆的原因）。
 * 条目状态与来源仍然全部来自 store，页面只做投影。
 */
const selectedDraft = computed(() => {
  const p = project.value
  const material = selectedMaterial.value
  if (p === undefined || material === null) {
    return {
      draft: null as UnderstandingDraftView | null,
      state: {
        phase: 'idle' as UnderstandingPhase,
        source: null,
        notice: null,
        errorText: null,
      },
      canGenerate: false,
    }
  }

  return {
    draft: understandingDraftViewOf(material, blocksOfMaterial(p, material.materialId)),
    state: understandingStateOf(material),
    canGenerate:
      materialRows.value.find((row) => row.material?.materialId === material.materialId)?.canGenerate ===
      true,
  }
})

/** 当前材料在列表里的片段文案（详情头部复用，模板里不再重复 find） */
const selectedRowText = computed(() => {
  const material = selectedMaterial.value
  if (material === null) return ''
  const row = materialRows.value.find((item) => item.material?.materialId === material.materialId)
  return row?.segmentText ?? ''
})

/**
 * 卡片发来的是「材料 + 版本 + 服务端 itemId」，store 的操作需要**本地稳定 blockId**。
 * 这里按三项身份反查本地条目：找不到就说明这条已经不存在（不猜、不新建）。
 */
function blockIdOf(payload: {
  materialId: string
  materialVersion: number
  itemId: string
}): string | null {
  const all = [
    ...store.pendingUnderstandingBlocks,
    ...store.modifiedUnderstandingBlocks,
    ...store.confirmedUnderstandingBlocks,
  ]
  const hit = all.find(
    (block) =>
      block.materialId === payload.materialId &&
      block.materialVersion === payload.materialVersion &&
      block.itemId === payload.itemId,
  )
  if (hit !== undefined) return hit.id

  // 兜底：按本地 id 规则推导（(materialId, kind, itemId) 的拼法只有一处实现）
  const kinds = ['goalCandidates', 'outcomeCandidates', 'dataNotes', 'methodNotes', 'openQuestions'] as const
  for (const kind of kinds) {
    const candidate = understandingBlockKey(payload.materialId, kind, payload.itemId)
    if (all.some((block) => block.id === candidate)) return candidate
  }
  return null
}

function confirmDraftItem(payload: { materialId: string; materialVersion: number; itemId: string }) {
  const blockId = blockIdOf(payload)
  if (blockId === null) {
    // 条目已经不在：这段未提交文字也不该再留着
    clearRememberedEdit(payload.materialId, payload.materialVersion)
    store.toast('这条理解已经不存在，请重新生成理解草稿')
    return
  }
  const result = store.confirmUnderstandingBlock({ blockId })
  if (!result.ok) {
    notifyFailure(result)
    return
  }
  clearRememberedEdit(payload.materialId, payload.materialVersion)
}

function undoDraftItem(payload: { materialId: string; materialVersion: number; itemId: string }) {
  const blockId = blockIdOf(payload)
  if (blockId === null) {
    clearRememberedEdit(payload.materialId, payload.materialVersion)
    store.toast('这条理解已经不存在，请重新生成理解草稿')
    return
  }
  const result = store.unconfirmUnderstandingBlock({ blockId })
  if (!result.ok) {
    notifyFailure(result)
    return
  }
  clearRememberedEdit(payload.materialId, payload.materialVersion)
}

function editDraftItem(payload: {
  materialId: string
  materialVersion: number
  itemId: string
  text: string
}) {
  const blockId = blockIdOf(payload)
  if (blockId === null) {
    clearRememberedEdit(payload.materialId, payload.materialVersion)
    store.toast('这条理解已经不存在，请重新生成理解草稿')
    return
  }
  const result = store.modifyUnderstandingBlock({ blockId, content: payload.text })
  if (!result.ok) {
    // 提交失败：保留缓存，用户切回这份材料还能接着改
    notifyFailure(result)
    return
  }
  clearRememberedEdit(payload.materialId, payload.materialVersion)
}

function removeDraftItem(payload: { materialId: string; materialVersion: number; itemId: string }) {
  const blockId = blockIdOf(payload)
  if (blockId === null) {
    clearRememberedEdit(payload.materialId, payload.materialVersion)
    store.toast('这条理解已经不存在')
    return
  }
  const result = store.deleteUnderstandingBlock({ blockId })
  if (!result.ok) {
    notifyFailure(result)
    return
  }
  clearRememberedEdit(payload.materialId, payload.materialVersion)
}

function confirmDraftAll(payload: { materialId: string; materialVersion: number }) {
  const result = store.confirmAllUnderstanding({ materialId: payload.materialId })
  if (!result.ok) {
    notifyFailure(result)
    return
  }
  clearRememberedEdit(payload.materialId, payload.materialVersion)
}

/* -------------------------------------------------------------- 问答 */

const chatText = ref('')
const chatLog = ref<HTMLElement | null>(null)
/** 上一次提问：失败后可以一键重发（store 不会重复记录同一个问题） */
const lastQuestion = ref('')

const chatTooLong = computed(() => chatText.value.trim().length > MAX_ADVISOR_CHAT_QUESTION_LENGTH)

async function sendChat(text: string): Promise<void> {
  const question = text.trim()
  if (question === '') return
  if (question.length > MAX_ADVISOR_CHAT_QUESTION_LENGTH) {
    store.toast(`问题不能超过 ${MAX_ADVISOR_CHAT_QUESTION_LENGTH} 字，请精简后再问。`)
    return
  }
  if (store.chatLoading) {
    store.toast('上一条提问还在回答中，请等回答出来再问。')
    return
  }

  lastQuestion.value = question
  if (chatText.value.trim() === question) chatText.value = ''
  await store.sendChat(question)
  await scrollChat()
}

function submitChat() {
  void sendChat(chatText.value)
}

function retryChat() {
  if (lastQuestion.value === '') return
  void sendChat(lastQuestion.value)
}

async function scrollChat() {
  await nextTick()
  if (chatLog.value) chatLog.value.scrollTop = chatLog.value.scrollHeight
}

watch(() => project.value?.chat.length, scrollChat)

/** 回答来源如实标注：AI 模型生成 / 服务端规则参考 / 本地规则参考 */
function chatSourceText(message: ChatMessage): string {
  if (message.me || message.source === undefined) return ''
  if (message.source === 'model') return 'AI 生成'
  if (message.source === 'fallback') {
    const reason = fallbackReasonTextOf(message.fallbackReason)
    return reason !== '' ? `系统规则参考（原因：${reason}）` : '系统规则参考'
  }
  return '本地规则参考'
}

/**
 * 契约 23.7 / prompt-spec §10.7、§11.7：只有**非空**引用才显示材料来源。
 *
 * 展示口径与 §10.7 完全一致：
 *   - 单条：`《实验手册.md》第 12–18 行`；单行写 `第 40 行`，不写 `40–40`；
 *   - 多条：**分别列出、不合并**（同一份材料的多个片段也各写一句）；
 *   - 不显示 `materialId` / `segmentId` / `itemId`，也不在文案里追加版本号
 *     （版本仍保留在数据层，供引用模型与去重使用）；
 *   - 空数组（含适配层把非法引用逐条剔除后变成空）返回空串：不渲染标签，
 *     也不出现"依据来自某材料"这类暗示（§11.7 最后一条）；前端不从本地材料补造引用。
 */
function chatCitationsText(message: ChatMessage): string {
  if (message.me || message.citations.length === 0) return ''

  const parts = message.citations.map((ref) =>
    ref.startLine === ref.endLine
      ? `《${ref.materialName}》第 ${ref.startLine} 行`
      : `《${ref.materialName}》第 ${ref.startLine}–${ref.endLine} 行`,
  )
  return `依据材料：${parts.join('；')}`
}

/* -------------------------------------------------------- 提交证据 */

const evidenceForm = ref<InstanceType<typeof EvidenceForm> | null>(null)
const submitting = ref(false)
/** 最近一次证据保存成功的展示时间（契约 5.2：证据已保存要可见） */
const lastSavedAt = ref('')

/** 契约 3.2 / 2.3：表单组件按结构化字段提交，页面只负责调用 store 并显示结果 */
async function onSubmitEvidence(input: SubmitEvidenceInput): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  try {
    const result = await store.submitEvidence(input)
    if (!result.ok) {
      // 保留已填写内容（STORAGE_FULL / INVALID_INPUT 尤其重要）：组件只在成功后才重置
      notifyFailure(result)
      return
    }
    lastSavedAt.value = toDisplayTime(new Date().toISOString())
    evidenceForm.value?.reset()
  } finally {
    submitting.value = false
  }
}

/** 契约 5.2：证据保存结果与建议结果要同时可见，且来源如实区分 */
const adviceNote = computed(() => {
  switch (store.aiStatus) {
    case 'loading':
      return '正在重新判断下一步…'
    case 'model':
      return '下一步建议来自 AI 模型'
    case 'fallback':
      return `建议暂时使用规则结果（服务端规则兜底：${reasonText.value}）`
    case 'local-rule':
      return `建议暂时使用规则结果（本地规则：${reasonText.value}）`
    case 'error':
      return `建议没有生成出来：${reasonText.value}`
    default:
      return ''
  }
})

/* ---------------------------------------------------------- 项目切换 */

watch(
  () => project.value?.projectId,
  () => {
    // 切换项目：清掉材料上传状态、草稿请求状态、证据保存提示与聊天草稿
    materialStage.value = 'idle'
    materialError.value = null
    materialNotice.value = null
    lastFailedFile.value = null
    understandingByKey.value = {}
    lastSavedAt.value = ''
    lastQuestion.value = ''
    chatText.value = ''
    // 摘要、选中材料与保留的编辑都属于上一个项目：一并清掉，避免串项目
    selectedMaterialId.value = ''
    pendingDraftEdits.value = {}
  },
  { immediate: true },
)
</script>

<template>
  <CloudProjectWorkbench v-if="platform.isCloudSource" />

  <template v-else>
  <!-- 空状态：创建项目 -->
  <ProjectCreate v-if="store.creating || !project" />

  <!-- 项目工作台 -->
  <div v-else>
    <!-- 共用头部：当前项目与切换入口在两个标签页都可见，避免切了标签不知道在操作哪个项目 -->
    <div class="card wb-head">
      <div class="wb-head-top">
        <div class="wb-head-project">
          <label class="wb-proj-label" for="wb-project-select">当前项目</label>
          <select
            id="wb-project-select"
            class="proj-select"
            :value="project.projectId"
            @change="onSelectProject(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="item in store.projects" :key="item.projectId" :value="item.projectId">
              {{ item.name }}
            </option>
          </select>
          <div class="wb-proj-meta">{{ project.group }} · {{ project.members }} · {{ project.updated }}</div>
        </div>
        <div class="wb-head-actions">
          <button class="btn" type="button" @click="store.showCreate()">＋ 新建项目</button>
          <button class="btn" type="button" @click="router.push('/map')">查看项目地图</button>
        </div>
      </div>

      <div class="wb-tabs" role="tablist" aria-label="工作台视图">
        <button
          v-for="(tab, index) in TABS"
          :id="`wb-tab-${tab.key}`"
          :key="tab.key"
          class="wb-tab"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          :aria-controls="`wb-panel-${tab.key}`"
          :tabindex="activeTab === tab.key ? 0 : -1"
          @click="selectTab(tab.key)"
          @keydown="onTabKeydown($event, index)"
        >
          {{ tab.label }}
          <span v-if="tab.key === 'data' && dataSummary.pending > 0" class="tag wb-tab-badge">
            待确认 {{ dataSummary.pending }}
          </span>
        </button>
      </div>
    </div>

    <!-- ======================================================= 项目推进 -->
    <section
      id="wb-panel-progress"
      class="wb-panel"
      role="tabpanel"
      aria-labelledby="wb-tab-progress"
      :hidden="activeTab !== 'progress'"
    >
    <!-- 流程条：没有里程碑时给真实空状态 -->
    <div class="card">
      <div class="card-b" style="padding:10px 14px 4px;">
        <div v-if="flowNodes.length" class="flow">
          <template v-for="(node, index) in flowNodes" :key="index">
            <div class="flow-node" :class="node.s">
              <div class="fn-t">{{ node.label }} {{ node.t }}</div>
              <div class="fn-s">{{ node.sub }}</div>
            </div>
            <div v-if="index < flowNodes.length - 1" class="flow-arrow">→</div>
          </template>
        </div>
        <div v-else class="empty" style="padding:2px 0 6px;">
          这个项目还没有里程碑。填写项目基本信息、上传材料或提交第一条进展后，AI 会给出阶段划分。
        </div>
      </div>
    </div>

    <div class="stu-grid">
      <!-- ---------------------------------------------------------- 左栏 -->
      <div>
        <!-- 侧栏只放简明信息与入口：完整表单与材料草稿在「项目资料」标签页 -->
        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">
            项目状态
            <span class="tag" style="background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;">
              {{ dataSummary.materials }} 份材料
            </span>
          </div>
          <div class="card-b">
            <dl class="stat-list">
              <div class="stat-row">
                <dt>资料</dt>
                <dd>材料 {{ dataSummary.materials }} 份 · 待确认 {{ dataSummary.pending }} 条</dd>
              </div>
              <div class="stat-row">
                <dt>任务</dt>
                <dd>进行中 {{ taskCounts.doing }} · 已完成 {{ taskCounts.done }}</dd>
              </div>
              <div class="stat-row">
                <dt>证据</dt>
                <dd>{{ project.evidenceRecords.length }} 条</dd>
              </div>
            </dl>
            <p v-if="dataSummary.legacy > 0" class="stat-note">
              另有 {{ dataSummary.legacy }} 条历史材料只登记了文件名，正文还没有读取。
            </p>
            <div class="stat-actions">
              <button
                v-if="dataSummary.pending > 0"
                class="btn primary"
                type="button"
                @click="goConfirmMaterials"
              >
                去确认（{{ dataSummary.pending }} 条）
              </button>
              <button class="btn" type="button" @click="selectTab('data')">查看项目资料</button>
            </div>
          </div>
        </div>

                <div class="card" style="margin-bottom:14px;">
          <div class="card-h">里程碑进度</div>
          <div class="card-b">
            <template v-if="project.ms.length">
              <div v-for="(m, i) in project.ms" :key="i" class="milestone">
                <div :class="badge(m, i).cls">{{ badge(m, i).text }}</div>
                <div style="flex:1">
                  <div class="ms-name">{{ m.t }}</div>
                  <div class="ms-sub">{{ m.sub }}</div>
                  <div v-if="m.s === 'cur'" class="ms-bar"><i :style="`width:${m.p}%`"></i></div>
                </div>
              </div>
            </template>
            <div v-else class="empty" style="padding:4px 0;">
              这个项目还没有里程碑。上传材料、写下项目目标或提交第一条进展后，
              AI 会给出阶段划分。
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">近 4 周活跃度</div>
          <div class="card-b" style="padding:8px;">
            <div class="week-bars">
              <div v-for="(bar, i) in weekBars" :key="i" class="wb" :class="{ hot: bar.hot }">
                <b>{{ bar.value }}</b>
                <i :style="`height:${bar.height}px`"></i>
                <span>{{ bar.label }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            未解决的疑问
            <span
              class="tag"
              style="background:#FAEEDA;color:#854F0B;border:1px solid #FAC775;"
            >{{ openDoubts.length }}</span>
          </div>
          <div class="card-b" style="padding-top:6px;">
            <div v-for="d in openDoubts" :key="d.doubtId" class="doubt">
              {{ d.text }}
              <button
                class="btn"
                style="margin-top:6px;padding:3px 10px;font-size:11.5px;"
                @click="resolveDoubtById(d.doubtId)"
              >
                标记已解决
              </button>
            </div>
            <div v-if="!openDoubts.length" class="empty">
              暂无疑问。推进中产生的不确定会记录在这里。
            </div>
          </div>
        </div>
      </div>

      <!-- ---------------------------------------------------------- 中栏 -->
      <div>
        <!-- 建议区：六种状态与文案见 docs/contracts.md 5.3，请求只经过 store -->
        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">
            AI 下一步建议
            <span class="tag" style="background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;">
              {{ statusTag }}
            </span>
          </div>
          <div class="card-b">
            <AiStatus
              :tone="aiTone"
              :tag="statusTag"
              :message="statusLine"
              :action-label="requestLabel"
              :busy="isRequesting || isBlankProject"
              @retry="requestSuggestions"
            />

            <span v-if="retryAfterText" class="hint">{{ retryAfterText }}</span>

            <RecommendationList :items="suggestionViews" @claim="claimSuggestion" />

            <div
              v-if="!suggestionViews.length && !isRequesting && store.aiStatus !== 'error'"
              class="empty"
              style="padding:4px 0 0;"
            >
              {{ store.aiStatus === 'idle' ? '点上方按钮开始。' : '这次没有生成建议，可以点上方按钮重新获取。' }}
            </div>
          </div>
        </div>

        <!-- AI 项目顾问：显示真实任务与真实状态，认领与提问都按 taskId -->
        <div class="card advisor-steps" style="margin-bottom:14px;">
          <div class="card-h">
            AI 项目顾问
            <span class="tag" style="background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;">
              基于项目状态与已确认材料
            </span>
          </div>
          <div class="card-b">
            <div class="ai-banner">{{ project.banner }}</div>

            <div v-for="(step, i) in project.steps" :key="step.taskId ?? i" class="step-card">
              <div class="sc-top">
                <div class="sc-no">{{ i + 1 }}</div>
                <div class="sc-title">{{ step.t }}</div>
                <span
                  class="tag sc-owner"
                  style="background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;"
                >{{ taskStatusText(step.status) }}</span>
              </div>
              <div v-if="step.why" class="sc-why"><b>为什么现在做：</b>{{ step.why }}</div>
              <div v-if="step.done" class="advisor-done"><b>完成标准：</b>{{ step.done }}</div>
              <div class="sc-actions">
                <button
                  class="btn primary"
                  :disabled="step.status === 'doing' || step.status === 'done'"
                  @click="claimStep(step)"
                >
                  {{ stepClaimLabel(step) }}
                </button>
                <button class="btn" @click="askStep(step)">就此提问</button>
                <button class="btn" @click="router.push('/papers')">相关论文</button>
              </div>
            </div>

            <div v-if="!project.steps.length" class="empty" style="padding:4px 0 0;">
              还没有任务。获取「AI 下一步建议」并认领一步之后，这里会显示正在推进的任务与真实状态。
            </div>
          </div>
        </div>

        <!-- 项目地图入口：地图本身在独立页面，工作台不再重复画一遍 -->
        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">项目地图</div>
          <div class="card-b">
            <p class="map-entry">
              项目的里程碑、任务状态与材料理解进度都摊在独立的项目地图页上。
            </p>
            <button class="btn primary" @click="router.push('/map')">查看项目地图</button>
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            向顾问提问
            <span class="tag" style="background:#f1efe8;color:#5f5e5a;border:1px solid #d3d1c7;">
              答疑模式 · 给提示不给答案
            </span>
          </div>
          <div class="card-b">
            <p class="chat-hint">AI 会结合当前项目的任务、证据、疑问和历史对话回答，并标明回答来源。</p>

            <div ref="chatLog" class="chat-log">
              <div v-for="(msg, i) in project.chat" :key="i" class="msg" :class="{ me: msg.me }">
                <div>
                  <div class="who" :style="msg.me ? 'text-align:right;' : ''">
                    {{ msg.who }}
                    <span v-if="chatSourceText(msg)" class="chat-source">{{ chatSourceText(msg) }}</span>
                  </div>
                  <div class="bubble">{{ msg.text }}</div>
                  <p v-if="chatCitationsText(msg)" class="chat-citations">{{ chatCitationsText(msg) }}</p>
                </div>
              </div>
              <p v-if="!project.chat.length" class="empty" style="padding-left:0;">
                还没有提问。描述你卡住的问题，顾问会结合项目状态回答。
              </p>
            </div>

            <p v-if="store.chatLoading" class="chat-status">正在等顾问回答…</p>
            <div v-if="store.chatError" class="chat-error" role="alert">
              <span>{{ store.chatError }}</span>
              <button class="btn" type="button" @click="retryChat">再问一次</button>
            </div>

            <div class="chat-input">
              <input
                v-model="chatText"
                :maxlength="MAX_ADVISOR_CHAT_QUESTION_LENGTH"
                placeholder="描述你卡住的问题，顾问会结合项目状态回答…"
                @keydown.enter="submitChat"
              />
              <button class="btn primary" :disabled="store.chatLoading" @click="submitChat">发送</button>
            </div>
            <p v-if="chatTooLong" class="chat-error">问题不能超过 2000 字，请精简后再问。</p>
          </div>
        </div>
      </div>

      <!-- ---------------------------------------------------------- 右栏 -->
      <div>
        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">提交步骤证据</div>
          <div class="card-b evi-form">
            <EvidenceForm
              ref="evidenceForm"
              :tasks="project.tasks"
              :project-key="project.projectId"
              :submitting="submitting"
              @submit="onSubmitEvidence"
            />

            <!-- 契约 5.2：证据保存结果与建议结果同时可见 -->
            <div v-if="lastSavedAt" class="evidence-save-status">
              ✓ 证据已保存（{{ lastSavedAt }}）；建议失败也不会丢失
              <template v-if="adviceNote"><br />{{ adviceNote }}</template>
              <template v-if="store.aiStatus === 'error' || store.aiStatus === 'local-rule'">
                <br />可以在「AI 下一步建议」处重试。
              </template>
              <template v-if="retryAfterText"><br />{{ retryAfterText }}</template>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h">最近证据</div>
          <div class="card-b" style="padding-top:8px;">
            <div class="tl">
              <div v-for="(item, i) in recentEvidence" :key="i" class="tl-item">
                <div class="tl-time">{{ item.time }}</div>
                <div class="tl-text">{{ item.text }}</div>
                <div class="tl-who">{{ item.who }}</div>
              </div>
              <div v-if="!recentEvidence.length" class="empty" style="padding-left:0;">
                还没有证据记录。完成第一步后，记得回来提交——AI 会根据你的证据更新项目状态，再给出下一步建议。
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </section>

    <!-- ======================================================= 项目资料 -->
    <section
      id="wb-panel-data"
      class="wb-panel"
      role="tabpanel"
      aria-labelledby="wb-tab-data"
      :hidden="activeTab !== 'data'"
    >
      <!-- 项目基本信息：用主体宽度的宽表单，不再挤在窄侧栏 -->
      <div class="card" style="margin-bottom:14px;">
        <div class="card-h">
          项目基本信息（目标 / 预期结果 / 成员 / 研究周期）
          <span class="tag" style="background:#f1efe8;color:#5f5e5a;border:1px solid #d3d1c7;">
            保存后会随建议一起交给 AI
          </span>
        </div>
        <div class="card-b">
          <ProjectProfileForm layout="wide" />
        </div>
      </div>

      <!-- 材料：左边选材料，右边只显示当前这份材料的解析、草稿与来源 -->
      <div class="card">
        <div class="card-h">
          材料
          <span class="tag" style="background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;">
            本轮支持 MD / TXT
          </span>
        </div>
        <div class="card-b data-grid">
          <div class="data-list">
            <p class="data-list-h">材料列表</p>
            <ul class="mat-list">
              <li v-for="row in materialRows" :key="row.key">
                <button
                  class="mat-pick"
                  type="button"
                  :aria-current="
                    row.material !== null && row.material.materialId === selectedMaterialId
                      ? 'true'
                      : undefined
                  "
                  @click="row.material !== null && selectMaterial(row.material.materialId)"
                >
                  <span class="mat-pick-name" :title="row.name">{{ row.name }}</span>
                  <span class="mat-pick-meta">
                    {{ row.parseText }}
                    <template v-if="row.versionText">· {{ row.versionText }}</template>
                    <template v-if="row.segmentText">· {{ row.segmentText }}</template>
                  </span>
                  <span class="mat-pick-flags">
                    <span
                      v-if="row.material !== null && draftCountsOf(row.material.materialId).pending > 0"
                      class="tag mat-pick-pending"
                    >
                      待确认 {{ draftCountsOf(row.material.materialId).pending }}
                    </span>
                    <span
                      v-else-if="row.material !== null"
                      class="tag mat-pick-ok"
                    >
                      已确认 {{ draftCountsOf(row.material.materialId).confirmed }}
                    </span>
                    <span v-else class="tag">正文未读取</span>
                  </span>
                </button>
              </li>
            </ul>

            <p v-if="!materialRows.length" class="empty" style="padding:2px 0 8px;">
              还没有材料。上传一份 MD 或 TXT 文件后，系统会拆成片段并生成待确认的理解草稿。
            </p>

            <MaterialUploader
              ref="materialInput"
              :key="project.projectId"
              :stage="materialStage"
              :busy="materialBusy"
              :error-text="materialError"
              :notice="materialNotice"
              @upload="onMaterialUpload"
              @retry="retryMaterialUpload"
            />

            <p class="mat-roadmap">
              本轮支持 MD、TXT（单个文件不超过 1 MB）；CSV、XLSX 将在下一批支持，PDF、DOCX、ZIP
              将在后续版本支持。
            </p>
          </div>

          <div id="wb-data-detail" class="data-detail">
            <template v-if="selectedMaterial">
              <div class="data-detail-h">
                <b class="data-detail-name" :title="selectedMaterial.name">{{ selectedMaterial.name }}</b>
                <span class="data-detail-meta">
                  版本 {{ selectedMaterial.version }}
                  <template v-if="selectedRowText !== ''"> · {{ selectedRowText }}</template>
                </span>
                <div class="data-detail-actions">
                  <button
                    class="btn"
                    type="button"
                    :disabled="materialBusy"
                    @click="replaceMaterial(selectedMaterial.materialId)"
                  >
                    重新上传
                  </button>
                </div>
              </div>

              <UnderstandingDraftCard
                :draft="selectedDraft.draft"
                :source="selectedDraft.state.source"
                :notice="selectedDraft.state.notice"
                :loading="selectedDraft.state.phase === 'loading'"
                :error-text="selectedDraft.state.errorText"
                :confirming="selectedDraft.state.phase === 'loading'"
                :has-material="true"
                :can-generate="selectedDraft.canGenerate"
                :current-material-version="selectedMaterial.version"
                :pending-edit="pendingEditOf(selectedMaterial)"
                @generate="generateUnderstanding(selectedMaterial)"
                @retry="generateUnderstanding(selectedMaterial)"
                @confirm="confirmDraftItem"
                @undo="undoDraftItem"
                @edit="onDraftEdited"
                @remove="removeDraftItem"
                @confirm-all="confirmDraftAll"
                @edit-abort="rememberAbortedEdit"
              />
            </template>
            <p v-else-if="materialRows.length > 0" class="empty">
              这些历史条目只登记了文件名，正文没有被读取，也没有理解草稿；重新上传一份 MD / TXT
              才能生成理解草稿。
            </p>
            <p v-else class="empty">
              左边还没有可显示的材料。上传一份 MD 或 TXT 文件后，这里会显示这份材料的状态、理解草稿与来源。
            </p>
          </div>
        </div>
      </div>
    </section>
  </div>
  </template>
</template>

<style scoped>
/* 只补新增区块的样式，其余沿用全局 platform.css 与设计稿配色 */
.mat-row {
  border-bottom: 1px dashed #efeee9;
  padding: 8px 0;
}

.mat-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mat-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11.5px;
  color: #888780;
  margin-top: 4px;
}

.mat-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.mat-actions .btn {
  padding: 4px 10px;
  font-size: 11.5px;
}

.mat-hint {
  font-size: 11.5px;
  color: #854f0b;
  line-height: 1.6;
}

.mat-row .is-ok {
  background: #e1f5ee;
  color: #0f6e56;
  border: 1px solid #9fe1cb;
}

.mat-row .is-wait {
  background: #faeeda;
  color: #854f0b;
  border: 1px solid #fac775;
}

.mat-roadmap {
  margin-top: 10px;
  font-size: 11px;
  color: #888780;
  line-height: 1.6;
}

.advisor-done {
  font-size: 12px;
  color: #0f6e56;
  margin-top: 8px;
}

.map-entry {
  font-size: 12.5px;
  color: #5f5e5a;
  line-height: 1.7;
  margin-bottom: 10px;
}

.chat-hint {
  font-size: 11.5px;
  color: #888780;
  line-height: 1.6;
  margin-bottom: 6px;
}

.chat-source {
  margin-left: 6px;
  font-size: 10.5px;
  color: #185fa5;
}

.chat-citations {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.6;
  color: #5f5e5a;
}

.chat-status {
  margin-top: 6px;
  font-size: 11.5px;
  color: #0c447c;
}

.chat-error {
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  background: #faeeda;
  border: 1px solid #fac775;
  color: #854f0b;
  font-size: 11.5px;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.evidence-save-status {
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #e1f5ee;
  border: 1px solid #9fe1cb;
  color: #0f6e56;
  font-size: 12px;
  line-height: 1.7;
}

.draft-note {
  margin-top: 10px;
  font-size: 11px;
  color: #888780;
  line-height: 1.6;
}

.hint {
  font-size: 11.5px;
  color: #888780;
  align-self: center;
}

/* ============================================================================
   工作台视图：共用头部 + 两个标签面板
   ----------------------------------------------------------------------------
   层次仍然只靠底色差、发丝线与字号阶梯（见 DESIGN.md），不引入新的颜色体系。
   ========================================================================== */

.wb-head {
  margin-bottom: 14px;
}

.wb-head-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px 10px;
}

.wb-head-project {
  min-width: 0;
  flex: 1;
}

.wb-proj-label {
  display: block;
  font-size: 11px;
  color: #888780;
  margin-bottom: 5px;
}

.wb-head-project .proj-select {
  max-width: 420px;
  margin-bottom: 6px;
}

.wb-proj-meta {
  font-size: 12px;
  color: #888780;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.wb-head-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.wb-tabs {
  display: flex;
  gap: 2px;
  padding: 0 8px;
  border-top: 1px solid #efeee9;
}

.wb-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  border: none;
  background: none;
  padding: 11px 16px;
  font-size: 13.5px;
  color: #5f5e5a;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.wb-tab:hover {
  color: #185fa5;
}

.wb-tab[aria-selected='true'] {
  color: #185fa5;
  font-weight: 600;
  border-bottom-color: #185fa5;
}

.wb-tab:focus-visible {
  outline: 2px solid #378add;
  outline-offset: -2px;
  border-radius: 6px;
}

.wb-tab-badge {
  background: #faeeda;
  color: #854f0b;
  border: 1px solid #fac775;
}

/* hidden 属性可能被元素自身的 display 覆盖，这里显式兜住 */
.wb-panel[hidden] {
  display: none;
}

/* ------------------------------------------------------------- 侧栏摘要 */

.stat-list {
  margin: 0 0 10px;
}

.stat-row {
  display: flex;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px dashed #efeee9;
  font-size: 12.5px;
  line-height: 1.55;
}

.stat-row:last-of-type {
  border-bottom: none;
}

.stat-row dt {
  flex-shrink: 0;
  width: 34px;
  color: #888780;
}

.stat-row dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.stat-note {
  font-size: 11.5px;
  color: #854f0b;
  background: #faeeda;
  border: 1px solid #fac775;
  border-radius: 8px;
  padding: 6px 10px;
  line-height: 1.6;
  margin-bottom: 10px;
}

.stat-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* ---------------------------------------------------------------- 资料页 */

.data-grid {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.data-list {
  min-width: 0;
}

.data-list-h {
  font-size: 11px;
  color: #888780;
  margin-bottom: 8px;
}

.mat-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.mat-pick {
  width: 100%;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid #e3e2dd;
  border-radius: 10px;
  background: #fff;
  padding: 9px 11px;
}

.mat-pick:hover {
  border-color: #b5d4f4;
}

.mat-pick[aria-current='true'] {
  border-color: #185fa5;
  background: #e6f1fb;
}

.mat-pick:focus-visible {
  outline: 2px solid #378add;
  outline-offset: 1px;
}

.mat-pick-name {
  font-size: 12.5px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mat-pick-meta {
  font-size: 11.5px;
  color: #888780;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.mat-pick-flags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.mat-pick-pending {
  background: #faeeda;
  color: #854f0b;
  border: 1px solid #fac775;
}

.mat-pick-ok {
  background: #e1f5ee;
  color: #0f6e56;
  border: 1px solid #9fe1cb;
}

.data-detail {
  min-width: 0;
}

.data-detail-h {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  margin-bottom: 12px;
  border-bottom: 1px solid #efeee9;
}

.data-detail-name {
  font-size: 13.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.data-detail-meta {
  font-size: 12px;
  color: #888780;
}

.data-detail-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 1100px) {
  .data-grid {
    grid-template-columns: 1fr;
  }

  .wb-head-top {
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .wb-tabs {
    padding: 0 4px;
    overflow-x: auto;
  }

  .wb-tab {
    padding: 10px 12px;
    flex-shrink: 0;
  }
}
</style>
