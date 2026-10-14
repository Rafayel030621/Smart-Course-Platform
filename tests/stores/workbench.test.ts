import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { CURRENT_SCHEMA_VERSION, STORAGE_KEY_PROJECTS } from '@/stores/persistence'
import { useWorkbenchStore } from '@/stores/workbench'
import { TOPICS } from '@/data/topics'
import type { AdvisorRecommendationsRequest, NewTaskDraft } from '@/domain/recommendation'
import type { Doubt, Milestone, Task } from '@/types/platform'

const CUSTOM_TOPIC = '__custom__'

type Store = ReturnType<typeof useWorkbenchStore>

/** 内存 Storage 替身：不碰用户真实 localStorage */
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

/** 写入必定失败的 Storage，模拟配额已满 */
function useFailingStorage(): void {
  const storage = createMemoryStorage()
  storage.setItem = () => {
    throw new Error('QuotaExceededError')
  }
  vi.stubGlobal('localStorage', storage)
}

/**
 * 建议接口的替身：返回不可重试的契约错误。
 * 这样 store 会直接走本地规则兜底，不会因为重试退避让用例变慢，也绝不访问真实网络。
 */
function stubAdvisorContractError(): void {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/advisor/chat')) {
      const request = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        contractVersion: '1.0', requestId: request.requestId, projectId: request.projectId,
        projectRevision: request.projectRevision, source: 'model', fallbackReason: null,
        answer: '基于当前项目状态，先核对已有证据，再推进下一步。',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(
      JSON.stringify({ contractVersion: '1.0', requestId: null, code: 'INVALID_INPUT', message: '测试替身', retryable: false, retryAfterSeconds: null }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetchImpl)
}

function chatResponse(request: Record<string, unknown>, source: 'model' | 'fallback' = 'model'): Response {
  return new Response(JSON.stringify({
    contractVersion: '1.0', requestId: request.requestId, projectId: request.projectId,
    projectRevision: request.projectRevision, source, fallbackReason: source === 'fallback' ? 'MODEL_TIMEOUT' : null,
    answer: source === 'fallback' ? '服务端暂时无法调用模型，请依据当前证据继续推进。' : '结合当前项目状态，建议先核对证据。',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function freshStore(): Store {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 用自定义题目建项目：**只有名称**，内容空白（见 createProject 的新语义） */
function createCustomProject(store: Store, name = '测试项目') {
  return store.createProject({ topicId: CUSTOM_TOPIC, customName: name, members: 3 })
}

/**
 * 测试夹具：显式放入"已有内容"的项目（与 createProject 的历史行为同形）。
 *
 * createProject 现在只设置名称、不注入任何内容，所以需要"已有任务/里程碑/疑问"的用例
 * 必须显式调用这里。模板内容在这里是**测试数据**，不是创建流程的一部分——这正是要证明的事。
 * 直接写 project 字段是因为公开 action 里没有"创建 todo 任务"的入口（认领只会得到 doing）。
 */
const FIXTURE_MS: Milestone[] = [
  { t: '选题确认与文献调研', s: 'cur', p: 0, sub: '刚启动' },
  { t: '数据获取与预处理', s: 'todo', p: 0, sub: '未开始' },
  { t: '核心方法 / 模型实现', s: 'todo', p: 0, sub: '未开始' },
  { t: '分析与验证', s: 'todo', p: 0, sub: '未开始' },
  { t: '系统集成与结题报告', s: 'todo', p: 0, sub: '未开始' },
]

const FIXTURE_STEPS = [
  { t: '用一句话写清项目目标与预期产出', owner: '成员A', why: '目标不清是所有后续分歧的根源。', done: '一句话目标 + 预期产出清单，全组确认。' },
  { t: '完成主流方法的文献调研', owner: '成员B', why: '不了解现有方法就动手，大概率走弯路。', done: '调研笔记：2-3 类主流方法 + 各自优缺点 + 初步倾向。' },
  { t: '验证数据 / 工具的可获取性', owner: '成员C', why: '数据拿不到或环境搭不起来是第一周必须验证的风险。', done: '确认数据来源或工具链可用，附验证记录。' },
]

const FIXTURE_DOUBTS = ['项目的具体范围和技术路线还没有和指导老师确认']

function seedTemplateContent(store: Store): void {
  const project = currentProject(store)
  const now = new Date().toISOString()
  const milestone = FIXTURE_MS[0]?.t ?? null

  const tasks: Task[] = FIXTURE_STEPS.map((step, index) => ({
    id: `tsk_seed${index}${project.projectId.replace(/^prj_/, '')}`,
    projectId: project.projectId,
    title: step.t,
    status: 'todo',
    doneCriteria: step.done,
    owner: null,
    suggestedOwner: step.owner,
    milestone,
    why: step.why,
    draftKey: null,
    createdAt: now,
    updatedAt: now,
  }))

  const doubtRecords: Doubt[] = FIXTURE_DOUBTS.map((text, index) => ({
    id: `dbt_seed${index}${project.projectId.replace(/^prj_/, '')}`,
    projectId: project.projectId,
    text,
    status: 'open',
    sourceEvidenceId: null,
    createdAt: now,
    resolvedAt: null,
  }))

  project.ms = JSON.parse(JSON.stringify(FIXTURE_MS)) as Milestone[]
  project.tasks = tasks
  project.doubtRecords = doubtRecords
  // 兼容投影：与 store 的 syncProjectView 保持一致
  project.steps = FIXTURE_STEPS.map((step) => ({ ...step }))
  project.doubts = [...FIXTURE_DOUBTS]
}

/** 建项目并放入示例内容：旧用例的 setup，语义与"创建后自带内容"时代保持一致 */
function createProjectWithContentOrThrow(store: Store, name = '测试项目'): string {
  const result = createCustomProject(store, name)
  if (!result.ok) throw new Error(`创建项目失败：${result.code}`)
  seedTemplateContent(store)
  return result.data.projectId
}

/** 兼容旧用例名称：这些测试需要一个含任务的显式内容夹具。 */
function createCustomProjectOrThrow(store: Store, name = '测试项目'): string {
  return createProjectWithContentOrThrow(store, name)
}

/** 建一个**空白**项目（只有名称），用于验证新语义 */
function createBlankProjectOrThrow(store: Store, name = '测试项目'): string {
  const result = createCustomProject(store, name)
  if (!result.ok) throw new Error(`创建项目失败：${result.code}`)
  return result.data.projectId
}

function currentProject(store: Store) {
  const project = store.current
  if (project === undefined) throw new Error('当前没有项目')
  return project
}

function currentTasks(store: Store) {
  return currentProject(store).tasks
}

beforeEach(() => {
  stubAdvisorContractError()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('空白项目：createProject 只设置名称，不注入任何内容', () => {
  it('选择已有项目名称：名称正确，任务 / 证据 / 疑问 / 材料 / 论文 / 聊天 / 里程碑全为空', () => {
    const store = freshStore()
    const topicId = TOPICS[0] ?? ''

    const result = store.createProject({ topicId, members: 3 })

    expect(result.ok).toBe(true)
    const project = currentProject(store)
    expect(project.name).toBe(topicId)
    expect(project.projectRevision).toBe(1)
    expect(project.tasks).toEqual([])
    expect(project.evidenceRecords).toEqual([])
    expect(project.doubtRecords).toEqual([])
    expect(project.materials).toEqual([])
    expect(project.papers).toEqual([])
    expect(project.chat).toEqual([])
    expect(project.ms).toEqual([])
    expect(project.steps).toEqual([])
    expect(project.evidence).toEqual([])
    expect(project.doubts).toEqual([])
    expect(project.aiPapers).toEqual([])
    expect(project.weekly).toEqual([0, 0, 0, 0])
  })

  it('自定义项目同样是空白内容，banner 是通用提示', () => {
    const store = freshStore()
    createBlankProjectOrThrow(store, '我的自定义项目')

    const project = currentProject(store)
    expect(project.name).toBe('我的自定义项目')
    expect(project.tasks).toEqual([])
    expect(project.ms).toEqual([])
    expect(project.doubtRecords).toEqual([])
    expect(project.chat).toEqual([])
    expect(project.papers).toEqual([])
    expect(project.banner).toContain('空白项目')
  })

  it('题目名称不在清单内时返回 NOT_FOUND，且不创建项目', () => {
    const store = freshStore()

    expect(store.createProject({ topicId: '不存在的题目', members: 3 })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    })
    expect(store.projects).toHaveLength(0)
  })

  it('两个空白项目可以创建与切换，任务互不影响', () => {
    const store = freshStore()
    const first = createBlankProjectOrThrow(store, '项目一')
    const second = createBlankProjectOrThrow(store, '项目二')

    store.claimTask({
      draft: {
        title: '项目二的第一条任务',
        doneCriteria: '留下证据',
        requestId: null,
        basisEvidenceIds: [],
        basisDoubtIds: [],
      },
    })
    expect(currentProject(store).tasks).toHaveLength(1)

    store.selectProject(first)
    expect(currentProject(store).projectId).toBe(first)
    expect(currentProject(store).tasks).toHaveLength(0)

    store.selectProject(second)
    expect(currentProject(store).projectId).toBe(second)
    expect(currentProject(store).tasks).toHaveLength(1)
  })

  it('空白项目仍能提交「其他进展」证据（不关联任务），并生成疑问', async () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)

    const result = await store.submitEvidence({
      submissionId: 'sub-blank-1',
      taskId: null,
      didWhat: '先记录了项目背景与目标',
      foundWhat: null,
      stillUnsure: '研究范围还没定',
      attachmentName: null,
      complete: false,
    })

    expect(result.ok).toBe(true)
    const project = currentProject(store)
    expect(project.evidenceRecords).toHaveLength(1)
    expect(project.evidenceRecords[0]?.taskId).toBeNull()
    expect(project.doubtRecords).toHaveLength(1)
  })

  it('本地规则对空白项目只提示「先补基本信息」，不编造任务', async () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)

    const result = await store.refreshRecommendations()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.source).toBe('local-rule')
    expect(result.data.suggestions).toHaveLength(1)
    expect(result.data.suggestions[0]?.existingTaskId).toBeNull()
    expect(result.data.suggestions[0]?.title).toContain('基本信息')
  })

  it('空白项目认领 AI 给出的新任务后进入 doing', async () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)

    const recommended = await store.refreshRecommendations()
    expect(recommended.ok).toBe(true)
    if (!recommended.ok) return
    const suggestion = recommended.data.suggestions[0]
    if (suggestion === undefined) throw new Error('缺少建议')

    const claimed = store.claimTask({
      draft: {
        title: suggestion.title,
        doneCriteria: suggestion.doneCriteria,
        requestId: suggestion.requestId,
        basisEvidenceIds: suggestion.basisEvidenceIds,
        basisDoubtIds: suggestion.basisDoubtIds,
      },
    })

    expect(claimed.ok).toBe(true)
    const task = currentProject(store).tasks[0]
    expect(task?.status).toBe('doing')
    expect(task?.title).toBe(suggestion.title)
  })
})

