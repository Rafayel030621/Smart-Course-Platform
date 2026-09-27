/**
 * 平台领域模型
 * ----------------------------------------------------------------------------
 * 与 platform-ui-mockup(3).html 的数据结构一一对应。
 * 一个项目 = 五个里程碑 + 若干疑问 + AI 顾问的三步建议 + 论文检索方向 + 证据时间线。
 */

/** 里程碑状态：已完成 / 进行中 / 未开始 */
export type MilestoneStatus = 'done' | 'cur' | 'todo'

export interface Milestone {
  /** 里程碑名称 */
  t: string
  s: MilestoneStatus
  /** 进行中的进度百分比 */
  p: number
  /** 状态说明，例如「刚启动」「未开始」 */
  sub: string
}

/** AI 顾问给出的步骤建议 */
export interface SuggestedStep {
  t: string
  /** 建议负责人 */
  owner: string
  /** 为什么现在做 */
  why: string
  /** 完成标志 */
  done: string
}

/* ------------------------------------------------------------------ 结构化状态模型 */

/**
 * 契约 2.2：任务状态。
 * 三态由三个不同动作驱动：认领 → doing，确认完成 → done，其余为 todo。
 */
export type TaskStatus = 'todo' | 'doing' | 'done'

/** 契约 2.4：疑问状态。只有 `open` 会进入建议请求 */
export type DoubtStatus = 'open' | 'resolved'

/**
 * localStorage 结构版本常量。
 * 结构发生不兼容变更时 +1，并在 `src/stores/persistence.ts` 里补一条迁移分支。
 */
export const PROJECT_SCHEMA_VERSION = 1

/**
 * 契约 2.2：任务。
 *
 * `id` 在**创建时生成并持久化**，不按数组下标派生（下标会随插入/删除漂移）。
 * `status` 只由认领与确认完成两个动作改变。
 *
 * 展示字段（`why` / `suggestedOwner`）只服务于旧页面：
 * 它们**不进请求体**（TaskSnapshot 不含它们，契约 8.4：服务端忽略未知字段），
 * 也不参与任何状态判断。
 *
 * `owner` 严格按契约 2.2 取值（MVP 无成员名单，本轮恒为 `null`）；
 * 题目模板里设计的「成员A / 成员B」只留在 `suggestedOwner` 里做展示。
 */
export interface Task {
  id: string
  projectId: string
  title: string
  status: TaskStatus
  doneCriteria: string | null
  /** 契约 2.2：建议负责人。MVP 无成员名单，本轮恒为 null */
  owner: string | null
  /** 旧页面展示用的「建议：成员A」。不进请求体，不参与状态判断 */
  suggestedOwner: string | null
  milestone: string | null
  /** 旧页面展示用的「为什么现在做」，不参与请求 */
  why: string | null
  createdAt: string
  updatedAt: string
}

/** 契约 2.3：证据。`submissionId` 是幂等键，重复提交同一值不重复写入 */
export interface Evidence {
  id: string
  projectId: string
  submissionId: string
  taskId: string | null
  didWhat: string
  foundWhat: string | null
  stillUnsure: string | null
  /** MVP 只记文件名，不定义上传协议 */
  attachmentName: string | null
  author: string | null
  createdAt: string
}

/** 契约 2.4：疑问。`sourceEvidenceId` 指向产生它的那条证据 */
export interface Doubt {
  id: string
  projectId: string
  text: string
  status: DoubtStatus
  sourceEvidenceId: string | null
  createdAt: string
  resolvedAt: string | null
}

/**
 * 契约 3.2：新任务候选。
 * 用于建议里 `existingTaskId === null` 的情形——由前端生成任务并直接置为 `doing`。
 */
export interface NewTaskDraft {
  title: string
  doneCriteria: string
  requestId: string | null
  basisEvidenceIds: string[]
  basisDoubtIds: string[]
}

/**
 * 论文推荐。两种方式并存：
 *   ① 直接给链接 —— 填了 `link`（指向具体论文，通常是 DOI）就直接能打开；
 *      没填则退化为「按标题检索」的链接，点开也能看到相关论文。
 *   ② 给提示词 —— `prompt` 复制到 GPT 里自己检索，练检索能力、也拿到最新结果。
 *
 * 只填能核实的链接：填错会 404，宁可留空走检索。
 */
export interface PaperDirection {
  title: string
  meta: string
  why: string
  prompt: string
  /** ① 指向具体论文的可靠地址，例如 DOI 链接 */
  link?: string
}

/** 题目模板（创建项目时实例化） */
export interface Template {
  short: string
  ms: Milestone[]
  doubts: string[]
  banner: string
  steps: SuggestedStep[]
  papers: PaperDirection[]
}

/** 项目材料类型 */
export type MaterialType = '实验手册' | '数据集' | '材料'

export interface MaterialItem {
  name: string
  type: MaterialType
}

/** 证据时间线上的一条 */
export interface EvidenceItem {
  time: string
  text: string
  who: string
}

export interface ChatMessage {
  who: string
  text: string
  /** 是否是学生自己说的 */
  me: boolean
}

/** AI 现场生成的检索方向卡片 */
export interface AiPaperDirection {
  title: string
  meta: string
  prompt: string
}

/**
 * 一个项目实例
 *
 * 数据只有**一份真实来源**：`tasks` / `evidenceRecords` / `doubtRecords`。
 * `steps` / `evidence` / `doubts` 是给旧页面用的**兼容投影**：
 * 每次本地写入后由 `syncProjectView()` 从上面三份数据重建，页面只读、不写。
 * 因此不存在「新旧两套状态互相打架」的问题。
 */
export interface Project {
  /* ---- 契约 2.1 字段 ---- */
  /** 项目稳定 ID：创建时生成并持久化 */
  projectId: string
  /** 项目题目（完整名称） */
  name: string
  /** 短名，用于标签与地图中心 */
  short: string
  /** 契约 2.6：项目状态版本，从 1 开始递增 */
  projectRevision: number
  /** localStorage 结构版本，不进请求体 */
  schemaVersion: number

  /* ---- 旧展示字段（与 mockup 一致，页面直接读） ---- */
  group: string
  members: string
  updated: string
  ms: Milestone[]
  banner: string
  papers: PaperDirection[]
  /** 近 4 周的活跃度计数 */
  weekly: number[]
  materials: MaterialItem[]
  chat: ChatMessage[]
  /** AI 现场生成的检索方向 */
  aiPapers: AiPaperDirection[]

  /* ---- 真实状态（唯一来源） ---- */
  /** 该项目全部任务，含已完成 */
  tasks: Task[]
  /** 结构化证据，按创建顺序保存 */
  evidenceRecords: Evidence[]
  /** 结构化疑问，已解决的也保留（status 为 resolved） */
  doubtRecords: Doubt[]

  /* ---- 兼容投影（由 syncProjectView 重建，页面只读） ---- */
  /** ← tasks */
  steps: SuggestedStep[]
  /** ← evidenceRecords */
  evidence: EvidenceItem[]
  /** ← doubtRecords 里 status === 'open' 的文本 */
  doubts: string[]
}
