<script lang="ts">
/**
 * 会话归属：`cloud.chat` 是单份内存状态，不带 projectId。
 * 新建/切换项目时本组件会随 `v-if` 重新挂载，新实例用首次渲染比较不出「项目变了」，
 * 所以把「上一次显示的是哪个项目」放在模块作用域，跨挂载保留。
 */
let lastChatProjectId: string | null = null
</script>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useCloudStore } from '@/stores/cloud'
import { MAX_ADVISOR_CHAT_QUESTION_LENGTH } from '@/domain/recommendation'
import type { AdvisorFallbackReason } from '@/domain/recommendation'

/**
 * AI 顾问（云端聊天，契约 6.4 / 23.7）
 * ----------------------------------------------------------------------------
 * 三条边界，写在页面上而不是只写在注释里：
 *   1. 后端只提供无状态聊天接口，历史由客户端每次回传 —— 刷新、换设备都看不到历史，
 *      所以标题写「本次会话」，并且不渲染「会话列表」这种不存在的入口；
 *   2. 失败时保留原问题（`chat.pendingQuestion`），用户可以一键重试，不用重打；
 *   3. 来源与依据说人话：模型/兜底、引用到哪份材料的哪几行，不显示内部字段名。
 */
const cloud = useCloudStore()

const question = ref('')
const listRef = ref<HTMLElement | null>(null)

const chat = computed(() => cloud.chat)
const sending = computed(() => chat.value.status === 'loading')
const messages = computed(() => chat.value.messages)
const failed = computed(() => chat.value.error !== null && chat.value.pendingQuestion !== null)

const SOURCE_TEXT: Record<'model' | 'fallback', string> = {
  model: 'AI 模型回答',
  fallback: '服务端规则兜底',
}

const FALLBACK_TEXT: Record<AdvisorFallbackReason, string> = {
  MODEL_TIMEOUT: '模型响应超时，这条回答由服务端规则生成',
  MODEL_UNAVAILABLE: '模型服务暂时不可用，这条回答由服务端规则生成',
  MODEL_NOT_CONFIGURED: '当前环境没有配置模型，这条回答由服务端规则生成',
  INVALID_MODEL_OUTPUT: '模型输出不合规，这条回答由服务端规则生成',
  RATE_LIMITED: '请求过于频繁，这条回答由服务端规则生成',
}

function sourceText(message: (typeof messages.value)[number]): string {
  return SOURCE_TEXT[message.source]
}

function fallbackText(message: (typeof messages.value)[number]): string | null {
  if (message.source !== 'fallback') return null
  const reason = message.fallbackReason as AdvisorFallbackReason | null
  if (reason === null) return '这条回答由服务端规则生成'
  return FALLBACK_TEXT[reason] ?? '这条回答由服务端规则生成'
}

function citationText(startLine: number, endLine: number, name: string): string {
  return `${name} 第 ${startLine}–${endLine} 行`
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const element = listRef.value
  if (element !== null) element.scrollTop = element.scrollHeight
}

const currentProjectId = cloud.project?.projectId ?? null
if (lastChatProjectId !== null && currentProjectId !== null && lastChatProjectId !== currentProjectId) {
  cloud.clearChat()
}
if (currentProjectId !== null) lastChatProjectId = currentProjectId

/**
 * 同一实例内的切换（不重挂载）也要清空：聊天历史只存在于内存，
 * 混在一起会让人以为第二个项目里有这些对话。
 */
watch(
  () => cloud.project?.projectId ?? null,
  (current, previous) => {
    if (previous !== undefined && current !== previous) cloud.clearChat()
  },
)

watch(
  () => messages.value.length,
  () => {
    void scrollToBottom()
  },
)

async function send(): Promise<void> {
  const text = question.value.trim()
  if (text === '' || sending.value) return
  const result = await cloud.sendChat({ question: text })
  if (result.ok) question.value = ''
  await scrollToBottom()
}

async function retry(): Promise<void> {
  if (sending.value) return
  await cloud.retryChat()
  await scrollToBottom()
}

function clear(): void {
  cloud.clearChat()
  question.value = ''
}
</script>

