/**
 * 云端 v3 链路真实联调（opt-in，仅 loopback）
 * ----------------------------------------------------------------------------
 * 验证目标（对应本次交付的验收项）：
 *   1. 材料四个读取接口 + cloud store 调用链在真实后端上可用；
 *   2. 云端建议/聊天按契约 23.x 发送 v3，并真的携带 milestoneContext；
 *   3. 跨项目/跨阶段的实体 ID 被服务端拒绝（400 INVALID_INPUT），客户端如实呈现；
 *   4. 聊天响应中的 citations 字段按契约解析（D15 前服务端返回空数组）。
 *
 * 与 v3LocalBackend.integration.test.ts 同一种装置：只有设置了
 * `V3_LOCAL_API_BASE_URL` 与 `V3_LOCAL_INVITE_CODE` 才会跑，普通 `npm test` 不包含本目录。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlatformStore } from '@/stores/platform'
import { useCloudStore } from '@/stores/cloud'
import {
  buildAdvisorChatRequest,
  buildAdvisorRequest,
} from '@/services/advisorApi'
import {
  getMaterial,
  listMaterials,
  listMaterialSegments,
  listMaterialUnderstanding,
} from '@/services/projectsApi'
import { buildEvidenceSnapshots, buildTaskSnapshots } from '@/domain/v3Advisor'
import { ADVISOR_CHAT_PROMPT_VERSION_V3, ADVISOR_V3_PROMPT_VERSION } from '@/domain/recommendation'
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
let milestoneId = ''
let taskId = ''
let materialId = ''
let otherProjectId = ''
let otherTaskId = ''

/** v3 请求体里不允许出现别的项目的数据 */
function advisorBodyFor(context: ReturnType<typeof cloud.buildAdvisorContext>) {
  if (!context.ok) throw new Error(`构造阶段上下文失败：${context.code}`)
  return buildAdvisorRequest({
    projectId,
    projectRevision: cloud.projectRevision,
    projectName: cloud.project?.name ?? '',
    currentMilestone: context.data.currentMilestone,
    tasks: buildTaskSnapshots(cloud.tasks, projectId),
    evidence: buildEvidenceSnapshots(cloud.evidence, projectId),
    doubts: [],
    projectProfile: null,
    confirmedMaterials: [],
    milestoneContext: context.data,
  })
}

