import type { AdvisorRecommendationsRequest } from '@/domain/recommendation'

/**
 * 建议接口 · 脱敏场景样例（6 类）
 * ----------------------------------------------------------------------------
 * 依据：`docs/ai/prompt-spec.md` §3.5；人工验收标准见 `docs/ai/evaluation.md`。
 *
 * 这些样例同时是：
 *   1. `tests/content/**` 的输入（用来验证样例自身符合契约 §4.1 的字段与上限）；
 *   2. 人工评估的固定输入（把 `request` 原文粘贴到评估记录里，逐项打分）。
 *
 * 数据纪律（`docs/ai/prompt-spec.md` §3.5）：
 *   - 项目名、任务名、证据内容只来自 `src/data/topics.ts` 的公开题目模板，
 *     或本节自造的通用示例；
 *   - **不得出现任何真实小组的会议纪要、教师信息、往届学生材料或未公开数据**；
 *   - 所有 `owner` / `author` 一律 `null`（契约 §2.2：MVP 无成员名单）。
 *
 * `doubts` 只放 `status: 'open'`，`tasks` 放全量（含 `done`）——这是契约 §9 差异 14 的规定，
 * 也是「已完成任务不得再推荐」能被服务端执行的前提。
 */

export type AiScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

export interface AiScenario {
  /** 场景编号，与 `docs/ai/evaluation.md` 的表一致 */
  id: AiScenarioId
  /** 场景名 */
  name: string
  /** 这个场景要看出什么 */
  purpose: string
  /** 对应 `src/data/topics.ts` 的题目；自定义题目为 `null` */
  topicKey: string | null
  /** 可直接作为请求体的脱敏输入（`requestId` 固定，便于复现） */
  request: AdvisorRecommendationsRequest
  expectations: AiScenarioExpectations
}

export interface AiScenarioExpectations {
  /**
   * 人工验收时必须看到的具体方法 / 工具 / 数据产品（`prompt-spec` §6.3 的锚点）。
   * 至少命中 `minDomainHits` 个，否则判 C9（领域具体性）不合格。
   */
  domainAnchors: string[]
  minDomainHits: number
  /** 允许出现在 `existingTaskId` 里的任务 ID */
  claimableTaskIds: string[]
  /** **任何情况下**都不得出现在建议里的任务 ID（已完成的） */
  neverSugggestedTaskIds: string[]
  /** 期望被用上的疑问 ID（新任务候选应带上它作为依据） */
  openDoubtIds: string[]
}

/* ------------------------------------------------------------ 公共片段 */

const CONTRACT_VERSION = '1.0'
const PROMPT_VERSION = 'mvp-prompt-v1'

/** 冻结时间：让样例可复现，不随执行时间漂移 */
const T0 = '2026-09-20T09:00:00+08:00'
const T1 = '2026-09-22T14:20:00+08:00'
const T2 = '2026-09-24T20:05:00+08:00'
const T3 = '2026-09-26T10:40:00+08:00'
const T4 = '2026-09-28T16:15:00+08:00'

/* ------------------------------------------------------------ S1 冷启动 */

