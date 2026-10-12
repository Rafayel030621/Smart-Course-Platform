import {
  AdvisorProviderError,
  type AdvisorProvider,
  type AdvisorRequest,
  type ProviderOutput,
  type Suggestion,
  type UnderstandingProviderInput,
} from './types.js'

/**
 * 确定性 mock provider
 * ----------------------------------------------------------------------------
 * 本轮不接真实模型：这个 provider 完全根据请求内容推导建议，同样的输入必然得到同样的输出，
 * 因此可以直接写断言。它同时提供几种可注入的失败模式，用来验证服务层的超时与兜底链路。
 *
 * 接入真实模型时：新写一个实现 AdvisorProvider 的 provider，在 index.ts 的装配处替换即可，
 * 路由层、校验层、兜底层和前端契约都不需要改动。
 */

export type MockProviderMode =
  /** 正常返回候选建议 */
  | 'ok'
  /** 返回 0 条 → 服务层判为非法模型输出并进入 fallback */
  | 'empty'
  /** 返回字段不合法（空白文本）→ 同上 */
  | 'invalid'
  /** 抛普通错误 → 服务层归为 MODEL_UNAVAILABLE */
  | 'throw'
  /** 抛"未配置密钥" → 服务层归为 MODEL_NOT_CONFIGURED（不可重试） */
  | 'not-configured'
  /** 一直不返回 → 由服务层超时兜底，归为 MODEL_TIMEOUT */
  | 'slow'

export interface MockProviderOptions {
  name?: string
  mode?: MockProviderMode
  /** slow 模式的等待时间；必须大于服务层超时才会真的触发超时 */
  delayMs?: number
}

/** slow 模式的默认等待时间：够长，能触发超时，同时不会把进程留太久 */
const DEFAULT_SLOW_DELAY_MS = 5_000

export function createMockProvider(options: MockProviderOptions = {}): AdvisorProvider {
  const mode = options.mode ?? 'ok'
  const name = options.name ?? (mode === 'ok' ? 'mock-provider' : `mock-provider:${mode}`)
  const delayMs = options.delayMs ?? DEFAULT_SLOW_DELAY_MS

  return {
    name,
    async generate(request: AdvisorRequest): Promise<ProviderOutput> {
      switch (mode) {
        case 'throw':
          throw new Error('mock provider 模拟上游故障')
        case 'not-configured':
          throw new AdvisorProviderError('mock provider 未读取到模型密钥', 'MODEL_NOT_CONFIGURED')
        case 'slow':
          // 用普通定时器（不 unref）：如果服务层已经超时返回，这个 promise 仍会在 delayMs 后结算，
          // 不会在测试进程收尾时留下"永不结算的 promise"
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs)
          })
          return { suggestions: buildMockSuggestions(request) }
        case 'empty':
          return { suggestions: [] }
        case 'invalid':
          return { suggestions: [{ title: '   ', whyNow: '', doneCriteria: '' }] }
        default:
          return { suggestions: buildMockSuggestions(request) }
      }
    },
    async generateChat(request) {
      if (mode === 'throw') throw new Error('mock provider 模拟上游故障')
      if (mode === 'not-configured') throw new AdvisorProviderError('mock provider 未读取到模型密钥', 'MODEL_NOT_CONFIGURED')
      if (mode === 'slow') {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      }
      if (mode === 'invalid' || mode === 'empty') return { answer: '' }
      return { answer: `基于当前项目状态，建议先围绕“${request.question}”检查已有证据，再把可验证的下一步记录下来。` }
    },
    // v2（M2-A）材料理解：与 generate 一样按 mode 给出确定性的成功/失败路径
    async generateUnderstanding(request) {
      switch (mode) {
        case 'throw':
          throw new Error('mock provider 模拟上游故障')
        case 'not-configured':
          throw new AdvisorProviderError('mock provider 未读取到模型密钥', 'MODEL_NOT_CONFIGURED')
        case 'slow':
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs)
          })
          return { draft: buildMockUnderstandingDraft(request) }
        case 'empty':
          return { draft: { goalCandidates: [], outcomeCandidates: [], dataNotes: [], methodNotes: [], openQuestions: [] } }
        case 'invalid':
          // 文本为空 + 引用不存在的片段：输出校验会全部丢弃，最终走 fallback
          return { draft: { goalCandidates: [{ text: '   ', segmentIds: ['seg_missing'] }] } }
        default:
          return { draft: buildMockUnderstandingDraft(request) }
      }
    },
  }
}

function shorten(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat
}

