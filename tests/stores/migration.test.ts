import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMigrationStore } from '@/stores/migration'
import {
  buildLocalMigrationRequest,
  inspectLocalProjects,
} from '@/domain/localMigration'
import { loadPersistedState, savePersistedState } from '@/stores/persistence'
import type { Project } from '@/types/platform'
import { makeProject } from '../domain/fixtures'
import { FIXED_ISO, installFetch, jsonResponse, requestBody } from '../support/v3Fixtures'

const LOCAL_PROJECTS_KEY = 'scp.mvp.projects'
const STORAGE_KEY_MIGRATIONS = 'scp.v3.migrations'

function localProject(overrides: Partial<Project> = {}): Project {
  return makeProject({
    projectId: 'prj_local_1',
    name: '本地极端风浪项目',
    short: '本地项目',
    projectRevision: 7,
    ms: [
      { t: '数据获取', s: 'cur', p: 30, sub: '进行中' },
      { t: '方法对比', s: 'todo', p: 0, sub: '未开始' },
    ],
    tasks: [
      {
        id: 'tsk_local_1',
        projectId: 'prj_local_1',
        title: '跑通 ERA5 下载链路',
        status: 'doing',
        doneCriteria: '下载样例数据',
        owner: null,
        suggestedOwner: null,
        milestone: '数据获取',
        why: null,
        draftKey: null,
        createdAt: FIXED_ISO,
        updatedAt: FIXED_ISO,
      },
    ],
    evidenceRecords: [
      {
        id: 'evd_local_1',
        projectId: 'prj_local_1',
        submissionId: 'sub_00000001',
        taskId: 'tsk_local_1',
        didWhat: '下载了 ERA5 样例数据',
        foundWhat: '字段完整',
        stillUnsure: '分辨率是否足够',
        attachmentName: null,
        author: null,
        createdAt: FIXED_ISO,
      },
    ],
    doubtRecords: [
      {
        id: 'dbt_local_1',
        projectId: 'prj_local_1',
        text: '分辨率是否足够',
        status: 'open',
        sourceEvidenceId: 'evd_local_1',
        createdAt: FIXED_ISO,
        resolvedAt: null,
      },
    ],
    materialRecords: [
      {
        materialId: 'mat_local_1',
        projectId: 'prj_local_1',
        name: '实验手册.md',
        type: 'md',
        size: 2048,
        encoding: 'utf-8',
        state: 'parsed',
        version: 1,
        createdAt: FIXED_ISO,
        updatedAt: FIXED_ISO,
        failureReason: null,
        needsReupload: false,
      },
    ],
    materialSegments: [
      {
        segmentId: 'seg_0',
        materialId: 'mat_local_1',
        materialVersion: 1,
        index: 0,
        startLine: 1,
        endLine: 8,
        text: '实验手册正文',
      },
    ],
    understandingBlocks: [
      {
        id: 'blk_local_1',
        itemId: 'cnd_goal_0',
        kind: 'goalCandidates',
        materialId: 'mat_local_1',
        materialVersion: 1,
        content: '复现极端风浪识别流程',
        sources: [
          {
            materialId: 'mat_local_1',
            materialName: '实验手册.md',
            materialVersion: 1,
            segmentId: 'seg_0',
            startLine: 1,
            endLine: 8,
          },
        ],
        status: 'pending',
        originalContent: '复现极端风浪识别流程',
        createdAt: FIXED_ISO,
        updatedAt: FIXED_ISO,
      },
    ],
    chat: [
      { who: '学生', text: '下一步做什么？', me: true },
      { who: 'AI 顾问', text: '先跑通下载链路。', me: false, source: 'model' },
    ],
    ...overrides,
  })
}

function seed(project: Project = localProject()): void {
  const result = savePersistedState([project], project.projectId)
  expect(result.ok).toBe(true)
}

