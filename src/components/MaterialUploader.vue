<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  MATERIAL_ACCEPT,
  MATERIAL_MAX_BYTES,
  MATERIAL_UNSUPPORTED_NOTE,
  materialTypeOf,
  type MaterialFileType,
} from './materialTypes'

/**
 * 材料上传入口（契约 15.1，雍-2）
 * ----------------------------------------------------------------------------
 * 只做三件事：选择文件 → 本地二次校验（类型 / 空文件 / 1 MB）→ 把**原始 File**交给父组件。
 *
 * 三条硬规则：
 *   1. 不在组件里按 UTF-8 预解码文件内容（会破坏 GBK 文件），字节/base64 由数据层负责；
 *   2. 非法文件必须给可见的中文提示，不静默忽略；
 *   3. busy 期间不允许再次选择或提交，避免重复上传。
 *
 * 上传、解析、生成理解草稿三个阶段由父组件通过 stage 驱动，组件只显示进度。
 */

const props = defineProps<{
  /**
   * 当前真实阶段，由父组件按"真的有动作成功"驱动：
   * idle 还没开始 / registered 只登记了文件名 / uploading 上传解析中 /
   * parsed 已解析 / understanding 生成草稿中 / error 上一次失败
   */
  stage?: 'idle' | 'registered' | 'uploading' | 'parsed' | 'understanding' | 'error'
  /** 处理中：禁用入口，防止重复提交 */
  busy?: boolean
  /** 失败原因（中文，父组件已转成用户能懂的话） */
  errorText?: string | null
  /** 额外说明（中文），例如"当前先登记文件名" */
  notice?: string | null
  /** 仅登记文件名（数据层未接入时的降级模式）：不做解析、不理解正文 */
  registerOnly?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** `materialId` 只在「重新上传某一份材料」时出现（换版时 version + 1，契约 14.5 第 4 条） */
  upload: [{ file: File; type: MaterialFileType; materialId?: string }]
  retry: []
}>()

const input = ref<HTMLInputElement | null>(null)
const localError = ref('')
const selectedName = ref('')
/** 正在换版的那份材料；新登记时为 null */
const replaceTarget = ref<string | null>(null)

const chooseDisabled = computed(() => props.disabled === true || props.busy === true)

const steps = computed(() => [
  { key: 'select', label: '选择文件' },
  { key: 'parse', label: props.registerOnly === true ? '登记文件名' : '上传与解析' },
  { key: 'draft', label: '生成理解草稿' },
])

/** 当前进行到哪一步：done / active / todo */
const stepStates = computed<Array<'done' | 'active' | 'todo'>>(() => {
  const stage = props.stage ?? 'idle'
  const first: 'done' | 'active' = selectedName.value === '' ? 'active' : 'done'

  if (stage === 'uploading') return [first, 'active', 'todo']
  if (stage === 'registered') return ['done', 'done', 'todo']
  if (stage === 'parsed') return ['done', 'done', 'active']
  if (stage === 'understanding') return ['done', 'done', 'active']
  if (stage === 'error') return [first, 'active', 'todo']
  return [first, 'todo', 'todo']
})

/**
 * 把"当前到底发生了什么"用一句中文说清楚。
 * 没有真实动作成功之前，不允许出现"已上传 / 已解析 / 已理解"这类说法。
 */
const stateText = computed(() => {
  const stage = props.stage ?? 'idle'
  if (stage === 'registered') return '当前状态：文件名已登记，正文尚未上传、也还没有解析'
  if (stage === 'uploading') return '当前状态：正在上传并解析正文'
  if (stage === 'parsed') return '当前状态：正文已解析，可以生成理解草稿'
  if (stage === 'understanding') return '当前状态：正在生成理解草稿'
  if (stage === 'error') return '当前状态：上一次没有成功，可以重试'
  return '当前状态：还没有选择文件'
})

function choose(): void {
  if (chooseDisabled.value) return
  localError.value = ''
  input.value?.click()
}

