import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  STORAGE_KEY_CURRENT_PROJECT_ID,
  STORAGE_KEY_PROJECTS,
  clearPersistedState,
  loadPersistedState,
  migrateProject,
  savePersistedState,
} from '@/stores/persistence'
import { makeEvidence, makeProject, makeTask } from '../domain/fixtures'

/** 内存 Storage 替身：不碰用户真实 localStorage，用例之间互不影响 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  }
}

/**
 * 换掉全局 localStorage。
 * jsdom 里 `window` 与 `globalThis` 是同一个对象，因此 `vi.stubGlobal('localStorage', …)`
 * 同时覆盖了 `window.localStorage`，`getStorage()` 会读到替换后的实现。
 */
function useStorage(storage: Storage): void {
  vi.stubGlobal('localStorage', storage)
}

/** 写一份原始信封；传入字符串时按原样写入，便于构造坏 JSON */
function writeEnvelope(value: unknown, key: string = STORAGE_KEY_PROJECTS): void {
  localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
}

function writeCurrentProjectId(value: unknown): void {
  localStorage.setItem(STORAGE_KEY_CURRENT_PROJECT_ID, JSON.stringify(value))
}

afterEach(() => {
  // 还原被替换的全局对象与 mock；真实 localStorage 由 tests/setup.ts 清空
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('存储键与版本常量', () => {
  it('使用约定的 key 与当前 schemaVersion', () => {
    expect(STORAGE_KEY_PROJECTS).toBe('scp.mvp.projects')
    expect(STORAGE_KEY_CURRENT_PROJECT_ID).toBe('scp.mvp.currentProjectId')
    // 决策记录（交接文档 §10.3/§11.2）：v2 材料与理解草稿路线，schemaVersion 3
    expect(CURRENT_SCHEMA_VERSION).toBe(3)
  })
})

describe('savePersistedState：写入', () => {
  it('写入带 schemaVersion 的信封，并单独记录当前项目 id', () => {
    const project = makeProject({ projectId: 'prj_1' })

    const result = savePersistedState([project], 'prj_1')

    expect(result.ok).toBe(true)
    const envelope = JSON.parse(localStorage.getItem(STORAGE_KEY_PROJECTS) ?? '') as {
      schemaVersion: number
      projects: unknown[]
    }
    expect(envelope.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(envelope.projects).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_CURRENT_PROJECT_ID) ?? '')).toBe('prj_1')
  })

  it('不把兼容投影写入磁盘（读取时会重建）', () => {
    const project = makeProject({
      steps: [{ t: 'x', owner: 'y', why: 'z', done: 'w' }],
      evidence: [{ time: '09-25 10:00', text: 't', who: 'w' }],
      doubts: ['疑问'],
    })

    savePersistedState([project], project.projectId)

    const envelope = JSON.parse(localStorage.getItem(STORAGE_KEY_PROJECTS) ?? '') as {
      projects: Array<Record<string, unknown>>
    }
    expect(envelope.projects[0]?.steps).toEqual([])
    expect(envelope.projects[0]?.evidence).toEqual([])
    expect(envelope.projects[0]?.doubts).toEqual([])
  })

  it('包含项目真实状态（任务、证据、疑问）', () => {
    const project = makeProject({
      projectId: 'prj_1',
      tasks: [makeTask({ id: 'tsk_1' })],
      evidenceRecords: [makeEvidence({ id: 'evd_1' })],
      doubtRecords: [],
    })

    savePersistedState([project], project.projectId)

    const envelope = JSON.parse(localStorage.getItem(STORAGE_KEY_PROJECTS) ?? '') as {
      projects: Array<{ tasks: unknown[]; evidenceRecords: unknown[] }>
    }
    expect(envelope.projects[0]?.tasks).toHaveLength(1)
    expect(envelope.projects[0]?.evidenceRecords).toHaveLength(1)
  })

  it('localStorage 不可用时返回 STORAGE_FULL', () => {
    vi.stubGlobal('localStorage', undefined)

    const result = savePersistedState([makeProject()], 'prj_1')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('STORAGE_FULL')
      expect(typeof result.message).toBe('string')
    }
  })

  it('写入抛错（配额满）时返回 STORAGE_FULL，不抛出异常', () => {
    useStorage(createMemoryStorage())
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    const result = savePersistedState([makeProject()], 'prj_1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STORAGE_FULL')
  })

  it('允许当前项目为 null', () => {
    const result = savePersistedState([makeProject()], null)

    expect(result.ok).toBe(true)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_CURRENT_PROJECT_ID) ?? '')).toBeNull()
  })
})