function migrationSuccess(init: RequestInit, migrationId: string) {
  const body = requestBody(init)
  return jsonResponse({
    contractVersion: '3.0',
    requestId: body['requestId'],
    projectId: 'prj_cloud_1',
    projectRevision: 1,
    migrationId,
    status: 'completed',
    replayed: false,
    deduplicated: false,
    appliedChanges: true,
    idMap: {
      milestones: { ms_local_1: 'ms_cloud_1' },
      tasks: { tsk_local_1: 'tsk_cloud_1' },
      evidence: { evd_local_1: 'evd_cloud_1' },
      progress: {},
      materials: { mat_local_1: 'mat_cloud_1' },
      understandingItems: { blk_local_1: 'cnd_cloud_1' },
      doubts: { dbt_local_1: 'dbt_cloud_1' },
      chats: { msg_local_1: 'msg_cloud_1' },
    },
    counts: {
      milestones: 2,
      tasks: 1,
      evidence: 1,
      progress: 0,
      materials: 1,
      materialSegments: 1,
      understandingItems: 1,
      doubts: 1,
      chatMessages: 2,
    },
    warnings: [],
    importedAt: FIXED_ISO,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('本地迁移检测', () => {
  it('检测到本地项目时只进入待确认，不发任何请求', async () => {
    seed()
    const fetchMock = installFetch(() => undefined)
    const store = useMigrationStore()

    const candidates = store.detect()

    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.status).toBe('pending-confirmation')
    expect(store.status).toBe('pending-confirmation')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).not.toBeNull()
  })

  it('schemaVersion 缺失/过低时标为阻塞并给中文提示，不发请求', async () => {
    localStorage.setItem(
      LOCAL_PROJECTS_KEY,
      JSON.stringify({ schemaVersion: 0, projects: [{ projectId: 'prj_old', name: '旧数据' }] }),
    )
    const fetchMock = installFetch(() => undefined)
    const store = useMigrationStore()

    const candidates = store.detect()
    expect(candidates[0]!.status).toBe('blocked')
    expect(candidates[0]!.blockReason).toBe('schema-outdated')

    const result = await store.confirmMigration('prj_old')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MIGRATION_DATA_OUTDATED')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).not.toBeNull()
  })
})

describe('确认与结果', () => {
  it('成功响应前不标记完成，成功后仍保留本地数据', async () => {
    seed()
    let requestInit: RequestInit | null = null
    installFetch((url, init) => {
      if (url.endsWith('/api/projects/migrate-local')) {
        requestInit = init
        const body = requestBody(init)
        return migrationSuccess(init, String(body['migrationId']))
      }
      return undefined
    })
    const store = useMigrationStore()
    store.detect()

    const result = await store.confirmMigration('prj_local_1')

    expect(result.ok).toBe(true)
    expect(store.status).toBe('succeeded')
    expect(store.activeCandidate?.cloudProjectId).toBe('prj_cloud_1')
    expect(requestInit).not.toBeNull()
    const body = requestBody(requestInit!)
    expect(body['userConfirmed']).toBe(true)
    expect(body['idempotencyKey']).toBe(body['migrationId'])
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).not.toBeNull()
    expect(localStorage.getItem(STORAGE_KEY_MIGRATIONS)).toContain('prj_cloud_1')
  })

  it('失败时保留本地数据；重试复用同一 migrationId', async () => {
    seed()
    const bodies: Array<Record<string, unknown>> = []
    let calls = 0
    installFetch((url, init) => {
      if (!url.endsWith('/api/projects/migrate-local')) return undefined
      calls += 1
      bodies.push(requestBody(init))
      if (calls === 1) return jsonResponse({ code: 'INTERNAL', message: '服务内部错误' }, 500)
      return migrationSuccess(init, String(bodies[0]!['migrationId']))
    })
    const store = useMigrationStore()
    store.detect()

    const first = await store.confirmMigration('prj_local_1')
    expect(first.ok).toBe(false)
    expect(store.status).toBe('failed')
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).not.toBeNull()

    const second = await store.retryMigration('prj_local_1')
    expect(second.ok).toBe(true)
    expect(calls).toBe(2)
    expect(bodies[0]!['migrationId']).toBe(bodies[1]!['migrationId'])
    expect(bodies[0]!['idempotencyKey']).toBe(bodies[1]!['idempotencyKey'])
    expect(localStorage.getItem(LOCAL_PROJECTS_KEY)).not.toBeNull()
  })

  it('并发重复点击只发送一次请求', async () => {
    seed()
    let resolveResponse!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    let calls = 0
    installFetch((url, init) => {
      if (!url.endsWith('/api/projects/migrate-local')) return undefined
      calls += 1
      const body = requestBody(init)
      return pending.then(() => migrationSuccess(init, String(body['migrationId'])))
    })
    const store = useMigrationStore()
    store.detect()

    const first = store.confirmMigration('prj_local_1')
    const second = store.confirmMigration('prj_local_1')
    resolveResponse(jsonResponse({}))
    const [a, b] = await Promise.all([first, second])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(calls).toBe(1)
  })
})

describe('迁移载荷映射', () => {
  it('使用契约字段，不泄露本地字段名，且不伪造进展', () => {
    seed()
    const inspected = inspectLocalProjects()
    const item = inspected.projects.find((entry) => entry.localProjectId === 'prj_local_1')
    expect(item?.project).not.toBeNull()

    const built = buildLocalMigrationRequest(item!.project!, item!.schemaVersion, {
      migrationId: 'mig_0123456789abcdef',
      userConfirmedAt: new Date().toISOString(),
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const payload = built.request.localProject
    expect(payload.progress).toEqual([])
    expect(payload.tasks[0]!.milestoneClientId).toBe(payload.milestones[0]!.clientId)
    expect(payload.materials[0]!.understandingItems[0]!.status).toBe('pending')
    expect(payload.materials[0]!.segments[0]!.segmentId).toBe('seg_0')
    expect(payload.chats.map((item) => item.role)).toEqual(['user', 'assistant'])

    const serialized = JSON.stringify(built.request)
    for (const forbidden of ['"ms"', '"t":', '"materialRecords"', '"understandingBlocks"', '"who"', '"me"']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('schema migration 保留任务/证据/聊天/材料数据', () => {
    seed()
    const loaded = loadPersistedState()
    expect(loaded.projects).toHaveLength(1)
    const project = loaded.projects[0]!
    expect(project.schemaVersion).toBe(3)
    expect(project.tasks[0]!.title).toBe('跑通 ERA5 下载链路')
    expect(project.evidenceRecords[0]!.submissionId).toBe('sub_00000001')
    expect(project.doubtRecords[0]!.text).toBe('分辨率是否足够')
    expect(project.materialRecords[0]!.name).toBe('实验手册.md')
    expect(project.materialSegments[0]!.segmentId).toBe('seg_0')
    expect(project.understandingBlocks[0]!.status).toBe('pending')
    expect(project.chat).toHaveLength(2)
  })
})
