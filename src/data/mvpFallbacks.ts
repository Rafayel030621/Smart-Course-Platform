import type {
  DoubtSnapshot,
  EvidenceSnapshot,
  Recommendation,
  Suggestion,
  TaskSnapshot,
} from '@/domain/recommendation'
// 复用适配层里同一套稳定 ID 约定（契约 2.5(b)），避免本地规则另写一份格式
import { buildRecommendationId } from '@/services/advisorApi'

/**
 * 前端本地规则兜底（source = local-rule）
 * ----------------------------------------------------------------------------
 * 用途：后端不可达、响应超时、响应不是契约形状，或后端返回了契约错误码时的兜底建议
 * （契约 5.1 的第三行）。这条路径必须在完全离线的情况下也能给出可展示的建议。
 *
 * 硬约束（与契约 2.5(b)、5.1 对齐）：
 *   - 不发任何网络请求、不读任何密钥、不碰 localStorage；
 *   - 纯函数：不修改传入对象，同一输入必然得到同一输出（时间由调用方传入）；
 *   - 最多 3 条；没有可推荐的依据时返回空数组；
 *   - `existingTaskId` 只能是输入里的 taskId 或 null；`basisEvidenceIds` / `basisDoubtIds`
 *     只能引用本次输入里真实存在的 ID；
 *   - 已完成的（done）任务永不被推荐；
 *   - `requestId` 恒为 null、`id` 用 `rec_local_<projectRevision>_<index>`：
 *     这是契约 2.5(b) 对本地规则的规定（本地建议不来自任何一次服务端响应）。
 *
 * 注意：这里只做"规则"，不判断是否该切到本地规则——那是 store 的事（见 advisorApi 的
 * `shouldFallbackToLocalRule`）。
 */

/** 每条规则最多产出一条，保证 1-3 条建议之间有类别差异，而不是同一类堆叠 */
const MAX_SUGGESTIONS = 3

/** 疑问标题里引用的原文长度上限 */
const DOUBT_TITLE_QUOTE_LENGTH = 20

export interface LocalRecommendationInput {
  /** 生成时间（ISO）。由调用方传入，使本函数保持纯函数、结果稳定 */
  generatedAt: string
  projectRevision: number
  /** 当前里程碑名称；没有就传 null */
  currentMilestone: string | null
  /** 该项目全部任务（含已完成） */
  tasks: TaskSnapshot[]
  /** 最近若干条证据 */
  evidence: EvidenceSnapshot[]
  /** 只传 status === 'open' 的疑问；即便传了 resolved 的也会被过滤掉 */
  doubts: DoubtSnapshot[]
}

/**
 * 本地规则兜底建议。
 *
 * 优先级（契约 5.1 的兜底顺序）：
 *   0. 空白项目（先补基本信息）  1. 进行中的任务      2. 未解决的疑问
 *   3. 未开始的任务              4. 当前里程碑        5. 证据不足
 * 前三条按项目实际状态各取一条，最多 3 条。
 */
export function buildLocalRecommendations(input: LocalRecommendationInput): Recommendation[] {
  const tasks = input.tasks ?? []
  const evidence = input.evidence ?? []
  const doubts = input.doubts ?? []

  const candidates: Suggestion[] = []
  const take = (candidate: Suggestion | null): void => {
    if (candidate !== null && candidates.length < MAX_SUGGESTIONS) candidates.push(candidate)
  }

  take(buildBlankProjectSuggestion(tasks, evidence, doubts, input.currentMilestone))
  take(buildDoingSuggestion(tasks, evidence))
  take(buildDoubtSuggestion(doubts, evidence))
  take(buildTodoSuggestion(tasks))
  take(buildMilestoneSuggestion(input.currentMilestone, tasks, doubts))
  take(buildEvidenceSuggestion(tasks, evidence))
  take(buildEvidenceOnlySuggestion(tasks, evidence))

  return candidates.map((candidate, index) => toLocalRecommendation(candidate, input, index))
}

