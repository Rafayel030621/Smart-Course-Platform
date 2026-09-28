import { describe, expect, it } from 'vitest'
import {
  MAX_TASK_SNAPSHOTS,
  claimedStepCount,
  computeProjectRevision,
  createDoubtId,
  createEvidenceId,
  createId,
  createProjectId,
  createTaskId,
  currentMilestone,
  currentMilestoneName,
  deriveProjectId,
  deriveStepViews,
  deriveTaskSnapshots,
  isValidIso,
  syncMilestones,
  tasksOf,
} from '@/domain/progress'
import { FIXED_ISO, makeMilestone, makeProject, makeTask } from './fixtures'

const REFERENCE = new Date('2026-09-26T08:30:00.000Z')

describe('稳定 ID 生成', () => {
  it('按契约 2 生成 <前缀>_<可打印串> 形态且长度不超过 64', () => {
    for (const prefix of ['prj', 'tsk', 'evd', 'dbt'] as const) {
      const id = createId(prefix)
      expect(id.startsWith(`${prefix}_`)).toBe(true)
      expect(id.length).toBeLessThanOrEqual(64)
      expect(id).toMatch(/^[a-z]{3}_[0-9a-z]+$/)
    }
  })

  it('各前缀工厂生成对应前缀', () => {
    expect(createProjectId().startsWith('prj_')).toBe(true)
    expect(createTaskId().startsWith('tsk_')).toBe(true)
    expect(createEvidenceId().startsWith('evd_')).toBe(true)
    expect(createDoubtId().startsWith('dbt_')).toBe(true)
  })

  it('连续生成不重复（ID 在创建时确定，不按下标派生）', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createTaskId()))
    expect(ids.size).toBe(200)
  })
})

describe('deriveProjectId 与 computeProjectRevision', () => {
  it('deriveProjectId 直接返回持久化的 projectId', () => {
    expect(deriveProjectId(makeProject({ projectId: 'prj_abc' }))).toBe('prj_abc')
  })

  it('computeProjectRevision 读取项目字段中的递增整数', () => {
    expect(computeProjectRevision(makeProject({ projectRevision: 7 }))).toBe(7)
  })

  it('projectRevision 非法时回退为 1（契约 2.6：≥ 1 的整数）', () => {
    expect(computeProjectRevision(makeProject({ projectRevision: 0 }))).toBe(1)
    expect(computeProjectRevision(makeProject({ projectRevision: -3 }))).toBe(1)
    expect(computeProjectRevision(makeProject({ projectRevision: 2.5 }))).toBe(1)
    expect(
      computeProjectRevision(makeProject({ projectRevision: undefined as unknown as number })),
    ).toBe(1)
  })
})

describe('里程碑读取', () => {
  it('优先取进行中的里程碑', () => {
    const project = makeProject({
      ms: [
        makeMilestone({ t: 'A', s: 'done', p: 100 }),
        makeMilestone({ t: 'B', s: 'cur', p: 40 }),
        makeMilestone({ t: 'C', s: 'todo', p: 0 }),
      ],
    })
    expect(currentMilestoneName(project)).toBe('B')
  })

  it('没有进行中的里程碑时取第一个未完成', () => {
    const project = makeProject({
      ms: [
        makeMilestone({ t: 'A', s: 'done', p: 100 }),
        makeMilestone({ t: 'B', s: 'todo', p: 0 }),
      ],
    })
    expect(currentMilestoneName(project)).toBe('B')
  })

  it('全部完成或没有里程碑时返回 null', () => {
    expect(currentMilestoneName(makeProject({ ms: [makeMilestone({ s: 'done' })] }))).toBeNull()
    expect(currentMilestoneName(makeProject({ ms: [] }))).toBeNull()
    expect(currentMilestone(makeProject({ ms: [] }))).toBeUndefined()
  })
})

