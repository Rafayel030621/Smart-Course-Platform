<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  DRAFT_BLOCK_ORDER,
  DRAFT_BLOCK_TITLES,
  DRAFT_SOURCE_TEXT,
  blockItemsOf,
  draftItemCount,
  type DraftItemStatus,
  type DraftItemView,
  type DraftSource,
  type UnderstandingDraftView,
} from './materialTypes'

/**
 * 材料理解草稿卡片（契约 14.3，雍-3 / 雍-4）
 * ----------------------------------------------------------------------------
 * 纯展示 + intent 组件：草稿内容、条目状态、版本都由父组件（store 投影）传入。
 *
 * 四条界面规则：
 *   1. AI 生成的内容默认待确认；修改后是"已修改 · 待确认"，**编辑不等于确认**；
 *   2. 所有操作都按材料 ID + 材料版本 + 条目 ID 发出，不依赖数组下标；
 *   3. 整份确认只提交当前仍然存在的条目（已删除的不会被"恢复"）；
 *   4. 材料版本与当前版本不一致时，旧确认状态一律按"待确认"显示，并禁止确认操作。
 */

const props = defineProps<{
  draft: UnderstandingDraftView | null
  /** 草稿来源：模型 / 服务端规则兜底 / 本地规则 */
  source?: DraftSource | null
  /** fallback 时的中文说明（空草稿 + 说明，不制造候选） */
  notice?: string | null
  loading?: boolean
  errorText?: string | null
  /** 整份确认进行中 */
  confirming?: boolean
  /** 项目里是否有材料（决定空状态文案） */
  hasMaterial?: boolean
  /** 是否允许发起"生成 / 重新生成"（数据层就绪后由页面打开） */
  canGenerate?: boolean
  /** 当前材料版本；与草稿版本不同表示草稿来自旧版本 */
  currentMaterialVersion?: number | null
  emptyHint?: string | null
  disabled?: boolean
  /**
   * 父级替这条材料的**同一版本**保留的未提交编辑（切换材料返回时恢复）。
   * 只有 `itemId` 仍存在、且该条目的原文与缓存时**逐字一致**才恢复——
   * 条目被删除、被重新生成替换、或材料换了版本，旧文字都不能挂到新内容上。
   */
  pendingEdit?: { itemId: string; text: string; original: string } | null
}>()

const emit = defineEmits<{
  generate: []
  retry: []
  confirm: [payload: { materialId: string; materialVersion: number; itemId: string }]
  edit: [payload: { materialId: string; materialVersion: number; itemId: string; text: string }]
  remove: [payload: { materialId: string; materialVersion: number; itemId: string }]
  undo: [payload: { materialId: string; materialVersion: number; itemId: string }]
  confirmAll: [payload: { materialId: string; materialVersion: number; itemIds: string[] }]
  /**
   * 草稿身份变化（切换材料或换版）时放弃的未提交编辑。
   * 父级收到后负责保留这段文字，不能静默丢掉用户已经打好的内容。
   */
  editAbort: [
    payload: {
      materialId: string
      materialVersion: number
      itemId: string
      text: string
      /** 开始编辑时该条目的原文：父级用它判断这条有没有被替换过 */
      original: string
    },
  ]
}>()

const editingItemId = ref('')
const editText = ref('')
const editError = ref('')
/** 开始编辑时条目的原文；用于判断条目是否已被替换（不能把旧文字挂到新内容上） */
const editOriginal = ref('')
/** 正在进行编辑的材料身份（材料 ID + 版本）：材料一换，这次编辑作废 */
const editMaterialKey = ref('')

function materialKeyOf(draft: UnderstandingDraftView | null): string {
  return draft === null ? '' : `${draft.materialId}#${draft.materialVersion}`
}

const total = computed(() => draftItemCount(props.draft))

const blocks = computed(() =>
  DRAFT_BLOCK_ORDER.map((key) => ({
    key,
    title: DRAFT_BLOCK_TITLES[key],
    items: props.draft === null ? [] : blockItemsOf(props.draft, key),
  })),
)

const stale = computed(() => {
  const draft = props.draft
  const current = props.currentMaterialVersion
  if (draft === null) return false
  if (current === null || current === undefined) return false
  return current !== draft.materialVersion
})

const confirmedCount = computed(() =>
  blocks.value.reduce(
    (sum, block) => sum + block.items.filter((item) => item.status === 'confirmed').length,
    0,
  ),
)

