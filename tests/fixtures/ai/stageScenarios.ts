import type {
  AdvisorChatRequest,
  AdvisorRecommendationsRequest,
  BasisMaterialRef,
  ConfirmedMaterial,
  EvidenceSnapshot,
  MilestoneContext,
  MilestoneTaskSnapshot,
  ProgressSnapshot,
  TaskSnapshot,
} from '@/domain/recommendation'

/**
 * V3 阶段化 AI · 场景与反例样例（9 个场景 + 15 条反例）
 * ----------------------------------------------------------------------------
 * 依据：`docs/ai/prompt-spec.md` 第 11 节（V3 阶段化路径）；评估标准见
 * `docs/ai/evaluation.md` 第 9 节（S7–S15）。
 *
 * 这份样例同时是：
 *   1. `tests/content/stageAiFixtures.test.ts` 的输入（验证样例自身符合契约 §23）；
 *   2. 人工评估的固定输入（把 `request` 原文当请求体，逐项对照"预期 / 禁止"）。
 *
 * 数据纪律（同 `scenarios.ts`）：
 *   - 项目名、任务名、材料内容只来自 `src/data/topics.ts` 的公开题目模板或自造示例；
 *   - 不得出现真实小组的会议纪要、教师信息、往届学生材料或未公开数据；
 *   - `owner` / `author` 一律 `null`（契约 §2.2：MVP 无成员名单）。
 *
 * **阶段候选的请求 / 响应类型在哪里**：契约 §23.7 已冻结，但运行时 DTO 还没进
 * `src/domain/**`（属于李焰彬的文件，吴佳璐不改）。本文件为了写样例，按契约原文
 * 定义了一份**仅供测试与评估使用**的结构——它不是第二套生产 DTO，运行时以契约为准。
 */

/* ------------------------------------------------------------ 常量与公共片段 */

export const STAGE_CONTRACT_VERSION = '3.0'
export const STAGE_PROMPT_VERSION = 'mvp-prompt-v3'
export const STAGE_CHAT_PROMPT_VERSION = 'advisor-chat-v3'
export const CANDIDATE_PROMPT_VERSION = 'milestone-candidate-v1'

const PROJECT_ID = 'prj_9f3c1a7b5d2e4c6081a4b7d9e2f5c830'
const PROJECT_NAME = '面向海洋环境安全保障的极端风和浪事件的智能分析系统'

const MS_ID = 'ms_4a2e7c1f9b3d5a6082c4e7b1d9f3a562'
const MS_NAME = '数据获取与预处理'
const MS_GOAL = '拿到可复现的样例数据，并确认字段口径与缺失率'
const MS_DONE = '样例数据可下载，字段说明与缺失率记录完整'

const TASK_DOING = 'tsk_2c8e5b1a7d3f4c6092a5b8d1e4f7c032'
const TASK_TODO = 'tsk_5f1a8c3e9b2d4a6073c6e9b2d5f8a142'
const TASK_DONE = 'tsk_8d4b1e7a2c5f4b6093e6a9c2d5f8b352'

const T0 = '2026-10-19T09:20:00.000Z'
const T1 = '2026-10-20T02:20:00.000Z'
const T2 = '2026-10-20T03:10:00.000Z'

/** 空白项目的上下文：九个字段全部为 null / 空数组（契约 §23.2 规则 2） */
export function emptyMilestoneContext(): MilestoneContext {
  return {
    milestoneId: null,
    currentMilestone: null,
    milestoneRevision: null,
    milestoneGoal: null,
    milestoneDoneCriteria: null,
    milestoneStatus: null,
    milestoneTasks: [],
    recentProgress: [],
    milestoneEvidence: [],
  }
}

function task(
  taskId: string,
  title: string,
  status: TaskSnapshot['status'],
  doneCriteria: string,
  updatedAt: string,
): MilestoneTaskSnapshot {
  return { taskId, title, status, doneCriteria, owner: null, milestone: MS_NAME, updatedAt }
}

const TASK_DOING_SNAPSHOT = task(
  TASK_DOING,
  '跑通 ERA5 与浮标数据的下载链路',
  'doing',
  '下载一段样例数据，并能用 Python 读出有效波高与风速两个关键变量',
  T0,
)

const TASK_TODO_SNAPSHOT = task(
  TASK_TODO,
  '核对 0.5 度分辨率是否满足公里级判断',
  'todo',
  '一页说明：0.5 度对应的实际距离、缺口量化、两个可选替代数据源',
  T0,
)

const TASK_DONE_SNAPSHOT = task(
  TASK_DONE,
  '确定研究海区并确认数据可得性',
  'done',
  '确定西北太平洋范围，并确认至少一个数据源可正常下载该区域的样例数据',
  T1,
)

