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
  makeUnderstandingItem,
  readEnvelope,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const MATERIAL_ID = 'mat_1'

function project(revision = 3) {
  return makeCloudProject({
    projectId: PROJECT_ID,
    projectRevision: revision,
    currentMilestoneId: 'ms_1',
    milestones: [makeCloudMilestone({ milestoneId: 'ms_1' })],
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('材料列表加载', () => {
  it('打开项目时读取材料列表并置 materialsHydrated', async () => {
    const material = makeCloudMaterial()
    installFetch(cloudRoutes({ project: project(), materials: [material] }))
    const store = useCloudStore()

    const opened = await store.openProject(PROJECT_ID)

    expect(opened.ok).toBe(true)
    expect(store.materials).toHaveLength(1)
    expect(store.materialsHydrated).toBe(true)
    expect(store.materialsStatus).toBe('ready')
    expect(store.findMaterial(MATERIAL_ID)?.materialVersion).toBe(1)
  })

  it('材料读取失败只影响材料状态，不阻断打开项目，也不清空已有列表', async () => {
    const material = makeCloudMaterial()
    const base = cloudRoutes({ project: project(), materials: [material] })
    let failMaterials = false
    installFetch((url, init) => {
      if (failMaterials && url.includes('/materials')) {
        return jsonResponse({ contractVersion: '3.0', code: 'INTERNAL', message: '服务异常' }, 500)
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    expect(store.materials).toHaveLength(1)

    failMaterials = true
    const refreshed = await store.refreshMaterials()

    expect(refreshed.ok).toBe(false)
    expect(store.materials).toHaveLength(1)
    expect(store.materialsStatus).toBe('error')
    expect(store.materialsError?.code).toBe('INTERNAL')
    // 项目级错误不被静默覆盖成「没有材料」
    expect(store.materialsHydrated).toBe(true)
  })

  it('分页读取材料列表，按 nextCursor 拉全', async () => {
    const first = makeCloudMaterial({ materialId: 'mat_1', name: '一.md' })
    const second = makeCloudMaterial({ materialId: 'mat_2', name: '二.txt', type: 'txt' })
    installFetch((url, init) => {
      const path = url.split('?')[0] ?? url
      if (path.endsWith(`/api/projects/${PROJECT_ID}/materials`)) {
        const cursor = new URL(url, 'http://localhost').searchParams.get('cursor')
        if (cursor === null) {
          return jsonResponse(readEnvelope({ materials: [first], nextCursor: 'page_2' }, PROJECT_ID, 3))
        }
        return jsonResponse(readEnvelope({ materials: [second], nextCursor: null }, PROJECT_ID, 3))
      }
      return cloudRoutes({ project: project() })(url, init)
    })
    const store = useCloudStore()

    await store.openProject(PROJECT_ID)

    expect(store.materials.map((item) => item.materialId)).toEqual(['mat_1', 'mat_2'])
  })

  it('切换项目时丢弃上一个项目迟到的材料响应', async () => {
    const lateMaterials = deferred<Response>()
    const projectA = makeCloudProject({ projectId: 'prj_a', projectRevision: 2 })
    const projectB = makeCloudProject({ projectId: 'prj_b', projectRevision: 2 })
    installFetch((url, init) => {
      if (url.includes('/api/projects/prj_a/materials')) return lateMaterials.promise
      if (url.includes('/api/projects/prj_a')) {
        return cloudRoutes({ project: projectA })(url, init)
      }
      return cloudRoutes({ project: projectB })(url, init)
    })
    const store = useCloudStore()

    const openA = store.openProject('prj_a')
    await Promise.resolve()
    const openB = store.openProject('prj_b')
    await openB
    lateMaterials.resolve(
      jsonResponse(readEnvelope({ materials: [makeCloudMaterial()], nextCursor: null }, 'prj_a', 2)),
    )
    await openA

    // 迟到的 prj_a 材料不能覆盖 prj_b 的状态
    expect(store.project?.projectId).toBe('prj_b')
    expect(store.materials).toEqual([])
    expect(store.materialsStatus).toBe('ready')
    expect(store.materialsHydrated).toBe(true)
  })

  it('退出登录（reset）清空材料与缓存', async () => {
    installFetch(cloudRoutes({ project: project(), materials: [makeCloudMaterial()] }))
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    await store.loadMaterialSegments(MATERIAL_ID)
    expect(store.cachedSegments(MATERIAL_ID, 1)).not.toBeNull()

    store.reset()

    expect(store.materials).toEqual([])
    expect(store.materialsHydrated).toBe(false)
    expect(store.cachedSegments(MATERIAL_ID, 1)).toBeNull()
    expect(store.materialsStatus).toBe('idle')
  })
})

describe('片段与理解条目读取', () => {
  function fixture() {
    return {
      project: project(),
      materials: [makeCloudMaterial()],
      materialSegments: {
        [`${MATERIAL_ID}@1`]: [
          makeMaterialSegment({ segmentId: 'seg_0', index: 0 }),
          makeMaterialSegment({ segmentId: 'seg_1', index: 1, startLine: 4, endLine: 6 }),
        ],
      },
      materialItems: {
        [`${MATERIAL_ID}@1`]: [
          makeUnderstandingItem({ itemId: 'it_1', status: 'confirmed' }),
          makeUnderstandingItem({ itemId: 'it_2', status: 'pending' }),
        ],
      },
    }
  }

  it('按材料+版本缓存片段与条目；重复读取不再发请求', async () => {
    const base = cloudRoutes(fixture())
    let segmentRequests = 0
    installFetch((url, init) => {
      if (url.includes(`/materials/${MATERIAL_ID}/segments`)) segmentRequests += 1
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const first = await store.loadMaterialSegments(MATERIAL_ID)
    const second = await store.loadMaterialSegments(MATERIAL_ID)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(segmentRequests).toBe(1)
    expect(store.cachedSegments(MATERIAL_ID, 1)).toHaveLength(2)

    const items = await store.loadMaterialUnderstanding(MATERIAL_ID)
    expect(items.ok).toBe(true)
    expect(store.cachedUnderstanding(MATERIAL_ID, 1)?.map((item) => item.itemId)).toEqual(['it_1', 'it_2'])
  })

  it('读历史版本不回写当前列表；读当前版本会同步单份材料', async () => {
    const base = cloudRoutes({ project: project(), materials: [makeCloudMaterial()] })
    installFetch((url, init) => {
      if (url.includes(`/materials/${MATERIAL_ID}?`) || url.endsWith(`/materials/${MATERIAL_ID}`)) {
        const version = new URL(url, 'http://localhost').searchParams.get('version')
        if (version === '1') {
          return jsonResponse(
            readEnvelope(
              {
                material: makeCloudMaterial({
                  materialVersion: 1,
                  isCurrent: false,
                  readOnly: true,
                  name: '旧版实验手册.md',
                }),
              },
              PROJECT_ID,
              3,
            ),
          )
        }
        return jsonResponse(
          readEnvelope({ material: makeCloudMaterial({ name: '改名后的实验手册.md' }) }, PROJECT_ID, 3),
        )
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const history = await store.loadMaterialDetail(MATERIAL_ID, { version: 1 })
    expect(history.ok).toBe(true)
    expect(store.findMaterial(MATERIAL_ID)?.name).toBe('实验手册.md')

    const current = await store.loadMaterialDetail(MATERIAL_ID)
    expect(current.ok).toBe(true)
    expect(store.findMaterial(MATERIAL_ID)?.name).toBe('改名后的实验手册.md')
  })

  it('理解条目读取失败时记录 key 级错误，不写入空数组缓存', async () => {
    const base = cloudRoutes(fixture())
    installFetch((url, init) => {
      if (url.includes('/understanding')) {
        return jsonResponse({ contractVersion: '3.0', code: 'RESOURCE_NOT_FOUND', message: '不存在' }, 404)
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.loadMaterialUnderstanding(MATERIAL_ID)

    expect(result.ok).toBe(false)
    expect(store.materialReadError?.code).toBe('RESOURCE_NOT_FOUND')
    expect(store.cachedUnderstanding(MATERIAL_ID, 1)).toBeNull()
  })
})

describe('材料归档 / 恢复 / 重新解析', () => {
  function projectWithMaterial() {
    return {
      project: project(),
      materials: [makeCloudMaterial()],
      materialSegments: { [`${MATERIAL_ID}@1`]: [makeMaterialSegment()] },
      materialItems: { [`${MATERIAL_ID}@1`]: [makeUnderstandingItem({ status: 'confirmed' })] },
    }
  }

  it('归档后本地状态同步为 archived + readOnly，并推进项目版本', async () => {
    const base = cloudRoutes(projectWithMaterial())
    const bodies: Record<string, unknown>[] = []
    installFetch((url, init) => {
      if (url.includes(`/materials/${MATERIAL_ID}/archive`)) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return jsonResponse(
          echoEnvelope(
            init,
            { material: makeCloudMaterial({ status: 'archived', readOnly: true, archivedAt: '2026-10-22T00:00:00.000Z', revision: 2 }) },
            { projectId: PROJECT_ID, projectRevision: 4 },
          ),
        )
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const result = await store.archiveMaterial(MATERIAL_ID)

    expect(result.ok).toBe(true)
    expect(bodies[0]!['projectRevision']).toBe(3)
    expect(typeof bodies[0]!['idempotencyKey']).toBe('string')
    expect(store.findMaterial(MATERIAL_ID)?.status).toBe('archived')
    expect(store.findMaterial(MATERIAL_ID)?.readOnly).toBe(true)
    expect(store.sync.projectRevision).toBe(4)

    const again = await store.archiveMaterial(MATERIAL_ID)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('恢复归档材料后回到 parsed', async () => {
    const base = cloudRoutes(projectWithMaterial())
    installFetch((url, init) => {
      if (url.includes(`/materials/${MATERIAL_ID}/restore`)) {
        return jsonResponse(
          echoEnvelope(
            init,
            { material: makeCloudMaterial({ status: 'parsed', readOnly: false, revision: 3 }) },
            { projectId: PROJECT_ID, projectRevision: 4 },
          ),
        )
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    store.materials = [makeCloudMaterial({ status: 'archived', readOnly: true })]

    const result = await store.restoreMaterial(MATERIAL_ID)

    expect(result.ok).toBe(true)
    expect(store.findMaterial(MATERIAL_ID)?.status).toBe('parsed')
  })

  it('重新解析产生新版本：片段直接来自响应，旧版本的已确认条目不再沿用', async () => {
    const base = cloudRoutes(projectWithMaterial())
    installFetch((url, init) => {
      if (url.includes(`/materials/${MATERIAL_ID}/reparse`)) {
        return jsonResponse(
          echoEnvelope(
            init,
            {
              material: makeCloudMaterial({ materialVersion: 2, revision: 2 }),
              segments: [
                makeMaterialSegment({ materialVersion: 2, segmentId: 'seg_v2_0', text: '新版本正文' }),
              ],
              segmentCount: 1,
              deduplicated: false,
            },
            { projectId: PROJECT_ID, projectRevision: 4 },
          ),
        )
      }
      return base(url, init)
    })
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)
    await store.loadMaterialUnderstanding(MATERIAL_ID)
    await store.loadMaterialSegments(MATERIAL_ID)
    const before = store.buildConfirmedMaterialsContext()
    expect(before.ok).toBe(true)
    if (before.ok) expect(before.data).toHaveLength(1)

    const result = await store.reparseMaterial(MATERIAL_ID)

    expect(result.ok).toBe(true)
    expect(store.findMaterial(MATERIAL_ID)?.materialVersion).toBe(2)
    expect(store.cachedSegments(MATERIAL_ID, 2)?.map((segment) => segment.segmentId)).toEqual(['seg_v2_0'])
    // 新版本还没有理解条目 → 明确拒绝，而不是继续用旧版本的已确认内容
    const after = store.buildConfirmedMaterialsContext()
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.code).toBe('MATERIALS_NOT_AVAILABLE')
  })
})

describe('已确认材料上下文', () => {
  it('只把 confirmed 条目转成 confirmedMaterials', async () => {
    installFetch(
      cloudRoutes({
        project: project(),
        materials: [makeCloudMaterial()],
        materialSegments: {
          [`${MATERIAL_ID}@1`]: [
            makeMaterialSegment({ segmentId: 'seg_0', text: '已确认正文' }),
            makeMaterialSegment({ segmentId: 'seg_1', index: 1, text: '未确认正文' }),
          ],
        },
        materialItems: {
          [`${MATERIAL_ID}@1`]: [
            makeUnderstandingItem({ itemId: 'it_1', status: 'confirmed' }),
            makeUnderstandingItem({
              itemId: 'it_2',
              status: 'pending',
              sources: [
                {
                  materialId: MATERIAL_ID,
                  materialName: '实验手册.md',
                  materialVersion: 1,
                  segmentId: 'seg_1',
                  startLine: 4,
                  endLine: 6,
                },
              ],
            }),
          ],
        },
      }),
    )
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    // 还没读条目/片段：明确拒绝，而不是当成「没有已确认材料」
    const notLoaded = store.buildConfirmedMaterialsContext()
    expect(notLoaded.ok).toBe(false)
    if (!notLoaded.ok) expect(notLoaded.code).toBe('MATERIALS_NOT_AVAILABLE')

    await store.loadMaterialUnderstanding(MATERIAL_ID)
    await store.loadMaterialSegments(MATERIAL_ID)

    const confirmed = store.buildConfirmedMaterialsContext()
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(confirmed.data).toHaveLength(1)
    expect(JSON.stringify(confirmed.data)).toContain('已确认正文')
    expect(JSON.stringify(confirmed.data)).not.toContain('未确认正文')
  })

  it('没有材料时上下文是空数组（真实空，不是读取失败）', async () => {
    installFetch(cloudRoutes({ project: project(), materials: [] }))
    const store = useCloudStore()
    await store.openProject(PROJECT_ID)

    const confirmed = store.buildConfirmedMaterialsContext()

    expect(confirmed.ok).toBe(true)
    if (confirmed.ok) expect(confirmed.data).toEqual([])
  })
})
