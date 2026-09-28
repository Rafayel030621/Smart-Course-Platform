import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { STORAGE_KEY_PROJECTS } from '@/stores/persistence'
import { useWorkbenchStore } from '@/stores/workbench'

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
  const fetchImpl = vi.fn(async () =>
    new Response(
      JSON.stringify({
        contractVersion: '1.0',
        requestId: null,
        code: 'INVALID_INPUT',
        message: '测试替身',
        retryable: false,
        retryAfterSeconds: null,
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
  )
  vi.stubGlobal('fetch', fetchImpl)
}

function freshStore(): Store {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 用自定义题目建项目：3 条 todo 任务 + 1 条 open 疑问，结构可预测 */
function createCustomProject(store: Store, name = '测试项目') {
  return store.createProject({ topicId: CUSTOM_TOPIC, customName: name, members: 3 })
}

function createCustomProjectOrThrow(store: Store, name = '测试项目'): string {
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
    expect(project.schemaVersion).toBe(1)
  })

  it('模板步骤实例化为结构化任务：全部 todo，线上 owner 为 null', () => {
    const store = freshStore()
    createCustomProjectOrThrow(store)

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

    createCustomProjectOrThrow(store)

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
    createCustomProjectOrThrow(store)

    expect(store.selectProject('prj_missing')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('兼容旧数组下标入口', () => {
    const store = freshStore()
    const firstId = createCustomProjectOrThrow(store, '项目一')
    createCustomProjectOrThrow(store, '项目二')

    const result = store.selectProject(0)

    expect(result.ok).toBe(true)
    expect(currentProject(store).projectId).toBe(firstId)
  })

  it('写盘失败时返回 STORAGE_FULL 并把选择回滚', () => {
    const store = freshStore()
    createCustomProjectOrThrow(store, '项目一')
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)

    expect(store.claimTask({ taskId: 'tsk_missing' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    })
  })

  it('其他项目的 taskId 返回 PROJECT_MISMATCH', () => {
    const store = freshStore()
    createCustomProjectOrThrow(store, '项目一')
    const foreignTaskId = currentProject(store).tasks[0]?.id ?? ''
    createCustomProjectOrThrow(store, '项目二')

    expect(store.claimTask({ taskId: foreignTaskId })).toMatchObject({
      ok: false,
      code: 'PROJECT_MISMATCH',
    })
  })

  it('draft 入参直接创建 doing 任务并递增 revision', () => {
    const store = freshStore()
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)

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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)

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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)

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
    createCustomProjectOrThrow(store)

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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store, '项目一')
    const foreignTaskId = currentProject(store).tasks[0]?.id ?? ''
    createCustomProjectOrThrow(store, '项目二')

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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)

    expect(store.resolveDoubt('dbt_missing')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('其他项目的 doubtId 返回 PROJECT_MISMATCH', () => {
    const store = freshStore()
    createCustomProjectOrThrow(store, '项目一')
    const foreignDoubtId = currentProject(store).doubtRecords[0]?.id ?? ''
    createCustomProjectOrThrow(store, '项目二')

    expect(store.resolveDoubt(foreignDoubtId)).toMatchObject({
      ok: false,
      code: 'PROJECT_MISMATCH',
    })
  })

  it('兼容旧数组下标入口（定位未解决的疑问）', () => {
    const store = freshStore()
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
    const project = currentProject(store)
    const before = project.projectRevision

    const result = await store.refreshRecommendations()

    expect(project.projectRevision).toBe(before)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.source).toBe('local-rule')
  })

  it('读取与项目切换都不改变任何项目的 revision', () => {
    const store = freshStore()
    createCustomProjectOrThrow(store, '项目一')
    createCustomProjectOrThrow(store, '项目二')
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
    createCustomProjectOrThrow(store, '项目一')
    createCustomProjectOrThrow(store, '项目二')
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
    createCustomProjectOrThrow(store)
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
    createCustomProjectOrThrow(store)
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