const s1: AiScenario = {
  id: 'S1',
  name: '冷启动（刚创建项目）',
  purpose:
    '项目刚建、没有任何证据。要看模型是不是把已有任务收尾排在前面，而不是凭空发明新任务或写「多查阅文献」这类空话。',
  topicKey: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
  request: {
    contractVersion: CONTRACT_VERSION,
    requestId: '11111111-1111-4111-8111-111111111111',
    projectId: 'prj_a1f30c7e5b2d4a6f8c0e3b7d9a1f4c60',
    projectRevision: 2,
    projectName: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
    currentMilestone: '选题确认与文献调研',
    confirmedContext: [
      '项目目标：构建极端风浪事件识别与预警的原型系统，为海上作业安全提供参考',
      '交付内容：可交互原型 + 正文不超过 4 页的会议论文',
      '已确认范围：先做西北太平洋，暂不覆盖全球海域',
    ],
    tasks: [
      {
        taskId: 'tsk_8c41b0e2_0',
        title: '调研极端风浪事件的定义与识别方法',
        status: 'doing',
        doneCriteria: '一页定义笔记：风速/浪高阈值方案 + 事件识别规则 + 文献依据。',
        owner: null,
        milestone: '选题确认与文献调研',
        updatedAt: T1,
      },
      {
        taskId: 'tsk_8c41b0e2_1',
        title: '跑通 ERA5 与浮标数据的下载链路',
        status: 'todo',
        doneCriteria: '成功下载并读取一个样例数据集，输出基本统计。',
        owner: null,
        milestone: '数据获取与预处理',
        updatedAt: T1,
      },
      {
        taskId: 'tsk_8c41b0e2_2',
        title: '明确「面向环境安全保障」的应用落点',
        status: 'todo',
        doneCriteria: '一段应用落点说明 + 对应的 2-3 个核心分析问题。',
        owner: null,
        milestone: '选题确认与文献调研',
        updatedAt: T1,
      },
    ],
    evidence: [],
    doubts: [
      {
        doubtId: 'dbt_8c41b0e2_0',
        text: '「极端」的标准是什么：风速和浪高分别用什么阈值？要不要联合判定？',
        status: 'open',
        sourceEvidenceId: null,
        createdAt: T0,
      },
    ],
    promptVersion: PROMPT_VERSION,
    forceRefresh: false,
  },
  expectations: {
    domainAnchors: ['ERA5', '有效波高', '百分位', 'GEV', 'POT', '浮标'],
    minDomainHits: 2,
    claimableTaskIds: ['tsk_8c41b0e2_0', 'tsk_8c41b0e2_1', 'tsk_8c41b0e2_2'],
    neverSugggestedTaskIds: [],
    openDoubtIds: ['dbt_8c41b0e2_0'],
  },
}

/* -------------------------------------------------------- S2 记录进展 */

const s2: AiScenario = {
  id: 'S2',
  name: '记录进展后（含已解决疑问与一条已完成任务）',
  purpose:
    '刚提交一条带「还不确定」的证据并由此产生疑问。要看：已完成任务绝不再出现；新建议是否吃到了最新证据的具体事实（云遮挡缺测率）。',
  topicKey: '区域海洋表层叶绿素多尺度变化模拟系统',
  request: {
    contractVersion: CONTRACT_VERSION,
    requestId: '22222222-2222-4222-8222-222222222222',
    projectId: 'prj_b2e41d8f6c3a5b7e9d1f0c4a8b6e2d73',
    projectRevision: 7,
    projectName: '区域海洋表层叶绿素多尺度变化模拟系统',
    currentMilestone: '数据获取与云遮挡重建',
    confirmedContext: [
      '项目目标：重建区域表层叶绿素并分析多尺度变化，形成可视化原型',
      '交付内容：可交互原型 + 正文不超过 4 页的会议论文',
      '已确认范围：研究区域初步定为东海近岸，最终以缺测率摸底结果为准',
    ],
    tasks: [
      {
        taskId: 'tsk_2d7b91a4_0',
        title: '明确「模拟」的技术路线',
        status: 'done',
        doneCriteria: '一页路线对比：三条路线的输入、难度、预期效果 + 选定路线。',
        owner: null,
        milestone: '选题确认与文献调研',
        updatedAt: T1,
      },
      {
        taskId: 'tsk_2d7b91a4_1',
        title: '确定研究区域并验证水色数据可获取性',
        status: 'doing',
        doneCriteria: '确定区域范围 + 下载一个月样例数据，统计缺测率。',
        owner: null,
        milestone: '数据获取与云遮挡重建',
        updatedAt: T3,
      },
      {
        taskId: 'tsk_2d7b91a4_2',
        title: '调研「多尺度变化」的常用分析框架',
        status: 'todo',
        doneCriteria: '3-5 篇区域叶绿素研究的尺度划分方式汇总。',
        owner: null,
        milestone: '选题确认与文献调研',
        updatedAt: T1,
      },
    ],
    evidence: [
      {
        evidenceId: 'evd_2d7b91a4_1',
        submissionId: 'b7c9e401-6c2f-4f18-8d5a-0e2b7c4a9f31',
        taskId: 'tsk_2d7b91a4_1',
        didWhat: '下载了 MODIS-Aqua 2026 年 7 月的 L3 月合成叶绿素产品，统计了候选区域的缺测率',
        foundWhat:
          '东海近岸候选区域的月缺测率约 62%，外海一侧降到 28%；缺测集中在长江口外侧的浑浊带。',
        stillUnsure: '近岸缺测率这么高，是先做 DINEOF 重建，还是把区域往外海挪一点更现实？',
        author: null,
        createdAt: T3,
      },
      {
        evidenceId: 'evd_2d7b91a4_0',
        submissionId: 'a1b2c3d4-1111-4222-8333-444455556666',
        taskId: 'tsk_2d7b91a4_0',
        didWhat: '读了三类重建路线的代表文献，做了路线对比表',
        foundWhat: null,
        stillUnsure: null,
        author: null,
        createdAt: T1,
      },
    ],
    doubts: [
      {
        doubtId: 'dbt_2d7b91a4_0',
        text: '近岸缺测率 62%：先做 DINEOF 重建，还是把研究区域往外海调整？',
        status: 'open',
        sourceEvidenceId: 'evd_2d7b91a4_1',
        createdAt: T3,
      },
    ],
    promptVersion: PROMPT_VERSION,
    forceRefresh: false,
  },
  expectations: {
    domainAnchors: ['DINEOF', '缺测率', 'MODIS', 'VIIRS', '浑浊', '云掩膜', 'L3'],
    minDomainHits: 2,
    claimableTaskIds: ['tsk_2d7b91a4_1', 'tsk_2d7b91a4_2'],
    neverSugggestedTaskIds: ['tsk_2d7b91a4_0'],
    openDoubtIds: ['dbt_2d7b91a4_0'],
  },
}

