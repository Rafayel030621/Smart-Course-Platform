<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AiStatus from '@/components/AiStatus.vue'
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
} from '@/components/materialTypes'
import { CHINESE_NUM, WEEK_LABELS, useWorkbenchStore } from '@/stores/workbench'
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
 * 草稿卡片按材料渲染。条目状态与来源全部来自 store，
 * 页面只做投影（不自己造候选、不自己改状态）。
 */
const draftGroups = computed(() => {
  const p = project.value
  if (p === undefined) return []
  return store.materials.map((material) => ({
    material,
    draft: understandingDraftViewOf(material, blocksOfMaterial(p, material.materialId)),
    state: understandingStateOf(material),
  }))
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
    store.toast('这条理解已经不存在，请重新生成理解草稿')
    return
  }
  const result = store.confirmUnderstandingBlock({ blockId })
  if (!result.ok) notifyFailure(result)
}

function undoDraftItem(payload: { materialId: string; materialVersion: number; itemId: string }) {
  const blockId = blockIdOf(payload)
  if (blockId === null) {
    store.toast('这条理解已经不存在，请重新生成理解草稿')
    return
  }
  const result = store.unconfirmUnderstandingBlock({ blockId })
  if (!result.ok) notifyFailure(result)
}

function editDraftItem(payload: {
  materialId: string
  materialVersion: number
  itemId: string
  text: string
}) {
  const blockId = blockIdOf(payload)
  if (blockId === null) {
    store.toast('这条理解已经不存在，请重新生成理解草稿')
    return
  }
  const result = store.modifyUnderstandingBlock({ blockId, content: payload.text })
  if (!result.ok) notifyFailure(result)
}

function removeDraftItem(payload: { materialId: string; materialVersion: number; itemId: string }) {
  const blockId = blockIdOf(payload)
  if (blockId === null) {
    store.toast('这条理解已经不存在')
    return
  }
  const result = store.deleteUnderstandingBlock({ blockId })
  if (!result.ok) notifyFailure(result)
}

function confirmDraftAll(payload: { materialId: string; materialVersion: number }) {
  const result = store.confirmAllUnderstanding({ materialId: payload.materialId })
  if (!result.ok) notifyFailure(result)
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
  },
  { immediate: true },
)
</script>

<template>
  <!-- 空状态：创建项目 -->
  <ProjectCreate v-if="store.creating || !project" />

  <!-- 项目工作台 -->
  <div v-else>
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
        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">我的项目</div>
          <div class="card-b">
            <select
              class="proj-select"
              :value="project.projectId"
              @change="onSelectProject(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="item in store.projects" :key="item.projectId" :value="item.projectId">
                {{ item.name }}
              </option>
            </select>
            <div style="font-size:12px;color:#888780;line-height:1.7;margin-bottom:8px;">
              {{ project.group }} · {{ project.members }}<br />{{ project.updated }}
            </div>
            <button class="btn" style="width:100%;margin-bottom:8px;" @click="store.showCreate()">
              ＋ 新建项目
            </button>
            <button class="btn" style="width:100%;" @click="router.push('/map')">查看项目地图</button>
          </div>
        </div>

        <!-- 项目资料：唯一的材料入口（真实 MD / TXT 上传 → 解析 → 理解草稿） -->
        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">
            项目资料
            <span class="tag" style="background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;">
              本轮支持 MD / TXT
            </span>
          </div>
          <div class="card-b">
            <div v-for="row in materialRows" :key="row.key" class="mat-row">
              <div class="mat-head">
                <span class="mat-name" :title="row.name">{{ row.name }}</span>
                <span class="tag mat-tag" :class="row.canGenerate ? 'is-ok' : 'is-wait'">
                  {{ row.parseText }}
                </span>
              </div>
              <div class="mat-meta">
                <span v-if="row.versionText">{{ row.versionText }}</span>
                <span v-if="row.segmentText">{{ row.segmentText }}</span>
                <span>读取状态：{{ row.readText }}</span>
              </div>
              <div v-if="row.material" class="mat-actions">
                <button
                  class="btn"
                  type="button"
                  :disabled="!row.canGenerate || materialBusy"
                  @click="generateUnderstanding(row.material)"
                >
                  获取理解草稿
                </button>
                <button
                  class="btn"
                  type="button"
                  :disabled="materialBusy"
                  @click="replaceMaterial(row.material.materialId)"
                >
                  重新上传
                </button>
              </div>
              <div v-else class="mat-actions">
                <span class="mat-hint">这份材料只有文件名：重新上传一份 MD / TXT 才能生成理解草稿。</span>
              </div>
            </div>

            <div v-if="!materialRows.length" class="empty" style="padding:4px 0 8px;">
              还没有材料。上传一份 MD 或 TXT 文件后，系统会拆成片段并生成待确认的理解草稿。
            </div>

            <MaterialUploader
              ref="materialInput"
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
        </div>

        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">项目基本信息（目标 / 预期结果 / 成员 / 研究周期）</div>
          <div class="card-b">
            <ProjectProfileForm />
          </div>
        </div>

        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">
            材料理解草稿
            <span class="tag" style="background:#FAEEDA;color:#854F0B;border:1px solid #FAC775;">
              确认后才会用于建议
            </span>
          </div>
          <div class="card-b">
            <template v-if="draftGroups.length">
              <UnderstandingDraftCard
                v-for="group in draftGroups"
                :key="group.material.materialId"
                :draft="group.draft"
                :source="group.state.source"
                :notice="group.state.notice"
                :loading="group.state.phase === 'loading'"
                :error-text="group.state.errorText"
                :confirming="group.state.phase === 'loading'"
                :has-material="true"
                :can-generate="materialRows.some((row) => row.material?.materialId === group.material.materialId && row.canGenerate)"
                :current-material-version="group.material.version"
                @generate="generateUnderstanding(group.material)"
                @retry="generateUnderstanding(group.material)"
                @confirm="confirmDraftItem"
                @undo="undoDraftItem"
                @edit="editDraftItem"
                @remove="removeDraftItem"
                @confirm-all="confirmDraftAll"
              />
            </template>
            <p v-else class="empty" style="padding:4px 0;">
              还没有材料。先在「项目资料」里上传 MD 或 TXT 文件，再生成理解草稿。
            </p>
            <p class="draft-note">
              只有标着「已确认」的内容会进入 AI 建议与问答；「待确认」和「已修改」都只是草稿。
            </p>
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
  </div>
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
</style>
