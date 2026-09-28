import { describe, expect, it } from 'vitest'
import { buildLocalRecommendations, type LocalRecommendationInput } from '@/data/mvpFallbacks'
import type { DoubtSnapshot, EvidenceSnapshot, TaskSnapshot } from '@/domain/recommendation'

const GENERATED_AT = '2026-09-26T08:30:00.000Z'
const REVISION = 12
const MILESTONE = '选题确认与文献调研'

function makeTaskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'tsk_1',
    title: '调研极端风浪事件的定义',
    status: 'todo',
    doneCriteria: '一页调研笔记',
    owner: null,
    milestone: MILESTONE,
    updatedAt: GENERATED_AT,
    ...overrides,
  }
}

function makeEvidenceSnapshot(overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    evidenceId: 'evd_1',
    submissionId: 'sub_1',
    taskId: null,
    didWhat: '读了 6 篇文献',
    foundWhat: null,
    stillUnsure: null,
    author: null,
    createdAt: GENERATED_AT,
    ...overrides,
  }
}

function makeDoubtSnapshot(overrides: Partial<DoubtSnapshot> = {}): DoubtSnapshot {
  return {
    doubtId: 'dbt_1',
    text: 'ERA5 分辨率差距怎么处理',
    status: 'open',
    sourceEvidenceId: null,
    createdAt: GENERATED_AT,
    ...overrides,
  }
}

function makeInput(overrides: Partial<LocalRecommendationInput> = {}): LocalRecommendationInput {
  return {
    generatedAt: GENERATED_AT,
    projectRevision: REVISION,
    currentMilestone: MILESTONE,
    tasks: [],
    evidence: [],
    doubts: [],
    ...overrides,
  }
}

describe('没有可推荐的内容时返回空数组', () => {
  it('空项目（无任务、无疑问、无里程碑）不产出建议', () => {
    const result = buildLocalRecommendations(
      makeInput({ currentMilestone: null, tasks: [], evidence: [], doubts: [] }),
    )

    expect(result).toEqual([])
  })

  it('字段缺失时按空数组处理，不抛异常', () => {
    const result = buildLocalRecommendations(
      makeInput({
        currentMilestone: null,
        tasks: undefined as unknown as TaskSnapshot[],
        evidence: undefined as unknown as EvidenceSnapshot[],
        doubts: undefined as unknown as DoubtSnapshot[],
      }),
    )

    expect(result).toEqual([])
  })
})

describe('已完成任务不会被再次建议', () => {
  it('只有 done 任务时不推荐任何任务，转而推进当前里程碑', () => {
    const result = buildLocalRecommendations(
      makeInput({
        tasks: [makeTaskSnapshot({ taskId: 'tsk_done', status: 'done' })],
        evidence: [makeEvidenceSnapshot()],
      }),
    )

    expect(result).toHaveLength(1)
    expect(result[0]?.existingTaskId).toBeNull()
    expect(result[0]?.title).toBe(`推进当前里程碑：${MILESTONE}`)
  })

  it('doing、todo 与 done 混合时优先进行中的任务，done 从不出现', () => {
    const result = buildLocalRecommendations(
      makeInput({
        tasks: [
          makeTaskSnapshot({ taskId: 'tsk_done', title: '已经做完的', status: 'done' }),
          makeTaskSnapshot({ taskId: 'tsk_doing', title: '正在做的', status: 'doing' }),
          makeTaskSnapshot({ taskId: 'tsk_todo', title: '还没开始的', status: 'todo' }),
        ],
        evidence: [makeEvidenceSnapshot()],
      }),
    )

    const referenced = result.map((item) => item.existingTaskId)
    expect(referenced).not.toContain('tsk_done')
    expect(result[0]?.existingTaskId).toBe('tsk_doing')
    expect(result[1]?.existingTaskId).toBe('tsk_todo')
  })
})

