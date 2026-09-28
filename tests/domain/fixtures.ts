import type { Doubt, Evidence, Milestone, Project, Task } from '@/types/platform'
import { PROJECT_SCHEMA_VERSION } from '@/types/platform'

/**
 * 测试夹具（不是测试文件）
 * ----------------------------------------------------------------------------
 * 只构造领域对象，不引入任何运行时依赖。
 * 每个工厂函数都返回**新对象**，单个用例只覆盖自己关心的字段，
 * 避免用例之间共享实例而互相污染。
 */

/** 固定时间戳，便于断言排序与格式化结果 */
export const FIXED_ISO = '2026-09-25T10:00:00.000Z'

export function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return { t: '选题确认与文献调研', s: 'cur', p: 10, sub: '刚启动', ...overrides }
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_1',
    projectId: 'prj_1',
    title: '调研极端风浪事件的定义',
    status: 'todo',
    doneCriteria: '一页调研笔记',
    // 契约 2.2：MVP 中线上 owner 恒为 null
    owner: null,
    suggestedOwner: '成员A',
    milestone: '选题确认与文献调研',
    why: '目标不清会导致返工',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  }
}

export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'evd_1',
    projectId: 'prj_1',
    submissionId: 'sub_1',
    taskId: 'tsk_1',
    didWhat: '读了 6 篇文献',
    foundWhat: '多数研究用 95 百分位做阈值',
    stillUnsure: null,
    attachmentName: null,
    author: null,
    createdAt: FIXED_ISO,
    ...overrides,
  }
}

export function makeDoubt(overrides: Partial<Doubt> = {}): Doubt {
  return {
    id: 'dbt_1',
    projectId: 'prj_1',
    text: 'ERA5 分辨率差距怎么处理',
    status: 'open',
    sourceEvidenceId: null,
    createdAt: FIXED_ISO,
    resolvedAt: null,
    ...overrides,
  }
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    projectId: 'prj_1',
    name: '测试项目',
    short: '测试',
    projectRevision: 1,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    group: '第 1 组',
    members: '3 名成员',
    updated: '',
    ms: [makeMilestone()],
    banner: '',
    papers: [],
    weekly: [0, 0, 0, 0],
    materials: [],
    chat: [],
    aiPapers: [],
    tasks: [],
    evidenceRecords: [],
    doubtRecords: [],
    // 下面三个是兼容投影，domain 用例里不需要真实值
    steps: [],
    evidence: [],
    doubts: [],
    ...overrides,
  }
}
