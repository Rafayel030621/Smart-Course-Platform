<script setup lang="ts">
import { computed, ref } from 'vue'
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
}>()

const emit = defineEmits<{
  generate: []
  retry: []
  confirm: [payload: { materialId: string; materialVersion: number; itemId: string }]
  edit: [payload: { materialId: string; materialVersion: number; itemId: string; text: string }]
  remove: [payload: { materialId: string; materialVersion: number; itemId: string }]
  undo: [payload: { materialId: string; materialVersion: number; itemId: string }]
  confirmAll: [payload: { materialId: string; materialVersion: number; itemIds: string[] }]
}>()

const editingItemId = ref('')
const editText = ref('')
const editError = ref('')

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

function startEdit(item: DraftItemView): void {
  if (actionsDisabled.value) return
  editError.value = ''
  editingItemId.value = item.itemId
  editText.value = item.text
}

function cancelEdit(): void {
  editingItemId.value = ''
  editText.value = ''
  editError.value = ''
}

function submitEdit(item: DraftItemView): void {
  const draft = props.draft
  if (draft === null) return
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
                    v-if="!stale && item.status !== 'confirmed'"
                    class="btn primary"
                    type="button"
                    :disabled="actionsDisabled"
                    @click="confirmItem(item)"
                  >
                    确认
                  </button>
                  <button
                    v-if="!stale && item.status === 'confirmed'"
                    class="btn"
                    type="button"
                    :disabled="actionsDisabled"
                    @click="undoItem(item)"
                  >
                    撤销确认
                  </button>
                  <button class="btn" type="button" :disabled="actionsDisabled" @click="startEdit(item)">
                    修改
                  </button>
                  <button class="btn" type="button" :disabled="actionsDisabled" @click="removeItem(item)">
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
