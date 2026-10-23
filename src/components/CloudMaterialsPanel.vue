<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useCloudStore } from '@/stores/cloud'
import { bytesToBase64 } from '@/services/materialsApi'
import { MATERIAL_TYPES, UNDERSTANDING_BLOCK_LABEL } from '@/domain/materials'
import type {
  CloudMaterial,
  CloudMaterialSegment,
  CloudMaterialStatus,
  CloudUnderstandingItem,
} from '@/types/platform'

/**
 * 项目资料（云端材料）
 * ----------------------------------------------------------------------------
 * 只做页面：数据全部来自 `cloud` store（契约 22.8 / 22.9），页面不拼 URL、不造数据。
 *
 * 三条展示纪律（`docs/v3-frontend-delivery.md` §2.6）：
 *   1. 「没有材料」只在 `materialsHydrated && materialsStatus === 'ready'` 时才敢说；
 *   2. 读取失败显示 `message`（中文原因），不给用户看 `code`；
 *   3. 失败与空是两件事：失败一定有「重试」，空一定给上传入口。
 */
const cloud = useCloudStore()

const includeArchived = ref(false)
const selectedId = ref<string | null>(null)
const selectedVersion = ref<number | null>(null)
const uploadNotice = ref<string | null>(null)
const uploadError = ref<string | null>(null)
const detailError = ref<string | null>(null)
const busyKey = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const materials = computed(() => cloud.materials)
const loading = computed(() => cloud.materialsStatus === 'loading' && !cloud.materialsHydrated)
const failed = computed(() => cloud.materialsStatus === 'error')
const ready = computed(() => cloud.materialsHydrated && cloud.materialsStatus === 'ready')
const isEmpty = computed(() => ready.value && materials.value.length === 0)
const uploading = computed(() => cloud.materialUpload.status === 'submitting')

const selected = computed<CloudMaterial | null>(() => {
  if (selectedId.value === null) return null
  const version = selectedVersion.value
  return (
    materials.value.find(
      (item) =>
        item.materialId === selectedId.value &&
        (version === null || item.materialVersion === version),
    ) ?? null
  )
})

const segments = computed<CloudMaterialSegment[] | null>(() => {
  const material = selected.value
  if (material === null) return null
  return cloud.cachedSegments(material.materialId, material.materialVersion)
})

const understanding = computed<CloudUnderstandingItem[] | null>(() => {
  const material = selected.value
  if (material === null) return null
  return cloud.cachedUnderstanding(material.materialId, material.materialVersion)
})

const detailLoading = computed(() => {
  const material = selected.value
  if (material === null) return false
  return cloud.isMaterialReadLoading(material.materialId, material.materialVersion)
})

const STATUS_TEXT: Record<CloudMaterialStatus, string> = {
  registered: '等待解析',
  parsed: '已解析',
  parse_failed: '解析失败',
  unsupported: '格式不支持',
  archived: '已归档',
}

const UNDERSTANDING_STATUS_TEXT: Record<CloudUnderstandingItem['status'], string> = {
  pending: '待确认',
  confirmed: '已确认',
  modified: '改过待再确认',
  archived: '已归档',
}

/** 只有已确认（`confirmed`）的条目才会进入 AI 依据（契约 17.2），页面要区分出来 */
const confirmedCount = computed(
  () => (understanding.value ?? []).filter((item) => item.status === 'confirmed').length,
)

function statusText(status: CloudMaterialStatus): string {
  return STATUS_TEXT[status] ?? status
}

function understandingStatusText(status: CloudUnderstandingItem['status']): string {
  return UNDERSTANDING_STATUS_TEXT[status] ?? status
}

