import type {
  Material,
  MaterialItem,
  MaterialReadState,
  MaterialSegment,
  MaterialSourceRef,
  MaterialType,
  Project,
  ProjectProfile,
  UnderstandingBlock,
  UnderstandingBlockKind,
  UnderstandingBlockStatus,
} from '@/types/platform'
import type { ConfirmedMaterial, UnderstandingSegmentInput } from '@/domain/recommendation'
import { createId } from '@/domain/progress'

/**
 * 材料与理解草稿（纯函数）
 * ----------------------------------------------------------------------------
 * 唯一依据：docs/contracts.md 第 13 节（项目基本信息）、第 14 节（材料领域对象）、
 * 第 17 节（建议与聊天的材料上下文）。
 *
 * 本文件只做三件事，不读系统时钟、不写状态、不发请求：
 *   1. 定义契约里的长度 / 数量上限（前端本地校验与截断的唯一出处）；
 *   2. 读取与查找项目里的材料、分段、理解草稿条目；
 *   3. 把「学生已确认」的内容映射成请求字段（`projectProfile` / `confirmedContext` /
 *      `confirmedMaterials`）——**未确认的草稿绝不进入请求体**（契约 12.2 第 2 条）。
 *
 * 命名与团队既有实现保持一致：材料 `Material`、分段 `MaterialSegment`、
 * 理解草稿条目 `UnderstandingBlock`（`kind` + `content` + `status`）。
 */

/* ------------------------------------------------------------------ 契约上限 */

/** 契约 14.1：原始文件名 1～200 字 */
export const MAX_MATERIAL_NAME_LENGTH = 200
/** 契约 15.1 / 15.4：单份材料解码后 ≤ 1 MB */
export const MATERIAL_MAX_BYTES = 1_048_576
/** 契约 14.2：单段正文 ≤ 2,000 字 */
export const MAX_SEGMENT_TEXT_LENGTH = 2_000
/** 契约 15.2：理解请求片段数 ≤ 100 条、合计 ≤ 24,000 字 */
export const MAX_UNDERSTANDING_SEGMENTS = 100
export const MAX_UNDERSTANDING_TOTAL_LENGTH = 24_000
/** 契约 17.1：confirmedMaterials ≤ 3 份材料、≤ 20 条片段、合计 ≤ 8,000 字 */
export const MAX_CONFIRMED_MATERIALS = 3
export const MAX_CONFIRMED_SEGMENTS = 20
export const MAX_CONFIRMED_TOTAL_LENGTH = 8_000
/** 契约 4.1：confirmedContext ≤ 10 条、每条 ≤ 200 字 */
export const MAX_CONFIRMED_CONTEXT_ITEMS = 10
export const MAX_CONFIRMED_CONTEXT_ITEM_LENGTH = 200

/** 契约 13.1：项目基本信息上限 */
export const MAX_PROFILE_TEXT_LENGTH = 300
export const MAX_PROFILE_RESEARCH_PERIOD_LENGTH = 100
export const MAX_PROFILE_MEMBERS = 10
export const MAX_PROFILE_MEMBER_NAME_LENGTH = 30

/** 契约 14.3：一条草稿候选 1～300 字 */
export const MAX_UNDERSTANDING_BLOCK_CONTENT_LENGTH = 300

/** 契约 14.1 / 15.1：本轮只收 md、txt（不区分大小写） */
export const MATERIAL_TYPES: readonly MaterialType[] = ['md', 'txt']

/** 服务端五块（契约 14.3）的展示顺序与中文标签 */
export const UNDERSTANDING_BLOCK_ORDER: readonly UnderstandingBlockKind[] = [
  'goalCandidates',
  'outcomeCandidates',
  'dataNotes',
  'methodNotes',
  'openQuestions',
]

export const UNDERSTANDING_BLOCK_LABEL: Record<UnderstandingBlockKind, string> = {
  goalCandidates: '项目目标',
  outcomeCandidates: '预期产出',
  dataNotes: '数据字段与规模',
  methodNotes: '方法与约束',
  openQuestions: '待确认问题',
}

/* -------------------------------------------------------------------- ID */

/** 契约 14.1：`mat_` 前缀，≤ 64；由前端生成，服务端只当不透明字符串 */
export function createMaterialId(): string {
  return createId('mat')
}

