import type { AdvisorLogger, BasisMaterialRef, ConfirmedMaterial } from './types.js'

/** 模型回答末尾引用 JSON 的最大条数（契约 23.7：citations 0～5 条） */
const MAX_CHAT_CITATIONS = 5

export interface ParsedChatAnswer {
  answer: string
  segmentIds: string[]
}

/**
 * 拆分「自然语言回答 + 末尾引用 JSON」。
 *
 * 解析失败不报错、不影响 answer：只把无法解析的末尾引用当作没有引用。
 * 回答正文里若没有引用 JSON，则原样返回。
 */
export function parseChatAnswer(raw: string): ParsedChatAnswer {
  const markerPattern = /\{\s*"segmentIds"\s*:/g
  let markerIndex = -1
  for (const match of raw.matchAll(markerPattern)) {
    markerIndex = match.index ?? -1
  }
  if (markerIndex < 0) return { answer: raw, segmentIds: [] }

  const answer = raw.slice(0, markerIndex).trim()
  const citationText = raw.slice(markerIndex).trim()
  const segmentIds: string[] = []
  try {
    const parsed: unknown = JSON.parse(citationText)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const values = (parsed as Record<string, unknown>).segmentIds
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value !== 'string') continue
          const segmentId = value.trim()
          if (segmentId !== '') segmentIds.push(segmentId)
          if (segmentIds.length >= MAX_CHAT_CITATIONS) break
        }
      }
    }
  } catch {
    // 引用 JSON 不合法时视为无引用；answer 仍然保留
  }

  // marker 之前没有正文时不能把整段丢掉，交给上层按空回答处理
  return { answer: answer === '' ? raw : answer, segmentIds }
}

/**
 * 用门禁后的权威材料回填引用。
 *
 * `materials` 必须来自 materialGate 的已确认材料（而非客户端自报名称/行号）；
 * 未知、未确认或不属于当前材料版本的引用逐条剔除并记录 warn。
 */
export function buildChatCitations(
  materials: ConfirmedMaterial[],
  segmentIds: string[],
  logger: AdvisorLogger,
  requestId: string,
): BasisMaterialRef[] {
  const available = new Map<string, BasisMaterialRef>()
  materials.forEach((material, materialIndex) => {
    for (const segment of material.segments) {
      available.set(`m${materialIndex + 1}:${segment.segmentId}`, {
        materialId: material.materialId,
        materialName: material.name,
        materialVersion: material.version,
        segmentId: segment.segmentId,
        startLine: segment.startLine,
        endLine: segment.endLine,
        itemId: null,
      })
    }
  })

  const citations: BasisMaterialRef[] = []
  const seen = new Set<string>()
  for (const reference of segmentIds) {
    const citation = available.get(reference)
    if (citation === undefined) {
      logger.warn('聊天引用未知或未确认，已剔除', { requestId, reference })
      continue
    }
    if (seen.has(reference)) continue
    seen.add(reference)
    citations.push(citation)
    if (citations.length >= MAX_CHAT_CITATIONS) break
  }
  return citations
}
