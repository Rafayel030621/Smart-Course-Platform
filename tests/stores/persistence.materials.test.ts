import { describe, expect, it } from 'vitest'
import { PROJECT_SCHEMA_VERSION } from '@/types/platform'
import { emptyProjectProfile } from '@/domain/materials'
import {
  CURRENT_SCHEMA_VERSION,
  STORAGE_KEY_CURRENT_PROJECT_ID,
  STORAGE_KEY_PROJECTS,
  loadPersistedState,
  migrateProject,
  savePersistedState,
} from '@/stores/persistence'
import { TEST_PROJECT_ID, v1ProjectRaw } from '../fixtures/project'

/**
 * v2 / v3 持久化与迁移（契约 12 / 13 / 14）
 * ----------------------------------------------------------------------------
 * 三条硬性验收：
 *   1. 旧版（schemaVersion 1）项目升级到当前结构后字段完整、旧数据一条不丢；
 *   2. v2（`block`/`text`/`understandingItems`/片段映射）数据能升到 v3 且内容不丢；
 *   3. 迁移是幂等的——同一份数据迁移两次结果完全一致。
 */

const MATERIAL_ID = 'mat_fixture01'

const materialRaw = {
  materialId: MATERIAL_ID,
  projectId: TEST_PROJECT_ID,
  name: '实验手册.md',
  type: 'md',
  size: 2048,
  encoding: 'utf-8',
  state: 'parsed',
  version: 1,
  createdAt: '2026-10-12T10:12:00+08:00',
  updatedAt: '2026-10-12T10:12:00+08:00',
  failureReason: null,
}

const blockRaw = {
  itemId: 'cnd_goal_0',
  kind: 'goalCandidates',
  materialId: MATERIAL_ID,
  materialVersion: 1,
  content: '复现极端风浪事件的识别流程',
  sources: [
    {
      materialId: MATERIAL_ID,
      materialName: '实验手册.md',
      materialVersion: 1,
      segmentId: 'seg_0',
      startLine: 1,
      endLine: 8,
    },
  ],
  status: 'pending',
  originalContent: '复现极端风浪事件的识别流程',
  createdAt: '2026-10-12T10:20:00+08:00',
  updatedAt: '2026-10-12T10:20:00+08:00',
}

/** v3 形态：材料 + 扁平片段 + 理解草稿 */
const v3Extras = {
  schemaVersion: 3,
  materialRecords: [materialRaw],
  materialSegments: [
    { segmentId: 'seg_0', materialId: MATERIAL_ID, materialVersion: 1, index: 0, startLine: 1, endLine: 8, text: '# 实验手册' },
    { segmentId: 'seg_1', materialId: MATERIAL_ID, materialVersion: 1, index: 1, startLine: 10, endLine: 24, text: '## 数据说明' },
  ],
  understandingBlocks: [blockRaw],
}

/** v2 形态：`block` / `text` / `understandingItems` + 片段映射（需要迁移） */
const v2Extras = {
  schemaVersion: 2,
  materialRecords: [materialRaw],
  materialSegments: {
    [MATERIAL_ID]: [
      { segmentId: 'seg_0', index: 0, startLine: 1, endLine: 8, text: '# 实验手册' },
      { segmentId: 'seg_1', index: 1, startLine: 10, endLine: 24, text: '## 数据说明' },
    ],
  },
  understandingItems: [
    {
      itemId: 'cnd_goal_0',
      block: 'goalCandidates',
      materialId: MATERIAL_ID,
      materialVersion: 1,
      text: '复现极端风浪事件的识别流程',
      sources: blockRaw.sources,
      status: 'pending',
      originalText: '复现极端风浪事件的识别流程',
      createdAt: '2026-10-12T10:20:00+08:00',
      updatedAt: '2026-10-12T10:20:00+08:00',
    },
  ],
}

/* ---------------------------------------------------------- 旧数据迁移 */

