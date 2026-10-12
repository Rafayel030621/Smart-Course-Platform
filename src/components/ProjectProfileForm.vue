<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PROFILE_LIMITS, emptyProfileValue, type ProfileFormValue } from './materialTypes'

/**
 * 项目基本信息表单（契约 13.1，雍-1）
 * ----------------------------------------------------------------------------
 * 纯表单组件：只维护"正在编辑的这份草稿"，保存成功与否由父组件通过 props 告知。
 *
 * 三条界面规则：
 *   1. 只有真实保存成功（父组件传入 savedAt）才显示"已保存"；
 *   2. 保存失败保留输入：组件不重置内容，失败原因由 saveError 传入；
 *   3. projectKey 变化（切换项目）时重置为该项目的数据，不把上一个项目的内容带过来。
 */

const props = defineProps<{
  /** 已保存的项目基本信息；null 表示尚未填写或数据层未接入 */
  profile: ProfileFormValue | null
  saving?: boolean
  /** 已转成中文的失败原因 */
  saveError?: string | null
  /** 最近一次真实保存成功的时间文本；由父组件在 action 成功后写入 */
  savedAt?: string | null
  disabled?: boolean
  /** 禁用的原因（中文），例如数据层尚未接入 */
  disabledNote?: string | null
  /** 当前项目标识：变化时重置表单 */
  projectKey?: string
}>()

const emit = defineEmits<{ save: [value: ProfileFormValue] }>()

const draft = ref<ProfileFormValue>(emptyProfileValue())
const dirty = ref(false)

function fromProfile(profile: ProfileFormValue | null): ProfileFormValue {
  if (profile === null) return emptyProfileValue()
  return {
    goal: profile.goal,
    expectedOutcome: profile.expectedOutcome,
    memberNames: profile.memberNames.length > 0 ? [...profile.memberNames] : [''],
    researchPeriod: profile.researchPeriod,
    scope: profile.scope,
    outOfScope: profile.outOfScope,
  }
}

/** 切换项目时重置；初始化时也走一次，保证表单与项目一致 */
watch(
  () => props.projectKey,
  () => {
    draft.value = fromProfile(props.profile)
    dirty.value = false
  },
  { immediate: true },
)

/** 真实保存成功后清掉"未保存"标记（内容以用户刚提交的为准，不覆盖输入） */
watch(
  () => props.savedAt,
  (value) => {
    if (value !== null && value !== undefined && value !== '') dirty.value = false
  },
)

function markDirty(): void {
  dirty.value = true
}

function updateMember(index: number, event: Event): void {
  const input = event.target as HTMLInputElement
  draft.value.memberNames[index] = input.value
  markDirty()
}

function addMember(): void {
  if (props.disabled || draft.value.memberNames.length >= PROFILE_LIMITS.members) return
  draft.value.memberNames.push('')
  markDirty()
}

function removeMember(index: number): void {
  if (props.disabled) return
  draft.value.memberNames.splice(index, 1)
  if (draft.value.memberNames.length === 0) draft.value.memberNames.push('')
  markDirty()
}

const memberNames = computed(() =>
  draft.value.memberNames.map((name) => name.trim()).filter((name) => name !== ''),
)

const canSave = computed(() => !props.disabled && !props.saving && dirty.value)

const statusText = computed(() => {
  if (props.saving) return '正在保存…'
  if (props.saveError !== null && props.saveError !== undefined && props.saveError !== '') {
    return '没有保存成功，请修改后重试'
  }
  if (dirty.value) return '有未保存的修改'
  if (props.savedAt !== null && props.savedAt !== undefined && props.savedAt !== '') {
    return `已保存 · ${props.savedAt}`
  }
  return '还没有填写'
})

const showSaved = computed(
  () =>
    !dirty.value &&
    props.saving !== true &&
    props.savedAt !== null &&
    props.savedAt !== undefined &&
    props.savedAt !== '',
)

function save(): void {
  if (!canSave.value) return
  emit('save', {
    goal: draft.value.goal.trim(),
    expectedOutcome: draft.value.expectedOutcome.trim(),
    memberNames: memberNames.value.slice(0, PROFILE_LIMITS.members),
    researchPeriod: draft.value.researchPeriod.trim(),
    scope: draft.value.scope.trim(),
    outOfScope: draft.value.outOfScope.trim(),
  })
}
</script>

