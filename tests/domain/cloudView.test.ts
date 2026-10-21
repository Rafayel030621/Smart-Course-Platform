import { describe, expect, it } from 'vitest'
import { toWorkbenchProjectView } from '@/domain/cloudView'
import { makeCloudMilestone, makeCloudProject, makeCloudTask, makeEvidence } from '../support/v3Fixtures'

const stats = (overrides: Partial<ReturnType<typeof makeCloudMilestone>['taskStats']> = {}) => ({
  total: 0,
  done: 0,
  doing: 0,
  todo: 0,
  archived: 0,
  progress: 0,
  ...overrides,
})

describe('云端项目 → 工作台只读视图', () => {
  it('里程碑状态/进度取服务端统计，归档阶段不展示', () => {
    const project = makeCloudProject({
      milestones: [
        makeCloudMilestone({
          milestoneId: 'ms_1',
          name: '数据获取',
          status: 'active',
          orderIndex: 0,
          taskStats: stats({ total: 4, done: 1, doing: 1, todo: 2, progress: 25 }),
        }),
        makeCloudMilestone({
          milestoneId: 'ms_2',
          name: '方法对比',
          status: 'completed',
          orderIndex: 1,
          taskStats: stats({ total: 2, done: 2, progress: 100 }),
        }),
        makeCloudMilestone({
          milestoneId: 'ms_3',
          name: '已归档阶段',
          status: 'archived',
          orderIndex: 2,
          archivedAt: '2026-10-18T00:00:00.000Z',
        }),
      ],
    })

    const view = toWorkbenchProjectView(project, [], [])

    expect(view.ms.map((item) => item.t)).toEqual(['数据获取', '方法对比'])
    expect(view.ms[0]).toMatchObject({ s: 'cur', p: 25 })
    expect(view.ms[0]?.sub).toContain('1/4')
    // 已完成阶段进度固定 100，不采用可能过期的 taskStats.progress
    expect(view.ms[1]).toMatchObject({ s: 'done', p: 100 })
    expect(view.group).toBe('V3 云端项目')
    expect(view.projectRevision).toBe(project.projectRevision)
  })

  it('任务与证据只映射当前项目、未归档/有效的数据', () => {
    const project = makeCloudProject({ projectId: 'prj_1', name: '极端风浪' })
    const view = toWorkbenchProjectView(
      project,
      [
        makeCloudTask({
          taskId: 'tsk_1',
          projectId: 'prj_1',
          title: '跑通下载链路',
          status: 'doing',
          milestoneName: '数据获取与预处理',
          orderIndex: 0,
        }),
        makeCloudTask({
          taskId: 'tsk_archived',
          projectId: 'prj_1',
          title: '已归档任务',
          archivedAt: '2026-10-18T00:00:00.000Z',
        }),
        makeCloudTask({ taskId: 'tsk_other', projectId: 'prj_other', title: '别的项目任务' }),
      ],
      [
        makeEvidence({
          evidenceId: 'evd_1',
          projectId: 'prj_1',
          taskId: 'tsk_1',
          didWhat: '下载了样例数据',
          foundWhat: '',
        }),
        makeEvidence({
          evidenceId: 'evd_redacted',
          projectId: 'prj_1',
          status: 'redacted',
          didWhat: '已撤回的证据',
        }),
        makeEvidence({
          evidenceId: 'evd_other',
          projectId: 'prj_other',
          didWhat: '别的项目证据',
        }),
      ],
    )

    expect(view.tasks.map((item) => item.id)).toEqual(['tsk_1'])
    expect(view.tasks[0]).toMatchObject({
      title: '跑通下载链路',
      status: 'doing',
      owner: null,
      milestone: '数据获取与预处理',
    })
    expect(view.steps.map((item) => item.t)).toEqual(['跑通下载链路'])

    expect(view.evidenceRecords.map((item) => item.id)).toEqual(['evd_1'])
    expect(view.evidenceRecords[0]?.foundWhat).toBeNull()
    expect(view.evidence[0]?.text).toContain('下载了样例数据')
    expect(view.evidence.map((item) => item.text).join(' ')).not.toContain('已撤回')
    expect(view.evidence.map((item) => item.text).join(' ')).not.toContain('别的项目')
  })

  it('没有读取端点的数据保持为空，不用本地内容填充', () => {
    const view = toWorkbenchProjectView(makeCloudProject({ milestones: [] }), [], [])

    expect(view.ms).toEqual([])
    expect(view.materials).toEqual([])
    expect(view.doubtRecords).toEqual([])
    expect(view.doubts).toEqual([])
    expect(view.chat).toEqual([])
    expect(view.weekly).toEqual([0, 0, 0, 0])
    expect(view.banner).toContain('暂无任务')
  })
})
