import { describe, expect, it } from 'vitest'
import {
  CLOUD_EXPORT_NOTICE,
  PROJECT_EXPORT_SCHEMA_VERSION,
  buildCloudProjectExport,
  buildLocalProjectExport,
  serializeCloudProject,
  serializeLocalProject,
  serializeProjectExport,
} from '@/domain/projectExport'
import type {
  ChatMessage,
  Material,
  Project,
  ProjectProfile,
  UnderstandingBlock,
} from '@/types/platform'
import { makeDoubt, makeEvidence, makeMilestone, makeProject, makeTask } from './fixtures'
import {
  makeCloudMaterial,
  makeCloudMilestone,
  makeCloudProject,
  makeCloudTask,
  makeEvidence as makeCloudEvidence,
  makeProgress,
} from '../support/v3Fixtures'

const FIXED_EXPORTED_AT = '2026-10-26T08:00:00.000Z'

const profile: ProjectProfile = {
  goal: '识别极端风浪事件',
  expectedOutcome: '一套可复现的分析流程',
  memberNames: ['李明', '王芳'],
  researchPeriod: '2026 秋',
  scope: '东海近岸',
  outOfScope: '全球尺度',
}

const material: Material = {
  materialId: 'mat_1',
  projectId: 'prj_1',
  name: '实验手册.md',
  type: 'md',
  size: 1024,
  encoding: 'utf-8',
  state: 'parsed',
  version: 2,
  createdAt: FIXED_EXPORTED_AT,
  updatedAt: FIXED_EXPORTED_AT,
  failureReason: null,
  needsReupload: false,
}

const understandingBlock: UnderstandingBlock = {
  id: 'ub_1',
  itemId: 'cnd_goal_0',
  kind: 'goalCandidates',
  materialId: 'mat_1',
  materialVersion: 2,
  content: '复现极端风浪事件的识别流程',
  sources: [
    {
      materialId: 'mat_1',
      materialName: '实验手册.md',
      materialVersion: 2,
      segmentId: 'seg_0',
      startLine: 1,
      endLine: 8,
    },
  ],
  status: 'confirmed',
  originalContent: '复现极端风浪事件的识别流程（原文）',
  createdAt: FIXED_EXPORTED_AT,
  updatedAt: FIXED_EXPORTED_AT,
}

const chatMessage: ChatMessage = {
  who: 'AI 顾问',
  text: '建议先确认数据口径',
  me: false,
  source: 'model',
  fallbackReason: null,
  citations: [
    {
      materialId: 'mat_1',
      materialName: '实验手册.md',
      materialVersion: 2,
      segmentId: 'seg_0',
      startLine: 1,
      endLine: 8,
    },
  ],
}

function fullProject(overrides: Partial<Project> = {}): Project {
  return makeProject({
    projectId: 'prj_1',
    name: '极端风浪事件分析',
    short: '极端风浪',
    projectRevision: 7,
    profile,
    ms: [makeMilestone(), makeMilestone({ t: '数据获取与预处理', s: 'todo', p: 0 })],
    tasks: [
      makeTask(),
      makeTask({ id: 'tsk_2', title: '整理样例数据', status: 'done', draftKey: 'draft_a' }),
    ],
    evidenceRecords: [makeEvidence(), makeEvidence({ id: 'evd_2', taskId: null })],
    doubtRecords: [makeDoubt(), makeDoubt({ id: 'dbt_2', status: 'resolved', resolvedAt: FIXED_EXPORTED_AT })],
    materialRecords: [material],
    understandingBlocks: [understandingBlock],
    chat: [chatMessage],
    ...overrides,
  })
}

/** 深遍历收集所有对象的键名（数组逐项下钻） */
function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
    return keys
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

const SENSITIVE_KEY_PATTERN =
  /(token|passw|pwd|cookie|secret|apikey|api_key|invite|credential|authorization|bearer|session)/i

