import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { TOPICS } from '@/data/topics'
import type { Project, UnderstandingDraft } from '@/types/platform'
import { useWorkbenchStore } from '@/stores/workbench'
import { buildConfirmedContext, buildConfirmedMaterials } from '@/domain/materials'

/**
 * v2 store action（契约 13 / 14 / 6.4）
 * ----------------------------------------------------------------------------
 * 覆盖五件事：
 *   1. 项目基本信息保存后刷新不丢；
 *   2. 材料登记 / 重传的版本与 revision 语义；
 *   3. 理解草稿的确认 / 修改 / 撤销确认 / 删除 / 整份确认；
 *   4. 未确认（含已修改未确认）的草稿绝不进入建议与聊天请求字段；
 *   5. 聊天链路走 `/api/advisor/chat` + `advisor-chat-v2`，失败有中文兜底。
 */

type Store = ReturnType<typeof useWorkbenchStore>

function newStore(): Store {
  setActivePinia(createPinia())
  return useWorkbenchStore()
}

function withProject(): Store {
  const store = newStore()
  const created = store.createProject({ topicId: TOPICS[0], members: 3 })
  expect(created.ok).toBe(true)
  return store
}

function project(store: Store): Project {
  const current = store.current
  if (current === undefined) throw new Error('没有当前项目')
  return current
}

function revision(store: Store): number {
  return project(store).projectRevision
}

