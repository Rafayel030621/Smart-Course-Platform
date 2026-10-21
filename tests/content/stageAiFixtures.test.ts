import { describe, expect, it } from 'vitest'
import type {
  AdvisorChatRequest,
  AdvisorRecommendationsRequest,
  ConfirmedMaterial,
  MilestoneContext,
} from '@/domain/recommendation'
import {
  CANDIDATE_PROMPT_VERSION,
  STAGE_CANDIDATE_EXAMPLE,
  STAGE_CANDIDATE_REQUEST,
  STAGE_CONTRACT_VERSION,
  STAGE_COUNTEREXAMPLES,
  STAGE_INTERNAL_WORDS,
  STAGE_PROMPT_VERSION_MATRIX,
  STAGE_SCENARIOS,
  type MilestoneCandidateRequest,
  type StageScenario,
} from '../fixtures/ai/stageScenarios'

/**
 * V3 阶段化 AI 样例集自洽性测试（owner：吴佳璐）
 * ----------------------------------------------------------------------------
 * `tests/fixtures/ai/stageScenarios.ts` 是**内容资产**：人工评估直接拿它当输入。
 * 样例一旦不自洽（版本配错、上下文形态不对、把未确认材料塞进请求），
 * 评估结论就是错的，而且很难发现。
 *
 * 这里查七类（都只查"样例自身"，不评判模型答得好不好）：
 *   1. 九个必备场景齐全、编号唯一、结构完整；
 *   2. `promptVersion` 与 `milestoneContext` 的配对符合契约 §23.4；
 *   3. `milestoneContext` 的不变式（空上下文、排序、条数、字段一致性）；
 *   4. 未确认材料没有泄漏进请求；
 *   5. 各字段上限（项目名、阶段名、材料、问题、历史）；
 *   6. 阶段候选样例与请求的结构、数量、来源回填一致性；
 *   7. 反例集与内部词清单的完整性。
 *
 * **不做的事**：不校验"模型输出是否正确"（那要靠 `evaluation.md` 第 9 节的人工评估），
 * 也不调用服务端 `parseAdvisorRequest`——它还没有 v3 分支（见 `docs/ai/prompt-spec.md` §9.3 的 D13）。
 */

const EXPECTED_SCENARIO_IDS = ['S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15'] as const

type StageRequest = AdvisorRecommendationsRequest | AdvisorChatRequest | MilestoneCandidateRequest

function isTaskRequest(request: StageRequest): request is AdvisorRecommendationsRequest | AdvisorChatRequest {
  return 'tasks' in request
}

function isChatRequest(request: StageRequest): request is AdvisorChatRequest {
  return 'chatHistory' in request
}

function charLength(value: string): number {
  return [...value].length
}

/** 递归收集所有字符串值（不含键名），用于内部词扫描 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out)
  }
  return out
}

function taskRequests(): Array<[string, AdvisorRecommendationsRequest | AdvisorChatRequest]> {
  return STAGE_SCENARIOS.flatMap((scenario) => {
    if (scenario.request === null || !isTaskRequest(scenario.request)) return []
    return [[scenario.id, scenario.request] as [string, AdvisorRecommendationsRequest | AdvisorChatRequest]]
  })
}

/* ------------------------------------------- 1. 场景集完整性 */

