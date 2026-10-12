import type { VueWrapper } from '@vue/test-utils'
import { expect } from 'vitest'

/**
 * 用户可见文本的检查工具（不是测试文件）
 * ----------------------------------------------------------------------------
 * 把页面上的正文、placeholder、title、aria-label 一起收集起来，
 * 断言里面不出现内部字段名——这是本轮"用户可读性"要求的可执行形式。
 *
 * 刻意**不 import 任何应用模块**（尤其不 import `@/router`）：
 * WorkbenchView.test.ts 会把 vue-router 整个替换成替身，
 * 这里若引入真实 router 会让那个套件加载失败。
 */

/** 内部字段名：任何页面的用户可见文本里都不允许出现 */
export const INTERNAL_TOKENS = [
  'currentMilestone',
  'confirmedContext',
  'projectRevision',
  'doneCriteria',
  'evidence',
  'doubts',
  'tasks',
  'doing',
  'done',
  // M2-A：材料与理解草稿相关内部名（界面只能说人话）
  'materialId',
  'materialVersion',
  'segmentId',
  'understandingDraft',
  'goalCandidates',
  'outcomeCandidates',
  'dataNotes',
  'methodNotes',
  'openQuestions',
] as const

/** 用户可见文本 = 正文 + placeholder / title / aria-label */
export function visibleTextOf(wrapper: VueWrapper): string {
  const parts: string[] = [wrapper.text()]
  for (const element of wrapper.findAll('[placeholder], [title], [aria-label]')) {
    for (const attribute of ['placeholder', 'title', 'aria-label'] as const) {
      const value = element.attributes(attribute)
      if (value !== undefined && value !== '') parts.push(value)
    }
  }
  return parts.join('\n')
}

export function expectNoInternalTokens(text: string): void {
  for (const token of INTERNAL_TOKENS) {
    expect(text, `用户可见文本里不应出现内部字段「${token}」`).not.toContain(token)
  }
}
