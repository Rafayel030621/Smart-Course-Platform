import { reactive } from 'vue'
import { mount } from '@vue/test-utils'
import { vi } from 'vitest'
import CloudAdvisorPanel from '@/components/CloudAdvisorPanel.vue'

type AdvisorMock = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  source: 'model' | 'fallback' | 'local-rule' | null
  fallbackReason: string | null
  error: { message: string } | null
  suggestions: Array<{ id: string; title: string; whyNow: string; doneCriteria: string }>
}

const mocked = vi.hoisted(() => ({
  platform: {
    isCloudSource: true,
    isAuthenticated: true,
  },
  cloud: {
    advisor: null as AdvisorMock | null,
    buildAdvisorContext: vi.fn(),
    refreshAdvisor: vi.fn(),
  },
}))

vi.mock('@/stores/platform', () => ({
  usePlatformStore: () => mocked.platform,
}))

vi.mock('@/stores/cloud', () => ({
  useCloudStore: () => mocked.cloud,
}))

function advisor(overrides: Partial<AdvisorMock> = {}): AdvisorMock {
  return {
    status: 'idle',
    source: null,
    fallbackReason: null,
    error: null,
    suggestions: [],
    ...overrides,
  }
}

describe('CloudAdvisorPanel', () => {
  beforeEach(() => {
    mocked.platform.isCloudSource = true
    mocked.platform.isAuthenticated = true
    mocked.cloud.advisor = reactive(advisor())
    mocked.cloud.buildAdvisorContext = vi.fn(() => ({ ok: true, data: {} }))
    mocked.cloud.refreshAdvisor = vi.fn()
  })

  it('点击生成建议后渲染 title、whyNow、doneCriteria 与模型来源', async () => {
    mocked.cloud.refreshAdvisor.mockImplementation(async () => {
      if (mocked.cloud.advisor) {
        Object.assign(mocked.cloud.advisor, advisor({
          status: 'ready',
          source: 'model',
          suggestions: [
            {
              id: 'suggestion-1',
              title: '补齐字段口径说明',
              whyNow: '当前阶段完成标准要求确认字段口径。',
              doneCriteria: '写出一页字段说明并标注缺失率。',
            },
          ],
        }))
      }
      return { ok: true }
    })

    const wrapper = mount(CloudAdvisorPanel)
    await wrapper.get('.advisor-actions button').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('补齐字段口径说明')
    })
    expect(wrapper.text()).toContain('当前阶段完成标准要求确认字段口径。')
    expect(wrapper.text()).toContain('写出一页字段说明并标注缺失率。')
    expect(wrapper.text()).toContain('模型生成（model）')
    expect(mocked.cloud.buildAdvisorContext).toHaveBeenCalledTimes(1)
    expect(mocked.cloud.refreshAdvisor).toHaveBeenCalledWith({ forceRefresh: true })
  })

  it('fallback 时显示服务端规则兜底和中文原因', async () => {
    mocked.cloud.refreshAdvisor.mockImplementation(async () => {
      if (mocked.cloud.advisor) {
        Object.assign(mocked.cloud.advisor, advisor({
          status: 'ready',
          source: 'fallback',
          fallbackReason: 'MODEL_TIMEOUT',
          suggestions: [
            {
              id: 'suggestion-2',
              title: '先补齐样例数据说明',
              whyNow: '当前阶段还缺一份可核对的字段说明。',
              doneCriteria: '写出一页字段说明并标注缺失率。',
            },
          ],
        }))
      }
      return { ok: true }
    })

    const wrapper = mount(CloudAdvisorPanel)
    await wrapper.get('.advisor-actions button').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('服务端规则兜底（fallback）')
    })
    expect(wrapper.text()).toContain('模型响应超时，本次建议由服务端规则生成。')
    expect(wrapper.text()).toContain('先补齐样例数据说明')
    expect(wrapper.find('.advisor-suggestion').exists()).toBe(true)
  })

  it('失败时显示中文原因并可重试，重试成功后渲染建议', async () => {
    mocked.cloud.refreshAdvisor
      .mockResolvedValueOnce({ ok: false, message: '建议服务暂时不可用' })
      .mockImplementationOnce(async () => {
        if (mocked.cloud.advisor) {
          Object.assign(mocked.cloud.advisor, advisor({
            status: 'ready',
            source: 'model',
            suggestions: [
              {
                id: 'suggestion-3',
                title: '重试后生成的建议',
                whyNow: '重试成功后应替换失败状态。',
                doneCriteria: '建议卡片正常出现。',
              },
            ],
          }))
        }
        return { ok: true }
      })

    const wrapper = mount(CloudAdvisorPanel)
    await wrapper.get('.advisor-actions button').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('建议服务暂时不可用')
    })
    const retry = wrapper.findAll('.advisor-state-error button').find((button) => button.text() === '重试')
    expect(retry).toBeTruthy()

    await retry?.trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('重试后生成的建议')
    })
    expect(mocked.cloud.refreshAdvisor).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('建议服务暂时不可用')
  })
})