describe('createProject：创建与持久化', () => {
  it('生成稳定 projectId，初始 projectRevision 为 1，schemaVersion 为当前版本', () => {
    const store = freshStore()

    const result = createCustomProject(store)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.projectId).toMatch(/^prj_[0-9a-z]+$/)
    expect(result.data.projectRevision).toBe(1)

    const project = currentProject(store)
    expect(project.projectId).toBe(result.data.projectId)
    expect(project.projectRevision).toBe(1)
    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('模板步骤实例化为结构化任务：全部 todo，线上 owner 为 null', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    const tasks = currentTasks(store)

    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) {
      expect(task.status).toBe('todo')
      expect(task.owner).toBeNull()
      expect(task.projectId).toBe(currentProject(store).projectId)
      expect(task.id).toMatch(/^tsk_[0-9a-z]+$/)
      expect(task.milestone).toBe('选题确认与文献调研')
    }
  })

  it('创建成功后写入 localStorage，并切到新项目', () => {
    const store = freshStore()

    createProjectWithContentOrThrow(store)

    expect(store.creating).toBe(false)
    expect(store.hasProject).toBe(true)
    expect(localStorage.getItem(STORAGE_KEY_PROJECTS)).not.toBeNull()
  })

  it('未选择题目时返回 INVALID_INPUT', () => {
    const store = freshStore()

    const result = store.createProject({ topicId: '', members: 3 })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(store.projects).toHaveLength(0)
  })

  it('自定义题目名称为空时返回 INVALID_INPUT', () => {
    const store = freshStore()

    const result = store.createProject({ topicId: CUSTOM_TOPIC, customName: '   ', members: 3 })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(store.projects).toHaveLength(0)
  })

  it('题目模板不存在时返回 NOT_FOUND', () => {
    const store = freshStore()

    const result = store.createProject({ topicId: '不存在的题目', members: 3 })

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(store.projects).toHaveLength(0)
  })

  it('写盘失败时返回 STORAGE_FULL 并回滚（不留下半截项目）', () => {
    useFailingStorage()
    const store = freshStore()

    const result = createCustomProject(store)

    expect(result).toMatchObject({ ok: false, code: 'STORAGE_FULL' })
    expect(store.projects).toHaveLength(0)
    expect(store.hasProject).toBe(false)
    expect(store.creating).toBe(true)
  })

  it('接受旧表单入参（兼容入口走同一条实现）', () => {
    const store = freshStore()

    const result = store.createProject({
      topic: CUSTOM_TOPIC,
      customName: '旧表单项目',
      members: '4 人',
      manual: '手册.pdf',
      data: null,
    })

    expect(result.ok).toBe(true)
    expect(currentProject(store).name).toBe('旧表单项目')
    expect(currentProject(store).members).toBe('4 名成员')
    expect(currentProject(store).materials).toEqual([{ name: '手册.pdf', type: '实验手册' }])
  })
})

