<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{
  login: [input: { account: string; password: string }]
  register: [input: { account: string; displayName: string; password: string; inviteCode: string }]
}>()

const mode = ref<'login' | 'register'>('login')
const account = ref('')
const displayName = ref('')
const password = ref('')
const confirmPassword = ref('')
const inviteCode = ref('')
const localError = ref('')

const title = computed(() => (mode.value === 'login' ? '登录云端项目' : '注册智慧课程平台'))

function submit(): void {
  localError.value = ''
  if (account.value.trim() === '' || password.value === '') {
    localError.value = '请输入用户名和密码'
    return
  }
  if (mode.value === 'login') {
    emit('login', { account: account.value.trim(), password: password.value })
    return
  }
  if (displayName.value.trim() === '') {
    localError.value = '请输入昵称'
    return
  }
  if (password.value.length < 8) {
    localError.value = '密码至少需要 8 位'
    return
  }
  if (password.value !== confirmPassword.value) {
    localError.value = '两次输入的密码不一致'
    return
  }
  if (inviteCode.value.trim() === '') {
    localError.value = '请输入邀请码'
    return
  }
  emit('register', {
    account: account.value.trim(),
    displayName: displayName.value.trim(),
    password: password.value,
    inviteCode: inviteCode.value.trim(),
  })
}
</script>

<template>
  <section class="auth-panel card" aria-labelledby="auth-title">
    <div class="card-h">
      <span id="auth-title">{{ title }}</span>
      <span class="tag" style="background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;">
        {{ mode === 'login' ? '已有账号' : '新用户' }}
      </span>
    </div>
    <form class="card-b auth-form" @submit.prevent="submit">
      <label for="auth-account">用户名或学号</label>
      <input id="auth-account" v-model="account" autocomplete="username" required />

      <template v-if="mode === 'register'">
        <label for="auth-display-name">昵称</label>
        <input id="auth-display-name" v-model="displayName" autocomplete="nickname" required />
      </template>

      <label for="auth-password">密码</label>
      <input
        id="auth-password"
        v-model="password"
        type="password"
        :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
        :aria-describedby="localError || props.error ? 'auth-error' : undefined"
        required
      />

      <template v-if="mode === 'register'">
        <label for="auth-confirm-password">确认密码</label>
        <input id="auth-confirm-password" v-model="confirmPassword" type="password" autocomplete="new-password" required />
        <label for="auth-invite-code">邀请码</label>
        <input id="auth-invite-code" v-model="inviteCode" autocomplete="off" required />
      </template>

      <p v-if="localError || props.error" id="auth-error" class="auth-error" role="alert">
        {{ localError || props.error }}
      </p>
      <button class="btn primary auth-submit" type="submit" :disabled="props.busy">
        {{ props.busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录' }}
      </button>
      <button class="btn auth-switch" type="button" :disabled="props.busy" @click="mode = mode === 'login' ? 'register' : 'login'">
        {{ mode === 'login' ? '没有账号？去注册' : '已有账号？返回登录' }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.auth-panel { max-width: 520px; margin: 38px auto 20px; }
.auth-form label { display:block; margin:12px 0 5px; font-size:12.5px; font-weight:600; }
.auth-form label:first-child { margin-top:0; }
.auth-form input { width:100%; border:1px solid #d3d1c7; border-radius:8px; padding:9px 10px; font:inherit; outline:none; }
.auth-form input:focus { border-color:#378ADD; }
.auth-submit { width:100%; margin-top:16px; padding:10px; }
.auth-switch { width:100%; margin-top:8px; }
.auth-error { margin-top:10px; color:#854F0B; line-height:1.6; }
</style>
