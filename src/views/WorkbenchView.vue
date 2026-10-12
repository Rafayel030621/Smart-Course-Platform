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
import type { MaterialFileType } from '@/components/materialTypes'
import { CHINESE_NUM, WEEK_LABELS, useWorkbenchStore } from '@/stores/workbench'
import { deriveDoubtSnapshots, deriveEvidenceSnapshots } from '@/domain/activity'
import { findClaimedTaskFor, taskStatusText } from '@/domain/progress'
import { BLANK_PROJECT_NOTE, summarizeProjectStatus } from '@/domain/projectStatus'
import { MAX_ADVISOR_CHAT_QUESTION_LENGTH } from '@/domain/recommendation'
import type { AdvisorFallbackReason, Recommendation, SubmitEvidenceInput } from '@/domain/recommendation'
import type { Milestone, SuggestedStep, TaskStatus } from '@/types/platform'

/**
 * 工作台
 * ----------------------------------------------------------------------------
 * 没有项目时是创建页；有项目时是三栏工作台：
 *   左栏  我的项目 / 项目基本信息 / 项目资料（材料）/ 里程碑进度 / 近 4 周活跃度 / 未解决的疑问
 *   中栏  AI 下一步建议 / AI 项目顾问（真实任务）/ 材料理解草稿 / 项目地图入口 / 向顾问提问
 *   右栏  提交步骤证据 / 最近证据
 *
 * 完整项目地图已经挪到独立的「项目地图」页面（/map），
 * 工作台只留一个入口，避免同一张图在两个地方各画一遍。
 *
 * M2-A：项目基本信息、材料上传、材料理解草稿三张卡片已经就位；
 * 数据层（store action / API 适配）尚未接入，页面只做真实存在的事（登记文件名），
 * 不展示任何"已保存 / 已解析 / 已确认"的假状态。
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

/**
 * 服务端规则兜底的原因 → 人话（只保留一句短原因，不出现错误码与字段名）。
 * 完整提示语写在下方的 statusLine 里。
 */
const FALLBACK_REASON_TEXT: Record<AdvisorFallbackReason, string> = {
  MODEL_TIMEOUT: '模型这次响应超时',
  MODEL_UNAVAILABLE: '模型服务暂时不可用',
  MODEL_NOT_CONFIGURED: '服务端还没接入模型',
  INVALID_MODEL_OUTPUT: '模型返回的内容不符合要求',
  RATE_LIMITED: '请求有点频繁',
}

/** 内部错误码 → 一句人话；用户永远看不到错误码本身 */
const ERROR_TEXT: Record<string, string> = {
  INVALID_INPUT: '当前项目内容还不够',
  RATE_LIMITED: '请求有点频繁',
  MODEL_TIMEOUT: '模型响应超时',
  INVALID_MODEL_OUTPUT: '模型返回的内容不符合要求',
  MODEL_UNAVAILABLE: '模型服务暂时不可用',
  MODEL_NOT_CONFIGURED: '服务端还没接入模型',
  NETWORK_ERROR: '连不上后端服务',
  INTERNAL: '服务端暂时不可用',
  STALE_REVISION: '项目状态刚更新过',
  UNAUTHORIZED: '没有通过服务端校验',
}

const aiStatus = computed(() => store.aiStatus)
const isRequesting = computed(() => store.aiStatus === 'loading')

/**
 * 空白项目：没有任务、证据、疑问与材料时才是空白——判断只看**真实数据**，不看项目名称。
 *
 * 用户提交第一条进展、上传材料、提出疑问或认领任务之后，`isBlank` 立刻变成 false，
 * 空白提示随之消失（同一份摘要也用于「AI 项目顾问」区的说明文字与刷新后的恢复）。
 */
const projectStatus = computed(() => (project.value ? summarizeProjectStatus(project.value) : null))
const isBlankProject = computed(() => projectStatus.value?.isBlank ?? false)

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