describe('selectProject：用 projectId 切换', () => {
  it('按 projectId 选择项目，且不递增 projectRevision', () => {
    const store = freshStore()
    const firstId = createCustomProjectOrThrow(store, '项目一')
    const secondId = createCustomProjectOrThrow(store, '项目二')
    const secondRevision = currentProject(store).projectRevision

    const result = store.selectProject(firstId)

    expect(result).toMatchObject({ ok: true, data: { projectId: firstId } })
    expect(currentProject(store).projectId).toBe(firstId)
    expect(store.projects.find((item) => item.projectId === secondId)?.projectRevision).toBe(
      secondRevision,
    )
  })

  it('不存在的 projectId 返回 NOT_FOUND', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    expect(store.selectProject('prj_missing')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('兼容旧数组下标入口', () => {
    const store = freshStore()
    const firstId = createCustomProjectOrThrow(store, '项目一')
    createProjectWithContentOrThrow(store, '项目二')

    const result = store.selectProject(0)

    expect(result.ok).toBe(true)
    expect(currentProject(store).projectId).toBe(firstId)
  })

  it('写盘失败时返回 STORAGE_FULL 并把选择回滚', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store, '项目一')
    const secondId = createCustomProjectOrThrow(store, '项目二')
    const before = currentProject(store).projectId

    useFailingStorage()
    const result = store.selectProject('placeholder-id')
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' })

    // 指向真实存在的另一个项目，但写盘失败
    const firstId = store.projects[0]?.projectId ?? ''
    const failing = store.selectProject(firstId)

    expect(failing).toMatchObject({ ok: false, code: 'STORAGE_FULL' })
    expect(currentProject(store).projectId).toBe(before)
    expect(store.projects.some((item) => item.projectId === secondId)).toBe(true)
  })
})

describe('claimTask：认领与进度', () => {
  it('todo → doing，且不增加完成进度', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const task = project.tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    const revisionBefore = project.projectRevision
    const progressBefore = project.ms[0]?.p ?? -1

    const result = store.claimTask({ taskId: task.id })

    expect(result).toMatchObject({ ok: true, data: { taskId: task.id, status: 'doing' } })
    expect(project.tasks[0]?.status).toBe('doing')
    expect(project.projectRevision).toBe(revisionBefore + 1)
    // 契约 3.2：认领不得增加任何完成比例
    expect(project.ms[0]?.p).toBe(progressBefore)
  })

  it('重复认领同一个进行中的任务保持幂等，不递增 revision', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const task = currentProject(store).tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    store.claimTask({ taskId: task.id })
    const revisionAfterFirst = currentProject(store).projectRevision

    const result = store.claimTask({ taskId: task.id })

    expect(result.ok).toBe(true)
    expect(currentProject(store).projectRevision).toBe(revisionAfterFirst)
  })

  it('已完成的任务不能再次认领', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const task = currentProject(store).tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    store.claimTask({ taskId: task.id })
    await store.submitEvidence({
      submissionId: 'sub-done',
      taskId: task.id,
      didWhat: '做完了',
      complete: true,
    })

    const result = store.claimTask({ taskId: task.id })

    expect(result).toMatchObject({ ok: false, code: 'TASK_NOT_CLAIMABLE' })
  })

  it('不存在的 taskId 返回 NOT_FOUND', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    expect(store.claimTask({ taskId: 'tsk_missing' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    })
  })

  it('其他项目的 taskId 返回 PROJECT_MISMATCH', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store, '项目一')
    const foreignTaskId = currentProject(store).tasks[0]?.id ?? ''
    createProjectWithContentOrThrow(store, '项目二')

    expect(store.claimTask({ taskId: foreignTaskId })).toMatchObject({
      ok: false,
      code: 'PROJECT_MISMATCH',
    })
  })

  it('draft 入参直接创建 doing 任务并递增 revision', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const before = currentProject(store)
    const countBefore = before.tasks.length
    const revisionBefore = before.projectRevision

    const result = store.claimTask({
      draft: {
        title: '新增的任务',
        doneCriteria: '留下一条证据',
        requestId: 'req-1',
        basisEvidenceIds: [],
        basisDoubtIds: [],
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const created = currentProject(store).tasks.find((item) => item.id === result.data.taskId)
    expect(created).toMatchObject({ title: '新增的任务', status: 'doing', owner: null })
    expect(created?.doneCriteria).toBe('留下一条证据')
    expect(currentProject(store).tasks).toHaveLength(countBefore + 1)
    expect(currentProject(store).projectRevision).toBe(revisionBefore + 1)
  })

  it('draft 标题为空返回 INVALID_INPUT', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    expect(
      store.claimTask({
        draft: {
          title: '  ',
          doneCriteria: '',
          requestId: null,
          basisEvidenceIds: [],
          basisDoubtIds: [],
        },
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it('同时给出 taskId 与 draft，或都不给出，都按 INVALID_INPUT 处理', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const taskId = currentProject(store).tasks[0]?.id ?? ''

    const both = store.claimTask({
      taskId,
      draft: {
        title: 'T',
        doneCriteria: '',
        requestId: null,
        basisEvidenceIds: [],
        basisDoubtIds: [],
      },
    } as unknown as { taskId: string })
    expect(both).toMatchObject({ ok: false, code: 'INVALID_INPUT' })

    expect(store.claimTask({} as unknown as { taskId: string })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    })
  })
})

describe('submitEvidence：记录进展与确认完成', () => {
  it('complete 为 false 时保存证据但不完成任务', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const task = currentProject(store).tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    store.claimTask({ taskId: task.id })
    const revisionBefore = currentProject(store).projectRevision

    const result = await store.submitEvidence({
      submissionId: 'sub-1',
      taskId: task.id,
      didWhat: '读了三篇文献',
      complete: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.deduplicated).toBe(false)
    expect(result.data.taskStatus).toBe('doing')
    expect(currentProject(store).tasks[0]?.status).toBe('doing')
    expect(currentProject(store).evidenceRecords).toHaveLength(1)
    expect(currentProject(store).projectRevision).toBe(revisionBefore + 1)
  })

  it('complete 为 true 时只允许 doing 任务转为 done，并更新进度', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const task = project.tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    expect(project.ms[0]?.p).toBe(0)
    store.claimTask({ taskId: task.id })

    const result = await store.submitEvidence({
      submissionId: 'sub-2',
      taskId: task.id,
      didWhat: '做完了',
      complete: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.taskStatus).toBe('done')
    expect(project.tasks[0]?.status).toBe('done')
    // 进度由已完成任务推导：3 条任务完成 1 条
    expect(project.ms[0]?.p).toBe(33)
  })

  it('complete 为 true 但任务仍是 todo 时整体失败，不发生部分写入', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const task = project.tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    const revisionBefore = project.projectRevision

    const result = await store.submitEvidence({
      submissionId: 'sub-3',
      taskId: task.id,
      didWhat: '没认领就想完成',
      complete: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(project.tasks[0]?.status).toBe('todo')
    expect(project.evidenceRecords).toHaveLength(0)
    expect(project.weekly.at(-1)).toBe(0)
    expect(project.projectRevision).toBe(revisionBefore)
  })

  it('complete 为 true 但未指定任务时返回 INVALID_INPUT', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    const result = await store.submitEvidence({
      submissionId: 'sub-4',
      taskId: null,
      didWhat: 'x',
      complete: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(currentProject(store).evidenceRecords).toHaveLength(0)
  })

  it('「完成了什么」缺失时返回 INVALID_INPUT 且不写入任何内容', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const revisionBefore = currentProject(store).projectRevision

    const result = await store.submitEvidence({
      submissionId: 'sub-5',
      taskId: null,
      didWhat: '   ',
      complete: false,
    })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(currentProject(store).evidenceRecords).toHaveLength(0)
    expect(currentProject(store).projectRevision).toBe(revisionBefore)
  })

  it('超出长度上限时返回 INVALID_INPUT', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    const result = await store.submitEvidence({
      submissionId: 'sub-6',
      taskId: null,
      didWhat: 'x'.repeat(301),
      complete: false,
    })

    expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(currentProject(store).evidenceRecords).toHaveLength(0)
  })

  it('「还有什么不确定」会同时生成一条 open 疑问，并指向该证据', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    const result = await store.submitEvidence({
      submissionId: 'sub-7',
      taskId: null,
      didWhat: '查了文献',
      stillUnsure: '分辨率差距怎么处理',
      complete: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const project = currentProject(store)
    const doubt = project.doubtRecords.find((item) => item.id === result.data.doubtId)
    expect(result.data.doubtId).not.toBeNull()
    expect(doubt).toMatchObject({
      text: '分辨率差距怎么处理',
      status: 'open',
      sourceEvidenceId: result.data.evidenceId,
      resolvedAt: null,
    })
    expect(project.doubts).toContain('分辨率差距怎么处理')
  })

  it('没有不确定内容时不生成疑问', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const doubtsBefore = currentProject(store).doubtRecords.length

    const result = await store.submitEvidence({
      submissionId: 'sub-8',
      taskId: null,
      didWhat: '查了文献',
      complete: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.doubtId).toBeNull()
    expect(currentProject(store).doubtRecords).toHaveLength(doubtsBefore)
  })

  it('其他项目的 taskId 返回 PROJECT_MISMATCH', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store, '项目一')
    const foreignTaskId = currentProject(store).tasks[0]?.id ?? ''
    createProjectWithContentOrThrow(store, '项目二')

    const result = await store.submitEvidence({
      submissionId: 'sub-9',
      taskId: foreignTaskId,
      didWhat: 'x',
      complete: false,
    })

    expect(result).toMatchObject({ ok: false, code: 'PROJECT_MISMATCH' })
    expect(currentProject(store).evidenceRecords).toHaveLength(0)
  })

  it('写盘失败时返回 STORAGE_FULL 并整体回滚', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const revisionBefore = project.projectRevision

    useFailingStorage()
    const result = await store.submitEvidence({
      submissionId: 'sub-10',
      taskId: null,
      didWhat: '写了但存不下',
      stillUnsure: '不确定',
      complete: false,
    })

    expect(result).toMatchObject({ ok: false, code: 'STORAGE_FULL' })
    expect(project.evidenceRecords).toHaveLength(0)
    expect(project.doubtRecords).toHaveLength(1)
    expect(project.weekly.at(-1)).toBe(0)
    expect(project.projectRevision).toBe(revisionBefore)
  })

  it('兼容旧表单入参：按「记录进展」处理且不完成任务', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const task = currentProject(store).tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    store.claimTask({ taskId: task.id })

    const result = await store.submitEvidence({
      stepLabel: `步骤 1 · ${task.title}`,
      didWhat: '旧表单提交',
      foundWhat: '发现了',
      solved: '解决了',
      unsure: '',
      attachment: 'note.ipynb',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.taskStatus).toBe('doing')
    const evidence = currentProject(store).evidenceRecords[0]
    expect(evidence?.taskId).toBe(task.id)
    expect(evidence?.attachmentName).toBe('note.ipynb')
    expect(evidence?.foundWhat).toContain('发现了')
    expect(currentProject(store).tasks[0]?.status).toBe('doing')
  })
})

