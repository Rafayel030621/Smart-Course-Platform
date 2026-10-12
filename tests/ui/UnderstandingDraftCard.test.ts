import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import UnderstandingDraftCard from '@/components/UnderstandingDraftCard.vue'
import type { DraftItemView, DraftSourceView, UnderstandingDraftView } from '@/components/materialTypes'
import { expectNoInternalTokens, visibleTextOf } from './visibleText'

/**
 * 材料理解草稿卡片（雍-3 / 雍-4）
 * ----------------------------------------------------------------------------
 * 重点验证界面规则：
 *   1. 默认待确认；修改后仍是待确认，编辑不等于确认；
 *   2. 所有操作按材料 ID + 版本 + 条目 ID 发出；
 *   3. 整份确认只提交当前存在的条目；
 *   4. 材料版本变化后，旧确认状态不继续显示为"已确认"；
 *   5. 空草稿（fallback）不显示确认成功。
 */

function source(overrides: Partial<DraftSourceView> = {}): DraftSourceView {
  return {
    materialId: 'mat_9b1e7c2f',
    materialName: '实验手册.md',
    materialVersion: 1,
    segmentId: 'seg_0',
    startLine: 1,
    endLine: 8,
    ...overrides,
  }
}

function item(overrides: Partial<DraftItemView> = {}): DraftItemView {
  return {
    itemId: 'cnd_goal_0',
    text: '用 ERA5 海浪场数据复现极端风浪事件的识别流程',
    status: 'pending',
    sources: [source()],
    ...overrides,
  }
}

function draftView(overrides: Partial<UnderstandingDraftView> = {}): UnderstandingDraftView {
  return {
    materialId: 'mat_9b1e7c2f',
    materialName: '实验手册.md',
    materialVersion: 1,
    blocks: [
      { key: 'goalCandidates', items: [item()] },
      { key: 'outcomeCandidates', items: [] },
      {
        key: 'dataNotes',
        items: [
          item({
            itemId: 'cnd_data_0',
            text: '包含有效波高、风速与经纬度字段',
            status: 'confirmed',
            sources: [source({ segmentId: 'seg_1', startLine: 10, endLine: 24 })],
          }),
        ],
      },
      { key: 'methodNotes', items: [] },
      {
        key: 'openQuestions',
        items: [
          item({
            itemId: 'cnd_question_0',
            text: '材料没有给出时间范围',
            status: 'modified',
            sources: [source({ segmentId: 'seg_2', startLine: 26, endLine: 30 })],
          }),
        ],
      },
    ],
    ...overrides,
  }
}

function buttonWithText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((button) => button.text() === text)
}