/* -------------------------------------------------------- S3 确认完成 */

const s3: AiScenario = {
  id: 'S3',
  name: '刚确认完成一个任务（没有进行中的任务、没有疑问）',
  purpose:
    '一个里程碑里的任务刚做完，项目里既没有 doing 也没有 open 疑问。要看：不再提刚做完的事，而是落到下一个里程碑的第一条具体任务。',
  topicKey: '深潜救生艇水下航行流体仿真系统',
  request: {
    contractVersion: CONTRACT_VERSION,
    requestId: '33333333-3333-4333-8333-333333333333',
    projectId: 'prj_c3f52e9a7d4b6c8f0a2e1d5b9c7f3e84',
    projectRevision: 11,
    projectName: '深潜救生艇水下航行流体仿真系统',
    currentMilestone: '几何建模与网格划分',
    confirmedContext: [
      '项目目标：完成救生艇典型工况的水动力仿真与结果分析',
      '交付内容：仿真算例 + 结果分析报告 + 可交互原型',
      '已确认范围：工具链使用 OpenFOAM，不做商业软件对比',
    ],
    tasks: [
      {
        taskId: 'tsk_3e8c02b5_0',
        title: '确定 CFD 工具链并完成安装跑通',
        status: 'done',
        doneCriteria: '选定的工具 + 一个官方教程算例成功运行的截图/日志。',
        owner: null,
        milestone: '选题确认与工具链调研',
        updatedAt: T4,
      },
      {
        taskId: 'tsk_3e8c02b5_1',
        title: '确定艇体几何方案',
        status: 'todo',
        doneCriteria: '几何方案说明：来源 + 主要尺寸参数 + 简化假设。',
        owner: null,
        milestone: '几何建模与网格划分',
        updatedAt: T2,
      },
      {
        taskId: 'tsk_3e8c02b5_2',
        title: '调研潜艇水动力仿真的标准验证算例',
        status: 'todo',
        doneCriteria: '算例调研笔记：可用实验数据 + 常用验证指标。',
        owner: null,
        milestone: '几何建模与网格划分',
        updatedAt: T2,
      },
    ],
    evidence: [
      {
        evidenceId: 'evd_3e8c02b5_0',
        submissionId: 'c2d3e4f5-2222-4333-8444-555566667777',
        taskId: 'tsk_3e8c02b5_0',
        didWhat: '装好 OpenFOAM 并跑通了官方 tutorial 里的 pitzDaily 算例',
        foundWhat: '残差在 800 步后收敛到 1e-5，和教程给出的参考结果一致。',
        stillUnsure: null,
        author: null,
        createdAt: T4,
      },
    ],
    doubts: [],
    promptVersion: PROMPT_VERSION,
    forceRefresh: false,
  },
  expectations: {
    domainAnchors: ['DARPA SUBOFF', 'SUB OFF', 'OpenFOAM', 'k-ω SST', 'k-epsilon', 'y+', '网格无关性', '边界层'],
    minDomainHits: 2,
    claimableTaskIds: ['tsk_3e8c02b5_1', 'tsk_3e8c02b5_2'],
    neverSugggestedTaskIds: ['tsk_3e8c02b5_0'],
    openDoubtIds: [],
  },
}