describe('submitEvidence：submissionId 幂等', () => {
  it('重复提交同一 submissionId 不重复写入任何内容', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const task = project.tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    store.claimTask({ taskId: task.id })

    const input = {
      submissionId: 'sub-idem',
      taskId: task.id,
      didWhat: '第一次',
      stillUnsure: '不确定',
      complete: false,
    }

    const first = await store.submitEvidence(input)
    const stateAfterFirst = {
      evidence: project.evidenceRecords.length,
      doubts: project.doubtRecords.length,
      weekly: project.weekly.at(-1) ?? 0,
      revision: project.projectRevision,
    }

    const second = await store.submitEvidence({ ...input, didWhat: '第二次' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.deduplicated).toBe(true)
    expect(project.evidenceRecords).toHaveLength(stateAfterFirst.evidence)
    expect(project.doubtRecords).toHaveLength(stateAfterFirst.doubts)
    expect(project.weekly.at(-1)).toBe(stateAfterFirst.weekly)
    expect(project.projectRevision).toBe(stateAfterFirst.revision)
    // 幂等命中不新增疑问
    expect(second.data.doubtId).toBeNull()
  })

  it('幂等命中不会把已完成任务改回，也不会重复推进状态', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const task = project.tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    store.claimTask({ taskId: task.id })

    await store.submitEvidence({
      submissionId: 'sub-idem-2',
      taskId: task.id,
      didWhat: '完成',
      complete: true,
    })
    const revision = project.projectRevision

    const again = await store.submitEvidence({
      submissionId: 'sub-idem-2',
      taskId: task.id,
      didWhat: '完成',
      complete: true,
    })

    expect(again.ok).toBe(true)
    expect(project.projectRevision).toBe(revision)
    expect(project.tasks[0]?.status).toBe('done')
  })
})

describe('resolveDoubt：真实 doubtId 与静默语义', () => {
  it('按真实 doubtId 解决，写入 resolvedAt 并递增 revision', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const doubt = project.doubtRecords[0]
    if (doubt === undefined) throw new Error('缺少疑问')
    const revisionBefore = project.projectRevision

    const result = store.resolveDoubt(doubt.id)

    expect(result).toMatchObject({ ok: true, data: { doubtId: doubt.id } })
    expect(doubt.status).toBe('resolved')
    expect(doubt.resolvedAt).not.toBeNull()
    expect(project.projectRevision).toBe(revisionBefore + 1)
  })

  it('重复解决保持幂等：返回成功、状态不变、revision 不递增', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const doubt = project.doubtRecords[0]
    if (doubt === undefined) throw new Error('缺少疑问')
    store.resolveDoubt(doubt.id)
    const revisionAfterFirst = project.projectRevision

    const second = store.resolveDoubt(doubt.id)

    expect(second.ok).toBe(true)
    expect(doubt.status).toBe('resolved')
    expect(project.projectRevision).toBe(revisionAfterFirst)
  })

  it('不存在的 doubtId 返回 NOT_FOUND', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    expect(store.resolveDoubt('dbt_missing')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('其他项目的 doubtId 返回 PROJECT_MISMATCH', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store, '项目一')
    const foreignDoubtId = currentProject(store).doubtRecords[0]?.id ?? ''
    createProjectWithContentOrThrow(store, '项目二')

    expect(store.resolveDoubt(foreignDoubtId)).toMatchObject({
      ok: false,
      code: 'PROJECT_MISMATCH',
    })
  })

  it('兼容旧数组下标入口（定位未解决的疑问）', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const doubt = project.doubtRecords[0]
    if (doubt === undefined) throw new Error('缺少疑问')

    expect(store.resolveDoubt(0)).toMatchObject({ ok: true, data: { doubtId: doubt.id } })
    expect(doubt.status).toBe('resolved')
  })
})

