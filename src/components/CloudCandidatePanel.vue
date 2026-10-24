<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useCloudStore } from '@/stores/cloud'
import type { CloudMilestoneCandidate } from '@/types/platform'

/**
 * 阶段候选（契约 23.7）
 * ----------------------------------------------------------------------------
 * 候选只读：生成后必须由学生逐条「确认创建」，才会调用创建阶段接口。
 * 页面不伪造候选，也不把 fallback 当成失败。
 */
const cloud = useCloudStore()

const now = ref(Date.now())
const createdIds = ref<string[]>([])
const expiredIds = ref<string[]>([])
const creatingId = ref<string | null>(null)
const confirmError = ref('')
const createdCount = ref(0)
let clock: ReturnType<typeof setInterval> | null = null

const loading = computed(() => cloud.candidatesStatus === 'loading')
const visibleCandidates = computed(() =>
  cloud.candidates.filter((candidate) => !createdIds.value.includes(candidate.candidateId)),
)
const showEmpty = computed(() =>
  cloud.candidatesStatus === 'ready' && visibleCandidates.value.length === 0 && createdCount.value === 0,
)

function isExpired(candidate: CloudMilestoneCandidate): boolean {
  const expiresAt = Date.parse(candidate.expiresAt)
  return Number.isNaN(expiresAt) || expiresAt <= now.value || expiredIds.value.includes(candidate.candidateId)
}

async function generate(): Promise<void> {
  createdIds.value = []
  expiredIds.value = []
  creatingId.value = null
  confirmError.value = ''
  createdCount.value = 0
  await cloud.generateCandidates({ maxCandidates: 2 })
}

async function confirm(candidate: CloudMilestoneCandidate): Promise<void> {
  if (isExpired(candidate) || creatingId.value !== null) return
  creatingId.value = candidate.candidateId
  confirmError.value = ''
  const result = await cloud.createMilestone({
    name: candidate.name,
    goal: candidate.goal,
    doneCriteria: candidate.doneCriteria,
    status: 'planned',
    source: 'ai-candidate',
    candidateId: candidate.candidateId,
    confirmedByUser: true,
  })
  if (!result.ok) {
    if (result.code === 'CANDIDATE_EXPIRED') {
      expiredIds.value = [...expiredIds.value, candidate.candidateId]
      confirmError.value = '候选已过期，请重新生成。'
    } else {
      confirmError.value = result.message
    }
    creatingId.value = null
    return
  }

  createdIds.value = [...createdIds.value, candidate.candidateId]
  createdCount.value += 1
  creatingId.value = null
  await cloud.refreshMilestones()
}

watch(
  () => cloud.project?.projectId ?? null,
  (current, previous) => {
    if (current === previous) return
    createdIds.value = []
    expiredIds.value = []
    creatingId.value = null
    confirmError.value = ''
    createdCount.value = 0
  },
)

onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})

onUnmounted(() => {
  if (clock !== null) clearInterval(clock)
})

defineExpose({ generate })
</script>

<template>
  <section class="card candidate-panel">
    <div class="card-h">
      <span>阶段候选</span>
      <span v-if="cloud.candidatesNotice" class="badge">服务端规则生成</span>
    </div>
    <div class="card-b">
      <p class="candidate-hint">
        根据项目资料和已确认材料生成候选；候选不会自动写入项目，需要你逐条确认。
      </p>

      <div class="candidate-actions">
        <button class="btn primary" type="button" :disabled="loading" @click="generate">
          {{ loading ? '生成中…' : '生成候选' }}
        </button>
      </div>

      <p v-if="loading" class="candidate-state">正在生成阶段候选…</p>
      <p v-if="cloud.candidatesError" class="candidate-state candidate-state-error" role="alert">
        {{ cloud.candidatesError.message }}
        <button class="btn" type="button" :disabled="loading" @click="generate">重试</button>
      </p>
      <p v-if="cloud.candidatesNotice" class="candidate-state">
        {{ cloud.candidatesNotice }}
      </p>
      <p v-if="confirmError" class="candidate-state candidate-state-error" role="alert">
        {{ confirmError }}
      </p>
      <p v-if="createdCount > 0" class="candidate-state">
        已创建 {{ createdCount }} 个阶段。
      </p>
      <p v-if="showEmpty" class="candidate-state">
        本次没有生成候选，请调整项目资料后重试。
      </p>

      <article
        v-for="candidate in visibleCandidates"
        :key="candidate.candidateId"
        class="candidate-card"
      >
        <div class="candidate-title-row">
          <h3>{{ candidate.name }}</h3>
          <span v-if="isExpired(candidate)" class="candidate-expired">已过期</span>
        </div>
        <p>{{ candidate.goal }}</p>
        <p><b>完成标准：</b>{{ candidate.doneCriteria }}</p>

        <div v-if="candidate.suggestedTasks.length > 0" class="candidate-section">
          <b>建议任务</b>
          <ul>
            <li v-for="task in candidate.suggestedTasks" :key="task.title">
              <span>{{ task.title }}</span>
              <small>{{ task.doneCriteria }}</small>
            </li>
          </ul>
        </div>

        <div v-if="candidate.risks.length > 0" class="candidate-section">
          <b>风险</b>
          <ul>
            <li v-for="risk in candidate.risks" :key="risk">{{ risk }}</li>
          </ul>
        </div>

        <div v-if="candidate.sources.length > 0" class="candidate-section">
          <b>依据材料</b>
          <ul>
            <li v-for="source in candidate.sources" :key="`${source.materialId}:${source.segmentId}`">
              {{ source.materialName }} 第 {{ source.startLine }}–{{ source.endLine }} 行
            </li>
          </ul>
        </div>

        <p v-if="isExpired(candidate)" class="candidate-state candidate-state-error">
          候选已过期，请重新生成。
        </p>
        <div class="candidate-actions">
          <button
            class="btn primary"
            type="button"
            :disabled="loading || creatingId !== null || isExpired(candidate)"
            @click="confirm(candidate)"
          >
            {{ creatingId === candidate.candidateId ? '创建中…' : (isExpired(candidate) ? '已过期' : '确认创建') }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.candidate-panel { margin-bottom: 14px; }
.candidate-hint,
.candidate-state {
  color: #5f5e5a;
  line-height: 1.65;
  font-size: 12.5px;
}
.candidate-state {
  margin: 10px 0;
  padding: 8px 10px;
  background: #f4f3ec;
  border: 1px solid #e4e2da;
  border-radius: 8px;
}
.candidate-state-error {
  background: #FAEEDA;
  border-color: #FAC775;
  color: #633806;
}
.candidate-actions { margin: 10px 0; }
.candidate-card {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed #efeee9;
}
.candidate-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.candidate-title-row h3 { margin: 0; font-size: 14px; }
.candidate-expired { color: #854F0B; font-size: 11.5px; }
.candidate-card > p { margin: 6px 0; color: #5f5e5a; font-size: 12.5px; line-height: 1.65; }
.candidate-section { margin-top: 8px; color: #5f5e5a; font-size: 12.5px; line-height: 1.65; }
.candidate-section ul { margin: 4px 0 0; padding-left: 18px; }
.candidate-section li { margin: 3px 0; }
.candidate-section small { display: block; color: #888780; font-size: 11.5px; }
</style>
