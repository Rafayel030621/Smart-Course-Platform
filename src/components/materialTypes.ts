/**
 * 材料与项目基本信息的 UI 视图类型（M2-A，界面层）
 * ----------------------------------------------------------------------------
 * 只描述组件之间传递的数据形状，字段含义与 docs/contracts.md 第 13 / 14 节一致。
 * 数据层（持久化、store action、项目切换与过期响应）由李焰彬在
 * `src/types/**`、`src/stores/**`、`src/services/**` 落地后接入；
 * 组件只接收 props、只发出 intent，不自己保存、不自己判断业务状态。
 */

/* ------------------------------------------------ 项目基本信息（契约 13.1） */

export interface ProfileFormValue {
  /** 项目目标 */
  goal: string
  /** 预期结果或交付物 */
  expectedOutcome: string
  /** 项目成员姓名 */
  memberNames: string[]
  /** 研究周期（本轮为自由文本） */
  researchPeriod: string
  /** 项目范围 */
  scope: string
  /** 暂不处理的内容 */
  outOfScope: string
}

/** 与契约 13.1 一致的输入上限 */
export const PROFILE_LIMITS = {
  text: 300,
  researchPeriod: 100,
  members: 10,
  memberName: 30,
} as const

export function emptyProfileValue(): ProfileFormValue {
  return {
    goal: '',
    expectedOutcome: '',
    memberNames: [''],
    researchPeriod: '',
    scope: '',
    outOfScope: '',
  }
}

/* ---------------------------------------------- 材料（契约 14.1 / 14.2） */

export type MaterialFileType = 'md' | 'txt'
export type MaterialFileEncoding = 'utf-8' | 'gbk'
export type MaterialFileState = 'parsed' | 'parse_failed'

/** 入口白名单：`.md` / `.txt`（M2-A） */
export const MATERIAL_ACCEPT = '.md,.txt'
/** 契约 15.4：单份材料 1 MB（1,048,576 字节） */
export const MATERIAL_MAX_BYTES = 1_048_576

/** 不支持的类型：明确给中文说明，不做静默忽略 */
export const MATERIAL_UNSUPPORTED_NOTE =
  '当前只支持 MD、TXT 文件；CSV、XLSX 将在下一批支持，PDF、DOCX、ZIP 将在后续版本支持。'

/** 已解析材料的最小展示信息（由页面从 store 投影） */
export interface MaterialSummaryView {
  materialId: string
  name: string
  type: MaterialFileType
  size: number
  encoding: MaterialFileEncoding
  state: MaterialFileState
  version: number
}

/** 旧记录：只登记过文件名，正文没有被读取（界面不得宣称已解析） */
export interface LegacyMaterialView {
  name: string
  type: string
}

export function materialTypeOf(name: string): MaterialFileType | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.txt')) return 'txt'
  return null
}

export function formatMaterialSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/* ---------------------------------------------- 理解草稿（契约 14.3） */

export type DraftBlockKey =
  'goalCandidates' | 'outcomeCandidates' | 'dataNotes' | 'methodNotes' | 'openQuestions'

/** 契约 14.3：条目状态由前端维护；"已修改"仍属于待确认 */
export type DraftItemStatus = 'pending' | 'modified' | 'confirmed'

export const DRAFT_BLOCK_ORDER: readonly DraftBlockKey[] = [
  'goalCandidates',
  'outcomeCandidates',
  'dataNotes',
  'methodNotes',
  'openQuestions',
]

export const DRAFT_BLOCK_TITLES: Record<DraftBlockKey, string> = {
  goalCandidates: '项目目标候选',
  outcomeCandidates: '预期产出候选',
  dataNotes: '数据字段与规模线索',
  methodNotes: '方法或约束线索',
  openQuestions: '待确认问题',
}

/** 条目来源：材料名 + 版本 + 起止行号（不展示内部 ID） */
export interface DraftSourceView {
  materialId: string
  materialName: string
  materialVersion: number
  segmentId: string
  startLine: number
  endLine: number
}

export interface DraftItemView {
  itemId: string
  text: string
  status: DraftItemStatus
  sources: DraftSourceView[]
}

export interface DraftBlockView {
  key: DraftBlockKey
  items: DraftItemView[]
}

/** 一份材料的理解草稿（页面按材料与版本从 store 投影） */
export interface UnderstandingDraftView {
  materialId: string
  materialName: string
  materialVersion: number
  blocks: DraftBlockView[]
}

/** 理解结果的来源（与建议接口同一套语义） */
export type DraftSource = 'model' | 'fallback' | 'local-rule'

export const DRAFT_SOURCE_TEXT: Record<DraftSource, string> = {
  model: 'AI 模型生成',
  fallback: '服务端规则兜底',
  'local-rule': '本地规则',
}

export function draftItemCount(draft: UnderstandingDraftView | null): number {
  if (draft === null) return 0
  return draft.blocks.reduce((sum, block) => sum + block.items.length, 0)
}

export function blockItemsOf(draft: UnderstandingDraftView, key: DraftBlockKey): DraftItemView[] {
  return draft.blocks.find((block) => block.key === key)?.items ?? []
}
