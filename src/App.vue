<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import AuthPanel from '@/components/AuthPanel.vue'
import LocalMigrationPanel from '@/components/LocalMigrationPanel.vue'
import { usePlatformStore } from '@/stores/platform'
import { useWorkbenchStore } from '@/stores/workbench'

/**
 * 应用外壳
 * ----------------------------------------------------------------------------
 * 顶部标题栏 + 三个页签（工作台 / 项目地图 / 论文推荐）+ 全局提示条。
 * 与 platform-ui-mockup(3).html 的 header / nav / toast 一致。
 */
const store = useWorkbenchStore()
const platform = usePlatformStore()
const route = useRoute()
const router = useRouter()
const authError = ref('')
const migrationVisible = ref(false)
const migrationBusy = ref(false)

const NAV = [
  { path: '/', label: '工作台' },
  { path: '/map', label: '项目地图' },
  { path: '/papers', label: '论文推荐' },
]

const activePath = computed(() => route.path)
const authBusy = computed(() => platform.authStatus === 'loading')
const migrationErrorText = computed(() => platform.migrationError?.message ?? '')

function resultMessage(result: { ok: boolean; message?: string }): string {
  return result.ok ? '' : result.message ?? '操作没有完成，请稍后再试'
}

async function initialize(): Promise<void> {
  const result = await platform.initialize()
  if (!result.ok && platform.authStatus === 'error') authError.value = result.message
}

async function login(input: { account: string; password: string }): Promise<void> {
  authError.value = ''
  const result = await platform.login(input.account, input.password)
  if (!result.ok) authError.value = resultMessage(result)
}

async function register(input: { account: string; displayName: string; password: string; inviteCode: string }): Promise<void> {
  authError.value = ''
  const result = await platform.register(input)
  if (!result.ok) authError.value = resultMessage(result)
}

async function logout(): Promise<void> {
  const result = await platform.logout()
  authError.value = result.ok ? '' : result.message
}

async function inspectMigration(): Promise<void> {
  const candidates = platform.detectLocalMigration()
  migrationVisible.value = candidates.length > 0
  if (platform.cloudProject === null && platform.cloudProjects.length > 0) {
    await platform.selectCloudProject(platform.cloudProjects[0].projectId)
  }
}

async function migrate(projectId: string, retry = false): Promise<void> {
  migrationBusy.value = true
  const result = retry
    ? await platform.retryLocalMigration(projectId)
    : await platform.confirmLocalMigration(projectId)
  migrationBusy.value = false
  if (!result.ok) return
  migrationVisible.value = platform.migrationCandidates.some((item) => item.status === 'pending-confirmation' || item.status === 'failed')
  if (result.data.projectId !== '') await platform.selectCloudProject(result.data.projectId)
}

function useLocalProjects(): void {
  migrationVisible.value = false
  platform.useLocalSource()
}

async function useCloudProjects(): Promise<void> {
  migrationVisible.value = false
  platform.useCloudSource()
  if (platform.cloudProject === null && platform.cloudProjects.length > 0) {
    await platform.selectCloudProject(platform.cloudProjects[0].projectId)
  }
}

onMounted(() => {
  void initialize()
})

watch(
  () => platform.isAuthenticated,
  (authenticated) => {
    if (authenticated) void inspectMigration()
  },
)

/**
 * 刷新页面后恢复项目：
 * 会话恢复时 `isAuthenticated` 先于项目列表返回，只靠上面的 watcher 会读到空列表，
 * 结果登录着却显示「创建云端项目」。这里等列表就绪再补选第一个项目。
 */
watch(
  () => [platform.isAuthenticated, platform.isCloudSource, platform.cloudProjects.length, platform.cloudProject?.projectId ?? null] as const,
  ([authenticated, isCloud, count, currentProjectId]) => {
    if (!authenticated || !isCloud || count === 0 || currentProjectId !== null) return
    const first = platform.cloudProjects[0]
    if (first === undefined) return
    void platform.selectCloudProject(first.projectId)
  },
  { immediate: true },
)
</script>

<template>
  <header>
    <div class="logo">《大数据分析实践》智慧课程平台<span>AI 项目顾问</span></div>
    <div v-if="platform.isAuthenticated" class="account-bar">
      <span class="account-name">{{ platform.displayName }}</span>
      <button v-if="platform.isCloudSource" class="btn account-logout" type="button" @click="useLocalProjects">本地项目</button>
      <button v-else class="btn account-logout" type="button" @click="useCloudProjects">云端项目</button>
      <button class="btn account-logout" type="button" @click="logout">退出登录</button>
    </div>
    <div v-else class="avatar">本地</div>
  </header>

  <nav>
    <button
      v-for="item in NAV"
      :key="item.path"
      :class="{ active: activePath === item.path }"
      @click="router.push(item.path)"
    >
      {{ item.label }}
    </button>
  </nav>

  <main class="page show">
    <div v-if="!platform.initialized || authBusy" class="card startup-state">
      正在检查登录状态…
    </div>
    <div v-else-if="platform.authStatus === 'error'" class="card startup-state" role="alert">
      <p>{{ authError || '暂时无法连接账号服务，当前登录状态没有确认。' }}</p>
      <button class="btn primary" type="button" @click="initialize">重试</button>
    </div>
    <AuthPanel
      v-if="platform.initialized && !platform.isAuthenticated"
      :busy="authBusy"
      :error="authError"
      @login="login"
      @register="register"
    />
    <LocalMigrationPanel
      v-if="platform.isAuthenticated && migrationVisible"
      :candidates="platform.migrationCandidates"
      :status="platform.migrationStatus"
      :error="migrationErrorText"
      :busy="migrationBusy"
      @confirm="migrate"
      @retry="(projectId) => migrate(projectId, true)"
      @dismiss="useLocalProjects"
    />
    <RouterView />
  </main>

  <div class="toast" :class="{ show: store.toastVisible }">{{ store.toastText }}</div>
</template>

<style scoped>
.account-bar { display:flex; align-items:center; gap:10px; margin-left:auto; }
.account-name { color:#185FA5; font-size:13px; }
.account-logout { padding:5px 10px; }
.startup-state { max-width:760px; margin:30px auto; padding:18px; display:flex; align-items:center; gap:12px; justify-content:space-between; }
@media (max-width:600px) {
  header { min-height:56px; height:auto; padding:8px 12px; flex-wrap:wrap; gap:8px; }
  .logo { flex:1 1 100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .logo span { margin-left:4px; }
  .account-bar { flex:1 1 100%; margin-left:0; justify-content:flex-end; flex-wrap:wrap; gap:6px; }
  .account-name { margin-right:auto; }
  .account-logout { padding:5px 8px; }
  nav { top:auto; padding:0 8px; overflow-x:auto; white-space:nowrap; }
  nav button { flex:0 0 auto; padding:11px 12px; }
  .page { padding:14px 12px; }
  .startup-state { align-items:stretch; flex-direction:column; margin:20px auto; }
}
</style>
