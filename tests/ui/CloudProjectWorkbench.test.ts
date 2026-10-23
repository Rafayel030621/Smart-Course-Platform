import { mount } from '@vue/test-utils'
import { vi } from 'vitest'
import CloudProjectWorkbench from '@/components/CloudProjectWorkbench.vue'

const mocked = vi.hoisted(() => ({
  platform: {
    cloudProject: {
      projectId: 'project-1',
      name: '测试云端项目',
      short: '测试',
      profile: { goal: '验证阶段流程' },
      taskStats: { total: 2, done: 0 },
    },
    cloudProjects: [{ projectId: 'project-1', name: '测试云端项目' }],
    selectCloudProject: vi.fn(),
    createCloudProject: vi.fn(),
  },
  cloud: {
    milestones: [] as Array<{
      milestoneId: string
      name: string
      goal: string
      doneCriteria: string
      dueAt: string | null
      status: 'planned' | 'active' | 'completed' | 'archived'
      orderIndex: number
      revision: number
      source: 'manual'
      createdAt: string
      updatedAt: string
      completedAt: string | null
      archivedAt: string | null
      taskStats: { total: number; done: number; doing: number; todo: number; archived: number; progress: number }
    }>,
    tasks: [] as Array<{
      taskId: string
      milestoneId: string | null
      title: string
      doneCriteria: string
      status: 'todo' | 'doing' | 'done'
      archivedAt: string | null
    }>,
    evidence: [] as Array<{ evidenceId: string; status: 'active' | 'redacted'; milestoneId: string | null; taskId: string | null; didWhat: string; foundWhat: string; createdAt: string }>,
    progress: [] as Array<{ progressId: string; status: 'active' | 'superseded'; milestoneId: string | null; taskId: string | null; summary: string; occurredAt: string }>,
    currentMilestoneId: 'milestone-1' as string | null,
    tasksHydrated: true,
    busy: false,
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    reorderMilestones: vi.fn(),
    activateMilestone: vi.fn(),
    completeMilestone: vi.fn(),
    reopenMilestone: vi.fn(),
    archiveMilestone: vi.fn(),
    restoreMilestone: vi.fn(),
    createTask: vi.fn(),
    linkTaskToMilestone: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
    reopenTask: vi.fn(),
    submitProgress: vi.fn(),
    createEvidence: vi.fn(),
    isActionLoading: vi.fn((_name: string): boolean => false),
  },
  push: vi.fn(),
}))

vi.mock('@/stores/platform', () => ({
  usePlatformStore: () => mocked.platform,
}))

vi.mock('@/stores/cloud', () => ({
  useCloudStore: () => mocked.cloud,
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mocked.push }),
}))

function milestone(
  milestoneId: string,
  name: string,
  orderIndex: number,
  archivedAt: string | null = null,
): (typeof mocked.cloud.milestones)[number] {
  return {
    milestoneId,
    name,
    goal: name + '目标',
    doneCriteria: name + '完成标准',
    dueAt: null,
    status: archivedAt === null ? 'planned' : 'archived',
    orderIndex,
    revision: 1,
    source: 'manual',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    completedAt: null,
    archivedAt,
    taskStats: { total: 1, done: 0, doing: 0, todo: 1, archived: 0, progress: 0 },
  }
}

function resetState(): void {
  mocked.cloud.milestones = [
    milestone('milestone-1', '资料整理', 0),
    milestone('milestone-2', '结论验证', 1),
  ]
  mocked.cloud.tasks = [
    { taskId: 'task-1', milestoneId: 'milestone-1', title: '整理资料', doneCriteria: '', status: 'todo', archivedAt: null },
    { taskId: 'task-2', milestoneId: 'milestone-2', title: '验证结论', doneCriteria: '', status: 'todo', archivedAt: null },
  ]
  mocked.cloud.currentMilestoneId = 'milestone-1'
}

