<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkbenchStore } from '@/stores/workbench'
import type { MaterialSourceRef, UnderstandingBlock, UnderstandingBlockKind } from '@/types/platform'

/**
 * 材料理解草稿（契约 14.3）
 * ----------------------------------------------------------------------------
 * 服务端 `draft` 有五块，这里按块渲染，每条候选显示**自然中文文本 + 材料名 + 起止行号**。
 *
 * 状态口径（契约 14.3 / 17.2）：
 *   - `pending`   待确认 —— 模型刚生成，页面**不能**当成项目事实；
 *   - `modified`  已修改 —— 学生改过，但**还没再次确认**，同样不是项目事实；
 *   - `confirmed` 已确认 —— 只有这一种才会进入建议与聊天请求。
 *
 * 因此「修改」不等于「确认」：改完必须再点一次「确认这条」，否则它不会进请求。
 *
 * 页面只调 store 的四个 action，并且一律用**本地稳定 blockId**（`block.id`），
 * 不用服务端的 itemId、不用片段 ID、不用数组下标。
 */

const store = useWorkbenchStore()

/** 五块的展示顺序与标题（顺序固定，避免每次渲染顺序漂移） */
const BLOCKS: Array<{ kind: UnderstandingBlockKind; title: string; hint: string }> = [
  { kind: 'goalCandidates', title: '项目目标候选', hint: '这份材料里看起来像「要解决什么问题」的内容' },
  { kind: 'outcomeCandidates', title: '预期产出候选', hint: '看起来像「要交出什么」的内容' },
  { kind: 'dataNotes', title: '数据字段与规模', hint: '涉及的数据字段、时间范围与量级' },
  { kind: 'methodNotes', title: '方法与约束', hint: '提到的方法、工具与限制条件' },
  { kind: 'openQuestions', title: '待确认问题', hint: '材料里没写清、需要你去补齐的地方' },
]

const editingId = ref<string | null>(null)
const editingText = ref('')
const busyId = ref<string | null>(null)
const actionHint = ref('')

const allBlocks = computed<UnderstandingBlock[]>(() => [
  ...store.pendingUnderstandingBlocks,
  ...store.modifiedUnderstandingBlocks,
  ...store.confirmedUnderstandingBlocks,
])

/** 按材料分组：整份确认是按材料做的，分组后按钮位置才明确 */
const groups = computed(() => {
  const byMaterial = new Map<string, { materialId: string; materialName: string; blocks: UnderstandingBlock[] }>()
  for (const block of allBlocks.value) {
    const key = `${block.materialId}@${block.materialVersion}`
    const material = store.materials.find((item) => item.materialId === block.materialId)
    const existing = byMaterial.get(key)
    if (existing !== undefined) {
      existing.blocks.push(block)
      continue
    }
    byMaterial.set(key, {
      materialId: block.materialId,
      materialName: material?.name ?? block.sources[0]?.materialName ?? '这份材料',
      blocks: [block],
    })
  }

  return [...byMaterial.values()].map((group) => ({
    ...group,
    unconfirmedCount: group.blocks.filter((block) => block.status !== 'confirmed').length,
    sections: BLOCKS.map((section) => ({
      ...section,
      items: group.blocks.filter((block) => block.kind === section.kind),
    })).filter((section) => section.items.length > 0),
  }))
})

const hasAnyBlock = computed(() => allBlocks.value.length > 0)

const STATUS_TEXT: Record<UnderstandingBlock['status'], string> = {
  pending: '待确认',
  modified: '已修改 · 待再次确认',
  confirmed: '已确认',
}

/**
 * 来源的可读文本：`材料名 · 第 12–40 行`。
 * 只显示材料名与行号——`materialId` / `segmentId` / `itemId` 都是内部字段，不上页面。
 */
function sourceText(source: MaterialSourceRef): string {
  const lines =
    source.startLine === source.endLine
      ? `第 ${source.startLine} 行`
      : `第 ${source.startLine}–${source.endLine} 行`
  return `${source.materialName} · ${lines}`
}