/** 登记一份 .md 材料，返回 materialId */
function registerMd(store: Store, name = '实验手册.md', segments = 1): string {
  const result = store.registerMaterial({
    name,
    size: 2048,
    segments: Array.from({ length: segments }, (_, index) => ({
      segmentId: `seg_${index}`,
      index,
      startLine: index + 1,
      endLine: index + 1,
      text: `第 ${index} 段正文`,
    })),
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.data.materialId
}

function draftFor(materialId: string, text = '复现极端风浪事件的识别流程'): UnderstandingDraft {
  return {
    goalCandidates: [
      {
        itemId: 'cnd_goal_0',
        text,
        sources: [
          {
            materialId,
            materialName: '实验手册.md',
            materialVersion: 1,
            segmentId: 'seg_0',
            startLine: 1,
            endLine: 1,
          },
        ],
      },
    ],
    outcomeCandidates: [],
    dataNotes: [],
    methodNotes: [],
    openQuestions: [],
  }
}

/** 用一份固定的回答桩替换全局 fetch，并返回捕获到的请求体 */
function stubChatFetch(options: { ok?: boolean; revisionDelta?: number } = {}) {
  const captured: Record<string, unknown>[] = []

  const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    captured.push(body)

    if (options.ok === false) throw new TypeError('Failed to fetch')

    return new Response(
      JSON.stringify({
        contractVersion: '1.0',
        requestId: body.requestId,
        projectId: body.projectId,
        projectRevision: Number(body.projectRevision) + (options.revisionDelta ?? 0),
        promptVersion: body.promptVersion,
        source: 'model',
        fallbackReason: null,
        answer: '先把研究海区定下来，再决定是否需要多尺度数据。',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })

  vi.stubGlobal('fetch', fetchStub)
  return { captured, fetchStub }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

/* -------------------------------------------------------- 项目基本信息 */

describe('updateProjectProfile（契约 13.1 / 2.6）', () => {
  it('保存目标、预期结果、成员与研究周期，刷新后仍在', () => {
    const store = withProject()
    const before = revision(store)

    const saved = store.updateProjectProfile({
      goal: '构建极端风浪事件识别与预警的原型系统',
      expectedOutcome: '可交互原型 + 4 页会议论文',
      memberNames: ['张同学', '李同学'],
      researchPeriod: '第 3 周至第 14 周',
      scope: '先做西北太平洋',
      outOfScope: null,
    })

    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.data.projectRevision).toBe(before + 1)
    expect(store.basicInfo.goal).toBe('构建极端风浪事件识别与预警的原型系统')
    expect(store.basicInfo.memberNames).toEqual(['张同学', '李同学'])
    expect(store.basicInfo.outOfScope).toBeNull()
    // 契约 13.2：有内容时才出现在请求字段里
    expect(store.projectProfile?.goal).toBe('构建极端风浪事件识别与预警的原型系统')

    // 刷新：新建 pinia 后从 localStorage 恢复
    const restored = newStore()
    expect(restored.basicInfo.goal).toBe('构建极端风浪事件识别与预警的原型系统')
    expect(restored.basicInfo.researchPeriod).toBe('第 3 周至第 14 周')
  })

  it('updateProjectBasicInfo 是同一个 action 的兼容别名', () => {
    const store = withProject()
    const before = revision(store)
    const saved = store.updateProjectBasicInfo({ goal: '一句话目标' })
    expect(saved.ok).toBe(true)
    expect(revision(store)).toBe(before + 1)
    expect(store.basicInfo.goal).toBe('一句话目标')
  })

  it('内容没变化时不递增 projectRevision', () => {
    const store = withProject()
    const input = { goal: '一句话目标' }
    store.updateProjectProfile(input)
    const after = revision(store)
    store.updateProjectProfile(input)
    expect(revision(store)).toBe(after)
  })

  it('超出长度上限返回 INVALID_INPUT，且不改状态、不递增版本', () => {
    const store = withProject()
    const before = revision(store)

    const failed = store.updateProjectProfile({ goal: 'x'.repeat(301) })

    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('INVALID_INPUT')
    expect(revision(store)).toBe(before)
    expect(store.basicInfo.goal).toBeNull()
  })

  it('写入失败时回滚内存状态（STORAGE_FULL）', () => {
    const store = withProject()
    const original = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      value: {
        ...original,
        setItem: (): void => {
          throw new Error('QuotaExceededError')
        },
      },
      configurable: true,
    })

    try {
      const failed = store.updateProjectProfile({ goal: '临时目标' })
      expect(failed.ok).toBe(false)
      if (!failed.ok) expect(failed.code).toBe('STORAGE_FULL')
      // 内存态也必须回滚，避免「内存里有、刷新后没了」
      expect(store.basicInfo.goal).toBeNull()
    } finally {
      Object.defineProperty(window, 'localStorage', { value: original, configurable: true })
    }
  })
})

/* --------------------------------------------------------------- 材料 */

describe('registerMaterial（契约 14.1 / 14.2 / 2.6）', () => {
  it('首次登记生成 mat_ 前缀 ID、version 1，片段自带归属字段', () => {
    const store = withProject()
    const before = revision(store)

    const materialId = registerMd(store)

    expect(materialId.startsWith('mat_')).toBe(true)
    expect(revision(store)).toBe(before + 1)
    expect(store.materials).toHaveLength(1)
    expect(store.materials[0].version).toBe(1)
    expect(store.materials[0].needsReupload).toBe(false)

    // 页面读的扁平片段列表：每条都能直接拿到 materialId / materialVersion
    expect(store.materialSegments).toHaveLength(1)
    expect(store.materialSegments[0].materialId).toBe(materialId)
    expect(store.materialSegments[0].materialVersion).toBe(1)
    expect(store.materialReadStateMap[materialId]).toBe('registered')
  })

  it('非 md / txt 文件被拒绝（契约 15.1 白名单）', () => {
    const store = withProject()
    const failed = store.registerMaterial({ name: '数据.csv' })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('INVALID_INPUT')
    expect(store.materials).toHaveLength(0)
  })

  it('同名重传时 version +1，旧片段与旧版本草稿一律作废（契约 14.5）', () => {
    const store = withProject()
    const materialId = registerMd(store)
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    expect(store.pendingUnderstandingBlocks).toHaveLength(1)

    const again = store.registerMaterial({
      materialId,
      name: '实验手册.md',
      size: 4096,
      segments: [{ segmentId: 'seg_0', index: 0, startLine: 1, endLine: 2, text: '新版正文' }],
    })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.data.version).toBe(2)
    expect(again.data.updated).toBe(true)
    expect(store.materials[0].version).toBe(2)
    expect(store.materialSegments).toHaveLength(1)
    expect(store.materialSegments[0].materialVersion).toBe(2)
    expect(project(store).understandingBlocks).toHaveLength(0)
  })

  it('材料 id 属于另一个项目时返回 PROJECT_MISMATCH', () => {
    const store = withProject()
    const materialId = registerMd(store)
    store.createProject({ topicId: TOPICS[1], members: 3 })

    const failed = store.registerMaterial({ materialId, name: '别的.md' })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('PROJECT_MISMATCH')
  })

  it('解析失败的材料标记为待重新上传，且不保留片段', () => {
    const store = withProject()
    const failed = store.registerMaterial({
      name: '乱码.md',
      state: 'parse_failed',
      failureReason: '文件编码无法识别（已尝试 UTF-8 与 GBK）',
    })

    expect(failed.ok).toBe(true)
    expect(store.materials[0].needsReupload).toBe(true)
    expect(store.materialSegments).toHaveLength(0)
    expect(store.toastText).toContain('解析失败')
  })

  it('登记成功后有明确的状态反馈', () => {
    const store = withProject()
    registerMd(store)
    expect(store.toastText).toContain('实验手册.md')
    expect(store.toastText).toContain('1 段')
  })

  it('写盘失败时回滚：不产生材料记录、不报成功、项目仍可用（契约 3.1）', () => {
    const store = withProject()
    const before = revision(store)
    const original = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      value: {
        ...original,
        setItem: (): void => {
          throw new Error('QuotaExceededError')
        },
      },
      configurable: true,
    })

    try {
      const failed = store.registerMaterial({
        name: '实验手册.md',
        segments: [{ segmentId: 'seg_0', index: 0, startLine: 1, endLine: 1, text: '正文' }],
      })

      expect(failed.ok).toBe(false)
      if (!failed.ok) expect(failed.code).toBe('STORAGE_FULL')
      // 内存态必须回滚，否则刷新后材料就"消失"了
      expect(store.materials).toHaveLength(0)
      expect(store.materialSegments).toHaveLength(0)
      expect(revision(store)).toBe(before)
      // 不能出现"保存成功"的反馈
      expect(store.toastText).not.toContain('可生成理解草稿')
    } finally {
      Object.defineProperty(window, 'localStorage', { value: original, configurable: true })
    }

    // 存储恢复后项目仍可正常使用
    expect(store.basicInfo.goal).toBeNull()
    expect(store.updateProjectProfile({ goal: '新目标' }).ok).toBe(true)
  })
})