describe('任务读取与快照', () => {
  it('tasksOf 对非数组返回空数组，不抛异常', () => {
    expect(tasksOf(makeProject({ tasks: undefined as unknown as [] }))).toEqual([])
    expect(tasksOf(makeProject({ tasks: [] }))).toEqual([])
  })

  it('claimedStepCount 统计已开始的（doing / done）任务', () => {
    const project = makeProject({
      tasks: [
        makeTask({ id: 't1', status: 'todo' }),
        makeTask({ id: 't2', status: 'doing' }),
        makeTask({ id: 't3', status: 'done' }),
      ],
    })
    expect(claimedStepCount(project)).toBe(2)
  })

  it('快照包含全部任务，已完成的任务也要发出去（契约 9-14）', () => {
    const project = makeProject({
      tasks: [
        makeTask({ id: 'tsk_a', status: 'doing' }),
        makeTask({ id: 'tsk_b', status: 'todo' }),
        makeTask({ id: 'tsk_c', status: 'done' }),
      ],
    })

    const snapshots = deriveTaskSnapshots(project, REFERENCE)

    expect(snapshots.map((item) => item.taskId)).toEqual(['tsk_a', 'tsk_b', 'tsk_c'])
    expect(snapshots.map((item) => item.status)).toEqual(['doing', 'todo', 'done'])
  })

  it('快照不含本地展示字段，owner 取线上字段（契约 2.2）', () => {
    const project = makeProject({
      tasks: [makeTask({ owner: null, suggestedOwner: '成员A', why: '只有页面需要' })],
    })

    const [snapshot] = deriveTaskSnapshots(project, REFERENCE)

    expect(snapshot.owner).toBeNull()
    expect(Object.keys(snapshot).sort()).toEqual(
      ['doneCriteria', 'milestone', 'owner', 'status', 'taskId', 'title', 'updatedAt'].sort(),
    )
    expect(snapshot).not.toHaveProperty('why')
    expect(snapshot).not.toHaveProperty('suggestedOwner')
  })

  it('空串字段归一化为 null', () => {
    const project = makeProject({
      tasks: [makeTask({ doneCriteria: '   ', owner: '  ', milestone: '' })],
    })

    const [snapshot] = deriveTaskSnapshots(project, REFERENCE)

    expect(snapshot.doneCriteria).toBeNull()
    expect(snapshot.owner).toBeNull()
    expect(snapshot.milestone).toBeNull()
  })

  it('updatedAt 非法时回退到调用方传入的参考时间', () => {
    const project = makeProject({ tasks: [makeTask({ updatedAt: 'not-a-date' })] })

    expect(deriveTaskSnapshots(project, REFERENCE)[0]?.updatedAt).toBe(REFERENCE.toISOString())
  })

  it(`快照条数上限为 ${MAX_TASK_SNAPSHOTS}（契约 4.1）`, () => {
    const tasks = Array.from({ length: MAX_TASK_SNAPSHOTS + 5 }, (_, index) =>
      makeTask({ id: `tsk_${index}` }),
    )

    expect(deriveTaskSnapshots(makeProject({ tasks }), REFERENCE)).toHaveLength(MAX_TASK_SNAPSHOTS)
  })

  it('isValidIso 只接受可解析的 ISO 字符串', () => {
    expect(isValidIso(FIXED_ISO)).toBe(true)
    expect(isValidIso('2026-09-25')).toBe(true)
    expect(isValidIso('abc')).toBe(false)
    expect(isValidIso('')).toBe(false)
    expect(isValidIso(null)).toBe(false)
    expect(isValidIso(undefined)).toBe(false)
  })
})