describe('九个必备场景', () => {
  it('编号齐全、唯一、顺序固定', () => {
    expect(STAGE_SCENARIOS.map((scenario) => scenario.id)).toEqual([...EXPECTED_SCENARIO_IDS])
  })

  it('每个场景都有用途、预期要点与禁止项', () => {
    for (const scenario of STAGE_SCENARIOS) {
      expect(scenario.name.length, `${scenario.id} 缺名称`).toBeGreaterThan(0)
      expect(charLength(scenario.purpose), `${scenario.id} 的 purpose 太短`).toBeGreaterThan(10)
      expect(scenario.expectations.requiredSignals.length, `${scenario.id} 没有预期要点`).toBeGreaterThan(0)
      expect(scenario.expectations.forbiddenPatterns.length, `${scenario.id} 没有禁止项`).toBeGreaterThan(0)
    }
  })

  it('场景类型覆盖建议 / 聊天 / 故障注入', () => {
    const kinds = new Set(STAGE_SCENARIOS.map((scenario) => scenario.kind))
    expect(kinds.has('advisor')).toBe(true)
    expect(kinds.has('chat')).toBe(true)
    expect(kinds.has('failure')).toBe(true)
  })

  it('只有 S14 没有请求体，且必须声明故障形态', () => {
    for (const scenario of STAGE_SCENARIOS) {
      if (scenario.id === 'S14') {
        expect(scenario.request).toBeNull()
        expect(scenario.failureMode).toBeDefined()
      } else {
        expect(scenario.request, `${scenario.id} 缺请求体`).not.toBeNull()
      }
    }
  })

  it('空阶段场景必须标记"要说清没有进行中的阶段"', () => {
    for (const id of ['S7', 'S10'] as const) {
      const scenario = STAGE_SCENARIOS.find((item) => item.id === id) as StageScenario
      expect(scenario.expectations.mustStateNoActiveMilestone, `${id} 未标记`).toBe(true)
    }
  })

  it('无材料场景必须标记"要说清没有已确认材料"', () => {
    for (const id of ['S11', 'S13'] as const) {
      const scenario = STAGE_SCENARIOS.find((item) => item.id === id) as StageScenario
      expect(scenario.expectations.mustStateNoConfirmedMaterial, `${id} 未标记`).toBe(true)
    }
  })

  it('S15 是长问题：问题本身不少于 300 字', () => {
    const scenario = STAGE_SCENARIOS.find((item) => item.id === 'S15')
    if (scenario === undefined || scenario.request === null || !isChatRequest(scenario.request)) {
      throw new Error('S15 必须是聊天请求')
    }
    expect(charLength(scenario.request.question)).toBeGreaterThanOrEqual(300)
    expect(scenario.expectations.minSteps).toBe(1)
    expect(scenario.expectations.maxSteps).toBe(8)
  })
})

/* ------------------------------------------- 2. 版本与上下文配对（契约 §23.4） */

describe('promptVersion 与 milestoneContext 的配对', () => {
  it('建议 / 聊天用 v3 时必须带 milestoneContext', () => {
    for (const [id, request] of taskRequests()) {
      if (request.promptVersion !== STAGE_PROMPT_VERSION_MATRIX.advisor &&
          request.promptVersion !== STAGE_PROMPT_VERSION_MATRIX.chat) {
        continue
      }
      expect(request.milestoneContext, `${id} 用了 v3 却没有 milestoneContext`).toBeDefined()
    }
  })

  it('建议 / 聊天用 v2 时必须不带 milestoneContext（不静默忽略）', () => {
    for (const [id, request] of taskRequests()) {
      if (request.promptVersion === STAGE_PROMPT_VERSION_MATRIX.advisor ||
          request.promptVersion === STAGE_PROMPT_VERSION_MATRIX.chat) {
        continue
      }
      expect(request.milestoneContext, `${id} 用了 v2 却带了 milestoneContext`).toBeUndefined()
    }
  })

  it('建议接口只能发建议版本，聊天接口只能发聊天版本', () => {
    for (const [id, request] of taskRequests()) {
      if (isChatRequest(request)) {
        expect(request.promptVersion, `${id} 聊天接口发了建议版本`).toBe(STAGE_PROMPT_VERSION_MATRIX.chat)
      } else {
        expect(request.promptVersion, `${id} 建议接口发了聊天版本`).toBe(STAGE_PROMPT_VERSION_MATRIX.advisor)
      }
    }
  })

  it('阶段候选请求用 milestone-candidate-v1 与 contractVersion 3.0', () => {
    expect(STAGE_CANDIDATE_REQUEST.promptVersion).toBe(CANDIDATE_PROMPT_VERSION)
    expect(STAGE_CANDIDATE_REQUEST.contractVersion).toBe(STAGE_CONTRACT_VERSION)
    expect(STAGE_CANDIDATE_REQUEST.maxCandidates).toBeGreaterThanOrEqual(1)
    expect(STAGE_CANDIDATE_REQUEST.maxCandidates).toBeLessThanOrEqual(3)
  })

  it('三个取值与契约 §23.4 逐字一致', () => {
    expect(STAGE_PROMPT_VERSION_MATRIX.advisor).toBe('mvp-prompt-v3')
    expect(STAGE_PROMPT_VERSION_MATRIX.chat).toBe('advisor-chat-v3')
    expect(STAGE_PROMPT_VERSION_MATRIX.candidate).toBe('milestone-candidate-v1')
  })
})

