import { describe, expect, it } from 'vitest'
import { buildAdvisorChatRequest, buildAdvisorRequest } from '@/services/advisorApi'
import {
  ADVISOR_CHAT_PROMPT_VERSION_V3,
  ADVISOR_V3_PROMPT_VERSION,
  supportsMilestoneContext,
  type MilestoneContext,
} from '@/domain/recommendation'
import {
  buildEvidenceSnapshots,
  buildMilestoneContext,
  buildTaskSnapshots,
  selectConfirmedMaterials,
} from '@/domain/v3Advisor'
import {
  makeCloudMaterial,
  makeCloudMilestone,
  makeCloudTask,
  makeEvidence,
  makeMaterialSegment,
  makeProgress,
  makeUnderstandingItem,
} from '../support/v3Fixtures'

const FIXED_ARCHIVED = '2026-10-16T00:00:00.000Z'

function contextSource() {
  return {
    projectId: 'prj_1',
    currentMilestoneId: 'ms_1',
    milestones: [
      makeCloudMilestone({ milestoneId: 'ms_1', status: 'active', revision: 4 }),
      makeCloudMilestone({ milestoneId: 'ms_2', name: '方法对比', orderIndex: 1, status: 'planned' }),
    ],
    tasks: [
      makeCloudTask({ taskId: 'tsk_1', milestoneId: 'ms_1', status: 'done' }),
      makeCloudTask({ taskId: 'tsk_2', milestoneId: 'ms_1', status: 'doing' }),
      makeCloudTask({ taskId: 'tsk_3', milestoneId: 'ms_2', status: 'todo' }),
    ],
    evidence: [
      makeEvidence({ evidenceId: 'evd_1', milestoneId: 'ms_1', createdAt: '2026-10-18T00:00:00.000Z' }),
      makeEvidence({ evidenceId: 'evd_2', milestoneId: 'ms_2' }),
      makeEvidence({ evidenceId: 'evd_3', milestoneId: 'ms_1', status: 'redacted' }),
    ],
    progress: [
      makeProgress({ progressId: 'prg_1', milestoneId: 'ms_1', occurredAt: '2026-10-17T00:00:00.000Z' }),
      makeProgress({ progressId: 'prg_2', milestoneId: 'ms_1', occurredAt: '2026-10-19T00:00:00.000Z' }),
      makeProgress({ progressId: 'prg_3', milestoneId: 'ms_2' }),
    ],
  }
}

describe('milestoneContext', () => {
  it('只包含当前阶段的未归档任务（含已完成）、进展和证据', () => {
    const context = buildMilestoneContext(contextSource())

    expect(context.milestoneId).toBe('ms_1')
    expect(context.currentMilestone).toBe('数据获取与预处理')
    expect(context.milestoneRevision).toBe(4)
    expect(context.milestoneStatus).toBe('active')
    expect(context.milestoneTasks.map((item) => item.taskId)).toEqual(['tsk_1', 'tsk_2'])
    expect(context.milestoneTasks.some((item) => item.status === 'done')).toBe(true)
    expect(context.recentProgress.map((item) => item.progressId)).toEqual(['prg_2', 'prg_1'])
    expect(context.milestoneEvidence.map((item) => item.evidenceId)).toEqual(['evd_1'])
  })

  it('已更正（superseded）的进展不进入阶段上下文', () => {
    const context = buildMilestoneContext({
      ...contextSource(),
      progress: [
        makeProgress({ progressId: 'prg_old', milestoneId: 'ms_1', status: 'superseded' }),
        makeProgress({ progressId: 'prg_new', milestoneId: 'ms_1', status: 'active' }),
      ],
    })

    expect(context.recentProgress.map((item) => item.progressId)).toEqual(['prg_new'])
  })

  it('当前阶段完成/归档或没有当前阶段时返回全空上下文', () => {
    const completed = buildMilestoneContext({
      ...contextSource(),
      milestones: [makeCloudMilestone({ milestoneId: 'ms_1', status: 'completed' })],
    })
    expect(completed.milestoneId).toBeNull()
    expect(completed.milestoneTasks).toEqual([])
    expect(completed.recentProgress).toEqual([])

    const blank = buildMilestoneContext({ ...contextSource(), currentMilestoneId: null })
    expect(blank).toEqual({
      milestoneId: null,
      currentMilestone: null,
      milestoneRevision: null,
      milestoneGoal: null,
      milestoneDoneCriteria: null,
      milestoneStatus: null,
      milestoneTasks: [],
      recentProgress: [],
      milestoneEvidence: [],
    })
  })
})