describe('syncMilestones：进度由已完成任务推导', () => {
  it('里程碑下没有任务时保持原样', () => {
    const project = makeProject({
      ms: [
        makeMilestone({ t: 'A', s: 'cur', p: 10 }),
        makeMilestone({ t: 'B', s: 'todo', p: 0 }),
      ],
      tasks: [],
    })

    syncMilestones(project)

    expect(project.ms[0]).toMatchObject({ s: 'cur', p: 10 })
    expect(project.ms[1]).toMatchObject({ s: 'todo', p: 0 })
  })

  it('认领（todo → doing）不增加完成进度', () => {
    const project = makeProject({
      ms: [makeMilestone({ t: 'A', s: 'cur', p: 0 })],
      tasks: [
        makeTask({ id: 't1', milestone: 'A', status: 'todo' }),
        makeTask({ id: 't2', milestone: 'A', status: 'todo' }),
      ],
    })

    syncMilestones(project)

    expect(project.ms[0]).toMatchObject({ s: 'cur', p: 0 })

    // 把其中一条认领为 doing，进度不应变化
    project.tasks[0]!.status = 'doing'
    syncMilestones(project)

    expect(project.ms[0]).toMatchObject({ s: 'cur', p: 0 })
  })

  it('进度等于已完成任务占比', () => {
    const project = makeProject({
      ms: [makeMilestone({ t: 'A', s: 'cur', p: 0 })],
      tasks: [
        makeTask({ id: 't1', milestone: 'A', status: 'done' }),
        makeTask({ id: 't2', milestone: 'A', status: 'doing' }),
        makeTask({ id: 't3', milestone: 'A', status: 'todo' }),
      ],
    })

    syncMilestones(project)

    expect(project.ms[0]).toMatchObject({ s: 'cur', p: 33 })
  })

  it('全部完成时该里程碑标记为 done 且进度为 100', () => {
    const project = makeProject({
      ms: [
        makeMilestone({ t: 'A', s: 'cur', p: 0 }),
        makeMilestone({ t: 'B', s: 'todo', p: 0 }),
      ],
      tasks: [
        makeTask({ id: 't1', milestone: 'A', status: 'done' }),
        makeTask({ id: 't2', milestone: 'B', status: 'todo' }),
      ],
    })

    syncMilestones(project)

    expect(project.ms[0]).toMatchObject({ s: 'done', p: 100 })
    expect(project.ms[1]).toMatchObject({ s: 'cur', p: 0 })
  })

  it('同一时间只有一个进行中的里程碑', () => {
    const project = makeProject({
      ms: [
        makeMilestone({ t: 'A', s: 'cur', p: 0 }),
        makeMilestone({ t: 'B', s: 'todo', p: 0 }),
        makeMilestone({ t: 'C', s: 'todo', p: 0 }),
      ],
      tasks: [
        makeTask({ id: 't1', milestone: 'A', status: 'todo' }),
        makeTask({ id: 't2', milestone: 'B', status: 'todo' }),
        makeTask({ id: 't3', milestone: 'C', status: 'todo' }),
      ],
    })

    syncMilestones(project)

    expect(project.ms.map((item) => item.s)).toEqual(['cur', 'todo', 'todo'])
  })

  it('全部任务完成后仍保留一个进行中的里程碑，保证 currentMilestone 取得到值', () => {
    const project = makeProject({
      ms: [
        makeMilestone({ t: 'A', s: 'cur', p: 0 }),
        makeMilestone({ t: 'B', s: 'todo', p: 0 }),
      ],
      tasks: [makeTask({ id: 't1', milestone: 'A', status: 'done' })],
    })

    syncMilestones(project)

    expect(project.ms[0]).toMatchObject({ s: 'done', p: 100 })
    expect(project.ms[1].s).toBe('cur')
    expect(currentMilestoneName(project)).toBe('B')
  })
})

describe('deriveStepViews：旧页面只读投影', () => {
  it('展示负责人取 suggestedOwner，缺失时为「待定」，不使用线上 owner', () => {
    const project = makeProject({
      tasks: [
        makeTask({ id: 't1', owner: null, suggestedOwner: '成员A' }),
        makeTask({ id: 't2', owner: '成员B', suggestedOwner: null }),
      ],
    })

    const steps = deriveStepViews(project)

    expect(steps[0]?.owner).toBe('成员A')
    // owner 是线上字段（恒 null），展示时不能被它带偏
    expect(steps[1]?.owner).toBe('待定')
  })

  it('title / why / doneCriteria 正确投影，缺失字段回退为空串', () => {
    const project = makeProject({
      tasks: [makeTask({ title: 'T', why: null, doneCriteria: null })],
    })

    expect(deriveStepViews(project)).toEqual([{ t: 'T', owner: '成员A', why: '', done: '' }])
  })

  it('顺序与 tasks 一致，新增任务追加在末尾', () => {
    const project = makeProject({
      tasks: [makeTask({ id: 't1', title: '一' }), makeTask({ id: 't2', title: '二' })],
    })

    expect(deriveStepViews(project).map((step) => step.t)).toEqual(['一', '二'])
  })
})
