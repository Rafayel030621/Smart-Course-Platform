import { mount } from '@vue/test-utils'
import { vi } from 'vitest'
import CloudCandidatePanel from '@/components/CloudCandidatePanel.vue'

type Candidate = {
  candidateId: string
  name: string
  goal: string
  doneCriteria: string
  suggestedTasks: Array<{ title: string; doneCriteria: string }>
  risks: string[]
  sources: Array<{
    materialId: string
    materialName: string
    materialVersion: number
    segmentId: string
    startLine: number
    endLine: number
    itemId: string | null
  }>
  expiresAt: string
}

const mocked = vi.hoisted(() => ({
  cloud: {
    project: { projectId: 'project-1' },
    candidates: [] as Candidate[],
    candidatesStatus: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    candidatesError: null as { code: string; message: string } | null,
    candidatesNotice: null as string | null,
    generateCandidates: vi.fn(),
    createMilestone: vi.fn(),
    refreshMilestones: vi.fn(async () => undefined),
  },
}))

vi.mock('@/stores/cloud', () => ({
  useCloudStore: () => mocked.cloud,
}))

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidateId: 'cand_1',
    name: '数据获取与预处理',
    goal: '拿到可复现的样例数据并确认字段口径',
    doneCriteria: '样例数据可下载，字段说明与缺失率记录完整',
    suggestedTasks: [
      { title: '跑通数据下载链路', doneCriteria: '能用 Python 读出关键变量' },
    ],
    risks: ['0.5 度分辨率可能不满足公里级判断'],
    sources: [
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
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

function resetState(): void {
  mocked.cloud.candidates = []
  mocked.cloud.candidatesStatus = 'idle'
  mocked.cloud.candidatesError = null
  mocked.cloud.candidatesNotice = null
  mocked.cloud.generateCandidates = vi.fn(async () => ({ ok: true, data: [] }))
  mocked.cloud.createMilestone = vi.fn()
  mocked.cloud.refreshMilestones = vi.fn(async () => undefined)
}

describe('CloudCandidatePanel', () => {
  beforeEach(() => {
    resetState()
  })

  it('生成成功渲染候选字段，并调用 generateCandidates', async () => {
    mocked.cloud.candidates = [candidate()]
    mocked.cloud.candidatesStatus = 'ready'

    const wrapper = mount(CloudCandidatePanel)
    expect(wrapper.text()).toContain('数据获取与预处理')
    expect(wrapper.text()).toContain('拿到可复现的样例数据并确认字段口径')
    expect(wrapper.text()).toContain('样例数据可下载')
    expect(wrapper.text()).toContain('跑通数据下载链路')
    expect(wrapper.text()).toContain('实验手册.md 第 10–24 行')

    await wrapper.get('.candidate-actions button').trigger('click')

    expect(mocked.cloud.generateCandidates).toHaveBeenCalledWith({ maxCandidates: 2 })
  })

  it('fallback 显示 notice 并标注服务端规则生成', () => {
    mocked.cloud.candidates = [candidate()]
    mocked.cloud.candidatesStatus = 'ready'
    mocked.cloud.candidatesNotice = '模型未参与，以下为按项目资料生成的规则候选。'

    const wrapper = mount(CloudCandidatePanel)

    expect(wrapper.text()).toContain('服务端规则生成')
    expect(wrapper.text()).toContain('模型未参与，以下为按项目资料生成的规则候选。')
    expect(wrapper.findAll('.candidate-card')).toHaveLength(1)
  })

  it('确认创建成功后刷新阶段列表并关闭候选卡片', async () => {
    mocked.cloud.candidates = [candidate()]
    mocked.cloud.candidatesStatus = 'ready'
    mocked.cloud.createMilestone.mockResolvedValue({ ok: true, data: { milestoneId: 'ms_1' } })

    const wrapper = mount(CloudCandidatePanel)
    await wrapper.get('.candidate-card button.btn.primary').trigger('click')

    expect(mocked.cloud.createMilestone).toHaveBeenCalledWith({
      name: '数据获取与预处理',
      goal: '拿到可复现的样例数据并确认字段口径',
      doneCriteria: '样例数据可下载，字段说明与缺失率记录完整',
      status: 'planned',
      source: 'ai-candidate',
      candidateId: 'cand_1',
      confirmedByUser: true,
    })
    await vi.waitFor(() => {
      expect(mocked.cloud.refreshMilestones).toHaveBeenCalledTimes(1)
    })
    expect(wrapper.text()).toContain('已创建 1 个阶段')
    expect(wrapper.findAll('.candidate-card')).toHaveLength(0)
  })

  it('expiresAt 已过期时禁用确认按钮并提示重新生成', () => {
    mocked.cloud.candidates = [candidate({ expiresAt: new Date(Date.now() - 60_000).toISOString() })]
    mocked.cloud.candidatesStatus = 'ready'

    const wrapper = mount(CloudCandidatePanel)
    const confirm = wrapper.get('.candidate-card button.btn.primary')

    expect(wrapper.text()).toContain('候选已过期，请重新生成。')
    expect(confirm.attributes('disabled')).toBeDefined()
    expect(confirm.text()).toBe('已过期')
  })

  it('确认返回 CANDIDATE_EXPIRED 时禁用按钮并给出中文提示', async () => {
    mocked.cloud.candidates = [candidate()]
    mocked.cloud.candidatesStatus = 'ready'
    mocked.cloud.createMilestone.mockResolvedValue({
      ok: false,
      code: 'CANDIDATE_EXPIRED',
      message: '候选阶段已过期，请重新生成',
    })

    const wrapper = mount(CloudCandidatePanel)
    await wrapper.get('.candidate-card button.btn.primary').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('候选已过期，请重新生成。')
    })
    expect(wrapper.get('.candidate-card button.btn.primary').attributes('disabled')).toBeDefined()
  })
})