describe('migrateProject：v1 → 当前结构', () => {
  it('补齐 v2 字段，且旧数据一条不丢', () => {
    const project = migrateProject(v1ProjectRaw())
    expect(project).not.toBeNull()
    if (project === null) return

    // v2 新字段：全部是默认值，不是 undefined
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(PROJECT_SCHEMA_VERSION)
    expect(project.profile).toEqual(emptyProjectProfile())
    expect(project.materialSegments).toEqual([])
    expect(project.understandingBlocks).toEqual([])

    // 旧数据保留
    expect(project.projectId).toBe(TEST_PROJECT_ID)
    expect(project.projectRevision).toBe(7)
    expect(project.tasks).toHaveLength(1)
    expect(project.tasks[0].id).toBe('tsk_old0001')
    expect(project.evidenceRecords).toHaveLength(1)
    expect(project.doubtRecords).toHaveLength(1)
    // 旧展示字段不动（旧页面还在读）
    expect(project.materials).toEqual([{ name: '实验手册.pdf', type: '实验手册' }])
    expect(project.members).toBe('3 名成员')
  })

  it('v1 的占位材料转成「仅登记」材料记录：状态未知、需要重新上传', () => {
    const project = migrateProject(v1ProjectRaw())
    expect(project).not.toBeNull()
    if (project === null) return

    const legacy = project.materialRecords.find((material) => material.materialId === 'mat_legacy_1')
    expect(legacy).toBeDefined()
    expect(legacy?.name).toBe('实验手册.pdf')
    expect(legacy?.state).toBeNull()
    expect(legacy?.needsReupload).toBe(true)
    // 旧字段仍然保留，新字段只是新增
    expect(project.materials).toHaveLength(1)
  })

  it('v2 数据升到 v3：block→kind、text→content、understandingItems→understandingBlocks、片段映射转扁平', () => {
    const project = migrateProject(v1ProjectRaw(v2Extras))
    expect(project).not.toBeNull()
    if (project === null) return

    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(project.materialSegments).toHaveLength(2)
    expect(project.materialSegments[0]).toMatchObject({
      segmentId: 'seg_0',
      materialId: MATERIAL_ID,
      materialVersion: 1,
    })
    expect(project.understandingBlocks).toHaveLength(1)
    expect(project.understandingBlocks[0].kind).toBe('goalCandidates')
    expect(project.understandingBlocks[0].content).toBe('复现极端风浪事件的识别流程')
    expect(project.understandingBlocks[0].originalContent).toBe('复现极端风浪事件的识别流程')
    expect(project.understandingBlocks[0].status).toBe('pending')
  })

  it('迁移是幂等的：同一份数据迁移两次结果完全一致（v3 数据再跑一遍也不变）', () => {
    for (const raw of [v1ProjectRaw(v3Extras), v1ProjectRaw(v2Extras), v1ProjectRaw()]) {
      const once = migrateProject(raw)
      const twice = migrateProject(JSON.parse(JSON.stringify(once)))
      expect(twice).toEqual(once)
    }
  })

  it('迁移后「存 → 读 → 再存」结果稳定（刷新不改变数据）', () => {
    const project = migrateProject(v1ProjectRaw(v2Extras))
    expect(project).not.toBeNull()
    if (project === null) return

    expect(savePersistedState([project], TEST_PROJECT_ID).ok).toBe(true)
    const first = loadPersistedState()
    // 再落盘一次，模拟刷新后再写入
    expect(savePersistedState(first.projects, first.currentProjectId).ok).toBe(true)
    const second = loadPersistedState()

    expect(second.currentProjectId).toBe(first.currentProjectId)
    expect(second.projects[0]).toEqual(first.projects[0])
    // 旧项目三件套与项目 ID 全程保留
    expect(second.projects[0].projectId).toBe(TEST_PROJECT_ID)
    expect(second.projects[0].tasks).toHaveLength(1)
    expect(second.projects[0].evidenceRecords).toHaveLength(1)
    expect(second.projects[0].doubtRecords).toHaveLength(1)
  })

  it('v3 数据往返一次（存 → 读）内容不变', () => {
    const project = migrateProject(v1ProjectRaw(v3Extras))
    expect(project).not.toBeNull()
    if (project === null) return

    const saved = savePersistedState([project], TEST_PROJECT_ID)
    expect(saved.ok).toBe(true)

    const restored = loadPersistedState()
    const loaded = restored.projects[0]
    expect(restored.currentProjectId).toBe(TEST_PROJECT_ID)
    expect(loaded.profile).toEqual(project.profile)
    expect(loaded.materialRecords).toEqual(project.materialRecords)
    expect(loaded.materialSegments).toEqual(project.materialSegments)
    expect(loaded.understandingBlocks).toEqual(project.understandingBlocks)
  })

  it('来自更新版本的数据（schemaVersion 高于当前）直接丢弃', () => {
    expect(migrateProject(v1ProjectRaw({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }))).toBeNull()
  })

  it('坏材料记录只丢这一条，项目仍然可用', () => {
    const project = migrateProject(
      v1ProjectRaw({
        schemaVersion: 3,
        materialRecords: [
          materialRaw,
          { ...materialRaw, materialId: 'mat_docx', name: '  ' },
          { name: '缺 materialId.md', type: 'md' },
        ],
      }),
    )
    expect(project).not.toBeNull()
    if (project === null) return
    // 只有一条合法材料 + v1 占位材料转出来的那条
    expect(project.materialRecords.map((item) => item.materialId)).toEqual([MATERIAL_ID, 'mat_legacy_1'])
  })

  it('草稿条目的块名非法、正文为空、来源全部无效时都丢弃', () => {
    const project = migrateProject(
      v1ProjectRaw({
        ...v3Extras,
        understandingBlocks: [
          blockRaw,
          { ...blockRaw, itemId: 'cnd_bad_kind', kind: 'unknownKind' },
          { ...blockRaw, itemId: 'cnd_empty_content', content: '   ' },
          { ...blockRaw, itemId: 'cnd_no_source', sources: [] },
          { ...blockRaw, itemId: 'cnd_bad_source', sources: [{ segmentId: 'seg_0' }] },
        ],
      }),
    )
    expect(project).not.toBeNull()
    if (project === null) return
    expect(project.understandingBlocks.map((block) => block.itemId)).toEqual(['cnd_goal_0'])
    // 本地唯一 id 由 (materialId, kind, itemId) 稳定派生
    expect(project.understandingBlocks[0].id).toBe(`${MATERIAL_ID}::goalCandidates::cnd_goal_0`)
  })

  it('契约 14.5 第 4 条：材料已升版时旧版本的草稿引用作废', () => {
    const stale = { ...blockRaw, itemId: 'cnd_old_version', materialVersion: 1 }
    const project = migrateProject(
      v1ProjectRaw({
        ...v3Extras,
        materialRecords: [{ ...materialRaw, version: 2 }],
        understandingBlocks: [stale],
      }),
    )
    expect(project).not.toBeNull()
    if (project === null) return
    expect(project.materialRecords[0].version).toBe(2)
    expect(project.understandingBlocks).toEqual([])
  })

  it('同一 materialId 多版本并存时只保留最新版本，旧版本片段一并丢弃', () => {
    const project = migrateProject(
      v1ProjectRaw({
        ...v3Extras,
        materialRecords: [
          { ...materialRaw, version: 1 },
          { ...materialRaw, version: 3 },
          { ...materialRaw, version: 2 },
        ],
      }),
    )
    expect(project).not.toBeNull()
    if (project === null) return
    expect(project.materialRecords[0].version).toBe(3)
    // 留下的片段（version 1）属于旧版本 → 全部丢弃
    expect(project.materialSegments).toEqual([])
    expect(project.materialRecords[0].needsReupload).toBe(true)
  })

  it('解析失败的材料不保留片段', () => {
    const project = migrateProject(
      v1ProjectRaw({
        ...v3Extras,
        materialRecords: [
          { ...materialRaw, state: 'parse_failed', failureReason: '编码无法识别' },
        ],
      }),
    )
    expect(project).not.toBeNull()
    if (project === null) return
    expect(project.materialSegments).toEqual([])
    expect(project.materialRecords[0].needsReupload).toBe(true)
    expect(project.materialRecords[0].failureReason).toBe('编码无法识别')
  })
})

