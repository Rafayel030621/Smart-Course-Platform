import { flushPromises, mount } from '@vue/test-utils'
import type { Pinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import type { Router } from 'vue-router'
import App from '@/App.vue'
import ProjectMapView from '@/views/ProjectMapView.vue'
import {
  createProject,
  createProjectWithTask,
  createTestRouter,
  seedTask,
  setupStoreWithPinia,
} from './support'
import { expectNoInternalTokens, visibleTextOf } from './visibleText'

/**
 * 独立「项目地图」页面
 * ----------------------------------------------------------------------------
 * 覆盖：导航顺序与高亮、/map 路由可打开、地图跟随当前项目、空状态、
 * 以及"用户可见文本里不出现内部字段名"。
 */

/** 挂载整页 App（走真实路由表），用来验证路由与导航 */
async function mountAppAt(path: string, pinia: Pinia): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createTestRouter()
  await router.push(path)
  await router.isReady()
  const wrapper = mount(App, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router }
}

/** 单独挂载地图页（带 router，便于验证"去工作台"这类跳转） */
async function mountMapPage(pinia: Pinia): Promise<{ wrapper: ReturnType<typeof mount>; router: Router }> {
  const router = createTestRouter()
  await router.push('/map')
  await router.isReady()
  const wrapper = mount(ProjectMapView, { global: { plugins: [pinia, router] } })
  return { wrapper, router }
}

describe('顶部导航', () => {
  it('按「工作台 / 项目地图 / 论文推荐」排列，并高亮当前页', async () => {
    const { pinia } = setupStoreWithPinia()
    const { wrapper, router } = await mountAppAt('/', pinia)

    const labels = () => wrapper.findAll('nav button').map((button) => button.text())
    const activeLabels = () =>
      wrapper
        .findAll('nav button')
        .filter((button) => button.classes().includes('active'))
        .map((button) => button.text())

    expect(labels()).toEqual(['工作台', '项目地图', '论文推荐'])
    expect(activeLabels()).toEqual(['工作台'])

    await router.push('/map')
    await flushPromises()

    expect(activeLabels()).toEqual(['项目地图'])
  })
})

describe('/map 路由', () => {
  it('可以打开，并渲染独立的地图页面', async () => {
    const { store, pinia } = setupStoreWithPinia()
    createProject(store, '地图路由项目')

    const { wrapper, router } = await mountAppAt('/map', pinia)

    expect(router.currentRoute.value.name).toBe('map')
    expect(wrapper.text()).toContain('项目地图')
    expect(wrapper.text()).toContain('地图路由项目')
    // 工作台的三栏内容不应该出现在地图页
    expect(wrapper.find('.stu-grid').exists()).toBe(false)
  })
})

describe('项目地图页面', () => {
  it('显示当前项目与它的任务状态', async () => {
    const { store, pinia } = setupStoreWithPinia()
    createProjectWithTask(store, '地图项目', '把数据处理脚本跑通')

    const { wrapper } = await mountMapPage(pinia)

    expect(wrapper.text()).toContain('当前项目')
    expect(wrapper.text()).toContain('地图项目')
    expect(wrapper.text()).toContain('把数据处理脚本跑通')
    expect(wrapper.text()).toContain('进行中')
    expect(wrapper.text()).toContain('任务状态')
    expect(visibleTextOf(wrapper)).not.toContain('空白项目')
  })

  it('切换项目后地图同步更新', async () => {
    const { store, pinia } = setupStoreWithPinia()
    const first = createProjectWithTask(store, '项目一', '项目一的任务')
    const second = createProjectWithTask(store, '项目二', '项目二的任务')

    const { wrapper } = await mountMapPage(pinia)
    expect(wrapper.text()).toContain('项目二的任务')
    expect(wrapper.text()).not.toContain('项目一的任务')
    expect(wrapper.find('svg').exists()).toBe(true)

    await wrapper.find('select.proj-select').setValue(first.projectId)

    expect(store.current?.projectId).toBe(first.projectId)
    expect(wrapper.text()).toContain('项目一的任务')
    expect(wrapper.text()).not.toContain('项目二的任务')

    await wrapper.find('select.proj-select').setValue(second.projectId)
    expect(wrapper.text()).toContain('项目二的任务')
  })

  it('没有项目时给出创建项目的提示，并能跳回工作台', async () => {
    const { store, pinia } = setupStoreWithPinia()
    expect(store.current).toBeUndefined()

    const { wrapper, router } = await mountMapPage(pinia)

    expect(wrapper.text()).toContain('还没有项目')
    expect(wrapper.find('select.proj-select').exists()).toBe(false)

    const entry = wrapper.findAll('button').find((button) => button.text().includes('去工作台创建项目'))
    expect(entry).toBeDefined()
    await entry?.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.name).toBe('workbench')
  })

  it('没有任务时给出清晰空状态，不画空地图', async () => {
    const { store, pinia } = setupStoreWithPinia()
    createProject(store, '空项目')

    const { wrapper } = await mountMapPage(pinia)

    expect(wrapper.text()).toContain('这个项目还没有任务')
    expect(wrapper.text()).toContain('还没有任务。任务会在你认领')
    expect(wrapper.find('svg').exists()).toBe(false)
  })

  it('用户可见文本里不出现内部字段名', async () => {
    const { store, pinia } = setupStoreWithPinia()
    createProjectWithTask(store, '可读性项目', '整理实验结果并写结论')
    seedTask(store, 'todo', '补一段数据说明')
    seedTask(store, 'done', '已经完成的准备工作')

    const { wrapper } = await mountMapPage(pinia)

    const text = visibleTextOf(wrapper)
    expectNoInternalTokens(text)
    // 三种状态都要用中文说法
    expect(text).toContain('未开始')
    expect(text).toContain('进行中')
    expect(text).toContain('已完成')
  })
})
