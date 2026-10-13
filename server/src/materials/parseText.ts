import type { MaterialSegment } from './types.js'

/**
 * 文本分段（契约 14.4）
 * ----------------------------------------------------------------------------
 * 规则必须确定性：相同输入与相同版本得到完全一致的分段结果。
 *   1. 统一换行后按行切分（\r\n、\r 视为 \n）；
 *   2. 连续非空行构成自然段，空行是段落分隔；
 *   3. 相邻自然段合并到 2,000 字以内；单个自然段本身超长时按 2,000 字切分；
 *   4. 每段记录 startLine / endLine（1 起始、包含两端），同一行内切分时两段都指向该行；
 *   5. 分段正文保留原始字符，只做换行归一；行号不受影响。
 *
 * 本文件只做分段，不读写文件、不记日志、不抛业务错误。
 */

export const MAX_SEGMENT_CHARS = 2000

interface Block {
  text: string
  startLine: number
  endLine: number
}

/** 把一个自然段（连续非空行）切成不超过 2,000 字的块；超长单行按 2,000 字切开 */
function splitParagraph(lines: string[], paragraphStartLine: number): Block[] {
  const blocks: Block[] = []
  let pendingLines: string[] = []
  let pendingStartLine = paragraphStartLine
  let pendingLength = 0

  const flush = (): void => {
    if (pendingLines.length === 0) return
    blocks.push({
      text: pendingLines.join('\n'),
      startLine: pendingStartLine,
      endLine: pendingStartLine + pendingLines.length - 1,
    })
    pendingLines = []
    pendingLength = 0
  }

  lines.forEach((line, offset) => {
    const lineNumber = paragraphStartLine + offset

    if (line.length > MAX_SEGMENT_CHARS) {
      flush()
      for (let start = 0; start < line.length; start += MAX_SEGMENT_CHARS) {
        blocks.push({
          text: line.slice(start, start + MAX_SEGMENT_CHARS),
          startLine: lineNumber,
          endLine: lineNumber,
        })
      }
      return
    }

    const nextLength = pendingLines.length === 0 ? line.length : pendingLength + 1 + line.length
    if (pendingLines.length > 0 && nextLength > MAX_SEGMENT_CHARS) flush()
    if (pendingLines.length === 0) pendingStartLine = lineNumber
    pendingLines.push(line)
    pendingLength = pendingLines.length === 1 ? line.length : pendingLength + 1 + line.length
  })

  flush()
  return blocks
}

/** 相邻块合并：直到再加入下一块会超过 2,000 字（契约 14.4 规则 3） */
function mergeBlocks(blocks: Block[]): Block[] {
  const merged: Block[] = []

  for (const block of blocks) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.text.length + 1 + block.text.length <= MAX_SEGMENT_CHARS) {
      merged[merged.length - 1] = {
        text: `${last.text}\n${block.text}`,
        startLine: last.startLine,
        endLine: block.endLine,
      }
    } else {
      merged.push({ ...block })
    }
  }

  return merged
}

export function parseText(text: string): MaterialSegment[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []

  let paragraphLines: string[] = []
  let paragraphStartLine = 1

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return
    blocks.push(...splitParagraph(paragraphLines, paragraphStartLine))
    paragraphLines = []
  }

  lines.forEach((line, offset) => {
    const lineNumber = offset + 1
    if (line.trim() === '') {
      // 空行（仅含空白字符）结束当前自然段
      flushParagraph()
      return
    }
    if (paragraphLines.length === 0) paragraphStartLine = lineNumber
    paragraphLines.push(line)
  })
  flushParagraph()

  return mergeBlocks(blocks).map((block, index) => ({
    segmentId: `seg_${index}`,
    index,
    startLine: block.startLine,
    endLine: block.endLine,
    text: block.text,
  }))
}
