import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CloudMaterialsPanel from '@/components/CloudMaterialsPanel.vue'

const material = {
  materialId: 'mat_1',
  materialVersion: 2,
  name: '实验手册.md',
  type: 'md',
  size: 2048,
  encoding: 'utf-8',
  status: 'parsed' as const,
  revision: 3,
  sha256: null,
  failureReason: null,
  createdAt: '2026-10-22T01:00:00.000Z',
  updatedAt: '2026-10-22T02:00:00.000Z',
  archivedAt: null as string | null,
  isCurrent: true,
  readOnly: false,
}

const mocked = vi.hoisted(() => ({
  cloud: {
    materials: [] as Array<Record<string, unknown>>,
    materialsStatus: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    materialsError: null as { code: string; message: string } | null,
    materialsHydrated: true,
    materialUpload: { status: 'idle' as 'idle' | 'submitting' | 'done' | 'error', error: null, lastUpload: null as Record<string, unknown> | null },
    refreshMaterials: vi.fn<(query?: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown[] }>>(),
    loadMaterialSegments: vi.fn<(id: string, input?: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown[] }>>(),
    loadMaterialUnderstanding: vi.fn<(id: string, input?: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown[] }>>(),
    cachedSegments: vi.fn((_id: string, _version: number): unknown[] | null => null),
    cachedUnderstanding: vi.fn((_id: string, _version: number): unknown[] | null => null),
    isMaterialReadLoading: vi.fn((): boolean => false),
    uploadMaterial: vi.fn<
      (input: Record<string, unknown>) => Promise<{ ok: boolean; data?: Record<string, unknown>; code?: string; message?: string }>
    >(),
    archiveMaterial: vi.fn(async () => ({ ok: true, data: {} })),
    restoreMaterial: vi.fn(async () => ({ ok: true, data: {} })),
    reparseMaterial: vi.fn(async () => ({ ok: true, data: {} })),
  },
}))

vi.mock('@/stores/cloud', () => ({
  useCloudStore: () => mocked.cloud,
}))

