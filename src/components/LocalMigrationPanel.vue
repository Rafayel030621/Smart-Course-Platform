<script setup lang="ts">
import type { LocalMigrationCandidate } from '@/types/platform'

const props = defineProps<{
  candidates: LocalMigrationCandidate[]
  status: string
  error?: string
  busy?: boolean
}>()

const emit = defineEmits<{
  confirm: [projectId: string]
  retry: [projectId: string]
  dismiss: []
}>()

function candidateLabel(candidate: LocalMigrationCandidate): string {
  return `${candidate.name} · ${candidate.taskCount} 个任务 · ${candidate.evidenceCount} 条证据`
}
</script>

<template>
  <section v-if="props.candidates.length" class="migration-panel card" aria-labelledby="migration-title">
    <div class="card-h">
      <span id="migration-title">发现本地项目</span>
      <span class="tag" style="background:#FAEEDA;color:#854F0B;border:1px solid #FAC775;">
        需要确认
      </span>
    </div>
    <div class="card-b">
      <p class="migration-copy">
        登录后发现以下浏览器本地项目。只有你明确确认后，平台才会迁移到当前账号；迁移失败时本地数据仍会保留。
      </p>
      <p v-if="props.error" class="migration-error" role="alert">{{ props.error }}</p>
      <div v-for="candidate in props.candidates" :key="candidate.localProjectId" class="migration-row">
        <div>
          <strong>{{ candidate.name }}</strong>
          <p>{{ candidateLabel(candidate) }}</p>
          <p v-if="candidate.blockReason" class="migration-error">这个项目暂时不能迁移，请先修复本地数据。</p>
          <p v-if="candidate.errorMessage" class="migration-error">{{ candidate.errorMessage }}</p>
        </div>
        <div class="migration-actions">
          <button
            v-if="candidate.status === 'pending-confirmation'"
            class="btn primary"
            type="button"
            :disabled="props.busy || candidate.blockReason !== null"
            @click="emit('confirm', candidate.localProjectId)"
          >
            {{ props.busy && props.status === 'migrating' ? '迁移中…' : '确认迁移' }}
          </button>
          <button
            v-else-if="candidate.status === 'failed'"
            class="btn"
            type="button"
            :disabled="props.busy"
            @click="emit('retry', candidate.localProjectId)"
          >重试</button>
          <span v-else-if="candidate.status === 'succeeded'" class="migration-ok">已迁移</span>
        </div>
      </div>
      <button class="btn" type="button" @click="emit('dismiss')">稍后处理</button>
    </div>
  </section>
</template>

<style scoped>
.migration-panel { max-width: 760px; margin: 20px auto; }
.migration-copy { color:#5f5e5a; line-height:1.7; margin-bottom:12px; }
.migration-row { display:flex; align-items:center; justify-content:space-between; gap:16px; border-top:1px dashed #efeee9; padding:12px 0; }
.migration-row p { margin-top:4px; font-size:12px; color:#888780; }
.migration-actions { flex-shrink:0; }
.migration-error { color:#854F0B !important; }
.migration-ok { color:#0F6E56; font-size:12px; }
@media (max-width:560px) { .migration-row { align-items:flex-start; flex-direction:column; } }
</style>
