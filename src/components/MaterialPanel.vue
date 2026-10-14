<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkbenchStore } from '@/stores/workbench'
import { MATERIAL_ERROR_MESSAGES } from '@/domain/recommendation'
import type { Material } from '@/types/platform'

/**
 * 材料面板（MD / TXT）
 * ----------------------------------------------------------------------------
 * 本轮契约（M2-A）只支持 `.md` 与 `.txt`；CSV/XLSX 属下一批，PDF/DOCX/ZIP 属后续版本。
 *
 * 页面只做三件事：
 *   1. 选文件 → 先按扩展名挡一道，再把**原始 File 对象**交给 store；
 *   2. 调 `store.uploadMaterialFile`，展示上传中 / 成功 / 失败 / 重试；
 *   3. 展示材料列表与解析状态，并提供「获取理解草稿」入口。
 *
 * 两条硬约束：
 *   - **不在页面层读文件文本**（不调用 `file.text()`）：GBK 文件必须先拿原始字节，
 *     由 store 的适配层做 base64，页面提前解码会破坏编码判定；
 *   - **上传失败不清空任何已有内容**：表单与材料列表都不动，只显示原因 + 重试。
 */

const store = useWorkbenchStore()

const ACCEPT = '.md,.txt'

/** 与契约 16 的中文文案保持一致：不支持的类型要讲清后续计划 */
const UNSUPPORTED_TEXT = MATERIAL_ERROR_MESSAGES.UNSUPPORTED_MATERIAL_TYPE

/** 选中的文件与「待重试」的文件：失败后保留，重试复用同一个 File */
const pendingFile = ref<File | null>(null)
const lastFailedFile = ref<File | null>(null)

type UploadPhase = 'idle' | 'uploading' | 'success' | 'error'
const phase = ref<UploadPhase>('idle')
const phaseText = ref('')
const errorText = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

/** 正在重新上传的材料（换新版本时用）：null 表示这是新登记 */
const replacingMaterialId = ref<string | null>(null)

const uploading = computed(() => phase.value === 'uploading')

/** 扩展名二次校验（不区分大小写）；契约 15.1 第 3 步在服务端也会再查一次 */
function isSupportedName(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.txt')
}

function pickFile(): void {
  replacingMaterialId.value = null
  lastFailedFile.value = null
  fileInput.value?.click()
}

function pickReplaceFile(materialId: string): void {
  replacingMaterialId.value = materialId
  lastFailedFile.value = null
  fileInput.value?.click()
}

function onFileChosen(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  // 允许再次选择同一个文件（否则 input 不会触发 change）
  input.value = ''
  if (file === null) return

  pendingFile.value = file
  phase.value = 'idle'
  phaseText.value = ''
  errorText.value = ''

  // 页面层先挡一道：非法扩展名不发起请求，直接给中文提示
  if (!isSupportedName(file.name)) {
    phase.value = 'error'
    errorText.value = `「${file.name}」不是支持的格式。${UNSUPPORTED_TEXT}`
    lastFailedFile.value = file
    return
  }

  void startUpload(file)
}

async function startUpload(file: File): Promise<void> {
  phase.value = 'uploading'
  errorText.value = ''
  phaseText.value = `正在上传并解析「${file.name}」…`

  const input: Parameters<typeof store.uploadMaterialFile>[0] = {
    // 直接传原始 File：store 的适配层读 arrayBuffer 后编 base64，
    // 页面**不**调用 file.text()，否则 GBK 字节会被破坏
    file,
    name: file.name,
  }
  if (replacingMaterialId.value !== null) input.materialId = replacingMaterialId.value

  try {
    const result = await store.uploadMaterialFile(input)
    if (!result.ok) {
      phase.value = 'error'
      errorText.value = result.message
      phaseText.value = ''
      lastFailedFile.value = file
      return
    }

    phase.value = 'success'
    lastFailedFile.value = null
    phaseText.value =
      result.data.version > 1
        ? `「${file.name}」已更新到第 ${result.data.version} 版，拆成 ${result.data.segmentCount} 个片段`
        : `「${file.name}」已解析，拆成 ${result.data.segmentCount} 个片段`
    replacingMaterialId.value = null
  } catch (error: unknown) {
    // store 内部已把契约失败转成 ActionResult；这里只兜住"请求还没发出就抛"的异常
    console.warn('[材料] 上传未能完成', error instanceof Error ? error.name : 'unknown')
    phase.value = 'error'
    errorText.value = '上传没有完成，请检查网络后重试。'
    phaseText.value = ''
    lastFailedFile.value = file
  }
}

