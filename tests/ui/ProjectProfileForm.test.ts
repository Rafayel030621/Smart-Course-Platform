import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ProjectProfileForm from '@/components/ProjectProfileForm.vue'
import { PROFILE_LIMITS, type ProfileFormValue } from '@/components/materialTypes'
import { expectNoInternalTokens, visibleTextOf } from './visibleText'

/**
 * 项目基本信息表单（雍-1）
 * ----------------------------------------------------------------------------
 * 只测界面行为：编辑、保存事件、失败保留输入、切换项目不串表单。
 * 真实保存由父组件的 store action 完成，这里用 props 扮演"已保存 / 保存失败"。
 */

function profile(overrides: Partial<ProfileFormValue> = {}): ProfileFormValue {
  return {
    goal: '构建极端风浪事件识别与预警的原型系统',
    expectedOutcome: '可交互原型 + 一页结论',
    memberNames: ['张同学', '李同学'],
    researchPeriod: '第 3 周至第 14 周',
    scope: '先做西北太平洋',
    outOfScope: '不做移动端',
    ...overrides,
  }
}

describe('ProjectProfileForm', () => {
  it('展示已保存的内容，未修改时不显示保存成功也不允许保存', () => {
    const wrapper = mount(ProjectProfileForm, { props: { profile: profile(), projectKey: 'prj_1' } })

    expect(wrapper.get('textarea').element.value).toBe('构建极端风浪事件识别与预警的原型系统')
    expect(wrapper.text()).not.toContain('已保存')
    expect(wrapper.text()).toContain('还没有填写')
    expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined()
  })

  it('编辑后可以保存，保存事件带去掉首尾空格的内容', async () => {
    const wrapper = mount(ProjectProfileForm, { props: { profile: profile(), projectKey: 'prj_1' } })

    await wrapper.findAll('textarea')[0].setValue('  换一个更具体的目标  ')
    expect(wrapper.text()).toContain('有未保存的修改')

    await wrapper.get('button.primary').trigger('click')

    const emitted = wrapper.emitted('save')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0][0]).toEqual(profile({ goal: '换一个更具体的目标' }))
  })

  it('成员为空行时不会提交空名字，也不会超过成员上限', async () => {
    const wrapper = mount(ProjectProfileForm, {
      props: { profile: profile({ memberNames: ['张同学', '   '] }), projectKey: 'prj_1' },
    })

    await wrapper.findAll('input')[0].setValue('张同学（组长）')
    await wrapper.get('button.primary').trigger('click')

    const value = wrapper.emitted('save')?.[0][0] as ProfileFormValue
    expect(value.memberNames).toEqual(['张同学（组长）'])
  })

  it('成员数量到上限后不能再添加，删除后可以再加', async () => {
    const members = Array.from({ length: PROFILE_LIMITS.members }, (_, index) => `成员${index + 1}`)
    const wrapper = mount(ProjectProfileForm, {
      props: { profile: profile({ memberNames: members }), projectKey: 'prj_1' },
    })

    const addButton = wrapper.findAll('button').find((button) => button.text().includes('添加成员'))
    expect(addButton?.attributes('disabled')).toBeDefined()

    const removeButton = wrapper.findAll('button').find((button) => button.text() === '移除')
    await removeButton?.trigger('click')

    const addAfterRemove = wrapper.findAll('button').find((button) => button.text().includes('添加成员'))
    expect(addAfterRemove?.attributes('disabled')).toBeUndefined()
  })

  it('保存失败时保留输入，并显示中文原因', async () => {
    const wrapper = mount(ProjectProfileForm, {
      props: { profile: profile(), projectKey: 'prj_1' },
    })

    await wrapper.findAll('textarea')[0].setValue('失败也要留下这段文字')
    await wrapper.get('button.primary').trigger('click')
    await wrapper.setProps({ saveError: '没有保存成功，请稍后重试' })

    expect(wrapper.get('[role="alert"]').text()).toContain('没有保存成功')
    expect(wrapper.findAll('textarea')[0].element.value).toBe('失败也要留下这段文字')
    expect(wrapper.text()).not.toContain('已保存')
  })

  it('只有父组件确认保存成功后才显示已保存', async () => {
    const wrapper = mount(ProjectProfileForm, { props: { profile: profile(), projectKey: 'prj_1' } })

    await wrapper.findAll('textarea')[0].setValue('改了一点点')
    await wrapper.get('button.primary').trigger('click')
    expect(wrapper.text()).not.toContain('已保存')

    await wrapper.setProps({ savedAt: '12:00:00' })
    expect(wrapper.text()).toContain('已保存 · 12:00:00')
    expect(wrapper.text()).not.toContain('有未保存的修改')
  })

  it('保存中显示保存中并禁用按钮', async () => {
    const wrapper = mount(ProjectProfileForm, { props: { profile: profile(), projectKey: 'prj_1' } })

    await wrapper.findAll('textarea')[0].setValue('保存中的内容')
    await wrapper.setProps({ saving: true })

    expect(wrapper.get('button.primary').text()).toContain('保存中')
    expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined()
  })

  it('切换项目时重置为该项目的内容，不把上一个项目的输入带过去', async () => {
    const wrapper = mount(ProjectProfileForm, { props: { profile: profile(), projectKey: 'prj_1' } })

    await wrapper.findAll('textarea')[0].setValue('上一个项目改到一半的内容')
    expect(wrapper.text()).toContain('有未保存的修改')

    await wrapper.setProps({
      projectKey: 'prj_2',
      profile: profile({ goal: '第二个项目的目标', memberNames: ['王同学'] }),
      savedAt: null,
      saveError: null,
    })

    expect(wrapper.findAll('textarea')[0].element.value).toBe('第二个项目的目标')
    expect(wrapper.text()).toContain('还没有填写')
    expect(wrapper.text()).not.toContain('上一个项目改到一半的内容')
  })

  it('数据层未接入时禁用保存并说明原因，但内容仍可填写', async () => {
    const wrapper = mount(ProjectProfileForm, {
      props: {
        profile: null,
        disabled: true,
        disabledNote: '项目基本信息的数据接口尚未接入：可以先填着看，保存暂不可用。',
        projectKey: 'prj_1',
      },
    })

    expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('保存暂不可用')

    await wrapper.findAll('textarea')[0].setValue('先写着')
    expect(wrapper.findAll('textarea')[0].element.value).toBe('先写着')
    expect(wrapper.text()).not.toContain('已保存')
  })

  it('输入长度遵循契约上限', () => {
    const wrapper = mount(ProjectProfileForm, { props: { profile: profile(), projectKey: 'prj_1' } })

    const textareas = wrapper.findAll('textarea')
    expect(textareas[0].attributes('maxlength')).toBe(String(PROFILE_LIMITS.text))
    expect(textareas[2].attributes('maxlength')).toBe(String(PROFILE_LIMITS.text))

    const inputs = wrapper.findAll('input')
    expect(inputs[0].attributes('maxlength')).toBe(String(PROFILE_LIMITS.memberName))
  })

  it('用户可见文本不出现内部字段名', () => {
    const wrapper = mount(ProjectProfileForm, {
      props: { profile: profile(), projectKey: 'prj_1', saveError: '没有保存成功，请稍后重试' },
    })
    expectNoInternalTokens(visibleTextOf(wrapper))
  })
})