/* ------------------------------------------- 3. milestoneContext 不变式 */

function assertEmptyContext(context: MilestoneContext): void {
  expect(context.milestoneId).toBeNull()
  expect(context.currentMilestone).toBeNull()
  expect(context.milestoneRevision).toBeNull()
  expect(context.milestoneGoal).toBeNull()
  expect(context.milestoneDoneCriteria).toBeNull()
  expect(context.milestoneStatus).toBeNull()
  expect(context.milestoneTasks).toEqual([])
  expect(context.recentProgress).toEqual([])
  expect(context.milestoneEvidence).toEqual([])
}

describe('milestoneContext 的不变式（契约 §23.2）', () => {
  it('空白场景的上下文必须是全 null + 空数组', () => {
    for (const id of ['S7', 'S10'] as const) {
      const scenario = STAGE_SCENARIOS.find((item) => item.id === id) as StageScenario
      if (scenario.request === null || !isTaskRequest(scenario.request)) {
        throw new Error(`${id} 必须有请求体`)
      }
      if (scenario.request.milestoneContext === undefined) throw new Error(`${id} 缺 milestoneContext`)
      assertEmptyContext(scenario.request.milestoneContext)
    }
  })

  it('非空上下文的字段自洽、状态合法、条数不超限', () => {
    for (const [id, request] of taskRequests()) {
      const context = request.milestoneContext
      if (context === undefined || context.milestoneId === null) continue

      expect(['planned', 'active'], `${id} 的 milestoneStatus 非法`).toContain(context.milestoneStatus)
      expect(context.currentMilestone, `${id} 的 currentMilestone 与顶层不一致`).toBe(
        request.currentMilestone,
      )
      expect(context.milestoneRevision).toBeGreaterThanOrEqual(1)
      expect(charLength(context.currentMilestone ?? '')).toBeLessThanOrEqual(60)
      expect(charLength(context.milestoneGoal ?? '')).toBeLessThanOrEqual(300)
      expect(charLength(context.milestoneDoneCriteria ?? '')).toBeLessThanOrEqual(300)
      expect(context.milestoneTasks.length, `${id} 阶段任务超 50 条`).toBeLessThanOrEqual(50)
      expect(context.recentProgress.length, `${id} 进展超 20 条`).toBeLessThanOrEqual(20)
      expect(context.milestoneEvidence.length, `${id} 证据超 20 条`).toBeLessThanOrEqual(20)
    }
  })

  it('进展与证据都按时间倒序', () => {
    for (const [id, request] of taskRequests()) {
      const context = request.milestoneContext
      if (context === undefined) continue
      const progressTimes = context.recentProgress.map((item) => item.occurredAt)
      expect(progressTimes, `${id} 进展未按 occurredAt 倒序`).toEqual(
        [...progressTimes].sort((a, b) => b.localeCompare(a)),
      )
      const evidenceTimes = context.milestoneEvidence.map((item) => item.createdAt)
      expect(evidenceTimes, `${id} 证据未按 createdAt 倒序`).toEqual(
        [...evidenceTimes].sort((a, b) => b.localeCompare(a)),
      )
    }
  })

  it('阶段任务必须包含已完成任务（"不得重提"的唯一依据）', () => {
    const s9 = STAGE_SCENARIOS.find((item) => item.id === 'S9')
    if (s9 === undefined || s9.request === null || !isTaskRequest(s9.request)) {
      throw new Error('S9 必须有请求体')
    }
    const context = s9.request.milestoneContext
    if (context === undefined) throw new Error('S9 缺 milestoneContext')
    expect(context.milestoneTasks.some((task) => task.status === 'done')).toBe(true)
    // 顶层的 tasks 也必须含已完成任务（契约 §4.1 / §9 差异 14）
    expect(s9.request.tasks.some((task) => task.status === 'done')).toBe(true)
  })

  it('阶段任务必须属于该阶段（milestone 字段一致）', () => {
    for (const [id, request] of taskRequests()) {
      const context = request.milestoneContext
      if (context === undefined || context.milestoneId === null) continue
      for (const task of context.milestoneTasks) {
        expect(task.milestone, `${id} 的任务 ${task.taskId} 不属于当前阶段`).toBe(
          context.currentMilestone,
        )
      }
    }
  })

  it('只有非空上下文才允许携带材料（空上下文 + 材料是矛盾组合）', () => {
    for (const [id, request] of taskRequests()) {
      const context = request.milestoneContext
      const materials = request.confirmedMaterials ?? []
      if (context === undefined || context.milestoneId === null) {
        // 空白项目的样例不刻意塞材料；若将来需要，应单独造场景而不是复用 S7 / S10
        expect(materials.length, `${id} 空白上下文却带了材料`).toBe(0)
      }
    }
  })
})

