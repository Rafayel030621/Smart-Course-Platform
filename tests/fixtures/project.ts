import type { Project, UnderstandingDraft } from '@/types/platform'

/**
 * 测试用项目数据
 * ----------------------------------------------------------------------------
 * `v1ProjectRaw()` 是**首轮 MVP 的持久化形状**（schemaVersion 1，没有 v2 字段），
 * 用于验证「旧版项目升级到 v2 后字段完整、无丢失」。
 */

export const TEST_PROJECT_ID = 'prj_test0001'

/** schemaVersion 1 的原始项目对象：故意不带 profile / materialRecords / understandingItems */
export function v1ProjectRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: TEST_PROJECT_ID,
    name: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
    short: '极端风浪事件',
    group: '第 1 组',
    members: '3 名成员',
    updated: '项目创建于今天 · 等待第一条证据',
    banner: '',
    projectRevision: 7,
    schemaVersion: 1,
    ms: [
      { t: '选题确认与文献调研', s: 'cur', p: 0, sub: '刚启动' },
      { t: '数据获取与预处理', s: 'todo', p: 0, sub: '未开始' },
    ],
    papers: [],
    weekly: [0, 1, 0, 0],
    materials: [{ name: '实验手册.pdf', type: '实验手册' }],
    chat: [],
    aiPapers: [],
    tasks: [
      {
        id: 'tsk_old0001',
        projectId: TEST_PROJECT_ID,
        title: '调研极端风浪事件的定义',
        status: 'doing',
        doneCriteria: '一页调研笔记',
        owner: null,
        suggestedOwner: '成员A',
        milestone: '选题确认与文献调研',
        why: '目标不清会导致返工',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-21T10:00:00.000Z',
      },
    ],
    evidenceRecords: [
      {
        id: 'evd_old0001',
        projectId: TEST_PROJECT_ID,
        submissionId: 'sub_old0001',
        taskId: 'tsk_old0001',
        didWhat: '查了 6 篇文献',
        foundWhat: '多数研究用有效波高第 95 百分位',
        stillUnsure: '分辨率差距怎么处理',
        attachmentName: null,
        author: null,
        createdAt: '2026-09-21T10:00:00.000Z',
      },
    ],
    doubtRecords: [
      {
        id: 'dbt_old0001',
        projectId: TEST_PROJECT_ID,
        text: 'ERA5 海浪场分辨率够不够',
        status: 'open',
        sourceEvidenceId: 'evd_old0001',
        createdAt: '2026-09-21T10:00:00.000Z',
        resolvedAt: null,
      },
    ],
    steps: [],
    evidence: [],
    doubts: [],
    ...overrides,
  }
}

/** 契约 14.3：一份服务端理解草稿（model 响应形状） */
export function draftFixture(overrides: Partial<UnderstandingDraft> = {}): UnderstandingDraft {
  const source = {
    materialId: 'mat_fixture01',
    materialName: '实验手册.md',
    materialVersion: 1,
    segmentId: 'seg_0',
    startLine: 1,
    endLine: 8,
  }

  return {
    goalCandidates: [{ itemId: 'cnd_goal_0', text: '复现极端风浪事件的识别流程', sources: [source] }],
    outcomeCandidates: [],
    dataNotes: [],
    methodNotes: [],
    openQuestions: [],
    ...overrides,
  }
}

/** 已迁移项目的一个最小可用实例：直接调用 store action 时用它兜底类型 */
export type StoreProject = Project
