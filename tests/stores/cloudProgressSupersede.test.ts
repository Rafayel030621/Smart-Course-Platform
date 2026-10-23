import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCloudStore } from '@/stores/cloud'
import {
  cloudRoutes,
  echoEnvelope,
  installFetch,
  jsonResponse,
  makeCloudMilestone,
  makeCloudProject,
  makeEvidence,
  makeProgress,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const OLD_PROGRESS_ID = 'prg_old'
const NEW_PROGRESS_ID = 'prg_new'

function project(revision = 9) {
  return makeCloudProject({
    projectId: PROJECT_ID,
    projectRevision: revision,
    currentMilestoneId: 'ms_1',
    milestones: [makeCloudMilestone({ milestoneId: 'ms_1' })],
  })
}

function oldProgress() {
  return makeProgress({
    progressId: OLD_PROGRESS_ID,
    summary: '旧的成功率 72%',
    revision: 2,
    occurredAt: '2026-10-18T00:00:00.000Z',
  })
}

function newProgress() {
  return makeProgress({
    progressId: NEW_PROGRESS_ID,
    summary: '更正：成功率 68%',
    revision: 1,
    status: 'active',
    supersedesProgressId: OLD_PROGRESS_ID,
    occurredAt: '2026-10-18T00:00:00.000Z',
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('云端进展更正', () => {
  async function openStore(revision = 9) {
    installFetch(
      cloudRoutes({
        project: project(revision),
        progress: [oldProgress()],
        evidence: [makeEvidence({ evidenceId: 'evd_1' })],
      }),
    )
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    return store
  }

  it('更正成功后旧记录置 superseded，新记录成为唯一的 active', async () => {
    const store = await openStore()
    const write = vi.fn((init: RequestInit) =>
      jsonResponse(
        echoEnvelope(
          init,
          {
            progress: newProgress(),
            supersededProgressId: OLD_PROGRESS_ID,
            milestoneStats: { total: 0, done: 0, doing: 0, todo: 0, archived: 0, progress: 0 },
          },
          { projectId: PROJECT_ID, projectRevision: 10 },
        ),
      ),
    )
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/supersede')) return write(init)
      return jsonResponse({ contractVersion: '3.0', projectId: PROJECT_ID, projectRevision: 10, data: {} })
    }))

    const result = await store.supersedeProgress({
      progressId: OLD_PROGRESS_ID,
      expectedRevision: 2,
      summary: '更正：成功率 68%',
    })

    expect(result.ok, JSON.stringify(result)).toBe(true)
    const old = store.progress.find((item) => item.progressId === OLD_PROGRESS_ID)
    const fresh = store.progress.find((item) => item.progressId === NEW_PROGRESS_ID)
    expect(old?.status).toBe('superseded')
    expect(old?.summary).toBe('旧的成功率 72%')
    expect(fresh?.status).toBe('active')
    expect(store.progress.filter((item) => item.status === 'active')).toHaveLength(1)
    expect(store.sync.projectRevision).toBe(10)

    // 顾问上下文只取 active：更正后一定用新正文
    const context = store.buildAdvisorContext()
    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(context.data.recentProgress.map((item) => item.progressId)).toEqual([NEW_PROGRESS_ID])
    expect(context.data.recentProgress[0]!.summary).toBe('更正：成功率 68%')
  })

  it('本地 expectedRevision 不一致时不发请求', async () => {
    const store = await openStore()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await store.supersedeProgress({
      progressId: OLD_PROGRESS_ID,
      expectedRevision: 1,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_REVISION')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.progress.find((item) => item.progressId === OLD_PROGRESS_ID)?.status).toBe('active')
  })

  it('已更正的进展不允许重复更正', async () => {
    const store = await openStore()
    store.progress = [
      { ...oldProgress(), status: 'superseded' },
      newProgress(),
    ]
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await store.supersedeProgress({
      progressId: OLD_PROGRESS_ID,
      expectedRevision: 3,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_STATE_TRANSITION')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('服务端拒绝时不产生半更新', async () => {
    const store = await openStore()
    installFetch(() =>
      jsonResponse(
        {
          contractVersion: '3.0',
          code: 'STALE_REVISION',
          message: '该进展已被修改',
          currentEntityRevision: 4,
        },
        409,
      ),
    )

    const result = await store.supersedeProgress({
      progressId: OLD_PROGRESS_ID,
      expectedRevision: 2,
      summary: '更正',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_REVISION')
    expect(store.progress).toHaveLength(1)
    expect(store.progress[0]!.status).toBe('active')
    expect(store.progress[0]!.summary).toBe('旧的成功率 72%')
    expect(store.sync.projectRevision).toBe(9)
  })

  it('更正说明为空时在本地拒绝', async () => {
    const store = await openStore()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await store.supersedeProgress({
      progressId: OLD_PROGRESS_ID,
      expectedRevision: 2,
      summary: '   ',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_INPUT')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