/** 六种状态各自一句提示。失败时只说明"发生了什么 + 下一步怎么办"，不给技术细节 */
const statusLine = computed(() => {
  switch (store.aiStatus) {
    case 'idle':
      return isBlankProject.value
        ? `${BLANK_PROJECT_NOTE}先补上内容，再点「获取建议」。`
        : '还没有建议。点一下「获取建议」，AI 会结合当前项目的任务、证据和未解决的疑问，给出 1～3 条下一步建议。'
    case 'loading':
      return '正在结合项目当前状态分析，请稍等…'
    case 'model':
      return '下面的建议由 AI 结合项目当前状态生成。展开「依据」可以看到它引用了哪条证据或疑问。'
    case 'fallback':
      return `模型暂时没有生成可用建议，正在使用系统规则生成参考建议（原因：${reasonText.value}）。可以点击「重新获取」。`
    case 'local-rule':
      return `暂时连不上后端 AI，正在使用本地规则生成参考建议（原因：${reasonText.value}）。可以点击「重新获取」。`
    case 'error':
      return `模型暂时没有生成可用建议（原因：${reasonText.value}）。可以点击「重新获取」，也可以先按自己的判断推进。`
    default:
      return ''
  }
})

const statusTone = computed(() => {
  if (store.aiStatus === 'idle') return 'neutral'
  return store.aiStatus
})

const statusTag = computed(() => {
  switch (store.aiStatus) {
    case 'idle':
      return '未获取'
    case 'loading':
      return '分析中'
    case 'model':
      return 'AI 生成'
    case 'fallback':
      return '系统规则参考'
    case 'local-rule':
      return '本地规则参考'
    case 'error':
      return '未生成'
    default:
      return ''
  }
})

const requestLabel = computed(() => {
  if (isRequesting.value) return '分析中…'
  if (isBlankProject.value) return '等待项目内容'
  if (store.aiStatus === 'idle') return '获取建议'
  if (store.aiStatus === 'error' || store.aiStatus === 'local-rule') return '重试'
  return '重新获取'
})

/** 契约 5.3：loading 期间禁止重复点击触发并发请求 */
function requestSuggestions() {
  if (isRequesting.value || isBlankProject.value) return

  void store.refreshRecommendations({ forceRefresh: store.aiStatus !== 'idle' }).catch((error: unknown) => {
    // store 内部已处理大多数失败，这里只兜住"请求还没发出去就出错"的异常
    console.warn('[建议] 请求未能完成', error instanceof Error ? error.name : 'unknown')
    store.toast('建议请求没能完成，请稍后再试')
  })
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
  const evidence = deriveEvidenceSnapshots(p, reference)
  const doubts = deriveDoubtSnapshots(p, reference)

  return {
    evidenceById: new Map(
      evidence.map((item, index) => [
        item.evidenceId,
        { id: item.evidenceId, time: p.evidence[index]?.time ?? '', text: item.didWhat },
      ]),
    ),
    doubtById: new Map(doubts.map((item) => [item.doubtId, { id: item.doubtId, text: item.text }])),
  }
})

type ClaimState = 'claimable' | 'claimed' | 'draft'

/**
 * 「是否已认领」只看**真实任务**（建议自带的 taskId / draft 幂等键），
 * 不用数组下标，也不靠页面内存里的标记：
 * 认领之后、刷新之后、重新获取建议之后，同一条建议都会稳定显示成「已认领」。
 */
function claimStateOf(suggestion: Recommendation): ClaimState {
  const current = project.value
  if (current !== undefined && findClaimedTaskFor(current, suggestion) !== null) return 'claimed'
  return suggestion.existingTaskId === null ? 'draft' : 'claimable'
}

/** 顾问区步骤状态徽标配色 */
const STEP_STATUS_STYLE: Record<TaskStatus, string> = {
  todo: 'background:#f1efe8;color:#5f5e5a;border:1px solid #d3d1c7;',
  doing: 'background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;',
  done: 'background:#E1F5EE;color:#0F6E56;border:1px solid #9FE1CB;',
}

function stepStatusStyle(status: TaskStatus | undefined): string {
  return STEP_STATUS_STYLE[status ?? 'todo']
}

