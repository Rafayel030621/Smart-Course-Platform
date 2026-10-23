import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getMaterial,
  listMaterials,
  listMaterialSegments,
  listMaterialUnderstanding,
} from '@/services/projectsApi'
import { installFetch, jsonResponse, makeCloudMaterial, makeMaterialSegment, makeUnderstandingItem, readEnvelope } from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const MATERIAL_ID = 'mat_1'

interface Captured {
  url: string
  method: string
}

function record(captured: Captured[], url: string, init: RequestInit): void {
  captured.push({ url, method: init.method ?? 'GET' })
}

function materialDto(overrides: Record<string, unknown> = {}) {
  const material = makeCloudMaterial()
  return {
    materialId: material.materialId,
    materialVersion: material.materialVersion,
    name: material.name,
    type: material.type,
    size: material.size,
    encoding: material.encoding,
    status: material.status,
    revision: material.revision,
    sha256: material.sha256,
    failureReason: material.failureReason,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
    archivedAt: material.archivedAt,
    isCurrent: material.isCurrent,
    readOnly: material.readOnly,
    ...overrides,
  }
}

function segmentDto(overrides: Record<string, unknown> = {}) {
  const segment = makeMaterialSegment()
  return {
    segmentId: segment.segmentId,
    materialId: segment.materialId,
    materialVersion: segment.materialVersion,
    index: segment.index,
    startLine: segment.startLine,
    endLine: segment.endLine,
    text: segment.text,
    charCount: segment.charCount,
    status: segment.status,
    createdAt: segment.createdAt,
    ...overrides,
  }
}

