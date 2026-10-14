import { describe, expect, it } from 'vitest'
import {
  MAX_DOUBT_SNAPSHOTS,
  MAX_EVIDENCE_SNAPSHOTS,
  composeEvidenceText,
  deriveDoubtSnapshots,
  deriveDoubtTexts,
  deriveEvidenceSnapshots,
  deriveEvidenceViews,
  doubtsOf,
  evidencesOf,
  toDisplayTime,
} from '@/domain/activity'
import { FIXED_ISO, makeDoubt, makeEvidence, makeProject, makeTask } from './fixtures'

const REFERENCE = new Date('2026-09-26T08:30:00.000Z')

/** 由本地时间构造 ISO，避免断言依赖运行机器的时区 */
function localIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute).toISOString()
}

describe('toDisplayTime：展示时间格式化', () => {
  it('把 ISO 格式化为 MM-DD HH:mm（本地时区）', () => {
    expect(toDisplayTime(localIso(2026, 9, 25, 14, 5))).toBe('09-25 14:05')
  })

  it('月、日、时、分都补零', () => {
    expect(toDisplayTime(localIso(2026, 1, 2, 3, 4))).toBe('01-02 03:04')
  })

  it('边界日期（午夜与年末）不产生异常', () => {
    expect(toDisplayTime(localIso(2026, 12, 31, 0, 0))).toBe('12-31 00:00')
    expect(toDisplayTime(localIso(2026, 1, 1, 23, 59))).toBe('01-01 23:59')
  })

  it('非法或缺失时间返回空串，不抛异常', () => {
    expect(toDisplayTime('')).toBe('')
    expect(toDisplayTime('not-a-date')).toBe('')
  })
})

describe('evidencesOf 与 doubtsOf 的容错', () => {
  it('字段缺失或不是数组时返回空数组', () => {
    const broken = makeProject({
      evidenceRecords: undefined as unknown as [],
      doubtRecords: null as unknown as [],
    })

    expect(evidencesOf(broken)).toEqual([])
    expect(doubtsOf(broken)).toEqual([])
  })

  it('空项目返回空数组（不抛异常）', () => {
    const project = makeProject()

    expect(deriveEvidenceSnapshots(project, REFERENCE)).toEqual([])
    expect(deriveDoubtSnapshots(project, REFERENCE)).toEqual([])
    expect(deriveEvidenceViews(project)).toEqual([])
    expect(deriveDoubtTexts(project)).toEqual([])
  })
})

describe('deriveEvidenceSnapshots：请求侧证据快照', () => {
  it('按 createdAt 倒序，最新的排在最前', () => {
    const project = makeProject({
      evidenceRecords: [
        makeEvidence({ id: 'evd_old', createdAt: localIso(2026, 9, 20, 9, 0) }),
        makeEvidence({ id: 'evd_new', createdAt: localIso(2026, 9, 25, 9, 0) }),
        makeEvidence({ id: 'evd_mid', createdAt: localIso(2026, 9, 23, 9, 0) }),
      ],
    })

    expect(deriveEvidenceSnapshots(project, REFERENCE).map((item) => item.evidenceId)).toEqual([
      'evd_new',
      'evd_mid',
      'evd_old',
    ])
  })

  it('使用真实 evidenceId / submissionId / taskId，空串归一化为 null', () => {
    const project = makeProject({
      evidenceRecords: [
        makeEvidence({
          id: 'evd_x',
          submissionId: 'sub_x',
          taskId: 'tsk_x',
          foundWhat: '  ',
          author: '',
        }),
      ],
    })

    expect(deriveEvidenceSnapshots(project, REFERENCE)[0]).toEqual({
      evidenceId: 'evd_x',
      submissionId: 'sub_x',
      taskId: 'tsk_x',
      didWhat: '读了 6 篇文献',
      foundWhat: null,
      stillUnsure: null,
      author: null,
      createdAt: FIXED_ISO,
    })
  })

  it('createdAt 非法时回退到参考时间', () => {
    const project = makeProject({
      evidenceRecords: [makeEvidence({ createdAt: 'broken' })],
    })

    expect(deriveEvidenceSnapshots(project, REFERENCE)[0]?.createdAt).toBe(REFERENCE.toISOString())
  })

  it(`最多发最近 ${MAX_EVIDENCE_SNAPSHOTS} 条（契约 4.1）`, () => {
    const evidenceRecords = Array.from({ length: MAX_EVIDENCE_SNAPSHOTS + 7 }, (_, index) =>
      makeEvidence({
        id: `evd_${index}`,
        createdAt: localIso(2026, 9, 1 + (index % 28), 10, 0),
      }),
    )

    expect(
      deriveEvidenceSnapshots(makeProject({ evidenceRecords }), REFERENCE),
    ).toHaveLength(MAX_EVIDENCE_SNAPSHOTS)
  })
})

