<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useWorkbenchStore } from '@/stores/workbench'
import type { ProjectProfile } from '@/types/platform'

/**
 * 项目资料表单
 * ----------------------------------------------------------------------------
 * 契约 13.1 的六个字段，**逐字段结构化保存**，不拼成一段聊天文本。
 *
 * 页面职责只有三件：收集输入、调 `store.updateProjectProfile`、显示结果。
 * 不直接 fetch、不碰 projectRevision、不做任何上限判断以外的业务逻辑
 * （长度与人数上限由 store 按契约 13.1 校验并返回中文 message）。
 *
 * 表单内容与 store 的同步规则：
 *   - 切项目、或 `projectRevision` 变化（别处改了资料、刷新恢复）时，
 *     一律**以 store 为准**重建草稿，避免页面缓存把新状态盖回去。
 */

const store = useWorkbenchStore()

/** 六个字段的本地草稿；`memberNames` 在输入框里是逗号分隔的一行文本 */
const draft = reactive({
  goal: '',
  expectedOutcome: '',
  memberText: '',
  researchPeriod: '',
  scope: '',
  outOfScope: '',
})

const saving = ref(false)
const savedHint = ref('')
const errorHint = ref('')
/**
 * 上一次「自己保存成功」时的项目版本。
 * 保存会让 `projectRevision` +1，watcher 随即重同步表单；如果不记下来，
 * 刚写好的「已保存」提示会被自己的 watcher 立刻清掉。
 */
const savedRevision = ref<number | null>(null)

function textOf(value: string | null | undefined): string {
  return value ?? ''
}

/** 用 store 中的资料重建草稿；空值一律显示成空串 */
function syncFromStore(): void {
  const info = store.basicInfo
  draft.goal = textOf(info?.goal)
  draft.expectedOutcome = textOf(info?.expectedOutcome)
  draft.memberText = (info?.memberNames ?? []).join('、')
  draft.researchPeriod = textOf(info?.researchPeriod)
  draft.scope = textOf(info?.scope)
  draft.outOfScope = textOf(info?.outOfScope)
}

/**
 * 切项目、资料版本变化、刷新恢复都以 store 为准重建草稿
 * ——这样别处改了资料，页面不会拿旧缓存盖回去。
 *
 * 提示文案的处理：只有「版本不是刚刚自己保存出来的那个」才清空，
 * 否则刚保存完的成功提示会立刻被自己清掉。
 */
watch(
  () => [store.current?.projectId, store.current?.projectRevision] as const,
  ([, revision]) => {
    syncFromStore()
    errorHint.value = ''
    if (revision !== savedRevision.value) savedHint.value = ''
  },
  { immediate: true },
)

function parseMembers(text: string): string[] {
  return text
    .split(/[、,，;；\s]+/)
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/** 已经有内容的字段个数：用于「已填写 N 项」与空状态判断 */
const filledCount = computed(() => {
  const info = store.basicInfo
  if (info === null) return 0
  const values: Array<string | null> = [
    info.goal,
    info.expectedOutcome,
    info.researchPeriod,
    info.scope,
    info.outOfScope,
  ]
  const filledText = values.filter((value) => typeof value === 'string' && value.trim() !== '').length
  return info.memberNames.length > 0 ? filledText + 1 : filledText
})

const hasAnyContent = computed(() => filledCount.value > 0)

/** 表单是否与 store 一致：全部为空说明这次保存清空了所有内容 */
async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  savedHint.value = ''
  errorHint.value = ''

  try {
    // 空字符串交给 store 归一为 null（契约 13.1 约定 1）；这里只负责把
    // 「成员姓名」这一行拆成数组
    const result = store.updateProjectProfile({
      goal: draft.goal,
      expectedOutcome: draft.expectedOutcome,
      memberNames: parseMembers(draft.memberText),
      researchPeriod: draft.researchPeriod,
      scope: draft.scope,
      outOfScope: draft.outOfScope,
    })

    if (!result.ok) {
      errorHint.value = result.message
      return
    }

    savedRevision.value = store.current?.projectRevision ?? null
    savedHint.value = hasAnyContent.value
      ? `项目资料已保存（已填写 ${filledCount.value} 项）`
      : '项目资料已保存（当前为空）'
  } finally {
    saving.value = false
  }
}