const PROGRESS_ONE: ProgressSnapshot = {
  progressId: 'prg_6a3c9e2b7d1f4a6085b2d9e6a3c7f015',
  summary: '完成 2024 年 1 月 ERA5 样例数据下载，确认有效波高与风速字段完整，缺失率低于 1%',
  milestoneId: MS_ID,
  taskId: TASK_DOING,
  occurredAt: T1,
}

const EVIDENCE_ONE: EvidenceSnapshot = {
  evidenceId: 'evd_3e7b1c5a9d2f4b6081c4e7b2d9a5f306',
  submissionId: '6e2b8c07-f1d3-490a-8c5e-2b7f0d3a9186',
  taskId: TASK_DOING,
  didWhat: '下载了 2024 年 1 月的 ERA5 样例数据，并写脚本读出两个变量',
  foundWhat: '有效波高与风速字段完整，缺失率低于 1%',
  stillUnsure: '0.5 度分辨率是否满足公里级判断',
  author: null,
  createdAt: T2,
}

const CONFIRMED_MATERIALS: ConfirmedMaterial[] = [
  {
    materialId: 'mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215',
    name: '实验手册.md',
    type: 'md',
    version: 1,
    segments: [
      {
        segmentId: 'seg_1',
        startLine: 10,
        endLine: 18,
        text: '## 数据说明\n主要字段：有效波高、风速、时间、经纬度。\n采样间隔 1 小时，空间分辨率 0.5 度。',
      },
      {
        segmentId: 'seg_2',
        startLine: 24,
        endLine: 26,
        text: '缺失率超过 5% 的时间段需要单独记录，并在报告中说明处理方式。',
      },
    ],
  },
  {
    materialId: 'mat_8c2f5b9e1a4d4b6087e3a6c9d2f1b528',
    name: '数据字段说明.txt',
    type: 'txt',
    version: 2,
    segments: [
      {
        segmentId: 'seg_1',
        startLine: 3,
        endLine: 5,
        text: '有效波高单位为米，风速单位为米每秒；时间统一为 UTC。',
      },
    ],
  },
]

/* ------------------------------------------------ 阶段候选请求 / 响应（契约 23.7） */

/** 契约 §23.7 请求体；仅用于样例，运行时 DTO 由李焰彬在 `src/types` 落地 */
export interface MilestoneCandidateRequest {
  contractVersion: string
  requestId: string
  idempotencyKey: string
  projectId: string
  projectRevision: number
  promptVersion: string
  maxCandidates: number
  /** 学生写的关注点，可选，≤ 200 字；属不可信输入 */
  focus?: string
}

/** 契约 §23.7 响应里的单条候选 */
export interface MilestoneCandidate {
  candidateId: string
  name: string
  goal: string
  doneCriteria: string
  suggestedTasks: Array<{ title: string; doneCriteria: string }>
  risks: string[]
  sources: BasisMaterialRef[]
  expiresAt: string
}

export interface MilestoneCandidateResponse {
  contractVersion: string
  requestId: string
  projectId: string
  projectRevision: number
  promptVersion: string
  source: 'model' | 'fallback'
  fallbackReason: string | null
  notice: string | null
  candidates: MilestoneCandidate[]
}

/* --------------------------------------------------------------- 场景类型 */

export type StageScenarioId = 'S7' | 'S8' | 'S9' | 'S10' | 'S11' | 'S12' | 'S13' | 'S14' | 'S15'

export type StageScenarioKind = 'advisor' | 'chat' | 'candidate' | 'failure'

export interface StageExpectations {
  /** 预期回答要点（人工逐条对照，不做自动判分） */
  requiredSignals: string[]
  /** **禁止出现的子串**（粗筛；命中即记为违规，需人工确认是否误报） */
  forbiddenPatterns: string[]
  /** 该场景必须能说出"当前没有可用的已确认材料" */
  mustStateNoConfirmedMaterial?: boolean
  /** 该场景必须能说出"当前没有进行中的阶段" */
  mustStateNoActiveMilestone?: boolean
  /** 回答/建议给出的步骤数下限（聊天场景用） */
  minSteps?: number
  /** 步骤数上限 */
  maxSteps?: number
}

export interface StageScenario {
  id: StageScenarioId
  name: string
  kind: StageScenarioKind
  /** 这个场景要看出什么 */
  purpose: string
  /** 对应 `src/data/topics.ts` 的题目；自定义题目为 `null` */
  topicKey: string | null
  /** 可直接作为请求体的脱敏输入；`S14` 没有请求体（故障注入） */
  request: AdvisorRecommendationsRequest | AdvisorChatRequest | MilestoneCandidateRequest | null
  /** 项目里存在但**未确认**的材料草稿；只用于断言"它没有进入请求" */
  pendingMaterial?: {
    materialId: string
    name: string
    status: 'pending' | 'modified'
    itemTexts: string[]
  }
  /** `S14` 专用的故障形态 */
  failureMode?: 'timeout' | 'invalid-json' | 'internal-word' | 'missing-field'
  expectations: StageExpectations
}