/* ---------------------------------------------------------- S4 新疑问 */

const s4: AiScenario = {
  id: 'S4',
  name: '自由记录进展产生新疑问（没有进行中的任务）',
  purpose:
    '学生自由记录了一条进展，由此生出一条疑问，项目里没有 doing 任务。要看：新建议是否以这条疑问为落点，并带上具体的数据条件（pH 月尺度）。',
  topicKey: '面向海洋生态环境安全的海洋复合极端事件（高温-缺氧-酸化）智能识别与多尺度演变分析系统',
  request: {
    contractVersion: CONTRACT_VERSION,
    requestId: '44444444-4444-4444-8444-444444444444',
    projectId: 'prj_d4a63f0b8e5c7d9a1b3f2e6c0d8a4f95',
    projectRevision: 4,
    projectName:
      '面向海洋生态环境安全的海洋复合极端事件（高温-缺氧-酸化）智能识别与多尺度演变分析系统',
    currentMilestone: '选题确认与文献调研',
    confirmedContext: [
      '项目目标：识别高温-缺氧-酸化复合极端事件并分析其多尺度演变',
      '交付内容：识别结果 + 多尺度分析 + 可交互原型',
      '已确认范围：先做西北太平洋，不扩展到全球',
    ],
    tasks: [
      {
        taskId: 'tsk_4f9d13c6_0',
        title: '调研复合极端事件的定义与阈值方法',
        status: 'done',
        doneCriteria: '一页定义笔记：单因子极端的判定 + 复合（共现）的判定规则 + 文献依据。',
        owner: null,
        milestone: '选题确认与文献调研',
        updatedAt: T2,
      },
      {
        taskId: 'tsk_4f9d13c6_1',
        title: '摸底三类因子的数据可获取性与分辨率',
        status: 'todo',
        doneCriteria: '数据摸底表：每个因子的来源、时间/空间分辨率、覆盖年限、缺测情况。',
        owner: null,
        milestone: '数据获取与预处理',
        updatedAt: T2,
      },
      {
        taskId: 'tsk_4f9d13c6_2',
        title: '召开启动组会，确定分工与里程碑时间',
        status: 'todo',
        doneCriteria: '组会纪要：定义与数据条件的共识 + 里程碑时间表。',
        owner: null,
        milestone: '选题确认与文献调研',
        updatedAt: T2,
      },
    ],
    evidence: [
      {
        evidenceId: 'evd_4f9d13c6_0',
        submissionId: 'd3e4f5a6-3333-4444-8555-666677778888',
        taskId: null,
        didWhat: '翻了三家公开数据平台的变量说明，确认温度和溶解氧的覆盖率，顺带看了 pH 产品的时间分辨率',
        foundWhat: 'pH 产品大多只有月尺度，和温度、溶解氧的日尺度对不上。',
        stillUnsure: '三个因子时间分辨率不同步，还能不能做「同时发生」的共现判定？阈值要按各自尺度分别定吗？',
        author: null,
        createdAt: T4,
      },
    ],
    doubts: [
      {
        doubtId: 'dbt_4f9d13c6_0',
        text: 'pH 只有月尺度，三因子分辨率不同步时「同时发生」怎么判定？阈值要不要按各自尺度分别定？',
        status: 'open',
        sourceEvidenceId: 'evd_4f9d13c6_0',
        createdAt: T4,
      },
    ],
    promptVersion: PROMPT_VERSION,
    forceRefresh: false,
  },
  expectations: {
    domainAnchors: ['Hobday', 'BGC-Argo', '百分位', '气候态', 'pH', '溶解氧', '共现'],
    minDomainHits: 2,
    claimableTaskIds: ['tsk_4f9d13c6_1', 'tsk_4f9d13c6_2'],
    neverSugggestedTaskIds: ['tsk_4f9d13c6_0'],
    openDoubtIds: ['dbt_4f9d13c6_0'],
  },
}

/* ---------------------------------------------------------- S5 无材料 */

