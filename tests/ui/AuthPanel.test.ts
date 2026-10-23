import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AuthPanel from '@/components/AuthPanel.vue'

describe('AuthPanel', () => {
  it('登录会提交用户名和密码', async () => {
    const wrapper = mount(AuthPanel)

    await wrapper.get('#auth-account').setValue('student-01')
    await wrapper.get('#auth-password').setValue('password-123')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('login')).toEqual([[{ account: 'student-01', password: 'password-123' }]])
  })

  it('注册会校验确认密码和邀请码，并提交完整表单', async () => {
    const wrapper = mount(AuthPanel)
    await wrapper.get('.auth-switch').trigger('click')
    await wrapper.get('#auth-account').setValue('student-02')
    await wrapper.get('#auth-display-name').setValue('雍蕾')
    await wrapper.get('#auth-password').setValue('password-123')
    await wrapper.get('#auth-confirm-password').setValue('password-123')
    await wrapper.get('#auth-invite-code').setValue('invite-01')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.emitted('register')).toEqual([[
      {
        account: 'student-02',
        displayName: '雍蕾',
        password: 'password-123',
        inviteCode: 'invite-01',
      },
    ]])
  })

  it('注册密码不一致时保留页面并显示中文提示', async () => {
    const wrapper = mount(AuthPanel)
    await wrapper.get('.auth-switch').trigger('click')
    await wrapper.get('#auth-account').setValue('student-03')
    await wrapper.get('#auth-display-name').setValue('测试')
    await wrapper.get('#auth-password').setValue('password-123')
    await wrapper.get('#auth-confirm-password').setValue('different-123')
    await wrapper.get('#auth-invite-code').setValue('invite-01')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.text()).toContain('两次输入的密码不一致')
    expect(wrapper.emitted('register')).toBeUndefined()
  })
})
