import { describe, expect, it } from 'vitest'
import { TEMPLATES, TOPICS } from '@/data/topics'
import { AI_SCENARIOS } from '../fixtures/ai/scenarios'
import { COUNTEREXAMPLES, COUNTEREXAMPLE_REQUESTS, INJECTION_MARKERS } from '../fixtures/ai/modelOutputs'
import { parseAdvisorRequest } from '../../server/src/advisor/validation'

/**
 * AI 样例集自洽性测试（owner：吴佳璐）
 * ----------------------------------------------------------------------------
 * `tests/fixtures/ai/**` 是一份**内容资产**：它会被人工评估直接当输入用，
 * 也会被 `tests/content/aiCounterexamples.test.ts` 喂给服务端校验层。
 * 一旦样例本身不自洽（引用了不存在的 ID、场景与题目模板对不上），
 * 人工评估的结论就是错的，而且很难发现。
 *
 * 这里做四类检查：
 *   1. 每个场景 / 反例基准请求都能通过**服务端真实校验层**（`parseAdvisorRequest`）——
 *      用真实实现校验样例，就不需要在本文件里再抄一份字段上限（契约不允许第二套 DTO）；
 *   2. 场景与 `src/data/topics.ts` 的交叉一致性（任务确实来自该题目的模板）；
 *   3. 场景期望集的完备性（任务被划分成「可认领」与「永不出现」两类，且不重叠不遗漏）；
 *   4. 反例集的结构完整性（每条都有期望处理与说明，下标对得上）。
 */

/* ------------------------------------------------- 1. 样例本身符合契约 */

describe('样例请求能通过服务端校验层', () => {
  it.each(AI_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    '%s 的请求合法',
    (_id, scenario) => {
      const result = parseAdvisorRequest(scenario.request)
      if (!result.ok) {
        throw new Error(`场景 ${scenario.id} 不符合契约：${result.issues.join(' / ')}`)
      }
      expect(result.ok).toBe(true)
    },
  )

  it.each(Object.entries(COUNTEREXAMPLE_REQUESTS))('反例基准请求 %s 合法', (_key, request) => {
    const result = parseAdvisorRequest(request)
    if (!result.ok) {
      throw new Error(`反例基准请求 ${_key} 不符合契约：${result.issues.join(' / ')}`)
    }
    expect(result.ok).toBe(true)
  })
})

/* --------------------------------------------- 2. 场景与题目模板的一致性 */

describe('场景与题目模板一致', () => {
  it.each(AI_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    '%s 的题目、任务、里程碑都来自该题目的模板',
    (_id, scenario) => {
      if (scenario.topicKey === null) {
        // 自定义题目：只需断言它确实不在 9 套模板里
        expect(TOPICS).not.toContain(scenario.request.projectName)
        return
      }

      expect(TOPICS).toContain(scenario.topicKey)
      // 题目名即项目名（创建项目时就是这么来的）
      expect(scenario.request.projectName).toBe(scenario.topicKey)

      const template = TEMPLATES[scenario.topicKey]
      const milestoneNames = template.ms.map((milestone) => milestone.t)

      // 当前里程碑必须是模板里的五个里程碑之一
      expect(milestoneNames).toContain(scenario.request.currentMilestone)

      // 创建项目时 steps → tasks 按下标一一对应，场景样例必须沿用这个映射，
      // 否则人工评估看到的任务就未必是学生真会遇到的那一版。
      // 例外：S5（无材料）故意留空，用来测信息量最少时的表现。
      if (scenario.request.tasks.length > 0) {
        expect(scenario.request.tasks).toHaveLength(template.steps.length)
      } else {
        expect(scenario.id, '只有 S5 允许没有任务').toBe('S5')
      }
      scenario.request.tasks.forEach((task, index) => {
        const step = template.steps[index]
        expect(step, `模板 ${scenario.topicKey} 缺少第 ${index + 1} 条建议`).toBeDefined()
        expect(task.title).toBe(step?.t)
        expect(task.doneCriteria).toBe(step?.done)
        expect(milestoneNames).toContain(task.milestone)
      })
    },
  )
})

/* --------------------------------------------------- 3. 场景期望的完备性 */