describe('projectRevision：只在契约规定的写入后递增', () => {
  it('创建后为 1，认领、提交证据、解决疑问各递增一次', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    expect(project.projectRevision).toBe(1)

    const task = project.tasks[0]
    const doubt = project.doubtRecords[0]
    if (task === undefined || doubt === undefined) throw new Error('缺少测试数据')

    store.claimTask({ taskId: task.id })
    expect(project.projectRevision).toBe(2)

    await store.submitEvidence({
      submissionId: 'sub-rev',
      taskId: task.id,
      didWhat: '完成',
      complete: true,
    })
    expect(project.projectRevision).toBe(3)

    store.resolveDoubt(doubt.id)
    expect(project.projectRevision).toBe(4)
  })

  it('刷新建议不会改变 revision，AI 失败也不会', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const before = project.projectRevision

    const result = await store.refreshRecommendations()

    expect(project.projectRevision).toBe(before)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.source).toBe('local-rule')
  })

  it('读取与项目切换都不改变任何项目的 revision', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store, '项目一')
    createProjectWithContentOrThrow(store, '项目二')
    const snapshot = store.projects.map((item) => item.projectRevision)

    void store.current
    void store.aiStatus
    void store.recommendations
    store.selectProject(store.projects[0]?.projectId ?? '')

    expect(store.projects.map((item) => item.projectRevision)).toEqual(snapshot)
  })
})

describe('项目隔离', () => {
  it('两个项目的数据互不影响', async () => {
    const store = freshStore()
    const firstId = createCustomProjectOrThrow(store, '项目一')
    const firstTaskId = currentProject(store).tasks[0]?.id ?? ''
    store.claimTask({ taskId: firstTaskId })

    const secondId = createCustomProjectOrThrow(store, '项目二')
    expect(secondId).not.toBe(firstId)

    const first = store.projects.find((item) => item.projectId === firstId)
    const second = store.projects.find((item) => item.projectId === secondId)

    expect(first?.tasks[0]?.status).toBe('doing')
    expect(second?.tasks.every((item) => item.status === 'todo')).toBe(true)
    expect(second?.evidenceRecords).toHaveLength(0)
    expect(second?.projectRevision).toBe(1)
  })

  it('切换项目后建议状态按项目隔离，不串写', async () => {
    const store = freshStore()
    const firstId = createCustomProjectOrThrow(store, '项目一')
    await store.refreshRecommendations()
    expect(store.aiStatus).toBe('local-rule')
    const firstSuggestions = store.recommendations.map((item) => item.id)

    const secondId = createCustomProjectOrThrow(store, '项目二')
    // 新项目还没请求过建议
    expect(store.aiStatus).toBe('idle')
    expect(store.recommendations).toHaveLength(0)

    store.selectProject(firstId)
    expect(store.aiStatus).toBe('local-rule')
    expect(store.recommendations.map((item) => item.id)).toEqual(firstSuggestions)

    store.selectProject(secondId)
    expect(store.aiStatus).toBe('idle')
  })

  it('切换项目不改变两边的持久化数据', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store, '项目一')
    createProjectWithContentOrThrow(store, '项目二')
    const firstId = store.projects[0]?.projectId ?? ''

    store.selectProject(firstId)

    const raw = localStorage.getItem(STORAGE_KEY_PROJECTS) ?? ''
    const envelope = JSON.parse(raw) as { projects: Array<{ projectId: string }> }
    expect(envelope.projects.map((item) => item.projectId)).toEqual(
      store.projects.map((item) => item.projectId),
    )
  })
})

