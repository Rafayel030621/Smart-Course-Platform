import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCloudStore } from '@/stores/cloud'
import {
  cloudRoutes,
  echoEnvelope,
  installFetch,
  jsonResponse,
  makeCloudMaterial,
  makeCloudMilestone,
  makeCloudProject,
  makeMaterialSegment,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const OTHER_PROJECT_ID = 'prj_2'
const NEW_MATERIAL_ID = 'mat_new'

function project(projectId = PROJECT_ID, revision = 3) {
  return makeCloudProject({
    projectId,
    projectRevision: revision,
    currentMilestoneId: 'ms_1',
    milestones: [makeCloudMilestone({ milestoneId: 'ms_1' })],
  })
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function uploadResponse(
  init: RequestInit,
  overrides: { materialId?: string; status?: 'parsed' | 'parse_failed'; segmentCount?: number; segments?: number; deduplicated?: boolean; projectRevision?: number } = {},
) {
  const materialId = overrides.materialId ?? NEW_MATERIAL_ID
  const segmentCount = overrides.segmentCount ?? 1
  const segmentTotal = overrides.segments ?? segmentCount
  return jsonResponse(
    echoEnvelope(
      init,
      {
        material: makeCloudMaterial({
          materialId,
          name: '实验手册.md',
          status: overrides.status ?? 'parsed',
          failureReason: overrides.status === 'parse_failed' ? '材料解析失败，请检查文件内容后重试' : null,
        }),
        segments: Array.from({ length: Math.min(segmentTotal, 20) }, (_, index) =>
          makeMaterialSegment({ materialId, segmentId: `seg_${index}`, index }),
        ),
        segmentCount,
        deduplicated: overrides.deduplicated ?? false,
      },
      { projectId: PROJECT_ID, projectRevision: overrides.projectRevision ?? 4 },
    ),
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

async function openStore(revision = 3) {
  installFetch(cloudRoutes({ project: project(PROJECT_ID, revision), materials: [] }))
  const store = useCloudStore()
  await store.openProject(PROJECT_ID)
  return store
}

describe('云端材料上传', () => {
  it('成功后列表立即可见，提交状态与项目版本同步', async () => {
    const store = await openStore()
    const base = cloudRoutes({ project: project(PROJECT_ID, 3), materials: [] })
    const bodies: Record<string, unknown>[] = []
    installFetch((url, init) => {
      if (url.includes(`/api/projects/${PROJECT_ID}/materials`) && init.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return uploadResponse(init)
      }
      return base(url, init)
    })

    const result = await store.uploadMaterial({
      name: '实验手册.md',
      contentBase64: base64('# 实验手册\n\n正文'),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.materialId).toBe(NEW_MATERIAL_ID)
    expect(store.materials.map((item) => item.materialId)).toContain(NEW_MATERIAL_ID)
    expect(store.materialsHydrated).toBe(true)
    expect(store.sync.projectRevision).toBe(4)
    expect(store.materialUpload.status).toBe('done')
    expect(store.materialUpload.error).toBeNull()
    expect(store.materialUpload.lastUpload).toEqual({
      materialId: NEW_MATERIAL_ID,
      materialVersion: 1,
      materialStatus: 'parsed',
      deduplicated: false,
      segmentCount: 1,
    })
    expect(bodies[0]!['projectRevision']).toBe(3)
    expect(bodies[0]!['name']).toBe('实验手册.md')
  })

  it('同一份文件再次上传：deduplicated=true，不新增列表行、版本不变', async () => {
    const store = await openStore()
    const base = cloudRoutes({ project: project(PROJECT_ID, 3), materials: [] })
    installFetch((url, init) => {
      if (url.includes(`/api/projects/${PROJECT_ID}/materials`) && init.method === 'POST') {
        return uploadResponse(init, { deduplicated: true, projectRevision: 3 })
      }
      return base(url, init)
    })

    await store.uploadMaterial({ name: '实验手册.md', contentBase64: base64('# 同一份') })
    const result = await store.uploadMaterial({ name: '实验手册.md', contentBase64: base64('# 同一份') })

    expect(result.ok).toBe(true)
    expect(store.materials.filter((item) => item.materialId === NEW_MATERIAL_ID)).toHaveLength(1)
    expect(store.sync.projectRevision).toBe(3)
    expect(store.materialUpload.lastUpload?.deduplicated).toBe(true)
  })

  it('服务端只回前 20 条片段时不整段写缓存，改用分页读取', async () => {
    const store = await openStore()
    const base = cloudRoutes({ project: project(PROJECT_ID, 3), materials: [] })
    let segmentRequests = 0
    installFetch((url, init) => {
      if (url.includes(`/api/projects/${PROJECT_ID}/materials`) && init.method === 'POST') {
        // 真实总数 25，响应只带前 20 条
        return uploadResponse(init, { segmentCount: 25 })
      }
      if (url.includes(`/materials/${NEW_MATERIAL_ID}/segments`)) {
        segmentRequests += 1
        const all = Array.from({ length: 25 }, (_, index) =>
          makeMaterialSegment({ materialId: NEW_MATERIAL_ID, segmentId: `seg_${index}`, index }),
        )
        return jsonResponse({
          contractVersion: '3.0',
          projectId: PROJECT_ID,
          projectRevision: 4,
          data: {
            materialId: NEW_MATERIAL_ID,
            materialVersion: 1,
            isCurrent: true,
            readOnly: false,
            segments: all,
            nextCursor: null,
          },
        })
      }
      return base(url, init)
    })

    const result = await store.uploadMaterial({ name: '长文.md', contentBase64: base64('# 长文') })

    expect(result.ok).toBe(true)
    expect(store.materialUpload.lastUpload?.segmentCount).toBe(25)
    // 截断响应不能当成完整片段缓存
    expect(store.cachedSegments(NEW_MATERIAL_ID, 1)).toBeNull()

    const loaded = await store.loadMaterialSegments(NEW_MATERIAL_ID)
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.data).toHaveLength(25)
    expect(segmentRequests).toBe(1)
  })

  it('响应片段条数等于真实总数时写入缓存，重复读取不再发请求', async () => {
    const store = await openStore()
    installFetch((url, init) => {
      if (url.includes(`/api/projects/${PROJECT_ID}/materials`) && init.method === 'POST') {
        return uploadResponse(init, { segmentCount: 2, segments: 2 })
      }
      throw new Error(`不应再发请求：${init.method ?? 'GET'} ${url}`)
    })

    await store.uploadMaterial({ name: '短文.md', contentBase64: base64('# 短文') })

    expect(store.cachedSegments(NEW_MATERIAL_ID, 1)).toHaveLength(2)
    const again = await store.loadMaterialSegments(NEW_MATERIAL_ID)
    expect(again.ok).toBe(true)
  })

  it('parse_failed 是「提交成功、理解未生成」：状态如实，且不进入已确认材料上下文', async () => {
    const store = await openStore()
    const base = cloudRoutes({ project: project(PROJECT_ID, 3), materials: [] })
    installFetch((url, init) => {
      if (url.includes(`/api/projects/${PROJECT_ID}/materials`) && init.method === 'POST') {
        return uploadResponse(init, { status: 'parse_failed', segmentCount: 0 })
      }
      if (url.includes('/understanding')) {
        return jsonResponse({
          contractVersion: '3.0',
          projectId: PROJECT_ID,
          projectRevision: 4,
          data: {
            materialId: NEW_MATERIAL_ID,
            materialVersion: 1,
            isCurrent: true,
            readOnly: false,
            items: [],
            nextCursor: null,
          },
        })
      }
      return base(url, init)
    })

    const result = await store.uploadMaterial({ name: '坏文件.md', contentBase64: base64('   ') })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.status).toBe('parse_failed')
    expect(store.materialUpload.lastUpload?.materialStatus).toBe('parse_failed')

    const context = store.buildConfirmedMaterialsContext()
    expect(context.ok).toBe(true)
    if (context.ok) expect(context.data).toEqual([])
  })

  it('失败时列表不变、错误可恢复，重试后成功', async () => {
    const store = await openStore()
    const base = cloudRoutes({ project: project(PROJECT_ID, 3), materials: [] })
    let fail = true
    installFetch((url, init) => {
      if (url.includes(`/api/projects/${PROJECT_ID}/materials`) && init.method === 'POST') {
        if (fail) {
          return jsonResponse(
            { contractVersion: '3.0', code: 'PROJECT_REVISION_MISMATCH', message: '项目内容已更新，请刷新后重试' },
            409,
          )
        }
        return uploadResponse(init)
      }
      return base(url, init)
    })

    const failed = await store.uploadMaterial({ name: '实验手册.md', contentBase64: base64('# 正文') })

    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('PROJECT_REVISION_MISMATCH')
    expect(store.materialUpload.status).toBe('error')
    expect(store.materialUpload.error?.code).toBe('PROJECT_REVISION_MISMATCH')
    expect(store.materials).toEqual([])

    fail = false
    const retried = await store.uploadMaterial({ name: '实验手册.md', contentBase64: base64('# 正文') })

    expect(retried.ok).toBe(true)
    expect(store.materialUpload.status).toBe('done')
    expect(store.materialUpload.error).toBeNull()
  })

  it('并发提交被拒绝，不会发出两次请求', async () => {
    const store = await openStore()
    const base = cloudRoutes({ project: project(PROJECT_ID, 3), materials: [] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let posts = 0
    installFetch(async (url, init) => {
      if (url.includes(`/api/projects/${PROJECT_ID}/materials`) && init.method === 'POST') {
        posts += 1
        await gate
        return uploadResponse(init)
      }
      return base(url, init) ?? jsonResponse({}, 404)
    })

    const first = store.uploadMaterial({ name: 'a.md', contentBase64: base64('# a') })
    await Promise.resolve()
    const second = await store.uploadMaterial({ name: 'b.md', contentBase64: base64('# b') })

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('DUPLICATE_REQUEST')
    release()
    expect((await first).ok).toBe(true)
    expect(posts).toBe(1)
  })

  it('切换项目后迟到的上传响应不污染新项目', async () => {
    const store = await openStore()
    const base = cloudRoutes({ project: project(PROJECT_ID, 3), materials: [] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installFetch(async (url, init) => {
      if (url.includes(`/api/projects/${PROJECT_ID}/materials`) && init.method === 'POST') {
        await gate
        return uploadResponse(init)
      }
      if (url.includes(`/api/projects/${OTHER_PROJECT_ID}`)) {
        return jsonResponse({
          contractVersion: '3.0',
          projectId: OTHER_PROJECT_ID,
          projectRevision: 1,
          data: {
            project: project(OTHER_PROJECT_ID, 1),
            evidence: [],
            progress: [],
            tasks: [],
          },
        })
      }
      return base(url, init) ?? jsonResponse({}, 200)
    })

    const pending = store.uploadMaterial({ name: 'a.md', contentBase64: base64('# a') })
    await Promise.resolve()
    await store.openProject(OTHER_PROJECT_ID)
    release()
    const result = await pending

    expect(result.ok).toBe(false)
    expect(store.materials.map((item) => item.materialId)).not.toContain(NEW_MATERIAL_ID)
    expect(store.materialUpload.status).toBe('idle')
    expect(store.materialUpload.lastUpload).toBeNull()
  })

  it('localStorage 项目 / 未打开项目时拒绝提交', async () => {
    const store = useCloudStore()
    const notLoaded = await store.uploadMaterial({ name: 'a.md', contentBase64: base64('# a') })
    expect(notLoaded.ok).toBe(false)
    if (!notLoaded.ok) expect(notLoaded.code).toBe('NOT_LOADED')

    const opened = await openStore()
    const mismatch = await opened.uploadMaterial({
      projectId: OTHER_PROJECT_ID,
      name: 'a.md',
      contentBase64: base64('# a'),
    })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.code).toBe('PROJECT_MISMATCH')
  })

  it('空文件名 / 空内容在本地拒绝，不发请求', async () => {
    const store = await openStore()
    const fetchMock = installFetch(() => undefined)

    const blankName = await store.uploadMaterial({ name: '  ', contentBase64: base64('x') })
    expect(blankName.ok).toBe(false)
    if (!blankName.ok) expect(blankName.code).toBe('INVALID_INPUT')
    expect(store.materialUpload.status).toBe('error')

    const empty = await store.uploadMaterial({ name: 'a.md', contentBase64: '  ' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe('EMPTY_MATERIAL')

    expect(vi.mocked(fetchMock).mock.calls).toHaveLength(0)
  })

  it('reset（退出登录）清空上传状态', async () => {
    const store = await openStore()
    store.materialUpload = {
      status: 'done',
      error: null,
      lastUpload: {
        materialId: NEW_MATERIAL_ID,
        materialVersion: 1,
        materialStatus: 'parsed',
        deduplicated: false,
        segmentCount: 1,
      },
    }

    store.reset()

    expect(store.materialUpload).toEqual({ status: 'idle', error: null, lastUpload: null })
  })
})