/** 顾问区按钮文案：未开始才可认领，进行中 / 已完成直接显示状态并禁用 */
function stepClaimLabel(status: TaskStatus | undefined): string {
  if (status === 'doing') return '进行中'
  if (status === 'done') return '已完成'
  return '认领这一步'
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
 * 认领已有任务，或把新任务候选保存为进行中的正式任务。
 *
 * 重复点击直接返回（store 侧同样幂等）：不新建任务、不递增 projectRevision、不重复写盘。
 * 认领成功后按钮状态由真实任务推导，页面不需要自己记 id。
 */
function claimSuggestion(suggestion: Recommendation) {
  const current = project.value
  if (current === undefined) return

  if (claimStateOf(suggestion) === 'claimed') {
    store.toast('这条建议已经认领过了，任务在「AI 项目顾问」里（进行中）')
    return
  }

  // 建议引用的任务必须真的在当前项目里；找不到（例如服务端引用了别的项目）就按新任务候选处理
  const existingTaskId =
    suggestion.existingTaskId !== null &&
    (current.tasks ?? []).some((task) => task.id === suggestion.existingTaskId)
      ? suggestion.existingTaskId
      : null

  const result =
    existingTaskId === null
      ? store.claimTask({
          draft: {
            title: suggestion.title,
            doneCriteria: suggestion.doneCriteria,
            requestId: suggestion.requestId,
            basisEvidenceIds: suggestion.basisEvidenceIds,
            basisDoubtIds: suggestion.basisDoubtIds,
          },
        })
      : store.claimTask({ taskId: existingTaskId })

  if (!result.ok) store.toast(result.message)
}

/** 顾问区：按 taskId 认领（不用下标）；状态由真实任务驱动 */
function claimStep(step: SuggestedStep) {
  const taskId = step.taskId
  if (taskId === undefined) {
    store.toast('这条步骤没有对应的任务，请先获取建议')
    return
  }
  const result = store.claimTask({ taskId })
  if (!result.ok) store.toast(result.message)
}

/** 顾问区：按 taskId 就这条任务提问（回复为本地演示文案） */
function askStep(step: SuggestedStep) {
  const taskId = step.taskId
  if (taskId === undefined) {
    store.toast('这条步骤没有对应的任务，请先获取建议')
    return
  }
  store.askAboutStep(taskId)
}

/* ------------------------------------------------- 项目基本信息（M2-A） */

/**
 * 数据层（store action / 接口适配）尚未接入：表单已按契约 13.1 就位，
 * 但页面没有真实的保存动作，因此禁用保存并说明原因——不展示假成功。
 */
const PROFILE_PENDING_NOTE =
  '项目基本信息的数据接口尚未接入：可以先填着看，保存暂不可用；接入后会随项目一起保存。'

/* -------------------------------------------------------------- 材料 */

/**
 * M2-A：材料登记 / 解析 / 理解草稿的 store action 尚未接入，
 * 因此上传入口当前只做真实存在的一件事：调用现有的 store.uploadMaterial 登记文件名。
 * 正文不会被读取，界面也不展示"已解析 / 已理解"这类没有发生过的状态。
 */
const MATERIAL_PENDING_NOTE = '现在只登记文件名：正文不会被读取，解析与理解草稿将在数据层接入后开放。'
const materialNotice = ref('')
const materialBusy = ref(false)
/** 真实阶段：只有动作真的成功才会前进（当前只可能到「文件名已登记」） */
const materialStage = ref<'idle' | 'registered' | 'uploading' | 'parsed' | 'understanding' | 'error'>('idle')

/** 未登记过任何文件时显示通用说明；登记成功后换成具体结果（仍然是"只登记文件名"） */
const materialsPendingNotice = computed(() =>
  materialNotice.value !== '' ? materialNotice.value : MATERIAL_PENDING_NOTE,
)

// 切换项目时材料状态回到初始值，不把上一个项目的阶段带过来
watch(
  () => project.value?.projectId,
  () => {
    materialNotice.value = ''
    materialStage.value = 'idle'
  },
)

function registerMaterialName(payload: { file: File; type: MaterialFileType }) {
  if (materialBusy.value) return
  materialBusy.value = true
  try {
    store.uploadMaterial('材料', payload.file.name)
    materialNotice.value = `已登记文件名「${payload.file.name}」；正文尚未读取。`
    materialStage.value = 'registered'
  } finally {
    materialBusy.value = false
  }
}

/* -------------------------------------------------- 材料理解草稿（M2-A） */

const DRAFT_PENDING_HINT = '材料接口接入后，上传 MD 或 TXT 就能在这里看到理解草稿，并逐条确认。'

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
  if (!text.trim() || store.chatLoading) return
  chat.value = ''
  await store.sendChat(text)
  await scrollChat()
}

/**
 * 聊天回答来自系统规则时，在署名后补一句人话原因。
 * 与建议区共用同一份文案表，聊天里也不会出现内部错误码。
 */
function chatFallbackNote(reason: string | null | undefined): string {
  if (reason === null || reason === undefined || reason === '') return ''
  const text = FALLBACK_REASON_TEXT[reason as AdvisorFallbackReason] ?? '系统规则参考'
  return ` · ${text}`
}

