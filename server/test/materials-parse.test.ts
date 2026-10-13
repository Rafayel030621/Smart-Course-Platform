import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SEGMENT_CHARS, parseText } from '../src/materials/parseText.js'

/**
 * 文本分段的单元测试（契约 14.4）
 * ----------------------------------------------------------------------------
 * 只验证确定性与行号来源：相同输入必须得到完全一致的分段，任何一段不超过 2,000 字。
 */

describe('文本分段', () => {
  test('小文本的相邻段落合并为一段，行号覆盖原文范围', () => {
    const segments = parseText('第一行\n第二行\n\n第三行')
    assert.equal(segments.length, 1)
    // 原文第 3 行是空行（段落分隔），第三段内容从第 4 行开始
    assert.deepEqual(
      {
        segmentId: segments[0].segmentId,
        index: segments[0].index,
        startLine: segments[0].startLine,
        endLine: segments[0].endLine,
      },
      { segmentId: 'seg_0', index: 0, startLine: 1, endLine: 4 },
    )
    assert.equal(segments[0].text, '第一行\n第二行\n第三行')
  })

  test('相邻段落合并后会超过 2,000 字时分开成两段', () => {
    const first = '甲'.repeat(1000)
    const second = '乙'.repeat(1001)
    const segments = parseText(`${first}\n\n${second}`)

    assert.equal(segments.length, 2)
    assert.equal(segments[0].startLine, 1)
    assert.equal(segments[0].endLine, 1)
    assert.equal(segments[0].text.length, 1000)
    assert.equal(segments[1].startLine, 3)
    assert.equal(segments[1].endLine, 3)
    assert.equal(segments[1].text.length, 1001)
  })

  test('单行超过 2,000 字时按 2,000 字切分，行号都指向该行', () => {
    const segments = parseText('x'.repeat(4500))

    assert.equal(segments.length, 3)
    assert.deepEqual(
      segments.map((segment) => segment.text.length),
      [2000, 2000, 500],
    )
    for (const segment of segments) {
      assert.equal(segment.startLine, 1)
      assert.equal(segment.endLine, 1)
    }
  })

  test('多行超长自然段按行累积切分，行号连续', () => {
    const line = 'y'.repeat(1500)
    const segments = parseText(`${line}\n${line}\n${line}`)

    // 每行 1,500 字，两行合并会超过 2,000 字，因此每段一行
    assert.equal(segments.length, 3)
    assert.deepEqual(
      segments.map((segment) => segment.startLine),
      [1, 2, 3],
    )
    assert.deepEqual(
      segments.map((segment) => segment.endLine),
      [1, 2, 3],
    )
  })

  test('CRLF 与 CR 统一按一个换行处理，行号保持一致', () => {
    const segments = parseText('a\r\nb\r\n\r\nc')
    assert.equal(segments.length, 1)
    assert.equal(segments[0].startLine, 1)
    assert.equal(segments[0].endLine, 4)
    assert.equal(segments[0].text, 'a\nb\nc')
  })

  test('仅含空白字符的行也视为段落分隔', () => {
    const segments = parseText('a\n \t\nb')
    assert.equal(segments.length, 1)
    assert.equal(segments[0].startLine, 1)
    assert.equal(segments[0].endLine, 3)
    assert.equal(segments[0].text, 'a\nb')
  })

  test('同一输入两次解析结果完全一致', () => {
    const text = ['# 标题', '第一段', '', '第二段', '继续', '', 'x'.repeat(2500)].join('\n')
    assert.deepEqual(parseText(text), parseText(text))
  })

  test('结尾换行不影响分段结果', () => {
    assert.deepEqual(parseText('# 标题\n内容'), parseText('# 标题\n内容\n'))
  })

  test('大文本的分段数量有界且每段不超过 2,000 字', () => {
    const segments = parseText('x'.repeat(300_000))
    assert.equal(segments.length, 150)
    for (const segment of segments) {
      assert.ok(segment.text.length > 0 && segment.text.length <= MAX_SEGMENT_CHARS)
    }
    assert.deepEqual(segments.map((segment) => segment.segmentId).slice(0, 3), ['seg_0', 'seg_1', 'seg_2'])
  })
})