/** 理解草稿条目的本地 id 前缀（契约只在服务端回 `itemId`，本地 id 由前端维护） */
export function createUnderstandingBlockId(): string {
  return createId('ublk')
}

/* ------------------------------------------------------------------ 工具 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampNullableText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

function clampText(value: unknown, limit: number): string {
  return clampNullableText(value, limit) ?? ''
}

/** 归一化一段草稿内容（写入与读取旧数据时用） */
export function normalizeBlockContent(value: unknown): string {
  return clampText(value, MAX_UNDERSTANDING_BLOCK_CONTENT_LENGTH)
}

/* ---------------------------------------------------------- 项目基本信息 */

/** 全部字段为空的默认基本信息：旧项目迁移后的初值（不是 `undefined`） */
export function emptyProjectProfile(): ProjectProfile {
  return {
    goal: null,
    expectedOutcome: null,
    memberNames: [],
    researchPeriod: null,
    scope: null,
    outOfScope: null,
  }
}

/**
 * 归一化成员姓名数组：
 * 逐项 trim、丢掉空项、去重、单人 ≤ 30 字、最多 10 人（契约 13.1）。
 */
export function normalizeMemberNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const names: string[] = []
  for (const item of value) {
    const name = clampNullableText(item, MAX_PROFILE_MEMBER_NAME_LENGTH)
    if (name === null) continue
    if (names.includes(name)) continue
    names.push(name)
    if (names.length >= MAX_PROFILE_MEMBERS) break
  }
  return names
}

/** 归一化（并截断）项目基本信息。用于落库前与读取旧数据时，不用于报错 */
export function normalizeProjectProfile(input: unknown): ProjectProfile {
  if (!isPlainObject(input)) return emptyProjectProfile()

  return {
    goal: clampNullableText(input.goal, MAX_PROFILE_TEXT_LENGTH),
    expectedOutcome: clampNullableText(input.expectedOutcome, MAX_PROFILE_TEXT_LENGTH),
    memberNames: normalizeMemberNames(input.memberNames),
    researchPeriod: clampNullableText(input.researchPeriod, MAX_PROFILE_RESEARCH_PERIOD_LENGTH),
    scope: clampNullableText(input.scope, MAX_PROFILE_TEXT_LENGTH),
    outOfScope: clampNullableText(input.outOfScope, MAX_PROFILE_TEXT_LENGTH),
  }
}

/** 是否所有字段都为空：为空时请求体不带 `projectProfile`（契约 13.2） */
export function isProjectProfileEmpty(profile: ProjectProfile): boolean {
  return (
    profile.goal === null &&
    profile.expectedOutcome === null &&
    profile.researchPeriod === null &&
    profile.scope === null &&
    profile.outOfScope === null &&
    profile.memberNames.length === 0
  )
}

/**
 * 契约 13.1 的长度校验（面向**用户原始输入**）。
 *
 * 必须在归一化之前调用：归一化会截断超长文本（用于容错旧数据），
 * 而用户输入超限时要报错并高亮字段，不能静默截断。
 */
export function validateProjectProfileInput(input: unknown): string | null {
  if (!isPlainObject(input)) return null

  const textChecks: Array<{ key: string; limit: number; label: string }> = [
    { key: 'goal', limit: MAX_PROFILE_TEXT_LENGTH, label: '项目目标' },
    { key: 'expectedOutcome', limit: MAX_PROFILE_TEXT_LENGTH, label: '预期结果' },
    { key: 'scope', limit: MAX_PROFILE_TEXT_LENGTH, label: '项目范围' },
    { key: 'outOfScope', limit: MAX_PROFILE_TEXT_LENGTH, label: '暂不处理的内容' },
    { key: 'researchPeriod', limit: MAX_PROFILE_RESEARCH_PERIOD_LENGTH, label: '研究周期' },
  ]

  for (const check of textChecks) {
    const value = input[check.key]
    if (typeof value !== 'string' || value.trim() === '') continue
    if (value.trim().length > check.limit) return `${check.label}最多 ${check.limit} 字`
  }

  const memberNames = input.memberNames
  if (memberNames === undefined || memberNames === null) return null
  if (!Array.isArray(memberNames)) return '成员名单格式不正确'

  const names = memberNames.filter((name) => typeof name === 'string' && name.trim() !== '')
  if (names.length > MAX_PROFILE_MEMBERS) return `项目成员最多 ${MAX_PROFILE_MEMBERS} 人`
  for (const name of names) {
    if ((name as string).trim().length > MAX_PROFILE_MEMBER_NAME_LENGTH) {
      return `成员姓名最多 ${MAX_PROFILE_MEMBER_NAME_LENGTH} 字`
    }
  }
  return null
}

