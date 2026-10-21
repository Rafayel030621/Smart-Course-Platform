import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { getTask } from '@/services/projectsApi'
import { useCloudStore } from '@/stores/cloud'
import type { CloudTask } from '@/types/platform'
import {
  installFetch,
  jsonResponse,
  makeCloudMilestone,
  makeCloudProject,
  makeCloudTask,
  readEnvelope,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const MILESTONE_ID = 'ms_1'

function projectWith(total: number) {
  const milestone = makeCloudMilestone({
    milestoneId: MILESTONE_ID,
    taskStats: { total, done: 0, doing: total, todo: 0, archived: 0, progress: 0 },
  })
  return makeCloudProject({
    projectId: PROJECT_ID,
    projectRevision: 3,
    currentMilestoneId: MILESTONE_ID,
    currentMilestone: milestone.name,
    milestones: [milestone],
    taskStats: { total, done: 0, doing: total, todo: 0, progress: 0 },
  })
}

function tasksBody(tasks: CloudTask[], nextCursor: string | null = null) {
  return readEnvelope({ tasks, nextCursor }, PROJECT_ID, 3)
}

function readJson(data: unknown) {
  return jsonResponse(readEnvelope(data, PROJECT_ID, 3))
}

/** 读取请求可能带 query（includeArchived / limit / cursor），只比较 pathname */
function pathOf(url: string): string {
  return url.split('?')[0] ?? url
}

function isTaskList(url: string): boolean {
  return pathOf(url).endsWith(`/api/projects/${PROJECT_ID}/tasks`)
}

/** openProject 会依次读取项目、证据、进展与任务 */
function projectRoute(project: unknown) {
  return (url: string, init: RequestInit): Response | undefined => {
    if (init.method !== 'GET') return undefined
    const path = pathOf(url)
    if (path.endsWith(`/api/projects/${PROJECT_ID}`)) return readJson({ project })
    if (path.includes(`/api/projects/${PROJECT_ID}/evidence`)) {
      return readJson({ evidence: [], nextCursor: null })
    }
    if (path.includes(`/api/projects/${PROJECT_ID}/progress`)) {
      return readJson({ progress: [], nextCursor: null })
    }
    return undefined
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('云端任务读取（契约 22.3）', () => {
  it('openProject 恢复任务列表、置 tasksHydrated，并让 AI 上下文可用', async () => {
    const project = projectWith(2)
    const tasks = [
      makeCloudTask({ taskId: 'tsk_1', projectId: PROJECT_ID, milestoneId: MILESTONE_ID }),
      makeCloudTask({
        taskId: 'tsk_2',
        projectId: PROJECT_ID,
        milestoneId: MILESTONE_ID,
        status: 'todo',
        orderIndex: 1,
      }),
    ]
    installFetch((url, init) => {
      if (init.method === 'GET' && isTaskList(url)) {
        return jsonResponse(tasksBody(tasks))
      }
      return projectRoute(project)(url, init)
    })

    const store = useCloudStore()
    const opened = await store.openProject(PROJECT_ID)

    expect(opened.ok).toBe(true)
    expect(store.tasks.map((task) => task.taskId)).toEqual(['tsk_1', 'tsk_2'])
    expect(store.tasksHydrated).toBe(true)

    const context = store.buildAdvisorContext()
    expect(context.ok).toBe(true)
    if (context.ok) {
      expect(context.data.milestoneId).toBe(MILESTONE_ID)
      expect(context.data.milestoneTasks).toHaveLength(2)
    }
  })

  it('任务列表读取失败：项目仍可打开，任务为空且 tasksHydrated 保持 false', async () => {
    const project = projectWith(2)
    installFetch((url, init) => {
      if (init.method === 'GET' && isTaskList(url)) {
        return jsonResponse({ code: 'INTERNAL', message: '任务读取失败' }, 500)
      }
      return projectRoute(project)(url, init)
    })

    const store = useCloudStore()
    const opened = await store.openProject(PROJECT_ID)

    expect(opened.ok).toBe(true)
    expect(store.tasks).toEqual([])
    expect(store.tasksHydrated).toBe(false)
    // 自动刷新是 silent：不覆盖项目级错误提示
    expect(store.lastError).toBeNull()

    const context = store.buildAdvisorContext()
    expect(context.ok).toBe(false)
    if (!context.ok) expect(context.code).toBe('TASKS_NOT_AVAILABLE')
  })

  it('已恢复后再刷新失败：保留原任务，不改变 tasksHydrated', async () => {
    const project = projectWith(2)
    const tasks = [
      makeCloudTask({ taskId: 'tsk_1', projectId: PROJECT_ID, milestoneId: MILESTONE_ID }),
      makeCloudTask({ taskId: 'tsk_2', projectId: PROJECT_ID, milestoneId: MILESTONE_ID, status: 'todo' }),
    ]
    let fail = false
    installFetch((url, init) => {
      if (init.method === 'GET' && isTaskList(url)) {
        if (fail) return jsonResponse({ code: 'INTERNAL', message: '刷新失败' }, 500)
        return jsonResponse(tasksBody(tasks))
      }
      return projectRoute(project)(url, init)
    })

    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    expect(store.tasksHydrated).toBe(true)

    fail = true
    const refreshed = await store.refreshTasks()

    expect(refreshed.ok).toBe(false)
    expect(store.tasks.map((task) => task.taskId)).toEqual(['tsk_1', 'tsk_2'])
    expect(store.tasksHydrated).toBe(true)
    expect(store.lastError).not.toBeNull()
  })

  it('分页读取会合并多页并按 taskId 去重', async () => {
    const project = projectWith(3)
    const t1 = makeCloudTask({ taskId: 'tsk_1', projectId: PROJECT_ID, milestoneId: MILESTONE_ID })
    const t2 = makeCloudTask({ taskId: 'tsk_2', projectId: PROJECT_ID, milestoneId: MILESTONE_ID })
    const t3 = makeCloudTask({ taskId: 'tsk_3', projectId: PROJECT_ID, milestoneId: MILESTONE_ID })
    let call = 0
    installFetch((url, init) => {
      if (init.method === 'GET' && isTaskList(url)) {
        call += 1
        if (call === 1) return jsonResponse(tasksBody([t1, t2], 'cursor_2'))
        return jsonResponse(tasksBody([t2, t3]))
      }
      return projectRoute(project)(url, init)
    })

    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    expect(call).toBe(2)
    expect(store.tasks.map((task) => task.taskId).sort()).toEqual(['tsk_1', 'tsk_2', 'tsk_3'])
    expect(store.tasksHydrated).toBe(true)
  })

  it('getTask 按契约解析单条任务', async () => {
    const task = makeCloudTask({ taskId: 'tsk_9', projectId: PROJECT_ID, milestoneId: MILESTONE_ID })
    installFetch((url, init) => {
      if (init.method === 'GET' && pathOf(url).endsWith(`/api/projects/${PROJECT_ID}/tasks/tsk_9`)) {
        return readJson({ task })
      }
      return undefined
    })

    const result = await getTask(PROJECT_ID, 'tsk_9')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.task.taskId).toBe('tsk_9')
      expect(result.data.task.status).toBe(task.status)
    }
  })
})