describe('本地项目导出：字段完整性', () => {
  it('顶层带 schemaVersion / exportedAt / scope，项目主字段齐全', () => {
    const doc = buildLocalProjectExport({ project: fullProject(), exportedAt: FIXED_EXPORTED_AT })

    expect(doc.schemaVersion).toBe(PROJECT_EXPORT_SCHEMA_VERSION)
    expect(doc.exportedAt).toBe(FIXED_EXPORTED_AT)
    expect(doc.scope).toBe('local')
    expect(doc.project.projectId).toBe('prj_1')
    expect(doc.project.name).toBe('极端风浪事件分析')
    expect(doc.project.short).toBe('极端风浪')
    expect(doc.project.projectRevision).toBe(7)
    expect(doc.project.sourceSchemaVersion).toBe(3)
    expect(doc.project.profile).toEqual(profile)
    expect(doc.project.milestones).toHaveLength(2)
    expect(doc.project.tasks.map((task) => task.id)).toEqual(['tsk_1', 'tsk_2'])
    expect(doc.project.evidence.map((item) => item.id)).toEqual(['evd_1', 'evd_2'])
    expect(doc.project.doubts.map((item) => item.status)).toEqual(['open', 'resolved'])
    expect(doc.project.materials[0]?.materialId).toBe('mat_1')
    expect(doc.project.materials[0]?.version).toBe(2)
    expect(doc.project.understanding[0]?.status).toBe('confirmed')
    expect(doc.project.understanding[0]?.sources[0]?.startLine).toBe(1)
  })

  it('任务保留幂等键与展示字段，材料保留待重传标记', () => {
    const doc = buildLocalProjectExport({ project: fullProject(), exportedAt: FIXED_EXPORTED_AT })

    expect(doc.project.tasks[1]).toMatchObject({
      id: 'tsk_2',
      status: 'done',
      draftKey: 'draft_a',
      suggestedOwner: '成员A',
    })
    expect(doc.project.materials[0]).toMatchObject({ needsReupload: false, encoding: 'utf-8' })
  })

  it('不导出展示投影与模板派生字段，并在 meta.omitted 写明原因', () => {
    const doc = buildLocalProjectExport({ project: fullProject(), exportedAt: FIXED_EXPORTED_AT })
    const keys = collectKeys(doc)

    for (const key of ['steps', 'banner', 'weekly', 'group', 'members', 'aiPapers', 'papers']) {
      expect(keys).not.toContain(key)
    }
    expect(doc.meta.omitted.length).toBeGreaterThan(0)
    expect(doc.meta.omitted.join('')).toContain('展示投影')
    expect(doc.meta.pendingDecision.join('')).toContain('聊天记录')
  })

  it('不修改传入的项目对象（纯函数）', () => {
    const project = fullProject()
    const before = JSON.stringify(project)

    const doc = buildLocalProjectExport({
      project,
      exportedAt: FIXED_EXPORTED_AT,
      includeChat: true,
    })
    expect(JSON.stringify(project)).toBe(before)

    // 导出结果与输入不共享引用
    doc.project.tasks[0]!.title = '被改掉了'
    expect(project.tasks[0]?.title).toBe('调研极端风浪事件的定义')
  })
})