function startEdit(block: UnderstandingBlock): void {
  editingId.value = block.id
  editingText.value = block.content
  actionHint.value = ''
}

function cancelEdit(): void {
  editingId.value = null
  editingText.value = ''
}

function confirmBlock(block: UnderstandingBlock): void {
  busyId.value = block.id
  try {
    const result = store.confirmUnderstandingBlock({ blockId: block.id })
    actionHint.value = result.ok
      ? '已确认这条理解，后续建议会参考它'
      : result.message
  } finally {
    busyId.value = null
  }
}

function saveEdit(block: UnderstandingBlock): void {
  const text = editingText.value.trim()
  if (text === '') {
    actionHint.value = '内容不能为空'
    return
  }

  busyId.value = block.id
  try {
    const result = store.modifyUnderstandingBlock({ blockId: block.id, content: text })
    if (!result.ok) {
      actionHint.value = result.message
      return
    }
    // 修改后是「已修改」，必须再明确确认一次才会进请求
    actionHint.value = '已保存修改。这条还需要再点一次「确认这条」才会用于建议。'
    cancelEdit()
  } finally {
    busyId.value = null
  }
}

function deleteBlock(block: UnderstandingBlock): void {
  busyId.value = block.id
  try {
    const result = store.deleteUnderstandingBlock({ blockId: block.id })
    actionHint.value = result.ok ? '已删除这条理解' : result.message
    if (result.ok && editingId.value === block.id) cancelEdit()
  } finally {
    busyId.value = null
  }
}

