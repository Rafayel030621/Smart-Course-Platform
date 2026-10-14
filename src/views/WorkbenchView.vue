<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ProjectCreate from '@/components/ProjectCreate.vue'
import ProjectMindMap from '@/components/ProjectMindMap.vue'
import SuggestionCard from '@/components/SuggestionCard.vue'
// v2（M1 / M2-A）：项目基本信息、材料上传与理解草稿三个面板（页面组件由雍蕾维护）
import MaterialPanel from '@/components/MaterialPanel.vue'
import ProjectProfileForm from '@/components/ProjectProfileForm.vue'
import UnderstandingDraft from '@/components/UnderstandingDraft.vue'
import { CHINESE_NUM, WEEK_LABELS, useWorkbenchStore } from '@/stores/workbench'
import { deriveDoubtSnapshots, deriveEvidenceSnapshots, toDisplayTime } from '@/domain/activity'
import { deriveTaskSnapshots } from '@/domain/progress'
import type {
  ActionResult,
  AdvisorFallbackReason,
  ClaimTaskInput,
  Recommendation,
} from '@/domain/recommendation'
import type { Milestone } from '@/types/platform'

/**
 * 工作台
 * ----------------------------------------------------------------------------
 * 没有项目时是创建页；有项目时是三栏工作台：
 *   左栏  我的项目 / 项目资料 / 里程碑进度 / 近 4 周活跃度 / 未解决的疑问
 *   中栏  AI 项目顾问（步骤建议）/ 项目地图 / 向顾问提问
 *   右栏  提交步骤证据 / 最近证据
 * 布局与内容与 platform-ui-mockup(3).html 一致。
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

/**
 * 建议区
 * ----------------------------------------------------------------------------
 * 页面只调 store.refreshRecommendations：不直接 fetch、不拼后端地址、不碰任何密钥。
 * 六种状态的文案见 docs/contracts.md 5.3；错误一律映射成人话（5.2 要求不显示英文码）。
 */

/** 服务端规则兜底的原因 → 人话 */
const FALLBACK_REASON_TEXT: Record<AdvisorFallbackReason, string> = {
  MODEL_TIMEOUT: '模型响应超时',
  MODEL_UNAVAILABLE: '模型服务暂时不可用',
  MODEL_NOT_CONFIGURED: '服务端还没接入模型',
  INVALID_MODEL_OUTPUT: '模型返回的内容不符合要求',
  RATE_LIMITED: '请求太频繁',
}

/** 错误码 → 人话（含适配层的前端内部码；保留码也先留文案） */
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
  NOT_FOUND: '该任务或疑问已经不存在',
  PROJECT_MISMATCH: '当前项目已变化，请重新加载',
  TASK_NOT_CLAIMABLE: '该任务已经完成',
  STORAGE_FULL: '本地存储空间不足，当前表单内容已保留',
  NETWORK_ERROR: '后端暂时不可用',
  STALE_RESPONSE: '这条建议已经过期，请重新获取',
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

const aiStatus = computed(() => store.aiStatus)
const isRequesting = computed(() => store.aiStatus === 'loading')

/** 兜底/失败原因：优先用响应里的 fallbackReason，其次用适配层保留的错误码 */
const reasonText = computed(() => {
  const fallbackReason = store.advisor.fallbackReason
  if (fallbackReason !== null) return FALLBACK_REASON_TEXT[fallbackReason]

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
      return `模型这次没能给出结果，下面是服务端规则生成的建议（原因：${reasonText.value}）。`
    case 'local-rule':
      return `后端这次不可用，下面是本地规则生成的建议（原因：${reasonText.value}）。`
    case 'error':
      return `建议没有生成出来：${reasonText.value}。可以重试，也可以先按自己的判断推进。`
    default:
      return ''
  }
})