describe('loadPersistedState：读取与容错', () => {
  it('没有数据时返回空状态', () => {
    expect(loadPersistedState()).toEqual({ projects: [], currentProjectId: null })
  })

  it('读回已保存的项目与当前项目 id', () => {
    savePersistedState(
      [makeProject({ projectId: 'prj_1', name: '一' }), makeProject({ projectId: 'prj_2', name: '二' })],
      'prj_2',
    )

    const state = loadPersistedState()

    expect(state.projects.map((item) => item.projectId)).toEqual(['prj_1', 'prj_2'])
    expect(state.currentProjectId).toBe('prj_2')
  })

  it('当前项目 id 指向不存在的项目时回退到第一个', () => {
    savePersistedState([makeProject({ projectId: 'prj_1' })], 'prj_1')
    writeCurrentProjectId('prj_gone')

    expect(loadPersistedState().currentProjectId).toBe('prj_1')
  })

  it('没有记录当前项目时回退到第一个项目', () => {
    writeEnvelope({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_1', name: '一', schemaVersion: CURRENT_SCHEMA_VERSION },
        { projectId: 'prj_2', name: '二', schemaVersion: CURRENT_SCHEMA_VERSION },
      ],
    })

    expect(loadPersistedState().currentProjectId).toBe('prj_1')
  })

  it('JSON 损坏时清空存储并返回空状态', () => {
    writeEnvelope('{ 这不是 JSON')

    expect(loadPersistedState()).toEqual({ projects: [], currentProjectId: null })
    expect(localStorage.getItem(STORAGE_KEY_PROJECTS)).toBeNull()
  })

  it('顶层结构不是数组也不是信封时清空存储', () => {
    writeEnvelope({ unexpected: true })

    expect(loadPersistedState()).toEqual({ projects: [], currentProjectId: null })
    expect(localStorage.getItem(STORAGE_KEY_PROJECTS)).toBeNull()
  })

  it('信件版本高于当前版本时拒绝解析并清空', () => {
    writeEnvelope({
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      projects: [{ projectId: 'prj_1', name: '来自更新版本' }],
    })

    expect(loadPersistedState()).toEqual({ projects: [], currentProjectId: null })
    expect(localStorage.getItem(STORAGE_KEY_PROJECTS)).toBeNull()
  })

  it('单个项目版本高于当前版本时只丢弃该项目', () => {
    writeEnvelope({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_ok', name: '正常', schemaVersion: CURRENT_SCHEMA_VERSION },
        { projectId: 'prj_future', name: '未来', schemaVersion: CURRENT_SCHEMA_VERSION + 5 },
      ],
    })

    expect(loadPersistedState().projects.map((item) => item.projectId)).toEqual(['prj_ok'])
  })

  it('缺少 projectId 或 name 的项目被丢弃', () => {
    writeEnvelope({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [
        { name: '没有 id', schemaVersion: CURRENT_SCHEMA_VERSION },
        { projectId: 'prj_no_name', schemaVersion: CURRENT_SCHEMA_VERSION },
        { projectId: 'prj_ok', name: '正常', schemaVersion: CURRENT_SCHEMA_VERSION },
      ],
    })

    expect(loadPersistedState().projects.map((item) => item.projectId)).toEqual(['prj_ok'])
  })

  it('坏的任务 / 证据 / 疑问记录逐条丢弃，好记录保留', () => {
    writeEnvelope({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [
        {
          projectId: 'prj_1',
          name: '项目',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          tasks: [{ id: 'tsk_ok', title: '正常任务' }, { title: '没有 id' }, 'not-an-object'],
          evidenceRecords: [
            { id: 'evd_ok', didWhat: '正常证据' },
            { id: 'evd_bad', didWhat: '   ' },
          ],
          doubtRecords: [{ id: 'dbt_ok', text: '正常疑问' }, { id: 'dbt_bad', text: '' }],
        },
      ],
    })

    const [project] = loadPersistedState().projects

    expect(project?.tasks.map((item) => item.id)).toEqual(['tsk_ok'])
    expect(project?.evidenceRecords.map((item) => item.id)).toEqual(['evd_ok'])
    expect(project?.doubtRecords.map((item) => item.id)).toEqual(['dbt_ok'])
  })

  it('版本缺失的旧数据按低版本迁移补齐字段', () => {
    writeEnvelope({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [{ projectId: 'prj_legacy', name: '旧项目' }],
    })

    const [project] = loadPersistedState().projects

    expect(project).toMatchObject({
      projectId: 'prj_legacy',
      name: '旧项目',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projectRevision: 1,
      weekly: [0, 0, 0, 0],
      tasks: [],
      evidenceRecords: [],
      doubtRecords: [],
    })
  })

  it('projectRevision 缺失或非法时归一为 1', () => {
    writeEnvelope({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [
        { projectId: 'prj_a', name: 'A', projectRevision: 0 },
        { projectId: 'prj_b', name: 'B', projectRevision: 'x' },
        { projectId: 'prj_c', name: 'C', projectRevision: 12 },
      ],
    })

    const revisions = loadPersistedState().projects.map((item) => item.projectRevision)
    expect(revisions).toEqual([1, 1, 12])
  })
})