describe('建议顺序与条数上限', () => {
  it('按「进行中 → 疑问 → 未开始」优先，最多 3 条', () => {
    const result = buildLocalRecommendations(
      makeInput({
        tasks: [
          makeTaskSnapshot({ taskId: 'tsk_doing', title: '进行中', status: 'doing' }),
          makeTaskSnapshot({ taskId: 'tsk_todo', title: '未开始', status: 'todo' }),
        ],
        doubts: [makeDoubtSnapshot({ doubtId: 'dbt_1' })],
        evidence: [makeEvidenceSnapshot()],
      }),
    )

    expect(result).toHaveLength(3)
    expect(result[0]?.existingTaskId).toBe('tsk_doing')
    expect(result[1]?.basisDoubtIds).toEqual(['dbt_1'])
    expect(result[2]?.existingTaskId).toBe('tsk_todo')
  })

  it('有任务但没有证据时补一条「先提交第一条证据」', () => {
    const result = buildLocalRecommendations(
      makeInput({
        tasks: [makeTaskSnapshot({ taskId: 'tsk_todo', status: 'todo' })],
        evidence: [],
      }),
    )

    expect(result.map((item) => item.title)).toContain('先提交第一条证据')
  })
})

describe('依据只引用本次输入里真实存在的 ID', () => {
  it('疑问的来源证据在输入中时进入 basisEvidenceIds', () => {
    const result = buildLocalRecommendations(
      makeInput({
        doubts: [makeDoubtSnapshot({ doubtId: 'dbt_1', sourceEvidenceId: 'evd_1' })],
        evidence: [makeEvidenceSnapshot({ evidenceId: 'evd_1' })],
      }),
    )

    expect(result[0]?.basisDoubtIds).toEqual(['dbt_1'])
    expect(result[0]?.basisEvidenceIds).toEqual(['evd_1'])
  })

  it('疑问的来源证据不在输入中时 basisEvidenceIds 为空', () => {
    const result = buildLocalRecommendations(
      makeInput({
        doubts: [makeDoubtSnapshot({ doubtId: 'dbt_1', sourceEvidenceId: 'evd_missing' })],
        evidence: [makeEvidenceSnapshot({ evidenceId: 'evd_1' })],
      }),
    )

    expect(result[0]?.basisDoubtIds).toEqual(['dbt_1'])
    expect(result[0]?.basisEvidenceIds).toEqual([])
  })

  it('已解决的疑问不参与推荐', () => {
    const result = buildLocalRecommendations(
      makeInput({
        doubts: [makeDoubtSnapshot({ doubtId: 'dbt_done', status: 'resolved' })],
        tasks: [],
        evidence: [],
        currentMilestone: null,
      }),
    )

    expect(result).toEqual([])
  })

  it('进行中的任务只引用同一任务的证据', () => {
    const result = buildLocalRecommendations(
      makeInput({
        tasks: [makeTaskSnapshot({ taskId: 'tsk_doing', status: 'doing' })],
        evidence: [
          makeEvidenceSnapshot({ evidenceId: 'evd_mine', taskId: 'tsk_doing' }),
          makeEvidenceSnapshot({ evidenceId: 'evd_other', taskId: 'tsk_other' }),
        ],
      }),
    )

    expect(result[0]?.existingTaskId).toBe('tsk_doing')
    expect(result[0]?.basisEvidenceIds).toEqual(['evd_mine'])
  })

  it('所有引用 ID 都必须落在本次输入集合内', () => {
    const evidence = [
      makeEvidenceSnapshot({ evidenceId: 'evd_1', taskId: 'tsk_doing' }),
      makeEvidenceSnapshot({ evidenceId: 'evd_2', taskId: 'tsk_other' }),
    ]
    const doubts = [
      makeDoubtSnapshot({ doubtId: 'dbt_1', sourceEvidenceId: 'evd_2' }),
      makeDoubtSnapshot({ doubtId: 'dbt_2', status: 'resolved' }),
    ]
    const tasks = [
      makeTaskSnapshot({ taskId: 'tsk_doing', status: 'doing' }),
      makeTaskSnapshot({ taskId: 'tsk_todo', status: 'todo' }),
    ]

    const result = buildLocalRecommendations(makeInput({ tasks, evidence, doubts }))

    const knownEvidenceIds = new Set(evidence.map((item) => item.evidenceId))
    const knownDoubtIds = new Set(doubts.map((item) => item.doubtId))
    const knownTaskIds = new Set(tasks.map((item) => item.taskId))

    for (const suggestion of result) {
      for (const id of suggestion.basisEvidenceIds) {
        expect(knownEvidenceIds.has(id)).toBe(true)
      }
      for (const id of suggestion.basisDoubtIds) {
        expect(knownDoubtIds.has(id)).toBe(true)
      }
      if (suggestion.existingTaskId !== null) {
        expect(knownTaskIds.has(suggestion.existingTaskId)).toBe(true)
      }
    }
  })
})

