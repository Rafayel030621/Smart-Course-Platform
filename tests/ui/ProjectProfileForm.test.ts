import { beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ProjectProfileForm from '@/components/ProjectProfileForm.vue'
import { PROFILE_LIMITS } from '@/components/materialTypes'
import { createProject, freshStore, type WorkbenchStore } from './support'
import { expectNoInternalTokens, visibleTextOf } from './visibleText'

/**
 * 项目基本信息表单（雍-1）
 * ----------------------------------------------------------------------------
 * 这里测的是**真实挂载的组件**：它直接读 store、直接调 `store.updateProjectProfile`，
 * 没有 props、也不向父组件发 save 事件。覆盖：
 *   1. 从 store 读资料、保存写回 store、失败保留输入；
 *   2. 与资料无关的版本变化不清空未保存的表单；
 *   3. 切换项目以 store 为准重建；刷新（重建 store）后资料仍在；
 *   4. 长度上限与"用户可见文本不出现内部字段名"。
 */

function setup(name = '资料表单项目'): { store: WorkbenchStore; wrapper: VueWrapper } {
  const store = freshStore()
  createProject(store, name)
  const wrapper = mount(ProjectProfileForm)
  return { store, wrapper }
}

/** 第 1 个 textarea 是项目目标；第 1 个 input 是成员姓名 */
function goalOf(wrapper: VueWrapper): HTMLTextAreaElement {
  return wrapper.findAll('textarea')[0].element as HTMLTextAreaElement
}

function membersOf(wrapper: VueWrapper): HTMLInputElement {
  return wrapper.findAll('input')[0].element as HTMLInputElement
}

async function fillMembers(wrapper: VueWrapper, value: string): Promise<void> {
  await wrapper.findAll('input')[0].setValue(value)
}

beforeEach(() => {
  localStorage.clear()
})

describe('ProjectProfileForm（真实挂载，读写 store）', () => {
  it('新建项目时是空表单，并提示先补项目目标与预期产出', () => {
    const { store, wrapper } = setup()

    expect(goalOf(wrapper).value).toBe('')
    expect(membersOf(wrapper).value).toBe('')
    expect(store.basicInfo.goal).toBeNull()
    expect(wrapper.text()).toContain('还没有填写')
    // 还没保存前不显示"已保存"
    expect(wrapper.text()).not.toContain('已保存')
  })

  it('填写后保存：结构化写入 store，并显示已保存', async () => {
    const { store, wrapper } = setup()

    await wrapper.findAll('textarea')[0].setValue('  识别极端风浪事件并做原型  ')
    await wrapper.findAll('textarea')[1].setValue('可交互原型 + 一页结论')
    await fillMembers(wrapper, '张三、李四')
    await wrapper.find('form').trigger('submit')

    expect(store.basicInfo.goal).toBe('识别极端风浪事件并做原型')
    expect(store.basicInfo.expectedOutcome).toBe('可交互原型 + 一页结论')
    expect(store.basicInfo.memberNames).toEqual(['张三', '李四'])
    expect(wrapper.text()).toContain('已保存')
  })

  it('保存失败时保留输入，并显示中文原因', async () => {
    const { store, wrapper } = setup()

    await wrapper.findAll('textarea')[0].setValue('失败也要留下这段文字')
    // 11 名成员超出契约 13.1 的上限（≤ 10 人）
    const tooMany = Array.from({ length: PROFILE_LIMITS.members + 1 }, (_v, i) => `成员${i + 1}`)
    await fillMembers(wrapper, tooMany.join('、'))
    await wrapper.find('form').trigger('submit')

    expect(wrapper.text()).toContain(`项目成员最多 ${PROFILE_LIMITS.members} 人`)
    expect(goalOf(wrapper).value).toBe('失败也要留下这段文字')
    expect(store.basicInfo.goal).toBeNull()
    expect(wrapper.text()).not.toContain('已保存')
  })

  it('与资料无关的版本变化（认领任务）不会清空未保存的表单', async () => {
    const { store, wrapper } = setup()

    await wrapper.findAll('textarea')[0].setValue('还没保存的目标草稿')

    const claimed = store.claimTask({
      draft: {
        title: '认领一步让版本变化',
        doneCriteria: '留下证据',
        requestId: null,
        basisEvidenceIds: [],
        basisDoubtIds: [],
      },
    })
    expect(claimed.ok).toBe(true)
    await wrapper.vm.$nextTick()

    // 版本变了，但资料本身没变：用户没保存的输入必须还在
    expect(goalOf(wrapper).value).toBe('还没保存的目标草稿')
    expect(store.basicInfo.goal).toBeNull()
  })

  it('切换项目时以 store 为准重建表单，不把上一个项目的输入带过去', async () => {
    const store = freshStore()
    const firstId = createProject(store, '项目一')
    createProject(store, '项目二')
    store.updateProjectProfile({ goal: '第二个项目的目标' })
    const wrapper = mount(ProjectProfileForm)

    await wrapper.findAll('textarea')[0].setValue('项目二改到一半的内容')
    expect(goalOf(wrapper).value).toBe('项目二改到一半的内容')

    store.selectProject(firstId)
    await wrapper.vm.$nextTick()

    expect(goalOf(wrapper).value).toBe('')
    expect(wrapper.text()).not.toContain('项目二改到一半的内容')
  })

  it('刷新（重建 store）后资料仍在', async () => {
    const { store, wrapper } = setup('刷新项目')
    await wrapper.findAll('textarea')[0].setValue('刷新后仍要看到的目标')
    await wrapper.find('form').trigger('submit')
    expect(store.basicInfo.goal).toBe('刷新后仍要看到的目标')
    wrapper.unmount()

    const reloaded = freshStore()
    const reloadedWrapper = mount(ProjectProfileForm)

    expect(reloaded.current?.projectId).toBe(store.current?.projectId)
    expect(goalOf(reloadedWrapper).value).toBe('刷新后仍要看到的目标')
  })

  it('输入长度遵循契约上限', () => {
    const { wrapper } = setup()

    // 顺序：目标 / 预期产出 / 成员姓名(input) / 研究周期(input) / 范围 / 暂不处理
    const textareas = wrapper.findAll('textarea')
    expect(textareas[0].attributes('maxlength')).toBe(String(PROFILE_LIMITS.text))
    expect(textareas[1].attributes('maxlength')).toBe(String(PROFILE_LIMITS.text))
    expect(textareas[2].attributes('maxlength')).toBe(String(PROFILE_LIMITS.text))
    expect(textareas[3].attributes('maxlength')).toBe(String(PROFILE_LIMITS.text))

    const inputs = wrapper.findAll('input')
    expect(inputs[0].attributes('maxlength')).toBeUndefined()
    expect(inputs[1].attributes('maxlength')).toBe(String(PROFILE_LIMITS.researchPeriod))
  })

  it('用户可见文本不出现内部字段名', () => {
    const { wrapper } = setup()
    expectNoInternalTokens(visibleTextOf(wrapper))
  })
})