describe('本地项目导出：边界', () => {
  it('空项目（无任务/证据/材料/草稿）也能稳定导出', () => {
    const doc = buildLocalProjectExport({ project: makeProject(), exportedAt: FIXED_EXPORTED_AT })

    expect(doc.project.tasks).toEqual([])
    expect(doc.project.evidence).toEqual([])
    expect(doc.project.doubts).toEqual([])
    expect(doc.project.materials).toEqual([])
    expect(doc.project.understanding).toEqual([])
    expect(doc.project.chat).toBeUndefined()
    expect(() => JSON.parse(serializeProjectExport(doc))).not.toThrow()
  })

  it('不传 exportedAt 时使用当前时间（ISO 格式）', () => {
    const doc = buildLocalProjectExport({ project: makeProject() })
    expect(doc.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('聊天记录取舍（待裁决，默认关闭）', () => {
  it('默认不导出聊天，并在 omitted 中说明', () => {
    const doc = buildLocalProjectExport({ project: fullProject(), exportedAt: FIXED_EXPORTED_AT })

    expect(doc.project.chat).toBeUndefined()
    expect(doc.meta.omitted.join('')).toContain('聊天记录')
  })

  it('显式 includeChat 时按原样导出，引用随消息保留', () => {
    const doc = buildLocalProjectExport({
      project: fullProject(),
      exportedAt: FIXED_EXPORTED_AT,
      includeChat: true,
    })

    expect(doc.project.chat).toHaveLength(1)
    expect(doc.project.chat?.[0]?.text).toBe('建议先确认数据口径')
    expect(doc.project.chat?.[0]?.citations[0]?.segmentId).toBe('seg_0')
    expect(doc.meta.omitted.join('')).not.toContain('聊天记录 chat')
  })
})

describe('凭证字段零出现', () => {
  it('即使输入对象被塞入敏感字段，导出的深遍历也不含敏感 key', () => {
    const polluted = {
      ...fullProject(),
      // 模拟「模型以后新增了字段」或调用方误传：白名单组装必须挡住
      accessToken: 'super-secret-token-value',
      cookie: 'scp_session=abc',
      password: 'p@ssw0rd',
      inviteCode: 'INV-8888',
      apiKey: 'sk-live-000',
      sessionId: 'sess_1',
      profile: { ...profile, credentialRef: 'cred_1' },
      tasks: [{ ...makeTask(), authToken: 'tok_in_task' }],
      materialRecords: [{ ...material, downloadUrl: 'https://x?sig=secret' }],
      chat: [{ ...chatMessage, rawAuthHeader: 'Bearer abc' }],
    } as unknown as Project

    const doc = buildLocalProjectExport({ project: polluted, exportedAt: FIXED_EXPORTED_AT })
    const keys = collectKeys(doc)
    const text = serializeProjectExport(doc)

    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(SENSITIVE_KEY_PATTERN.test(key)).toBe(false)
    }
    expect(keys).not.toContain('ownerUserId')
    for (const leaked of ['super-secret-token-value', 'scp_session=abc', 'p@ssw0rd', 'INV-8888', 'sk-live-000', 'cred_1', 'tok_in_task', 'Bearer abc', 'sig=secret']) {
      expect(text).not.toContain(leaked)
    }
  })
})

describe('云端项目导出：投影快照', () => {
  it('显式标注 cloud-projection 与 exportedAt，并带中文免责说明', () => {
    const doc = buildCloudProjectExport({
      project: makeCloudProject({ projectId: 'prj_9', projectRevision: 4 }),
      exportedAt: FIXED_EXPORTED_AT,
    })

    expect(doc.schemaVersion).toBe(PROJECT_EXPORT_SCHEMA_VERSION)
    expect(doc.scope).toBe('cloud-projection')
    expect(doc.exportedAt).toBe(FIXED_EXPORTED_AT)
    expect(doc.notice).toBe(CLOUD_EXPORT_NOTICE)
    expect(doc.notice).toContain('不是完整备份')
    expect(doc.project.projectId).toBe('prj_9')
    expect(doc.project.projectRevision).toBe(4)
  })

  it('未加载的列表标 loaded: false 且 items 为 null，不用空数组伪装「没有数据」', () => {
    const doc = buildCloudProjectExport({
      project: makeCloudProject(),
      exportedAt: FIXED_EXPORTED_AT,
    })

    expect(doc.lists.tasks).toEqual({ loaded: false, items: null })
    expect(doc.lists.evidence).toEqual({ loaded: false, items: null })
    expect(doc.lists.progress).toEqual({ loaded: false, items: null })
    expect(doc.lists.materials).toEqual({ loaded: false, items: null })
  })

  it('已加载但确实为空时是 loaded: true + 空数组，与未加载区分开', () => {
    const doc = buildCloudProjectExport({
      project: makeCloudProject(),
      tasks: [],
      evidence: [],
      exportedAt: FIXED_EXPORTED_AT,
    })

    expect(doc.lists.tasks).toEqual({ loaded: true, items: [] })
    expect(doc.lists.evidence).toEqual({ loaded: true, items: [] })
    expect(doc.lists.progress.loaded).toBe(false)
  })

  it('已加载的任务/证据/进展/材料按字段白名单导出，且不含项目 ID 之外的敏感项', () => {
    const doc = buildCloudProjectExport({
      project: makeCloudProject({
        projectId: 'prj_9',
        milestones: [makeCloudMilestone({ milestoneId: 'ms_1' })],
      }),
      tasks: [makeCloudTask({ taskId: 'tsk_9', projectId: 'prj_9' })],
      evidence: [makeCloudEvidence({ evidenceId: 'evd_9', projectId: 'prj_9' })],
      progress: [makeProgress({ progressId: 'prg_9' })],
      materials: [makeCloudMaterial({ materialId: 'mat_9' })],
      exportedAt: FIXED_EXPORTED_AT,
    })

    expect(doc.project.milestones[0]?.milestoneId).toBe('ms_1')
    expect(doc.lists.tasks.loaded).toBe(true)
    if (doc.lists.tasks.loaded) expect(doc.lists.tasks.items[0]?.taskId).toBe('tsk_9')
    if (doc.lists.evidence.loaded) expect(doc.lists.evidence.items[0]?.evidenceId).toBe('evd_9')
    if (doc.lists.progress.loaded) expect(doc.lists.progress.items[0]?.progressId).toBe('prg_9')
    if (doc.lists.materials.loaded) expect(doc.lists.materials.items[0]?.materialId).toBe('mat_9')

    const keys = collectKeys(doc)
    expect(keys).not.toContain('ownerUserId')
    expect(keys).not.toContain('chat')
    expect(keys).not.toContain('segments')
    for (const key of keys) expect(SENSITIVE_KEY_PATTERN.test(key)).toBe(false)
  })
})

describe('序列化可还原', () => {
  it('本地导出 JSON.parse 后与原对象深相等', () => {
    const doc = buildLocalProjectExport({
      project: fullProject(),
      exportedAt: FIXED_EXPORTED_AT,
      includeChat: true,
    })
    const text = serializeProjectExport(doc)

    expect(typeof text).toBe('string')
    expect(JSON.parse(text)).toEqual(doc)
    expect(text).toContain('\n  "schemaVersion"')
  })

  it('云端导出 JSON.parse 后与原对象深相等', () => {
    const doc = buildCloudProjectExport({
      project: makeCloudProject(),
      tasks: [makeCloudTask()],
      exportedAt: FIXED_EXPORTED_AT,
    })

    expect(JSON.parse(serializeProjectExport(doc))).toEqual(doc)
  })

  it('两个便捷入口与通用序列化结果一致', () => {
    const localInput = { project: fullProject(), exportedAt: FIXED_EXPORTED_AT }
    const cloudInput = { project: makeCloudProject(), exportedAt: FIXED_EXPORTED_AT }

    expect(serializeLocalProject(localInput)).toBe(
      serializeProjectExport(buildLocalProjectExport(localInput)),
    )
    expect(serializeCloudProject(cloudInput)).toBe(
      serializeProjectExport(buildCloudProjectExport(cloudInput)),
    )
  })
})