describe('UnderstandingDraftCard', () => {
  it('五类内容与材料来源都展示出来（材料名 + 版本 + 起止行号）', () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView(), source: 'model' } })

    const text = wrapper.text()
    for (const title of [
      '项目目标候选',
      '预期产出候选',
      '数据字段与规模线索',
      '方法或约束线索',
      '待确认问题',
    ]) {
      expect(text, `缺少区块：${title}`).toContain(title)
    }
    expect(text).toContain('实验手册.md（版本 1）第 1–8 行')
    expect(text).toContain('第 10–24 行')
    expect(text).toContain('AI 模型生成')
  })

  it('条目状态如实显示：待确认 / 已确认 / 已修改待确认', () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    const text = wrapper.text()
    expect(text).toContain('待确认')
    expect(text).toContain('已确认')
    expect(text).toContain('已修改 · 待确认')
    expect(text).toContain('已确认 1 / 共 3 条')
  })

  it('单条确认按材料 ID、版本与条目 ID 发出', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '确认')?.trigger('click')

    expect(wrapper.emitted('confirm')?.[0][0]).toEqual({
      materialId: 'mat_9b1e7c2f',
      materialVersion: 1,
      itemId: 'cnd_goal_0',
    })
  })

  it('修改后仍然待确认：只发出修改事件，不自动确认', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '修改')?.trigger('click')
    const textarea = wrapper.get('textarea')
    await textarea.setValue('改成更具体的一句目标')
    expect(wrapper.text()).toContain('保存后仍是待确认')

    await buttonWithText(wrapper, '保存修改')?.trigger('click')

    expect(wrapper.emitted('edit')?.[0][0]).toEqual({
      materialId: 'mat_9b1e7c2f',
      materialVersion: 1,
      itemId: 'cnd_goal_0',
      text: '改成更具体的一句目标',
    })
    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.text()).toContain('待确认')
  })

  it('修改为空内容时不提交，并给出中文提示', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '修改')?.trigger('click')
    await wrapper.get('textarea').setValue('   ')
    await buttonWithText(wrapper, '保存修改')?.trigger('click')

    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(wrapper.get('[role="alert"]').text()).toContain('不能为空')
  })

  it('已确认条目可以撤销确认', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '撤销确认')?.trigger('click')

    expect(wrapper.emitted('undo')?.[0][0]).toEqual({
      materialId: 'mat_9b1e7c2f',
      materialVersion: 1,
      itemId: 'cnd_data_0',
    })
  })

  it('删除条目按条目 ID 发出', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '删除')?.trigger('click')

    expect(wrapper.emitted('remove')?.[0][0]).toEqual({
      materialId: 'mat_9b1e7c2f',
      materialVersion: 1,
      itemId: 'cnd_goal_0',
    })
  })

  it('整份确认只提交当前存在的条目（已删除的不会被恢复）', async () => {
    const view = draftView()
    view.blocks[0].items = [] // 模拟用户已经删掉了这条候选
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: view } })

    await buttonWithText(wrapper, '整份确认')?.trigger('click')

    const payload = wrapper.emitted('confirmAll')?.[0][0] as {
      materialId: string
      materialVersion: number
      itemIds: string[]
    }
    expect(payload.materialId).toBe('mat_9b1e7c2f')
    expect(payload.materialVersion).toBe(1)
    expect(payload.itemIds).toEqual(['cnd_data_0', 'cnd_question_0'])
    expect(payload.itemIds).not.toContain('cnd_goal_0')
  })

  it('全部确认后按钮禁用并显示已确认进度', async () => {
    const view = draftView()
    for (const block of view.blocks) {
      block.items = block.items.map((entry) => ({ ...entry, status: 'confirmed' as const }))
    }
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: view } })

    expect(buttonWithText(wrapper, '整份确认')?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('全部条目已确认')
  })

  it('空草稿不显示确认成功，也不能整份确认', async () => {
    const view = draftView()
    for (const block of view.blocks) block.items = []
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: view, source: 'model' } })

    expect(wrapper.text()).toContain('这次没有生成任何候选内容')
    expect(buttonWithText(wrapper, '整份确认')?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('没有可确认的内容')
    expect(wrapper.text()).not.toContain('全部条目已确认')
  })

  it('fallback 时显示中文说明，不制造候选内容', async () => {
    const view = draftView()
    for (const block of view.blocks) block.items = []
    const wrapper = mount(UnderstandingDraftCard, {
      props: {
        draft: view,
        source: 'fallback',
        notice: '模型调用超时，未生成理解草稿；材料已解析成功，可以先手动登记要点，稍后重新生成。',
      },
    })

    expect(wrapper.text()).toContain('模型调用超时')
    expect(wrapper.text()).toContain('服务端规则兜底')
    expect(wrapper.text()).not.toContain('用 ERA5')
  })

  it('生成失败时显示中文原因并提供重试', async () => {
    const wrapper = mount(UnderstandingDraftCard, {
      props: { draft: null, errorText: '理解草稿没有生成成功，请稍后重试', hasMaterial: true },
    })

    expect(wrapper.get('[role="alert"]').text()).toContain('理解草稿没有生成成功')
    await buttonWithText(wrapper, '重试')?.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('没有材料时提示先去上传材料', () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: null, hasMaterial: false } })

    expect(wrapper.text()).toContain('还没有材料')
    expect(wrapper.text()).toContain('MD 或 TXT')
  })

  it('材料版本不同时不继续显示旧确认状态，且全部条目操作被禁用', async () => {
    const wrapper = mount(UnderstandingDraftCard, {
      props: { draft: draftView(), currentMaterialVersion: 2 },
    })

    const text = wrapper.text()
    expect(text).toContain('材料已更新')
    expect(text).toContain('确认状态已失效')
    expect(text).not.toContain('已确认 1 / 共 3 条')
    expect(text).not.toContain('全部条目已确认')

    // 过期草稿：确认 / 撤销确认 / 修改 / 删除 / 整份确认都保留但禁用
    for (const label of ['确认', '撤销确认', '修改', '删除', '整份确认']) {
      const buttons = wrapper.findAll('button').filter((button) => button.text() === label)
      expect(buttons.length, `${label} 按钮应当存在`).toBeGreaterThanOrEqual(1)
      for (const button of buttons) {
        expect(button.attributes('disabled'), `${label} 应当被禁用`).toBeDefined()
      }
    }

    await buttonWithText(wrapper, '确认')?.trigger('click')
    await buttonWithText(wrapper, '修改')?.trigger('click')
    await buttonWithText(wrapper, '删除')?.trigger('click')
    await buttonWithText(wrapper, '整份确认')?.trigger('click')
    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('remove')).toBeUndefined()
    expect(wrapper.emitted('confirmAll')).toBeUndefined()
  })

  it('切换材料后旧编辑文本不会被提交', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '修改')?.trigger('click')
    await wrapper.get('textarea').setValue('这段文字属于旧材料')

    // 材料换成另一份（ID 与版本都变了）
    await wrapper.setProps({
      draft: draftView({
        materialId: 'mat_other',
        materialName: '数据说明.txt',
        materialVersion: 3,
        blocks: draftView().blocks,
      }),
    })

    expect(wrapper.find('textarea').exists()).toBe(false)

    await buttonWithText(wrapper, '保存修改')?.trigger('click')
    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(wrapper.text()).not.toContain('这段文字属于旧材料')
  })

  it('同一材料的新版本同样作废正在编辑的内容', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '修改')?.trigger('click')
    await wrapper.get('textarea').setValue('旧版本里写的内容')
    await wrapper.setProps({ draft: draftView({ materialVersion: 2 }) })

    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.emitted('edit')).toBeUndefined()
  })

  it('加载中不能提交修改', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '修改')?.trigger('click')
    await wrapper.get('textarea').setValue('加载中不应该能提交')

    await wrapper.setProps({ loading: true })
    await buttonWithText(wrapper, '保存修改')?.trigger('click')

    expect(wrapper.emitted('edit')).toBeUndefined()
  })

  it('禁用状态不能提交修改', async () => {
    const wrapper = mount(UnderstandingDraftCard, { props: { draft: draftView() } })

    await buttonWithText(wrapper, '修改')?.trigger('click')
    await wrapper.get('textarea').setValue('禁用时不应该能提交')

    await wrapper.setProps({ disabled: true })
    await buttonWithText(wrapper, '保存修改')?.trigger('click')

    expect(wrapper.emitted('edit')).toBeUndefined()
  })

  it('加载中不显示可操作按钮', () => {
    const wrapper = mount(UnderstandingDraftCard, {
      props: { draft: null, loading: true, hasMaterial: true },
    })

    expect(wrapper.text()).toContain('正在生成理解草稿')
    expect(buttonWithText(wrapper, '整份确认')).toBeUndefined()
  })

  it('用户可见文本不出现内部字段名', () => {
    const wrapper = mount(UnderstandingDraftCard, {
      props: { draft: draftView(), source: 'model', currentMaterialVersion: 1 },
    })
    expectNoInternalTokens(visibleTextOf(wrapper))
  })
})
