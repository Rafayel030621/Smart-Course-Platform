import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LocalMigrationPanel from '@/components/LocalMigrationPanel.vue'
import type { LocalMigrationCandidate } from '@/types/platform'

const candidate: LocalMigrationCandidate = {
  localProjectId: 'local-project-1',
  name: '本地海洋项目',
  short: '海洋项目',
  schemaVersion: 2,
  taskCount: 3,
  evidenceCount: 2,
  doubtCount: 1,
  materialCount: 1,
  chatCount: 0,
  status: 'pending-confirmation',
  migrationId: null,
  cloudProjectId: null,
  blockReason: null,
  errorMessage: null,
}

describe('LocalMigrationPanel', () => {
  it('展示本地项目数量并要求用户明确确认', async () => {
    const wrapper = mount(LocalMigrationPanel, {
      props: { candidates: [candidate], status: 'pending-confirmation' },
    })

    expect(wrapper.text()).toContain('发现本地项目')
    expect(wrapper.text()).toContain('3 个任务')
    expect(wrapper.text()).toContain('只有你明确确认后')
    await wrapper.get('button.primary').trigger('click')

    expect(wrapper.emitted('confirm')).toEqual([['local-project-1']])
  })

  it('迁移失败时展示错误并允许重试', async () => {
    const failed = { ...candidate, status: 'failed' as const, errorMessage: '迁移没有完成，请稍后重试' }
    const wrapper = mount(LocalMigrationPanel, {
      props: {
        candidates: [failed],
        status: 'failed',
        error: '迁移没有完成，请稍后重试',
      },
    })

    expect(wrapper.find('[role="alert"]').text()).toContain('迁移没有完成')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('retry')).toEqual([['local-project-1']])
  })
})
