import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CloudChatPanel from '@/components/CloudChatPanel.vue'

const mocked = vi.hoisted(() => ({
  cloud: {
    chat: {
      status: 'idle' as 'idle' | 'loading' | 'error',
      messages: [] as Array<Record<string, unknown>>,
      error: null as { code: string; message: string } | null,
      pendingQuestion: null as string | null,
      contextAttached: true,
    },
    sendChat: vi.fn(async () => ({ ok: true, data: {} })),
    retryChat: vi.fn(async () => ({ ok: true, data: {} })),
    clearChat: vi.fn(),
  },
}))

vi.mock('@/stores/cloud', () => ({
  useCloudStore: () => mocked.cloud,
}))

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: 'chat_1',
    role: 'assistant',
    text: '先把 0.5 度分辨率的缺口写成待确认事项。',
    source: 'model',
    fallbackReason: null,
    citations: [],
    createdAt: '2026-10-22T03:00:00.000Z',
    ...overrides,
  }
}

describe('CloudChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.cloud.chat = { status: 'idle', messages: [], error: null, pendingQuestion: null, contextAttached: true }
    mocked.cloud.sendChat.mockResolvedValue({ ok: true, data: {} })
    mocked.cloud.retryChat.mockResolvedValue({ ok: true, data: {} })
  })

  it('空会话给出可问的问题，并声明记录不落库', () => {
    const wrapper = mount(CloudChatPanel)

    expect(wrapper.text()).toContain('还没有对话')
    expect(wrapper.text()).toContain('聊天记录暂不保存')
    expect(wrapper.text()).toContain('本次会话')
  })

  it('发送成功后清空输入框', async () => {
    const wrapper = mount(CloudChatPanel)
    const textarea = wrapper.get('textarea')

    await textarea.setValue('下一步做什么')
    await wrapper.get('form').trigger('submit')

    expect(mocked.cloud.sendChat).toHaveBeenCalledWith({ question: '下一步做什么' })
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('发送失败保留问题，点重试直接复用原问题', async () => {
    mocked.cloud.chat = {
      status: 'error',
      messages: [],
      error: { code: 'MODEL_UNAVAILABLE', message: '模型服务暂时不可用，请稍后重试' },
      pendingQuestion: '下一步做什么',
      contextAttached: true,
    }

    const wrapper = mount(CloudChatPanel)
    expect(wrapper.text()).toContain('模型服务暂时不可用')

    await wrapper.get('.chat-error button').trigger('click')
    expect(mocked.cloud.retryChat).toHaveBeenCalled()
  })

  it('兜底回答说人话，并展示材料引用行号', () => {
    mocked.cloud.chat = {
      status: 'idle',
      messages: [
        message({ role: 'user', clientId: 'chat_u1', text: '下一步做什么', source: 'model' }),
        message({
          source: 'fallback',
          fallbackReason: 'MODEL_TIMEOUT',
          citations: [
            {
              materialId: 'mat_1',
              materialName: '实验手册.md',
              materialVersion: 1,
              segmentId: 'seg_1',
              startLine: 10,
              endLine: 24,
              itemId: null,
            },
          ],
        }),
      ],
      error: null,
      pendingQuestion: null,
      contextAttached: true,
    }

    const wrapper = mount(CloudChatPanel)

    expect(wrapper.text()).toContain('服务端规则兜底')
    expect(wrapper.text()).toContain('模型响应超时')
    expect(wrapper.text()).toContain('依据：实验手册.md 第 10–24 行')
    expect(wrapper.text()).not.toContain('MODEL_TIMEOUT')
  })

  it('正在思考时禁用发送，避免重复提交', () => {
    mocked.cloud.chat = {
      status: 'loading',
      messages: [],
      error: null,
      pendingQuestion: null,
      contextAttached: true,
    }

    const wrapper = mount(CloudChatPanel)

    expect(wrapper.text()).toContain('正在思考')
    expect(wrapper.get('form button').attributes('disabled')).toBeDefined()
    expect(wrapper.get('textarea').attributes('disabled')).toBeDefined()
  })

  it('清空会调用 store 并重置输入', async () => {
    mocked.cloud.chat = {
      status: 'idle',
      messages: [message()],
      error: null,
      pendingQuestion: null,
      contextAttached: true,
    }

    const wrapper = mount(CloudChatPanel)
    await wrapper.get('.chat-head button').trigger('click')

    expect(mocked.cloud.clearChat).toHaveBeenCalled()
  })
})