const allConfirmed = computed(() => total.value > 0 && confirmedCount.value === total.value)

const actionsDisabled = computed(() => props.disabled === true || props.loading === true)

/** 单条操作（确认 / 撤销确认 / 修改 / 删除）：禁用、加载中或草稿过期时全部禁用 */
const itemActionsDisabled = computed(() => actionsDisabled.value || stale.value)

const canConfirmAll = computed(
  () =>
    total.value > 0 &&
    !allConfirmed.value &&
    props.confirming !== true &&
    !actionsDisabled.value &&
    !stale.value,
)

const footerHint = computed(() => {
  if (stale.value) return '材料已更新，请重新生成后再确认'
  if (total.value === 0) return '没有可确认的内容'
  if (allConfirmed.value) return '全部条目已确认'
  return `已确认 ${confirmedCount.value} / 共 ${total.value} 条`
})

function statusTextOf(item: DraftItemView): string {
  if (stale.value) return '待确认'
  if (item.status === 'confirmed') return '已确认'
  if (item.status === 'modified') return '已修改 · 待确认'
  return '待确认'
}

function statusClassOf(item: DraftItemView): string {
  const status: DraftItemStatus = stale.value ? 'pending' : item.status
  return `is-${status}`
}

function sourceTextOf(item: DraftItemView): string {
  return item.sources
    .map(
      (source) =>
        `${source.materialName}（版本 ${source.materialVersion}）第 ${source.startLine}–${source.endLine} 行`,
    )
    .join('；')
}

// 材料 ID 或材料版本变化（切换材料、材料更新）：这次编辑不能静默丢掉——
// 先把未提交的文字交给父级保留，再看父级是否要求恢复一条编辑。
watch(
  () => materialKeyOf(props.draft),
  () => {
    abortEdit()
    restorePendingEdit()
  },
)

/** 未提交的编辑：把文字、条目原文与它原本属于哪份材料一起交给父级（没有输入就不打扰） */
function abortEdit(): void {
  const text = editText.value
  if (editingItemId.value === '' || text.trim() === '') return
  const [materialId, versionText] = editMaterialKey.value.split('#')
  if (materialId === undefined || materialId === '') return
  emit('editAbort', {
    materialId,
    materialVersion: Number(versionText ?? ''),
    itemId: editingItemId.value,
    text,
    original: editOriginal.value,
  })
}

/**
 * 恢复父级替这条材料保留的未提交编辑。
 *
 * 三项都要对上才恢复：条目还在、条目原文与缓存时一致、缓存文字非空；
 * 否则一定退出编辑态（既不能把旧文字挂到新内容上，也不能让编辑框串到另一份材料上）。
 */
function restorePendingEdit(): void {
  const pending = props.pendingEdit
  const draft = props.draft

  const currentItem =
    pending === null || pending === undefined
      ? undefined
      : blocks.value.flatMap((block) => block.items).find((item) => item.itemId === pending.itemId)

  const restorable =
    pending !== null &&
    pending !== undefined &&
    draft !== null &&
    pending.text.trim() !== '' &&
    currentItem !== undefined &&
    currentItem.text === pending.original

  if (!restorable || draft === null || pending === null || pending === undefined) {
    cancelEdit()
    return
  }

  editingItemId.value = pending.itemId
  editText.value = pending.text
  editOriginal.value = currentItem.text
  editMaterialKey.value = materialKeyOf(draft)
  editError.value = ''
}

function startEdit(item: DraftItemView): void {
  const draft = props.draft
  if (draft === null || itemActionsDisabled.value) return
  editError.value = ''
  editingItemId.value = item.itemId
  editText.value = item.text
  editOriginal.value = item.text
  editMaterialKey.value = materialKeyOf(draft)
}

function cancelEdit(): void {
  editingItemId.value = ''
  editText.value = ''
  editOriginal.value = ''
  editMaterialKey.value = ''
  editError.value = ''
}

function submitEdit(item: DraftItemView): void {
  const draft = props.draft
  if (draft === null) return
  // 禁用 / 加载中 / 草稿过期：不提交
  if (itemActionsDisabled.value) return
  // 编辑会话已经结束，或者编辑的不是当前草稿：不提交
  if (editingItemId.value !== item.itemId) return
  if (editMaterialKey.value !== materialKeyOf(draft)) {
    cancelEdit()
    return
  }

  const text = editText.value.trim()
  if (text === '') {
    editError.value = '内容不能为空，请写一句可核对的话。'
    return
  }
  if (text === item.text) {
    cancelEdit()
    return
  }

  emit('edit', {
    materialId: draft.materialId,
    materialVersion: draft.materialVersion,
    itemId: item.itemId,
    text,
  })
  cancelEdit()
}

