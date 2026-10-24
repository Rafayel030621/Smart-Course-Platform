<script setup lang="ts">
import { computed, ref } from 'vue'
import { useCloudStore } from '@/stores/cloud'
import { usePlatformStore } from '@/stores/platform'
import type { AdvisorFallbackReason } from '@/domain/recommendation'

/**
 * 云端 AI 建议（契约 23.5）
 * ----------------------------------------------------------------------------
 * 只负责「当前阶段建议」这一段：先让 store 组装阶段上下文，再请求建议。
 * 页面不拼提示词、不伪造建议，也不把 fallback 当成失败。
 */
const cloud = useCloudStore()
const platform = usePlatformStore()

const error = ref('')
const advisor = computed(() => cloud.advisor)
const isCloud = computed(() => platform.isCloudSource !== false)
const authenticated = computed(() => platform.isAuthenticated !== false)
const loading = computed(() => advisor.value.status === 'loading')
const suggestions = computed(() => advisor.value.suggestions)
const ready = computed(() => advisor.value.status === 'ready')

const FALLBACK_TEXT: Record<AdvisorFallbackReason, string> = {
  MODEL_TIMEOUT: '模型响应超时，本次建议由服务端规则生成。',
  MODEL_UNAVAILABLE: '模型服务暂时不可用，本次建议由服务端规则生成。',
  MODEL_NOT_CONFIGURED: '当前环境没有配置模型，本次建议由服务端规则生成。',
  INVALID_MODEL_OUTPUT: '模型输出不合规，本次建议由服务端规则生成。',
  RATE_LIMITED: '请求过于频繁，本次建议由服务端规则生成。',
}

const sourceText = computed(() => {
  if (advisor.value.source === 'model') return '模型生成（model）'
  if (advisor.value.source === 'fallback') return '服务端规则兜底（fallback）'
  if (advisor.value.source === 'local-rule') return '本地规则兜底（local-rule）'
  return '尚未生成'
})

const fallbackText = computed(() => {
  const reason = advisor.value.fallbackReason
  if (reason === null) return '本次未使用模型生成，建议由服务端规则生成。'
  return FALLBACK_TEXT[reason] ?? '本次未使用模型生成，建议由服务端规则生成。'
})

const failureMessage = computed(() => {
  if (error.value !== '') return error.value
  if (advisor.value.error !== null) return advisor.value.error.message
  if (advisor.value.status === 'error') return '生成建议失败，请稍后重试。'
  return ''
})

async function generate(): Promise<void> {
  if (!isCloud.value || !authenticated.value || loading.value) return
  error.value = ''
  const context = cloud.buildAdvisorContext()
  if (!context.ok) {
    error.value = context.message || '当前项目上下文不完整，暂时无法生成建议。'
    return
  }
  const result = await cloud.refreshAdvisor({ forceRefresh: true })
  if (!result.ok) error.value = result.message || '生成建议失败，请稍后重试。'
}
</script>

<template>
  <section class="card advisor-card">
    <div class="card-h">
      <span>AI 建议</span>
      <span class="badge">{{ sourceText }}</span>
    </div>
    <div class="card-b">
      <p v-if="!isCloud" class="advisor-state">
        AI 建议只对云端项目开放；本地项目不会调用模型，也不会显示本地拼接的建议。
      </p>
      <p v-else-if="!authenticated" class="advisor-state" role="status">
        登录状态已失效，请重新登录后再生成建议。
      </p>
      <template v-else>
        <p v-if="advisor.status === 'idle' && failureMessage === ''" class="advisor-hint">
          结合当前阶段、任务、进展和已确认材料，生成下一步可执行建议。
        </p>
        <p v-if="loading" class="advisor-hint">正在结合当前阶段生成建议…</p>
        <p v-if="failureMessage !== ''" class="advisor-state advisor-state-error" role="alert">
          {{ failureMessage }}
          <button class="btn" type="button" :disabled="loading" @click="generate">重试</button>
        </p>
        <p v-if="ready && advisor.source === 'fallback'" class="advisor-state">
          {{ fallbackText }}
        </p>

        <div class="advisor-actions">
          <button class="btn primary" type="button" :disabled="loading" @click="generate">
            {{ loading ? '生成中…' : (ready ? '重新生成建议' : '生成建议') }}
          </button>
        </div>

        <div v-if="ready" class="advisor-suggestions">
          <p v-if="suggestions.length === 0" class="advisor-state" role="status">
            本次没有返回可用建议，请稍后重试。
          </p>
          <article
            v-for="suggestion in suggestions"
            :key="suggestion.id"
            class="advisor-suggestion"
          >
            <h3>{{ suggestion.title }}</h3>
            <p>{{ suggestion.whyNow }}</p>
            <p><b>完成标准：</b>{{ suggestion.doneCriteria }}</p>
          </article>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.advisor-card { margin-bottom: 14px; }
.advisor-hint { color: #5f5e5a; line-height: 1.7; }
.advisor-state { margin: 10px 0; padding: 8px 10px; background: #f4f3ec; border: 1px solid #e4e2da; border-radius: 8px; color: #5f5e5a; font-size: 12.5px; line-height: 1.6; }
.advisor-state-error { background: #FAEEDA; border-color: #FAC775; color: #633806; }
.advisor-actions { margin: 12px 0; }
.advisor-suggestions { display: grid; gap: 10px; margin-top: 12px; }
.advisor-suggestion { border-top: 1px dashed #efeee9; padding-top: 10px; }
.advisor-suggestion h3 { margin: 0 0 6px; font-size: 14px; }
.advisor-suggestion p { margin: 0 0 5px; color: #5f5e5a; font-size: 12.5px; line-height: 1.65; }
</style>