describe('请求顶层快照', () => {
  it('任务快照排除归档任务、按阶段顺序排列', () => {
    const snapshots = buildTaskSnapshots(
      [
        makeCloudTask({ taskId: 'tsk_b', orderIndex: 2, milestoneName: '方法对比' }),
        makeCloudTask({ taskId: 'tsk_a', orderIndex: 0 }),
        makeCloudTask({ taskId: 'tsk_archived', orderIndex: 1, archivedAt: '2026-10-18T00:00:00.000Z' }),
      ],
      'prj_1',
    )

    expect(snapshots.map((item) => item.taskId)).toEqual(['tsk_a', 'tsk_b'])
    expect(snapshots[1]!.milestone).toBe('方法对比')
    // 契约 2.2：V3 任务没有负责人展示字段，不编造
    expect(snapshots[0]!.owner).toBeNull()
  })

  it('证据快照只保留 active 记录并按 createdAt 倒序', () => {
    const snapshots = buildEvidenceSnapshots(
      [
        makeEvidence({ evidenceId: 'evd_old', createdAt: '2026-10-01T00:00:00.000Z' }),
        makeEvidence({ evidenceId: 'evd_new', createdAt: '2026-10-18T00:00:00.000Z' }),
        makeEvidence({ evidenceId: 'evd_redacted', status: 'redacted' }),
        makeEvidence({ evidenceId: 'evd_other', projectId: 'prj_2' }),
      ],
      'prj_1',
    )

    expect(snapshots.map((item) => item.evidenceId)).toEqual(['evd_new', 'evd_old'])
  })
})

describe('已确认材料过滤', () => {
  const material = makeCloudMaterial({ materialVersion: 2 })
  const segments = [
    makeMaterialSegment({ materialVersion: 2, segmentId: 'seg_0', index: 0, text: '确认过的正文' }),
    makeMaterialSegment({ materialVersion: 2, segmentId: 'seg_1', index: 1, text: '未确认的正文' }),
  ]

  function sourceOf(segmentId: string, materialVersion = 2) {
    return {
      materialId: 'mat_1',
      materialName: '实验手册.md',
      materialVersion,
      segmentId,
      startLine: 1,
      endLine: 3,
    }
  }

  it('pending / modified / 旧版本条目都不会进入 confirmedMaterials', () => {
    const confirmed = selectConfirmedMaterials(
      [
        makeUnderstandingItem({ itemId: 'it_confirmed', status: 'confirmed', sources: [sourceOf('seg_0')] }),
        makeUnderstandingItem({
          itemId: 'it_pending',
          status: 'pending',
          sources: [sourceOf('seg_1')],
        }),
        makeUnderstandingItem({ itemId: 'it_modified', status: 'modified', sources: [sourceOf('seg_0')] }),
        makeUnderstandingItem({ itemId: 'it_archived', status: 'archived', sources: [sourceOf('seg_0')] }),
        makeUnderstandingItem({
          itemId: 'it_old_version',
          status: 'confirmed',
          sources: [sourceOf('seg_0', 1)],
        }),
      ],
      segments,
      [material],
    )

    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]!.version).toBe(2)
    expect(confirmed[0]!.segments.map((segment) => segment.segmentId)).toEqual(['seg_0'])
    expect(JSON.stringify(confirmed)).not.toContain('未确认的正文')
  })

  it('归档材料、非当前版本、非 md/txt 材料都不进上下文', () => {
    const confirmed = selectConfirmedMaterials(
      [makeUnderstandingItem({ status: 'confirmed' })],
      segments,
      [
        makeCloudMaterial({ materialVersion: 2, status: 'archived', archivedAt: FIXED_ARCHIVED }),
        makeCloudMaterial({ materialVersion: 2, isCurrent: false, readOnly: true }),
        makeCloudMaterial({ materialVersion: 2, type: 'csv' }),
      ],
    )

    expect(confirmed).toEqual([])
  })

  it('没有来源片段的条目不会凭空产出材料上下文', () => {
    const confirmed = selectConfirmedMaterials(
      [makeUnderstandingItem({ status: 'confirmed', sources: [] })],
      segments,
      [material],
    )

    expect(confirmed).toEqual([])
  })
})

