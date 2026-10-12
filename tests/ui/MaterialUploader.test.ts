import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import MaterialUploader from '@/components/MaterialUploader.vue'
import { MATERIAL_ACCEPT, MATERIAL_MAX_BYTES } from '@/components/materialTypes'
import { expectNoInternalTokens, visibleTextOf } from './visibleText'

/**
 * 材料上传入口（雍-2）
 * ----------------------------------------------------------------------------
 * 只测界面与本地二次校验：类型、空文件、1 MB 上限、busy 时防重复提交。
 * 真正的字节/base64 上传由数据层负责（组件把原始 File 交给父组件，不预解码）。
 */

async function selectFile(wrapper: VueWrapper, file: File): Promise<void> {
  const input = wrapper.get('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
}

function mdFile(content = '# 标题', name = '实验手册.md'): File {
  return new File([content], name, { type: 'text/markdown' })
}

describe('MaterialUploader', () => {
  it('入口只接受 md / txt，并提示当前支持范围', () => {
    const wrapper = mount(MaterialUploader)

    expect(wrapper.get('input[type="file"]').attributes('accept')).toBe(MATERIAL_ACCEPT)
    const text = wrapper.text()
    expect(text).toContain('只支持 MD、TXT')
    expect(text).toContain('1 MB')
    expect(text).toContain('选择文件')
    expect(text).toContain('生成理解草稿')
  })

  it('选择合法 md 后发出上传事件，携带原始文件与类型', async () => {
    const wrapper = mount(MaterialUploader)
    const file = mdFile()

    await selectFile(wrapper, file)

    const emitted = wrapper.emitted('upload')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0][0]).toEqual({ file, type: 'md' })
    expect(wrapper.text()).toContain('实验手册.md')
  })

  it('选择合法 txt（大写扩展名）同样通过', async () => {
    const wrapper = mount(MaterialUploader)

    await selectFile(wrapper, new File(['纯文本'], '数据说明.TXT', { type: 'text/plain' }))

    const emitted = wrapper.emitted('upload')
    expect(emitted).toHaveLength(1)
    expect((emitted?.[0][0] as { type: string }).type).toBe('txt')
  })

  it('CSV / PDF / DOCX / ZIP 给中文说明，不发出上传事件', async () => {
    const wrapper = mount(MaterialUploader)

    for (const name of ['数据.csv', '手册.pdf', '报告.docx', '资料.zip', '没有扩展名']) {
      await selectFile(wrapper, new File(['x'], name))
      expect(wrapper.emitted('upload'), `${name} 不应触发上传`).toBeUndefined()
      expect(wrapper.get('[role="alert"]').text()).toContain('当前只支持 MD、TXT')
    }
  })

  it('空文件被拦下并提示', async () => {
    const wrapper = mount(MaterialUploader)

    await selectFile(wrapper, new File([], '空的.txt'))

    expect(wrapper.emitted('upload')).toBeUndefined()
    expect(wrapper.get('[role="alert"]').text()).toContain('内容为空')
  })

  it('超过 1 MB 被拦下并提示，恰好 1 MB 可以通过', async () => {
    const wrapper = mount(MaterialUploader)

    await selectFile(wrapper, new File([new Uint8Array(MATERIAL_MAX_BYTES + 1)], '太大.md'))
    expect(wrapper.emitted('upload')).toBeUndefined()
    expect(wrapper.get('[role="alert"]').text()).toContain('1 MB')

    await selectFile(wrapper, new File([new Uint8Array(MATERIAL_MAX_BYTES)], '刚好.md'))
    expect(wrapper.emitted('upload')).toHaveLength(1)
  })

  it('处理中禁止再次选择，避免重复提交', async () => {
    const wrapper = mount(MaterialUploader, { props: { busy: true } })

    expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined()
    expect(wrapper.get('button.primary').text()).toContain('正在处理')
    expect(wrapper.get('input[type="file"]').attributes('disabled')).toBeDefined()

    // 直接派发事件绕过"禁用元素不触发"的测试工具保护，验证组件自己的兜底判断
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [mdFile()], configurable: true })
    input.element.dispatchEvent(new Event('change'))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('upload')).toBeUndefined()
    expect(wrapper.text()).toContain('正在处理上一个文件')
  })

  it('登记模式下的第二步文案是「登记文件名」', () => {
    const wrapper = mount(MaterialUploader, { props: { registerOnly: true } })

    expect(wrapper.text()).toContain('登记文件名')
    expect(wrapper.text()).not.toContain('上传与解析')
  })

  it('失败时显示中文原因并提供重试入口', async () => {
    const wrapper = mount(MaterialUploader, { props: { errorText: '材料没有登记成功，请稍后重试' } })

    expect(wrapper.get('[role="alert"]').text()).toContain('材料没有登记成功')

    const retry = wrapper.findAll('button').find((button) => button.text() === '重试')
    await retry?.trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('阶段推进时高亮当前步骤', async () => {
    const wrapper = mount(MaterialUploader, { props: { stage: 'uploading' } })
    expect(wrapper.findAll('.mu-step.is-active').length).toBeGreaterThanOrEqual(1)

    await wrapper.setProps({ stage: 'understanding' })
    expect(wrapper.findAll('.mu-step.is-done').length).toBeGreaterThanOrEqual(2)
  })

  it('登记完成后显示「文件名已登记，正文尚未上传」，不冒充已解析', () => {
    const wrapper = mount(MaterialUploader, { props: { stage: 'registered', registerOnly: true } })

    const text = wrapper.text()
    expect(text).toContain('文件名已登记，正文尚未上传')
    expect(text).not.toContain('正文已解析')
    expect(text).not.toContain('已理解')
    expect(wrapper.findAll('.mu-step.is-done')).toHaveLength(2)
  })

  it('阶段状态文案严格区分未选择 / 已解析 / 生成中', async () => {
    const wrapper = mount(MaterialUploader, { props: { stage: 'idle' } })
    expect(wrapper.text()).toContain('还没有选择文件')

    await wrapper.setProps({ stage: 'parsed' })
    expect(wrapper.text()).toContain('正文已解析，可以生成理解草稿')

    await wrapper.setProps({ stage: 'understanding' })
    expect(wrapper.text()).toContain('正在生成理解草稿')
  })

  it('用户可见文本不出现内部字段名', () => {
    const wrapper = mount(MaterialUploader, {
      props: {
        errorText: '材料没有登记成功，请稍后重试',
        notice: '已登记文件名「实验手册.md」；正文尚未读取。',
      },
    })
    expectNoInternalTokens(visibleTextOf(wrapper))
  })
})