/** 契约 13.2：全部为空时不发送 `projectProfile`；否则原样发送（不发送字段名以外的内部信息） */
export function buildProjectProfile(profile: ProjectProfile | undefined): ProjectProfile | null {
  if (profile === undefined || isProjectProfileEmpty(profile)) return null
  return {
    goal: profile.goal,
    expectedOutcome: profile.expectedOutcome,
    memberNames: [...profile.memberNames],
    researchPeriod: profile.researchPeriod,
    scope: profile.scope,
    outOfScope: profile.outOfScope,
  }
}

/* ------------------------------------------------------------------ 材料读取 */

/** 契约 14.1：材料元数据（每种材料只保留最新版本） */
export function materialsOf(project: Project): Material[] {
  return Array.isArray(project.materialRecords) ? project.materialRecords : []
}

/** 当前版本、解析成功的材料，按创建时间正序（跨次请求稳定） */
export function parsedMaterialsOf(project: Project): Material[] {
  return materialsOf(project)
    .filter((material) => material.state === 'parsed')
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

export function findMaterial(project: Project, materialId: string): Material | null {
  return materialsOf(project).find((material) => material.materialId === materialId) ?? null
}

/** 该 materialId 是否属于**另一个**项目（用于返回 `PROJECT_MISMATCH`） */
export function isMaterialInOtherProject(
  projects: Project[],
  projectId: string,
  materialId: string,
): boolean {
  return projects.some(
    (project) =>
      project.projectId !== projectId &&
      materialsOf(project).some((material) => material.materialId === materialId),
  )
}

/** 项目里全部材料的当前版本片段（本地形态，自带 materialId / materialVersion） */
export function allSegmentsOf(project: Project): MaterialSegment[] {
  const current = new Map(materialsOf(project).map((material) => [material.materialId, material.version]))
  const segments = Array.isArray(project.materialSegments) ? project.materialSegments : []
  return segments.filter((segment) => current.get(segment.materialId) === segment.materialVersion)
}

/** 契约 14.2：某个材料**当前版本**的片段（按 index 正序） */
export function segmentsOfMaterial(project: Project, materialId: string): MaterialSegment[] {
  return allSegmentsOf(project)
    .filter((segment) => segment.materialId === materialId)
    .slice()
    .sort((a, b) => a.index - b.index)
}

/** 在某个材料的某个版本里找一条片段（用于回填来源材料名） */
export function findSegment(
  project: Project,
  materialId: string,
  materialVersion: number,
  segmentId: string,
): MaterialSegment | null {
  const segments = Array.isArray(project.materialSegments) ? project.materialSegments : []
  return (
    segments.find(
      (segment) =>
        segment.materialId === materialId &&
        segment.materialVersion === materialVersion &&
        segment.segmentId === segmentId,
    ) ?? null
  )
}

/** 契约 14.1 备注：材料是否需要重新上传（解析失败，或当前版本没有任何片段） */
export function materialNeedsReupload(material: Material, segmentCount: number): boolean {
  return material.state !== 'parsed' || segmentCount === 0
}

/** 契约 15.2：从第 1 段开始累计，直到片段数或字数达到上限 */
export function selectUnderstandingSegments(
  segments: MaterialSegment[],
): UnderstandingSegmentInput[] {
  const selected: UnderstandingSegmentInput[] = []
  let total = 0

  for (const segment of segments) {
    if (selected.length >= MAX_UNDERSTANDING_SEGMENTS) break
    if (total + segment.text.length > MAX_UNDERSTANDING_TOTAL_LENGTH) break
    selected.push({
      segmentId: segment.segmentId,
      startLine: segment.startLine,
      endLine: segment.endLine,
      text: segment.text,
    })
    total += segment.text.length
  }

  return selected
}

/* ------------------------------------------------------ 理解草稿条目读取 */

/** 项目里全部理解草稿条目 */
export function understandingBlocksOf(project: Project): UnderstandingBlock[] {
  return Array.isArray(project.understandingBlocks) ? project.understandingBlocks : []
}

/**
 * 本地唯一条目的 id：服务器的 `itemId` 只在单次响应内唯一（契约 14.3），
 * 两份材料可能出现同名 `itemId`，因此本地 id 必须带材料与块前缀。
 */
export function understandingBlockKey(
  materialId: string,
  kind: UnderstandingBlockKind,
  itemId: string,
): string {
  return `${materialId}::${kind}::${itemId}`
}

/** 某份材料**当前版本**的草稿条目，按五块顺序排列 */
export function blocksOfMaterial(project: Project, materialId: string): UnderstandingBlock[] {
  const material = findMaterial(project, materialId)
  if (material === null) return []

  const kindIndex = (kind: UnderstandingBlockKind): number => UNDERSTANDING_BLOCK_ORDER.indexOf(kind)

  return understandingBlocksOf(project)
    .filter((block) => block.materialId === materialId && block.materialVersion === material.version)
    .slice()
    .sort((a, b) => kindIndex(a.kind) - kindIndex(b.kind) || a.itemId.localeCompare(b.itemId))
}

export function findUnderstandingBlock(project: Project, blockId: string): UnderstandingBlock | null {
  return understandingBlocksOf(project).find((block) => block.id === blockId) ?? null
}

export function isConfirmedBlock(block: UnderstandingBlock): boolean {
  return block.status === 'confirmed'
}

/** 已确认条目（契约 17.2）：只有这一种会进入请求体 */
export function confirmedBlocksOf(project: Project): UnderstandingBlock[] {
  return understandingBlocksOf(project).filter(isConfirmedBlock)
}

/** 未确认条目 = 待确认 + 已修改（两者都不是项目事实） */
export function unconfirmedBlocksOf(project: Project): UnderstandingBlock[] {
  return understandingBlocksOf(project).filter((block) => block.status !== 'confirmed')
}

/** 待确认条目：模型刚生成，学生还没动过 */
export function pendingBlocksOf(project: Project): UnderstandingBlock[] {
  return understandingBlocksOf(project).filter((block) => block.status === 'pending')
}

/** 已修改条目：学生改过但还没再次确认（所以也不进请求体） */
export function modifiedBlocksOf(project: Project): UnderstandingBlock[] {
  return understandingBlocksOf(project).filter((block) => block.status === 'modified')
}

/**
 * 契约 14.3：撤销确认后回到哪个状态。
 *
 * - 内容与服务端原始文本一致 → `pending`（等同于还没确认过的候选）；
 * - 内容被学生改过 → `modified`（改过但未再次确认），保住「这条被改过」的信息。
 */
export function statusAfterUnconfirm(block: UnderstandingBlock): UnderstandingBlockStatus {
  return block.content.trim() === block.originalContent.trim() ? 'pending' : 'modified'
}

/** 条目是否仍然有效：材料、版本都对得上（契约 14.5 第 4 条：旧版本引用视为过期） */
export function isBlockCurrent(project: Project, block: UnderstandingBlock): boolean {
  const material = findMaterial(project, block.materialId)
  return material !== null && material.version === block.materialVersion
}

/** 去掉失效（材料已删或已升版）的草稿条目 */
export function dropStaleBlocks(project: Project): UnderstandingBlock[] {
  return understandingBlocksOf(project).filter((block) => isBlockCurrent(project, block))
}

/** 契约 14.1 备注：材料的本地读取口径（仅界面展示，不进接口） */
export function materialReadStateOf(project: Project, materialId: string): MaterialReadState {
  const blocks = blocksOfMaterial(project, materialId)
  if (blocks.length === 0) return 'registered'
  if (blocks.some((block) => block.status !== 'confirmed')) return 'pending'
  return 'confirmed'
}

/** 材料的本地读取口径：materialId → 状态 */
export function materialReadStates(project: Project): Record<string, MaterialReadState> {
  const table: Record<string, MaterialReadState> = {}
  for (const material of materialsOf(project)) {
    table[material.materialId] = materialReadStateOf(project, material.materialId)
  }
  return table
}

/* ------------------------------------------------ 已确认内容 → 请求字段 */

/** 契约 14.3：`材料名 (第 3-8 行)` 这样的展示 / 提示词来源说明 */
export function describeBlockSource(ref: MaterialSourceRef): string {
  if (ref.startLine === ref.endLine) {
    return `${ref.materialName} (第 ${ref.startLine} 行)`
  }
  return `${ref.materialName} (第 ${ref.startLine}-${ref.endLine} 行)`
}

/**
 * 契约 4.1 / 13.2：`confirmedContext` = 学生已确认的项目事实。
 *
 * 由**已确认的理解草稿条目**生成，标签用中文块名；项目基本信息走 `projectProfile`，
 * 不重复写进这里（契约 13.2 明确要求）。
 */
export function buildConfirmedContext(project: Project): string[] {
  const lines: string[] = []

  for (const block of confirmedBlocksOf(project)) {
    const content = block.content.trim()
    if (content === '') continue
    const label = UNDERSTANDING_BLOCK_LABEL[block.kind] ?? '项目理解'
    lines.push(`${label}：${content}`)
    if (lines.length >= MAX_CONFIRMED_CONTEXT_ITEMS) break
  }

  return lines.map((line) =>
    line.length > MAX_CONFIRMED_CONTEXT_ITEM_LENGTH
      ? `${line.slice(0, MAX_CONFIRMED_CONTEXT_ITEM_LENGTH)}…`
      : line,
  )
}

/**
 * 契约 17.1：`confirmedMaterials` = 已确认条目引用到的材料片段。
 *
 * 约束：≤ 3 份材料、≤ 20 条片段、文本合计 ≤ 8,000 字。
 * 材料顺序按 `createdAt` 正序，保证同样的项目状态得到同样的请求体。
 */
export function buildConfirmedMaterials(project: Project): ConfirmedMaterial[] {
  const confirmed = confirmedBlocksOf(project)
  if (confirmed.length === 0) return []

  const byMaterial = new Map<string, Set<string>>()
  for (const block of confirmed) {
    if (!isBlockCurrent(project, block)) continue
    const ids = byMaterial.get(block.materialId) ?? new Set<string>()
    for (const ref of block.sources) {
      // 来源必须属于这条条目自己的材料，且是当前版本
      if (ref.materialId !== block.materialId || ref.materialVersion !== block.materialVersion) continue
      ids.add(ref.segmentId)
    }
    byMaterial.set(block.materialId, ids)
  }

  const result: ConfirmedMaterial[] = []
  let totalSegments = 0
  let totalChars = 0

  for (const material of parsedMaterialsOf(project)) {
    if (result.length >= MAX_CONFIRMED_MATERIALS) break
    if (material.type === null) continue

    const referenced = byMaterial.get(material.materialId)
    if (referenced === undefined || referenced.size === 0) continue

    const segments: UnderstandingSegmentInput[] = []
    for (const segment of segmentsOfMaterial(project, material.materialId)) {
      if (!referenced.has(segment.segmentId)) continue
      if (totalSegments >= MAX_CONFIRMED_SEGMENTS) break
      if (totalChars + segment.text.length > MAX_CONFIRMED_TOTAL_LENGTH) break

      totalSegments += 1
      totalChars += segment.text.length
      segments.push({
        segmentId: segment.segmentId,
        startLine: segment.startLine,
        endLine: segment.endLine,
        text: segment.text,
      })
    }

    if (segments.length === 0) continue
    result.push({
      materialId: material.materialId,
      name: material.name,
      type: material.type,
      version: material.version,
      segments,
    })
  }

  return result
}

/* ---------------------------------------------------------------- 旧页面投影 */

/**
 * `Project.materials` 的兼容投影（旧页面读 `{ name, type }`）。
 *
 * v2 的材料白名单只有 md / txt，因此统一投影为「材料」；
 * 旧字段 `materials` 本身保持原样不动，避免旧页面写过的条目被投影覆盖。
 */
export function deriveMaterialViews(project: Project): MaterialItem[] {
  return materialsOf(project).map((material) => ({
    name: material.name,
    type: '材料' as const,
  }))
}

/** 材料文件名是否在本轮白名单内（不区分大小写；契约 14.1 / 15.1） */
export function materialTypeFromFileName(name: string): MaterialType | null {
  const matched = /\.([a-z0-9]+)$/i.exec(name.trim())
  if (matched === null) return null
  const extension = matched[1].toLowerCase()
  return (MATERIAL_TYPES as readonly string[]).includes(extension) ? (extension as MaterialType) : null
}

/** 只用于测试与日志的稳定摘要：材料名 + 版本 */
export function describeMaterial(material: Material): string {
  return `${material.name} v${material.version}`
}