<template>
  <section class="card chat-card">
    <div class="card-h chat-head">
      <span>AI 顾问</span>
      <span class="badge">本次会话</span>
      <button
        v-if="messages.length > 0 || question !== ''"
        class="btn"
        type="button"
        :disabled="sending"
        @click="clear"
      >
        清空
      </button>
    </div>

    <div class="card-b">
      <p class="chat-note">
        聊天记录暂不保存：刷新或换设备后这里会清空。回答只依据当前阶段、任务、证据和你已确认的材料。
      </p>

      <div ref="listRef" class="chat-list">
        <p v-if="messages.length === 0 && !sending" class="hint">
          还没有对话。可以问「当前阶段下一步该做什么」「这个结论还缺什么证据」。
        </p>

        <div
          v-for="message in messages"
          :key="message.clientId"
          class="chat-message"
          :class="message.role"
        >
          <div class="chat-bubble">
            <p class="chat-text">{{ message.text }}</p>

            <div v-if="message.role === 'assistant'" class="chat-meta">
              <span class="badge">{{ sourceText(message) }}</span>
              <small v-if="fallbackText(message)">{{ fallbackText(message) }}</small>
            </div>

            <ul v-if="message.role === 'assistant' && message.citations.length" class="chat-citations">
              <li v-for="citation in message.citations" :key="`${message.clientId}-${citation.segmentId}`">
                依据：{{ citationText(citation.startLine, citation.endLine, citation.materialName) }}
              </li>
            </ul>
          </div>
        </div>

        <p v-if="sending" class="hint thinking">正在思考…</p>
      </div>

      <div v-if="failed" class="cloud-error chat-error">
        <span>{{ chat.error?.message ?? '这次提问没有成功，请重试' }}</span>
        <button class="btn" type="button" :disabled="sending" @click="retry">重试</button>
      </div>

      <form class="chat-composer" @submit.prevent="send">
        <textarea
          v-model="question"
          :maxlength="MAX_ADVISOR_CHAT_QUESTION_LENGTH"
          placeholder="问一个和当前阶段有关的具体问题"
          aria-label="向 AI 顾问提问"
          :disabled="sending"
          required
        ></textarea>
        <button class="btn primary" type="submit" :disabled="sending || question.trim() === ''">
          {{ sending ? '发送中…' : '发送' }}
        </button>
      </form>
    </div>
  </section>
</template>

<style scoped>
.chat-card { margin-bottom: 20px; }
.chat-head { flex-wrap: wrap; gap: 8px; }
.chat-head .badge { background: #eef4fb; color: #185FA5; border-color: #b8d3ee; }
.chat-head .btn { margin-left: auto; padding: 4px 10px; font-size: 11.5px; }
.chat-note { margin-bottom: 10px; padding: 8px 10px; background: #f4f3ec; border: 1px solid #e4e2da; border-radius: 8px; color: #5f5e5a; font-size: 12px; line-height: 1.6; }
.chat-list { max-height: 360px; overflow: auto; display: grid; gap: 10px; padding: 2px; }
.hint { color: #5f5e5a; font-size: 12.5px; line-height: 1.7; }
.thinking { color: #185FA5; }
.chat-message { display: flex; }
.chat-message.user { justify-content: flex-end; }
.chat-bubble { max-width: 88%; border-radius: 12px; padding: 9px 12px; border: 1px solid #e4e2da; background: #fcfcfa; }
.chat-message.user .chat-bubble { background: #eef4fb; border-color: #b8d3ee; }
.chat-text { white-space: pre-wrap; font-size: 13px; line-height: 1.7; color: #2c2c2a; overflow-wrap: anywhere; }
.chat-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 7px; }
.chat-meta small { color: #854F0B; font-size: 11.5px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #f1efe8; color: #5f5e5a; border: 1px solid #d3d1c7; }
.chat-citations { margin-top: 7px; padding-left: 16px; list-style: disc; }
.chat-citations li { font-size: 11.5px; color: #5f5e5a; line-height: 1.6; }
.chat-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.chat-error .btn { padding: 4px 10px; font-size: 11.5px; }
.chat-composer { display: flex; gap: 8px; align-items: flex-end; margin-top: 12px; }
.chat-composer textarea { flex: 1; min-height: 56px; max-height: 160px; resize: vertical; border: 1px solid #d3d1c7; border-radius: 10px; padding: 9px 11px; font: inherit; font-size: 13px; outline: none; }
.chat-composer textarea:focus { border-color: #378ADD; }
.chat-composer .btn { flex-shrink: 0; padding: 9px 16px; }
@media (max-width: 520px) {
  .chat-composer { flex-direction: column; align-items: stretch; }
  .chat-composer .btn { width: 100%; }
  .chat-error { flex-direction: column; align-items: flex-start; }
}
</style>