describe('刷新的建议结果不会污染项目状态', () => {
  it('建议失败走本地规则兜底，且不动任务与证据', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const before = JSON.stringify({
      tasks: project.tasks,
      evidence: project.evidenceRecords,
      revision: project.projectRevision,
    })

    const result = await store.refreshRecommendations()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.source).toBe('local-rule')
      expect(result.data.requestId).toBeNull()
      expect(result.data.suggestions.length).toBeGreaterThan(0)
    }
    expect(
      JSON.stringify({
        tasks: project.tasks,
        evidence: project.evidenceRecords,
        revision: project.projectRevision,
      }),
    ).toBe(before)
  })

  it('本地规则建议不推荐已完成任务，依据 ID 落在当前项目内', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const task = project.tasks[0]
    if (task === undefined) throw new Error('缺少任务')
    store.claimTask({ taskId: task.id })
    await store.submitEvidence({
      submissionId: 'sub-local',
      taskId: task.id,
      didWhat: '完成第一步',
      complete: true,
    })

    await store.refreshRecommendations()

    const doneTaskIds = new Set(
      project.tasks.filter((item) => item.status === 'done').map((item) => item.id),
    )
    const knownEvidenceIds = new Set(project.evidenceRecords.map((item) => item.id))
    const knownDoubtIds = new Set(project.doubtRecords.map((item) => item.id))

    for (const suggestion of store.recommendations) {
      expect(suggestion.source).toBe('local-rule')
      if (suggestion.existingTaskId !== null) {
        expect(doneTaskIds.has(suggestion.existingTaskId)).toBe(false)
      }
      for (const id of suggestion.basisEvidenceIds) expect(knownEvidenceIds.has(id)).toBe(true)
      for (const id of suggestion.basisDoubtIds) expect(knownDoubtIds.has(id)).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------ 测试替身 */

/** 构造一条回显指定请求身份的成功响应，便于精确控制「过期」发生在哪个维度 */
function advisorSuccessResponse(
  identity: Pick<AdvisorRecommendationsRequest, 'requestId' | 'projectId' | 'projectRevision'>,
  title: string,
): Response {
  return new Response(
    JSON.stringify({
      contractVersion: '1.0',
      requestId: identity.requestId,
      projectId: identity.projectId,
      projectRevision: identity.projectRevision,
      source: 'model',
      fallbackReason: null,
      cached: false,
      promptVersion: 'mvp-prompt-v1',
      suggestions: [
        {
          title,
          whyNow: '测试用',
          doneCriteria: '测试用',
          existingTaskId: null,
          basisEvidenceIds: [],
          basisDoubtIds: [],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** 不可重试的契约错误：让 store 直接落到本地规则，得到确定性的实际结果状态 */
function advisorContractErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      contractVersion: '1.0',
      requestId: null,
      code: 'INVALID_INPUT',
      message: '测试替身',
      retryable: false,
      retryAfterSeconds: null,
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
}

function requestBodyOf(init: RequestInit | undefined): AdvisorRecommendationsRequest {
  return JSON.parse(String(init?.body)) as AdvisorRecommendationsRequest
}

/** 有界等待建议状态离开 loading，不依赖真实网络，也不会长时间阻塞 */
async function waitUntilNotLoading(store: Store): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.aiStatus !== 'loading') return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/* -------------------------------------------------------------- F1 回归测试 */
/* 契约 4.7 补充约定 2、3：过期响应不得覆盖当前状态，也不得留下没有在途请求却永久 loading */

describe('F1 回归：状态变化后旧响应被丢弃，loading 不得永久停留', () => {
  it('同一项目 revision 变化且无新请求时，替代请求接管并收敛到实际结果状态', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const task = project.tasks[0]
    if (task === undefined) throw new Error('缺少任务')

    const bodies: AdvisorRecommendationsRequest[] = []
    const releases: Array<((response: Response) => void) | undefined> = []
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = requestBodyOf(init)
      bodies.push(body)
      if (bodies.length === 1) {
        // 第一次请求挂起，由测试决定何时返回
        return await new Promise<Response>((resolve) => {
          releases[0] = resolve
        })
      }
      // 替代请求：不可重试的契约错误 → 本地规则兜底
      return advisorContractErrorResponse()
    })
    vi.stubGlobal('fetch', fetchImpl)

    const pending = store.refreshRecommendations()
    const firstBody = bodies[0]
    if (firstBody === undefined) throw new Error('第一次请求没有发出')
    expect(store.aiStatus).toBe('loading')

    // 期间项目状态变化（认领任务 → projectRevision + 1），且没有任何新的建议请求
    store.claimTask({ taskId: task.id })
    const revisionAfterClaim = project.projectRevision
    expect(revisionAfterClaim).toBe(firstBody.projectRevision + 1)

    // 旧响应按第一次请求的身份返回（版本已落后）
    releases[0]?.(advisorSuccessResponse(firstBody, '这条建议来自过期响应'))

    expect(await pending).toMatchObject({ ok: false, code: 'STALE_RESPONSE' })

    // 替代请求接管状态：最终必须是实际结果状态，不能停在 loading，也不能只靠设 idle 蒙过去
    await waitUntilNotLoading(store)
    expect(store.aiStatus).toBe('local-rule')
    expect(['model', 'fallback', 'local-rule', 'error']).toContain(store.aiStatus)

    // 契约 4.7 补充约定 1：过期响应不得写入建议，也不得改动项目数据
    expect(store.recommendations.some((item) => item.title === '这条建议来自过期响应')).toBe(false)
    expect(project.projectRevision).toBe(revisionAfterClaim)
    // 替代请求确实发出过
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('已有更新的请求在途时，旧请求静默结束且不改变新请求的状态', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)

    const bodies: AdvisorRecommendationsRequest[] = []
    const releases: Array<((response: Response) => void) | undefined> = []
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = requestBodyOf(init)
      bodies.push(body)
      const index = bodies.length - 1
      return await new Promise<Response>((resolve) => {
        releases[index] = resolve
      })
    })
    vi.stubGlobal('fetch', fetchImpl)

    const first = store.refreshRecommendations()
    const second = store.refreshRecommendations()
    const firstBody = bodies[0]
    const secondBody = bodies[1]
    if (firstBody === undefined || secondBody === undefined) throw new Error('请求没有发出')
    expect(store.aiStatus).toBe('loading')

    // 旧请求先返回：必须静默丢弃，不能把新请求的 loading 改成 idle 或其他状态
    releases[0]?.(advisorSuccessResponse(firstBody, '旧请求的建议'))
    expect(await first).toMatchObject({ ok: false, code: 'STALE_RESPONSE' })
    expect(store.aiStatus).toBe('loading')
    expect(store.recommendations).toHaveLength(0)

    // 新请求返回后由它接管状态
    releases[1]?.(advisorSuccessResponse(secondBody, '最新请求的建议'))
    const secondResult = await second

    expect(secondResult.ok).toBe(true)
    expect(store.aiStatus).toBe('model')
    expect(store.recommendations.map((item) => item.title)).toEqual(['最新请求的建议'])
  })

  it('服务端回显与本次请求不符且版本未变时，回到可重试的 idle 且不再重复请求', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const bodies: AdvisorRecommendationsRequest[] = []
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = requestBodyOf(init)
      bodies.push(body)
      // requestId 对不上 → 过期响应
      return advisorSuccessResponse({ ...body, requestId: 'other-request-id' }, '过期建议')
    })
    vi.stubGlobal('fetch', fetchImpl)

    const result = await store.refreshRecommendations()

    expect(result).toMatchObject({ ok: false, code: 'STALE_RESPONSE' })
    expect(store.aiStatus).toBe('idle')
    expect(store.recommendations).toHaveLength(0)
    // 版本没有变化，不应该再发替代请求
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

/* -------------------------------------------------------------- F2 回归测试 */
/* 契约 3.2 约束 4：同一项目内字段完全相同的 draft 重复提交必须幂等 */

describe('F2 回归：相同 draft 重复认领必须幂等', () => {
  const baseDraft: NewTaskDraft = {
    title: '整理 ERA5 下载脚本',
    doneCriteria: '脚本能跑通并产出一段样例数据',
    requestId: 'req-abc',
    basisEvidenceIds: ['evd_1', 'evd_2'],
    basisDoubtIds: ['dbt_1'],
  }

  function draftOf(overrides: Partial<NewTaskDraft> = {}): NewTaskDraft {
    return { ...baseDraft, ...overrides }
  }

  /** 让后续的写盘操作可计数，用于验证「命中时不重复持久化」 */
  function countSetItemCalls(): () => number {
    const storage = createMemoryStorage()
    const originalSetItem = storage.setItem
    let calls = 0
    storage.setItem = (key: string, value: string) => {
      calls += 1
      originalSetItem(key, value)
    }
    vi.stubGlobal('localStorage', storage)
    return () => calls
  }

  it('连续两次相同 draft 只创建一条任务，返回同一个 taskId，revision 只加一次', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const countBefore = project.tasks.length
    const revisionBefore = project.projectRevision

    const first = store.claimTask({ draft: draftOf() })
    const revisionAfterFirst = project.projectRevision
    const second = store.claimTask({ draft: draftOf() })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.taskId).toBe(first.data.taskId)
    expect(project.tasks).toHaveLength(countBefore + 1)
    expect(revisionAfterFirst).toBe(revisionBefore + 1)
    expect(project.projectRevision).toBe(revisionAfterFirst)
  })

  it('同一 tick 内并发调用相同 draft 也只创建一条任务（竞态）', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const countBefore = project.tasks.length
    const revisionBefore = project.projectRevision

    const results = await Promise.all([
      Promise.resolve().then(() => store.claimTask({ draft: draftOf() })),
      Promise.resolve().then(() => store.claimTask({ draft: draftOf() })),
      Promise.resolve().then(() => store.claimTask({ draft: draftOf() })),
    ])

    const taskIds = results.map((item) => (item.ok ? item.data.taskId : 'failed'))
    expect(new Set(taskIds).size).toBe(1)
    expect(project.tasks).toHaveLength(countBefore + 1)
    expect(project.projectRevision).toBe(revisionBefore + 1)
  })

  it('命中已有任务时不重复持久化', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    store.claimTask({ draft: draftOf() })

    const setItemCalls = countSetItemCalls()
    const second = store.claimTask({ draft: draftOf() })

    expect(second.ok).toBe(true)
    expect(setItemCalls()).toBe(0)
  })

  it('去重身份覆盖 draft 的全部语义字段，任一不同都创建新任务', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const countBefore = project.tasks.length

    const variants: NewTaskDraft[] = [
      draftOf({ title: '另一个标题' }),
      draftOf({ doneCriteria: '另一个完成标志' }),
      draftOf({ requestId: 'req-other' }),
      draftOf({ requestId: null }),
      draftOf({ basisEvidenceIds: ['evd_1'] }),
      draftOf({ basisDoubtIds: [] }),
    ]

    const taskIds = new Set<string>()
    for (const variant of variants) {
      const result = store.claimTask({ draft: variant })
      expect(result.ok).toBe(true)
      if (result.ok) taskIds.add(result.data.taskId)
    }

    expect(taskIds.size).toBe(variants.length)
    expect(project.tasks).toHaveLength(countBefore + variants.length)
  })

  it('依据 ID 顺序不同仍视为同一 draft（键经过规范化）', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const countBefore = project.tasks.length

    const first = store.claimTask({ draft: draftOf({ basisEvidenceIds: ['evd_1', 'evd_2'] }) })
    const second = store.claimTask({ draft: draftOf({ basisEvidenceIds: ['evd_2', 'evd_1'] }) })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.taskId).toBe(first.data.taskId)
    expect(project.tasks).toHaveLength(countBefore + 1)
  })

  it('不同项目之间的相同 draft 各自创建任务（去重限定在同一项目内）', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store, '项目一')
    const first = store.claimTask({ draft: draftOf() })
    const firstProjectTaskCount = currentProject(store).tasks.length

    createProjectWithContentOrThrow(store, '项目二')
    const second = store.claimTask({ draft: draftOf() })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.taskId).not.toBe(first.data.taskId)
    expect(currentProject(store).tasks.some((item) => item.id === second.data.taskId)).toBe(true)
    expect(store.projects[0]?.tasks).toHaveLength(firstProjectTaskCount)
  })

  it('刷新恢复后相同 draft 仍命中同一条任务（幂等键已持久化）', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const first = store.claimTask({ draft: draftOf() })
    if (!first.ok) throw new Error('第一次认领失败')

    // 重建 store 相当于刷新页面：localStorage 保留
    const reloaded = freshStore()
    const project = currentProject(reloaded)
    const countBefore = project.tasks.length

    const second = reloaded.claimTask({ draft: draftOf() })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.taskId).toBe(first.data.taskId)
    expect(project.tasks).toHaveLength(countBefore)
  })

  it('模板任务与认领已有任务没有幂等键，draft 任务带键', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)

    expect(project.tasks.every((item) => item.draftKey === null)).toBe(true)

    const created = store.claimTask({ draft: draftOf() })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const task = project.tasks.find((item) => item.id === created.data.taskId)
    expect(typeof task?.draftKey).toBe('string')
  })

  it('draft 幂等键不进入 advisor 请求快照', async () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    store.claimTask({ draft: draftOf() })

    const bodies: AdvisorRecommendationsRequest[] = []
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(requestBodyOf(init))
      return advisorContractErrorResponse()
    })
    vi.stubGlobal('fetch', fetchImpl)

    await store.refreshRecommendations()

    const tasks = bodies[0]?.tasks ?? []
    expect(tasks.length).toBeGreaterThan(0)
    expect(Object.keys(tasks[0] ?? {}).sort()).toEqual(
      ['doneCriteria', 'milestone', 'owner', 'status', 'taskId', 'title', 'updatedAt'].sort(),
    )
    for (const task of tasks) {
      expect(task).not.toHaveProperty('draftKey')
      expect(task).not.toHaveProperty('why')
      expect(task).not.toHaveProperty('suggestedOwner')
      expect(task.owner).toBeNull()
    }
  })
})