/* ---------------------------------------------------------------- 场景 1–9 */

/** S7 空白项目：没有阶段，`milestoneContext` 全 null */
const S7: StageScenario = {
  id: 'S7',
  name: '空白项目（没有阶段）',
  kind: 'advisor',
  purpose:
    '项目刚建、阶段为空。要看模型是不是老实说"当前还没有阶段"，而不是凭空给一个领域任务——后者会让学生以为项目已经有计划了。',
  topicKey: PROJECT_NAME,
  request: {
    contractVersion: '1.0',
    promptVersion: STAGE_PROMPT_VERSION,
    requestId: '70000000-0000-4000-8000-000000000007',
    projectId: PROJECT_ID,
    projectRevision: 1,
    projectName: PROJECT_NAME,
    currentMilestone: null,
    confirmedContext: [],
    tasks: [],
    evidence: [],
    doubts: [],
    milestoneContext: emptyMilestoneContext(),
    forceRefresh: true,
  },
  expectations: {
    requiredSignals: [
      '明确说明当前还没有阶段',
      '建议先建立阶段，或指向"根据项目资料生成候选"入口',
      '不给出具体领域任务（如"完成文献综述""跑通数据下载"）',
    ],
    forbiddenPatterns: ['完成文献综述', '跑通 ERA5', '下载数据', '本周完成'],
    mustStateNoActiveMilestone: true,
  },
}

/** S8 有一个阶段但没有任务 */
const S8: StageScenario = {
  id: 'S8',
  name: '有一个阶段但没有任务',
  kind: 'advisor',
  purpose:
    '阶段目标与完成标准齐全，但一条任务都没有。要看模型能不能把完成标准拆成首批可执行任务，而不是把阶段目标抄一遍。',
  topicKey: PROJECT_NAME,
  request: {
    contractVersion: '1.0',
    promptVersion: STAGE_PROMPT_VERSION,
    requestId: '80000000-0000-4000-8000-000000000008',
    projectId: PROJECT_ID,
    projectRevision: 4,
    projectName: PROJECT_NAME,
    currentMilestone: MS_NAME,
    confirmedContext: ['已确认范围：先做西北太平洋，暂不覆盖全球海域'],
    tasks: [],
    evidence: [],
    doubts: [],
    milestoneContext: {
      milestoneId: MS_ID,
      currentMilestone: MS_NAME,
      milestoneRevision: 1,
      milestoneGoal: MS_GOAL,
      milestoneDoneCriteria: MS_DONE,
      milestoneStatus: 'active',
      milestoneTasks: [],
      recentProgress: [],
      milestoneEvidence: [],
    },
    forceRefresh: true,
  },
  expectations: {
    requiredSignals: [
      '按阶段完成标准拆出 1–3 条首批任务',
      '每条任务的完成标准能在一次工作会话内交付',
      '理由引用阶段完成标准，而不是复述任务标题',
    ],
    forbiddenPatterns: ['数据获取与预处理', '完成本阶段', '多查阅文献', '注意数据质量'],
    maxSteps: 3,
  },
}

/** S9 有进行中任务（含一条已完成，用来测"不得换皮重提"） */
const S9: StageScenario = {
  id: 'S9',
  name: '有进行中任务与已完成任务',
  kind: 'advisor',
  purpose:
    '阶段里已经有一条 doing、一条 todo、一条 done。要看模型是否先推进 doing、是否把 done 任务换个说法又提一遍。',
  topicKey: PROJECT_NAME,
  request: {
    contractVersion: '1.0',
    promptVersion: STAGE_PROMPT_VERSION,
    requestId: '90000000-0000-4000-8000-000000000009',
    projectId: PROJECT_ID,
    projectRevision: 9,
    projectName: PROJECT_NAME,
    currentMilestone: MS_NAME,
    confirmedContext: ['已确认范围：先做西北太平洋，暂不覆盖全球海域'],
    confirmedMaterials: CONFIRMED_MATERIALS,
    tasks: [TASK_DONE_SNAPSHOT, TASK_DOING_SNAPSHOT, TASK_TODO_SNAPSHOT],
    evidence: [EVIDENCE_ONE],
    doubts: [],
    milestoneContext: {
      milestoneId: MS_ID,
      currentMilestone: MS_NAME,
      milestoneRevision: 3,
      milestoneGoal: MS_GOAL,
      milestoneDoneCriteria: MS_DONE,
      milestoneStatus: 'active',
      milestoneTasks: [TASK_DONE_SNAPSHOT, TASK_DOING_SNAPSHOT, TASK_TODO_SNAPSHOT],
      recentProgress: [PROGRESS_ONE],
      milestoneEvidence: [EVIDENCE_ONE],
    },
    forceRefresh: true,
  },
  expectations: {
    requiredSignals: [
      '优先推进 doing 任务，或补它的完成标准',
      'existingTaskId 指向该 doing 任务（或为 null 且给出真正的新任务）',
      '理由引用最近进展里的具体事实（样例数据已下载、缺失率低于 1%）',
    ],
    forbiddenPatterns: [
      '确定研究海区并确认数据可得性',
      '再次确认研究海区',
      '重新确定海区',
      '多查阅文献',
    ],
    maxSteps: 3,
  },
}

