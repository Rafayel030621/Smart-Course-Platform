<script setup lang="ts">
type AiStatusTone = 'neutral' | 'loading' | 'model' | 'fallback' | 'local-rule' | 'error'

const props = defineProps<{
  tone: AiStatusTone
  tag: string
  message: string
  actionLabel: string
  busy?: boolean
}>()

const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="ai-status" :class="`is-${props.tone}`" role="status" aria-live="polite">
    <div class="ai-status-head">
      <span class="ai-status-tag">{{ props.tag }}</span>
      <span v-if="props.tone === 'loading'" class="ai-status-spinner" aria-hidden="true"></span>
    </div>
    <p class="ai-status-message">{{ props.message }}</p>
    <button class="btn primary ai-status-action" :disabled="props.busy" @click="emit('retry')">
      {{ props.actionLabel }}
    </button>
  </div>
</template>

<style scoped>
.ai-status {
  border: 1px solid #AFA9EC;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
  color: #3C3489;
  background: linear-gradient(90deg, #EEEDFE, #E6F1FB);
}

.ai-status.is-fallback {
  color: #854F0B;
  border-color: #FAC775;
  background: #FAEEDA;
}

.ai-status.is-neutral {
  color: #5f5e5a;
  border-color: #d3d1c7;
  background: #f8f7f4;
}

.ai-status.is-loading {
  color: #0C447C;
  border-color: #B5D4F4;
  background: #E6F1FB;
}

.ai-status.is-model {
  color: #3C3489;
}

.ai-status.is-local-rule {
  color: #5f5e5a;
  border-color: #d3d1c7;
  background: #f1efe8;
}

.ai-status.is-error {
  color: #5f5e5a;
  border-color: #d3d1c7;
  background: #f8f7f4;
}

.ai-status-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-status-tag {
  font-size: 11px;
  font-weight: 600;
}

.ai-status-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ai-spin 0.8s linear infinite;
}

.ai-status-message {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.6;
}

.ai-status-action {
  margin-top: 10px;
}

@keyframes ai-spin {
  to { transform: rotate(360deg); }
}
</style>