describe('claimTask：对已认领任务重复点击的反馈与幂等', () => {
  /** 让后续写盘可计数（命中的幂等分支必须一次都不写） */
  function countSetItemCalls(): () => number {
    const storage = createMemoryStorage()
    const originalSetItem = storage.setItem
    let calls = 0
    storage.setItem = (key: string, value: string) => {
      calls += 1
      originalSetItem(key, value)
    }
    vi.stubGlobal('localStorage', storage)
    return () => calls
  }

  it('再次认领同一进行中任务：不写盘、不递增 revision，并提示「已认领」', () => {
    const store = freshStore()
    createProjectWithContentOrThrow(store)
    const project = currentProject(store)
    const task = project.tasks[0]
    if (task === undefined) throw new Error('缺少任务')

    store.claimTask({ taskId: task.id })
    const revisionAfterFirst = project.projectRevision
    const toastAfterFirst = store.toastText

    const setItemCalls = countSetItemCalls()
    const again = store.claimTask({ taskId: task.id })

    expect(again).toMatchObject({ ok: true, data: { taskId: task.id, status: 'doing' } })
    expect(setItemCalls()).toBe(0)
    expect(project.projectRevision).toBe(revisionAfterFirst)
    expect(project.tasks.filter((item) => item.id === task.id)).toHaveLength(1)
    expect(store.toastText).toContain('已认领')
    expect(store.toastText).not.toBe(toastAfterFirst)
  })
})

describe('项目状态提示：banner 随真实数据更新，不写死空白项目', () => {
  const draft = {
    title: '写清项目目标与预期产出',
    doneCriteria: '一页目标说明',
    requestId: null,
    basisEvidenceIds: [],
    basisDoubtIds: [],
  }

  it('新建项目 → 认领任务后：提示从「空白项目」变成任务状态', () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)
    expect(currentProject(store).banner).toContain('空白项目')

    store.claimTask({ draft })

    const banner = currentProject(store).banner
    expect(banner).not.toContain('空白项目')
    expect(banner).toContain('进行中 1')
  })

  it('上传材料后空白提示消失', () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)

    store.uploadMaterial('实验手册', '实验手册.pdf')

    const banner = currentProject(store).banner
    expect(banner).not.toContain('空白项目')
    expect(banner).toContain('1 份材料')
  })

  it('提交第一条进展后空白提示消失', async () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)

    const result = await store.submitEvidence({
      submissionId: 'sub-blank-1',
      taskId: null,
      didWhat: '读了 2 篇文献并整理了结论',
      complete: false,
    })

    expect(result.ok).toBe(true)
    const banner = currentProject(store).banner
    expect(banner).not.toContain('空白项目')
    expect(banner).toContain('1 条证据')
  })

  it('提出疑问（仍有不确定）后空白提示消失', async () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)

    await store.submitEvidence({
      submissionId: 'sub-blank-2',
      taskId: null,
      didWhat: '试了一次数据下载',
      stillUnsure: '数据集的分辨率是否够用？',
      complete: false,
    })

    const project = currentProject(store)
    expect(project.doubtRecords).toHaveLength(1)
    expect(project.banner).not.toContain('空白项目')
    expect(project.banner).toContain('待解决疑问')
  })

  it('刷新恢复后仍按真实数据展示，不会退回空白提示', () => {
    const store = freshStore()
    const projectId = createBlankProjectOrThrow(store)
    store.claimTask({ draft })

    // 重建 store 相当于刷新页面：localStorage 保留
    const reloaded = freshStore()

    expect(reloaded.current?.projectId).toBe(projectId)
    expect(reloaded.current?.banner).not.toContain('空白项目')
    expect(reloaded.current?.banner).toContain('进行中 1')
    expect(reloaded.current?.tasks).toHaveLength(1)
  })
})

