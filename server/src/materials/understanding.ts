import {
  AdvisorProviderError,
  silentLogger,
  type AdvisorFallbackReason,
  type AdvisorLogger,
  type AdvisorProvider,
  type UnderstandingProviderInput,
} from '../advisor/types.js'
import { isHumanizedUserText } from '../advisor/validation.js'
import {
  emptyUnderstandingDraft,
  MATERIAL_RETRYABLE_BY_CODE,
  type DraftItem,
  type MaterialRuntimeErrorCode,
  type MaterialSourceRef,
  type MaterialsUnderstandingInput,
  type MaterialsUnderstandingResult,
  type MaterialsUnderstandingV3Input,
  type UnderstandingDraft,
  type UnderstandingSegmentInput,
} from './types.js'

/**
 * 材料理解：输出校验 + 服务编排（契约 15.2 / 15.3）
 * ----------------------------------------------------------------------------
 * 与建议接口同一套分层：
 *   模型成功且输出合法  → source: "model"
 *   模型失败 / 输出非法  → 服务端保守兜底（空草稿 + 中文 notice），仍返回 200 + source: "fallback"
 *   兜底也失败          → 才把失败码交给路由层（正常实现下不会发生）
 *
 * 三条硬约束（契约 12.2 / 用户决定 5）：
 *   1. 兜底不摘录、不编造材料事实，只返回空草稿与中文说明；
 *   2. 模型只允许给 text 与 segmentIds 引用，材料名、版本、行号一律由服务端回填；
 *   3. 日志只记类别与数量（未知引用次数、丢弃条数、是否不安全输出），
 *      绝不记录模型原始文本、原始 segmentId 或材料正文。
 */

export const DEFAULT_MATERIALS_TIMEOUT_MS = 20_000

const MAX_ITEMS_PER_BLOCK = 5
const MAX_ITEM_TEXT_LENGTH = 300
const MAX_SOURCES_PER_ITEM = 3

/** 日志摘要上限：条数与单条长度都固定，日志里不出现任何动态内容 */
export const MAX_SUMMARY_NOTES = 8
export const MAX_NOTE_LENGTH = 60

const DRAFT_BLOCKS = [
  { key: 'goalCandidates', short: 'goal' },
  { key: 'outcomeCandidates', short: 'outcome' },
  { key: 'dataNotes', short: 'data' },
  { key: 'methodNotes', short: 'method' },
  { key: 'openQuestions', short: 'question' },
] as const

