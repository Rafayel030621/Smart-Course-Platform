import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectMindMap from '@/components/ProjectMindMap.vue'
import type { Project } from '@/types/platform'
import { createProjectWithTask, freshStore } from './support'

/**
 * ProjectMindMap 组件级状态显示测试
 * ----------------------------------------------------------------------------
 * 证明「taskId/status 从输入到渲染」的整条运行时链路：
 * store 的真实 action（claimTask / submitEvidence）→ commit → syncProjectView
 * 投影出 steps（带真实 taskId / status）→ 组件把状态画进 SVG
 * （进行中 / 已完成；没有 status 的旧建议走「建议：…」兜底）。
 * 不是只验证类型，也不是只调用 deriveStepViews / taskStatusText。
 */

/** 内存 Storage 替身：不碰真实 localStorage，也避免用例之间互相污染 */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  }
}

/**
 * 建议接口的替身：返回不可重试的契约错误。
 * submitEvidence 落盘后会请求建议，替身让 store 直接走本地规则兜底，
 * 不因重试退避变慢，也绝不访问真实网络。
 */
function stubAdvisorContractError(): void {
  const fetchImpl = vi.fn(async () => new Response(
    JSON.stringify({
      contractVersion: '1.0',
      requestId: null,
      code: 'INVALID_INPUT',
      message: '测试替身',
      retryable: false,
      retryAfterSeconds: null,
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchImpl)
}

/** 单独挂载地图组件：它只依赖 project 一个 prop，不需要 router / pinia 插件 */
function mountMap(project: Project): VueWrapper {
  return mount(ProjectMindMap, { props: { project } })
}

/** SVG 里每个 <text> 节点的可见文本，按文档顺序排列 */
function svgTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('svg text').map((node) => node.text())
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
  stubAdvisorContractError()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProjectMindMap：任务状态渲染进地图 SVG', () => {
  it('认领后的 doing 任务显示「进行中 · AI 追踪中」，不走建议兜底', () => {
    const store = freshStore()
    const { taskId } = createProjectWithTask(store, '地图组件项目', '把数据处理脚本跑通')
    const project = store.current
    if (project === undefined) throw new Error('缺少测试项目')

    // 输入侧：认领的真实任务通过投影带上了 taskId / status（页面据此认领 / 提问）。
    // 注意 createProject 会注入模板 todo 任务，认领的任务追加在末尾，按 taskId 定位。
    const position = project.steps.findIndex((step) => step.taskId === taskId) + 1
    const stepTitle = `步骤${position} 把数据处理脚本跑通`
    expect(position).toBeGreaterThan(0)
    expect(project.steps[position - 1]?.status).toBe('doing')

    const wrapper = mountMap(project)
    expect(wrapper.find('svg').exists()).toBe(true)

    const texts = svgTexts(wrapper)
    expect(texts).toContain(stepTitle)
    expect(texts).toContain('进行中 · AI 追踪中')
    // 状态与标题配对：SVG 文本顺序里，标题的下一个节点就是它的状态
    const titleIndex = texts.indexOf(stepTitle)
    expect(titleIndex).toBeGreaterThan(-1)
    expect(texts[titleIndex + 1]).toBe('进行中 · AI 追踪中')
    // 有真实状态时不再显示「建议：」兜底文案
    expect(texts.some((text) => text.startsWith('建议：'))).toBe(false)
  })

  it('提交证据确认完成后，同一任务显示「已完成 · AI 追踪中」', async () => {
    const store = freshStore()
    const { taskId } = createProjectWithTask(store, '地图组件项目', '完成实验数据对比')
    const project = store.current
    if (project === undefined) throw new Error('缺少测试项目')

    const result = await store.submitEvidence({
      submissionId: 'sub-map-done-1',
      taskId,
      didWhat: '跑完了对比实验并记录结果',
      complete: true,
    })
    expect(result.ok).toBe(true)
    const position = project.steps.findIndex((step) => step.taskId === taskId) + 1
    const stepTitle = `步骤${position} 完成实验数据对比`
    expect(position).toBeGreaterThan(0)
    expect(project.steps[position - 1]?.status).toBe('done')

    const wrapper = mountMap(project)
    const texts = svgTexts(wrapper)
    expect(texts).toContain(stepTitle)
    expect(texts).toContain('已完成 · AI 追踪中')
    const titleIndex = texts.indexOf(stepTitle)
    expect(titleIndex).toBeGreaterThan(-1)
    expect(texts[titleIndex + 1]).toBe('已完成 · AI 追踪中')
    // 该任务已完成：地图里不应再出现它的「进行中 · AI 追踪中」
    //（注意「进行中」三个字也会出现在里程碑状态里，所以断言用任务状态专属的完整文案）
    expect(texts.some((text) => text.includes('进行中 · AI 追踪中'))).toBe(false)
  })

  it('没有 status 的旧建议走兜底文案「建议：待定 · AI 追踪中」，与真实状态共存', () => {
    const store = freshStore()
    createProjectWithTask(store, '地图组件项目', '把数据处理脚本跑通')
    const project = store.current
    if (project === undefined) throw new Error('缺少测试项目')

    // SuggestedStep.status 是可选字段：在组件 props 契约边界上
    // 构造一条没有 status 的旧版建议（旧数据 / 旧入口的输入形状），
    // 验证组件对它的兜底渲染——不改组件、不放宽断言。
    const legacyPosition = project.steps.length + 1
    const legacyTitle = `步骤${legacyPosition} 旧数据里的建议步骤`
    project.steps = [
      ...project.steps,
      { t: '旧数据里的建议步骤', owner: '待定', why: '', done: '' },
    ]

    const wrapper = mountMap(project)
    const texts = svgTexts(wrapper)
    expect(texts).toContain(legacyTitle)
    expect(texts).toContain('建议：待定 · AI 追踪中')
    const legacyIndex = texts.indexOf(legacyTitle)
    expect(legacyIndex).toBeGreaterThan(-1)
    expect(texts[legacyIndex + 1]).toBe('建议：待定 · AI 追踪中')
    // 同一张图里，真实 doing 任务仍是「进行中」，两种文案互不覆盖
    expect(texts).toContain('进行中 · AI 追踪中')
  })
})