describe('向顾问提问：真实聊天接口', () => {
  it('请求期间显示 loading 并阻止重复提交', async () => {
    let resolveRequest: ((response: Response) => void) | undefined
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      resolveRequest = () => resolve(chatResponse(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>))
    }))
    vi.stubGlobal('fetch', fetchImpl)
    const store = freshStore()
    createBlankProjectOrThrow(store)
    const first = store.sendChat('第一个问题')
    expect(store.chatLoading).toBe(true)
    await store.sendChat('重复问题')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    resolveRequest?.(new Response())
    await first
  })

  it('显示服务端 fallback 及原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => chatResponse(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, 'fallback')))
    const store = freshStore()
    createBlankProjectOrThrow(store)
    await store.sendChat('模型不可用时怎么办？')
    expect(currentProject(store).chat[1]?.who).toBe('服务端兜底')
    expect(currentProject(store).chat[1]?.fallbackReason).toBe('MODEL_TIMEOUT')
  })

  it('网络失败显示明确的中文提示，且不泄露请求内容与内部字段名', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network failure') }))
    const store = freshStore()
    createBlankProjectOrThrow(store)
    await store.sendChat('网络失败测试问题')
    expect(currentProject(store).chat).toHaveLength(1)
    expect(store.chatError).toContain('连不上后端服务')
    expect(store.chatError).not.toContain('network failure')
    // 内部字段名与错误码都不能出现在用户看到的提示里
    for (const token of ['projectRevision', 'doneCriteria', 'currentMilestone', 'NETWORK_ERROR', 'requestId']) {
      expect(store.chatError).not.toContain(token)
    }
  })

  it('服务端返回的原始报文（含字段名）不会直接展示给用户', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            contractVersion: '1.0',
            requestId: 'req-x',
            code: 'INVALID_INPUT',
            message: '请求内容不合法：projectRevision 必须是整数',
            retryable: false,
            retryAfterSeconds: null,
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    const store = freshStore()
    createBlankProjectOrThrow(store)

    await store.sendChat('这句提问本身是合法的')

    expect(store.chatError).not.toBeNull()
    expect(store.chatError).not.toContain('projectRevision')
    expect(store.chatError).not.toContain('INVALID_INPUT')
    expect(store.chatError).not.toContain('请求内容不合法')
    // 换成一句用户能看懂的话
    expect(store.chatError).toContain('项目')
  })

  it('超过问题长度上限不发送请求', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const store = freshStore()
    createBlankProjectOrThrow(store)
    await store.sendChat('x'.repeat(2001))
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.chatError).toContain('不能超过')
  })

  it('切换项目或 revision 后丢弃旧响应', async () => {
    const pending: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      pending.push(() => resolve(chatResponse(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)))
    })))
    const store = freshStore()
    const firstId = createBlankProjectOrThrow(store, '项目一')
    const secondId = createBlankProjectOrThrow(store, '项目二')
    const oldRequest = store.sendChat('旧项目问题')
    store.selectProject(firstId)
    pending[0]?.(new Response())
    await oldRequest
    expect(store.projects.find((item) => item.projectId === secondId)?.chat).toHaveLength(1)

    store.selectProject(secondId)
    const revisionRequest = store.sendChat('旧版本问题')
    store.claimTask({ draft: { title: '改变版本', doneCriteria: '完成', requestId: null, basisEvidenceIds: [], basisDoubtIds: [] } })
    pending[1]?.(new Response())
    await revisionRequest
    expect(currentProject(store).chat.filter((item) => !item.me)).toHaveLength(0)
  })
  it('提问与回复都记在当前项目，回复署名「AI 模型」', async () => {
      const store = freshStore()
      const firstProjectId = createBlankProjectOrThrow(store, '项目一')
      const secondProjectId = createBlankProjectOrThrow(store, '项目二')

      store.sendChat('这个方法在我们的数据上适用吗？')
      expect(currentProject(store).chat).toHaveLength(1)

      await vi.waitFor(() => expect(currentProject(store).chat).toHaveLength(2))

      const chat = currentProject(store).chat
      expect(chat).toHaveLength(2)
      expect(chat[1]?.who).toBe('AI 模型')
      expect(chat[1]?.source).toBe('model')

      // 聊天记录按项目保存：切换项目互不串
      store.selectProject(firstProjectId)
      expect(currentProject(store).chat).toHaveLength(0)
      store.selectProject(secondProjectId)
      expect(currentProject(store).chat).toHaveLength(2)
      expect(store.projects.find((item) => item.projectId === firstProjectId)?.chat).toHaveLength(0)
      const reloaded = freshStore()
      expect(reloaded.current?.chat[1]?.who).toBe('AI 模型')
  })

  it('空问题不发送请求也不写入聊天记录', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const store = freshStore()
    createBlankProjectOrThrow(store)
    await store.sendChat('   ')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(currentProject(store).chat).toHaveLength(0)
  })

  it('askAboutStep 按 taskId 定位任务并调用真实聊天接口', async () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)

    // 先建一条别的任务：目标任务的下标就不是 0 了
    store.claimTask({
      draft: {
        title: '先做文献调研',
        doneCriteria: '调研笔记',
        requestId: null,
        basisEvidenceIds: [],
        basisDoubtIds: [],
      },
    })
    const claimed = store.claimTask({
      draft: {
        title: '写清项目目标与预期产出',
        doneCriteria: '一页目标说明',
        requestId: null,
        basisEvidenceIds: [],
        basisDoubtIds: [],
      },
    })
    if (!claimed.ok) throw new Error('认领失败')
    expect(currentProject(store).tasks[0]?.id).not.toBe(claimed.data.taskId)

    store.askAboutStep(claimed.data.taskId)

    await vi.waitFor(() => expect(currentProject(store).chat).toHaveLength(2))
    const completedChat = currentProject(store).chat
    expect(completedChat[0]?.who).toBe('我')
    expect(completedChat[0]?.text).toContain('写清项目目标与预期产出')
    expect(completedChat[1]?.who).toBe('AI 模型')
  })

  it('askAboutStep 对不存在的任务给出提示，不写入聊天记录', () => {
    const store = freshStore()
    createBlankProjectOrThrow(store)

    store.askAboutStep('tsk_missing')

    expect(currentProject(store).chat).toHaveLength(0)
    expect(store.toastText).toContain('已经不在当前项目')
  })
})