/* ----------------------------------------------------------- 理解草稿 */

describe('recordUnderstanding（契约 14.3 / 15.3）', () => {
  it('写入草稿条目本身不递增版本（契约 2.6）；重复写入同一份草稿也不递增', () => {
    const store = withProject()
    const materialId = registerMd(store)
    const before = revision(store)

    const first = store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.blockCount).toBe(1)
    // 契约 2.6 / 14.5 的 +1 事件只有材料登记与草稿的确认 / 修改 / 删除 / 整份确认
    expect(revision(store)).toBe(before)

    const block = store.pendingUnderstandingBlocks[0]
    expect(block.status).toBe('pending')
    expect(block.kind).toBe('goalCandidates')
    expect(block.content).toBe('复现极端风浪事件的识别流程')
    expect(block.id).toBe(`${materialId}::goalCandidates::cnd_goal_0`)

    // 幂等
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    expect(revision(store)).toBe(before)
  })

  it('重新生成草稿的策略（当前实现的特征，决策项见交接文档 §10.4）', () => {
    const store = withProject()
    const materialId = registerMd(store)

    // 第一轮：两条候选（目标 + 待确认问题），学生确认了目标那条
    const first = draftFor(materialId)
    first.openQuestions = [
      { itemId: 'cnd_q_0', text: '数据规模还没定', sources: first.goalCandidates[0].sources },
    ]
    expect(store.recordUnderstanding({ materialId, materialVersion: 1, draft: first }).ok).toBe(true)
    const confirmedId = store.pendingUnderstandingBlocks.find((block) => block.kind === 'goalCandidates')!.id
    expect(store.confirmUnderstandingBlock({ blockId: confirmedId }).ok).toBe(true)
    expect(store.confirmedUnderstandingBlocks).toHaveLength(1)

    // 第二轮：同一材料同一版本重新生成 —— 目标候选文案未变、问题候选不再返回、新增一条数据说明
    const second = draftFor(materialId)
    second.dataNotes = [
      { itemId: 'cnd_data_0', text: '字段包含有效波高', sources: second.goalCandidates[0].sources },
    ]
    expect(store.recordUnderstanding({ materialId, materialVersion: 1, draft: second }).ok).toBe(true)

    const blocks = project(store).understandingBlocks
    // ① 文案逐字未变的已确认条目：保持 confirmed
    expect(store.confirmedUnderstandingBlocks.map((block) => block.id)).toEqual([confirmedId])
    // ② 服务端这次没再返回的条目：从本地移除（"整份替换"，服务端才是草稿的来源）
    expect(blocks.some((block) => block.itemId === 'cnd_q_0')).toBe(false)
    // ③ 新候选是 pending，不会因为"重新生成"就变成已确认
    expect(store.pendingUnderstandingBlocks.map((block) => block.itemId)).toEqual(['cnd_data_0'])
  })

  it('重新生成后同一 itemId 的文案变了：退回待确认，不把学生没看过的新文案当已确认发出去', () => {
    const store = withProject()
    const materialId = registerMd(store)

    expect(
      store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) }).ok,
    ).toBe(true)
    const blockId = store.pendingUnderstandingBlocks[0].id
    store.confirmUnderstandingBlock({ blockId })
    expect(store.confirmedUnderstandingBlocks).toHaveLength(1)

    // 服务端重新生成，items 位置不变但文案换了（itemId 是按块内序号生成的，不代表同一个候选）
    store.recordUnderstanding({
      materialId,
      materialVersion: 1,
      draft: draftFor(materialId, '换成了另一条完全不同的目标表述'),
    })

    expect(store.confirmedUnderstandingBlocks).toHaveLength(0)
    expect(store.pendingUnderstandingBlocks).toHaveLength(1)
    expect(buildConfirmedMaterials(project(store))).toEqual([])
    expect(buildConfirmedContext(project(store))).toEqual([])
  })

  it('正文为空、来源被剔除、来源属于旧版本的候选都整条丢弃', () => {
    const store = withProject()
    const materialId = registerMd(store)

    const draft = draftFor(materialId)
    const source = draft.goalCandidates[0].sources[0]
    draft.goalCandidates.push(
      { itemId: 'cnd_empty', text: '   ', sources: [source] },
      { itemId: 'cnd_no_source', text: '有文本没来源', sources: [] },
      {
        itemId: 'cnd_other_material',
        text: '来源属于别的材料',
        sources: [{ ...source, materialId: 'mat_other' }],
      },
      { itemId: 'cnd_old_version', text: '来源是旧版本', sources: [{ ...source, materialVersion: 2 }] },
    )

    store.recordUnderstanding({ materialId, materialVersion: 1, draft })
    expect(store.pendingUnderstandingBlocks.map((block) => block.itemId)).toEqual(['cnd_goal_0'])
  })

  it('同文案换来源：退回待确认，新来源片段不进入请求字段，且版本递增（确认集合变了）', () => {
    const store = withProject()
    const materialId = registerMd(store, '实验手册.md', 2)
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    const blockId = store.pendingUnderstandingBlocks[0].id
    expect(store.confirmUnderstandingBlock({ blockId }).ok).toBe(true)
    expect(buildConfirmedMaterials(project(store))).toHaveLength(1)
    const afterConfirm = revision(store)

    // 同 itemId、同文案，但来源换成另一段：不是学生确认过的那一条
    const regenerated = draftFor(materialId)
    regenerated.goalCandidates[0].sources = [
      {
        materialId,
        materialName: '实验手册.md',
        materialVersion: 1,
        segmentId: 'seg_1',
        startLine: 2,
        endLine: 2,
      },
    ]
    expect(store.recordUnderstanding({ materialId, materialVersion: 1, draft: regenerated }).ok).toBe(true)

    expect(store.confirmedUnderstandingBlocks).toHaveLength(0)
    expect(store.pendingUnderstandingBlocks.map((block) => block.sources[0]?.segmentId)).toEqual(['seg_1'])
    // 两条请求字段里都不能再出现这条内容
    expect(buildConfirmedMaterials(project(store))).toEqual([])
    expect(buildConfirmedContext(project(store))).toEqual([])
    // 已确认集合变化 → projectRevision 必须递增（在途旧响应随之失效）
    expect(revision(store)).toBe(afterConfirm + 1)
  })

  it('同文案、同来源重新生成：保持已确认，且不递增版本', () => {
    const store = withProject()
    const materialId = registerMd(store, '实验手册.md', 2)
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    const blockId = store.pendingUnderstandingBlocks[0].id
    store.confirmUnderstandingBlock({ blockId })
    const afterConfirm = revision(store)

    // 同一条候选（同 itemId / 同文案 / 同来源、材料版本一致）再次返回
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })

    expect(store.confirmedUnderstandingBlocks.map((block) => block.id)).toEqual([blockId])
    expect(revision(store)).toBe(afterConfirm)
  })

  it('空草稿（fallback）不覆盖已确认内容，也不递增版本', () => {
    const store = withProject()
    const materialId = registerMd(store)
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    const blockId = store.pendingUnderstandingBlocks[0].id
    store.confirmUnderstandingBlock({ blockId })
    const before = revision(store)

    const empty: UnderstandingDraft = {
      goalCandidates: [],
      outcomeCandidates: [],
      dataNotes: [],
      methodNotes: [],
      openQuestions: [],
    }
    const result = store.recordUnderstanding({
      materialId,
      materialVersion: 1,
      draft: empty,
      notice: '模型调用超时，未生成理解草稿',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 没有结果就如实报 0 条：不伪装成功、也不动学生已经确认过的内容
    expect(result.data.blockCount).toBe(0)
    expect(store.confirmedUnderstandingBlocks).toHaveLength(1)
    expect(store.toastText).toContain('模型调用超时')
    expect(revision(store)).toBe(before)
  })

  it('材料版本对不上时返回 STALE_RESPONSE，不写入', () => {
    const store = withProject()
    const materialId = registerMd(store)

    const failed = store.recordUnderstanding({ materialId, materialVersion: 99, draft: draftFor(materialId) })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('STALE_RESPONSE')
    expect(project(store).understandingBlocks).toHaveLength(0)
  })

  it('fallback 的中文说明会出现在反馈里（即使没有写入任何条目）', () => {
    const store = withProject()
    const materialId = registerMd(store)
    store.recordUnderstanding({
      materialId,
      materialVersion: 1,
      draft: {
        goalCandidates: [],
        outcomeCandidates: [],
        dataNotes: [],
        methodNotes: [],
        openQuestions: [],
      },
      notice: '模型调用超时，材料已解析成功，可以先手动登记要点',
    })
    expect(store.toastText).toContain('模型调用超时')
  })
})

