import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

/**
 * 三个页签，与 mockup 的导航一致：
 *   /        工作台（创建项目 + 三栏工作台）
 *   /map     项目地图（里程碑 + 任务状态，独立页面）
 *   /papers  论文推荐（检索提示词）
 *
 * `routes` 单独导出：测试要用内存 history 建一个互不干扰的 router（见 tests/ui）。
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'workbench', component: () => import('@/views/WorkbenchView.vue') },
  { path: '/map', name: 'map', component: () => import('@/views/ProjectMapView.vue') },
  { path: '/papers', name: 'papers', component: () => import('@/views/PapersView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  },
})