/* --------------------------------------------------------------- 各条规则 */

/**
 * 0. 空白项目：创建之后还没有任务、证据、疑问与里程碑。
 * 这时不该凭空编造研究事实，只提示"先补基本信息"，把主动权交回用户。
 */
function buildBlankProjectSuggestion(
  tasks: TaskSnapshot[],
  evidence: EvidenceSnapshot[],
  doubts: DoubtSnapshot[],
  currentMilestone: string | null,
): Suggestion | null {
  const hasAnyBasis =
    tasks.length > 0 ||
    evidence.length > 0 ||
    doubts.length > 0 ||
    (currentMilestone ?? '').trim() !== ''
  if (hasAnyBasis) return null

  return {
    title: '先补上项目的基本信息',
    whyNow:
      '这是一个空白项目：还没有任务、证据和未解决的疑问，AI 没有可分析的依据。先上传材料或写下项目目标，之后每一步建议才有落点。',
    doneCriteria: '上传实验手册或数据集，或写下项目目标与预期产出',
    existingTaskId: null,
    basisEvidenceIds: [],
    basisDoubtIds: [],
  }
}

/** 1. 进行中的任务：先把已有投入收尾，不要让进度虚高 */
function buildDoingSuggestion(tasks: TaskSnapshot[], evidence: EvidenceSnapshot[]): Suggestion | null {
  const doing = tasks.filter((task) => task.status === 'doing')
  const task = doing[0]
  if (task === undefined) return null

  const scopeHint = doing.length > 1 ? `（项目里共有 ${doing.length} 条进行中的任务）` : ''

  return {
    title: `先把进行中的任务收尾：${task.title}`,
    whyNow: `「${task.title}」正在进行中${scopeHint}；先把它收尾，后面的步骤才有稳定的前提。`,
    doneCriteria: task.doneCriteria ?? '补齐这一步的完成标准，并提交一条证据',
    existingTaskId: task.taskId,
    basisEvidenceIds: latestEvidenceIdOfTask(evidence, task.taskId),
    basisDoubtIds: [],
  }
}

/** 2. 未解决的疑问：悬着的问题会影响后续判断 */
function buildDoubtSuggestion(doubts: DoubtSnapshot[], evidence: EvidenceSnapshot[]): Suggestion | null {
  const open = doubts.filter((doubt) => doubt.status === 'open')
  const doubt = open[0]
  if (doubt === undefined) return null

  const sourceEvidenceId = doubt.sourceEvidenceId
  const hasSource =
    sourceEvidenceId !== null && evidence.some((item) => item.evidenceId === sourceEvidenceId)

  return {
    title: `把未解决的疑问定下来：${shorten(doubt.text, DOUBT_TITLE_QUOTE_LENGTH)}`,
    whyNow: `这是项目里 ${open.length} 条未解决的疑问之一；它一直悬着，会影响后面每一步的判断。`,
    doneCriteria: '写清结论，并在疑问上标记已解决',
    existingTaskId: null,
    basisEvidenceIds: hasSource && sourceEvidenceId !== null ? [sourceEvidenceId] : [],
    basisDoubtIds: [doubt.doubtId],
  }
}

/** 3. 未开始的任务：当前里程碑里排在前面、还没启动的那条 */
function buildTodoSuggestion(tasks: TaskSnapshot[]): Suggestion | null {
  const todo = tasks.filter((task) => task.status === 'todo')
  const task = todo[0]
  if (task === undefined) return null

  const milestone = task.milestone === null || task.milestone.trim() === '' ? '当前阶段' : task.milestone

  return {
    title: `启动下一个任务：${task.title}`,
    whyNow: `它是「${milestone}」里尚未开始的任务；先把它启动起来，推进才有着落。`,
    doneCriteria: task.doneCriteria ?? '完成这一步，并提交一条证据',
    existingTaskId: task.taskId,
    basisEvidenceIds: [],
    basisDoubtIds: [],
  }
}