describe('deriveDoubtSnapshots：只发未解决的疑问', () => {
  it('过滤掉已解决的疑问（契约 4.1 / 9-14）', () => {
    const project = makeProject({
      doubtRecords: [
        makeDoubt({ id: 'dbt_open', status: 'open' }),
        makeDoubt({ id: 'dbt_done', status: 'resolved', resolvedAt: FIXED_ISO }),
      ],
    })

    const snapshots = deriveDoubtSnapshots(project, REFERENCE)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.doubtId).toBe('dbt_open')
    expect(snapshots[0]?.status).toBe('open')
  })

  it('保留 sourceEvidenceId，空串归一化为 null', () => {
    const project = makeProject({
      doubtRecords: [
        makeDoubt({ id: 'dbt_a', sourceEvidenceId: 'evd_a' }),
        makeDoubt({ id: 'dbt_b', sourceEvidenceId: '' }),
      ],
    })

    const snapshots = deriveDoubtSnapshots(project, REFERENCE)

    expect(snapshots[0]?.sourceEvidenceId).toBe('evd_a')
    expect(snapshots[1]?.sourceEvidenceId).toBeNull()
  })

  it(`最多发 ${MAX_DOUBT_SNAPSHOTS} 条`, () => {
    const doubtRecords = Array.from({ length: MAX_DOUBT_SNAPSHOTS + 5 }, (_, index) =>
      makeDoubt({ id: `dbt_${index}` }),
    )

    expect(deriveDoubtSnapshots(makeProject({ doubtRecords }), REFERENCE)).toHaveLength(
      MAX_DOUBT_SNAPSHOTS,
    )
  })
})

describe('composeEvidenceText：旧页面时间线文案', () => {
  it('关联任务时用任务标题做前缀', () => {
    const project = makeProject({ tasks: [makeTask({ id: 'tsk_1', title: '跑通下载链路' })] })
    const evidence = makeEvidence({ taskId: 'tsk_1', didWhat: '下载了样例', foundWhat: null })

    expect(composeEvidenceText(project, evidence)).toBe('【跑通下载链路】下载了样例')
  })

  it('不关联任务时用「其他进展」，任务已被删除也不抛异常', () => {
    const noTask = makeProject({ tasks: [] })

    expect(
      composeEvidenceText(noTask, makeEvidence({ taskId: null, didWhat: '读了文献', foundWhat: null })),
    ).toBe('【其他进展】读了文献')
    expect(
      composeEvidenceText(noTask, makeEvidence({ taskId: 'tsk_gone', didWhat: 'x', foundWhat: null })),
    ).toBe('【其他进展】x')
  })

  it('按顺序拼接发现、待定与附件，空值不产生多余分隔符', () => {
    const project = makeProject()
    const evidence = makeEvidence({
      taskId: null,
      didWhat: 'A',
      foundWhat: 'B',
      stillUnsure: 'C',
      attachmentName: 'note.ipynb',
    })

    expect(composeEvidenceText(project, evidence)).toBe('【其他进展】A；发现：B；待定：C；附件：note.ipynb')
    expect(
      composeEvidenceText(project, makeEvidence({ taskId: null, didWhat: 'A', foundWhat: null })),
    ).toBe('【其他进展】A')
  })
})

describe('deriveEvidenceViews / deriveDoubtTexts：旧页面只读投影', () => {
  it('投影按时间倒序，并带格式化后的展示时间', () => {
    const project = makeProject({
      evidenceRecords: [
        makeEvidence({ id: 'evd_old', createdAt: localIso(2026, 9, 20, 9, 0), didWhat: '旧的' }),
        makeEvidence({ id: 'evd_new', createdAt: localIso(2026, 9, 25, 14, 5), didWhat: '新的' }),
      ],
    })

    const views = deriveEvidenceViews(project)

    expect(views[0]?.text).toContain('新的')
    expect(views[0]?.time).toBe('09-25 14:05')
    expect(views[1]?.text).toContain('旧的')
  })

  it('作者缺失时给出默认展示值', () => {
    const project = makeProject({ evidenceRecords: [makeEvidence({ author: null })] })

    expect(deriveEvidenceViews(project)[0]?.who).toBe('我 · 刚提交')
  })

  it('疑问投影只含未解决的文本，顺序与记录顺序一致', () => {
    const project = makeProject({
      doubtRecords: [
        makeDoubt({ id: 'd1', text: '第一个', status: 'open' }),
        makeDoubt({ id: 'd2', text: '已解决', status: 'resolved' }),
        makeDoubt({ id: 'd3', text: '第二个', status: 'open' }),
      ],
    })

    expect(deriveDoubtTexts(project)).toEqual(['第一个', '第二个'])
  })
})