const statusStyle = computed(() => {
  switch (store.aiStatus) {
    case 'fallback':
      return 'background:#FAEEDA;border-color:#FAC775;color:#854F0B;'
    case 'local-rule':
      return 'background:#f1efe8;border-color:#d3d1c7;color:#5f5e5a;'
    case 'error':
      return 'background:#FCEBEB;border-color:#F7C1C1;color:#A32D2D;'
    default:
      return ''
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

/** 契约 5.3：loading 期间禁止重复点击触发并发请求 */
async function requestSuggestions() {
  if (isRequesting.value) return

  try {
    const result = await store.refreshRecommendations({ forceRefresh: store.aiStatus !== 'idle' })
    if (!result.ok) notifyFailure(result)
  } catch (error: unknown) {
    // store 内部已处理绝大多数失败，这里只兜住"请求还没发出去就出错"的异常
    console.warn('[建议] 请求未能完成', error instanceof Error ? error.name : 'unknown')
    store.toast('建议请求没能完成，请稍后再试')
  }
}

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

/** 切换项目用稳定 projectId，不用数组下标 */
function onSelectProject(projectId: string) {
  const result = store.selectProject(projectId)
  if (!result.ok) notifyFailure(result)
}

/** 契约 5.4 第 4 条：同一条建议重复点击只认领一次 */
const claimedIds = ref<string[]>([])

type ClaimState = 'claimable' | 'claimed' | 'draft'

function claimStateOf(suggestion: Recommendation): ClaimState {
  if (claimedIds.value.includes(suggestion.id)) return 'claimed'
  // existingTaskId 为 null = 新任务候选（契约 5.4 第 2 条），走 claimTask({ draft })
  if (suggestion.existingTaskId === null) return 'draft'
  return 'claimable'
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
 * 页面不判断任务状态、不自己造任务、不碰进度。
 */
function claimSuggestion(suggestion: Recommendation) {
  if (claimedIds.value.includes(suggestion.id)) return

  const input: ClaimTaskInput =
    suggestion.existingTaskId === null
      ? {
          draft: {
            title: suggestion.title,
            doneCriteria: suggestion.doneCriteria,
            requestId: suggestion.requestId,
            basisEvidenceIds: [...suggestion.basisEvidenceIds],
            basisDoubtIds: [...suggestion.basisDoubtIds],
          },
        }
      : { taskId: suggestion.existingTaskId }

  const result = store.claimTask(input)
  if (!result.ok) {
    notifyFailure(result)
    return
  }
  claimedIds.value = [...claimedIds.value, suggestion.id]
}

/** 中栏「AI 项目顾问」的步骤卡：同样走 claimTask，不用下标版 wrapper */
function claimStepByIndex(index: number) {
  const task = derived.value?.tasks[index]
  if (task === undefined) {
    store.toast('该任务已经不存在，请重新获取建议')
    return
  }
  const result = store.claimTask({ taskId: task.taskId })
  if (!result.ok) notifyFailure(result)
}

/** 契约 3.2：resolveDoubt 用真实 doubtId。重复解决（ALREADY_RESOLVED）保持安静 */
function resolveDoubtById(doubtId: string) {
  const result = store.resolveDoubt(doubtId)
  if (!result.ok) notifyFailure(result)
}

/* -------------------------------------------------------------- 材料 */

const manualInput = ref<HTMLInputElement | null>(null)
const dataInput = ref<HTMLInputElement | null>(null)
const otherInput = ref<HTMLInputElement | null>(null)

function upload(type: '实验手册' | '数据集' | '材料', event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  store.uploadMaterial(type, file.name)
  input.value = ''
}

function materialStyle(type: string) {
  if (type === '实验手册') return 'background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;'
  if (type === '数据集') return 'background:#E1F5EE;color:#0F6E56;border:1px solid #9FE1CB;'
  return 'background:#f1efe8;color:#5f5e5a;border:1px solid #d3d1c7;'
}

/* -------------------------------------------------------------- 问答 */

const chat = ref('')
const chatLog = ref<HTMLElement | null>(null)

async function send() {
  const text = chat.value
  if (!text.trim()) return
  chat.value = ''
  store.sendChat(text)
  await scrollChat()
}

async function scrollChat() {
  await nextTick()
  if (chatLog.value) chatLog.value.scrollTop = chatLog.value.scrollHeight
}

watch(() => project.value?.chat.length, scrollChat)

/* -------------------------------------------------------- 提交证据 */

/**
 * 契约 3.2 / 2.3：证据表单直接用结构化字段。
 * `taskId` 为空串表示「不关联任务」（对应快照里的 null）。
 */
const form = reactive({
  taskId: '',
  didWhat: '',
  foundWhat: '',
  stillUnsure: '',
  attachmentName: null as string | null,
})

const evidenceInput = ref<HTMLInputElement | null>(null)
const submitting = ref(false)
/** 最近一次证据保存成功的展示时间（契约 5.2：证据已保存要可见） */
const lastSavedAt = ref('')

/**
 * 幂等键：一次真正的提交只生成一次。
 * 提交失败时保留它，重复点击会复用同一个 submissionId（store 侧命中即不重复写入）；
 * 保存成功后作废，下一次提交重新生成。
 */
let pendingSubmissionId: string | null = null

function newSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 任务下拉：结构化任务列表（真实 taskId），状态只用来做展示后缀 */
const taskOptions = computed(() => {
  const tasks = derived.value?.tasks ?? []
  return [
    ...tasks.map((task) => ({
      value: task.taskId,
      label: task.title + (task.status === 'done' ? '（已完成）' : task.status === 'doing' ? '（进行中）' : ''),
    })),
    { value: '', label: '其他进展（不关联任务）' },
  ]
})

const selectedTask = computed(
  () => (derived.value?.tasks ?? []).find((task) => task.taskId === form.taskId) ?? null,
)

/**
 * 「确认完成」是否可用。
 * 这里只做按钮可用性提示；真正的状态规则（只允许 doing → done）在 store 里。
 */
const canComplete = computed(() => selectedTask.value !== null && selectedTask.value.status === 'doing')

watch(
  () => project.value?.projectId,
  () => {
    // 切换项目：清掉上一次的认领记录、表单与幂等键
    claimedIds.value = []
    pendingSubmissionId = null
    lastSavedAt.value = ''
    form.taskId = taskOptions.value[0]?.value ?? ''
    form.didWhat = ''
    form.foundWhat = ''
    form.stillUnsure = ''
    form.attachmentName = null
  },
  { immediate: true },
)

function pickEvidenceFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  // MVP 只记文件名，不上传文件本身
  form.attachmentName = file.name
}

/**
 * 契约 3.2：submitEvidence。
 * - complete: false → 只保存证据，必要时生成未解决疑问，不把任务改成 done；
 * - complete: true  → 校验通过后由 store 把进行中的任务置为 done。
 * 失败一律保留表单内容。
 */
async function submitEvidence(complete: boolean) {
  if (submitting.value) return
  submitting.value = true

  try {
    if (pendingSubmissionId === null) pendingSubmissionId = newSubmissionId()

    const result = await store.submitEvidence({
      submissionId: pendingSubmissionId,
      taskId: form.taskId === '' ? null : form.taskId,
      didWhat: form.didWhat,
      foundWhat: form.foundWhat,
      stillUnsure: form.stillUnsure,
      attachmentName: form.attachmentName,
      complete,
    })

    if (!result.ok) {
      // 保留已填写内容（STORAGE_FULL / INVALID_INPUT 尤其重要）
      notifyFailure(result)
      return
    }

    // 保存成功：作废幂等键、清空输入（任务选择保留，方便连着记录下一条）
    pendingSubmissionId = null
    lastSavedAt.value = toDisplayTime(new Date().toISOString())
    form.didWhat = ''
    form.foundWhat = ''
    form.stillUnsure = ''
    form.attachmentName = null
  } finally {
    submitting.value = false
  }
}

/** 契约 5.2：证据保存结果与建议结果要同时可见 */
const adviceNote = computed(() => {
  switch (store.aiStatus) {
    case 'loading':
      return '正在重新判断下一步…'
    case 'model':
      return '下一步建议来自 AI 模型'
    case 'fallback':
      return `建议来自服务端规则（${reasonText.value}）`
    case 'local-rule':
      return `建议来自本地规则（${reasonText.value}）`
    case 'error':
      return `建议没有生成出来：${reasonText.value}`
    default:
      return ''
  }
})
</script>

<template>
  <!-- 空状态：创建项目 -->
  <ProjectCreate v-if="store.creating || !project" />

  <!-- 项目工作台 -->
  <div v-else>
    <!-- 穿插可视化①：流程条 -->
    <div class="card">
      <div class="card-b" style="padding:10px 14px 4px;">
        <div class="flow">
          <template v-for="(node, index) in flowNodes" :key="index">
            <div class="flow-node" :class="node.s">
              <div class="fn-t">{{ node.label }} {{ node.t }}</div>
              <div class="fn-s">{{ node.sub }}</div>
            </div>
            <div v-if="index < flowNodes.length - 1" class="flow-arrow">→</div>
          </template>
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
            <button class="btn" style="width:100%;" @click="store.showCreate()">＋ 新建项目</button>
          </div>
        </div>

        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">
            项目资料
            <span class="tag" style="background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;">
              AI 追踪依据
            </span>
          </div>
          <div class="card-b">
            <div v-if="project.materials.length">
              <div v-for="(m, i) in project.materials" :key="i" class="mat-item">
                <span class="mat-name" :title="m.name">{{ m.name }}</span>
                <span class="tag mat-tag" :style="materialStyle(m.type)">{{ m.type }}</span>
              </div>
            </div>
            <div v-else class="empty" style="padding:4px 0 8px;">
              还没有上传材料。上传实验手册或数据集后，AI 会解析内容并更精准地追踪步骤。
            </div>

            <div class="up-row">
              <button class="btn" @click="manualInput?.click()">＋手册</button>
              <button class="btn" @click="dataInput?.click()">＋数据</button>
              <button class="btn" @click="otherInput?.click()">＋其他</button>
            </div>
            <input ref="manualInput" type="file" style="display:none" @change="upload('实验手册', $event)" />
            <input ref="dataInput" type="file" style="display:none" @change="upload('数据集', $event)" />
            <input ref="otherInput" type="file" style="display:none" @change="upload('材料', $event)" />
          </div>
        </div>

        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">项目基本信息（目标 / 预期结果 / 成员 / 研究周期）</div>
          <div class="card-b">
            <ProjectProfileForm />
          </div>
        </div>

        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">材料与理解草稿</div>
          <div class="card-b">
            <MaterialPanel />
            <UnderstandingDraft />
          </div>
        </div>

        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">里程碑进度</div>
          <div class="card-b">
            <div v-for="(m, i) in project.ms" :key="i" class="milestone">
              <div :class="badge(m, i).cls">{{ badge(m, i).text }}</div>
              <div style="flex:1">
                <div class="ms-name">{{ m.t }}</div>
                <div class="ms-sub">{{ m.sub }}</div>
                <div v-if="m.s === 'cur'" class="ms-bar"><i :style="`width:${m.p}%`"></i></div>
              </div>
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
            <div class="ai-banner" :style="statusStyle">{{ statusLine }}</div>

            <div class="sc-actions" style="margin-top:0;margin-bottom:4px;">
              <button class="btn primary" :disabled="isRequesting" @click="requestSuggestions">
                {{ requestLabel }}
              </button>
              <span v-if="retryAfterText" class="hint">{{ retryAfterText }}</span>
            </div>

            <SuggestionCard
              v-for="view in suggestionViews"
              :key="view.suggestion.id"
              :suggestion="view.suggestion"
              :index="view.index"
              :claim-state="view.claimState"
              :evidence="view.evidence"
              :doubts="view.doubts"
              @claim="claimSuggestion(view.suggestion)"
            />

            <div
              v-if="!suggestionViews.length && !isRequesting && aiStatus !== 'error'"
              class="empty"
              style="padding:4px 0 0;"
            >
              {{ aiStatus === 'idle' ? '点上方按钮开始。' : '这次没有生成建议，可以点上方按钮重新获取。' }}
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">
            AI 项目顾问
            <span class="tag" style="background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;">
              基于项目状态与上传材料
            </span>
          </div>
          <div class="card-b">
            <div class="ai-banner">{{ project.banner }}</div>

            <div v-for="(s, i) in project.steps" :key="i" class="step-card">
              <div class="sc-top">
                <div class="sc-no">{{ i + 1 }}</div>
                <div class="sc-title">{{ s.t }}</div>
                <span
                  class="tag sc-owner"
                  style="background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;"
                >建议：{{ s.owner }}</span>
              </div>
              <div class="sc-why"><b>为什么现在做：</b>{{ s.why }}</div>
              <div class="sc-done">{{ s.done }}</div>
              <div class="sc-actions">
                <button class="btn primary" @click="claimStepByIndex(i)">认领这一步</button>
                <button class="btn" @click="store.askAboutStep(i)">就此提问</button>
                <button class="btn" @click="router.push('/papers')">相关论文</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 穿插可视化②：项目地图 -->
        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">
            项目地图
            <span
              class="tag"
              style="background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;"
            >{{ project.short }}</span>
          </div>
          <div class="card-b">
            <ProjectMindMap :project="project" />
            <div style="font-size:12px;color:#888780;text-align:center;margin-top:4px;">
              左侧为里程碑，右侧为 AI 正在追踪的当前实际步骤 · 绿=已完成，蓝=进行中，灰=未开始
            </div>
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
            <div ref="chatLog" class="chat-log">
              <div v-for="(msg, i) in project.chat" :key="i" class="msg" :class="{ me: msg.me }">
                <div>
                  <div class="who" :style="msg.me ? 'text-align:right;' : ''">{{ msg.who }}</div>
                  <div class="bubble">{{ msg.text }}</div>
                </div>
              </div>
            </div>
            <div class="chat-input">
              <input
                v-model="chat"
                placeholder="描述你卡住的问题，AI 会结合项目状态回答…"
                @keydown.enter="send"
              />
              <button class="btn primary" @click="send">发送</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ---------------------------------------------------------- 右栏 -->
      <div>
        <div class="card" style="margin-bottom:14px;">
          <div class="card-h">提交步骤证据</div>
          <div class="card-b evi-form">
            <label>对应任务</label>
            <select v-model="form.taskId" class="proj-select" style="margin-bottom:0;">
              <option v-for="opt in taskOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>

            <label>完成了什么</label>
            <textarea v-model="form.didWhat" placeholder="一句话说明产出"></textarea>

            <label>发现了什么 <small>（意外收获、异常现象都算）</small></label>
            <textarea v-model="form.foundWhat"></textarea>

            <label>还有什么不确定</label>
            <textarea
              v-model="form.stillUnsure"
              placeholder="写下来的会进入左侧「未解决的疑问」"
            ></textarea>

            <div
              class="upbox"
              style="margin-top:12px;"
              :class="{ has: form.attachmentName }"
              @click="evidenceInput?.click()"
            >
              <template v-if="form.attachmentName">✓ 附件：{{ form.attachmentName }}</template>
              <template v-else>＋ 附加 notebook、截图或结果文件</template>
            </div>
            <input ref="evidenceInput" type="file" style="display:none" @change="pickEvidenceFile" />

            <!-- 契约 4.1：记录进展与确认完成是两个不同动作 -->
            <button class="submit" :disabled="submitting" @click="submitEvidence(false)">
              记录进展（不完成任务）
            </button>
            <button
              class="submit"
              style="margin-top:8px;background:#0F6E56;"
              :disabled="submitting || !canComplete"
              @click="submitEvidence(true)"
            >
              确认完成这一步
            </button>
            <div v-if="!canComplete" class="evi-hint">
              确认完成需要先认领一个进行中的任务。只想留下记录就用上面的「记录进展」。
            </div>

            <!-- 契约 5.2：证据保存结果与建议结果同时可见 -->
            <div v-if="lastSavedAt" class="evi-saved">
              ✓ 证据已于 {{ lastSavedAt }} 保存（建议失败也不会丢失）
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
              <div v-for="(item, i) in project.evidence" :key="i" class="tl-item">
                <div class="tl-time">{{ item.time }}</div>
                <div class="tl-text">{{ item.text }}</div>
                <div class="tl-who">{{ item.who }}</div>
              </div>
              <div v-if="!project.evidence.length" class="empty" style="padding-left:0;">
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
/* 只补两个新增区块的样式，其余沿用全局 platform.css 与设计稿配色 */
.evi-hint {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.6;
  color: #888780;
}

.evi-saved {
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #e1f5ee;
  border: 1px solid #9fe1cb;
  color: #0f6e56;
  font-size: 12px;
  line-height: 1.7;
}

.submit:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.hint {
  font-size: 11.5px;
  color: #888780;
  align-self: center;
}
</style>