function confirmItem(item: DraftItemView): void {
  const draft = props.draft
  if (draft === null || actionsDisabled.value || stale.value) return
  emit('confirm', {
    materialId: draft.materialId,
    materialVersion: draft.materialVersion,
    itemId: item.itemId,
  })
}

function undoItem(item: DraftItemView): void {
  const draft = props.draft
  if (draft === null || actionsDisabled.value || stale.value) return
  emit('undo', { materialId: draft.materialId, materialVersion: draft.materialVersion, itemId: item.itemId })
}

function removeItem(item: DraftItemView): void {
  const draft = props.draft
  if (draft === null || actionsDisabled.value) return
  if (editingItemId.value === item.itemId) cancelEdit()
  emit('remove', {
    materialId: draft.materialId,
    materialVersion: draft.materialVersion,
    itemId: item.itemId,
  })
}

function confirmAll(): void {
  const draft = props.draft
  if (draft === null || !canConfirmAll.value) return
  // 只提交当前仍然存在的条目：已删除的条目不会因为"整份确认"被恢复
  const itemIds = blocks.value.flatMap((block) => block.items.map((item) => item.itemId))
  emit('confirmAll', {
    materialId: draft.materialId,
    materialVersion: draft.materialVersion,
    itemIds,
  })
}
</script>

<template>
  <div class="dc">
    <p v-if="props.loading" class="dc-loading" role="status">正在生成理解草稿…</p>

    <p v-if="props.errorText" class="dc-error" role="alert">{{ props.errorText }}</p>

    <p v-if="props.notice" class="dc-notice">{{ props.notice }}</p>

    <p v-if="stale" class="dc-stale" role="alert">
      材料已更新（当前版本
      {{ props.currentMaterialVersion }}），下面内容来自旧版本，确认状态已失效，请重新生成后再确认。
    </p>

    <template v-if="props.draft !== null">
      <div class="dc-meta">
        材料：<b>{{ props.draft.materialName }}</b
        >（版本 {{ props.draft.materialVersion }}）
        <span v-if="props.source" class="tag dc-source">{{ DRAFT_SOURCE_TEXT[props.source] }}</span>
      </div>

      <div v-if="total === 0" class="empty dc-empty">这次没有生成任何候选内容，可以稍后重试。</div>

      <template v-else>
        <div v-for="block in blocks" :key="block.key" class="dc-block">
          <div class="dc-block-h">
            {{ block.title }}<span class="dc-count">{{ block.items.length }}</span>
          </div>
          <div v-if="block.items.length === 0" class="dc-block-empty">这一块没有候选内容</div>

          <template v-else>
            <div v-for="item in block.items" :key="item.itemId" class="dc-item" :class="statusClassOf(item)">
              <template v-if="editingItemId === item.itemId">
                <textarea v-model="editText" class="dc-edit" rows="2" maxlength="300"></textarea>
                <p v-if="editError" class="dc-error" role="alert">{{ editError }}</p>
                <div class="dc-actions">
                  <button class="btn primary" type="button" @click="submitEdit(item)">保存修改</button>
                  <button class="btn" type="button" @click="cancelEdit()">取消</button>
                </div>
                <p class="dc-edit-hint">保存后仍是待确认，需要再点一次「确认」。</p>
              </template>

              <template v-else>
                <p class="dc-text">{{ item.text }}</p>
                <p v-if="item.sources.length > 0" class="dc-from">来源：{{ sourceTextOf(item) }}</p>
                <p v-else class="dc-from">这条内容没有标注来源</p>

                <div class="dc-actions">
                  <span class="dc-status">{{ statusTextOf(item) }}</span>
                  <button
                    v-if="item.status !== 'confirmed'"
                    class="btn primary"
                    type="button"
                    :disabled="itemActionsDisabled"
                    @click="confirmItem(item)"
                  >
                    确认
                  </button>
                  <button
                    v-if="item.status === 'confirmed'"
                    class="btn"
                    type="button"
                    :disabled="itemActionsDisabled"
                    @click="undoItem(item)"
                  >
                    撤销确认
                  </button>
                  <button class="btn" type="button" :disabled="itemActionsDisabled" @click="startEdit(item)">
                    修改
                  </button>
                  <button class="btn" type="button" :disabled="itemActionsDisabled" @click="removeItem(item)">
                    删除
                  </button>
                </div>
              </template>
            </div>
          </template>
        </div>
      </template>

      <div class="dc-foot">
        <button class="btn primary" type="button" :disabled="!canConfirmAll" @click="confirmAll">
          {{ props.confirming === true ? '确认中…' : '整份确认' }}
        </button>
        <span class="dc-foot-hint">{{ footerHint }}</span>
        <button
          v-if="props.canGenerate"
          class="btn"
          type="button"
          :disabled="actionsDisabled"
          @click="emit('generate')"
        >
          重新生成
        </button>
      </div>
    </template>

    <template v-else>
      <div class="empty dc-empty">
        <p v-if="props.hasMaterial">材料已登记，但还没有理解草稿。</p>
        <p v-else>还没有材料。先在「项目资料」里上传 MD 或 TXT 文件。</p>
        <p v-if="props.emptyHint" class="dc-hint">{{ props.emptyHint }}</p>
      </div>

      <div class="dc-foot">
        <button
          v-if="props.canGenerate"
          class="btn primary"
          type="button"
          :disabled="actionsDisabled"
          @click="emit('generate')"
        >
          生成理解草稿
        </button>
        <span class="dc-foot-hint">草稿里的每条内容都需要你确认后才会作为项目依据。</span>
      </div>
    </template>

    <button
      v-if="props.errorText"
      class="btn dc-retry"
      type="button"
      :disabled="actionsDisabled"
      @click="emit('retry')"
    >
      重试
    </button>
  </div>
