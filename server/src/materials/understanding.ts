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
 * 两条硬约束（契约 12.2 / 用户决定 5）：
 *   1. 兜底不摘录、不编造材料事实，只返回空草稿与中文说明；
 *   2. 模型只允许给 text 与 segmentIds 引用，材料名、版本、行号一律由服务端回填。
 */

export const DEFAULT_MATERIALS_TIMEOUT_MS = 20_000

const MAX_ITEMS_PER_BLOCK = 5
const MAX_ITEM_TEXT_LENGTH = 300
const MAX_SOURCES_PER_ITEM = 3

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

/** 按 segmentId 回填来源；未知 ID 剔除，去重，最多 3 条 */
function buildSources(
  rawSegmentIds: unknown,
  segments: Map<string, UnderstandingSegmentInput>,
  input: MaterialsUnderstandingInput,
  label: string,
  notes: string[],
): MaterialSourceRef[] {
  if (!Array.isArray(rawSegmentIds)) {
    notes.push(`${label} 不是数组`)
    return []
  }

  const sources: MaterialSourceRef[] = []
  const seen = new Set<string>()

  for (const rawId of rawSegmentIds) {
    if (typeof rawId !== 'string') {
      notes.push(`${label} 含非字符串项，已忽略`)
      continue
    }
    const segmentId = rawId.trim()
    if (segmentId === '' || seen.has(segmentId)) continue

    const segment = segments.get(segmentId)
    if (segment === undefined) {
      notes.push(`${label} 引用了本次请求中不存在的片段：${segmentId}`)
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

  return sources
}

export interface NormalizeDraftSuccess {
  ok: true
  draft: UnderstandingDraft
  notes: string[]
}

export interface NormalizeDraftFailure {
  ok: false
  notes: string[]
}

export type NormalizeDraftResult = NormalizeDraftSuccess | NormalizeDraftFailure

/**
 * 校验并清理模型（或兜底层）返回的理解草稿（契约 15.3）。
 * 能修就修（截断、剔除未知引用、限条数）；不能修的条目丢弃；全部为空或出现内部词判整份非法。
 */
export function normalizeUnderstandingDraft(
  raw: unknown,
  input: MaterialsUnderstandingInput,
): NormalizeDraftResult {
  const notes: string[] = []

  const source = isPlainObject(raw) ? raw.draft : undefined
  if (!isPlainObject(source)) {
    notes.push('draft 不是对象')
    return { ok: false, notes }
  }

  const segments = new Map(input.material.segments.map((segment) => [segment.segmentId, segment]))
  const draft = emptyUnderstandingDraft()
  let hasUnsafeText = false

  for (const block of DRAFT_BLOCKS) {
    const list = source[block.key]
    if (!Array.isArray(list)) {
      if (list !== undefined) notes.push(`${block.key} 不是数组，按空数组处理`)
      continue
    }
    if (list.length > MAX_ITEMS_PER_BLOCK) {
      notes.push(`${block.key} 超过 ${MAX_ITEMS_PER_BLOCK} 条，超出部分已丢弃`)
    }

    const items: DraftItem[] = []
    list.slice(0, MAX_ITEMS_PER_BLOCK).forEach((item, index) => {
      const label = `${block.key}[${index}]`
      if (!isPlainObject(item)) {
        notes.push(`${label} 不是对象，已丢弃`)
        return
      }

      const text = normalizeText(item.text, MAX_ITEM_TEXT_LENGTH)
      if (text === null) {
        notes.push(`${label} 的 text 为空，已丢弃`)
        return
      }
      if (!isHumanizedUserText(text)) {
        hasUnsafeText = true
        notes.push(`${label} 的 text 不符合中文安全要求`)
        return
      }

      const sources = buildSources(item.segmentIds, segments, input, `${label}.segmentIds`, notes)
      if (sources.length === 0) {
        notes.push(`${label} 没有可用的来源，已丢弃`)
        return
      }

      items.push({ itemId: `cnd_${block.short}_${items.length}`, text, sources })
    })

    draft[block.key] = items
  }

  if (hasUnsafeText) {
    notes.push('输出包含内部字段名或非中文文本')
    return { ok: false, notes }
  }

  const total = DRAFT_BLOCKS.reduce((sum, block) => sum + draft[block.key].length, 0)
  if (total === 0) {
    notes.push('清理后没有任何候选')
    return { ok: false, notes }
  }

  return { ok: true, draft, notes }
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

  return {
    providerName: provider.name,
    timeoutMs,

    async understand(input: MaterialsUnderstandingInput): Promise<MaterialsUnderstandingResult> {
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
      if (normalized.notes.length > 0) {
        logger.warn('材料理解输出被清理', { requestId: input.requestId, notes: normalized.notes })
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
    },
  }
}