function sizeText(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 KB'
  const kb = size / 1024
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`
}

function timeText(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function isBusy(key: string): boolean {
  return busyKey.value === key
}

async function loadList(): Promise<void> {
  await cloud.refreshMaterials({ includeArchived: includeArchived.value })
}

async function refresh(): Promise<void> {
  await loadList()
}

async function onToggleArchived(): Promise<void> {
  selectedId.value = null
  selectedVersion.value = null
  await loadList()
}

function pickFile(): void {
  uploadError.value = null
  uploadNotice.value = null
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  if (file === null) return

  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!MATERIAL_TYPES.includes(extension as (typeof MATERIAL_TYPES)[number])) {
    uploadError.value = '只支持 MD 和 TXT 文件，请换一个文件再上传。'
    return
  }
  if (file.size > 1024 * 1024) {
    uploadError.value = '文件超过 1 MB 上限，请压缩或拆分后再上传。'
    return
  }

  uploadError.value = null
  uploadNotice.value = null
  const bytes = new Uint8Array(await file.arrayBuffer())
  const result = await cloud.uploadMaterial({ name: file.name, contentBase64: bytesToBase64(bytes) })
  if (!result.ok) {
    uploadError.value = result.message
    return
  }

  const material = result.data
  const deduplicated = cloud.materialUpload.lastUpload?.deduplicated === true
  uploadNotice.value = deduplicated
    ? '这份材料之前就上传过，已复用已有记录，没有重复保存。'
    : material.status === 'parse_failed'
      ? '材料已保存，但解析失败，暂时没有片段与理解草稿；可以稍后重新解析。'
      : '材料已保存并解析完成；理解条目需逐条确认后才会作为 AI 依据。'

  await loadList()
  if (!deduplicated) {
    const target = cloud.materials.find((item) => item.materialId === material.materialId)
    if (target !== undefined) await select(target)
  }
}

async function select(material: CloudMaterial): Promise<void> {
  selectedId.value = material.materialId
  selectedVersion.value = material.materialVersion
  detailError.value = null
  if (material.status !== 'parsed' && material.status !== 'archived') return
  await Promise.all([readSegments(false), readUnderstanding(false)])
}

async function readSegments(forceRefresh: boolean): Promise<void> {
  const material = selected.value
  if (material === null) return
  const result = await cloud.loadMaterialSegments(material.materialId, {
    version: material.materialVersion,
    forceRefresh,
  })
  if (!result.ok) detailError.value = result.message
}

async function readUnderstanding(forceRefresh: boolean): Promise<void> {
  const material = selected.value
  if (material === null) return
  const result = await cloud.loadMaterialUnderstanding(material.materialId, {
    version: material.materialVersion,
    forceRefresh,
  })
  if (!result.ok) detailError.value = result.message
}

async function reloadDetail(): Promise<void> {
  detailError.value = null
  await Promise.all([readSegments(true), readUnderstanding(true)])
}

async function runMaterialAction(
  action: 'archive' | 'restore' | 'reparse',
  material: CloudMaterial,
): Promise<void> {
  const key = `${action}:${material.materialId}`
  busyKey.value = key
  detailError.value = null
  uploadNotice.value = null
  uploadError.value = null
  try {
    const result =
      action === 'archive'
        ? await cloud.archiveMaterial(material.materialId)
        : action === 'restore'
          ? await cloud.restoreMaterial(material.materialId)
          : await cloud.reparseMaterial(material.materialId)
    if (!result.ok) {
      uploadError.value = result.message
      return
    }
    uploadNotice.value =
      action === 'archive'
        ? `已归档「${material.name}」，它不会再作为 AI 依据。`
        : action === 'restore'
          ? `已恢复「${material.name}」。`
          : `已重新解析「${material.name}」为版本 ${result.data.materialVersion}，理解条目需要重新确认。`
    await loadList()
    const target = cloud.materials.find((item) => item.materialId === material.materialId)
    if (target !== undefined) {
      selectedId.value = target.materialId
      selectedVersion.value = target.materialVersion
      await Promise.all([readSegments(true), readUnderstanding(true)])
    }
  } finally {
    busyKey.value = null
  }
}

onMounted(() => {
  if (!cloud.materialsHydrated && cloud.materialsStatus === 'idle') void loadList()
})
</script>

<template>
  <section class="card materials-panel">
    <div class="card-h materials-head">
      <span>项目资料</span>
      <span class="count">{{ materials.length }} 份</span>
      <label class="toggle">
        <input v-model="includeArchived" type="checkbox" @change="onToggleArchived" />
        显示已归档
      </label>
      <button class="btn" type="button" :disabled="loading || uploading" @click="refresh">
        {{ loading ? '读取中…' : '刷新' }}
      </button>
      <button class="btn primary" type="button" :disabled="uploading" @click="pickFile">
        {{ uploading ? '上传中…' : '上传 MD / TXT' }}
      </button>
      <input
        ref="fileInput"
        class="file-input"
        type="file"
        accept=".md,.txt,text/markdown,text/plain"
        aria-label="选择要上传的材料文件"
        @change="onFileChange"
      />
    </div>

    <div class="card-b">
      <p v-if="uploadError" class="cloud-error">{{ uploadError }}</p>
      <p v-else-if="uploadNotice" class="notice">{{ uploadNotice }}</p>

      <p v-if="loading" class="hint">正在读取材料…</p>

      <div v-else-if="failed" class="cloud-error error-block">
        <span>{{ cloud.materialsError?.message ?? '材料读取失败，请稍后重试' }}</span>
        <button class="btn" type="button" @click="refresh">重试</button>
      </div>

      <p v-else-if="isEmpty" class="hint">
        这个项目还没有材料。上传 MD 或 TXT 后，系统会切分片段并生成理解草稿；只有你逐条确认的内容才会作为
        AI 依据。
      </p>

      <ul v-else class="material-list">
        <li
          v-for="material in materials"
          :key="`${material.materialId}@${material.materialVersion}`"
          class="material-row"
          :class="{ selected: material.materialId === selectedId, archived: material.archivedAt !== null }"
        >
          <button class="material-main" type="button" @click="select(material)">
            <span class="material-title">
              <strong>{{ material.name }}</strong>
              <span class="badge" :class="material.status">{{ statusText(material.status) }}</span>
              <span v-if="material.readOnly" class="badge muted">只读</span>
            </span>
            <small class="material-meta">
              内容版本 {{ material.materialVersion }} · 元数据 v{{ material.revision }} ·
              {{ sizeText(material.size) }} · {{ timeText(material.updatedAt) }}
            </small>
            <small v-if="material.failureReason" class="material-failure">
              解析失败原因：{{ material.failureReason }}
            </small>
          </button>

          <div class="row-actions">
            <button
              v-if="material.archivedAt === null && !material.readOnly"
              class="btn"
              type="button"
              :disabled="isBusy(`archive:${material.materialId}`)"
              @click="runMaterialAction('archive', material)"
            >
              {{ isBusy(`archive:${material.materialId}`) ? '归档中…' : '归档' }}
            </button>
            <button
              v-if="material.archivedAt !== null"
              class="btn"
              type="button"
              :disabled="isBusy(`restore:${material.materialId}`)"
              @click="runMaterialAction('restore', material)"
            >
              {{ isBusy(`restore:${material.materialId}`) ? '恢复中…' : '恢复' }}
            </button>
            <button
              v-if="material.archivedAt === null && material.isCurrent && !material.readOnly"
              class="btn"
              type="button"
              :disabled="isBusy(`reparse:${material.materialId}`)"
              @click="runMaterialAction('reparse', material)"
            >
              {{ isBusy(`reparse:${material.materialId}`) ? '解析中…' : '重新解析' }}
            </button>
          </div>
        </li>
      </ul>

      <div v-if="selected" class="material-detail">
        <div class="detail-head">
          <div>
            <strong>{{ selected.name }}</strong>
            <small>
              版本 {{ selected.materialVersion }} · 片段 {{ segments?.length ?? 0 }} 段 · 已确认理解
              {{ confirmedCount }} 条
            </small>
          </div>
          <button class="btn" type="button" :disabled="detailLoading" @click="reloadDetail">
            {{ detailLoading ? '读取中…' : '重新读取' }}
          </button>
        </div>

        <p v-if="detailError" class="cloud-error">{{ detailError }}</p>
        <p v-else-if="detailLoading" class="hint">正在读取片段与理解内容…</p>

        <template v-else>
          <div v-if="selected.status === 'parse_failed'" class="hint">
            这份材料解析失败，没有片段与理解草稿。可以点「重新解析」，或删掉后重新上传。
          </div>
          <template v-else>
            <div class="detail-block">
              <h4>材料片段</h4>
              <p v-if="segments !== null && segments.length === 0" class="hint">这份材料没有切出片段。</p>
              <p v-else-if="segments === null" class="hint">还没有读取片段。</p>
              <ol v-else class="segment-list">
                <li v-for="segment in segments" :key="segment.segmentId">
                  <div class="segment-head">
                    <span>第 {{ segment.index + 1 }} 段</span>
                    <small>行 {{ segment.startLine }}–{{ segment.endLine }} · {{ segment.charCount }} 字</small>
                  </div>
                  <pre class="segment-text">{{ segment.text }}</pre>
                </li>
              </ol>
            </div>

            <div class="detail-block">
              <h4>理解内容</h4>
              <p v-if="understanding !== null && understanding.length === 0" class="hint">
                这份材料还没有理解条目，说明草稿尚未生成。
              </p>
              <p v-else-if="understanding === null" class="hint">还没有读取理解内容。</p>
              <ul v-else class="understanding-list">
                <li v-for="item in understanding" :key="item.itemId">
                  <div class="understanding-head">
                    <span class="kind">{{ UNDERSTANDING_BLOCK_LABEL[item.kind] ?? item.kind }}</span>
                    <span class="badge" :class="item.status">{{ understandingStatusText(item.status) }}</span>
                  </div>
                  <p class="understanding-text">{{ item.text }}</p>
                  <small v-if="item.sources.length" class="understanding-source">
                    来自：{{ item.sources
                      .map((source) => `第 ${source.startLine}–${source.endLine} 行`)
                      .join('、') }}
                  </small>
                </li>
              </ul>
            </div>
          </template>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.materials-panel { margin-bottom: 20px; }
.materials-head { flex-wrap: wrap; gap: 8px; }
.materials-head .count { color: #888780; font-size: 12px; font-weight: 400; }
.materials-head .toggle { display: flex; align-items: center; gap: 5px; margin-left: auto; font-size: 12px; color: #5f5e5a; }
.materials-head .btn { padding: 5px 10px; font-size: 12px; }
.file-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.hint { color: #5f5e5a; font-size: 12.5px; line-height: 1.7; }
.notice { background: #eaf5ee; border: 1px solid #b9dfc7; color: #1f6b3c; border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.6; }
.error-block { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.material-list { list-style: none; display: grid; gap: 8px; }
.material-row { border: 1px solid #e4e2da; border-radius: 10px; padding: 10px 12px; }
.material-row.selected { border-color: #378ADD; background: #f6faff; }
.material-row.archived { opacity: 0.72; }
.material-main { display: block; width: 100%; text-align: left; background: transparent; border: 0; padding: 0; cursor: pointer; font: inherit; }
.material-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.material-title strong { font-size: 13.5px; }
.material-meta { display: block; margin-top: 5px; color: #888780; font-size: 11.5px; }
.material-failure { display: block; margin-top: 4px; color: #854F0B; font-size: 11.5px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #f1efe8; color: #5f5e5a; border: 1px solid #d3d1c7; }
.badge.parsed, .badge.confirmed { background: #eaf5ee; color: #1f6b3c; border-color: #b9dfc7; }
.badge.parse_failed, .badge.modified { background: #FAEEDA; color: #854F0B; border-color: #FAC775; }
.badge.registered, .badge.pending { background: #eef4fb; color: #185FA5; border-color: #b8d3ee; }
.badge.archived { background: #f1efe8; color: #6b6a64; }
.badge.muted { background: #f1efe8; color: #77766f; }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.row-actions .btn { padding: 4px 8px; font-size: 11.5px; }
.row-actions .btn:disabled { cursor: not-allowed; opacity: 0.6; }
.material-detail { margin-top: 16px; border-top: 1px dashed #e4e2da; padding-top: 14px; }
.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.detail-head small { display: block; margin-top: 4px; color: #888780; font-size: 11.5px; }
.detail-head .btn { padding: 4px 8px; font-size: 11.5px; }
.detail-block { margin-top: 14px; }
.detail-block h4 { font-size: 12.5px; margin-bottom: 8px; color: #2c2c2a; }
.segment-list, .understanding-list { list-style: none; display: grid; gap: 8px; }
.segment-list li, .understanding-list li { border: 1px solid #efeee9; border-radius: 8px; padding: 9px 10px; background: #fcfcfa; }
.segment-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: #2c2c2a; }
.segment-head small { color: #888780; font-size: 11px; }
.segment-text { margin-top: 6px; max-height: 160px; overflow: auto; white-space: pre-wrap; font-size: 11.5px; line-height: 1.6; color: #44433f; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.understanding-head { display: flex; align-items: center; gap: 8px; }
.understanding-head .kind { font-size: 12px; font-weight: 600; color: #2c2c2a; }
.understanding-text { margin-top: 5px; font-size: 12.5px; line-height: 1.6; color: #44433f; }
.understanding-source { display: block; margin-top: 5px; color: #888780; font-size: 11px; }
@media (max-width: 520px) {
  .materials-head .toggle { margin-left: 0; }
  .materials-head .btn { flex: 1 1 auto; }
  .detail-head { flex-direction: column; align-items: stretch; }
  .error-block { flex-direction: column; align-items: flex-start; }
}
</style>
