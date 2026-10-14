import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PapersView from '@/views/PapersView.vue'
import { createProjectWithTask, freshStore } from './support'
import { expectNoInternalTokens, visibleTextOf } from './visibleText'

/**
 * 论文推荐页的用户可读性
 * ----------------------------------------------------------------------------
 * 工作台与项目地图页的同类断言分别放在各自的用例文件里；
 * 这里把第三个页签补齐，保证三个页面的可见文本都不出现内部字段名。
 */
describe('论文推荐页', () => {
  it('用户可见文本不出现内部字段名，说人话', () => {
    const store = freshStore()
    createProjectWithTask(store, '论文项目', '先做文献调研')

    const wrapper = mount(PapersView)
    const text = visibleTextOf(wrapper)

    expectNoInternalTokens(text)
    expect(text).toContain('论文项目')
    expect(text).toContain('每个项目独立推荐')
  })
})
