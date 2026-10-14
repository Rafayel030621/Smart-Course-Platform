import { describe, expect, it } from 'vitest'
import { BLANK_PROJECT_NOTE, summarizeProjectStatus } from '@/domain/projectStatus'
import { makeDoubt, makeEvidence, makeProject, makeTask } from './fixtures'

/**
 * 项目状态摘要（空白项目提示的唯一来源）
 * ----------------------------------------------------------------------------
 * 规则：只有「没有任务、没有证据、没有疑问、没有材料」的项目才是空白项目；
 * 用户输入任意一类内容后，提示必须消失或更新为当前项目状态。
 */
describe('summarizeProjectStatus：空白项目判定', () => {
  it('新建的空白项目：isBlank 为真，文案是标准空白提示', () => {
    const summary = summarizeProjectStatus(makeProject())

    expect(summary.isBlank).toBe(true)
    expect(summary.taskCount).toBe(0)
    expect(summary.evidenceCount).toBe(0)
    expect(summary.doubtCount).toBe(0)
    expect(summary.materialCount).toBe(0)
    expect(summary.note).toBe(BLANK_PROJECT_NOTE)
    expect(summary.note).toContain('空白项目')
  })

  it('只有材料时不再是空白项目，提示更新为项目状态', () => {
    const summary = summarizeProjectStatus(
      makeProject({ materials: [{ name: '实验手册.pdf', type: '实验手册' }] }),
    )

    expect(summary.isBlank).toBe(false)
    expect(summary.materialCount).toBe(1)
    expect(summary.note).not.toContain('空白项目')
    expect(summary.note).toContain('1 份材料')
  })

  it('只有证据时不再是空白项目', () => {
    const summary = summarizeProjectStatus(makeProject({ evidenceRecords: [makeEvidence()] }))

    expect(summary.isBlank).toBe(false)
    expect(summary.note).toContain('1 条证据')
  })

  it('只有疑问时不再是空白项目（已解决的疑问也算用户输入过）', () => {
    const summary = summarizeProjectStatus(
      makeProject({
        doubtRecords: [makeDoubt({ status: 'resolved' }), makeDoubt({ id: 'dbt_2', status: 'open' })],
      }),
    )

    expect(summary.isBlank).toBe(false)
    expect(summary.doubtCount).toBe(2)
    expect(summary.openDoubtCount).toBe(1)
    expect(summary.note).toContain('1 条待解决疑问')
  })

  it('只有任务时不再是空白项目，并按状态统计', () => {
    const summary = summarizeProjectStatus(
      makeProject({
        tasks: [
          makeTask({ id: 't1', status: 'doing' }),
          makeTask({ id: 't2', status: 'done' }),
          makeTask({ id: 't3', status: 'todo' }),
        ],
      }),
    )

    expect(summary.isBlank).toBe(false)
    expect(summary.taskCount).toBe(3)
    expect(summary.doingCount).toBe(1)
    expect(summary.doneCount).toBe(1)
    expect(summary.todoCount).toBe(1)
    expect(summary.note).toContain('正在追踪 3 个任务')
    expect(summary.note).toContain('进行中 1')
    expect(summary.note).not.toContain('空白项目')
  })

  it('认领一步之后：提示变成「进行中」而不是空白项目', () => {
    const before = summarizeProjectStatus(makeProject())
    const after = summarizeProjectStatus(
      makeProject({
        tasks: [
          makeTask({
            title: '写清项目目标',
            status: 'doing',
            suggestedOwner: null,
            why: null,
            draftKey: '["写清项目目标","一页目标说明",null,[],[]]',
          }),
        ],
      }),
    )

    expect(before.isBlank).toBe(true)
    expect(after.isBlank).toBe(false)
    expect(after.note).toContain('进行中 1')
    expect(after.note).not.toContain('空白项目')
  })
})