describe('确认 / 修改 / 撤销确认 / 删除（契约 14.3 / 17.2 / 2.6）', () => {
  function withDraft(): { store: Store; materialId: string; blockId: string } {
    const store = withProject()
    const materialId = registerMd(store)
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    return { store, materialId, blockId: store.pendingUnderstandingBlocks[0].id }
  }

  it('未确认的草稿不进请求字段，确认后才进', () => {
    const { store, materialId, blockId } = withDraft()

    expect(buildConfirmedMaterials(project(store))).toEqual([])
    expect(buildConfirmedContext(project(store))).toEqual([])
    expect(store.confirmedContext).toEqual([])
    expect(store.confirmedMaterials).toEqual([])

    const confirmed = store.confirmUnderstandingBlock({ blockId })
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(confirmed.data.status).toBe('confirmed')
    expect(store.pendingUnderstandingBlocks).toHaveLength(0)
    expect(store.confirmedUnderstandingBlocks).toHaveLength(1)

    const materials = store.confirmedMaterials
    expect(materials).toHaveLength(1)
    expect(materials[0].materialId).toBe(materialId)
    expect(materials[0].segments[0].segmentId).toBe('seg_0')
    expect(store.confirmedContext).toEqual(['项目目标：复现极端风浪事件的识别流程'])
  })

  it('重复确认是幂等的（不报错、不改状态、不递增版本）', () => {
    const { store, blockId } = withDraft()
    store.confirmUnderstandingBlock({ blockId })
    const after = revision(store)

    const again = store.confirmUnderstandingBlock({ blockId })
    expect(again.ok).toBe(true)
    expect(revision(store)).toBe(after)
  })

  it('修改后状态是 modified，仍然不进请求字段，直到再次确认', () => {
    const { store, blockId } = withDraft()
    const before = revision(store)

    const modified = store.modifyUnderstandingBlock({ blockId, content: '学生改写后的目标' })
    expect(modified.ok).toBe(true)
    if (!modified.ok) return
    expect(modified.data.status).toBe('modified')
    expect(revision(store)).toBe(before + 1)
    expect(store.modifiedUnderstandingBlocks).toHaveLength(1)
    expect(buildConfirmedMaterials(project(store))).toEqual([])

    const confirmed = store.confirmUnderstandingBlock({ blockId })
    expect(confirmed.ok).toBe(true)
    expect(store.confirmedContext).toEqual(['项目目标：学生改写后的目标'])
  })

  it('修改已经确认过的条目会退回 modified，不再进入请求字段', () => {
    const { store, blockId } = withDraft()
    store.confirmUnderstandingBlock({ blockId })
    expect(store.confirmedMaterials).toHaveLength(1)

    store.modifyUnderstandingBlock({ blockId, content: '又改了一版' })
    expect(store.confirmedMaterials).toEqual([])
    expect(store.confirmedContext).toEqual([])
    expect(store.modifiedUnderstandingBlocks).toHaveLength(1)
  })

  it('修改内容为空返回 INVALID_INPUT', () => {
    const { store, blockId } = withDraft()
    const failed = store.modifyUnderstandingBlock({ blockId, content: '   ' })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.code).toBe('INVALID_INPUT')
  })

  it('撤销确认：未改过的条目回到 pending，改过的回到 modified，都离开已确认集合', () => {
    const { store, blockId } = withDraft()

    // 未改过 → pending
    store.confirmUnderstandingBlock({ blockId })
    const back = store.unconfirmUnderstandingBlock({ blockId })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.data.status).toBe('pending')
    expect(store.confirmedUnderstandingBlocks).toHaveLength(0)
    expect(store.pendingUnderstandingBlocks).toHaveLength(1)
    expect(store.confirmedMaterials).toEqual([])

    // 改过 → modified（保住「这条被改过」的信息）
    store.modifyUnderstandingBlock({ blockId, content: '改过的目标' })
    store.confirmUnderstandingBlock({ blockId })
    const backModified = store.unconfirmUnderstandingBlock({ blockId })
    expect(backModified.ok).toBe(true)
    if (!backModified.ok) return
    expect(backModified.data.status).toBe('modified')
    expect(store.modifiedUnderstandingBlocks).toHaveLength(1)
  })

  it('撤销确认会递增版本；对未确认条目调用是幂等的', () => {
    const { store, blockId } = withDraft()
    store.confirmUnderstandingBlock({ blockId })
    const confirmedRevision = revision(store)

    const back = store.unconfirmUnderstandingBlock({ blockId })
    expect(back.ok).toBe(true)
    expect(revision(store)).toBe(confirmedRevision + 1)

    // 已经不是 confirmed：不改状态、不递增版本
    const again = store.unconfirmUnderstandingBlock({ blockId })
    expect(again.ok).toBe(true)
    expect(revision(store)).toBe(confirmedRevision + 1)
  })

  it('未知 blockId 返回 NOT_FOUND', () => {
    const { store } = withDraft()
    const missing = store.unconfirmUnderstandingBlock({ blockId: 'ublk_not_exists' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND')
  })

  it('删除草稿条目并递增版本；未知 id 返回 NOT_FOUND', () => {
    const { store, blockId } = withDraft()
    const before = revision(store)

    const removed = store.deleteUnderstandingBlock({ blockId })
    expect(removed.ok).toBe(true)
    expect(revision(store)).toBe(before + 1)
    expect(project(store).understandingBlocks).toHaveLength(0)

    const missing = store.deleteUnderstandingBlock({ blockId })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND')
  })

  it('整份确认覆盖该材料当前版本的全部未确认条目（含已修改）；重复调用不再递增版本', () => {
    const store = withProject()
    const materialId = registerMd(store)
    store.recordUnderstanding({
      materialId,
      materialVersion: 1,
      draft: {
        ...draftFor(materialId),
        dataNotes: [
          {
            itemId: 'cnd_data_0',
            text: '数据包含有效波高与风速字段',
            sources: draftFor(materialId).goalCandidates[0].sources,
          },
        ],
      },
    })
    // 其中一条先改成「已修改」，整份确认应当把它也一起确认
    store.modifyUnderstandingBlock({
      blockId: store.pendingUnderstandingBlocks[0].id,
      content: '改过的一条',
    })
    expect(store.pendingUnderstandingBlocks).toHaveLength(1)
    expect(store.modifiedUnderstandingBlocks).toHaveLength(1)
    const before = revision(store)

    const all = store.confirmAllUnderstanding({ materialId })
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.data.confirmedCount).toBe(2)
    expect(revision(store)).toBe(before + 1)
    expect(store.confirmedUnderstandingBlocks).toHaveLength(2)

    const again = store.confirmAllUnderstanding({ materialId })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.data.confirmedCount).toBe(0)
    expect(revision(store)).toBe(before + 1)
  })
})