/* ------------------------------------------- 4. 未确认材料不得泄漏 */

describe('未确认材料不会进入请求', () => {
  it('S11 的草稿正文不出现在请求的任何字段里', () => {
    const scenario = STAGE_SCENARIOS.find((item) => item.id === 'S11')
    if (scenario === undefined || scenario.request === null) throw new Error('S11 缺请求体')
    expect(scenario.pendingMaterial?.status).toBe('pending')
    expect(scenario.request).not.toHaveProperty('confirmedMaterials')

    const requestText = collectStrings(scenario.request).join('\n')
    for (const itemText of scenario.pendingMaterial?.itemTexts ?? []) {
      expect(requestText, `未确认内容泄漏：${itemText}`).not.toContain(itemText)
    }
  })

  it('只有 S9 / S12 / S15 携带已确认材料，且版本 ≥ 1、片段行号合法', () => {
    const withMaterials = taskRequests().filter(
      ([, request]) => (request.confirmedMaterials ?? []).length > 0,
    )
    expect(withMaterials.map(([id]) => id).sort()).toEqual(['S12', 'S15', 'S9'])

    for (const [id, request] of withMaterials) {
      for (const material of request.confirmedMaterials ?? []) {
        expect(['md', 'txt'], `${id} 的材料类型非法`).toContain(material.type)
        expect(material.version, `${id} 的材料版本必须 ≥ 1`).toBeGreaterThanOrEqual(1)
        expect(material.segments.length, `${id} 的材料没有片段`).toBeGreaterThan(0)
        for (const segment of material.segments) {
          expect(segment.startLine, `${id} 的 startLine 必须 ≥ 1`).toBeGreaterThanOrEqual(1)
          expect(segment.endLine, `${id} 的 endLine 不得小于 startLine`).toBeGreaterThanOrEqual(
            segment.startLine,
          )
          expect(charLength(segment.text), `${id} 的单段超 2000 字`).toBeLessThanOrEqual(2000)
        }
      }
    }
  })
})

/* ------------------------------------------- 5. 字段上限 */

describe('字段上限（契约 §4.1 / §6.4 / §17.1 / §23.2）', () => {
  it('项目名、阶段名、问题、历史都在上限内', () => {
    for (const [id, request] of taskRequests()) {
      expect(charLength(request.projectName), `${id} 项目名超 120 字`).toBeLessThanOrEqual(120)
      if (request.currentMilestone !== null) {
        expect(charLength(request.currentMilestone), `${id} 阶段名超 60 字`).toBeLessThanOrEqual(60)
      }
      if (isChatRequest(request)) {
        expect(charLength(request.question), `${id} 问题超 2000 字`).toBeLessThanOrEqual(2000)
        expect(request.chatHistory.length, `${id} 历史超 20 条`).toBeLessThanOrEqual(20)
        for (const message of request.chatHistory) {
          expect(['user', 'assistant']).toContain(message.role)
          expect(charLength(message.text), `${id} 历史单条超 2000 字`).toBeLessThanOrEqual(2000)
        }
      }
    }
  })

  it('已确认材料满足 ≤3 份 / ≤20 片段 / ≤8000 字', () => {
    for (const [id, request] of taskRequests()) {
      const materials: ConfirmedMaterial[] = request.confirmedMaterials ?? []
      expect(materials.length, `${id} 材料超 3 份`).toBeLessThanOrEqual(3)
      const segments = materials.flatMap((material) => material.segments)
      expect(segments.length, `${id} 片段超 20 条`).toBeLessThanOrEqual(20)
      const total = segments.reduce((sum, segment) => sum + segment.text.length, 0)
      expect(total, `${id} 材料正文合计超 8000 字`).toBeLessThanOrEqual(8000)
    }
  })

  it('任务与证据快照字段齐全（owner / author 必须为 null）', () => {
    for (const [id, request] of taskRequests()) {
      for (const task of request.tasks) {
        expect(task.owner, `${id} 的 owner 必须是 null`).toBeNull()
        expect(charLength(task.title)).toBeLessThanOrEqual(60)
      }
      for (const evidence of request.evidence) {
        expect(evidence.author, `${id} 的 author 必须是 null`).toBeNull()
      }
    }
  })
})