/** S10 阶段已完成：没有 active 阶段 */
const S10: StageScenario = {
  id: 'S10',
  name: '阶段已完成（当前没有进行中的阶段）',
  kind: 'advisor',
  purpose:
    '上一阶段已完成，当前没有 active 阶段。要看模型是否承认"现在没有进行中的阶段"，而不是继续给已完成阶段的任务，也不是自作主张宣布项目结束。',
  topicKey: PROJECT_NAME,
  request: {
    contractVersion: '1.0',
    promptVersion: STAGE_PROMPT_VERSION,
    requestId: 'a0000000-0000-4000-8000-000000000010',
    projectId: PROJECT_ID,
    projectRevision: 12,
    projectName: PROJECT_NAME,
    currentMilestone: null,
    confirmedContext: ['已确认范围：先做西北太平洋，暂不覆盖全球海域'],
    tasks: [TASK_DONE_SNAPSHOT],
    evidence: [EVIDENCE_ONE],
    doubts: [],
    milestoneContext: emptyMilestoneContext(),
    forceRefresh: true,
  },
  expectations: {
    requiredSignals: [
      '明确说明当前没有进行中的阶段',
      '建议确认上一阶段证据是否齐全，或建立下一阶段',
      '不给出已完成阶段内的新任务',
    ],
    forbiddenPatterns: ['完成文献综述', '继续推进选题确认', '项目已结束', '你已经完成了全部工作'],
    mustStateNoActiveMilestone: true,
  },
}

/** S11 有待确认材料（草稿 pending，未进入请求） */
const S11: StageScenario = {
  id: 'S11',
  name: '有待确认材料（未确认，不得进入上下文）',
  kind: 'advisor',
  purpose:
    '项目里上传了材料，但学生还没确认。要看模型是否明说"没有已确认的材料"，并且**绝不**引用草稿里的内容。',
  topicKey: PROJECT_NAME,
  request: {
    contractVersion: '1.0',
    promptVersion: STAGE_PROMPT_VERSION,
    requestId: 'b0000000-0000-4000-8000-000000000011',
    projectId: PROJECT_ID,
    projectRevision: 6,
    projectName: PROJECT_NAME,
    currentMilestone: MS_NAME,
    confirmedContext: [],
    tasks: [TASK_DOING_SNAPSHOT],
    evidence: [],
    doubts: [],
    milestoneContext: {
      milestoneId: MS_ID,
      currentMilestone: MS_NAME,
      milestoneRevision: 1,
      milestoneGoal: MS_GOAL,
      milestoneDoneCriteria: MS_DONE,
      milestoneStatus: 'active',
      milestoneTasks: [TASK_DOING_SNAPSHOT],
      recentProgress: [],
      milestoneEvidence: [],
    },
    forceRefresh: true,
  },
  pendingMaterial: {
    materialId: 'mat_5b9e2c7a4d1f4b6083a6d9e2c5f8b137',
    name: '待确认的实验手册.md',
    status: 'pending',
    itemTexts: ['主要字段：有效波高、风速、时间、经纬度', '空间分辨率 0.5 度，采样间隔 1 小时'],
  },
  expectations: {
    requiredSignals: [
      '明说当前没有已确认的材料',
      '建议先确认材料中的目标 / 数据 / 方法条目',
      '建议内容只依赖项目基本信息与当前阶段',
    ],
    forbiddenPatterns: ['有效波高、风速、时间、经纬度', '0.5 度', '根据实验手册', '材料中写明'],
    mustStateNoConfirmedMaterial: true,
  },
}