async function scrollChat() {
  await nextTick()
  if (chatLog.value) chatLog.value.scrollTop = chatLog.value.scrollHeight
}

watch(() => project.value?.chat.length, scrollChat)

/* -------------------------------------------------------- 提交证据 */

const evidenceForm = ref<InstanceType<typeof EvidenceForm> | null>(null)
const evidenceSubmitting = ref(false)
const savedEvidenceAt = ref('')
const savedEvidenceHint = ref('')

watch(
  () => project.value?.projectId,
  () => {
    savedEvidenceAt.value = ''
    savedEvidenceHint.value = ''
  },
)

async function submitEvidence(input: SubmitEvidenceInput) {
  if (evidenceSubmitting.value) return
  evidenceSubmitting.value = true
  try {
    const result = await store.submitEvidence(input)
    if (result.ok) {
      evidenceForm.value?.reset()
      savedEvidenceAt.value = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
      const usedRuleRecommendation = store.aiStatus === 'fallback' || store.aiStatus === 'local-rule'
      savedEvidenceHint.value = usedRuleRecommendation
        ? '建议暂时使用规则结果'
        : store.aiStatus === 'error'
          ? '建议生成失败，请查看建议区并重试'
          : '建议由 AI 模型生成'
      if (store.aiStatus !== 'model') {
        store.toast(`证据已保存，${savedEvidenceHint.value}`)
      }
    } else {
      // 失败时不重置组件，保留用户已经填写的内容以便修正后重试。
      store.toast(result.message)
    }
  } catch (error: unknown) {
    console.warn('[证据] 提交未能完成', error instanceof Error ? error.name : 'unknown')
    store.toast('证据没有保存，请稍后重试')
  } finally {
    evidenceSubmitting.value = false
  }
}

const openDoubts = computed(() =>
  (project.value?.doubtRecords ?? []).filter((doubt) => doubt.status === 'open'),
)
</script>