async function postAdvisor(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await localRequest(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe.skipIf(!RUN)('云端 v3 链路（真实 HTTP，仅 loopback）', () => {
  beforeAll(() => {
    setActivePinia(createPinia())
    guard = installLocalFetchGuard()
    platform = usePlatformStore()
    cloud = useCloudStore()
  })

  afterAll(() => {
    guard?.uninstall()
    console.info(
      `[${TEST_MARKER}] advisor v3 联调数据（不会自动清理）：` + JSON.stringify({ projectId, otherProjectId }),
    )
  })

  it('注册并创建项目 / 阶段 / 任务 / 进展 / 证据', async () => {
    const register = await localRequest('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: '3.0',
        requestId: newRequestId(),
        idempotencyKey: `it-advisor-v3-register-${TEST_ACCOUNT}`,
        account: TEST_ACCOUNT,
        password: TEST_PASSWORD,
        displayName: 'v3 联调用户',
        inviteCode: INVITE_CODE,
      }),
    })
    expect(register.status, `注册失败：HTTP ${register.status}`).toBeLessThan(300)
    must(await platform.initialize(), '初始化会话')
    expect(platform.authStatus).toBe('authenticated')

    const created = must(
      await platform.createCloudProject({
        name: `[${TEST_MARKER}] advisor v3`,
        profile: {
          goal: '验证云端 v3 请求',
          expectedOutcome: '建议与聊天带上阶段上下文',
          memberNames: ['v3 联调用户'],
          researchPeriod: '2026-10',
          scope: '仅本地临时数据库',
          outOfScope: null,
        },
      }),
      '创建项目',
    )
    projectId = created.data.projectId
    must(await cloud.openProject(projectId), '打开项目')

    const milestone = must(
      await cloud.createMilestone({
        name: '数据获取与预处理',
        goal: '拿到可复现的样例数据',
        doneCriteria: '样例数据可下载，字段说明完整',
        status: 'active',
      }),
      '创建阶段',
    )
    milestoneId = milestone.data.milestoneId

    const task = must(
      await cloud.createTask({
        title: '跑通 ERA5 数据下载链路',
        doneCriteria: '下载一段样例数据并能读出关键变量',
        milestoneId,
        status: 'doing',
      }),
      '创建任务',
    )
    taskId = task.data.taskId

    must(
      await cloud.submitProgress({
        milestoneId,
        taskId,
        summary: '完成样例数据下载，确认了 4 个关键字段',
      }),
      '写入进展',
    )
    must(
      await cloud.createEvidence({
        taskId,
        milestoneId,
        didWhat: '下载了 2024 年 1 月的 ERA5 样例数据',
        foundWhat: '有效波高与风速字段完整，缺失率低于 1%',
      }),
      '写入证据',
    )
  })

  it('材料四个读取接口在真实后端可用（列表 / 单份 / 片段 / 理解条目）', async () => {
    const content = ['# 实验手册', '', '## 数据说明', '主要字段：有效波高、风速、时间、经纬度。', '', '## 步骤', '1. 下载样例数据', '2. 检查缺失率'].join('\n')
    const upload = await localRequest(`/api/projects/${projectId}/materials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: '3.0',
        requestId: newRequestId(),
        idempotencyKey: `it-material-upload-${projectId}`,
        projectId,
        projectRevision: cloud.projectRevision,
        name: '实验手册.md',
        contentBase64: Buffer.from(content, 'utf8').toString('base64'),
      }),
    })
    expect(upload.status, `上传材料失败：HTTP ${upload.status}`).toBeLessThan(300)
    const uploaded = (await upload.json()) as { data?: { material?: { materialId?: string } } }
    materialId = uploaded.data?.material?.materialId ?? ''
    expect(materialId).toMatch(/^mat_/)

    const rawList = await localRequest(`/api/projects/${projectId}/materials`)
    expect(rawList.status).toBe(200)

    const list = must(await listMaterials(projectId), 'listMaterials')
    expect(list.data.materials.map((item) => item.materialId)).toContain(materialId)
    const listed = list.data.materials.find((item) => item.materialId === materialId)!
    expect(listed.status).toBe('parsed')
    expect(listed.materialVersion).toBe(1)
    expect(listed.isCurrent).toBe(true)
    expect(typeof listed.revision).toBe('number')

    const one = must(await getMaterial(projectId, materialId), 'getMaterial')
    expect(one.data.material.materialId).toBe(materialId)
    expect(one.data.material.name).toBe('实验手册.md')

    const segments = must(await listMaterialSegments(projectId, materialId), 'listMaterialSegments')
    expect(segments.data.segments.length).toBeGreaterThan(0)
    expect(segments.data.segments[0]!.materialId).toBe(materialId)
    expect(typeof segments.data.segments[0]!.index).toBe('number')
    expect(typeof segments.data.segments[0]!.charCount).toBe('number')
    expect(segments.data.segments[0]!.startLine).toBeGreaterThanOrEqual(1)

    const understanding = must(
      await listMaterialUnderstanding(projectId, materialId),
      'listMaterialUnderstanding',
    )
    expect(Array.isArray(understanding.data.items)).toBe(true)

    // 上传后重新打开项目：projectRevision 与材料列表一起更新（页面同样按这个链路刷新）
    must(await cloud.openProject(projectId), '重新打开项目')
    expect(cloud.materials.map((item) => item.materialId)).toContain(materialId)
    expect(cloud.materialsHydrated).toBe(true)
    expect(cloud.materialsStatus).toBe('ready')
    // segments/understanding 走缓存，重复调用不会多发请求
    const before = guard?.requests.length ?? 0
    const cachedSegments = must(await cloud.loadMaterialSegments(materialId), 'store.loadMaterialSegments')
    expect(cachedSegments.data.length).toBe(segments.data.segments.length)
    must(await cloud.loadMaterialUnderstanding(materialId), 'store.loadMaterialUnderstanding')
    const after = guard?.requests.length ?? 0
    expect(after - before).toBe(2)
    must(await cloud.loadMaterialSegments(materialId), 'store.loadMaterialSegments（第二次）')
    expect(guard?.requests.length ?? 0).toBe(after)
  })

  it('云端建议按 v3 发送，服务端接受 milestoneContext', async () => {
    const context = cloud.buildAdvisorContext()
    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(context.data.milestoneId).toBe(milestoneId)
    expect(context.data.milestoneStatus).toBe('active')
    expect(context.data.milestoneTasks.map((item) => item.taskId)).toContain(taskId)

    const body = advisorBodyFor(context)
    expect(body.promptVersion).toBe(ADVISOR_V3_PROMPT_VERSION)
    expect(body.milestoneContext?.milestoneId).toBe(milestoneId)

    const result = await postAdvisor('/api/advisor/recommendations', body)
    expect(result.status, `建议接口 HTTP ${result.status} ${String(result.json['code'] ?? '')}`).toBe(200)
    expect(result.json['projectId']).toBe(projectId)
    expect(result.json['promptVersion']).toBe(ADVISOR_V3_PROMPT_VERSION)
    expect(['model', 'fallback']).toContain(result.json['source'])

    // store 链路（同一份上下文，走适配层与状态机）
    const viaStore = must(await cloud.refreshAdvisor(), 'cloud.refreshAdvisor')
    expect(['model', 'fallback']).toContain(viaStore.data.source)
    expect(cloud.advisor.contextAttached).toBe(true)
  })

  it('跨项目任务 ID 被服务端拒绝（400 INVALID_INPUT），客户端如实呈现', async () => {
    const created = must(
      await platform.createCloudProject({
        name: `[${TEST_MARKER}] advisor v3 干扰项目`,
        profile: {
          goal: '制造跨项目实体',
          expectedOutcome: '用于反向用例',
          memberNames: ['v3 联调用户'],
          researchPeriod: '2026-10',
          scope: null,
          outOfScope: null,
        },
      }),
      '创建干扰项目',
    )
    otherProjectId = created.data.projectId
    must(await cloud.openProject(otherProjectId), '打开干扰项目')
    const otherMilestone = must(
      await cloud.createMilestone({ name: '干扰阶段', status: 'active' }),
      '创建干扰阶段',
    )
    const otherTask = must(
      await cloud.createTask({
        title: '干扰任务',
        milestoneId: otherMilestone.data.milestoneId,
        status: 'doing',
      }),
      '创建干扰任务',
    )
    otherTaskId = otherTask.data.taskId
    expect(otherTaskId).not.toBe(taskId)

    // 回到主项目，构造一份「上下文里有别的项目任务」的请求
    must(await cloud.openProject(projectId), '回到主项目')
    const context = cloud.buildAdvisorContext()
    if (!context.ok) throw new Error(`构造阶段上下文失败：${context.code}`)
    const tampered = {
      ...context.data,
      milestoneTasks: [
        ...context.data.milestoneTasks,
        {
          taskId: otherTaskId,
          title: '干扰任务',
          status: 'doing' as const,
          doneCriteria: null,
          owner: null,
          milestone: '干扰阶段',
          updatedAt: new Date().toISOString(),
        },
      ],
    }
    const body = advisorBodyFor({ ok: true, data: tampered })

    const result = await postAdvisor('/api/advisor/recommendations', body)

    expect(result.status).toBe(400)
    expect(result.json['code']).toBe('INVALID_INPUT')
    expect(String(result.json['message'] ?? '')).toContain('任务')
  })

  it('聊天按 advisor-chat-v3 发送并解析 citations', async () => {
    const context = cloud.buildAdvisorContext()
    if (!context.ok) throw new Error(`构造阶段上下文失败：${context.code}`)
    const request = buildAdvisorChatRequest({
      projectId,
      projectRevision: cloud.projectRevision,
      projectName: cloud.project?.name ?? '',
      currentMilestone: context.data.currentMilestone,
      tasks: buildTaskSnapshots(cloud.tasks, projectId),
      evidence: buildEvidenceSnapshots(cloud.evidence, projectId),
      doubts: [],
      question: '当前阶段下一步先做什么？',
      chatHistory: [],
      projectProfile: null,
      confirmedMaterials: [],
      milestoneContext: context.data,
    })
    expect(request.promptVersion).toBe(ADVISOR_CHAT_PROMPT_VERSION_V3)

    const result = await postAdvisor('/api/advisor/chat', request)

    expect(result.status, `聊天接口 HTTP ${result.status} ${String(result.json['code'] ?? '')}`).toBe(200)
    expect(typeof result.json['answer']).toBe('string')
    // D15 之前服务端不产出引用，客户端必须能接受「缺失或空数组」
    const citations = result.json['citations']
    expect(citations === undefined || Array.isArray(citations)).toBe(true)
  })
})