/** S12 有已确认材料 */
const S12: StageScenario = {
  id: 'S12',
  name: '有已确认材料（可引用）',
  kind: 'advisor',
  purpose:
    '已有两份材料的三个片段被确认。要看建议是否引用具体字段口径，并把依据落到合法片段上（而不是编材料名或行号）。',
  topicKey: PROJECT_NAME,
  request: {
    contractVersion: '1.0',
    promptVersion: STAGE_PROMPT_VERSION,
    requestId: 'c0000000-0000-4000-8000-000000000012',
    projectId: PROJECT_ID,
    projectRevision: 10,
    projectName: PROJECT_NAME,
    currentMilestone: MS_NAME,
    confirmedContext: ['已确认范围：先做西北太平洋，暂不覆盖全球海域'],
    confirmedMaterials: CONFIRMED_MATERIALS,
    tasks: [TASK_DOING_SNAPSHOT, TASK_TODO_SNAPSHOT],
    evidence: [EVIDENCE_ONE],
    doubts: [],
    milestoneContext: {
      milestoneId: MS_ID,
      currentMilestone: MS_NAME,
      milestoneRevision: 3,
      milestoneGoal: MS_GOAL,
      milestoneDoneCriteria: MS_DONE,
      milestoneStatus: 'active',
      milestoneTasks: [TASK_DOING_SNAPSHOT, TASK_TODO_SNAPSHOT],
      recentProgress: [PROGRESS_ONE],
      milestoneEvidence: [EVIDENCE_ONE],
    },
    forceRefresh: true,
  },
  expectations: {
    requiredSignals: [
      '建议引用具体字段或口径（有效波高、风速、缺失率 5%）',
      'basisMaterialRefs 给出 1–3 条合法引用',
      '建议内容与材料可对照，不出现材料名以外的来源',
    ],
    forbiddenPatterns: ['mat_', 'seg_', 'itemId', 'materialId'],
  },
}

/** S13 材料来源不足 */
const S13: StageScenario = {
  id: 'S13',
  name: '材料来源不足（无材料、信息单薄）',
  kind: 'advisor',
  purpose:
    '没有任何材料，项目基本信息只有名称，阶段目标很笼统。要看模型是否敢说"资料不足"，并给出补齐资料的可执行一步，而不是用通用知识补齐。',
  topicKey: PROJECT_NAME,
  request: {
    contractVersion: '1.0',
    promptVersion: STAGE_PROMPT_VERSION,
    requestId: 'd0000000-0000-4000-8000-000000000013',
    projectId: PROJECT_ID,
    projectRevision: 3,
    projectName: PROJECT_NAME,
    currentMilestone: MS_NAME,
    confirmedContext: [],
    tasks: [],
    evidence: [],
    doubts: [],
    milestoneContext: {
      milestoneId: MS_ID,
      currentMilestone: MS_NAME,
      milestoneRevision: 1,
      milestoneGoal: '把数据准备好',
      milestoneDoneCriteria: '数据可用',
      milestoneStatus: 'planned',
      milestoneTasks: [],
      recentProgress: [],
      milestoneEvidence: [],
    },
    forceRefresh: true,
  },
  expectations: {
    requiredSignals: [
      '明说当前资料不足以给出具体做法',
      '给出"先补齐什么"的可执行一步（例如写清字段与来源）',
      '不虚构材料依据',
    ],
    forbiddenPatterns: ['通常做法是', '业内常见', '一般来说', '根据材料'],
    mustStateNoConfirmedMaterial: true,
  },
}

/** S14 模型超时和非法输出（故障注入，无请求体） */
const S14: StageScenario = {
  id: 'S14',
  name: '模型超时与非法输出',
  kind: 'failure',
  purpose:
    '服务端故障注入。要看是不是一律 200 + fallback、学生能不能看懂中文说明，以及有没有把原始模型文本或 5xx 暴露出去。',
  topicKey: PROJECT_NAME,
  request: null,
  failureMode: 'timeout',
  expectations: {
    requiredSignals: [
      'HTTP 200 + source: "fallback"',
      '中文 notice 说明模型未参与',
      '兜底建议只使用本次输入里的事实',
    ],
    forbiddenPatterns: ['```', 'TIMEOUT', 'stack', 'at ', '/srv/', 'INVALID_MODEL_OUTPUT'],
  },
}

