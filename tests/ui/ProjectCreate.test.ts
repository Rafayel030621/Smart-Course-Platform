import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ProjectCreate from '@/components/ProjectCreate.vue'
import { freshStore } from './support'
import { expectNoInternalTokens, visibleTextOf } from './visibleText'

/**
 * 创建页（M2-A 收尾）
 * ----------------------------------------------------------------------------
 * 创建页只负责创建**空白项目**：
 *   - 不再出现 docx / pdf / csv / zip 的上传入口，也不再声称"AI 会解析这些内容"；
 *   - 材料上传与项目基本信息都在工作台完成，页面用中文说明指过去。
 * 创建动作仍然走真实的 store.createProject。
 */

describe('ProjectCreate', () => {
  it('只创建空白项目：没有材料上传入口，也没有"AI 会解析"的说法', () => {
    freshStore()
    const wrapper = mount(ProjectCreate)

    const text = wrapper.text()
    expect(wrapper.find('input[type="file"]').exists()).toBe(false)
    expect(text).not.toContain('docx')
    expect(text).not.toContain('pdf')
    expect(text).not.toContain('csv')
    expect(text).not.toContain('zip')
    expect(text).not.toContain('AI 会解析')
    expect(text).not.toContain('数据集会用于追踪')
    expect(text).not.toContain('上传实验手册')
  })

  it('指向工作台：说明材料与项目基本信息去哪里补充', () => {
    freshStore()
    const wrapper = mount(ProjectCreate)

    const text = wrapper.text()
    expect(text).toContain('创建后，请到工作台填写项目基本信息，并上传 MD 或 TXT 材料')
    expect(text).toContain('MD 或 TXT')
    expect(text).toContain('1 MB')
    expect(text).toContain('CSV / XLSX 将在下一批支持')
  })

  it('选择自定义名称后创建的是真实空白项目', async () => {
    const store = freshStore()
    const wrapper = mount(ProjectCreate)

    await wrapper.get('select').setValue('__custom__')
    await wrapper.get('input[type="text"]').setValue('M2-A 创建页测试项目')
    await wrapper.get('button.create-btn').trigger('click')

    expect(store.hasProject).toBe(true)
    expect(store.current?.name).toBe('M2-A 创建页测试项目')
    // 空白项目：没有任何任务，也没有材料记录
    expect(store.current?.tasks).toHaveLength(0)
    expect(store.current?.materials).toHaveLength(0)
  })

  it('没有选择题目时不会创建项目', async () => {
    const store = freshStore()
    const wrapper = mount(ProjectCreate)

    await wrapper.get('button.create-btn').trigger('click')

    expect(store.hasProject).toBe(false)
  })

  it('用户可见文本不出现内部字段名', () => {
    freshStore()
    const wrapper = mount(ProjectCreate)
    expectNoInternalTokens(visibleTextOf(wrapper))
  })
})
