import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { useWorkbenchStore } from '@/stores/workbench'

/**
 * 环境自检（不是业务测试）
 * ----------------------------------------------------------------------------
 * 只用来证明 Vitest 环境装好了：jsdom、localStorage、Pinia、组件挂载、`@` 别名
 * 与真实 store 都能跑。业务用例由李焰彬按 tests/domain、tests/stores、tests/services
 * 分目录编写；这个文件不需要扩展，删掉也不影响环境本身。
 */

describe('Vitest 环境', () => {
  it('能跑最基本的用例', () => {
    expect(1 + 1).toBe(2)
  })

  it('jsdom 提供可用的 localStorage', () => {
    localStorage.setItem('probe', 'v')
    expect(localStorage.getItem('probe')).toBe('v')
    expect(localStorage.length).toBe(1)
  })

  it('localStorage 在用例之间被清空（tests/setup.ts 生效）', () => {
    // 上一个用例写入过 probe；setupFiles 里的 afterEach 应该已经清掉
    expect(localStorage.getItem('probe')).toBeNull()
  })

  it('能创建 Pinia 并读写 setup store', () => {
    setActivePinia(createPinia())

    const useCounter = defineStore('env-counter', () => {
      const count = ref(0)
      const inc = () => {
        count.value += 1
      }
      return { count, inc }
    })

    const store = useCounter()
    expect(store.count).toBe(0)
    store.inc()
    expect(store.count).toBe(1)
  })

  it('能挂载 Vue 组件', () => {
    const Hello = defineComponent({
      props: { name: { type: String, required: true } },
      setup(props) {
        return () => h('p', `hi ${props.name}`)
      },
    })

    const wrapper = mount(Hello, { props: { name: '测试' } })
    expect(wrapper.text()).toBe('hi 测试')
  })

  it('能通过 @ 别名加载真实的工作台 store', () => {
    setActivePinia(createPinia())

    const store = useWorkbenchStore()
    expect(store.projects).toHaveLength(0)
    expect(store.aiStatus).toBe('idle')
    expect(store.recommendations).toHaveLength(0)

    // showCreate 会调用 window.scrollTo：能跑通说明 tests/setup.ts 的空实现生效
    store.showCreate()
    expect(store.creating).toBe(true)
  })
})