describe('v3 的来源判定（契约 23.1）', () => {
  it('只有云端项目允许携带阶段上下文', () => {
    expect(supportsMilestoneContext('cloud')).toBe(true)
    // 本地工作台的 projectId / 实体 ID 只存在于 localStorage，服务端不认识 → 只能发 v2
    expect(supportsMilestoneContext('local')).toBe(false)
  })

  it('本地来源的 v2 请求不带 milestoneContext（构造器层面也拿不到上下文）', () => {
    const localRequest = buildAdvisorRequest({
      projectId: 'prj_local_1',
      projectRevision: 3,
      projectName: '本地项目',
      currentMilestone: '本地阶段',
      tasks: [],
      evidence: [],
      doubts: [],
    })

    expect(localRequest.promptVersion).toBe('mvp-prompt-v2')
    expect('milestoneContext' in localRequest).toBe(false)
  })
})

describe('v3 请求构造器', () => {
  const baseInput = {
    projectId: 'prj_1',
    projectRevision: 12,
    projectName: '极端风浪事件分析',
    currentMilestone: '数据获取与预处理',
    tasks: [],
    evidence: [],
    doubts: [],
  }

  function context(): MilestoneContext {
    return buildMilestoneContext(contextSource())
  }

  it('建议请求带 milestoneContext 时默认 v3，并原样传递阶段上下文', () => {
    const request = buildAdvisorRequest({ ...baseInput, milestoneContext: context() })

    expect(request.promptVersion).toBe(ADVISOR_V3_PROMPT_VERSION)
    expect(request.milestoneContext?.milestoneId).toBe('ms_1')
    expect(request.contractVersion).toBe('1.0')
    expect(request.milestoneContext?.milestoneTasks.map((item) => item.taskId)).toEqual(['tsk_1', 'tsk_2'])
  })

  it('不传 milestoneContext 时保持 V2 请求结构，不出现该字段', () => {
    const request = buildAdvisorRequest(baseInput)

    expect(request.promptVersion).toBe('mvp-prompt-v2')
    expect('milestoneContext' in request).toBe(false)
  })

  it('显式传 v2 + milestoneContext 时不静默降级或丢弃上下文', () => {
    const request = buildAdvisorRequest({
      ...baseInput,
      milestoneContext: context(),
      promptVersion: 'mvp-prompt-v2',
    })

    expect(request.promptVersion).toBe('mvp-prompt-v2')
    expect(request.milestoneContext?.milestoneId).toBe('ms_1')
  })

  it('聊天请求同样按 v3 + milestoneContext 组合', () => {
    const request = buildAdvisorChatRequest({
      ...baseInput,
      question: '下一步做什么？',
      milestoneContext: context(),
    })

    expect(request.promptVersion).toBe(ADVISOR_CHAT_PROMPT_VERSION_V3)
    expect(request.milestoneContext?.milestoneId).toBe('ms_1')
    expect(request.contractVersion).toBe('1.0')
  })

  it('聊天请求只携带已确认材料', () => {
    const confirmed = selectConfirmedMaterials(
      [
        makeUnderstandingItem({ itemId: 'it_1', status: 'confirmed' }),
        makeUnderstandingItem({
          itemId: 'it_2',
          kind: 'dataNotes',
          status: 'pending',
          sources: [
            {
              materialId: 'mat_1',
              materialName: '实验手册.md',
              materialVersion: 1,
              segmentId: 'seg_1',
              startLine: 3,
              endLine: 4,
            },
          ],
        }),
      ],
      [
        makeMaterialSegment({ segmentId: 'seg_0', index: 0, text: '已确认正文' }),
        makeMaterialSegment({ segmentId: 'seg_1', index: 1, text: '未确认正文' }),
      ],
      [makeCloudMaterial()],
    )

    const request = buildAdvisorChatRequest({
      ...baseInput,
      question: '下一步做什么？',
      confirmedMaterials: confirmed,
    })

    expect(request.confirmedMaterials).toHaveLength(1)
    expect(JSON.stringify(request)).toContain('已确认正文')
    expect(JSON.stringify(request)).not.toContain('未确认正文')
  })
})