describe('场景期望集完备', () => {
  it.each(AI_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    '%s 的疑问都是 open、任务被完整划分、引用的 ID 都存在',
    (_id, scenario) => {
      const { request, expectations } = scenario

      // 契约 §4.1：只发 status === 'open' 的疑问
      for (const doubt of request.doubts) {
        expect(doubt.status).toBe('open')
      }

      const taskIds = request.tasks.map((task) => task.taskId)
      const claimable = new Set(expectations.claimableTaskIds)
      const never = new Set(expectations.neverSugggestedTaskIds)

      // 两类必须互斥
      for (const id of claimable) {
        expect(never.has(id), `${scenario.id}：${id} 同时出现在两类里`).toBe(false)
      }

      // 两类必须覆盖全部任务（不重不漏），并检查状态与分类相符
      for (const task of request.tasks) {
        const isClaimable = claimable.has(task.taskId)
        const isNever = never.has(task.taskId)
        expect(isClaimable || isNever, `${scenario.id}：任务 ${task.taskId} 没有被分类`).toBe(true)
        if (isNever) {
          expect(task.status, `${scenario.id}：被标为「永不出现」的任务 ${task.taskId} 应当是 done`).toBe(
            'done',
          )
        }
        if (isClaimable) {
          expect(task.status, `${scenario.id}：可认领的任务 ${task.taskId} 不应是 done`).not.toBe('done')
        }
      }

      // 期望分两类里的 ID 必须真实存在（防止改样例时改漏）
      for (const id of [...claimable, ...never]) {
        expect(taskIds, `${scenario.id}：${id} 不在任务列表里`).toContain(id)
      }

      const doubtIds = request.doubts.map((doubt) => doubt.doubtId)
      for (const id of expectations.openDoubtIds) {
        expect(doubtIds, `${scenario.id}：${id} 不在疑问列表里`).toContain(id)
      }

      // 依据 ID 必须落在本次请求范围内（契约 §4.1）
      const evidenceIds = request.evidence.map((item) => item.evidenceId)
      for (const doubt of request.doubts) {
        if (doubt.sourceEvidenceId === null) continue
        expect(evidenceIds, `${scenario.id}：疑问 ${doubt.doubtId} 的来源证据不在请求里`).toContain(
          doubt.sourceEvidenceId,
        )
      }

      // 领域锚点至少要有一条，否则这条场景没法做 C9 的评分
      expect(expectations.domainAnchors.length).toBeGreaterThan(0)
      expect(expectations.minDomainHits).toBeGreaterThanOrEqual(1)
      expect(expectations.minDomainHits).toBeLessThanOrEqual(expectations.domainAnchors.length)
    },
  )

  it('覆盖了 prompt-spec §3.5 要求的 6 类场景', () => {
    expect(AI_SCENARIOS.map((scenario) => scenario.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6'])
  })

  it('至少有三个场景里带已完成任务（否则「已完成不得再推荐」无从检验）', () => {
    const withDone = AI_SCENARIOS.filter((scenario) =>
      scenario.request.tasks.some((task) => task.status === 'done'),
    )
    expect(withDone.length).toBeGreaterThanOrEqual(3)
  })
})

/* ------------------------------------------------- 4. 注入样例是合法请求 */

describe('提示词注入样例', () => {
  it('注入文本确实在请求里，且请求本身合法', () => {
    const request = COUNTEREXAMPLE_REQUESTS.injection
    const flatten = JSON.stringify(request)
    for (const marker of INJECTION_MARKERS) {
      expect(flatten, `注入标记「${marker}」不在请求里`).toContain(marker)
    }
    expect(parseAdvisorRequest(request).ok).toBe(true)
  })

  it('注入只出现在证据文本里，不污染结构化字段', () => {
    const { injection } = COUNTEREXAMPLE_REQUESTS
    for (const evidence of injection.evidence) {
      // 结构化字段不能被注入文本带跑
      expect(evidence.evidenceId).toMatch(/^evd_[A-Za-z0-9_]+$/)
      expect(evidence.submissionId).toMatch(/^[0-9a-f-]{36}$/)
    }
    expect(injection.promptVersion).toBe('mvp-prompt-v1')
  })
})

/* ------------------------------------------------------ 5. 反例集结构完整 */

describe('反例集结构完整', () => {
  it('编号齐全：R1–R12 与补充 E1–E3', () => {
    expect(COUNTEREXAMPLES.map((item) => item.id)).toEqual([
      'R1',
      'R2',
      'R3a',
      'R3b',
      'R4',
      'R5',
      'R6',
      'R7',
      'R8',
      'R9',
      'R10',
      'R11',
      'R12',
      'E1',
      'E2',
      'E3',
    ])
  })

  it.each(COUNTEREXAMPLES.map((item) => [item.id, item] as const))(
    '%s 字段齐全且有明确期望',
    (_id, item) => {
      expect(item.title.trim().length).toBeGreaterThan(0)
      expect(item.violates.trim().length).toBeGreaterThan(0)
      expect(item.note.trim().length).toBeGreaterThan(0)
      expect(item.raw.length).toBeGreaterThan(0)
      expect(Object.keys(COUNTEREXAMPLE_REQUESTS)).toContain(item.requestKey)
    },
  )

  it.each(
    COUNTEREXAMPLES.filter(
      (item) => item.expected.kind === 'normalized' || item.expected.kind === 'slips-through',
    ).map((item) => [item.id, item] as const),
  )('%s 的逐条期望与 raw 里的建议条数一致', (_id, item) => {
    const expected = item.expected
    if (expected.kind !== 'normalized' && expected.kind !== 'slips-through') return

    const parsed = JSON.parse(item.raw) as { suggestions: unknown[] }
    expect(expected.perSuggestion.length).toBe(parsed.suggestions.length)

    // 「保留」的期望必须写清 existingTaskId，否则断言会变成空转
    for (const outcome of expected.perSuggestion) {
      if (outcome.outcome !== 'kept') continue
      expect(outcome.existingTaskId, `${item.id}：kept 的期望缺少 existingTaskId`).toBeDefined()
      expect(outcome.basisEvidenceIds).toBeDefined()
      expect(outcome.basisDoubtIds).toBeDefined()
    }
  })
})
