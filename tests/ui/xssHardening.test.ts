import { mount } from '@vue/test-utils'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import PapersView from '@/views/PapersView.vue'
import ProjectMindMap from '@/components/ProjectMindMap.vue'
import { createProject, freshStore } from './support'

/**
 * v-html 注入面回归测试
 * ----------------------------------------------------------------------------
 * 两个组件用 v-html 渲染拼接好的 HTML（论文推荐 banner、项目地图 SVG），
 * 项目名/短名是用户输入。这里证明：输入里的 HTML 特殊字符与引号都被转义，
 * 不会变成可执行元素或属性。
 */

const PAYLOAD = '<img src="x" onerror="alert(1)">'

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index],
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => map.set(key, String(value)),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('v-html 渲染面：用户输入必须转义', () => {
  it('论文推荐 banner 不把项目短名渲染成 HTML 元素', () => {
    const store = freshStore()
    createProject(store, PAYLOAD)
    const project = store.current
    if (project === undefined) throw new Error('缺少测试项目')

    const wrapper = mount(PapersView)
    const html = wrapper.find('.mode-banner').html()

    // 尖括号必须被转义：否则 <img ...> 会成为真实元素
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror=')
    expect(html).toContain('&lt;img')
    expect(wrapper.find('.mode-banner img').exists()).toBe(false)
    // 文本内容原样保留（含引号），只是不再被当作 HTML 解析
    expect(wrapper.find('.mode-banner').text()).toContain(project.short)
    wrapper.unmount()
  })

  it('项目地图 SVG 不把项目短名渲染成 HTML 元素', () => {
    const store = freshStore()
    createProject(store, PAYLOAD)
    const project = store.current
    if (project === undefined) throw new Error('缺少测试项目')

    const wrapper = mount(ProjectMindMap, { props: { project } })
    const svgHtml = wrapper.find('svg').html()

    expect(svgHtml).not.toContain('<img')
    expect(svgHtml).not.toContain('onerror=')
    expect(svgHtml).toContain('&lt;img')
    expect(wrapper.find('svg img').exists()).toBe(false)
    // SVG 属性不受注入影响：viewBox 等结构属性保持原样
    expect(wrapper.find('svg').attributes('viewBox')).toBe('0 0 760 420')
    wrapper.unmount()
  })
})