const s5: AiScenario = {
  id: 'S5',
  name: '无材料（任务、证据、疑问都为空）',
  purpose:
    '信息量最少的极端情形。这是 C9 的关键用例：模型应当说清「需要先确认什么」，而不是给出任何项目都适用的空话。',
  topicKey: '基于PB级数据的人机协同科学发现系统',
  request: {
    contractVersion: CONTRACT_VERSION,
    requestId: '55555555-5555-4555-8555-555555555555',
    projectId: 'prj_e5b74a1c9f6d8e0b2c4a3f7d1e9b5a06',
    projectRevision: 1,
    projectName: '基于PB级数据的人机协同科学发现系统',
    currentMilestone: '选题确认与场景调研',
    confirmedContext: [],
    tasks: [],
    evidence: [],
    doubts: [],
    promptVersion: PROMPT_VERSION,
    forceRefresh: true,
  },
  expectations: {
    domainAnchors: ['Argo', '中尺度涡', '主动学习', '数据立方体', '近似查询', 'DuckDB', 'SciServer'],
    minDomainHits: 1,
    claimableTaskIds: [],
    neverSugggestedTaskIds: [],
    openDoubtIds: [],
  },
}

/* ------------------------------------------------------ S6 自定义题目 */

const s6: AiScenario = {
  id: 'S6',
  name: '自定义题目（题目不在 9 套模板内）',
  purpose:
    '学生自己填的题目，没有模板兜底。要看：模型不会因为没有预设就不会说话，而是围绕学生自己写的具体事实给可执行的一步。',
  topicKey: null,
  request: {
    contractVersion: CONTRACT_VERSION,
    requestId: '66666666-6666-4666-8666-666666666666',
    projectId: 'prj_f6c85b2d0a7e9f1c3d5b4a8e2f0c6b17',
    projectRevision: 3,
    projectName: '校园二手书流转数据分析平台',
    currentMilestone: '需求调研与数据摸底',
    confirmedContext: ['项目目标：做出一个能看流通趋势与热门类目的原型', '交付内容：可交互原型 + 一页结论'],
    tasks: [
      {
        taskId: 'tsk_5b6a24d7_0',
        title: '整理现有流转记录的字段与缺失情况',
        status: 'doing',
        doneCriteria: '一张字段清单：字段名、含义、缺失率、是否可用于统计。',
        owner: null,
        milestone: '需求调研与数据摸底',
        updatedAt: T3,
      },
      {
        taskId: 'tsk_5b6a24d7_1',
        title: '确定要展示的三个核心指标',
        status: 'todo',
        doneCriteria: '三个指标的定义 + 各自的计算口径。',
        owner: null,
        milestone: '需求调研与数据摸底',
        updatedAt: T3,
      },
    ],
    evidence: [
      {
        evidenceId: 'evd_5b6a24d7_0',
        submissionId: 'e4f5a6b7-4444-4555-8666-777788889999',
        taskId: 'tsk_5b6a24d7_0',
        didWhat: '把导出的流转记录过了一遍，统计了主要字段的缺失情况',
        foundWhat: '成交时间字段有 18% 为空，类目字段有 7 条写法不统一（同时存在「教材」和「教科书」）。',
        stillUnsure: '缺失 18% 的成交时间还能不能用于月度趋势，是不是只能按周看？',
        author: null,
        createdAt: T4,
      },
    ],
    doubts: [
      {
        doubtId: 'dbt_5b6a24d7_0',
        text: '成交时间缺失 18% 的情况下，月度趋势还能不能做？还是改成按周统计？',
        status: 'open',
        sourceEvidenceId: 'evd_5b6a24d7_0',
        createdAt: T4,
      },
    ],
    promptVersion: PROMPT_VERSION,
    forceRefresh: false,
  },
  expectations: {
    domainAnchors: ['缺失率', '口径', '字段', '类目归一化', '18%'],
    minDomainHits: 2,
    claimableTaskIds: ['tsk_5b6a24d7_0', 'tsk_5b6a24d7_1'],
    neverSugggestedTaskIds: [],
    openDoubtIds: ['dbt_5b6a24d7_0'],
  },
}

/** 六类场景，顺序与 `docs/ai/evaluation.md` 的表一致 */
export const AI_SCENARIOS: readonly AiScenario[] = [s1, s2, s3, s4, s5, s6]

/** 按编号取场景，便于在评估记录里引用 */
export function findScenario(id: AiScenarioId): AiScenario {
  const hit = AI_SCENARIOS.find((scenario) => scenario.id === id)
  if (hit === undefined) throw new Error(`未知场景：${id}`)
  return hit
}