/**
 * 根据请求内容生成候选建议：优先收尾进行中的任务，其次处理未解决疑问，再启动未开始的任务。
 * 引用的 ID 一律取自本次请求，保证能通过输出校验。
 */
export function buildMockSuggestions(request: AdvisorRequest): Suggestion[] {
  const doing = request.tasks.filter((task) => task.status === 'doing')
  const todo = request.tasks.filter((task) => task.status === 'todo')
  const openDoubts = request.doubts.filter((doubt) => doubt.status === 'open')
  const latestEvidenceId = request.evidence[0]?.evidenceId
  const evidenceIds = new Set(request.evidence.map((item) => item.evidenceId))

  const suggestions: Suggestion[] = []

  for (const task of doing.slice(0, 2)) {
    suggestions.push({
      title: `先把进行中的任务收尾：${task.title}`,
      whyNow: `项目里有 ${doing.length} 个进行中的任务，「${task.title}」是其中之一；先把已有投入收尾再开新线，进度才不会虚高。`,
      doneCriteria: task.doneCriteria ?? '补齐这一步的完成标志，并提交一条证据',
      existingTaskId: task.taskId,
      basisEvidenceIds: latestEvidenceId === undefined ? [] : [latestEvidenceId],
      basisDoubtIds: openDoubts[0] === undefined ? [] : [openDoubts[0].doubtId],
    })
  }

  if (suggestions.length < 3 && openDoubts[0] !== undefined) {
    const doubt = openDoubts[0]
    const sourceEvidenceId =
      doubt.sourceEvidenceId !== null && evidenceIds.has(doubt.sourceEvidenceId)
        ? doubt.sourceEvidenceId
        : null
    suggestions.push({
      title: `处理未解决疑问：${shorten(doubt.text, 24)}`,
      whyNow: `这是项目里未解决的疑问（共 ${openDoubts.length} 条），它会直接影响后面步骤的判断。`,
      doneCriteria: '给出结论，并把该疑问标记为已解决',
      existingTaskId: null,
      basisEvidenceIds: sourceEvidenceId === null ? [] : [sourceEvidenceId],
      basisDoubtIds: [doubt.doubtId],
    })
  }

  if (suggestions.length < 3 && todo[0] !== undefined) {
    const task = todo[0]
    suggestions.push({
      title: `启动「${task.milestone ?? request.currentMilestone ?? '下一阶段'}」的下一个任务：${task.title}`,
      whyNow: '当前里程碑还没有推进到这一步，而它是这条线上最先要做的事。',
      doneCriteria: task.doneCriteria ?? '完成这一步，并提交一条证据',
      existingTaskId: task.taskId,
      basisEvidenceIds: [],
      basisDoubtIds: [],
    })
  }

  if (suggestions.length === 0) {
    suggestions.push({
      title: '先给项目补一条证据',
      whyNow: '目前没有进行中或未开始的任务，也没有未解决的疑问；先写下刚做完的事和结论，后续判断才有依据。',
      doneCriteria: '提交一条包含「完成了什么」和「发现了什么」的证据',
      existingTaskId: null,
      basisEvidenceIds: [],
      basisDoubtIds: [],
    })
  }

  return suggestions.slice(0, 3)
}

/**
 * v2（M2-A）材料理解的 mock 输出：只引用本次请求里出现的片段，文本为自然中文且不含内部字段名，
 * 因此能稳定通过输出校验（用于本地联调与测试，不用于部署）。
 */
export function buildMockUnderstandingDraft(request: UnderstandingProviderInput): unknown {
  const first = request.segments[0]
  const second = request.segments[1]

  const goalCandidates: Array<{ text: string; segmentIds: string[] }> = []
  if (first !== undefined) {
    goalCandidates.push({
      text: `材料《${request.materialName}》第 ${first.startLine} 行起说明了这一步要完成的事情`,
      segmentIds: [first.segmentId],
    })
  }

  const dataNotes: Array<{ text: string; segmentIds: string[] }> = []
  if (second !== undefined) {
    dataNotes.push({
      text: `材料《${request.materialName}》第 ${second.startLine} 行起给出了数据相关说明`,
      segmentIds: [second.segmentId],
    })
  }

  const openQuestions: Array<{ text: string; segmentIds: string[] }> = first === undefined
    ? []
    : [{
        text: `材料《${request.materialName}》没有覆盖的内容需要你们补充确认`,
        segmentIds: [first.segmentId],
      }]

  return { goalCandidates, outcomeCandidates: [], dataNotes, methodNotes: [], openQuestions }
}