/** 供外部（例如切换项目后）强制以 store 重建 */
function resetFromStore(): void {
  syncFromStore()
  savedRevision.value = null
  savedHint.value = ''
  errorHint.value = ''
}

defineExpose({ resetFromStore })

/** 只用于展示：当前进请求的形态（页面不显示字段名，只用来判断「是否已进建议」） */
const inRequest = computed<ProjectProfile | null>(() => store.projectProfile)
</script>

<template>
  <form class="profile-form" @submit.prevent="save">
    <label for="profile-goal">项目目标 <small>（一句话说明要解决什么）</small></label>
    <textarea
      id="profile-goal"
      v-model="draft.goal"
      maxlength="300"
      placeholder="例如：识别西北太平洋的海洋锋面并评估其对渔场的影响"
    ></textarea>

    <label for="profile-outcome">预期产出 <small>（交付物，能验收的那种）</small></label>
    <textarea
      id="profile-outcome"
      v-model="draft.expectedOutcome"
      maxlength="300"
      placeholder="例如：一页方法对比表 + 可交互原型 + 4 页论文初稿"
    ></textarea>

    <label for="profile-members">成员姓名 <small>（用顿号或逗号分隔）</small></label>
    <input id="profile-members" v-model="draft.memberText" placeholder="张三、李四、王五" />

    <label for="profile-period">研究周期</label>
    <input id="profile-period" v-model="draft.researchPeriod" maxlength="100" placeholder="例如：2026 年 9 月至 12 月" />

    <label for="profile-scope">项目范围 <small>（已确定要覆盖的部分）</small></label>
    <textarea
      id="profile-scope"
      v-model="draft.scope"
      maxlength="300"
      placeholder="例如：仅西北太平洋，时间范围 2015-2024"
    ></textarea>

    <label for="profile-out">暂不处理 <small>（先划清边界，避免越做越散）</small></label>
    <textarea
      id="profile-out"
      v-model="draft.outOfScope"
      maxlength="300"
      placeholder="例如：全球海域、生物化学耦合过程"
    ></textarea>

    <div class="form-actions">
      <button class="submit" type="submit" :disabled="saving">
        {{ saving ? '保存中…' : '保存项目资料' }}
      </button>
      <p v-if="savedHint" class="hint ok">{{ savedHint }}</p>
      <p v-else-if="errorHint" class="hint error">{{ errorHint }}</p>
      <p v-else-if="hasAnyContent" class="hint">
        已填写 {{ filledCount }} 项。这些内容会在获取建议时一起交给 AI，不会拼成聊天文本。
      </p>
      <p v-else class="hint">
        还没有填写。补上项目目标与预期产出后，AI 的建议会更贴合你的课题。
      </p>
      <p v-if="inRequest === null && hasAnyContent" class="hint error">
        资料还没有进入请求，请先保存。
      </p>
    </div>
  </form>
</template>

<style scoped>
.profile-form label {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  margin: 12px 0 5px;
  color: #444441;
}

.profile-form label:first-child {
  margin-top: 0;
}

.profile-form label small {
  font-weight: 400;
  color: #888780;
}

.profile-form textarea,
.profile-form input {
  width: 100%;
  border: 1px solid #d3d1c7;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12.5px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}

.profile-form textarea {
  resize: vertical;
  min-height: 48px;
}

.profile-form textarea:focus,
.profile-form input:focus {
  border-color: #378ADD;
}

.form-actions {
  margin-top: 14px;
}

.profile-form button.submit {
  width: 100%;
  padding: 9px;
  background: #1D9E75;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 13.5px;
  font-weight: 600;
}

.profile-form button.submit:disabled {
  cursor: wait;
  opacity: 0.65;
}

.hint {
  font-size: 11.5px;
  line-height: 1.6;
  color: #5f5e5a;
  margin-top: 8px;
}

.hint.ok {
  color: #0F6E56;
  background: #E1F5EE;
  border: 1px solid #9FE1CB;
  border-radius: 8px;
  padding: 7px 10px;
}

.hint.error {
  color: #854F0B;
}
</style>