describe('v1 → v2 迁移：任务新增 draftKey', () => {
  it('v1 数据可以原样恢复，旧任务补 draftKey 为 null', () => {
    writeEnvelope({
      schemaVersion: 1,
      projects: [
        {
          projectId: 'prj_v1',
          name: '旧项目',
          schemaVersion: 1,
          projectRevision: 3,
          tasks: [
            { id: 'tsk_1', title: '旧任务', status: 'doing' },
            { id: 'tsk_2', title: '已完成的任务', status: 'done' },
          ],
        },
      ],
    })

    const [project] = loadPersistedState().projects

    expect(project?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(project?.tasks.map((item) => item.id)).toEqual(['tsk_1', 'tsk_2'])
    // 决策记录：schemaVersion 3 路线不使用任务 draftKey（材料与理解草稿见 §10.3）
    expect(project?.tasks[0]?.status).toBe('doing')
    expect(project?.tasks[1]?.status).toBe('done')
    expect(project?.projectRevision).toBe(3)
  })

  it('migrateProject 容忍任务上的未知字段（旧数据的 draftKey 被忽略，任务原样保留）', () => {
    const migrated = migrateProject({
      projectId: 'prj_1',
      name: '项目',
      schemaVersion: 1,
      tasks: [
        { id: 'tsk_old', title: '旧任务' },
        { id: 'tsk_new', title: '新任务', draftKey: '["T",null,null,[],[]]' },
      ],
    })

    expect(migrated?.tasks.map((item) => item.id)).toEqual(['tsk_old', 'tsk_new'])
    expect(migrated?.tasks.map((item) => item.title)).toEqual(['旧任务', '新任务'])
  })

  it('迁移后再次保存时信封版本升为当前版本', () => {
    writeEnvelope({
      schemaVersion: 1,
      projects: [{ projectId: 'prj_v1', name: '旧项目', schemaVersion: 1 }],
    })

    const state = loadPersistedState()
    savePersistedState(state.projects, state.currentProjectId)

    const envelope = JSON.parse(localStorage.getItem(STORAGE_KEY_PROJECTS) ?? '') as {
      schemaVersion: number
    }
    expect(envelope.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('高于当前版本的数据仍被拒绝（新增迁移分支不放宽版本上限）', () => {
    expect(
      migrateProject({ projectId: 'prj_x', name: 'X', schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    ).toBeNull()
  })
})

describe('migrateProject：归一化', () => {
  it('非对象返回 null', () => {
    expect(migrateProject(null)).toBeNull()
    expect(migrateProject('x')).toBeNull()
    expect(migrateProject([])).toBeNull()
  })

  it('线上 owner 恒为 null，模板中的建议负责人迁到展示字段', () => {
    const migrated = migrateProject({
      projectId: 'prj_1',
      name: '项目',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tasks: [{ id: 'tsk_1', title: 'T', owner: '成员A' }],
    })

    expect(migrated?.tasks[0]?.owner).toBeNull()
    expect(migrated?.tasks[0]?.suggestedOwner).toBe('成员A')
  })

  it('已存在 suggestedOwner 时优先保留它', () => {
    const migrated = migrateProject({
      projectId: 'prj_1',
      name: '项目',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tasks: [{ id: 'tsk_1', title: 'T', owner: '旧的', suggestedOwner: '成员B' }],
    })

    expect(migrated?.tasks[0]?.suggestedOwner).toBe('成员B')
  })

  it('unknown 状态归一为 todo，resolvedAt 等信息保留', () => {
    const migrated = migrateProject({
      projectId: 'prj_1',
      name: '项目',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      tasks: [{ id: 'tsk_1', title: 'T', status: 'weird' }],
      doubtRecords: [{ id: 'dbt_1', text: 'Q', status: 'resolved', resolvedAt: '2026-09-26T08:30:00.000Z' }],
    })

    expect(migrated?.tasks[0]?.status).toBe('todo')
    expect(migrated?.doubtRecords[0]?.status).toBe('resolved')
    expect(migrated?.doubtRecords[0]?.resolvedAt).toBe('2026-09-26T08:30:00.000Z')
  })

  it('兼容投影被清空，交由调用方重建', () => {
    const migrated = migrateProject({
      projectId: 'prj_1',
      name: '项目',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      steps: [{ t: 'x', owner: 'y', why: 'z', done: 'w' }],
      evidence: [{ time: 'a', text: 'b', who: 'c' }],
      doubts: ['d'],
    })

    expect(migrated?.steps).toEqual([])
    expect(migrated?.evidence).toEqual([])
    expect(migrated?.doubts).toEqual([])
  })
})

describe('migrateProject：聊天记录与引用（契约 23.7）', () => {
  const legacyChat = [
    { who: '我', me: true, text: '旧问题：下一步做什么？' },
    { who: 'AI 模型', me: false, text: '旧回答：先核对数据。', source: 'model', fallbackReason: null },
  ]

  it('旧记录没有 citations：消息一条不丢，引用补空数组', () => {
    const migrated = migrateProject({
      projectId: 'prj_1',
      name: '项目',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      chat: legacyChat,
    })

    expect(migrated?.chat).toHaveLength(2)
    expect(migrated?.chat[0]).toMatchObject({ text: '旧问题：下一步做什么？', citations: [] })
    expect(migrated?.chat[1]).toMatchObject({
      text: '旧回答：先核对数据。',
      source: 'model',
      citations: [],
    })
  })

  it('从旧 localStorage 加载：没有 citations 的历史消息一条不丢，引用补空数组', () => {
    writeEnvelope({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [
        {
          projectId: 'prj_legacy_chat',
          name: '旧项目',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          chat: legacyChat,
        },
      ],
    })
    writeCurrentProjectId('prj_legacy_chat')

    const loaded = loadPersistedState()

    expect(loaded.projects).toHaveLength(1)
    expect(loaded.projects[0]?.chat).toEqual([
      {
        who: '我',
        text: '旧问题：下一步做什么？',
        me: true,
        fallbackReason: null,
        citations: [],
      },
      {
        who: 'AI 模型',
        text: '旧回答：先核对数据。',
        me: false,
        source: 'model',
        fallbackReason: null,
        citations: [],
      },
    ])
  })

  it('带引用的记录保留材料名、版本与行号；没有材料名的引用剔除（不拿 ID 顶替）', () => {
    const migrated = migrateProject({
      projectId: 'prj_1',
      name: '项目',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      chat: [
        {
          who: 'AI 模型',
          me: false,
          text: '新回答：先补齐字段说明。',
          source: 'model',
          fallbackReason: null,
          citations: [
            {
              materialId: 'mat_1',
              materialName: '实验手册.md',
              materialVersion: 2,
              segmentId: 'seg_1',
              startLine: 10,
              endLine: 24,
            },
            // 缺 materialName：界面无法展示，也不能退回显示 materialId
            { materialId: 'mat_1', materialVersion: 2, segmentId: 'seg_2', startLine: 1, endLine: 2 },
            // 材料名是空白
            {
              materialId: 'mat_1',
              materialName: '   ',
              materialVersion: 2,
              segmentId: 'seg_3',
              startLine: 1,
              endLine: 2,
            },
            'seg_4',
          ],
        },
      ],
    })

    expect(migrated?.chat[0]?.text).toBe('新回答：先补齐字段说明。')
    expect(migrated?.chat[0]?.citations).toEqual([
      {
        materialId: 'mat_1',
        materialName: '实验手册.md',
        materialVersion: 2,
        segmentId: 'seg_1',
        startLine: 10,
        endLine: 24,
      },
    ])
  })

  it('往返：写入后再读回，回答的引用不丢', () => {
    const project = makeProject({
      projectId: 'prj_chat',
      chat: [
        {
          who: 'AI 模型',
          me: false,
          text: '往返回答',
          source: 'model',
          fallbackReason: null,
          citations: [
            {
              materialId: 'mat_1',
              materialName: '数据说明.md',
              materialVersion: 1,
              segmentId: 'seg_2',
              startLine: 6,
              endLine: 8,
            },
          ],
        },
      ],
    })

    expect(savePersistedState([project], 'prj_chat').ok).toBe(true)
    const loaded = loadPersistedState()

    expect(loaded.projects[0]?.chat).toHaveLength(1)
    expect(loaded.projects[0]?.chat[0]?.citations).toEqual([
      {
        materialId: 'mat_1',
        materialName: '数据说明.md',
        materialVersion: 1,
        segmentId: 'seg_2',
        startLine: 6,
        endLine: 8,
      },
    ])
  })
})

describe('clearPersistedState', () => {
  it('移除两个存储键，之后读取为空状态', () => {
    savePersistedState([makeProject()], 'prj_1')

    clearPersistedState()

    expect(localStorage.getItem(STORAGE_KEY_PROJECTS)).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_CURRENT_PROJECT_ID)).toBeNull()
    expect(loadPersistedState()).toEqual({ projects: [], currentProjectId: null })
  })

  it('localStorage 不可用时不抛异常', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(() => clearPersistedState()).not.toThrow()
  })
})