describe('领域对象字段（契约 2.5(b)）', () => {
  it('本地规则建议的 id / source / requestId / projectRevision / generatedAt 符合约定', () => {
    const result = buildLocalRecommendations(
      makeInput({ tasks: [makeTaskSnapshot({ taskId: 'tsk_doing', status: 'doing' })] }),
    )

    expect(result[0]).toMatchObject({
      id: `rec_local_${REVISION}_0`,
      source: 'local-rule',
      requestId: null,
      projectRevision: REVISION,
      generatedAt: GENERATED_AT,
    })
  })

  it('id 的序号随列表位置递增', () => {
    const result = buildLocalRecommendations(
      makeInput({
        tasks: [
          makeTaskSnapshot({ taskId: 'tsk_doing', status: 'doing' }),
          makeTaskSnapshot({ taskId: 'tsk_todo', status: 'todo' }),
        ],
        evidence: [makeEvidenceSnapshot()],
      }),
    )

    expect(result.map((item) => item.id)).toEqual([
      `rec_local_${REVISION}_0`,
      `rec_local_${REVISION}_1`,
    ])
  })

  it('每条建议的六个线格式字段都不为空（除了允许为 null 的 existingTaskId）', () => {
    const result = buildLocalRecommendations(
      makeInput({ tasks: [makeTaskSnapshot({ taskId: 'tsk_todo', status: 'todo' })] }),
    )

    for (const suggestion of result) {
      expect(suggestion.title.length).toBeGreaterThan(0)
      expect(suggestion.whyNow.length).toBeGreaterThan(0)
      expect(suggestion.doneCriteria.length).toBeGreaterThan(0)
      expect(Array.isArray(suggestion.basisEvidenceIds)).toBe(true)
      expect(Array.isArray(suggestion.basisDoubtIds)).toBe(true)
    }
  })
})

describe('纯函数语义', () => {
  it('不修改传入的输入对象', () => {
    const input = makeInput({
      tasks: [makeTaskSnapshot({ taskId: 'tsk_doing', status: 'doing' })],
      doubts: [makeDoubtSnapshot({ doubtId: 'dbt_1', sourceEvidenceId: 'evd_1' })],
      evidence: [makeEvidenceSnapshot({ evidenceId: 'evd_1' })],
    })
    const snapshot = JSON.parse(JSON.stringify(input)) as LocalRecommendationInput

    buildLocalRecommendations(input)

    expect(input).toEqual(snapshot)
  })

  it('同一输入重复调用得到相同结果', () => {
    const input = makeInput({
      tasks: [makeTaskSnapshot({ taskId: 'tsk_doing', status: 'doing' })],
      doubts: [makeDoubtSnapshot({ doubtId: 'dbt_1' })],
    })

    expect(buildLocalRecommendations(input)).toEqual(buildLocalRecommendations(input))
  })
})