describe('CloudProjectWorkbench', () => {
  beforeEach(() => {
    resetState()
    mocked.cloud.isActionLoading = vi.fn(() => false)
  })

  it('切换查看阶段后只展示所选阶段的任务', async () => {
    const wrapper = mount(CloudProjectWorkbench, {
      global: { stubs: { RouterLink: true } },
    })

    expect(wrapper.text()).toContain('整理资料')
    expect(wrapper.text()).not.toContain('验证结论')

    await wrapper.get('select.stage-select').setValue('milestone-2')

    expect(wrapper.text()).toContain('验证结论')
    expect(wrapper.text()).not.toContain('整理资料')
  })

  it('归档阶段不影响活动阶段排序按钮的边界', () => {
    mocked.cloud.milestones = [
      milestone('milestone-1', '资料整理', 0),
      milestone('milestone-archived', '旧阶段', 1, '2026-10-20T00:00:00.000Z'),
      milestone('milestone-2', '结论验证', 2),
    ]
    mocked.cloud.currentMilestoneId = 'milestone-1'

    const wrapper = mount(CloudProjectWorkbench)
    const rows = wrapper.findAll('.milestone-row')

    expect(rows[0]?.findAll('button')[0]?.attributes('disabled')).toBeDefined()
    expect(rows[0]?.findAll('button')[1]?.attributes('disabled')).toBeUndefined()
    expect(rows[2]?.findAll('button')[0]?.attributes('disabled')).toBeUndefined()
    expect(rows[2]?.findAll('button')[1]?.attributes('disabled')).toBeDefined()
  })

  it('点击阶段候选入口时明确提示接口尚未接入', async () => {
    const wrapper = mount(CloudProjectWorkbench)

    await wrapper.get('.candidate-entry button').trigger('click')

    expect(wrapper.text()).toContain('阶段候选接口暂未接入')
  })

  it('无里程碑时显示新建与候选两个入口，新建会聚焦名称输入', async () => {
    mocked.cloud.milestones = []
    mocked.cloud.tasks = []

    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(CloudProjectWorkbench, { attachTo: host })
    const actions = wrapper.findAll('.empty-actions button')

    expect(actions.map((item) => item.text())).toEqual(['新建里程碑', '根据项目资料生成候选'])
    await actions[0]?.trigger('click')
    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('阶段名称')
    })

    wrapper.unmount()
    host.remove()
  })

  it('切换标签页不卸载表单，输入不会丢失；项目资料页说明尚未接入', async () => {
    const wrapper = mount(CloudProjectWorkbench)

    await wrapper.get('input[aria-label="阶段名称"]').setValue('未提交的阶段草稿')
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs[0]?.text()).toContain('项目推进')
    expect(tabs[1]?.text()).toContain('项目资料')

    await tabs[1]?.trigger('click')

    expect(wrapper.get('#cloud-panel-data').isVisible()).toBe(true)
    expect(wrapper.get('#cloud-panel-data').text()).toContain('云端材料列表还没有接入本页')
    expect((wrapper.get('input[aria-label="阶段名称"]').element as HTMLInputElement).value).toBe('未提交的阶段草稿')

    await tabs[0]?.trigger('click')
    expect(wrapper.get('#cloud-panel-progress').isVisible()).toBe(true)
  })

  it('「下一步做什么」按当前阶段数据给出行动，并明确不是 AI 建议', async () => {
    const wrapper = mount(CloudProjectWorkbench)

    expect(wrapper.get('.next-step').text()).toContain('开始任务：整理资料')
    expect(wrapper.get('.next-step').text()).toContain('不是 AI 建议')

    const startButton = wrapper.findAll('.next-step-list button').find((item) => item.text() === '开始')
    mocked.cloud.startTask.mockResolvedValue({ ok: true })
    await startButton?.trigger('click')

    expect(mocked.cloud.startTask).toHaveBeenCalledWith({ taskId: 'task-1', expectedRevision: undefined })
  })

  it('任务按钮按各自 action 键显示忙碌态', async () => {
    mocked.cloud.isActionLoading = vi.fn((name: string): boolean => name === 'task.start')

    const wrapper = mount(CloudProjectWorkbench)
    const startButton = wrapper.findAll('.task-row button').find((item) => item.text() === '开始')
    const completeButton = wrapper.findAll('.task-row button').find((item) => item.text() === '完成')

    expect(startButton?.attributes('disabled')).toBeDefined()
    expect(completeButton?.attributes('disabled')).toBeUndefined()
  })

  it('新建任务默认挂当前阶段，未挂阶段的任务可以补挂', async () => {
    mocked.cloud.tasks = [
      { taskId: 'task-9', milestoneId: null, title: '未挂阶段的任务', doneCriteria: '', status: 'todo', archivedAt: null },
    ]
    mocked.cloud.linkTaskToMilestone.mockResolvedValue({ ok: true })
    mocked.cloud.isActionLoading = vi.fn((name: string): boolean => name === 'linkTaskToMilestone')

    const wrapper = mount(CloudProjectWorkbench)
    const milestoneSelect = wrapper.get('select[aria-label="任务所属阶段"]')

    expect((milestoneSelect.element as HTMLSelectElement).value).toBe('milestone-1')
    expect(wrapper.get('.unassigned').text()).toContain('未挂阶段的任务')
    expect(wrapper.get('.unassigned button').attributes('disabled')).toBeDefined()

    mocked.cloud.isActionLoading = vi.fn((_name: string): boolean => false)
    const idle = mount(CloudProjectWorkbench)
    expect(idle.get('.unassigned button').attributes('disabled')).toBeUndefined()
    await idle.get('.unassigned button').trigger('click')

    expect(mocked.cloud.linkTaskToMilestone).toHaveBeenCalledWith({
      taskId: 'task-9',
      milestoneId: 'milestone-1',
      expectedRevision: undefined,
    })
  })
})
