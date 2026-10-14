<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SubmitEvidenceInput } from '@/domain/recommendation'
import type { Task } from '@/types/platform'

const props = defineProps<{
  tasks: Task[]
  projectKey: string
  submitting?: boolean
}>()

const emit = defineEmits<{ submit: [input: SubmitEvidenceInput] }>()

type EvidenceMode = 'progress' | 'complete'

const mode = ref<EvidenceMode>('progress')
const taskId = ref('')
const didWhat = ref('')
const foundWhat = ref('')
const stillUnsure = ref('')
const attachmentName = ref<string | null>(null)
const attachmentInput = ref<HTMLInputElement | null>(null)
const submissionId = ref(newSubmissionId())

const taskOptions = computed(() => props.tasks.filter((task) => task.status !== 'done'))
const selectedTask = computed(() => props.tasks.find((task) => task.id === taskId.value))

function newSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `submission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function reset() {
  mode.value = 'progress'
  taskId.value = ''
  didWhat.value = ''
  foundWhat.value = ''
  stillUnsure.value = ''
  attachmentName.value = null
  submissionId.value = newSubmissionId()
  if (attachmentInput.value) attachmentInput.value.value = ''
}

function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement
  attachmentName.value = input.files?.[0]?.name ?? null
}

function submit() {
  const foundParts = [foundWhat.value.trim()].filter((value) => value !== '')
  emit('submit', {
    submissionId: submissionId.value,
    taskId: taskId.value || null,
    didWhat: didWhat.value,
    foundWhat: foundParts.length > 0 ? foundParts.join('；') : null,
    stillUnsure: stillUnsure.value || null,
    attachmentName: attachmentName.value,
    complete: mode.value === 'complete',
  })
}

watch(
  () => props.projectKey,
  () => reset(),
)

defineExpose({ reset })
</script>

<template>
  <form class="evidence-form" @submit.prevent="submit">
    <label for="evidence-task">对应任务</label>
    <select id="evidence-task" v-model="taskId" class="proj-select">
      <option value="">其他进展（不关联任务）</option>
      <option v-for="task in taskOptions" :key="task.id" :value="task.id">
        {{ task.title }} · {{ task.status === 'doing' ? '进行中' : '待认领' }}
      </option>
    </select>

    <fieldset class="mode-switch">
      <legend>这次提交的目的</legend>
      <button
        type="button"
        class="mode-option"
        :class="{ active: mode === 'progress' }"
        @click="mode = 'progress'"
      >
        记录进展
      </button>
      <button
        type="button"
        class="mode-option complete"
        :class="{ active: mode === 'complete' }"
        :disabled="props.submitting || selectedTask?.status !== 'doing'"
        @click="mode = 'complete'"
      >
        确认完成
      </button>
    </fieldset>
    <p v-if="mode === 'complete' && selectedTask" class="mode-hint">
      提交后“{{ selectedTask.title }}”会从进行中变为已完成。
    </p>
    <p v-else-if="mode === 'complete'" class="mode-hint error">确认完成需要先选择一个已认领的进行中任务。</p>

    <label for="evidence-did">完成了什么 <small>（必填）</small></label>
    <textarea id="evidence-did" v-model="didWhat" required maxlength="300" placeholder="一句话说明产出"></textarea>

    <label for="evidence-found">发现了什么 <small>（异常、结论或新线索）</small></label>
    <textarea id="evidence-found" v-model="foundWhat" maxlength="300"></textarea>

    <label for="evidence-unsure">还有什么不确定</label>
    <textarea id="evidence-unsure" v-model="stillUnsure" maxlength="300" placeholder="写下来的内容会进入未解决的疑问"></textarea>

    <div
      class="upbox"
      style="margin-top:12px;"
      :class="{ has: attachmentName }"
      @click="attachmentInput?.click()"
    >
      <template v-if="attachmentName">✓ 附件：{{ attachmentName }}</template>
      <template v-else>＋ 附加 notebook、截图或结果文件</template>
    </div>
    <input ref="attachmentInput" type="file" style="display:none" @change="chooseFile" />

    <div class="form-actions">
      <button
        class="submit"
        type="submit"
        :disabled="props.submitting || (mode === 'complete' && selectedTask?.status !== 'doing')"
      >
        {{ props.submitting ? '保存中…' : mode === 'complete' ? '保存证据并确认完成' : '只保存这次进展' }}
      </button>
      <span class="form-note">保存证据后，系统会再请求下一步建议。</span>
    </div>
  </form>
</template>

<style scoped>
.evidence-form label {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  margin: 12px 0 5px;
  color: #444441;
}

.evidence-form label small {
  font-weight: 400;
  color: #888780;
}

.evidence-form textarea {
  width: 100%;
  border: 1px solid #d3d1c7;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12.5px;
  font-family: inherit;
  resize: vertical;
  min-height: 48px;
  outline: none;
}

.evidence-form textarea:focus,
.evidence-form select:focus {
  border-color: #378ADD;
}

.mode-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  border: 0;
  margin: 12px 0 0;
}

.mode-switch legend {
  grid-column: 1 / -1;
  font-size: 12.5px;
  font-weight: 600;
  color: #444441;
  margin-bottom: 1px;
}

.mode-option {
  border: 1px solid #d3d1c7;
  border-radius: 8px;
  background: #fff;
  color: #444441;
  padding: 8px 6px;
  font-size: 12px;
}

.mode-option.active {
  border-color: #185FA5;
  color: #0C447C;
  background: #E6F1FB;
  font-weight: 600;
}

.mode-option.complete.active {
  border-color: #1D9E75;
  color: #0F6E56;
  background: #E1F5EE;
}

.mode-option:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.mode-hint,
.form-note {
  color: #5f5e5a;
  font-size: 11.5px;
  line-height: 1.5;
  margin-top: 6px;
}

.mode-hint.error {
  color: #854F0B;
}

.form-actions {
  margin-top: 14px;
}

.evidence-form button.submit {
  width: 100%;
  padding: 9px;
  background: #1D9E75;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 13.5px;
  font-weight: 600;
}

.evidence-form button.submit:disabled {
  cursor: wait;
  opacity: 0.65;
}

.form-note {
  display: block;
  text-align: center;
}
</style>