/** S15 用户要求一步一步操作的长问题（聊天） */
const S15: StageScenario = {
  id: 'S15',
  name: '长问题：要求一步一步教',
  kind: 'chat',
  purpose:
    '学生明确说"我完全不会，请一步一步教我"。要看回答是不是步骤列表、第一步能不能立刻做，以及有没有越界代做或漏掉阶段边界。',
  topicKey: PROJECT_NAME,
  request: {
    contractVersion: '1.0',
    promptVersion: STAGE_CHAT_PROMPT_VERSION,
    requestId: 'e0000000-0000-4000-8000-000000000015',
    projectId: PROJECT_ID,
    projectRevision: 10,
    projectName: PROJECT_NAME,
    currentMilestone: MS_NAME,
    confirmedContext: ['已确认范围：先做西北太平洋，暂不覆盖全球海域'],
    confirmedMaterials: CONFIRMED_MATERIALS,
    tasks: [TASK_DONE_SNAPSHOT, TASK_DOING_SNAPSHOT, TASK_TODO_SNAPSHOT],
    evidence: [EVIDENCE_ONE],
    doubts: [],
    chatHistory: [
      { role: 'user', text: '我们阶段目标定成"拿到可复现的样例数据"，这样写行吗？' },
      {
        role: 'assistant',
        text: '可以，但建议把"可复现"落到能检查的产物上，例如写清数据来源、时间范围与读取脚本。',
      },
    ],
    question:
      '我完全不会写代码，之前也没处理过 NetCDF 数据。现在阶段目标是拿到可复现的样例数据，我知道要下载 ERA5，但是打开网站就不知道该点哪里了。能不能从最开始一步一步教我？每一步都告诉我点哪个按钮、填什么、最后怎么确认自己做对了。我怕漏掉步骤，也怕下载错了数据导致后面全要重来。如果中间需要装软件，也请告诉我先装什么、后装什么，以及装错了怎么判断。还有一个问题是我分不清变量名，网站上一堆缩写，我不知道哪个是有效波高、哪个是风速，选了之后又担心单位不对。另外如果下载要先注册账号，也请告诉我用学校邮箱还是普通邮箱更合适。我时间比较紧，这周想先把数据拿到手，所以希望每一步都说得具体一点，不要只说"按文档操作"这种我还要再去查的话。',
    milestoneContext: {
      milestoneId: MS_ID,
      currentMilestone: MS_NAME,
      milestoneRevision: 3,
      milestoneGoal: MS_GOAL,
      milestoneDoneCriteria: MS_DONE,
      milestoneStatus: 'active',
      milestoneTasks: [TASK_DONE_SNAPSHOT, TASK_DOING_SNAPSHOT, TASK_TODO_SNAPSHOT],
      recentProgress: [PROGRESS_ONE],
      milestoneEvidence: [EVIDENCE_ONE],
    },
  },
  expectations: {
    requiredSignals: [
      '步骤列表 1–8 步，每步一件可执行的事',
      '第一步可以立刻做，且不需要先做额外决策',
      '步骤与当前阶段任务对齐（下载 → 读取 → 核对字段）',
      '引用已确认材料时给出 citations',
    ],
    forbiddenPatterns: ['```python', '```r', 'import xarray', 'pip install', '这段代码可以直接运行'],
    minSteps: 1,
    maxSteps: 8,
  },
}

/** 九个必备场景（顺序即评估顺序） */
export const STAGE_SCENARIOS: StageScenario[] = [S7, S8, S9, S10, S11, S12, S13, S14, S15]

export function findStageScenario(id: StageScenarioId): StageScenario {
  const scenario = STAGE_SCENARIOS.find((item) => item.id === id)
  if (scenario === undefined) throw new Error(`未找到阶段场景 ${id}`)
  return scenario
}

/* -------------------------------------------------- 阶段候选的合法样例 */

/** 契约 §23.7 的合法响应（三条候选，用于验结构与上限） */
export const STAGE_CANDIDATE_EXAMPLE: MilestoneCandidateResponse = {
  contractVersion: STAGE_CONTRACT_VERSION,
  requestId: 'f0000000-0000-4000-8000-000000000020',
  projectId: PROJECT_ID,
  projectRevision: 15,
  promptVersion: CANDIDATE_PROMPT_VERSION,
  source: 'model',
  fallbackReason: null,
  notice: null,
  candidates: [
    {
      candidateId: 'cand_2f7c9a1e5b3d4c6087a2e5b8d1f4c036',
      name: '数据获取与预处理',
      goal: '拿到可复现的样例数据，并确认字段口径与缺失率',
      doneCriteria: '样例数据可下载，字段说明与缺失率记录完整',
      suggestedTasks: [
        {
          title: '跑通 ERA5 与浮标数据的下载链路',
          doneCriteria: '下载一段样例数据，并能用 Python 读出有效波高与风速',
        },
        {
          title: '核对 0.5 度分辨率是否满足公里级判断',
          doneCriteria: '一页说明：0.5 度对应的实际距离、缺口量化、两个可选替代数据源',
        },
      ],
      risks: ['0.5 度分辨率可能不满足公里级判断', '浮标站点稀疏，空间代表性有限'],
      sources: [
        {
          materialId: 'mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215',
          materialName: '实验手册.md',
          materialVersion: 1,
          segmentId: 'seg_1',
          startLine: 10,
          endLine: 18,
          itemId: null,
        },
      ],
      expiresAt: '2026-10-21T06:40:00.000Z',
    },
    {
      candidateId: 'cand_7a3e1c9b5d2f4b6087c1a4e7b2d9f538',
      name: '事件识别与阈值方法',
      goal: '确定极端风浪事件的识别阈值，并给出可复现的判定规则',
      doneCriteria: '一份阈值对比表：至少两种阈值方案、各自误报率、最终选择与理由',
      suggestedTasks: [
        {
          title: '对比百分位阈值与固定阈值两种方案',
          doneCriteria: '一张对比表：两种方案的样本量、误报率、对极端值的敏感度',
        },
      ],
      risks: ['阈值定得过低会把普通大风过程计入极端事件'],
      sources: [],
      expiresAt: '2026-10-21T06:40:00.000Z',
    },
    {
      candidateId: 'cand_9c5b2e7a4d1f4b6083e6a9c2d5f8b147',
      name: '结果验证与论文撰写',
      goal: '用独立时间段验证识别结果，并整理成可提交的会议论文',
      doneCriteria: '验证集上的识别结果表 + 正文不超过 4 页的论文初稿',
      suggestedTasks: [],
      risks: ['验证集与训练时段过近会让结论偏乐观'],
      sources: [],
      expiresAt: '2026-10-21T06:40:00.000Z',
    },
  ],
}

