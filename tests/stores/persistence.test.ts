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
    expect(CURRENT_SCHEMA_VERSION).toBe(1)
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