function confirmGroup(materialId: string): void {
  busyId.value = materialId
  try {
    const result = store.confirmAllUnderstanding({ materialId })
    actionHint.value = result.ok
      ? result.data.confirmedCount > 0
        ? `已确认 ${result.data.confirmedCount} 条理解`
        : '这份材料没有待确认的条目'
      : result.message
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="draft">
    <div v-if="hasAnyBlock" class="draft-list">
      <div v-for="group in groups" :key="group.materialId" class="draft-group">
        <div class="group-head">
          <span class="group-name" :title="group.materialName">{{ group.materialName }}</span>
          <button
            class="btn confirm-all"
            type="button"
            :disabled="busyId === group.materialId || group.unconfirmedCount === 0"
            @click="confirmGroup(group.materialId)"
          >
            {{ group.unconfirmedCount > 0 ? `整份确认（${group.unconfirmedCount}）` : '整份已确认' }}
          </button>
        </div>

        <div v-for="section in group.sections" :key="section.kind" class="draft-section">
          <div class="section-head">
            <span class="section-title">{{ section.title }}</span>
            <span class="section-hint">{{ section.hint }}</span>
          </div>

          <div
            v-for="block in section.items"
            :key="block.id"
            class="candidate"
            :class="`is-${block.status}`"
          >
            <div class="cand-head">
              <span class="cand-status">{{ STATUS_TEXT[block.status] }}</span>
            </div>

            <template v-if="editingId === block.id">
              <textarea v-model="editingText" class="cand-edit" maxlength="300"></textarea>
              <div class="cand-sources">
                <span v-for="source in block.sources" :key="`${source.segmentId}`" class="src">
                  {{ sourceText(source) }}
                </span>
                <span v-if="block.sources.length === 0" class="src muted">这条没有标注来源</span>
              </div>
              <div class="cand-actions">
                <button
                  class="btn primary"
                  type="button"
                  :disabled="busyId === block.id"
                  @click="saveEdit(block)"
                >
                  保存修改
                </button>
                <button class="btn" type="button" @click="cancelEdit">取消</button>
              </div>
            </template>

            <template v-else>
              <p class="cand-text">{{ block.content }}</p>
              <div class="cand-sources">
                <span v-for="source in block.sources" :key="`${source.segmentId}`" class="src">
                  {{ sourceText(source) }}
                </span>
                <span v-if="block.sources.length === 0" class="src muted">这条没有标注来源</span>
              </div>
              <div class="cand-actions">
                <button
                  v-if="block.status !== 'confirmed'"
                  class="btn primary"
                  type="button"
                  :disabled="busyId === block.id"
                  @click="confirmBlock(block)"
                >
                  确认这条
                </button>
                <button
                  class="btn"
                  type="button"
                  :disabled="busyId === block.id"
                  @click="startEdit(block)"
                >
                  {{ block.status === 'confirmed' ? '修改（改完需再确认）' : '修改' }}
                </button>
                <button
                  class="btn danger"
                  type="button"
                  :disabled="busyId === block.id"
                  @click="deleteBlock(block)"
                >
                  删除
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <p v-else class="empty draft-empty">
      还没有理解草稿。先上传一份 md 或 txt，再点「获取理解草稿」。
    </p>

    <p v-if="actionHint" class="draft-hint">{{ actionHint }}</p>
    <p class="draft-note">
      只有标着「已确认」的内容会进入 AI 建议与问答；「待确认」和「已修改」都只是草稿。
    </p>
  </div>
</template>

<style scoped>
.draft-group + .draft-group {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed #e5e3db;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.group-name {
  font-size: 12.5px;
  font-weight: 600;
  color: #33322e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.confirm-all {
  padding: 3px 10px;
  font-size: 11.5px;
  white-space: nowrap;
}

.confirm-all:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.draft-section + .draft-section {
  margin-top: 10px;
}

.section-head {
  margin-bottom: 4px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: #444441;
}

.section-hint {
  display: block;
  font-size: 11px;
  color: #888780;
  margin-top: 1px;
}

.candidate {
  border: 1px solid #e5e3db;
  border-left-width: 3px;
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: #fff;
}

.candidate.is-pending {
  border-left-color: #EF9F27;
  background: #fffdf8;
}

.candidate.is-modified {
  border-left-color: #378ADD;
  background: #f8fbff;
}

.candidate.is-confirmed {
  border-left-color: #1D9E75;
  background: #f7fdfa;
}

.cand-head {
  display: flex;
  justify-content: flex-end;
}

.cand-status {
  font-size: 10.5px;
  border-radius: 999px;
  padding: 1px 8px;
}

.is-pending .cand-status {
  background: #faeeda;
  color: #854f0b;
  border: 1px solid #fac775;
}

.is-modified .cand-status {
  background: #e6f1fb;
  color: #185fa5;
  border: 1px solid #b5d4f4;
}

.is-confirmed .cand-status {
  background: #e1f5ee;
  color: #0f6e56;
  border: 1px solid #9fe1cb;
}

.cand-text {
  font-size: 12.5px;
  line-height: 1.7;
  color: #33322e;
  margin: 4px 0 0;
  word-break: break-word;
}

.cand-edit {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #d3d1c7;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12.5px;
  font-family: inherit;
  min-height: 52px;
  resize: vertical;
  outline: none;
  margin-top: 4px;
}

.cand-edit:focus {
  border-color: #378add;
}

.cand-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.src {
  font-size: 10.5px;
  color: #5f5e5a;
  background: #f6f5f1;
  border: 1px solid #e5e3db;
  border-radius: 999px;
  padding: 1px 8px;
}

.src.muted {
  color: #888780;
}

.cand-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.cand-actions .btn {
  padding: 3px 10px;
  font-size: 11.5px;
}

.cand-actions .btn.primary {
  background: #1d9e75;
  color: #fff;
  border: 1px solid #1d9e75;
}

.cand-actions .btn.danger {
  color: #a13329;
  border-color: #f5c2bd;
}

.draft-empty {
  font-size: 12px;
  color: #888780;
  line-height: 1.7;
}

.draft-hint {
  margin-top: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  background: #e6f1fb;
  border: 1px solid #b5d4f4;
  color: #185fa5;
  font-size: 11.5px;
  line-height: 1.6;
}

.draft-note {
  margin-top: 10px;
  font-size: 11px;
  color: #888780;
  line-height: 1.6;
}
</style>
