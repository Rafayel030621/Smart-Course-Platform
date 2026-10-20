import { describe, expect, it } from 'vitest'
import { buildAdvisorChatRequest, buildAdvisorRequest } from '@/services/advisorApi'
import {
  ADVISOR_CHAT_PROMPT_VERSION_V3,
  MILESTONE_PROMPT_VERSION,
  type MilestoneContext,
} from '@/domain/recommendation'
import { buildMilestoneContext, selectConfirmedMaterials } from '@/domain/v3Advisor'
import type { CloudMaterial, CloudMaterialSegment, CloudUnderstandingItem } from '@/types/platform'
import {
  makeCloudMilestone,
  makeCloudTask,
  makeEvidence,
  makeProgress,
} from '../support/v3Fixtures'

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

describe('已确认材料过滤', () => {
  const material: CloudMaterial = {
    materialId: 'mat_1',
    projectId: 'prj_1',
    name: '实验手册.md',
    type: 'md',
    size: 2048,
    encoding: 'utf-8',
    version: 2,
    status: 'parsed',
    createdAt: '2026-10-15T00:00:00.000Z',
  }
  const segments: CloudMaterialSegment[] = [
    {
      materialId: 'mat_1',
      materialVersion: 2,
      segmentId: 'seg_0',
      orderIndex: 0,
      startLine: 1,
      endLine: 3,
      text: '确认过的正文',
    },
    {
      materialId: 'mat_1',
      materialVersion: 2,
      segmentId: 'seg_1',
      orderIndex: 1,
      startLine: 4,
      endLine: 6,
      text: '未确认的正文',
    },
  ]
  function item(overrides: Partial<CloudUnderstandingItem>): CloudUnderstandingItem {
    return {
      itemId: 'it_1',
      materialId: 'mat_1',
      materialVersion: 2,
      kind: 'goalCandidates',
      text: '目标',
      originalText: '目标',
      sourceSegmentIds: ['seg_0'],
      status: 'pending',
      revision: 1,
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
      ...overrides,
    }
  }

  it('pending / modified / 旧版本条目都不会进入 confirmedMaterials', () => {
    const confirmed = selectConfirmedMaterials(
      [
        item({ itemId: 'it_confirmed', status: 'confirmed' }),
        item({ itemId: 'it_pending', status: 'pending', sourceSegmentIds: ['seg_1'] }),
        item({ itemId: 'it_modified', status: 'modified' }),
        item({ itemId: 'it_old_version', status: 'confirmed', materialVersion: 1 }),
      ],
      segments,
      [material],
    )

    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]!.segments.map((segment) => segment.segmentId)).toEqual(['seg_0'])
    expect(JSON.stringify(confirmed)).not.toContain('未确认的正文')
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

    expect(request.promptVersion).toBe(MILESTONE_PROMPT_VERSION)
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
    const material: CloudMaterial = {
      materialId: 'mat_1',
      projectId: 'prj_1',
      name: '实验手册.md',
      type: 'md',
      size: 100,
      encoding: 'utf-8',
      version: 1,
      status: 'parsed',
      createdAt: '2026-10-15T00:00:00.000Z',
    }
    const confirmed = selectConfirmedMaterials(
      [
        {
          itemId: 'it_1',
          materialId: 'mat_1',
          materialVersion: 1,
          kind: 'goalCandidates',
          text: '目标',
          originalText: '目标',
          sourceSegmentIds: ['seg_0'],
          status: 'confirmed',
          revision: 1,
          createdAt: '2026-10-15T00:00:00.000Z',
          updatedAt: '2026-10-15T00:00:00.000Z',
        },
        {
          itemId: 'it_2',
          materialId: 'mat_1',
          materialVersion: 1,
          kind: 'dataNotes',
          text: '待确认',
          originalText: '待确认',
          sourceSegmentIds: ['seg_1'],
          status: 'pending',
          revision: 1,
          createdAt: '2026-10-15T00:00:00.000Z',
          updatedAt: '2026-10-15T00:00:00.000Z',
        },
      ],
      [
        {
          materialId: 'mat_1',
          materialVersion: 1,
          segmentId: 'seg_0',
          orderIndex: 0,
          startLine: 1,
          endLine: 2,
          text: '已确认正文',
        },
        {
          materialId: 'mat_1',
          materialVersion: 1,
          segmentId: 'seg_1',
          orderIndex: 1,
          startLine: 3,
          endLine: 4,
          text: '未确认正文',
        },
      ],
      [material],
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