<template>
  <!-- 空状态：创建项目 -->
  <ProjectCreate v-if="store.creating || !project" />

  <!-- 项目工作台 -->
  <div v-else>
    <!-- 穿插可视化①：流程条 -->
    <div class="card">
      <div class="card-b" style="padding: 10px 14px 4px">
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
        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">我的项目</div>
          <div class="card-b">
            <select
              class="proj-select"
              :value="project.projectId"
              @change="store.selectProject(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="item in store.projects" :key="item.projectId" :value="item.projectId">
                {{ item.name }}
              </option>
            </select>
            <div style="font-size: 12px; color: #888780; line-height: 1.7; margin-bottom: 8px">
              {{ project.group }} · {{ project.members }}<br />{{ project.updated }}
            </div>
            <button class="btn" style="width: 100%" @click="store.showCreate()">＋ 新建项目</button>
          </div>
        </div>

        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">
            项目基本信息
            <span class="tag" style="background: #f1efe8; color: #5f5e5a; border: 1px solid #d3d1c7">
              即将开放
            </span>
          </div>
          <div class="card-b">
            <ProjectProfileForm
              :profile="null"
              :disabled="true"
              :disabled-note="PROFILE_PENDING_NOTE"
              :project-key="project.projectId"
            />
          </div>
        </div>

        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">
            项目资料
            <span class="tag" style="background: #eeedfe; color: #3c3489; border: 1px solid #cecbf6">
              AI 追踪依据
            </span>
          </div>
          <div class="card-b">
            <div v-if="project.materials.length">
              <div v-for="(m, i) in project.materials" :key="i" class="mat-item">
                <span class="mat-name" :title="m.name">{{ m.name }}</span>
                <span class="tag mat-tag" :style="materialStyle(m.type)">{{ m.type }}</span>
              </div>
              <p class="mat-note">以上只登记了文件名，正文没有被读取。</p>
            </div>
            <div v-else class="empty" style="padding: 4px 0 8px">
              还没有材料。上传 MD 或 TXT 后会先登记文件名；正文解析与理解草稿将在数据层接入后开放。
            </div>

            <MaterialUploader
              :stage="materialStage"
              :busy="materialBusy"
              :register-only="true"
              :notice="materialsPendingNotice"
              @upload="registerMaterialName"
            />
          </div>
        </div>

        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">里程碑进度</div>
          <div class="card-b">
            <div v-for="(m, i) in project.ms" :key="i" class="milestone">
              <div :class="badge(m, i).cls">{{ badge(m, i).text }}</div>
              <div style="flex: 1">
                <div class="ms-name">{{ m.t }}</div>
                <div class="ms-sub">{{ m.sub }}</div>
                <div v-if="m.s === 'cur'" class="ms-bar"><i :style="`width:${m.p}%`"></i></div>
              </div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">近 4 周活跃度</div>
          <div class="card-b" style="padding: 8px">
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
            <span class="tag" style="background: #faeeda; color: #854f0b; border: 1px solid #fac775">{{
              openDoubts.length
            }}</span>
          </div>
          <div class="card-b" style="padding-top: 6px">
            <div v-for="doubt in openDoubts" :key="doubt.id" class="doubt">
              {{ doubt.text }}
              <button
                class="btn"
                style="margin-top: 6px; padding: 3px 10px; font-size: 11.5px"
                @click="store.resolveDoubt(doubt.id)"
              >
                标记已解决
              </button>
            </div>
            <div v-if="!openDoubts.length" class="empty">暂无疑问。推进中产生的不确定会记录在这里。</div>
          </div>
        </div>
      </div>

      <!-- ---------------------------------------------------------- 中栏 -->
      <div>
        <!-- 建议区：六种状态与文案见 docs/contracts.md 5.3，请求只经过 store -->
        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">
            AI 下一步建议
            <span class="tag" style="background: #eeedfe; color: #3c3489; border: 1px solid #cecbf6">
              候选建议
            </span>
          </div>
          <div class="card-b">
            <div class="card-note">
              这里是候选建议：认领之后才会变成项目里的任务，并出现在下方「AI 项目顾问」。
            </div>
            <AiStatus
              :tone="statusTone"
              :tag="statusTag"
              :message="statusLine"
              :action-label="requestLabel"
              :busy="isRequesting || isBlankProject"
              @retry="requestSuggestions"
            />

            <RecommendationList :items="suggestionViews" @claim="claimSuggestion" />

            <div
              v-if="!suggestionViews.length && !isRequesting && aiStatus !== 'error'"
              class="empty"
              style="padding: 4px 0 0"
            >
              {{
                aiStatus === 'idle'
                  ? isBlankProject
                    ? '空白项目还没有可分析的依据：先补充材料或项目目标。'
                    : '点上方按钮开始。'
                  : '这次没有生成建议，可以点上方按钮重新获取。'
              }}
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">
            AI 项目顾问
            <span class="tag" style="background: #e6f1fb; color: #185fa5; border: 1px solid #b5d4f4">
              项目真实任务
            </span>
          </div>
          <div class="card-b">
            <div class="card-note">
              这里只显示已经进入项目的任务与状态（未开始 / 进行中 / 已完成）； 候选建议请在「AI
              下一步建议」里认领。
            </div>
            <div class="ai-banner">{{ project.banner }}</div>

            <div v-if="!project.steps.length" class="empty">
              还没有任务。先在上方「AI 下一步建议」里认领一步，任务会出现在这里并显示进度。
            </div>

            <div class="advisor-steps">
              <div
                v-for="(step, index) in project.steps"
                :key="step.taskId ?? `${step.t}-${index}`"
                class="step-card"
              >
                <div class="sc-top">
                  <div class="sc-no">{{ index + 1 }}</div>
                  <div class="sc-title">{{ step.t }}</div>
                  <span class="tag sc-owner" :style="stepStatusStyle(step.status)">
                    {{ taskStatusText(step.status) }}
                  </span>
                </div>
                <div v-if="step.why" class="sc-why"><b>为什么现在做：</b>{{ step.why }}</div>
                <div v-if="step.done" class="sc-done">完成标准：{{ step.done }}</div>
                <div class="sc-actions">
                  <button class="btn primary" :disabled="step.status !== 'todo'" @click="claimStep(step)">
                    {{ stepClaimLabel(step.status) }}
                  </button>
                  <button class="btn" @click="askStep(step)">就此提问</button>
                  <button class="btn" @click="router.push('/papers')">相关论文</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">
            材料理解草稿
            <span class="tag" style="background: #eeedfe; color: #3c3489; border: 1px solid #cecbf6">
              需逐条确认
            </span>
          </div>
          <div class="card-b">
            <UnderstandingDraftCard
              :draft="null"
              :loading="false"
              :has-material="project.materials.length > 0"
              :can-generate="false"
              :disabled="true"
              :empty-hint="DRAFT_PENDING_HINT"
              :current-material-version="null"
            />
          </div>
        </div>

        <!-- 项目地图已经独立成页面：工作台只留入口，不重复画同一张图 -->
        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">
            项目地图
            <span class="tag" style="background: #e6f1fb; color: #185fa5; border: 1px solid #b5d4f4"
              >独立页面</span
            >
          </div>
          <div class="card-b">
            <div class="card-note">里程碑与任务状态已经挪到「项目地图」页面，避免和工作台重复展示。</div>
            <button class="btn primary" @click="router.push('/map')">查看项目地图</button>
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            向顾问提问
            <span class="tag" style="background: #f1efe8; color: #5f5e5a; border: 1px solid #d3d1c7">
              AI 项目顾问
            </span>
          </div>
          <div class="card-b">
            <div class="chat-notice">
              AI 会结合当前项目的任务、证据、疑问和历史对话回答；上传的文件正文不会自动参与回答。
              对话按项目保存在本地。
            </div>
            <div ref="chatLog" class="chat-log">
              <div v-if="!project.chat.length" class="empty" style="padding: 4px 0">
                还没有对话。把你卡住的地方写下来，AI 会结合当前项目的任务、证据和疑问回答。
              </div>
              <div v-for="(msg, i) in project.chat" :key="i" class="msg" :class="{ me: msg.me }">
                <div>
                  <div class="who" :style="msg.me ? 'text-align:right;' : ''">
                    {{ msg.who
                    }}<span v-if="msg.source === 'fallback' && msg.fallbackReason">{{
                      chatFallbackNote(msg.fallbackReason)
                    }}</span>
                  </div>
                  <div class="bubble">{{ msg.text }}</div>
                </div>
              </div>
              <div v-if="store.chatLoading" class="msg" aria-live="polite">
                <div>
                  <div class="who">AI 正在思考</div>
                  <div class="bubble">正在结合当前项目状态生成回答…</div>
                </div>
              </div>
              <div v-if="store.chatError" class="chat-error" role="alert">{{ store.chatError }}</div>
            </div>
            <div class="chat-input">
              <input
                v-model="chat"
                :disabled="store.chatLoading"
                :maxlength="MAX_ADVISOR_CHAT_QUESTION_LENGTH"
                placeholder="描述你卡住的问题…"
                @keydown.enter="send"
              />
              <button class="btn primary" :disabled="store.chatLoading || !chat.trim()" @click="send">
                {{ store.chatLoading ? '思考中…' : '发送' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ---------------------------------------------------------- 右栏 -->
      <div>
        <div class="card" style="margin-bottom: 14px">
          <div class="card-h">提交步骤证据</div>
          <div class="card-b">
            <div v-if="savedEvidenceAt" class="evidence-save-status" role="status" aria-live="polite">
              <strong>证据已保存（{{ savedEvidenceAt }}）</strong>
              <span> · {{ savedEvidenceHint }}</span>
            </div>
            <EvidenceForm
              ref="evidenceForm"
              :tasks="project.tasks"
              :project-key="project.projectId"
              :submitting="evidenceSubmitting"
              @submit="submitEvidence"
            />
          </div>
        </div>

        <div class="card">
          <div class="card-h">最近证据</div>
          <div class="card-b" style="padding-top: 8px">
            <div class="tl">
              <div v-for="(item, i) in project.evidence" :key="i" class="tl-item">
                <div class="tl-time">{{ item.time }}</div>
                <div class="tl-text">{{ item.text }}</div>
                <div class="tl-who">{{ item.who }}</div>
              </div>
              <div v-if="!project.evidence.length" class="empty" style="padding-left: 0">
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
.card-note {
  font-size: 11.5px;
  color: #888780;
  line-height: 1.6;
  margin-bottom: 8px;
}

.chat-notice {
  border: 1px solid #d3d1c7;
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 10px;
  background: #f8f7f4;
  color: #5f5e5a;
  font-size: 11.5px;
  line-height: 1.6;
}

.chat-error {
  margin-top: 8px;
  border: 1px solid #f2a7a0;
  border-radius: 8px;
  padding: 7px 9px;
  color: #a32d2d;
  background: #fff4f2;
  font-size: 12px;
}

.evidence-save-status {
  border: 1px solid #9fe1cb;
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 12px;
  background: #e1f5ee;
  color: #0f6e56;
  font-size: 12px;
  line-height: 1.5;
}

/* 旧材料记录：只登记过文件名，正文没有被读取 */
.mat-note {
  margin: 6px 0 8px;
  font-size: 11.5px;
  color: #888780;
  line-height: 1.6;
}
</style>