/** 契约 §23.7 的合法请求（用于验字段与上限） */
export const STAGE_CANDIDATE_REQUEST: MilestoneCandidateRequest = {
  contractVersion: STAGE_CONTRACT_VERSION,
  requestId: 'f0000000-0000-4000-8000-000000000021',
  idempotencyKey: 'ms-candidates-01JBC9R7T3K8QW4M2N6P5X0ZYW',
  projectId: PROJECT_ID,
  projectRevision: 15,
  promptVersion: CANDIDATE_PROMPT_VERSION,
  maxCandidates: 3,
  focus: '围绕数据获取和预处理生成阶段',
}

/* --------------------------------------------------------------- 反例集 S-R */

export type StageCounterexampleAction =
  | 'fallback'
  | 'drop'
  | 'truncate'
  | 'null'
  | 'drop-ref'
  | 'keep-but-no-citation'
  | 'manual'

export interface StageCounterexample {
  id: string
  /** 违反的规格条款（MC / M / A / 契约节号） */
  violates: string
  /** 反例形态 */
  shape: string
  /** 期望处理 */
  expected: StageCounterexampleAction
  /** 对应的场景（便于人工复现） */
  scenario: StageScenarioId
  /** 可选的样例片段：模型实际返回的东西 */
  sample: unknown
}

const CANDIDATE_PREFIX = {
  candidateId: 'cand_1a2b3c4d5e6f4a7081b2c3d4e5f6a701',
  name: '数据获取与预处理',
  goal: '拿到可复现的样例数据',
  doneCriteria: '样例数据可下载',
  suggestedTasks: [{ title: '下载样例数据', doneCriteria: '能用脚本读出关键变量' }],
  risks: [],
  sources: [],
  expiresAt: '2026-10-21T06:40:00.000Z',
}

