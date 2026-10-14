<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useWorkbenchStore } from '@/stores/workbench'

/**
 * 应用外壳
 * ----------------------------------------------------------------------------
 * 顶部标题栏 + 三个页签（工作台 / 项目地图 / 论文推荐）+ 全局提示条。
 * 与 platform-ui-mockup(3).html 的 header / nav / toast 一致。
 */
const store = useWorkbenchStore()
const route = useRoute()
const router = useRouter()

const NAV = [
  { path: '/', label: '工作台' },
  { path: '/map', label: '项目地图' },
  { path: '/papers', label: '论文推荐' },
]

const activePath = computed(() => route.path)
</script>

<template>
  <header>
    <div class="logo">《大数据分析实践》智慧课程平台<span>AI 项目顾问</span></div>
    <div class="avatar">我</div>
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

  <div class="page show">
    <RouterView />
  </div>

  <div class="toast" :class="{ show: store.toastVisible }">{{ store.toastText }}</div>
</template>