/* ---------------------------------------------------------------- 聊天 */

describe('sendChat（契约 6.4 / 13.2 / 17.1 / 17.4）', () => {
  it('未确认草稿不进聊天请求；promptVersion 是 advisor-chat-v2', async () => {
    const { captured } = stubChatFetch()
    const store = withProject()
    const materialId = registerMd(store)
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })

    const result = await store.sendChat('我下一步做什么？')

    expect(result.ok).toBe(true)
    expect(captured).toHaveLength(1)
    const body = captured[0]
    expect(body.promptVersion).toBe('advisor-chat-v2')
    expect('confirmedMaterials' in body).toBe(false)
    expect('projectProfile' in body).toBe(false)
    expect('confirmedContext' in body).toBe(false)
    expect(JSON.stringify(body)).not.toContain('复现极端风浪事件的识别流程')
    // 提问进聊天记录，回答也进
    expect(project(store).chat.at(-2)?.text).toBe('我下一步做什么？')
    expect(project(store).chat.at(-1)?.text).toContain('研究海区')
  })

  it('确认后：请求体带上 projectProfile 与已确认材料片段', async () => {
    const { captured } = stubChatFetch()
    const store = withProject()
    store.updateProjectProfile({ goal: '目标：识别极端风浪事件' })
    const materialId = registerMd(store, '实验手册.md', 2)
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    store.confirmUnderstandingBlock({ blockId: store.pendingUnderstandingBlocks[0].id })

    await store.sendChat('这份材料说明了什么？')

    const body = captured[0]
    expect(body.projectProfile).toEqual({
      goal: '目标：识别极端风浪事件',
      expectedOutcome: null,
      memberNames: [],
      researchPeriod: null,
      scope: null,
      outOfScope: null,
    })
    const materials = body.confirmedMaterials as Array<{ segments: Array<{ segmentId: string }> }>
    expect(materials).toHaveLength(1)
    expect(materials[0].segments.map((segment) => segment.segmentId)).toEqual(['seg_0'])
  })

  it('修改已确认条目后，聊天请求不再带旧内容', async () => {
    const { captured } = stubChatFetch()
    const store = withProject()
    const materialId = registerMd(store)
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    const blockId = store.pendingUnderstandingBlocks[0].id
    store.confirmUnderstandingBlock({ blockId })
    store.modifyUnderstandingBlock({ blockId, content: '改过但还没确认' })

    await store.sendChat('再问一次')

    expect('confirmedMaterials' in captured[0]).toBe(false)
    expect(JSON.stringify(captured[0])).not.toContain('改过但还没确认')
  })

  it('聊天不递增 projectRevision，且 chatLoading 会复位', async () => {
    const { fetchStub } = stubChatFetch()
    const store = withProject()
    const before = revision(store)

    const pending = store.sendChat('一个问题')
    expect(store.chatLoading).toBe(true)
    await pending

    expect(store.chatLoading).toBe(false)
    expect(store.chatError).toBeNull()
    expect(revision(store)).toBe(before)
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('后端不可用时如实报告失败（中文说明，不用本地假回复冒充顾问）', async () => {
    stubChatFetch({ ok: false })
    const store = withProject()

    const result = await store.sendChat('断网时会怎样？')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NETWORK_ERROR')
    // chatError 是给用户看的中文说明：按稳定错误码映射，不含错误码与内部字段名
    expect(store.chatError).toContain('连不上后端服务')
    expect(store.chatError).not.toContain('NETWORK_ERROR')
    expect(store.toastText).not.toBe('')
    // 用户的问题保留在聊天记录里；不写任何假回答，也没有"顾问答过了"的气泡
    const chat = project(store).chat
    expect(chat).toHaveLength(1)
    expect(chat[0]?.me).toBe(true)
    expect(chat[0]?.text).toBe('断网时会怎样？')
    expect(chat.some((entry) => entry.source !== undefined)).toBe(false)
  })

  it('失败后重试同一个问题：不重复记录，问题与回答各一条', async () => {
    const { captured, fetchStub } = stubChatFetch()
    const store = withProject()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await store.sendChat('同一个问题')
    expect(project(store).chat).toHaveLength(1)

    // 第二次成功：同一个问题只保留一条用户消息，历史里也不会出现两次
    vi.stubGlobal('fetch', fetchStub)
    const retried = await store.sendChat('同一个问题')

    expect(retried.ok).toBe(true)
    expect(project(store).chat).toHaveLength(2)
    expect(project(store).chat[0]?.text).toBe('同一个问题')
    expect(project(store).chat[1]?.source).toBe('model')
    const history = captured[0]?.chatHistory as Array<{ text: string }>
    expect(history.filter((entry) => entry.text === '同一个问题')).toHaveLength(0)
  })

  it('过期聊天响应整份丢弃：不写进聊天记录，也不改项目状态', async () => {
    stubChatFetch({ revisionDelta: 1 })
    const store = withProject()
    const before = revision(store)
    const chatLength = project(store).chat.length

    const result = await store.sendChat('会被丢弃的提问')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_RESPONSE')
    expect(project(store).chat).toHaveLength(chatLength + 1)
    expect(revision(store)).toBe(before)
  })

  it('空提问返回 INVALID_INPUT，不发起请求', async () => {
    const { fetchStub } = stubChatFetch()
    const store = withProject()

    const result = await store.sendChat('   ')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_INPUT')
    expect(fetchStub).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------ 版本递增 */

describe('projectRevision（契约 2.6）', () => {
  it('每次状态变更严格 +1，纯读取不动版本', () => {
    const store = withProject()
    expect(revision(store)).toBe(1)

    store.updateProjectProfile({ goal: '目标' })
    expect(revision(store)).toBe(2)

    const materialId = registerMd(store)
    expect(revision(store)).toBe(3)

    // 草稿生成不是契约 2.6 的 +1 事件
    store.recordUnderstanding({ materialId, materialVersion: 1, draft: draftFor(materialId) })
    expect(revision(store)).toBe(3)

    const blockId = store.pendingUnderstandingBlocks[0].id
    // 顺序对应状态的合法迁移：pending → confirmed → pending → modified → deleted
    const steps: Array<() => void> = [
      () => store.confirmUnderstandingBlock({ blockId }),
      () => store.unconfirmUnderstandingBlock({ blockId }),
      () => store.modifyUnderstandingBlock({ blockId, content: '改写' }),
      () => store.deleteUnderstandingBlock({ blockId }),
    ]
    for (const step of steps) {
      const before = revision(store)
      step()
      expect(revision(store)).toBe(before + 1)
    }

    // 纯读取不改版本
    const before = revision(store)
    void store.materials
    void store.materialSegments
    void store.confirmedContext
    void store.confirmedMaterials
    void store.basicInfo
    expect(revision(store)).toBe(before)
  })
})