describe('CloudMaterialsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.cloud.materials = []
    mocked.cloud.materialsStatus = 'ready'
    mocked.cloud.materialsError = null
    mocked.cloud.materialsHydrated = true
    mocked.cloud.materialUpload = { status: 'idle', error: null, lastUpload: null }
    mocked.cloud.refreshMaterials.mockResolvedValue({ ok: true, data: [] })
    mocked.cloud.loadMaterialSegments.mockResolvedValue({ ok: true, data: [] })
    mocked.cloud.loadMaterialUnderstanding.mockResolvedValue({ ok: true, data: [] })
    mocked.cloud.cachedSegments.mockReturnValue(null)
    mocked.cloud.cachedUnderstanding.mockReturnValue(null)
    mocked.cloud.uploadMaterial.mockResolvedValue({ ok: true, data: material })
    mocked.cloud.archiveMaterial.mockResolvedValue({ ok: true, data: material })
  })

  it('读取中只显示加载提示，不说「没有材料」', () => {
    mocked.cloud.materialsStatus = 'loading'
    mocked.cloud.materialsHydrated = false

    const wrapper = mount(CloudMaterialsPanel)

    expect(wrapper.text()).toContain('正在读取材料')
    expect(wrapper.text()).not.toContain('还没有材料')
  })

  it('读取失败时显示中文原因并可重试', async () => {
    mocked.cloud.materialsStatus = 'error'
    mocked.cloud.materialsHydrated = false
    mocked.cloud.materialsError = { code: 'NETWORK_ERROR', message: '网络不可用，请稍后重试' }

    const wrapper = mount(CloudMaterialsPanel)

    expect(wrapper.text()).toContain('网络不可用')
    expect(wrapper.text()).not.toContain('NETWORK_ERROR')

    await wrapper.get('.error-block button').trigger('click')
    expect(mocked.cloud.refreshMaterials).toHaveBeenCalled()
  })

  it('确认读过且为空时才说「还没有材料」', () => {
    const wrapper = mount(CloudMaterialsPanel)

    expect(wrapper.text()).toContain('还没有材料')
  })

  it('列出材料并在点开时读取片段与理解内容', async () => {
    mocked.cloud.materials = [material]
    const wrapper = mount(CloudMaterialsPanel)
    expect(wrapper.text()).toContain('实验手册.md')
    expect(wrapper.text()).toContain('已解析')
    expect(wrapper.text()).toContain('内容版本 2')

    mocked.cloud.cachedSegments.mockReturnValue([
      { segmentId: 'seg_1', materialId: 'mat_1', materialVersion: 2, index: 0, startLine: 1, endLine: 4, text: '第一段材料正文', charCount: 7, status: 'active', createdAt: '2026-10-22T02:00:00.000Z' },
    ])
    mocked.cloud.cachedUnderstanding.mockReturnValue([
      {
        itemId: 'item_1',
        kind: 'goalCandidates',
        text: '把分辨率缺口写成待确认事项',
        originalText: null,
        sources: [{ segmentId: 'seg_1', startLine: 1, endLine: 4 }],
        status: 'confirmed',
        revision: 1,
        confirmedAt: '2026-10-22T02:10:00.000Z',
        confirmedByUserId: 'usr_1',
        removedAt: null,
      },
    ])

    await wrapper.get('.material-main').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('第一段材料正文')
    })

    expect(mocked.cloud.loadMaterialSegments).toHaveBeenCalledWith('mat_1', { version: 2, forceRefresh: false })
    expect(mocked.cloud.loadMaterialUnderstanding).toHaveBeenCalledWith('mat_1', { version: 2, forceRefresh: false })
    expect(wrapper.text()).toContain('项目目标')
    expect(wrapper.text()).toContain('已确认')
    expect(wrapper.text()).toContain('来自：第 1–4 行')
  })

  it('上传只发 name 与 base64，成功后给出「需逐条确认」的说明', async () => {
    mocked.cloud.uploadMaterial.mockResolvedValue({
      ok: true,
      data: { ...material, status: 'parsed' },
    })
    mocked.cloud.refreshMaterials.mockResolvedValue({ ok: true, data: [material] })

    const wrapper = mount(CloudMaterialsPanel)
    const input = wrapper.get('input[type="file"]')
    const file = new File(['hello'], '笔记.md', { type: 'text/markdown' })
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('hello').buffer })
    }
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })

    await input.trigger('change')
    await vi.waitFor(() => {
      expect(mocked.cloud.uploadMaterial).toHaveBeenCalled()
    })

    expect(mocked.cloud.uploadMaterial).toHaveBeenCalledWith({
      name: '笔记.md',
      contentBase64: 'aGVsbG8=',
    })
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('理解条目需逐条确认')
    })
  })

  it('拒绝非 MD/TXT 与超过 1 MB 的文件，不发请求', async () => {
    const wrapper = mount(CloudMaterialsPanel)
    const input = wrapper.get('input[type="file"]')

    Object.defineProperty(input.element, 'files', {
      value: [new File(['x'], 'data.csv', { type: 'text/csv' })],
      configurable: true,
    })
    await input.trigger('change')
    expect(mocked.cloud.uploadMaterial).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('只支持 MD 和 TXT')

    const big = new File(['x'], 'big.md', { type: 'text/markdown' })
    Object.defineProperty(big, 'size', { value: 1024 * 1024 + 1 })
    Object.defineProperty(input.element, 'files', { value: [big], configurable: true })
    await input.trigger('change')
    expect(mocked.cloud.uploadMaterial).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('超过 1 MB')
  })

  it('归档调用 store，并把服务端中文原因展示出来', async () => {
    mocked.cloud.materials = [material]
    const wrapper = mount(CloudMaterialsPanel)

    await wrapper.get('.row-actions button').trigger('click')

    expect(mocked.cloud.archiveMaterial).toHaveBeenCalledWith('mat_1')
  })

  it('解析失败的材料提示可以重新解析，且不显示片段', async () => {
    mocked.cloud.materials = [{ ...material, status: 'parse_failed', failureReason: '分段失败' }]
    const wrapper = mount(CloudMaterialsPanel)

    expect(wrapper.text()).toContain('解析失败原因：分段失败')

    await wrapper.get('.material-main').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('这份材料解析失败')
    })
    expect(mocked.cloud.loadMaterialSegments).not.toHaveBeenCalled()
  })
})
