import { describe, expect, it } from 'vitest'
import { COUNTEREXAMPLES, COUNTEREXAMPLE_REQUESTS } from '../fixtures/ai/modelOutputs'
import { normalizeSuggestions, parseAdvisorRequest } from '../../server/src/advisor/validation'
import type { AdvisorRequest } from '../../server/src/advisor/types'

/**
 * 模型输出反例的**可执行验收**（owner：吴佳璐）
 * ----------------------------------------------------------------------------
 * `docs/ai/prompt-spec.md` §7 的 R1–R12 是一份纸面清单。本文件把它变成断言：
 * 把每条反例的原始文本喂给**服务端的真实校验层** `normalizeSuggestions`，
 * 核对 `docs/ai/prompt-spec.md` §5.2 承诺的补救行为确实发生了。
 *
 * 为什么这里可以跨目录 import `server/`：
 *   契约 §5.1 规定服务端不得导入 `src/`，反向没有限制；而「非法输出与引用越界的
 *   反例样例」这条交付物（契约 §1.3）如果不跑真实实现，就只是一份随时会和代码漂移的文档。
 *   本文件只读导入，不修改服务端任何文件。
 *
 * 两条耦合约定（改了要一起改）：
 *   - 哪天服务端补上 D1（已完成任务不得换皮重提），R10 就不再是 `slips-through`，
 *     fixture 与本文件都要同步；
 *   - `slips-through` 断言的是「校验层**一定放行**」。它变红不代表有 bug，
 *     而是说明校验层变了，人工评估的覆盖范围需要重新评估。
 */

/** `[编号, 名称, 反例]`：让 it.each 的用例标题可读 */
const counterexampleCases = COUNTEREXAMPLES.map((item) => [item.id, item.title, item] as const)

/** 取反例对应的、通过校验后的请求（服务端各层的共同输入） */
function advisorRequestOf(key: keyof typeof COUNTEREXAMPLE_REQUESTS): AdvisorRequest {
  const parsed = parseAdvisorRequest(COUNTEREXAMPLE_REQUESTS[key])
  if (!parsed.ok) {
    throw new Error(`反例基准请求 ${String(key)} 不合法：${parsed.issues.join(' / ')}`)
  }
  return parsed.value
}

describe('反例的原始文本形态', () => {
  it.each(counterexampleCases)('%s %s：raw 的可解析性与预期一致', (_id, _title, item) => {
    if (item.expected.kind === 'invalid-json') {
      expect(() => JSON.parse(item.raw) as unknown).toThrow()
      return
    }
    expect(() => JSON.parse(item.raw) as unknown).not.toThrow()
  })
})

describe('服务端校验层的实际处理', () => {
  it.each(counterexampleCases)('%s %s', (_id, _title, item) => {
    const expected = item.expected
    if (expected.kind === 'invalid-json') return

    const request = advisorRequestOf(item.requestKey)
    const result = normalizeSuggestions(JSON.parse(item.raw) as unknown, request)

    // ① 整份判非法 → 服务端规则兜底
    if (expected.kind === 'invalid-output') {
      expect(result.ok, `${item.id} 期望整份判非法，实际却通过了校验`).toBe(false)
      expect(result.notes.length, `${item.id} 应该留下可排查的日志`).toBeGreaterThan(0)
      return
    }

    // ② 校验通过：normalized 与 slips-through 都走这里
    if (!result.ok) {
      throw new Error(`${item.id} 期望校验通过，实际失败：${result.notes.join(' / ')}`)
    }

    expect(result.suggestions.length).toBeGreaterThanOrEqual(1)
    expect(result.suggestions.length).toBeLessThanOrEqual(3)

    // 逐条核对：只保留期望为 kept 的那些，顺序不变（实现按原顺序重建）
    const kept = expected.perSuggestion.filter((outcome) => outcome.outcome === 'kept')
    expect(result.suggestions).toHaveLength(kept.length)

    kept.forEach((outcome, index) => {
      const suggestion = result.suggestions[index]
      expect(suggestion, `${item.id} 缺少第 ${index + 1} 条保留建议`).toBeDefined()
      expect(suggestion?.existingTaskId).toBe(outcome.existingTaskId)
      expect(suggestion?.basisEvidenceIds).toEqual(outcome.basisEvidenceIds)
      expect(suggestion?.basisDoubtIds).toEqual(outcome.basisDoubtIds)
    })

    if (expected.kind === 'normalized') {
      if (expected.expectNotes) {
        expect(result.notes.length, `${item.id} 期望留下日志`).toBeGreaterThan(0)
      } else {
        expect(result.notes, `${item.id} 期望不产生日志`).toHaveLength(0)
      }
      return
    }

    // slips-through：校验层完全放行，连一条日志都没有 —— 这正是它必须进人工评估的原因
    expect(
      result.notes,
      `${item.id} 期望「校验层完全放行」，实际留下了日志：${result.notes.join(' / ')}`,
    ).toHaveLength(0)
    expect(expected.reason.length).toBeGreaterThan(0)
  })
})

describe('清理结果的不变量', () => {
  it.each(counterexampleCases)('%s %s：引用 ID 一定落在本次请求范围内', (_id, _title, item) => {
    const expected = item.expected
    if (expected.kind === 'invalid-json' || expected.kind === 'invalid-output') return

    const request = advisorRequestOf(item.requestKey)
    const result = normalizeSuggestions(JSON.parse(item.raw) as unknown, request)
    if (!result.ok) return

    const taskIds = new Set(request.tasks.map((task) => task.taskId))
    const evidenceIds = new Set(request.evidence.map((evidence) => evidence.evidenceId))
    const doubtIds = new Set(request.doubts.map((doubt) => doubt.doubtId))

    for (const suggestion of result.suggestions) {
      if (suggestion.existingTaskId !== null) {
        expect(taskIds.has(suggestion.existingTaskId)).toBe(true)
      }
      for (const id of suggestion.basisEvidenceIds) {
        expect(evidenceIds.has(id)).toBe(true)
      }
      for (const id of suggestion.basisDoubtIds) {
        expect(doubtIds.has(id)).toBe(true)
      }
    }
  })

  it('任何清理结果里都不会出现已完成任务（C5 的前一半）', () => {
    const request = advisorRequestOf('base')
    const doneIds = new Set(
      request.tasks.filter((task) => task.status === 'done').map((task) => task.taskId),
    )
    expect(doneIds.size, '基准请求里必须有已完成任务，否则这条断言没有意义').toBeGreaterThan(0)

    for (const item of COUNTEREXAMPLES) {
      if (item.expected.kind === 'invalid-json') continue
      const result = normalizeSuggestions(JSON.parse(item.raw) as unknown, request)
      if (!result.ok) continue
      for (const suggestion of result.suggestions) {
        if (suggestion.existingTaskId === null) continue
        expect(
          doneIds.has(suggestion.existingTaskId),
          `${item.id} 的建议引用了已完成任务 ${suggestion.existingTaskId}`,
        ).toBe(false)
      }
    }
  })
})
