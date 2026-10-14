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
  /**
   * 该步骤对应的真实任务 ID。
   * 由 `deriveStepViews` 从 `Project.tasks` 投影出来，页面据此认领 / 提问，**不用数组下标**。
   * 题目模板里的示例步骤没有真实任务，因此是可选的。
   */
  taskId?: string
  /** 该步骤对应任务的真实状态，页面（项目地图 / 步骤卡）据此显示「进行中 / 未开始 / 已完成」 */
  status?: TaskStatus
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
 *
 * v2（契约第 12~14 节，M1 冻结）：新增 `profile`（项目基本信息）、
 * `materialRecords` / `materialSegments`（材料元数据与分段）、
 * `understandingBlocks`（理解草稿条目）。v1 项目由迁移逻辑补默认值，不丢数据。
 *
 * v3：命名与团队约定对齐（`Material` / `UnderstandingBlock`：`block`→`kind`、
 * `text`→`content`、`understandingItems`→`understandingBlocks`、`type`/`size`/
 * `encoding`/`state` 允许为 `null` 以容纳「仅登记」的旧材料）。v2 数据由迁移逻辑
 * 逐字段改名，字段内容不丢。
 */
export const PROJECT_SCHEMA_VERSION = 3

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
  /**
   * v2：任务的 draft 幂等键（契约 3.2 约束 4）。
   * 由 `draftKeyOf` 对「标题 + 完成标准 + requestId + 依据 ID（排序后）」做规范化摘要；
   * 相同 draft 内容重复认领时按它命中同一条任务，**不重复创建、不重复写盘**。
   * 模板任务与认领已有任务（taskId 路径）没有幂等键，取 `null`；
   * 旧数据（v1/v2）里没有该字段，读取时统一补 `null`。
   */
  draftKey: string | null
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

/* ------------------------------------------------------------------ v2：项目基本信息（契约 13.1） */

/**
 * 契约 13.1：项目基本信息。
 *
 * 缺失值一律 `null`、不存空字符串（契约第 2 节通用约定）；
 * 这些字段必须存在项目结构化状态里，不能只作为一段聊天文本。
 */
export interface ProjectProfile {
  /** 项目目标，≤ 300 字 */
  goal: string | null
  /** 预期结果或交付物，≤ 300 字 */
  expectedOutcome: string | null
  /** 项目成员姓名，≤ 10 人，每人 1～30 字 */
  memberNames: string[]
  /** 研究周期（本轮为自由文本），≤ 100 字 */
  researchPeriod: string | null
  /** 项目范围，≤ 300 字 */
  scope: string | null
  /** 暂不处理的内容，≤ 300 字 */
  outOfScope: string | null
}

/* ------------------------------------------------------------------ v2：材料（契约 14） */

/** 契约 14.1 / 15.1：本轮文件白名单只有 `.md` / `.txt`（不区分大小写） */
export type MaterialType = 'md' | 'txt'

/** 契约 14.1：实际用于解码的编码，UTF-8 优先、失败回退 GBK */
export type MaterialEncoding = 'utf-8' | 'gbk'

/** 契约 14.1：解析状态。被拒绝的文件不产生材料记录 */
export type MaterialState = 'parsed' | 'parse_failed'

/**
 * 契约 14.1：材料元数据（本地形态）。
 *
 * 线上字段在**上传成功后才齐备**；旧数据迁移来的「仅登记」材料没有经过服务端，
 * `type` / `size` / `encoding` / `state` 为 `null`，并以 `needsReupload` 标记
 * 「待重新上传」——这一标记只是界面展示口径，**不进任何请求体**（契约 14.1 备注）。
 */
export interface Material {
  /** 前端生成的稳定 ID，`mat_` 前缀 */
  materialId: string
  projectId: string
  /** 原始文件名，1～200 字；扩展名必须是 `.md` / `.txt` */
  name: string
  /** 由扩展名推导，统一小写；未上传过为 null */
  type: MaterialType | null
  /** 解码后的原始字节数，1～1,048,576；未上传过为 null */
  size: number | null
  encoding: MaterialEncoding | null
  state: MaterialState | null
  /** 前端维护的整数，≥ 1；同一 materialId 重新上传时 +1（契约 14.5 第 4 条） */
  version: number
  createdAt: string
  updatedAt: string
  /** 只在 `state === 'parse_failed'` 时是中文原因 */
  failureReason: string | null

  /* ---- 纯本地字段（不进接口） ---- */
  /** 需要重新上传：解析失败，或当前版本没有任何片段 */
  needsReupload: boolean
}

