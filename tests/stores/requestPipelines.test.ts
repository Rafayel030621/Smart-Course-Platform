import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { TOPICS } from '@/data/topics'
import type { Project, UnderstandingDraft } from '@/types/platform'
import { MATERIAL_ERROR_MESSAGES } from '@/domain/recommendation'
import { useWorkbenchStore } from '@/stores/workbench'

/**
 * 四条链路的请求体与竞态（契约 4.7 / 13.2 / 14.5 / 17.1 / 17.2）
 * ----------------------------------------------------------------------------
 * 这里用真实的 store + 假 `fetch`（`vi.stubGlobal`）检查**发出去的东西**：
 *   1. 未确认 / 已撤销 / 旧版本的草稿内容绝不进入建议与聊天请求体；
 *   2. 确认之后才带上 `confirmedMaterials` / `confirmedContext`；
 *   3. 请求在途时切换项目或改状态 → 旧响应丢弃且不留永久 loading；
 *   4. 聊天失败给中文说明，不用本地假回复掩盖接口故障；
 *   5. 上传 / 解析 / 理解失败都不破坏已有项目数据。
 */

type Store = ReturnType<typeof useWorkbenchStore>

const MARKER = 'DRAFT_SHOULD_NOT_LEAK_9f2c'
/** 单行标记：请求体里换行会被 JSON 转义，断言用这个标记更可靠 */
const SEGMENT_MARKER = 'SEGMENT_MARKER_4b7d'
const SEGMENT_TEXT = `# 实验手册\n本实验使用 ERA5 海浪场数据。${SEGMENT_MARKER}`
const MATERIAL_NAME = '实验手册.md'

interface CapturedCall {
  url: string
  body: Record<string, unknown> | null
  init: RequestInit | undefined
}

const calls: CapturedCall[] = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 建议接口成功响应：回显请求身份，便于走完正常分支 */
function recommendationsSuccess(body: Record<string, unknown>): Response {
  return jsonResponse({
    contractVersion: '1.0',
    requestId: body.requestId,
    projectId: body.projectId,
    projectRevision: body.projectRevision,
    promptVersion: body.promptVersion,
    source: 'model',
    fallbackReason: null,
    cached: false,
    suggestions: [
      {
        title: '调研极端风浪事件的定义',
        whyNow: '先把定义定下来，后面才不会返工。',
        doneCriteria: '一页定义笔记。',
        existingTaskId: null,
        basisEvidenceIds: [],
        basisDoubtIds: [],
      },
    ],
  })
}

function chatSuccess(body: Record<string, unknown>): Response {
  return jsonResponse({
    contractVersion: '1.0',
    requestId: body.requestId,
    projectId: body.projectId,
    projectRevision: body.projectRevision,
    promptVersion: body.promptVersion,
    source: 'model',
    fallbackReason: null,
    answer: '材料里写的是 ERA5 海浪场数据。',
  })
}

type Handler = (url: string, body: Record<string, unknown>, init: RequestInit | undefined) => Response | Promise<Response>

function installFetch(handler: Handler): void {
  calls.length = 0
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, body, init })
    return handler(url, body, init)
  })
  vi.stubGlobal('fetch', mock)
}

function callsTo(path: string): CapturedCall[] {
  return calls.filter((call) => call.url.includes(path))
}

function bodyText(call: CapturedCall): string {
  return JSON.stringify(call.body ?? {})
}

/** 建项目 + 存基本信息 + 登记一份 md 材料（都在本地，不发请求） */
function setupWithMaterial(): { store: Store; materialId: string } {
  setActivePinia(createPinia())
  const store = useWorkbenchStore()
  expect(store.createProject({ topicId: TOPICS[0], members: 3 }).ok).toBe(true)
  expect(store.updateProjectProfile({ goal: '构建极端风浪事件识别与预警的原型系统' }).ok).toBe(true)

  const registered = store.registerMaterial({
    name: MATERIAL_NAME,
    size: 2048,
    segments: [{ segmentId: 'seg_0', index: 0, startLine: 1, endLine: 2, text: SEGMENT_TEXT }],
  })
  expect(registered.ok).toBe(true)
  if (!registered.ok) throw new Error(registered.message)
  return { store, materialId: registered.data.materialId }
}