function itemDto(overrides: Record<string, unknown> = {}) {
  const item = makeUnderstandingItem()
  return {
    itemId: item.itemId,
    kind: item.kind,
    text: item.text,
    originalText: item.originalText,
    sources: item.sources,
    status: item.status,
    revision: item.revision,
    confirmedAt: item.confirmedAt,
    confirmedByUserId: item.confirmedByUserId,
    removedAt: item.removedAt,
    ...overrides,
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('材料列表（GET /api/projects/{id}/materials）', () => {
  it('默认只请求当前版本，解析 Material DTO 与 nextCursor', async () => {
    const captured: Captured[] = []
    installFetch((url, init) => {
      if (!url.includes(`/api/projects/${PROJECT_ID}/materials`)) return undefined
      record(captured, url, init)
      return jsonResponse(
        readEnvelope({ materials: [materialDto()], nextCursor: 'cursor_2' }, PROJECT_ID, 7),
      )
    })

    const result = await listMaterials(PROJECT_ID, { limit: 50 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(captured).toHaveLength(1)
    expect(captured[0]!.method).toBe('GET')
    expect(captured[0]!.url).toContain(`/api/projects/${PROJECT_ID}/materials?limit=50`)
    expect(result.data.nextCursor).toBe('cursor_2')
    expect(result.data.materials[0]).toEqual({
      materialId: MATERIAL_ID,
      materialVersion: 1,
      name: '实验手册.md',
      type: 'md',
      size: 2048,
      encoding: 'utf-8',
      status: 'parsed',
      revision: 1,
      sha256: null,
      failureReason: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      archivedAt: null,
      isCurrent: true,
      readOnly: false,
    })
  })

  it('includeArchived / cursor 进入查询串；空 nextCursor 视为最后一页', async () => {
    const captured: Captured[] = []
    installFetch((url, init) => {
      record(captured, url, init)
      return jsonResponse(readEnvelope({ materials: [], nextCursor: null }, PROJECT_ID, 7))
    })

    const result = await listMaterials(PROJECT_ID, { includeArchived: true, cursor: 'c1' })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.nextCursor).toBeNull()
    expect(captured[0]!.url).toContain('includeArchived=true')
    expect(captured[0]!.url).toContain('cursor=c1')
  })

  it('缺少必需字段时整份丢弃（INVALID_RESPONSE），不写入猜测值', async () => {
    installFetch(() =>
      jsonResponse(readEnvelope({ materials: [{ materialId: 'mat_1' }], nextCursor: null }, PROJECT_ID, 7)),
    )

    const result = await listMaterials(PROJECT_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_RESPONSE')
  })

  it('服务端 404 映射为契约错误码', async () => {
    installFetch(() =>
      jsonResponse({ contractVersion: '3.0', code: 'PROJECT_NOT_FOUND', message: '项目不存在' }, 404),
    )

    const result = await listMaterials('prj_missing')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND')
  })
})

describe('单份材料（GET .../materials/{materialId}）', () => {
  it('version 进入查询串，历史版本 readOnly/isCurrent 原样返回', async () => {
    const captured: Captured[] = []
    installFetch((url, init) => {
      record(captured, url, init)
      return jsonResponse(
        readEnvelope(
          {
            material: materialDto({ materialVersion: 1, isCurrent: false, readOnly: true }),
          },
          PROJECT_ID,
          7,
        ),
      )
    })

    const result = await getMaterial(PROJECT_ID, MATERIAL_ID, { version: 1 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.material.materialVersion).toBe(1)
      expect(result.data.material.readOnly).toBe(true)
    }
    expect(captured[0]!.url).toContain(`/api/projects/${PROJECT_ID}/materials/${MATERIAL_ID}?version=1`)
  })

  it('响应返回其它 materialId 时视为串包', async () => {
    installFetch(() =>
      jsonResponse(readEnvelope({ material: materialDto({ materialId: 'mat_other' }) }, PROJECT_ID, 7)),
    )

    const result = await getMaterial(PROJECT_ID, MATERIAL_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_RESPONSE')
  })
})

describe('材料片段（GET .../segments）', () => {
  it('解析 index/charCount/status，并拒绝混入其它版本的片段', async () => {
    installFetch(() =>
      jsonResponse(
        readEnvelope(
          {
            materialId: MATERIAL_ID,
            materialVersion: 1,
            isCurrent: true,
            readOnly: false,
            segments: [
              segmentDto({ segmentId: 'seg_0', index: 0 }),
              segmentDto({ segmentId: 'seg_1', index: 1, startLine: 4, endLine: 6 }),
            ],
            nextCursor: null,
          },
          PROJECT_ID,
          7,
        ),
      ),
    )

    const ok = await listMaterialSegments(PROJECT_ID, MATERIAL_ID)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.data.segments.map((segment) => segment.segmentId)).toEqual(['seg_0', 'seg_1'])
      expect(ok.data.segments[1]!.index).toBe(1)
      expect(ok.data.readOnly).toBe(false)
    }

    installFetch(() =>
      jsonResponse(
        readEnvelope(
          {
            materialId: MATERIAL_ID,
            materialVersion: 2,
            isCurrent: true,
            readOnly: false,
            segments: [segmentDto({ materialVersion: 1 })],
            nextCursor: null,
          },
          PROJECT_ID,
          7,
        ),
      ),
    )
    const mixed = await listMaterialSegments(PROJECT_ID, MATERIAL_ID)
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(mixed.error.code).toBe('INVALID_RESPONSE')
  })
})

describe('材料理解条目（GET .../understanding）', () => {
  it('解析 sources（服务端回填的真实行号）与 status', async () => {
    installFetch(() =>
      jsonResponse(
        readEnvelope(
          {
            materialId: MATERIAL_ID,
            materialVersion: 1,
            isCurrent: true,
            readOnly: false,
            items: [itemDto({ status: 'confirmed' })],
            nextCursor: null,
          },
          PROJECT_ID,
          7,
        ),
      ),
    )

    const result = await listMaterialUnderstanding(PROJECT_ID, MATERIAL_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.items).toHaveLength(1)
    expect(result.data.items[0]!.status).toBe('confirmed')
    expect(result.data.items[0]!.sources[0]).toEqual({
      materialId: MATERIAL_ID,
      materialName: '实验手册.md',
      materialVersion: 1,
      segmentId: 'seg_0',
      startLine: 1,
      endLine: 3,
    })
  })

  it('未知 kind 或来源指向其它材料时整份丢弃', async () => {
    installFetch(() =>
      jsonResponse(
        readEnvelope(
          {
            materialId: MATERIAL_ID,
            materialVersion: 1,
            isCurrent: true,
            readOnly: false,
            items: [itemDto({ kind: 'unknownKind' })],
            nextCursor: null,
          },
          PROJECT_ID,
          7,
        ),
      ),
    )
    const unknownKind = await listMaterialUnderstanding(PROJECT_ID, MATERIAL_ID)
    expect(unknownKind.ok).toBe(false)

    installFetch(() =>
      jsonResponse(
        readEnvelope(
          {
            materialId: MATERIAL_ID,
            materialVersion: 1,
            isCurrent: true,
            readOnly: false,
            items: [
              itemDto({
                sources: [
                  {
                    materialId: 'mat_other',
                    materialName: '其它.md',
                    materialVersion: 1,
                    segmentId: 'seg_0',
                    startLine: 1,
                    endLine: 2,
                  },
                ],
              }),
            ],
            nextCursor: null,
          },
          PROJECT_ID,
          7,
        ),
      ),
    )
    const crossMaterial = await listMaterialUnderstanding(PROJECT_ID, MATERIAL_ID)
    expect(crossMaterial.ok).toBe(false)
    if (!crossMaterial.ok) expect(crossMaterial.error.code).toBe('INVALID_RESPONSE')
  })
})