function retry(): void {
  const file = lastFailedFile.value
  if (file === null) return
  void startUpload(file)
}

function clearUploadState(): void {
  pendingFile.value = null
  lastFailedFile.value = null
  phase.value = 'idle'
  phaseText.value = ''
  errorText.value = ''
  replacingMaterialId.value = null
}

/* -------------------------------------------------------- 材料与解析状态 */

const materials = computed<Material[]>(() => store.materials)

function materialStateText(material: Material): string {
  if (material.needsReupload || material.state === null) return '仅登记，待重新上传'
  if (material.state === 'parse_failed') return '解析失败'
  if (material.state === 'parsed') return '已解析'
  return '状态未知'
}

function materialStateTone(material: Material): string {
  if (material.state === 'parsed' && !material.needsReupload) return 'ok'
  if (material.state === 'parse_failed') return 'bad'
  return 'wait'
}

function segmentCountOf(material: Material): number {
  return store.materialSegments.filter(
    (segment) =>
      segment.materialId === material.materialId && segment.materialVersion === material.version,
  ).length
}

/** 只有真的解析成功、且拿得到当前版本片段时，才允许请求理解草稿 */
function canRequestUnderstanding(material: Material): boolean {
  return material.state === 'parsed' && !material.needsReupload && segmentCountOf(material) > 0
}

const understanding = ref<{ materialId: string; phase: 'loading' | 'done' | 'error'; text: string } | null>(
  null,
)

async function requestUnderstanding(material: Material): Promise<void> {
  if (understanding.value?.phase === 'loading') return

  understanding.value = { materialId: material.materialId, phase: 'loading', text: '正在生成理解草稿…' }
  try {
    const result = await store.requestUnderstanding({ materialId: material.materialId })
    if (!result.ok) {
      understanding.value = { materialId: material.materialId, phase: 'error', text: result.message }
      return
    }

    // 契约 15.2：model 与 fallback 都是「请求已完成」，fallback 时另有 notice 要展示
    understanding.value = {
      materialId: material.materialId,
      phase: 'done',
      text:
        result.data.source === 'fallback'
          ? `已生成草稿（${result.data.blockCount} 条）。${result.data.notice ?? ''}`.trim()
          : `已生成 ${result.data.blockCount} 条待确认草稿`,
    }
  } catch (error: unknown) {
    console.warn('[材料] 理解请求未能完成', error instanceof Error ? error.name : 'unknown')
    understanding.value = { materialId: material.materialId, phase: 'error', text: '生成草稿没有完成，请稍后重试。' }
  }
}

/** 本轮支持的计划说明：用户选错格式时能看到后续安排，不是一句"不支持" */
const ROADMAP_TEXT = UNSUPPORTED_TEXT

defineExpose({ clearUploadState })
</script>

