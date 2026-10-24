/**
 * 本地 V3 后端集成测试（opt-in，仅 loopback）
 * ----------------------------------------------------------------------------
 * 运行方式见 docs/integration-v3-local.md：
 *   npm run test:integration:v3-local
 *
 * 约束：
 *   1. 只有设置了 V3_LOCAL_API_BASE_URL 才会跑；普通 `npm test` 不包含本目录。
 *   2. 后端地址必须是 loopback（localhost / 127.0.0.1 / ::1），否则在发请求前失败。
 *   3. 不使用 VITE_API_BASE_URL：所有请求由 tests/support/v3LocalHarness.ts 改写到
 *      V3_LOCAL_API_BASE_URL，确保测试不会打到别的环境。
 *   4. 邀请码只从 V3_LOCAL_INVITE_CODE 读取；测试账号密码运行时生成，不写入文件或日志。
 *   5. 只覆盖后端已实现、契约已冻结的端点；未冻结能力以 404 探测记录为已知缺口。
 *
 * 测试数据：每次运行注册一个新的测试账号，并创建带 [v3local] 标记的项目。
 * 当前后端没有“删除账号/硬删除项目”的接口，因此不会自动清理；残留数据的处理见文档。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlatformStore } from '@/stores/platform'
import { useCloudStore } from '@/stores/cloud'
import { useSessionStore } from '@/stores/session'
import { useWorkbenchStore } from '@/stores/workbench'
import { STORAGE_KEY_PROJECTS } from '@/stores/persistence'
import {
  createProject as createProjectApi,
  createTask as createTaskApi,
  getProject as getProjectApi,
  listMilestones,
  listProgress,
  submitProgress as submitProgressApi,
  updateMilestone as updateMilestoneApi,
  updateProject as updateProjectApi,
  updateTask as updateTaskApi,
} from '@/services/projectsApi'
import { loginAccount } from '@/services/authApi'
import {
  HAS_INVITE_CODE,
  LOCAL_BASE_URL,
  SKIP_REASON,
  TEST_ACCOUNT,
  TEST_MARKER,
  TEST_PASSWORD,
  installLocalFetchGuard,
  localRequest,
  must,
  newRequestId,
  type LocalFetchGuard,
} from '../support/v3LocalHarness'

type PlatformStore = ReturnType<typeof usePlatformStore>
type CloudStore = ReturnType<typeof useCloudStore>
type SessionStore = ReturnType<typeof useSessionStore>
type WorkbenchStore = ReturnType<typeof useWorkbenchStore>

const RUN = LOCAL_BASE_URL !== '' && HAS_INVITE_CODE
const INVITE_CODE = (process.env.V3_LOCAL_INVITE_CODE ?? '').trim()
const PROJECT_NAME_PREFIX = `[${TEST_MARKER}]`

if (!RUN) console.info(SKIP_REASON)

let guard: LocalFetchGuard | null = null
let platform: PlatformStore
let cloud: CloudStore
let session: SessionStore
let workbench: WorkbenchStore

let userId = ''
let projectId = ''
let projectBId = ''
let milestoneA = ''
let milestoneB = ''
let taskId = ''
let evidenceId = ''
let progressId = ''

/** 同一文件内的用例按顺序共享状态：前一步失败会让后续用例一起失败，便于定位首个破点 */
describe.skipIf(!RUN)('本地 V3 后端集成（真实 HTTP，仅 loopback）', () => {
  beforeAll(() => {
    setActivePinia(createPinia())
    // 闸门必须在任何业务请求之前安装
    guard = installLocalFetchGuard()
    platform = usePlatformStore()
    cloud = useCloudStore()
    session = useSessionStore()
    workbench = useWorkbenchStore()
  })

  afterAll(() => {
    guard?.uninstall()
    console.info(
      `[${TEST_MARKER}] 本次运行写入了测试数据（不会自动清理）：` +
        JSON.stringify({ account: TEST_ACCOUNT, projectId, projectBId }),
    )
  })

  it('未登录时恢复会话失败，状态为未认证', async () => {
    const anon = await session.restoreSession()
    expect(anon.ok).toBe(false)
    expect(session.status).toBe('unauthenticated')
  })

  it('注册测试账号并建立 Cookie 会话', async () => {
    const register = await localRequest('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: '3.0',
        requestId: newRequestId(),
        idempotencyKey: `it-register-${TEST_ACCOUNT}`,
        account: TEST_ACCOUNT,
        password: TEST_PASSWORD,
        displayName: '本地集成测试用户',
        inviteCode: INVITE_CODE,
      }),
    })
    const registerBody = (await register.json()) as {
      user?: { account?: string; userId?: string }
      code?: string
    }
    // 失败信息只带状态码与错误码，不回显邀请码
    expect(register.status, `注册失败：HTTP ${register.status} ${registerBody.code ?? ''}`).toBeLessThan(300)
    expect(registerBody.user?.account).toBe(TEST_ACCOUNT)
    userId = registerBody.user?.userId ?? ''
    expect(userId).not.toBe('')

    // Cookie 会话 + /api/auth/me + 项目列表
    must(await platform.initialize(), '启动会话')
    expect(platform.authStatus).toBe('authenticated')
    expect(platform.currentUser?.userId).toBe(userId)
    expect(platform.projectsStatus).toBe('ready')
    expect(platform.cloudProjects).toEqual([])

    // 登录接口本身也验证一次（不依赖注册留下的会话）
    const loggedIn = must(await loginAccount(TEST_ACCOUNT, TEST_PASSWORD), '登录')
    expect(loggedIn.data.user.userId).toBe(userId)
  })

  it('创建项目并校验归属、初始版本与空阶段列表', async () => {
    const created = must(
      await platform.createCloudProject({
        name: `${PROJECT_NAME_PREFIX} 项目 A`,
        short: '联调A',
        profile: {
          goal: '验证 V3 数据层本地联调',
          expectedOutcome: '跑通写入与读取',
          memberNames: ['本地集成测试用户'],
          researchPeriod: '2026-10',
          scope: '仅本地临时数据库',
          outOfScope: null,
        },
      }),
      '创建项目',
    )
    projectId = created.data.projectId
    expect(projectId).toMatch(/^prj_/)
    expect(platform.cloudProjects.map((item) => item.projectId)).toContain(projectId)

    const detail = must(await getProjectApi(projectId), '读取项目详情')
    expect(detail.data.ownerUserId).toBe(userId)
    expect(detail.data.projectRevision).toBe(1)
    expect(detail.data.milestones).toEqual([])

    must(await cloud.openProject(projectId), '打开项目')
    expect(cloud.project?.projectId).toBe(projectId)
  })

  it('更新项目资料，过期版本被拒绝（STALE_REVISION）', async () => {
    must(await cloud.updateProject({ name: `${PROJECT_NAME_PREFIX} 项目 A（改名）` }), '更新项目资料')
    expect(cloud.projectRevision).toBe(2)

    const staleUpdate = await updateProjectApi({
      projectId,
      projectRevision: 1,
      name: '过期版本不应成功',
    })
    expect(staleUpdate.ok).toBe(false)
    if (!staleUpdate.ok) expect(staleUpdate.error.code).toBe('STALE_REVISION')
  })

  it('阶段：创建、编辑、排序、激活、完成、重开、归档、恢复', async () => {
    const msA = must(
      await cloud.createMilestone({
        name: `${PROJECT_NAME_PREFIX} 阶段甲`,
        goal: '验证阶段写入',
        doneCriteria: '阶段甲可完成',
        status: 'planned',
      }),
      '创建阶段甲',
    )
    const msB = must(
      await cloud.createMilestone({
        name: `${PROJECT_NAME_PREFIX} 阶段乙`,
        doneCriteria: '阶段乙可完成',
        status: 'planned',
      }),
      '创建阶段乙',
    )
    milestoneA = msA.data.milestoneId
    milestoneB = msB.data.milestoneId

    must(
      await cloud.updateMilestone({
        milestoneId: milestoneA,
        expectedRevision: msA.data.revision,
        name: `${PROJECT_NAME_PREFIX} 阶段甲（改名）`,
      }),
      '编辑阶段',
    )
    must(await cloud.reorderMilestones({ order: [milestoneB, milestoneA] }), '阶段排序')

    const reordered = must(await listMilestones(projectId), '读取阶段列表')
    expect(reordered.data.milestones.map((item) => item.milestoneId)).toEqual([
      milestoneB,
      milestoneA,
    ])

    const msAAfter = cloud.milestones.find((item) => item.milestoneId === milestoneA)
    must(
      await cloud.activateMilestone({
        milestoneId: milestoneA,
        expectedRevision: msAAfter?.revision ?? msA.data.revision,
      }),
      '激活阶段',
    )
    const msAActive = cloud.milestones.find((item) => item.milestoneId === milestoneA)
    expect(msAActive?.status).toBe('active')
    expect(cloud.currentMilestoneId).toBe(milestoneA)

    must(
      await cloud.completeMilestone({
        milestoneId: milestoneA,
        expectedRevision: msAActive?.revision ?? 1,
      }),
      '完成阶段',
    )
    expect(cloud.milestones.find((item) => item.milestoneId === milestoneA)?.status).toBe(
      'completed',
    )

    const msACompleted = cloud.milestones.find((item) => item.milestoneId === milestoneA)
    must(
      await cloud.reopenMilestone({
        milestoneId: milestoneA,
        expectedRevision: msACompleted?.revision ?? 1,
      }),
      '重开阶段',
    )
    expect(cloud.milestones.find((item) => item.milestoneId === milestoneA)?.status).toBe('active')

    const msAReopened = cloud.milestones.find((item) => item.milestoneId === milestoneA)
    must(
      await cloud.archiveMilestone({
        milestoneId: milestoneA,
        expectedRevision: msAReopened?.revision ?? 1,
      }),
      '归档阶段',
    )
    const archivedList = must(
      await listMilestones(projectId, { includeArchived: true }),
      '读取含归档阶段',
    )
    expect(
      archivedList.data.milestones.find((item) => item.milestoneId === milestoneA)?.archivedAt,
    ).not.toBeNull()

    const restoreTarget = cloud.milestones.find((item) => item.milestoneId === milestoneA)
    must(
      await cloud.restoreMilestone({
        milestoneId: milestoneA,
        expectedRevision: restoreTarget?.revision ?? 1,
      }),
      '恢复阶段',
    )
    expect(cloud.milestones.find((item) => item.milestoneId === milestoneA)?.archivedAt).toBeNull()
  })

  it('任务：创建、编辑、状态流转、跨阶段移动、归档、恢复', async () => {
    const taskCreated = must(
      await cloud.createTask({
        title: `${PROJECT_NAME_PREFIX} 任务一`,
        doneCriteria: '跑通本地联调',
        milestoneId: milestoneA,
        status: 'todo',
      }),
      '创建任务',
    )
    taskId = taskCreated.data.taskId

    must(
      await cloud.updateTask({
        taskId,
        expectedRevision: taskCreated.data.revision,
        title: `${PROJECT_NAME_PREFIX} 任务一（改名）`,
      }),
      '编辑任务',
    )

    const taskAfterEdit = cloud.tasks.find((item) => item.taskId === taskId)
    must(
      await cloud.startTask({ taskId, expectedRevision: taskAfterEdit?.revision ?? 1 }),
      '启动任务',
    )
    expect(cloud.tasks.find((item) => item.taskId === taskId)?.status).toBe('doing')

    const taskDoing = cloud.tasks.find((item) => item.taskId === taskId)
    must(
      await cloud.completeTask({ taskId, expectedRevision: taskDoing?.revision ?? 1 }),
      '完成任务',
    )
    const taskDone = cloud.tasks.find((item) => item.taskId === taskId)
    expect(taskDone?.status).toBe('done')

    must(
      await cloud.reopenTask({
        taskId,
        expectedRevision: taskDone?.revision ?? 1,
        targetStatus: 'todo',
      }),
      '重开任务（完成→待办）',
    )
    const taskTodo = cloud.tasks.find((item) => item.taskId === taskId)
    expect(taskTodo?.status).toBe('todo')

    const linked = must(
      await cloud.linkTaskToMilestone({
        taskId,
        milestoneId: milestoneB,
        expectedRevision: taskTodo?.revision ?? 1,
      }),
      '任务关联阶段',
    )
    expect(linked.data.milestoneId).toBe(milestoneB)

    const taskLinked = cloud.tasks.find((item) => item.taskId === taskId)
    must(
      await cloud.archiveTask({ taskId, expectedRevision: taskLinked?.revision ?? 1 }),
      '归档任务',
    )
    const taskArchived = cloud.tasks.find((item) => item.taskId === taskId)
    must(
      await cloud.restoreTask({ taskId, expectedRevision: taskArchived?.revision ?? 1 }),
      '恢复任务',
    )
    expect(cloud.tasks.find((item) => item.taskId === taskId)?.archivedAt).toBeNull()
  })

  it('证据与进展：写入、读取、解除关联、阶段与任务不一致时拒绝', async () => {
    const taskReady = cloud.tasks.find((item) => item.taskId === taskId)
    must(await cloud.startTask({ taskId, expectedRevision: taskReady?.revision ?? 1 }), '启动任务')

    const taskDoing = cloud.tasks.find((item) => item.taskId === taskId)
    const evidenceCreated = must(
      await cloud.createEvidence({
        taskId,
        milestoneId: milestoneB,
        didWhat: `${PROJECT_NAME_PREFIX} 提交证据`,
        foundWhat: '接口返回成功',
        stillUnsure: '无',
        attachmentName: 'local-it.txt',
        completeTask: true,
        expectedTaskRevision: taskDoing?.revision ?? 1,
      }),
      '创建证据并完成任务',
    )
    evidenceId = evidenceCreated.data.evidence.evidenceId
    expect(cloud.tasks.find((item) => item.taskId === taskId)?.status).toBe('done')
    expect(cloud.evidence.map((item) => item.evidenceId)).toContain(evidenceId)

    must(
      await cloud.attachEvidenceToTask({
        evidenceId,
        taskId: null,
        milestoneId: null,
        expectedRevision: evidenceCreated.data.evidence.revision,
      }),
      '证据解除关联',
    )
    const evidenceAfter = cloud.evidence.find((item) => item.evidenceId === evidenceId)
    expect(evidenceAfter?.taskId).toBeNull()
    expect(evidenceAfter?.milestoneId).toBeNull()

    const progressNull = must(
      await cloud.submitProgress({
        milestoneId: null,
        taskId: null,
        summary: `${PROJECT_NAME_PREFIX} 进展（空关联）`,
      }),
      '提交空关联进展',
    )
    progressId = progressNull.data.progressId
    expect(progressId).toMatch(/^prg_/)

    must(
      await cloud.submitProgress({
        milestoneId: milestoneB,
        taskId,
        summary: `${PROJECT_NAME_PREFIX} 进展（关联任务）`,
      }),
      '提交关联进展',
    )
    const progressList = must(await listProgress(projectId), '读取进展')
    expect(progressList.data.progress.map((item) => item.progressId)).toContain(progressId)

    const conflictProgress = await cloud.submitProgress({
      milestoneId: milestoneA,
      taskId,
      summary: '阶段与任务不一致，应被拒绝',
    })
    expect(conflictProgress.ok).toBe(false)
    if (!conflictProgress.ok) expect(conflictProgress.code).toBe('INVALID_INPUT')
  })

  it('真实后端归属校验：跨项目任务/阶段被拒绝，过期阶段版本被拒绝', async () => {
    const projectB = must(
      await createProjectApi({
        name: `${PROJECT_NAME_PREFIX} 项目 B`,
        profile: {
          goal: null,
          expectedOutcome: null,
          memberNames: [],
          researchPeriod: null,
          scope: null,
          outOfScope: null,
        },
      }),
      '创建项目 B',
    )
    projectBId = projectB.data.projectId

    const crossProjectTask = await updateTaskApi({
      projectId: projectBId,
      projectRevision: projectB.data.projectRevision,
      taskId,
      expectedRevision: 1,
      title: '跨项目改名不应成功',
    })
    expect(crossProjectTask.ok).toBe(false)
    expect(crossProjectTask.ok ? '' : crossProjectTask.error.code).toBe('RESOURCE_NOT_FOUND')

    const crossProjectMilestone = await createTaskApi({
      projectId: projectBId,
      projectRevision: projectB.data.projectRevision,
      title: '跨项目阶段任务不应成功',
      milestoneId: milestoneA,
    })
    expect(crossProjectMilestone.ok).toBe(false)
    expect(crossProjectMilestone.ok ? '' : crossProjectMilestone.error.code).toBe(
      'RESOURCE_NOT_FOUND',
    )

    const milestoneBState = cloud.milestones.find((item) => item.milestoneId === milestoneB)
    const staleMilestone = await updateMilestoneApi({
      projectId,
      projectRevision: cloud.projectRevision,
      milestoneId: milestoneB,
      expectedRevision: (milestoneBState?.revision ?? 1) + 5,
      name: '过期阶段版本不应成功',
    })
    expect(staleMilestone.ok).toBe(false)
    if (!staleMilestone.ok) expect(staleMilestone.error.code).toBe('STALE_REVISION')
  })

  it('幂等：同内容在新版本下换键；显式重试回放同一条进展', async () => {
    // 项目版本已变化，同内容属于新的逻辑操作 → 默认幂等键必须变化，不能 IDEMPOTENCY_CONFLICT
    const dupSummary = `${PROJECT_NAME_PREFIX} 重复提交一致性测试`
    const dupFirst = must(
      await cloud.submitProgress({ milestoneId: null, taskId: null, summary: dupSummary }),
      '重复提交第一次',
    )
    const dupSecond = must(
      await cloud.submitProgress({ milestoneId: null, taskId: null, summary: dupSummary }),
      '重复提交第二次',
    )
    expect(dupSecond.data.progressId).not.toBe(dupFirst.data.progressId)
    expect(cloud.progress.filter((item) => item.summary === dupSummary)).toHaveLength(2)

    // 同一 revision + 同一 idempotencyKey = 同一次网络重试 → 回放同一条进展
    const retryKey = `it-progress-retry-${newRequestId()}`
    const retryInput = {
      projectId,
      projectRevision: cloud.projectRevision,
      milestoneId: null,
      taskId: null,
      summary: `${PROJECT_NAME_PREFIX} 显式重试回放测试`,
    }
    const retryFirst = must(
      await submitProgressApi(retryInput, { idempotencyKey: retryKey }),
      '显式重试第一次',
    )
    const retrySecond = must(
      await submitProgressApi(retryInput, { idempotencyKey: retryKey }),
      '显式重试第二次',
    )
    expect(retrySecond.data.progress.progressId).toBe(retryFirst.data.progress.progressId)
    expect(retryFirst.replayed).toBe(false)
    expect(retrySecond.replayed).toBe(true)
  })

  it('项目归档/恢复/软删除/恢复删除，归档与删除后禁写', async () => {
    // 上一步直接调用 service 层（绕过 store），这里先按服务端最新版本重新加载
    must(await cloud.openProject(projectId), '归档前刷新项目')

    must(await cloud.archiveProject(), '归档项目')
    expect(cloud.project?.status).toBe('archived')
    const blocked = await cloud.createMilestone({ name: '归档后不应创建成功' })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.code).toBe('PROJECT_ARCHIVED')

    must(await cloud.restoreProject(), '恢复项目')
    must(await cloud.deleteProject(), '软删除项目')
    expect(cloud.project?.status).toBe('deleted')
    const blockedDeleted = await cloud.createMilestone({ name: '删除后不应创建成功' })
    expect(blockedDeleted.ok).toBe(false)

    must(await cloud.restoreDeletedProject(), '恢复已删除项目')
    expect(cloud.project?.status).toBe('active')
  })

  it('任务读取与阶段候选已实现；时间线仍为 404，不伪造替代实现', async () => {
    const tasksGet = await localRequest(`/api/projects/${projectId}/tasks`)
    expect(tasksGet.status).toBe(200)
    const tasksBody = (await tasksGet.json()) as { data?: { tasks?: unknown } }
    expect(Array.isArray(tasksBody.data?.tasks)).toBe(true)

    const timelineGet = await localRequest(`/api/projects/${projectId}/timeline`)
    expect(timelineGet.status).toBe(404)

    // D12 已实现：合法请求返回 200，且候选形状符合契约 23.7（未配模型时走 fallback）
    // 上一条用例改过项目状态，先刷新拿到最新 projectRevision，否则会被 409 STALE_REVISION 拒绝
    must(await cloud.openProject(projectId), '生成候选前刷新项目')
    const candidatesPost = await localRequest(`/api/projects/${projectId}/milestones/candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: '3.0',
        requestId: newRequestId(),
        projectId,
        idempotencyKey: newRequestId(),
        projectRevision: cloud.projectRevision,
        promptVersion: 'milestone-candidate-v1',
        maxCandidates: 1,
      }),
    })
    expect(candidatesPost.status).toBe(200)
    const candidatesBody = (await candidatesPost.json()) as {
      source?: string
      candidates?: Array<{ candidateId?: string; expiresAt?: string }>
    }
    expect(['model', 'fallback']).toContain(candidatesBody.source)
    expect(Array.isArray(candidatesBody.candidates)).toBe(true)

    // 客户端对未提供的时间线接口给出明确错误码，而不是静默成功
    const timeline = cloud.loadTimeline()
    expect(timeline.ok).toBe(false)
    if (!timeline.ok) expect(timeline.code).toBe('TIMELINE_NOT_AVAILABLE')
  })

  it('退出登录：云端状态清空，本地项目不受影响；所有请求都落在 loopback', async () => {
    const local = workbench.createProject({
      topicId: '__custom__',
      customName: '本地项目（退出登录前创建）',
      members: 2,
    })
    must(local, '本地项目创建')
    const localBefore = localStorage.getItem(STORAGE_KEY_PROJECTS)
    expect(localBefore).not.toBeNull()

    must(await platform.logout(), '退出登录')
    expect(session.status).toBe('unauthenticated')
    expect(platform.cloudProjects).toEqual([])
    expect(cloud.project).toBeNull()

    const meAfter = await session.restoreSession()
    expect(meAfter.ok).toBe(false)
    expect(localStorage.getItem(STORAGE_KEY_PROJECTS)).toBe(localBefore)
    expect(useWorkbenchStore().projects.map((item) => item.name)).toContain(
      '本地项目（退出登录前创建）',
    )

    // 证明这次运行真的发出了真实请求，且全部只访问 loopback
    const requests = guard?.requests ?? []
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((url) => url.startsWith(LOCAL_BASE_URL))).toBe(true)
  })
}, 60_000)