/** 契约 14.2：分段（本地形态自带 materialId / materialVersion，便于按材料+版本取片段） */
export interface MaterialSegment {
  segmentId: string
  /** 服务端生成的片段 ID 只保证在同一 materialId + version 内唯一 */
  materialId: string
  materialVersion: number
  /** 从 0 开始的稳定序号 */
  index: number
  /** 1 起始、包含两端 */
  startLine: number
  endLine: number
  /** 分段正文，1～2,000 字 */
  text: string
}

/** 契约 14.3：草稿条目的来源引用（材料名与行号由服务端回填，模型不得自造） */
export interface MaterialSourceRef {
  materialId: string
  materialName: string
  materialVersion: number
  segmentId: string
  startLine: number
  endLine: number
}

/** 契约 14.3：一条理解草稿候选（线格式） */
export interface DraftItem {
  /** 服务端生成 `cnd_<块短名>_<序号>`，只在**本次响应内**唯一 */
  itemId: string
  text: string
  sources: MaterialSourceRef[]
}

/** 契约 14.3：理解草稿的五块（分组维度即「块类别」） */
export type UnderstandingBlockKind =
  | 'goalCandidates'
  | 'outcomeCandidates'
  | 'dataNotes'
  | 'methodNotes'
  | 'openQuestions'

/** 契约 14.3：服务端响应里的线格式 */
export type UnderstandingDraft = Record<UnderstandingBlockKind, DraftItem[]>

/**
 * 契约 14.3 / 2.6：理解草稿条目的本地确认状态。
 *
 * - `pending`：模型刚生成，**不能**当项目事实；
 * - `modified`：学生改过但**还没再次确认**，同样不是项目事实；
 * - `confirmed`：只有这一种会进入建议与聊天请求（契约 17.2）。
 */
export type UnderstandingBlockStatus = 'pending' | 'confirmed' | 'modified'

/**
 * 前端本地保存的理解草稿条目 = 线格式的一条候选 + 本地字段。
 *
 * 本地字段说明：
 *   - `id`：项目内唯一（服务器 itemId 只在单次响应内唯一，两份材料可能出现同名 itemId）；
 *   - `kind` / `materialId` / `materialVersion`：按材料与块类别分组、按版本判过期；
 *   - `status`：本地确认状态，不进请求体。
 */
export interface UnderstandingBlock {
  id: string
  itemId: string
  kind: UnderstandingBlockKind
  materialId: string
  materialVersion: number
  content: string
  sources: MaterialSourceRef[]
  status: UnderstandingBlockStatus
  /** 服务端原始文本，修改后仍保留，便于「撤销修改 / 撤销确认」回到未改状态 */
  originalContent: string
  createdAt: string
  updatedAt: string
}

/**
 * 前端本地的材料读取口径（只用于界面展示，不进接口，契约 14.1 备注）：
 * 仅登记文件名 / 存在待确认草稿 / 草稿已确认。
 */
export type MaterialReadState = 'registered' | 'pending' | 'confirmed'

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

/**
 * 旧页面材料条目的展示类型（`Project.materials`）。
 *
 * 注意与契约 14.1 的 `MaterialType`（`'md' | 'txt'`）区分：这里只是首轮 MVP 的中文
 * 占位标签，**不进任何接口**，v2 起由 `materialRecords` 取代，仅为兼容旧页面保留。
 */
export type MaterialItemType = '实验手册' | '数据集' | '材料'

export interface MaterialItem {
  name: string
  type: MaterialItemType
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
  /** 契约 6.4：回答来源；学生自己说的消息没有这个字段 */
  source?: 'model' | 'fallback' | 'error'
  /** 契约 5.1：fallback / error 时的原因码，用于界面说明 */
  fallbackReason?: string | null
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

  /* ---- v2 真实状态（契约 13 / 14） ---- */
  /**
   * 契约 13.1：项目基本信息。
   * 旧项目迁移时补空值（不是 `undefined`），保存后 `projectRevision + 1`。
   */
  profile: ProjectProfile
  /**
   * 契约 14.1：材料元数据，每种材料只保留**最新版本**一条。
   * 重新上传同一 materialId 时 `version + 1`，旧版本的草稿条目按 14.5 作废。
   */
  materialRecords: Material[]
  /** 契约 14.2：当前版本的片段（扁平保存，自带 materialId / materialVersion） */
  materialSegments: MaterialSegment[]
  /** 契约 14.3：理解草稿条目（含本地确认状态） */
  understandingBlocks: UnderstandingBlock[]

  /* ---- 兼容投影（由 syncProjectView 重建，页面只读） ---- */
  /** ← tasks */
  steps: SuggestedStep[]
  /** ← evidenceRecords */
  evidence: EvidenceItem[]
  /** ← doubtRecords 里 status === 'open' 的文本 */
  doubts: string[]
}