function onSelect(event: Event): void {
  const element = event.target as HTMLInputElement
  const file = element.files?.[0]
  // 允许再次选择同一个文件：先清空 input 的值
  element.value = ''
  if (file === undefined) return

  if (props.disabled === true || props.busy === true) {
    localError.value = '正在处理上一个文件，请等它完成后再选。'
    return
  }

  selectedName.value = file.name

  const type = materialTypeOf(file.name)
  if (type === null) {
    localError.value = MATERIAL_UNSUPPORTED_NOTE
    return
  }
  if (file.size === 0) {
    localError.value = '文件内容为空，请检查后再上传。'
    return
  }
  if (file.size > MATERIAL_MAX_BYTES) {
    localError.value = '文件超过 1 MB 上限，请压缩或拆分后再上传。'
    return
  }

  localError.value = ''
  emit('upload', { file, type, materialId: replaceTarget.value ?? undefined })
  replaceTarget.value = null
}

/**
 * 供父组件调用：为某一份材料选择新文件（重新上传 → 同一个材料 ID，版本 +1）。
 * 组件本身不改变任何业务状态，只负责选文件与本地校验。
 */
function chooseReplace(materialId: string): void {
  if (chooseDisabled.value) return
  replaceTarget.value = materialId
  choose()
}

// 供父组件（工作台）在材料列表里触发「重新上传某一份材料」——
// 入口只有一个，材料 ID 只随事件带出去，组件本身不做业务判断
defineExpose({ chooseReplace })
</script>

<template>
  <div class="mu">
    <div class="mu-row">
      <button class="btn primary mu-choose" type="button" :disabled="chooseDisabled" @click="choose">
        {{ props.busy === true ? '正在处理…' : '选择 MD / TXT 文件' }}
      </button>
      <span v-if="selectedName" class="mu-selected" :title="selectedName">{{ selectedName }}</span>
    </div>

    <input
      ref="input"
      class="mu-input"
      type="file"
      :accept="MATERIAL_ACCEPT"
      :disabled="chooseDisabled"
      style="display: none"
      @change="onSelect"
    />

    <ol class="mu-steps">
      <li v-for="(step, index) in steps" :key="step.key" class="mu-step" :class="`is-${stepStates[index]}`">
        {{ step.label }}
      </li>
    </ol>

    <p class="mu-state">{{ stateText }}</p>
    <p class="mu-hint">
      只支持 MD、TXT 文件（单个文件不超过 1 MB）。选择文件后会先在本机检查类型、大小与空文件。
    </p>
    <p v-if="props.registerOnly && !props.notice" class="mu-note">
      当前先登记文件名：正文不会被读取，解析与理解草稿将在材料接口接入后开放。
    </p>
    <p v-if="props.notice" class="mu-notice">{{ props.notice }}</p>
    <p v-if="localError" class="mu-error" role="alert">{{ localError }}</p>
    <p v-else-if="props.errorText" class="mu-error" role="alert">{{ props.errorText }}</p>

    <button
      v-if="props.errorText"
      class="btn mu-retry"
      type="button"
      :disabled="chooseDisabled"
      @click="emit('retry')"
    >
      重试
    </button>
  </div>
</template>

<style scoped>
.mu-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mu-selected {
  font-size: 11.5px;
  color: #444441;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mu-steps {
  display: flex;
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 10px 0 6px;
}

.mu-step {
  flex: 1;
  font-size: 11px;
  text-align: center;
  padding: 4px 6px;
  border-radius: 8px;
  border: 1px solid #d3d1c7;
  color: #888780;
  background: #f8f7f4;
}

.mu-step.is-active {
  border-color: #b5d4f4;
  color: #0c447c;
  background: #e6f1fb;
}

.mu-step.is-done {
  border-color: #9fe1cb;
  color: #0f6e56;
  background: #e1f5ee;
}

.mu-state {
  margin-top: 8px;
  font-size: 11.5px;
  color: #444441;
  line-height: 1.6;
}

.mu-hint {
  font-size: 11.5px;
  color: #888780;
  line-height: 1.6;
}

.mu-note {
  margin-top: 6px;
  font-size: 11.5px;
  color: #854f0b;
  line-height: 1.6;
}

.mu-notice {
  margin-top: 6px;
  font-size: 11.5px;
  color: #0f6e56;
  line-height: 1.6;
}

.mu-error {
  margin-top: 6px;
  font-size: 11.5px;
  color: #a83232;
  line-height: 1.6;
}

.mu-retry {
  margin-top: 8px;
}

.mu .btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