<template>
  <div class="material-panel">
    <div v-if="materials.length" class="mat-list">
      <div v-for="material in materials" :key="material.materialId" class="mat-item">
        <div class="mat-head">
          <span class="mat-name" :title="material.name">{{ material.name }}</span>
          <span class="tag" :class="`state-${materialStateTone(material)}`">
            {{ materialStateText(material) }}
          </span>
        </div>
        <div class="mat-meta">
          <span v-if="material.version > 1">第 {{ material.version }} 版</span>
          <span v-if="canRequestUnderstanding(material)">{{ segmentCountOf(material) }} 个片段</span>
          <span v-else-if="material.needsReupload">需要重新上传一份 md 或 txt</span>
        </div>
        <div class="mat-actions">
          <button
            v-if="canRequestUnderstanding(material)"
            class="btn"
            type="button"
            :disabled="uploading"
            @click="requestUnderstanding(material)"
          >
            获取理解草稿
          </button>
          <button class="btn" type="button" :disabled="uploading" @click="pickReplaceFile(material.materialId)">
            重新上传
          </button>
        </div>
        <p
          v-if="understanding !== null && understanding.materialId === material.materialId"
          class="mat-note"
          :class="{ error: understanding.phase === 'error' }"
        >
          {{ understanding.text }}
        </p>
      </div>
    </div>

    <p v-else class="empty mat-empty">
      还没有材料。上传一份 md 或 txt 文件后，系统会拆成片段并生成待确认的理解草稿。
    </p>

    <div class="up-row">
      <button class="btn primary" type="button" :disabled="uploading" @click="pickFile">
        {{ uploading ? '上传中…' : '＋ 上传材料' }}
      </button>
      <span class="up-hint">支持 .md / .txt</span>
    </div>

    <input
      ref="fileInput"
      type="file"
      class="file-input"
      :accept="ACCEPT"
      @change="onFileChosen"
    />

    <div v-if="phase === 'uploading'" class="up-status uploading">
      {{ phaseText }}
    </div>
    <div v-else-if="phase === 'success'" class="up-status ok">
      ✓ {{ phaseText }}
    </div>
    <div v-else-if="phase === 'error'" class="up-status bad">
      <span>{{ errorText }}</span>
      <button v-if="lastFailedFile" class="btn retry" type="button" @click="retry">重试上传</button>
    </div>

    <p class="roadmap">{{ ROADMAP_TEXT }}</p>
  </div>
</template>

<style scoped>
.mat-list {
  margin-bottom: 10px;
}

.mat-item {
  border: 1px solid #e5e3db;
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: #fdfcfa;
}

.mat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mat-name {
  font-size: 12.5px;
  font-weight: 600;
  color: #33322e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
}

.state-ok {
  background: #e1f5ee;
  color: #0f6e56;
  border: 1px solid #9fe1cb;
}

.state-bad {
  background: #fdecea;
  color: #a13329;
  border: 1px solid #f5c2bd;
}

.state-wait {
  background: #faeeda;
  color: #854f0b;
  border: 1px solid #fac775;
}

.mat-meta {
  display: flex;
  gap: 10px;
  font-size: 11.5px;
  color: #888780;
  margin-top: 4px;
}

.mat-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.mat-actions .btn {
  padding: 4px 10px;
  font-size: 11.5px;
}

.mat-note {
  font-size: 11.5px;
  color: #0f6e56;
  margin-top: 6px;
  line-height: 1.6;
}

.mat-note.error {
  color: #854f0b;
}

.mat-empty {
  padding: 4px 0 10px;
  font-size: 12px;
  color: #888780;
  line-height: 1.7;
}

.up-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.up-hint {
  font-size: 11.5px;
  color: #888780;
}

.file-input {
  display: none;
}

.up-status {
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
}

.up-status.uploading {
  background: #e6f1fb;
  border: 1px solid #b5d4f4;
  color: #185fa5;
}

.up-status.ok {
  background: #e1f5ee;
  border: 1px solid #9fe1cb;
  color: #0f6e56;
}

.up-status.bad {
  background: #fdecea;
  border: 1px solid #f5c2bd;
  color: #a13329;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}

.up-status .retry {
  padding: 3px 10px;
  font-size: 11.5px;
}

.roadmap {
  margin-top: 8px;
  font-size: 11px;
  color: #888780;
  line-height: 1.6;
}
</style>