/**
 * 4. 当前里程碑：只有在"没有可推进的具体任务"时才用，
 * 否则会和上面几条表达同一件事（第 1、3 条已经覆盖了具体任务）。
 */
function buildMilestoneSuggestion(
  currentMilestone: string | null,
  tasks: TaskSnapshot[],
  doubts: DoubtSnapshot[],
): Suggestion | null {
  if (currentMilestone === null || currentMilestone.trim() === '') return null

  const hasOpenWork =
    tasks.some((task) => task.status === 'doing' || task.status === 'todo') ||
    doubts.some((doubt) => doubt.status === 'open')
  if (hasOpenWork) return null

  return {
    title: `推进当前里程碑：${currentMilestone}`,
    whyNow: `项目里暂时没有进行中或未开始的任务，也没有未解决的疑问；先给「${currentMilestone}」定下一个具体任务。`,
    doneCriteria: '写下一条具体任务，并说明完成时会留下什么',
    existingTaskId: null,
    basisEvidenceIds: [],
    basisDoubtIds: [],
  }
}

/** 5. 证据不足：有任务却一条证据都没有，先补一条可追溯的证据 */
function buildEvidenceSuggestion(tasks: TaskSnapshot[], evidence: EvidenceSnapshot[]): Suggestion | null {
  if (evidence.length > 0) return null
  if (tasks.length === 0) return null

  return {
    title: '先提交第一条证据',
    whyNow: `项目里已经有 ${tasks.length} 条任务，但还没有任何证据；先写下刚做完的事和结论，后续判断才有依据。`,
    doneCriteria: '提交一条包含「完成了什么」和「发现了什么」的证据',
    existingTaskId: null,
    basisEvidenceIds: [],
    basisDoubtIds: [],
  }
}

/** 有证据但还没有任务时，先把这条真实进展整理成下一步输入。 */
function buildEvidenceOnlySuggestion(
  tasks: TaskSnapshot[],
  evidence: EvidenceSnapshot[],
): Suggestion | null {
  if (tasks.length > 0 || evidence.length === 0) return null

  const latest = evidence[0]
  if (latest === undefined) return null

  return {
    title: '根据这条进展补出第一项任务',
    whyNow: '项目里已经有一条真实进展，但还没有正式任务；先把这次进展整理成可执行的下一步。',
    doneCriteria: '写下一条任务，并说明完成时会留下什么证据',
    existingTaskId: null,
    basisEvidenceIds: [latest.evidenceId],
    basisDoubtIds: [],
  }
}

/* ------------------------------------------------------------------ 工具 */

function shorten(text: string, maxLength: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat
}

/** 与该任务关联的最新一条证据（证据按时间倒序传入），没有就返回空数组 */
function latestEvidenceIdOfTask(evidence: EvidenceSnapshot[], taskId: string): string[] {
  const hit = evidence.find((item) => item.taskId === taskId)
  return hit === undefined ? [] : [hit.evidenceId]
}

/** 组装成领域对象；数组逐个复制，避免与调用方共享引用 */
function toLocalRecommendation(
  candidate: Suggestion,
  input: LocalRecommendationInput,
  index: number,
): Recommendation {
  return {
    title: candidate.title,
    whyNow: candidate.whyNow,
    doneCriteria: candidate.doneCriteria,
    existingTaskId: candidate.existingTaskId,
    basisEvidenceIds: [...candidate.basisEvidenceIds],
    basisDoubtIds: [...candidate.basisDoubtIds],
    id: buildRecommendationId('local-rule', null, input.projectRevision, index),
    source: 'local-rule',
    // 契约 2.5(b)：本地规则的建议不来自任何一次服务端响应，requestId 恒为 null
    requestId: null,
    projectRevision: input.projectRevision,
    generatedAt: input.generatedAt,
  }
}