/* ------------------------------------------- 6. 阶段候选样例 */

describe('阶段候选样例（契约 §23.7）', () => {
  it('候选 0–3 条，字段与上限合法', () => {
    const candidates = STAGE_CANDIDATE_EXAMPLE.candidates
    expect(candidates.length).toBeGreaterThanOrEqual(0)
    expect(candidates.length).toBeLessThanOrEqual(3)

    for (const candidate of candidates) {
      expect(candidate.candidateId.startsWith('cand_')).toBe(true)
      expect(charLength(candidate.name)).toBeGreaterThanOrEqual(1)
      expect(charLength(candidate.name)).toBeLessThanOrEqual(60)
      expect(charLength(candidate.goal)).toBeLessThanOrEqual(300)
      expect(charLength(candidate.doneCriteria)).toBeLessThanOrEqual(300)
      expect(candidate.suggestedTasks.length, '每条候选最多 5 个建议任务').toBeLessThanOrEqual(5)
      expect(candidate.risks.length, '风险最多 3 条').toBeLessThanOrEqual(3)
      expect(candidate.sources.length, '来源最多 3 条').toBeLessThanOrEqual(3)
      expect(candidate.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

      for (const task of candidate.suggestedTasks) {
        expect(charLength(task.title)).toBeGreaterThanOrEqual(1)
        expect(charLength(task.title)).toBeLessThanOrEqual(60)
        expect(charLength(task.doneCriteria)).toBeLessThanOrEqual(200)
      }
      for (const risk of candidate.risks) {
        expect(charLength(risk), '单条风险超 100 字').toBeLessThanOrEqual(100)
      }
    }
  })

  it('候选名称不重复（同项目阶段不得重名）', () => {
    const names = STAGE_CANDIDATE_EXAMPLE.candidates.map((candidate) => candidate.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('来源必须能对上已确认片段：材料名、版本、行号由服务端回填', () => {
    const confirmed = taskRequests()
      .flatMap(([, request]) => request.confirmedMaterials ?? [])
      .flatMap((material) =>
        material.segments.map((segment) => ({
          materialId: material.materialId,
          materialName: material.name,
          materialVersion: material.version,
          segmentId: segment.segmentId,
          startLine: segment.startLine,
          endLine: segment.endLine,
        })),
      )

    for (const candidate of STAGE_CANDIDATE_EXAMPLE.candidates) {
      for (const source of candidate.sources) {
        const matched = confirmed.some(
          (item) =>
            item.materialId === source.materialId &&
            item.materialName === source.materialName &&
            item.materialVersion === source.materialVersion &&
            item.segmentId === source.segmentId &&
            item.startLine === source.startLine &&
            item.endLine === source.endLine,
        )
        expect(matched, `候选来源 ${source.materialName}/${source.segmentId} 对不上已确认片段`).toBe(
          true,
        )
      }
    }
  })

  it('响应头字段与请求一致：source 合法、promptVersion 一致、notice 与 fallback 配对', () => {
    expect(['model', 'fallback']).toContain(STAGE_CANDIDATE_EXAMPLE.source)
    expect(STAGE_CANDIDATE_EXAMPLE.promptVersion).toBe(STAGE_CANDIDATE_REQUEST.promptVersion)
    if (STAGE_CANDIDATE_EXAMPLE.source === 'fallback') {
      expect(STAGE_CANDIDATE_EXAMPLE.notice).not.toBeNull()
    } else {
      expect(STAGE_CANDIDATE_EXAMPLE.fallbackReason).toBeNull()
    }
    expect(STAGE_CANDIDATE_EXAMPLE.projectId).toBe(STAGE_CANDIDATE_REQUEST.projectId)
    expect(STAGE_CANDIDATE_EXAMPLE.projectRevision).toBe(STAGE_CANDIDATE_REQUEST.projectRevision)
  })
})

/* ------------------------------------------- 7. 反例集与内部词 */

describe('反例集 S-R', () => {
  it('15 条齐全、编号唯一且连续', () => {
    const ids = STAGE_COUNTEREXAMPLES.map((item) => item.id)
    expect(ids).toEqual(Array.from({ length: 15 }, (_, index) => `S-R${index + 1}`))
  })

  it('每条都写明违反条款、期望处理与可复现场景', () => {
    const validActions = new Set([
      'fallback',
      'drop',
      'truncate',
      'null',
      'drop-ref',
      'keep-but-no-citation',
      'manual',
    ])
    for (const item of STAGE_COUNTEREXAMPLES) {
      expect(item.violates.length, `${item.id} 缺违反条款`).toBeGreaterThan(0)
      expect(validActions.has(item.expected), `${item.id} 的期望处理非法`).toBe(true)
      expect(EXPECTED_SCENARIO_IDS).toContain(item.scenario)
      expect(item.shape.length, `${item.id} 缺形态描述`).toBeGreaterThan(5)
    }
  })

  it('版本组合类反例（S-R13 / S-R14）确实构造出了不合法组合', () => {
    const r13 = STAGE_COUNTEREXAMPLES.find((item) => item.id === 'S-R13')
    const r14 = STAGE_COUNTEREXAMPLES.find((item) => item.id === 'S-R14')
    expect(r13?.sample).toMatchObject({ promptVersion: 'mvp-prompt-v3', milestoneContext: undefined })
    expect(r14?.sample).toMatchObject({ promptVersion: 'mvp-prompt-v2' })
    expect((r14?.sample as { milestoneContext?: unknown }).milestoneContext).toBeDefined()
  })

  it('候选类反例命中数量上限（S-R6 / S-R7）', () => {
    const r6 = STAGE_COUNTEREXAMPLES.find((item) => item.id === 'S-R6')
    const r7 = STAGE_COUNTEREXAMPLES.find((item) => item.id === 'S-R7')
    const r6Sample = r6?.sample as { suggestedTasks: unknown[] }
    const r7Sample = r7?.sample as { candidates: unknown[] }
    expect(r6Sample.suggestedTasks).toHaveLength(8)
    expect(r7Sample.candidates).toHaveLength(5)
  })
})

describe('内部词清单', () => {
  it('覆盖 prompt-spec §11.6 列出的关键内部词', () => {
    for (const word of [
      'milestoneContext',
      'milestoneGoal',
      'milestoneDoneCriteria',
      'basisMaterialRefs',
      'citations',
      'segmentIds',
      'candidateId',
      'planned',
      'active',
    ]) {
      expect(STAGE_INTERNAL_WORDS, `内部词清单缺 ${word}`).toContain(word)
    }
  })

  it('样例里的学生可见文本不含内部词（键名除外）', () => {
    const texts: string[] = []
    for (const scenario of STAGE_SCENARIOS) {
      if (scenario.request === null) continue
      if (isTaskRequest(scenario.request)) {
        for (const task of scenario.request.tasks) {
          texts.push(task.title, task.doneCriteria ?? '')
        }
        if ('confirmedContext' in scenario.request) {
          for (const item of scenario.request.confirmedContext) texts.push(item)
        }
        for (const evidence of scenario.request.evidence) {
          texts.push(evidence.didWhat, evidence.foundWhat ?? '', evidence.stillUnsure ?? '')
        }
        if (isChatRequest(scenario.request)) texts.push(scenario.request.question)
      }
    }

    const joined = texts.join('\n')
    for (const word of STAGE_INTERNAL_WORDS) {
      expect(joined, `学生可见文本出现内部词：${word}`).not.toContain(word)
    }
  })
})