</template>

<style scoped>
.dc-loading {
  font-size: 12px;
  color: #0c447c;
  line-height: 1.6;
}

.dc-error {
  margin-top: 6px;
  font-size: 11.5px;
  color: #a83232;
  line-height: 1.6;
}

.dc-notice {
  margin-top: 6px;
  font-size: 11.5px;
  color: #854f0b;
  line-height: 1.6;
}

.dc-stale {
  margin-top: 6px;
  font-size: 11.5px;
  color: #a83232;
  line-height: 1.6;
}

.dc-meta {
  font-size: 11.5px;
  color: #444441;
  margin-bottom: 8px;
}

.dc-source {
  margin-left: 6px;
  background: #eeedfe;
  color: #3c3489;
  border: 1px solid #cecbf6;
}

.dc-empty {
  padding: 6px 0 8px;
}

.dc-hint {
  margin-top: 4px;
  font-size: 11.5px;
  color: #888780;
}

.dc-block {
  border-top: 1px dashed #e3e2dd;
  padding-top: 8px;
  margin-top: 8px;
}

.dc-block-h {
  font-size: 12px;
  font-weight: 600;
  color: #534ab7;
  margin-bottom: 6px;
}

.dc-count {
  margin-left: 6px;
  font-weight: 400;
  color: #888780;
}

.dc-block-empty {
  font-size: 11.5px;
  color: #888780;
}

.dc-item {
  border: 1px solid #e3e2dd;
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 6px;
  background: #fff;
}

.dc-item.is-confirmed {
  border-color: #9fe1cb;
  background: #f4fbf8;
}

.dc-item.is-modified {
  border-color: #fac775;
  background: #fdf7ee;
}

.dc-text {
  font-size: 12.5px;
  color: #2f2f2c;
  line-height: 1.6;
}

.dc-from {
  margin-top: 4px;
  font-size: 11px;
  color: #888780;
  line-height: 1.6;
}

.dc-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.dc-status {
  font-size: 11px;
  color: #888780;
  margin-right: 2px;
}

.dc-item.is-confirmed .dc-status {
  color: #0f6e56;
}

.dc-item.is-modified .dc-status {
  color: #854f0b;
}

.dc-edit {
  width: 100%;
  border: 1px solid #d3d1c7;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12.5px;
  font-family: inherit;
  box-sizing: border-box;
}

.dc-edit-hint {
  margin-top: 6px;
  font-size: 11px;
  color: #888780;
}

.dc-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.dc-foot-hint {
  font-size: 11.5px;
  color: #888780;
}

.dc-retry {
  margin-top: 8px;
}

.dc .btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