/* -------------------------------------------------------------- 读取容错 */

describe('loadPersistedState：坏数据不进门', () => {
  it('信封版本高于当前版本时清空', () => {
    window.localStorage.setItem(
      STORAGE_KEY_PROJECTS,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1, projects: [v1ProjectRaw()] }),
    )
    expect(loadPersistedState()).toEqual({ projects: [], currentProjectId: null })
    expect(window.localStorage.getItem(STORAGE_KEY_PROJECTS)).toBeNull()
  })

  it('JSON 损坏时清空', () => {
    window.localStorage.setItem(STORAGE_KEY_PROJECTS, '{不是 JSON')
    expect(loadPersistedState()).toEqual({ projects: [], currentProjectId: null })
  })

  it('坏的单条项目只丢这一条，其余项目照常读出', () => {
    const good = migrateProject(v1ProjectRaw())
    const second = migrateProject(v1ProjectRaw({ projectId: 'prj_second0002', name: '第二个项目' }))
    if (good === null || second === null) throw new Error('fixture 迁移失败')

    window.localStorage.setItem(
      STORAGE_KEY_PROJECTS,
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        projects: [
          good,
          '不是对象',
          {},
          { projectId: 'prj_future', name: '来自更新版本', schemaVersion: CURRENT_SCHEMA_VERSION + 1 },
          second,
        ],
      }),
    )

    const restored = loadPersistedState()
    expect(restored.projects.map((item) => item.projectId)).toEqual([TEST_PROJECT_ID, 'prj_second0002'])
    expect(restored.currentProjectId).toBe(TEST_PROJECT_ID)
  })

  it('项目列表不是数组时清空（不抛异常）', () => {
    window.localStorage.setItem(
      STORAGE_KEY_PROJECTS,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, projects: '不是数组' }),
    )
    expect(loadPersistedState()).toEqual({ projects: [], currentProjectId: null })
  })

  it('当前项目 id 指向已不存在的项目时回退到第一个项目', () => {
    const project = migrateProject(v1ProjectRaw())
    if (project === null) throw new Error('fixture 迁移失败')
    savePersistedState([project], 'prj_not_exists')
    expect(loadPersistedState().currentProjectId).toBe(TEST_PROJECT_ID)
  })
})

/* -------------------------------------------------------------- 写入失败 */

describe('savePersistedState：写入失败', () => {
  it('localStorage 抛错时返回 STORAGE_FULL，不抛出异常', () => {
    const original = window.localStorage
    const throwing = {
      ...original,
      setItem: (): void => {
        throw new Error('QuotaExceededError')
      },
    }
    Object.defineProperty(window, 'localStorage', { value: throwing, configurable: true })

    try {
      const project = migrateProject(v1ProjectRaw())
      if (project === null) throw new Error('fixture 迁移失败')
      const result = savePersistedState([project], TEST_PROJECT_ID)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('STORAGE_FULL')
    } finally {
      Object.defineProperty(window, 'localStorage', { value: original, configurable: true })
    }
  })

  it('当前项目 id 单独存一份，切换项目后刷新能恢复', () => {
    const project = migrateProject(v1ProjectRaw())
    if (project === null) throw new Error('fixture 迁移失败')
    savePersistedState([project], null)
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY_CURRENT_PROJECT_ID) ?? 'null')).toBeNull()
  })
})
