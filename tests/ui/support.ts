import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { routes } from '@/router'
import { useWorkbenchStore } from '@/stores/workbench'
import type { Task } from '@/types/platform'

/**
 * UI 测试的公共夹具（不是测试文件：文件名不含 .test，不会被 vitest 收集）
 * ----------------------------------------------------------------------------
 * `createTestRouter` 用**真实 routes** + 内存 history 建一个互不干扰的 router，
 * 因此"导航顺序 / 当前页高亮 / 路由能不能打开"测的是真实路由表。
 *
 * 注意：本文件 import 了 `@/router`，所以只有**没有 mock vue-router** 的测试文件
 * 才能引用它（WorkbenchView.test.ts 只从 ./visibleText 取工具函数）。
 */

export type WorkbenchStore = ReturnType<typeof useWorkbenchStore>

/** 建一个干净的 store（视图单独 mount 时用它，沿用既有约定：靠 active pinia） */
export function freshStore(): WorkbenchStore {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

/** 连 pinia 一起返回：mount(App) 要把 pinia 作为插件传进去 */
export function setupStoreWithPinia(): { store: WorkbenchStore; pinia: Pinia } {
  const pinia = createPinia()
  setActivePinia(pinia)
  return { store: useWorkbenchStore(), pinia }
}

export function createProject(store: WorkbenchStore, name = '测试项目'): string {
  const result = store.createProject({ topicId: '__custom__', customName: name, members: 3 })
  if (!result.ok) throw new Error(`创建项目失败：${result.message}`)
  return result.data.projectId
}

/** 认领一条新任务：状态直接是「进行中」 */
export function createProjectWithTask(
  store: WorkbenchStore,
  name: string,
  taskTitle = `${name}的测试任务`,
): { projectId: string; taskId: string } {
  const projectId = createProject(store, name)
  const result = store.claimTask({
    draft: {
      title: taskTitle,
      doneCriteria: '完成测试并留下证据',
      requestId: null,
      basisEvidenceIds: [],
      basisDoubtIds: [],
    },
  })
  if (!result.ok) throw new Error(`创建测试任务失败：${result.message}`)
  return { projectId, taskId: result.data.taskId }
}

/**
 * 直接放一条真实任务进当前项目（含未认领的 todo）。
 * 公开 action 只能创建"进行中"的任务，等待认领的 todo 任务只在测试里这样造。
 */
export function seedTask(
  store: WorkbenchStore,
  status: Task['status'] = 'todo',
  title = '等待认领的步骤',
): Task {
  const project = store.current
  if (project === undefined) throw new Error('缺少测试项目')
  const timestamp = new Date().toISOString()
  const task: Task = {
    id: `tsk_seed_${project.tasks.length + 1}`,
    projectId: project.projectId,
    title,
    status,
    doneCriteria: '写出一页结论',
    owner: null,
    suggestedOwner: null,
    milestone: null,
    why: null,
    draftKey: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  project.tasks = [...project.tasks, task]
  return task
}

/** 测试用 router：内存 history，避免用例之间共享单例路由的当前位置 */
export function createTestRouter(): Router {
  return createRouter({ history: createMemoryHistory(), routes })
}