<template>
  <div class="pf">
    <div class="pf-grid">
      <label class="pf-field pf-wide">
        <span class="pf-label">项目目标</span>
        <textarea
          v-model="draft.goal"
          class="pf-input"
          rows="2"
          :maxlength="PROFILE_LIMITS.text"
          :disabled="props.disabled"
          placeholder="一句话说明这个项目要解决什么问题"
          @input="markDirty"
        ></textarea>
      </label>

      <label class="pf-field pf-wide">
        <span class="pf-label">预期产出</span>
        <textarea
          v-model="draft.expectedOutcome"
          class="pf-input"
          rows="2"
          :maxlength="PROFILE_LIMITS.text"
          :disabled="props.disabled"
          placeholder="例如：可交互原型 + 一页结论"
          @input="markDirty"
        ></textarea>
      </label>

      <div class="pf-field pf-wide">
        <span class="pf-label">项目成员姓名</span>
        <div v-for="(name, index) in draft.memberNames" :key="index" class="pf-member">
          <input
            class="pf-input"
            :value="name"
            :maxlength="PROFILE_LIMITS.memberName"
            :disabled="props.disabled"
            :placeholder="`成员 ${index + 1}`"
            @input="updateMember(index, $event)"
          />
          <button
            class="btn pf-mini"
            type="button"
            :disabled="props.disabled || draft.memberNames.length <= 1"
            @click="removeMember(index)"
          >
            移除
          </button>
        </div>
        <button
          class="btn pf-mini"
          type="button"
          :disabled="props.disabled || draft.memberNames.length >= PROFILE_LIMITS.members"
          @click="addMember"
        >
          ＋ 添加成员（最多 {{ PROFILE_LIMITS.members }} 人）
        </button>
      </div>

      <label class="pf-field">
        <span class="pf-label">研究周期</span>
        <input
          v-model="draft.researchPeriod"
          class="pf-input"
          :maxlength="PROFILE_LIMITS.researchPeriod"
          :disabled="props.disabled"
          placeholder="例如：第 3 周至第 14 周"
          @input="markDirty"
        />
      </label>

      <label class="pf-field">
        <span class="pf-label">项目范围</span>
        <input
          v-model="draft.scope"
          class="pf-input"
          :maxlength="PROFILE_LIMITS.text"
          :disabled="props.disabled"
          placeholder="先做什么、覆盖哪里"
          @input="markDirty"
        />
      </label>

      <label class="pf-field pf-wide">
        <span class="pf-label">暂不处理的内容</span>
        <textarea
          v-model="draft.outOfScope"
          class="pf-input"
          rows="2"
          :maxlength="PROFILE_LIMITS.text"
          :disabled="props.disabled"
          placeholder="例如：不做移动端，不覆盖全球海域"
          @input="markDirty"
        ></textarea>
      </label>
    </div>

    <div class="pf-foot">
      <button class="btn primary" type="button" :disabled="!canSave" @click="save">
        {{ props.saving ? '保存中…' : '保存基本信息' }}
      </button>
      <span class="pf-status" :class="{ 'is-saved': showSaved }">{{ statusText }}</span>
    </div>

    <p v-if="props.disabledNote" class="pf-note">{{ props.disabledNote }}</p>
    <p v-if="props.saveError" class="pf-error" role="alert">{{ props.saveError }}</p>
  </div>
</template>

<style scoped>
.pf-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 10px;
}

.pf-wide {
  grid-column: 1 / -1;
}

.pf-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pf-label {
  font-size: 11.5px;
  color: #5f5e5a;
}

.pf-input {
  width: 100%;
  border: 1px solid #d3d1c7;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12.5px;
  font-family: inherit;
  color: #2f2f2c;
  background: #fff;
  box-sizing: border-box;
}

.pf-input:disabled {
  background: #f8f7f4;
  color: #888780;
}

.pf-member {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}

.pf-mini {
  font-size: 11.5px;
  padding: 4px 8px;
  white-space: nowrap;
}

.pf-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.pf-status {
  font-size: 11.5px;
  color: #888780;
}

.pf-status.is-saved {
  color: #0f6e56;
}

.pf-note {
  margin-top: 8px;
  font-size: 11.5px;
  color: #854f0b;
  line-height: 1.6;
}

.pf-error {
  margin-top: 8px;
  font-size: 11.5px;
  color: #a83232;
  line-height: 1.6;
}

.pf .btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 1100px) {
  .pf-grid {
    grid-template-columns: 1fr;
  }
}
</style>