/** 兜底时的中文说明：说清模型没参与、材料已解析、用户可以先做什么 */
const NOTICE_BY_REASON: Record<AdvisorFallbackReason, string> = {
  MODEL_TIMEOUT: '模型调用超时，未生成理解草稿；材料已解析成功，可以先手动登记要点，稍后重新生成。',
  INVALID_MODEL_OUTPUT:
    '模型返回内容不合法，未生成理解草稿；材料已解析成功，可以先手动登记要点，稍后重新生成。',
  MODEL_UNAVAILABLE: '模型服务暂时不可用，未生成理解草稿；材料已解析成功，可以先手动登记要点，稍后重新生成。',
  MODEL_NOT_CONFIGURED: '服务端未配置模型密钥，暂时无法生成理解草稿；材料已解析成功，可以先手动登记要点。',
  RATE_LIMITED: '请求过于频繁，未生成理解草稿；材料已解析成功，请稍后重新生成。',
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空、trim、超长截断；为空或类型不对返回 null（调用方据此丢弃该条） */
function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

interface SourcesResult {
  sources: MaterialSourceRef[]
  /** 引用了本次请求中不存在的片段编号的次数（不保留原始编号） */
  unknownReferenceCount: number
  /** segmentIds 结构不合法（不是数组 / 含非字符串项） */
  hasShapeIssue: boolean
}

/**
 * 按 segmentId 回填来源：材料名、版本、行号一律取自本次请求的片段表。
 * 未知或在本次请求中不存在的引用只计数、不记录原文——模型输出不可信，
 * 原始编号可能夹带材料正文、密钥样式文本或超长内容。
 */
function buildSources(
  rawSegmentIds: unknown,
  segments: Map<string, UnderstandingSegmentInput>,
  input: MaterialsUnderstandingInput,
): SourcesResult {
  if (!Array.isArray(rawSegmentIds)) {
    return { sources: [], unknownReferenceCount: 0, hasShapeIssue: true }
  }

  const sources: MaterialSourceRef[] = []
  const seen = new Set<string>()
  let unknownReferenceCount = 0
  let hasShapeIssue = false

  for (const rawId of rawSegmentIds) {
    if (typeof rawId !== 'string') {
      hasShapeIssue = true
      continue
    }
    const segmentId = rawId.trim()
    if (segmentId === '' || seen.has(segmentId)) continue

    const segment = segments.get(segmentId)
    if (segment === undefined) {
      unknownReferenceCount += 1
      continue
    }

    seen.add(segmentId)
    sources.push({
      materialId: input.material.materialId,
      materialName: input.material.name,
      materialVersion: input.material.version,
      segmentId: segment.segmentId,
      startLine: segment.startLine,
      endLine: segment.endLine,
    })
    if (sources.length >= MAX_SOURCES_PER_ITEM) break
  }

  return { sources, unknownReferenceCount, hasShapeIssue }
}

/**
 * 输出清理的日志摘要：只保留类别与数量。
 * 不允许放入模型原始文本、原始 segmentId 或材料正文。
 */
export interface NormalizeDraftSummary {
  /** 引用了本次请求中不存在的片段编号的次数 */
  unknownSegmentReferenceCount: number
  /** 被丢弃的候选条目数（文本为空、无有效来源、超出每块上限等） */
  droppedItemCount: number
  /** 输出包含内部字段名或非中文文本 */
  unsafeOutput: boolean
  /** 清理后没有任何候选 */
  emptyOutput: boolean
  /** 结构性提示：固定短语，不含任何动态内容 */
  notes: string[]
}

export interface NormalizeDraftSuccess {
  ok: true
  draft: UnderstandingDraft
  summary: NormalizeDraftSummary
}

export interface NormalizeDraftFailure {
  ok: false
  summary: NormalizeDraftSummary
}

export type NormalizeDraftResult = NormalizeDraftSuccess | NormalizeDraftFailure

interface SummaryCollector {
  unknownSegmentReferenceCount: number
  droppedItemCount: number
  notes: string[]
}

/** 记录固定短语，受条数与单条长度限制 */
function pushNote(collector: SummaryCollector, note: string): void {
  if (collector.notes.length >= MAX_SUMMARY_NOTES) return
  collector.notes.push(note.slice(0, MAX_NOTE_LENGTH))
}

function toSummary(
  collector: SummaryCollector,
  extras: { unsafeOutput: boolean; emptyOutput: boolean },
): NormalizeDraftSummary {
  return {
    unknownSegmentReferenceCount: collector.unknownSegmentReferenceCount,
    droppedItemCount: collector.droppedItemCount,
    unsafeOutput: extras.unsafeOutput,
    emptyOutput: extras.emptyOutput,
    notes: collector.notes.slice(0, MAX_SUMMARY_NOTES),
  }
}

/**
 * 校验并清理模型（或兜底层）返回的理解草稿（契约 15.3）。
 * 能修就修（截断、剔除未知引用、限条数）；不能修的条目丢弃；全部为空或出现内部词判整份非法。
 * 返回值只带类别与数量的摘要，日志与响应都不会出现模型原始文本或原始引用编号。
 */
export function normalizeUnderstandingDraft(
  raw: unknown,
  input: MaterialsUnderstandingInput,
): NormalizeDraftResult {
  const collector: SummaryCollector = { unknownSegmentReferenceCount: 0, droppedItemCount: 0, notes: [] }

  const source = isPlainObject(raw) ? raw.draft : undefined
  if (!isPlainObject(source)) {
    pushNote(collector, 'draft 不是对象')
    return { ok: false, summary: toSummary(collector, { unsafeOutput: false, emptyOutput: true }) }
  }

  const segments = new Map(input.material.segments.map((segment) => [segment.segmentId, segment]))
  const draft = emptyUnderstandingDraft()
  let hasUnsafeText = false

  for (const block of DRAFT_BLOCKS) {
    const list = source[block.key]
    if (!Array.isArray(list)) {
      if (list !== undefined) pushNote(collector, `${block.key} 不是数组，按空数组处理`)
      continue
    }
    if (list.length > MAX_ITEMS_PER_BLOCK) {
      pushNote(collector, `${block.key} 超过每块上限，超出部分已丢弃`)
      collector.droppedItemCount += list.length - MAX_ITEMS_PER_BLOCK
    }

    const items: DraftItem[] = []
    list.slice(0, MAX_ITEMS_PER_BLOCK).forEach((item) => {
      if (!isPlainObject(item)) {
        collector.droppedItemCount += 1
        pushNote(collector, `${block.key} 含非对象条目，已丢弃`)
        return
      }

      const text = normalizeText(item.text, MAX_ITEM_TEXT_LENGTH)
      if (text === null) {
        collector.droppedItemCount += 1
        pushNote(collector, `${block.key} 含空文本条目，已丢弃`)
        return
      }
      if (!isHumanizedUserText(text)) {
        hasUnsafeText = true
        collector.droppedItemCount += 1
        pushNote(collector, `${block.key} 含不符合中文安全要求的条目`)
        return
      }

      const sourcesResult = buildSources(item.segmentIds, segments, input)
      collector.unknownSegmentReferenceCount += sourcesResult.unknownReferenceCount
      if (sourcesResult.hasShapeIssue) pushNote(collector, `${block.key} 的引用结构不合法`)

      if (sourcesResult.sources.length === 0) {
        collector.droppedItemCount += 1
        pushNote(collector, `${block.key} 含没有可用来源的条目，已丢弃`)
        return
      }

      items.push({ itemId: `cnd_${block.short}_${items.length}`, text, sources: sourcesResult.sources })
    })

    draft[block.key] = items
  }

  if (hasUnsafeText) {
    pushNote(collector, '输出包含内部字段名或非中文文本')
    return { ok: false, summary: toSummary(collector, { unsafeOutput: true, emptyOutput: false }) }
  }

  const total = DRAFT_BLOCKS.reduce((sum, block) => sum + draft[block.key].length, 0)
  if (total === 0) {
    pushNote(collector, '清理后没有任何候选')
    return { ok: false, summary: toSummary(collector, { unsafeOutput: false, emptyOutput: true }) }
  }

  return { ok: true, draft, summary: toSummary(collector, { unsafeOutput: false, emptyOutput: false }) }
}

/** 摘要里是否存在需要记日志的问题 */
export function hasSummaryIssues(summary: NormalizeDraftSummary): boolean {
  return (
    summary.unknownSegmentReferenceCount > 0 ||
    summary.droppedItemCount > 0 ||
    summary.unsafeOutput ||
    summary.emptyOutput ||
    summary.notes.length > 0
  )
}

/**
 * 只用于日志的明细：字段固定、条数与长度都有上限。
 * requestId 由调用方补；这里绝不包含模型原始文本、原始 segmentId 或材料正文。
 */
export function toLogDetail(summary: NormalizeDraftSummary): Record<string, unknown> {
  return {
    unknownSegmentReferenceCount: summary.unknownSegmentReferenceCount,
    droppedItemCount: summary.droppedItemCount,
    unsafeOutput: summary.unsafeOutput,
    emptyOutput: summary.emptyOutput,
    notes: summary.notes.slice(0, MAX_SUMMARY_NOTES),
  }
}

/* ---------------------------------------------------------------- 服务层 */

export interface MaterialsServiceOptions {
  provider: AdvisorProvider
  /** 单次 provider 调用超时；默认 20 秒（与契约 7.5 对齐） */
  timeoutMs?: number
  logger?: AdvisorLogger
}

export interface MaterialsService {
  readonly providerName: string
  readonly timeoutMs: number
  understand(input: MaterialsUnderstandingInput): Promise<MaterialsUnderstandingResult>
  /** V3 多材料理解：逐材料复用单材料流程，再合并五块草稿 */
  understandV3(input: MaterialsUnderstandingV3Input): Promise<MaterialsUnderstandingResult>
}

type ProviderOutcome = { ok: true; output: { draft: unknown } } | { ok: false; reason: AdvisorFallbackReason }

class ProviderTimeoutError extends Error {
  constructor() {
    super('provider 调用超时')
    this.name = 'ProviderTimeoutError'
  }
}

async function callUnderstandingProvider(
  generate: (input: UnderstandingProviderInput) => Promise<{ draft: unknown }>,
  input: MaterialsUnderstandingInput,
  timeoutMs: number,
): Promise<ProviderOutcome> {
  let timer: NodeJS.Timeout | undefined

  const providerInput: UnderstandingProviderInput = {
    materialName: input.material.name,
    materialType: input.material.type,
    materialVersion: input.material.version,
    projectName: input.projectName,
    segments: input.material.segments,
  }

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      const handle = setTimeout(() => reject(new ProviderTimeoutError()), timeoutMs)
      // 不让未触发的定时器把进程留住
      handle.unref()
      timer = handle
    })

    const output = await Promise.race([generate(providerInput), timeout])
    return { ok: true, output }
  } catch (error) {
    if (error instanceof ProviderTimeoutError) return { ok: false, reason: 'MODEL_TIMEOUT' }
    if (error instanceof AdvisorProviderError) return { ok: false, reason: error.reason }
    return { ok: false, reason: 'MODEL_UNAVAILABLE' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createMaterialsService(options: MaterialsServiceOptions): MaterialsService {
  const { provider } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_MATERIALS_TIMEOUT_MS
  const logger = options.logger ?? silentLogger

  function finalFailure(reason: MaterialRuntimeErrorCode): MaterialsUnderstandingResult {
    return {
      ok: false,
      code: reason,
      retryable: MATERIAL_RETRYABLE_BY_CODE[reason],
      retryAfterSeconds: null,
    }
  }

  /** 保守兜底：空草稿 + 中文说明；不摘录原文、不编造事实 */
  function runFallback(reason: AdvisorFallbackReason): MaterialsUnderstandingResult {
    try {
      return {
        ok: true,
        source: 'fallback',
        fallbackReason: reason,
        notice: NOTICE_BY_REASON[reason],
        draft: emptyUnderstandingDraft(),
      }
    } catch (error) {
      logger.warn('材料理解兜底自身失败', {
        reason,
        detail: error instanceof Error ? error.message : 'unknown',
      })
      return finalFailure(reason)
    }
  }

  async function understandOne(
    input: MaterialsUnderstandingInput,
  ): Promise<MaterialsUnderstandingResult> {
    const generate = provider.generateUnderstanding
    const outcome =
      generate === undefined
        ? { ok: false as const, reason: 'MODEL_UNAVAILABLE' as const }
        : await callUnderstandingProvider(generate.bind(provider), input, timeoutMs)

    if (!outcome.ok) {
      logger.warn('材料理解模型调用失败，使用安全兜底', {
        requestId: input.requestId,
        reason: outcome.reason,
        provider: provider.name,
      })
      return runFallback(outcome.reason)
    }

    const normalized = normalizeUnderstandingDraft(outcome.output, input)
    if (hasSummaryIssues(normalized.summary)) {
      // 日志只带类别与数量：模型输出不可信，原始文本与原始编号都不落日志
      logger.warn('材料理解输出被清理', {
        requestId: input.requestId,
        ...toLogDetail(normalized.summary),
      })
    }

    if (!normalized.ok) {
      logger.warn('材料理解输出不合法，使用安全兜底', { requestId: input.requestId })
      return runFallback('INVALID_MODEL_OUTPUT')
    }

    return {
      ok: true,
      source: 'model',
      fallbackReason: null,
      notice: null,
      draft: normalized.draft,
    }
  }

  return {
    providerName: provider.name,
    timeoutMs,
    understand: understandOne,

    async understandV3(input: MaterialsUnderstandingV3Input): Promise<MaterialsUnderstandingResult> {
      if (input.materials.length === 0) {
        return runFallback('MODEL_UNAVAILABLE')
      }

      const merged = emptyUnderstandingDraft()
      for (const material of input.materials) {
        const result = await understandOne({
          requestId: input.requestId,
          projectId: input.projectId,
          projectRevision: input.projectRevision,
          projectName: input.projectName,
          promptVersion: input.promptVersion,
          material,
        })
        if (!result.ok) return result
        if (result.source === 'fallback') return result

        for (const block of DRAFT_BLOCKS) {
          merged[block.key].push(...result.draft[block.key])
        }
      }

      // itemId 只在本次响应内唯一；合并多材料后按块重新编号
      for (const block of DRAFT_BLOCKS) {
        merged[block.key] = merged[block.key].map((item, index) => ({
          ...item,
          itemId: `cnd_${block.short}_${index}`,
        }))
      }

      return {
        ok: true,
        source: 'model',
        fallbackReason: null,
        notice: null,
        draft: merged,
      }
    },
  }
}