function draftWith(text = MARKER): UnderstandingDraft {
  return {
    goalCandidates: [
      {
        itemId: 'cnd_goal_0',
        text,
        sources: [
          {
            materialId: 'material-placeholder',
            materialName: MATERIAL_NAME,
            materialVersion: 1,
            segmentId: 'seg_0',
            startLine: 1,
            endLine: 2,
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

/** 写入一条待确认草稿（来源会在 store 里按材料 ID 校正，这里传占位值再替换） */
function recordDraft(store: Store, materialId: string, text = MARKER): string {
  const draft = draftWith(text)
  draft.goalCandidates[0].sources[0].materialId = materialId
  const recorded = store.recordUnderstanding({ materialId, materialVersion: 1, draft })
  expect(recorded.ok).toBe(true)
  return store.pendingUnderstandingBlocks[0].id
}

function project(store: Store): Project {
  const current = store.current
  if (current === undefined) throw new Error('没有当前项目')
  return current
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------- 未确认草稿隔离 */

describe('未确认内容不进请求体（契约 17.2 / 13.2）', () => {
  it('待确认草稿：建议与聊天请求体都不含其内容', async () => {
    const { store, materialId } = setupWithMaterial()
    recordDraft(store, materialId)

    installFetch((url, body) =>
      url.includes('/api/advisor/chat') ? chatSuccess(body) : recommendationsSuccess(body),
    )

    await store.refreshRecommendations({ forceRefresh: true })
    await store.sendChat('这份材料说明了什么？')

    const advisor = callsTo('/api/advisor/recommendations')[0]
    const chat = callsTo('/api/advisor/chat')[0]

    expect(advisor).toBeDefined()
    expect(chat).toBeDefined()
    expect(bodyText(advisor)).not.toContain(MARKER)
    expect(bodyText(chat)).not.toContain(MARKER)
    // 未确认 → 两个可选字段都不出现（行为与 v1.3 一致）
    expect('confirmedMaterials' in (advisor.body ?? {})).toBe(false)
    expect('confirmedMaterials' in (chat.body ?? {})).toBe(false)
    expect(advisor.body?.confirmedContext).toEqual([])
    // 聊天不发 confirmedContext（契约 6.4 字段表）
    expect('confirmedContext' in (chat.body ?? {})).toBe(false)
    // 版本取值（契约 17.4）
    expect(advisor.body?.promptVersion).toBe('mvp-prompt-v2')
    expect(chat.body?.promptVersion).toBe('advisor-chat-v2')
    // 项目基本信息走 projectProfile（契约 13.2），不重复写进 confirmedContext
    expect(advisor.body?.projectProfile).toMatchObject({ goal: '构建极端风浪事件识别与预警的原型系统' })
    expect(chat.body?.projectProfile).toMatchObject({ goal: '构建极端风浪事件识别与预警的原型系统' })
    expect(advisor.body?.confirmedContext).not.toContain('构建极端风浪事件识别与预警的原型系统')
    // 身份三件套（契约 4.7）
    expect(advisor.body?.projectId).toBe(project(store).projectId)
    expect(advisor.body?.projectRevision).toBe(project(store).projectRevision)
    expect(typeof advisor.body?.requestId).toBe('string')
  })

  it('确认后：两条链路都带上 confirmedMaterials，建议还带上 confirmedContext', async () => {
    const { store, materialId } = setupWithMaterial()
    const blockId = recordDraft(store, materialId)
    expect(store.confirmUnderstandingBlock({ blockId }).ok).toBe(true)

    installFetch((url, body) =>
      url.includes('/api/advisor/chat') ? chatSuccess(body) : recommendationsSuccess(body),
    )

    await store.refreshRecommendations({ forceRefresh: true })
    await store.sendChat('这份材料说明了什么？')

    const advisor = callsTo('/api/advisor/recommendations')[0].body ?? {}
    const chat = callsTo('/api/advisor/chat')[0].body ?? {}

    // confirmedMaterials = 已确认条目引用到的**材料片段原文**
    for (const body of [advisor, chat]) {
      const materials = body.confirmedMaterials as Array<Record<string, unknown>>
      expect(materials).toHaveLength(1)
      expect(materials[0]).toMatchObject({ name: MATERIAL_NAME, type: 'md', version: 1 })
      expect((materials[0].segments as Array<Record<string, unknown>>)[0]).toMatchObject({
        segmentId: 'seg_0',
        text: SEGMENT_TEXT,
      })
    }
    // confirmedContext = 已确认的草稿结论；聊天按契约 6.4 不发这个字段
    expect(advisor.confirmedContext).toEqual([`项目目标：${MARKER}`])
    expect('confirmedContext' in chat).toBe(false)
  })

  it('撤销确认后：内容重新从两条链路消失（modified 与 pending 都不进请求体）', async () => {
    const { store, materialId } = setupWithMaterial()
    const blockId = recordDraft(store, materialId)
    store.confirmUnderstandingBlock({ blockId })
    // 改内容但不再确认 → modified
    expect(store.modifyUnderstandingBlock({ blockId, content: `${MARKER}（学生改写）` }).ok).toBe(true)

    installFetch((url, body) =>
      url.includes('/api/advisor/chat') ? chatSuccess(body) : recommendationsSuccess(body),
    )
    await store.refreshRecommendations({ forceRefresh: true })
    await store.sendChat('改写后还算数吗？')
    expect(bodyText(callsTo('/api/advisor/recommendations')[0])).not.toContain(MARKER)
    expect(bodyText(callsTo('/api/advisor/chat')[0])).not.toContain(MARKER)

    // 确认 → 进入请求体（confirmedMaterials 带上被引用的片段）；再撤销确认 → 又消失
    const reconfirmed = store.confirmUnderstandingBlock({ blockId })
    expect(reconfirmed.ok).toBe(true)
    expect(store.confirmedUnderstandingBlocks).toHaveLength(1)
    expect(store.confirmedMaterials).toHaveLength(1)

    calls.length = 0
    await store.sendChat('确认之后呢？')
    const afterConfirm = callsTo('/api/advisor/chat')[0]
    expect('confirmedMaterials' in (afterConfirm.body ?? {})).toBe(true)
    expect(bodyText(afterConfirm)).toContain(SEGMENT_MARKER)

    expect(store.unconfirmUnderstandingBlock({ blockId }).ok).toBe(true)
    calls.length = 0
    await store.sendChat('撤销之后呢？')
    const afterUnconfirm = callsTo('/api/advisor/chat')[0]
    expect('confirmedMaterials' in (afterUnconfirm.body ?? {})).toBe(false)
    expect(bodyText(afterUnconfirm)).not.toContain(SEGMENT_MARKER)
  })

  it('删除条目后不再进入请求体', async () => {
    const { store, materialId } = setupWithMaterial()
    const blockId = recordDraft(store, materialId)
    store.confirmUnderstandingBlock({ blockId })
    store.deleteUnderstandingBlock({ blockId })

    installFetch((url, body) =>
      url.includes('/api/advisor/chat') ? chatSuccess(body) : recommendationsSuccess(body),
    )
    await store.sendChat('还在吗？')
    const chat = callsTo('/api/advisor/chat')[0]
    expect(bodyText(chat)).not.toContain(MARKER)
    expect('confirmedMaterials' in (chat.body ?? {})).toBe(false)
  })
})

/* ------------------------------------------------------------ 材料换版 */

describe('材料换版（契约 14.5 第 4 条）', () => {
  it('重传同名材料后，旧版本片段与草稿都不再进入请求体', async () => {
    const { store, materialId } = setupWithMaterial()
    const blockId = recordDraft(store, materialId)
    store.confirmUnderstandingBlock({ blockId })

    // 同名重传 → 同一个 materialId、version +1，旧草稿与旧片段作废
    const replaced = store.registerMaterial({
      name: MATERIAL_NAME,
      size: 4096,
      segments: [{ segmentId: 'seg_0', index: 0, startLine: 1, endLine: 3, text: '新版正文 NEW_VERSION_BODY' }],
    })
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return
    expect(replaced.data.materialId).toBe(materialId)
    expect(replaced.data.version).toBe(2)
    expect(store.confirmedUnderstandingBlocks).toHaveLength(0)
    expect(store.pendingUnderstandingBlocks).toHaveLength(0)

    installFetch((url, body) =>
      url.includes('/api/advisor/chat') ? chatSuccess(body) : recommendationsSuccess(body),
    )
    await store.refreshRecommendations({ forceRefresh: true })
    await store.sendChat('换版之后呢？')

    for (const call of [
      callsTo('/api/advisor/recommendations')[0],
      callsTo('/api/advisor/chat')[0],
    ]) {
      expect(bodyText(call)).not.toContain(MARKER)
      expect(bodyText(call)).not.toContain(SEGMENT_MARKER)
      expect('confirmedMaterials' in (call.body ?? {})).toBe(false)
    }
  })

  it('理解请求在途时材料被换版：旧响应整份丢弃，不写到新版本上', async () => {
    const { store, materialId } = setupWithMaterial()

    let release: (response: Response) => void = () => {}
    installFetch((url) => {
      if (url.includes('/api/materials/understanding')) {
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      }
      return jsonResponse({})
    })

    const pending = store.requestUnderstanding({ materialId })
    const request = callsTo('/api/materials/understanding')[0]
    expect(request).toBeDefined()

    // 请求在途时换版：同一 materialId 重新登记为 version 2
    const replaced = store.registerMaterial({
      name: MATERIAL_NAME,
      size: 4096,
      segments: [{ segmentId: 'seg_0', index: 0, startLine: 1, endLine: 3, text: '新版正文' }],
    })
    expect(replaced.ok).toBe(true)
    const revisionAfterSwap = project(store).projectRevision

    // 迟到的旧响应：身份回显旧的 projectRevision，材料版本也还是 1
    const draft = draftWith(MARKER)
    draft.goalCandidates[0].sources[0].materialId = materialId
    release(
      jsonResponse({
        contractVersion: '1.0',
        requestId: request.body?.requestId,
        projectId: request.body?.projectId,
        projectRevision: request.body?.projectRevision,
        materialId,
        materialVersion: 1,
        promptVersion: 'material-understanding-v1',
        source: 'model',
        fallbackReason: null,
        notice: null,
        draft,
      }),
    )

    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_RESPONSE')
    // 旧版本草稿不会被写到新版本材料上，也不会递增版本
    expect(project(store).understandingBlocks).toHaveLength(0)
    expect(project(store).projectRevision).toBe(revisionAfterSwap)
    expect(store.materials[0].version).toBe(2)
  })
})

/* ------------------------------------------------------ 竞态与 loading */

describe('过期响应与 loading 收尾（契约 4.7）', () => {
  it('请求在途时确认草稿 → 旧响应丢弃，且不留永久 loading', async () => {
    const { store, materialId } = setupWithMaterial()
    const blockId = recordDraft(store, materialId)

    let release: (() => void) | null = null
    installFetch((_url, body) => {
      return new Promise<Response>((resolve) => {
        release = () => resolve(recommendationsSuccess(body))
      })
    })

    const pending = store.refreshRecommendations({ forceRefresh: true })
    expect(store.aiStatus).toBe('loading')

    // 请求在途时项目状态变化（revision +1）
    store.confirmUnderstandingBlock({ blockId })
    if (release === null) throw new Error('fetch 没有被调用')
    ;(release as () => void)()

    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_RESPONSE')
    // 旧响应不得覆盖状态，也不得留下转圈
    expect(store.aiStatus).toBe('idle')
    expect(store.recommendations).toEqual([])
  })

  it('请求在途时切换项目 → 旧响应丢弃，且旧项目不会卡在 loading', async () => {
    const { store, materialId } = setupWithMaterial()
    recordDraft(store, materialId)
    const firstProjectId = project(store).projectId

    let release: (() => void) | null = null
    installFetch((_url, body) => {
      return new Promise<Response>((resolve) => {
        release = () => resolve(recommendationsSuccess(body))
      })
    })

    const pending = store.refreshRecommendations({ forceRefresh: true })
    store.createProject({ topicId: TOPICS[1], members: 3 })
    expect(project(store).projectId).not.toBe(firstProjectId)

    if (release === null) throw new Error('fetch 没有被调用')
    ;(release as () => void)()
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('STALE_RESPONSE')
    // 新项目不该被旧响应的 loading 状态污染
    expect(store.aiStatus).toBe('idle')
    expect(store.recommendations).toEqual([])
  })
})

/* -------------------------------------------------------------- 聊天链路 */

describe('聊天链路（契约 6.4）', () => {
  it('真的调用后端接口，成功时写入回答', async () => {
    const { store } = setupWithMaterial()
    installFetch((_url, body) => chatSuccess(body))

    const result = await store.sendChat('这份材料说明了什么？')

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/api/advisor/chat')
    const last = project(store).chat.at(-1)
    expect(last?.text).toBe('材料里写的是 ERA5 海浪场数据。')
    expect(last?.source).toBe('model')
    expect(store.chatLoading).toBe(false)
    expect(store.chatError).toBeNull()
  })

  it('响应不回显 promptVersion 也算合法（契约 6.4 未要求），不重试也不误报失败', async () => {
    const { store } = setupWithMaterial()
    const mock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      return jsonResponse({
        contractVersion: '1.0',
        requestId: body.requestId,
        projectId: body.projectId,
        projectRevision: body.projectRevision,
        source: 'model',
        fallbackReason: null,
        answer: '材料里写的是 ERA5 海浪场数据。',
      })
    })
    vi.stubGlobal('fetch', mock)

    const result = await store.sendChat('这份材料说明了什么？')

    expect(result.ok).toBe(true)
    // 少一个非必需字段不能触发自动重试
    expect(mock).toHaveBeenCalledTimes(1)
    const last = project(store).chat.at(-1)
    expect(last?.source).toBe('model')
    expect(last?.text).toBe('材料里写的是 ERA5 海浪场数据。')
  })

  it('断网失败：给中文说明，不用本地假回复冒充顾问', async () => {
    const { store } = setupWithMaterial()
    installFetch(() => {
      throw new TypeError('Failed to fetch')
    })

    const result = await store.sendChat('这份材料说明了什么？')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NETWORK_ERROR')

    const last = project(store).chat.at(-1)
    expect(last?.source).toBe('error')
    expect(last?.text).toContain('顾问暂时回答不了')
    expect(last?.text).toContain('你的问题已经保存')
    // 不能再写"看起来很像是顾问答的"内容
    expect(last?.text).not.toContain('建议先做其中的文献部分')
    expect(store.chatLoading).toBe(false)
    expect(store.chatError?.code).toBe('NETWORK_ERROR')
  })

  it('非法响应：整份丢弃并给中文说明', async () => {
    const { store } = setupWithMaterial()
    installFetch(() => jsonResponse({ contractVersion: '1.0', answer: '缺少身份字段' }))

    const result = await store.sendChat('这份材料说明了什么？')
    expect(result.ok).toBe(false)
    expect(project(store).chat.at(-1)?.source).toBe('error')
    expect(store.chatLoading).toBe(false)
  })

  it('新提问取消上一次：旧请求静默结束，loading 由新请求收尾', async () => {
    const { store } = setupWithMaterial()

    const pendingResolvers: Array<() => void> = []
    installFetch((_url, body, init) => {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        )
        pendingResolvers.push(() => resolve(chatSuccess(body)))
      })
    })

    const first = store.sendChat('问题一')
    const second = store.sendChat('问题二')
    expect(store.chatLoading).toBe(true)

    // 第二次提问作废了第一次；只让第二次成功返回
    expect(pendingResolvers).toHaveLength(2)
    pendingResolvers[1]()
    const secondResult = await second
    expect(secondResult.ok).toBe(true)

    const firstResult = await first
    expect(firstResult.ok).toBe(false)
    expect(store.chatLoading).toBe(false)
    // 聊天记录里只有一次顾问回答（第二次的），第一次既没有留下假回答也没有错误提示
    const answers = project(store).chat.filter((entry) => entry.source !== undefined)
    expect(answers).toHaveLength(1)
    expect(answers[0].source).toBe('model')
    expect(answers[0].text).toBe('材料里写的是 ERA5 海浪场数据。')
  })

  it('「就此提问」走真实接口，而不是本地预写回答', async () => {
    const { store } = setupWithMaterial()
    installFetch((_url, body) => chatSuccess(body))

    store.askAboutStep(0)
    await vi.waitFor(() => {
      expect(callsTo('/api/advisor/chat')).toHaveLength(1)
    })

    expect(calls[0].url).toContain('/api/advisor/chat')
    const question = String(calls[0].body?.question ?? '')
    expect(question).toContain('我想先了解')
  })
})

/* --------------------------------------------------------- 失败不破坏数据 */

describe('上传的本地守卫（契约 15.1 白名单 / 16 错误码与中文提示）', () => {
  async function expectGuardRejects(
    store: Store,
    file: Blob,
    name: string,
    code: string,
  ): Promise<void> {
    installFetch(() => jsonResponse({}))
    const before = project(store).projectRevision

    const result = await store.uploadMaterialFile({ file, name })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(code)
      // 提示必须与契约 16 的对外文案逐字一致（同一处常量）
      expect(result.message).toBe(MATERIAL_ERROR_MESSAGES[code as keyof typeof MATERIAL_ERROR_MESSAGES])
    }
    // 本地就挡下，不浪费一次必然失败的请求，也不动项目数据
    expect(callsTo('/api/materials')).toHaveLength(0)
    expect(store.materials).toHaveLength(1)
    expect(project(store).projectRevision).toBe(before)
  }

  it('非 md / txt：拒绝并给契约中文提示，不发请求、不产生记录', async () => {
    const { store } = setupWithMaterial()
    await expectGuardRejects(store, new Blob(['a,b\n1,2']), '数据.csv', 'UNSUPPORTED_MATERIAL_TYPE')
    await expectGuardRejects(store, new Blob(['%PDF-1.7']), '说明.pdf', 'UNSUPPORTED_MATERIAL_TYPE')
  })

  it('超过 1 MB：拒绝并给契约中文提示', async () => {
    const { store } = setupWithMaterial()
    await expectGuardRejects(store, new Blob([new Uint8Array(1_100_000)]), '大文件.md', 'MATERIAL_TOO_LARGE')
  })

  it('空文件：拒绝并给契约中文提示', async () => {
    const { store } = setupWithMaterial()
    await expectGuardRejects(store, new Blob([]), '空.md', 'EMPTY_MATERIAL')
  })
})

describe('上传 / 理解失败不破坏项目数据（契约 15.1 / 16）', () => {
  it('上传网络失败：不产生材料记录，原有材料与版本不动', async () => {
    const { store, materialId } = setupWithMaterial()
    const before = project(store).projectRevision

    installFetch(() => {
      throw new TypeError('Failed to fetch')
    })

    const result = await store.uploadMaterialFile({
      file: new Blob(['# 新手册\n正文']),
      name: '新手册.md',
    })

    expect(result.ok).toBe(false)
    expect(store.materials).toHaveLength(1)
    expect(store.materials[0].materialId).toBe(materialId)
    expect(store.materials[0].version).toBe(1)
    expect(project(store).projectRevision).toBe(before)
    // 项目仍可继续使用
    expect(store.updateProjectProfile({ expectedOutcome: '可交互原型' }).ok).toBe(true)
  })

  it('解析失败的材料：登记但标记需重新上传，不产生片段', async () => {
    const { store } = setupWithMaterial()
    const before = project(store).projectRevision

    installFetch((_url, body) =>
      jsonResponse({
        contractVersion: '1.0',
        requestId: body.requestId,
        projectId: body.projectId,
        projectRevision: body.projectRevision,
        material: {
          materialId: 'mat_parsefail',
          projectId: body.projectId,
          name: '坏手册.md',
          type: 'md',
          size: 12,
          encoding: 'utf-8',
          state: 'parse_failed',
          version: 1,
          createdAt: '2026-10-13T10:00:00+08:00',
          updatedAt: '2026-10-13T10:00:00+08:00',
          failureReason: '材料解析失败，请检查文件内容后重试',
        },
        segmentCount: 0,
        segments: [],
      }),
    )

    const result = await store.uploadMaterialFile({
      file: new Blob(['# 坏手册']),
      name: '坏手册.md',
    })

    expect(result.ok).toBe(true)
    const failed = store.materials.find((material) => material.materialId === 'mat_parsefail')
    expect(failed?.state).toBe('parse_failed')
    expect(failed?.needsReupload).toBe(true)
    expect(store.confirmedMaterials).toEqual([])
    // 材料登记（含解析失败）是契约 2.6 的 +1 事件
    expect(project(store).projectRevision).toBe(before + 1)
    // 先前的正常材料不受影响
    expect(store.materials).toHaveLength(2)
  })

  it('理解请求失败：不写入草稿，材料与已有确认状态不动', async () => {
    const { store, materialId } = setupWithMaterial()
    const before = project(store).projectRevision

    installFetch(() => {
      throw new TypeError('Failed to fetch')
    })

    const result = await store.requestUnderstanding({ materialId })

    expect(result.ok).toBe(false)
    expect(store.pendingUnderstandingBlocks).toHaveLength(0)
    expect(store.materials).toHaveLength(1)
    expect(store.materials[0].needsReupload).toBe(false)
    expect(project(store).projectRevision).toBe(before)
  })

  it('理解 fallback（200 + 空草稿 + notice）：不写草稿、不递增版本，notice 可见', async () => {
    const { store, materialId } = setupWithMaterial()
    const before = project(store).projectRevision

    installFetch((_url, body) =>
      jsonResponse({
        contractVersion: '1.0',
        requestId: body.requestId,
        projectId: body.projectId,
        projectRevision: body.projectRevision,
        materialId,
        materialVersion: 1,
        promptVersion: 'material-understanding-v1',
        source: 'fallback',
        fallbackReason: 'MODEL_TIMEOUT',
        notice: '模型调用超时，材料已解析成功，可以先手动登记要点',
        draft: {
          goalCandidates: [],
          outcomeCandidates: [],
          dataNotes: [],
          methodNotes: [],
          openQuestions: [],
        },
      }),
    )

    const result = await store.requestUnderstanding({ materialId })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.source).toBe('fallback')
      expect(result.data.blockCount).toBe(0)
    }
    expect(store.pendingUnderstandingBlocks).toHaveLength(0)
    expect(project(store).projectRevision).toBe(before)
    expect(store.toastText).toContain('模型调用超时')
  })
})
