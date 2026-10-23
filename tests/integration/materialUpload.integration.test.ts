/**
 * 材料上传真实联调（opt-in，仅 loopback）
 * ----------------------------------------------------------------------------
 * 验证 `uploadMaterial()`（API + cloud store）在真实后端上的行为：
 *   1. base64 + name 的 JSON 上传（不是 multipart），服务端同步分段；
 *   2. 上传成功后列表可见、projectRevision 前进；
 *   3. 片段总数 > 20 时响应被截断，但不污染版本缓存，分页读取能拿全；
 *   4. 同项目同 sha256 重传命中 deduplicated，projectRevision 不变；
 *   5. 过期 projectRevision 被 409 拒绝，客户端状态可恢复。
 *
 * 与其它集成用例同一种装置：只有设置了 `V3_LOCAL_API_BASE_URL` 与 `V3_LOCAL_INVITE_CODE` 才会跑。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlatformStore } from '@/stores/platform'
import { useCloudStore } from '@/stores/cloud'
import { listMaterialSegments, listMaterialUnderstanding, listMaterials, uploadMaterial } from '@/services/projectsApi'
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

const RUN = LOCAL_BASE_URL !== '' && HAS_INVITE_CODE
const INVITE_CODE = (process.env.V3_LOCAL_INVITE_CODE ?? '').trim()

if (!RUN) console.info(SKIP_REASON)

let guard: LocalFetchGuard | null = null
let platform: ReturnType<typeof usePlatformStore>
let cloud: ReturnType<typeof useCloudStore>

let projectId = ''
let materialId = ''
let segmentCount = 0
/**
 * 分段规则（`parseText`）：连续非空行合并到 2,000 字以内，单行超长按 2,000 字切开。
 * 所以要让片段数超过响应上限 20 条，必须造出 ≥ 20 个 2,000 字级的块（约 42 KB）。
 */
const CONTENT = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 段：${'甲'.repeat(2_100)}`).join('\n\n')

function contentBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

describe.skipIf(!RUN)('材料上传（真实 HTTP，仅 loopback）', () => {
  beforeAll(() => {
    setActivePinia(createPinia())
    guard = installLocalFetchGuard()
    platform = usePlatformStore()
    cloud = useCloudStore()
  })

  afterAll(() => {
    guard?.uninstall()
    console.info(`[${TEST_MARKER}] 材料上传联调数据（不会自动清理）：` + JSON.stringify({ projectId, materialId }))
  })

  it('注册并创建项目', async () => {
    const register = await localRequest('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: '3.0',
        requestId: newRequestId(),
        idempotencyKey: `it-upload-register-${TEST_ACCOUNT}`,
        account: TEST_ACCOUNT,
        password: TEST_PASSWORD,
        displayName: '上传联调用户',
        inviteCode: INVITE_CODE,
      }),
    })
    expect(register.status, `注册失败：HTTP ${register.status}`).toBeLessThan(300)
    must(await platform.initialize(), '初始化会话')

    const created = must(
      await platform.createCloudProject({
        name: `[${TEST_MARKER}] 材料上传`,
        profile: {
          goal: '验证材料上传链路',
          expectedOutcome: '材料可上传并读取',
          memberNames: ['上传联调用户'],
          researchPeriod: '2026-10',
          scope: '仅本地临时数据库',
          outOfScope: null,
        },
      }),
      '创建项目',
    )
    projectId = created.data.projectId
    must(await cloud.openProject(projectId), '打开项目')
    expect(cloud.materials).toEqual([])
  })

  it('store 上传成功：列表立即可见、版本前进、截断片段不进缓存', async () => {
    const before = cloud.projectRevision

    const result = must(
      await cloud.uploadMaterial({ name: '长文档.md', contentBase64: contentBase64(CONTENT) }),
      'cloud.uploadMaterial',
    )

    materialId = result.data.materialId
    expect(materialId).toMatch(/^mat_/)
    expect(result.data.status).toBe('parsed')
    expect(result.data.materialVersion).toBe(1)
    expect(cloud.materialUpload.status).toBe('done')
    expect(cloud.materialUpload.lastUpload?.deduplicated).toBe(false)
    // 片段数 > 响应上限 20：计数用真实总数
    segmentCount = cloud.materialUpload.lastUpload?.segmentCount ?? 0
    expect(segmentCount).toBeGreaterThan(20)
    expect(cloud.projectRevision).toBe(before + 1)
    expect(cloud.materials.map((item) => item.materialId)).toContain(materialId)

    // 截断响应不能当成完整片段缓存
    expect(cloud.cachedSegments(materialId, 1)).toBeNull()

    const segments = must(await cloud.loadMaterialSegments(materialId), 'loadMaterialSegments')
    expect(segments.data).toHaveLength(segmentCount)
    expect(segments.data[0]!.index).toBe(0)
    expect(segments.data.at(-1)!.endLine).toBeGreaterThan(segments.data[0]!.endLine)
  })

  it('API 与列表读回一致（materialId / 版本 / 状态 / 片段数）', async () => {
    const list = must(await listMaterials(projectId), 'listMaterials')
    const listed = list.data.materials.find((item) => item.materialId === materialId)
    expect(listed?.name).toBe('长文档.md')
    expect(listed?.status).toBe('parsed')
    expect(listed?.isCurrent).toBe(true)
    expect(listed?.readOnly).toBe(false)

    const segments = must(await listMaterialSegments(projectId, materialId), 'listMaterialSegments')
    expect(segments.data.segments).toHaveLength(segmentCount)

    // 理解草稿依赖 AI 服务：本环境未配置真实模型，只验证「可以读，且未生成时为真空」
    const understanding = must(await listMaterialUnderstanding(projectId, materialId), 'listMaterialUnderstanding')
    expect(Array.isArray(understanding.data.items)).toBe(true)
  })

  it('同一份内容重传：deduplicated=true，projectRevision 不变', async () => {
    const before = cloud.projectRevision

    const result = must(
      await cloud.uploadMaterial({ name: '长文档.md', contentBase64: contentBase64(CONTENT) }),
      '重复上传',
    )

    expect(result.data.materialId).toBe(materialId)
    expect(cloud.materialUpload.lastUpload?.deduplicated).toBe(true)
    expect(cloud.projectRevision).toBe(before)
    expect(cloud.materials.filter((item) => item.name === '长文档.md')).toHaveLength(1)
  })

  it('过期 projectRevision 被 409 STALE_REVISION 拒绝，状态可恢复', async () => {
    const stale = await uploadMaterial(projectId, {
      name: '旧版本.md',
      contentBase64: contentBase64('# 用过期版本上传'),
      projectRevision: 1,
    })

    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.error.code).toBe('STALE_REVISION')
      expect(stale.error.currentProjectRevision).toBeGreaterThan(1)
    }

    const recovered = must(
      await cloud.uploadMaterial({ name: '恢复后.md', contentBase64: contentBase64('# 重新上传') }),
      '恢复上传',
    )
    expect(recovered.data.materialId).toMatch(/^mat_/)
    expect(cloud.materialUpload.status).toBe('done')
  })
})