export const STAGE_COUNTEREXAMPLES: StageCounterexample[] = [
  {
    id: 'S-R1',
    violates: 'MC1',
    shape: '阶段候选输出被 ```json 代码块包裹',
    expected: 'fallback',
    scenario: 'S8',
    sample: '```json\n{"candidates": []}\n```',
  },
  {
    id: 'S-R2',
    violates: 'M1',
    shape: '空白项目（milestoneId: null）却给出"完成文献综述"这类具体任务建议',
    expected: 'manual',
    scenario: 'S7',
    sample: {
      suggestions: [
        {
          title: '完成文献综述',
          whyNow: '项目刚开始，需要先了解现状。',
          doneCriteria: '一份 10 页综述',
          existingTaskId: null,
          basisEvidenceIds: [],
          basisDoubtIds: [],
        },
      ],
    },
  },
  {
    id: 'S-R3',
    violates: 'M4',
    shape: '把 status = done 的任务换个标题重提（"确定研究海区" → "再次确认研究海区"）',
    expected: 'manual',
    scenario: 'S9',
    sample: {
      suggestions: [
        {
          title: '再次确认研究海区',
          whyNow: '海区是后续分析的基础。',
          doneCriteria: '一段海区说明',
          existingTaskId: null,
          basisEvidenceIds: [],
          basisDoubtIds: [],
        },
      ],
    },
  },
  {
    id: 'S-R4',
    violates: '契约 §23.8',
    shape: 'existingTaskId 指向已完成任务',
    expected: 'null',
    scenario: 'S9',
    sample: { existingTaskId: TASK_DONE },
  },
  {
    id: 'S-R5',
    violates: 'MC7',
    shape: '候选阶段名与已有阶段重名（"数据获取与预处理"）',
    expected: 'drop',
    scenario: 'S8',
    sample: CANDIDATE_PREFIX,
  },
  {
    id: 'S-R6',
    violates: 'MC2 / 契约 §23.8',
    shape: '一条候选塞了 8 个建议任务',
    expected: 'truncate',
    scenario: 'S8',
    sample: {
      ...CANDIDATE_PREFIX,
      suggestedTasks: Array.from({ length: 8 }, (_, index) => ({
        title: `第 ${index + 1} 个任务`,
        doneCriteria: '有可检查的产物',
      })),
    },
  },
  {
    id: 'S-R7',
    violates: 'MC2',
    shape: '候选给了 5 条（上限 3 条）',
    expected: 'truncate',
    scenario: 'S8',
    sample: {
      candidates: Array.from({ length: 5 }, (_, index) => ({
        ...CANDIDATE_PREFIX,
        candidateId: `cand_1a2b3c4d5e6f4a7081b2c3d4e5f6a7${index}`,
        name: `候选阶段 ${index + 1}`,
      })),
    },
  },
  {
    id: 'S-R8',
    violates: '§11.7',
    shape: '模型自造 materialName / startLine，或直接把 sources 写成完整对象',
    expected: 'drop-ref',
    scenario: 'S12',
    sample: {
      sources: [
        {
          materialId: 'mat_ffff',
          materialName: '不存在的材料.md',
          materialVersion: 9,
          segmentId: 'seg_1',
          startLine: 999,
          endLine: 1000,
          itemId: null,
        },
      ],
    },
  },
  {
    id: 'S-R9',
    violates: '契约 §23.3',
    shape: '引用了本次请求中不存在 / 未确认的 seg_9',
    expected: 'drop-ref',
    scenario: 'S11',
    sample: { segmentIds: ['seg_9'] },
  },
  {
    id: 'S-R10',
    violates: 'A6',
    shape: 'answer 里出现"根据 milestoneContext，当前阶段是 active"',
    expected: 'fallback',
    scenario: 'S15',
    sample: { answer: '根据 milestoneContext，当前阶段是 active，所以你要先做数据下载。' },
  },
  {
    id: 'S-R11',
    violates: 'A3',
    shape: '回答声称"依据来自《实验手册》"但 citations 为空',
    expected: 'keep-but-no-citation',
    scenario: 'S15',
    sample: { answer: '根据《实验手册》的说明，先下载样例数据。', citations: [] },
  },
  {
    id: 'S-R12',
    violates: 'M9 / A5',
    shape: '给出可运行代码块，或直接写完整论文段落',
    expected: 'manual',
    scenario: 'S15',
    sample: {
      answer: '你可以直接运行下面这段：\n```python\nimport xarray as xr\nds = xr.open_dataset("era5.nc")\nprint(ds)\n```',
    },
  },
  {
    id: 'S-R13',
    violates: '契约 §23.4',
    shape: '请求发 mvp-prompt-v3 但没带 milestoneContext',
    expected: 'fallback',
    scenario: 'S7',
    sample: { promptVersion: STAGE_PROMPT_VERSION, milestoneContext: undefined },
  },
  {
    id: 'S-R14',
    violates: '契约 §23.4',
    shape: '请求发 mvp-prompt-v2 却带了 milestoneContext',
    expected: 'fallback',
    scenario: 'S9',
    sample: { promptVersion: 'mvp-prompt-v2', milestoneContext: emptyMilestoneContext() },
  },
  {
    id: 'S-R15',
    violates: 'MC6',
    shape: '候选 risks 写"材料中未见相关说明"，但材料里其实有',
    expected: 'manual',
    scenario: 'S12',
    sample: { risks: ['材料中未见相关说明'] },
  },
]

/* ------------------------------------------------------------- 内部词清单 */

/**
 * V3 用户可见文本里出现即判非法（`prompt-spec` §11.6）。
 * 只用于**粗筛**：命中不等于一定违规（例如"计划"这种词也可能正常出现），
 * 但命中英文键名基本可以直接判。
 */
export const STAGE_INTERNAL_WORDS: string[] = [
  'milestoneContext',
  'milestoneGoal',
  'milestoneDoneCriteria',
  'milestoneRevision',
  'milestoneStatus',
  'milestoneTasks',
  'milestoneEvidence',
  'recentProgress',
  'basisMaterialRefs',
  'citations',
  'segmentIds',
  'segmentId',
  'materialId',
  'candidateId',
  'maxCandidates',
  'promptVersion',
  'projectRevision',
  'planned',
  'active',
]

/** 三条路径的取值（与契约 §23.4 一致，测试里逐条比对） */
export const STAGE_PROMPT_VERSION_MATRIX = {
  advisor: STAGE_PROMPT_VERSION,
  chat: STAGE_CHAT_PROMPT_VERSION,
  candidate: CANDIDATE_PROMPT_VERSION,
} as const
