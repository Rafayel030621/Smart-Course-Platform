/**
 * 学生自助导出项目 JSON（纯函数，无第三方库）
 * ============================================================================
 * 只做一件事件：把「当前项目状态」序列化成一份可 JSON.stringify 的文档。
 * 不碰 DOM、不造 Blob、不触发下载、不做 ZIP/CSV/XLSX，也不做多项目打包。
 *
 * ---------------------------------------------------------------------------
 * 导出字段最小约定（草案，**等待确认后固化**；未确认前不得当成冻结契约）
 * ---------------------------------------------------------------------------
 * 0. 定位
 *    - 这是「学生自己看得懂、带走得了」的项目快照，**不是平台备份**：
 *      不保证能重新导入、不保证覆盖服务端全部数据、不含任何账号信息。
 *    - 顶层固定字段：`schemaVersion`（导出格式版本，从 1 开始）、`exportedAt`
 *      （ISO 时间，由调用方传入以便测试稳定）、`scope`、`meta`。
 *
 * 1. 本地项目（`scope: "local"`）
 *    数据源就是 localStorage 里的 `Project`（PROJECT_SCHEMA_VERSION = 3），逐项取舍：
 *
 *    | 导出内容 | 来源字段 | 取舍理由 |
 *    | --- | --- | --- |
 *    | 项目标识与版本 | projectId / name / short / projectRevision | 学生能对上「这是哪个项目、第几版」 |
 *    | 本地模型版本 | schemaVersion → `sourceSchemaVersion` | 便于日后排查导出结构与本地格式的对应关系 |
 *    | 基本信息 | profile（goal / expectedOutcome / memberNames / researchPeriod / scope / outOfScope） | 契约 13.1 的结构化事实，属于项目内容 |
 *    | 阶段 | ms[]（t / s / p / sub） | 本地没有独立阶段实体，`ms` 是唯一阶段形状；不导出 `banner` 等派生文案 |
 *    | 任务 | tasks[]（含已完成） | 唯一真实来源；省略每条里冗余的 projectId（顶层已有） |
 *    | 证据 | evidenceRecords[] | 唯一真实来源；不导出 `evidence`（可由它重建的展示投影） |
 *    | 疑问 | doubtRecords[] | 唯一真实来源（含已解决）；不导出 `doubts`（投影） |
 *    | 材料元数据 | materialRecords[] | 文件名、类型、大小、编码、状态、版本；**不含片段正文** |
 *    | 理解草稿 | understandingBlocks[] | 含确认状态与原文（content / originalContent），是学生的判断结果 |
 *    | 聊天记录 | chat[] | 见第 4 条，**默认不导出**，由调用方显式开启 |
 *
 *    **不导出**（并写入 `meta.omitted` 说明原因）：
 *      - `steps` / `evidence` / `doubts` / `banner` / `updated` / `group` / `members` / `weekly`：
 *        都是 `syncProjectView()` 或模板派生的展示投影，导出等于同一事实存两份；
 *      - `materials`（`MaterialItem[]`）：首轮 MVP 的中文占位标签，已被 `materialRecords` 取代；
 *      - `papers`：来自题目模板的预置方向，可随时按题目重建；
 *      - `aiPapers`：运行期生成的检索方向卡片，属于过程性 UI 状态；
 *      - `materialSegments`：材料原文片段。取舍理由：体积可达 MB 级、且是学生上传的原始资料，
 *        与「项目结构化事实」不是一回事。**已确认：材料片段正文本阶段不导出，如需资料级导出
 *        另立契约。**
 *
 * 2. 云端项目（`scope: "cloud-projection"`）
 *    - 数据源是 cloud store 里**已经加载**的只读投影，不是服务端全量数据。
 *    - 必须带 `notice` 中文免责说明，明确写出「快照、非完整备份」。
 *    - 列表用 `{ loaded: true, items }` / `{ loaded: false, items: null }` 表示：
 *      未加载时**不写空数组**，避免把「没读」伪装成「没有」。调用方必须显式告诉本函数
 *      哪些列表已经加载（传数组即视为已加载，不传即未加载），本函数不自行补空。
 *    - 导出范围：项目元信息、阶段、任务、证据、进展、材料元数据（仅当已加载）。
 *      **不导出**：疑问（V3 没有读取端点）、材料片段正文、聊天（无持久化端点）、
 *      阶段候选（临时数据，会过期）。
 *    - 不导出 `ownerUserId`：对「学生带走自己的项目」没有价值，属于身份标识，按最小化处理。
 *
 * 3. 凭证红线（任何 scope 都适用）
 *    - 绝不导出：Cookie、密码、邀请码、API Key、token、会话凭证、`ownerUserId` 等身份/凭证字段。
 *    - 实现方式是**白名单逐字段组装**（不展开原对象），因此模型以后新增字段也不会被顺带导出。
 *    - 测试会对导出结果做深遍历，断言不存在敏感 key。
 *
 * 4. 聊天记录（**已确认：默认不导出聊天**）
 *    - 现状：本地项目的 `chat` 只存在于当前页面内存 / 本地持久化；云端聊天在契约第 30 节
 *      落地前没有读回端点，刷新即丢失。
 *    - 因此本函数默认**不导出聊天**（`includeChat` 默认 false），理由：
 *      ① 聊天是过程对话，不是项目结构化事实；② 其中可能夹带学生随手粘贴的隐私内容；
 *      ③ 现在导出会让「本地有、云端没有」两个 scope 的语义不一致。
 *    - 调用方仍可显式 `includeChat: true` 按原样导出内存态消息，这只是导出选项，不改变默认结论。
 *
 * 5. 序列化
 *    - `buildLocalProjectExport()` / `buildCloudProjectExport()` 返回纯对象；
 *      `serializeProjectExport()` 负责 `JSON.stringify(doc, null, 2)`。
 *    - 不读系统时钟以外的任何环境；`exportedAt` 建议由调用方传入（默认取当前时间）。
 *
 * ---------------------------------------------------------------------------
 * 界面层接入（文件下载归界面，不在本文件实现）
 * ---------------------------------------------------------------------------
 * ```ts
 * // 本地项目
 * const doc = buildLocalProjectExport({
 *   project,
 *   exportedAt: new Date().toISOString(),
 * })
 * // 云端项目：只传实际已加载的列表，未加载就传 undefined，不要传 []
 * const cloudDoc = buildCloudProjectExport({
 *   project: cloudStore.project!,
 *   tasks: cloudStore.tasks,
 *   evidence: cloudStore.evidence,
 *   progress: cloudStore.progress,
 *   materials: cloudStore.materials,
 *   exportedAt: new Date().toISOString(),
 * })
 *
 * const text = serializeProjectExport(doc)
 * // 下面三行属于界面层：文件名、Blob、a[download] 点击
 * const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
 * const url = URL.createObjectURL(blob)
 * // a.href = url; a.download = `${project.short || project.name}-export.json`; a.click(); URL.revokeObjectURL(url)
 * ```
 */
import type {
  ChatMessage,
  CloudEvidence,
  CloudMaterial,
  CloudMilestone,
  CloudProject,
  CloudTask,
  Doubt,
  Evidence,
  Material,
  MaterialSourceRef,
  Milestone,
  ProgressRecord,
  Project,
  ProjectProfile,
  Task,
  UnderstandingBlock,
} from '@/types/platform'
import { PROJECT_SCHEMA_VERSION } from '@/types/platform'

/** 导出格式版本：字段增删或语义变化时 +1（与本地 PROJECT_SCHEMA_VERSION 无关） */
export const PROJECT_EXPORT_SCHEMA_VERSION = 1

/** 云端导出的必读说明：必须展示在界面上，不能只在文件里 */
export const CLOUD_EXPORT_NOTICE =
  '这是导出时已加载的云端只读投影快照，不是完整备份：未加载的列表标为 loaded: false，' +
  '不代表服务端没有数据；导出后服务端的新改动不会同步到这份文件。'

export type ProjectExportScope = 'local' | 'cloud-projection'

/** `loaded: false` 时 items 必须是 null：没读到的列表不能写成空数组 */
export type ExportProjectionList<T> =
  | { loaded: true; items: T[] }
  | { loaded: false; items: null }

export interface ExportMeta {
  /** 未导出的本地字段及原因（中文，界面可直接展示给用户） */
  omitted: string[]
  /** 尚未定稿、等待产品裁决的取舍 */
  pendingDecision: string[]
}

export type ExportedProfile = ProjectProfile

export interface ExportedTask {
  id: string
  title: string
  status: Task['status']
  doneCriteria: string | null
  owner: string | null
  suggestedOwner: string | null
  milestone: string | null
  why: string | null
  draftKey: string | null
  createdAt: string
  updatedAt: string
}

export interface ExportedEvidence {
  id: string
  submissionId: string
  taskId: string | null
  didWhat: string
  foundWhat: string | null
  stillUnsure: string | null
  attachmentName: string | null
  author: string | null
  createdAt: string
}

export interface ExportedDoubt {
  id: string
  text: string
  status: Doubt['status']
  sourceEvidenceId: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface ExportedMaterial {
  materialId: string
  name: string
  type: Material['type']
  size: Material['size']
  encoding: Material['encoding']
  state: Material['state']
  version: number
  failureReason: string | null
  needsReupload: boolean
  createdAt: string
  updatedAt: string
}

export interface ExportedUnderstandingBlock {
  id: string
  itemId: string
  kind: UnderstandingBlock['kind']
  materialId: string
  materialVersion: number
  content: string
  sources: MaterialSourceRef[]
  status: UnderstandingBlock['status']
  originalContent: string
  createdAt: string
  updatedAt: string
}

export interface ExportedChatMessage {
  who: string
  text: string
  me: boolean
  source: ChatMessage['source']
  fallbackReason: string | null
  citations: MaterialSourceRef[]
}

export interface LocalExportedProject {
  projectId: string
  name: string
  short: string
  projectRevision: number
  /** 导出时该项目的本地结构版本（PROJECT_SCHEMA_VERSION） */
  sourceSchemaVersion: number
  profile: ExportedProfile
  milestones: Milestone[]
  tasks: ExportedTask[]
  evidence: ExportedEvidence[]
  doubts: ExportedDoubt[]
  materials: ExportedMaterial[]
  understanding: ExportedUnderstandingBlock[]
  /** 仅在调用方显式 includeChat: true 时出现 */
  chat?: ExportedChatMessage[]
}

export interface ExportedCloudMilestone {
  milestoneId: string
  name: string
  goal: string
  doneCriteria: string
  dueAt: string | null
  status: CloudMilestone['status']
  orderIndex: number
  revision: number
  source: CloudMilestone['source']
  createdAt: string
  updatedAt: string
  completedAt: string | null
  archivedAt: string | null
  taskStats: CloudMilestone['taskStats']
}

export interface ExportedCloudProject {
  projectId: string
  name: string
  short: string | null
  profile: ExportedProfile
  status: CloudProject['status']
  projectRevision: number
  currentMilestoneId: string | null
  currentMilestone: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  deletedAt: string | null
  taskStats: CloudProject['taskStats']
  milestones: ExportedCloudMilestone[]
}

export interface ExportedCloudTask {
  taskId: string
  milestoneId: string | null
  milestoneName: string | null
  title: string
  doneCriteria: string
  status: CloudTask['status']
  assigneeUserId: string | null
  orderIndex: number
  source: CloudTask['source']
  revision: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  archivedAt: string | null
}

export interface ExportedCloudEvidence {
  evidenceId: string
  taskId: string | null
  milestoneId: string | null
  milestoneNameSnapshot: string | null
  submissionId: string | null
  didWhat: string
  foundWhat: string
  stillUnsure: string | null
  attachmentName: string | null
  status: CloudEvidence['status']
  revision: number
  createdAt: string
  updatedAt: string
  redactedAt: string | null
}

export interface ExportedProgressRecord {
  progressId: string
  milestoneId: string | null
  taskId: string | null
  evidenceIds: string[]
  summary: string
  occurredAt: string
  status: ProgressRecord['status']
  supersedesProgressId: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ExportedCloudMaterial {
  materialId: string
  name: string
  type: CloudMaterial['type']
  size: number | null
  status: CloudMaterial['status']
  materialVersion: number
  revision: number
  failureReason: string | null
  isCurrent: boolean
  readOnly: boolean
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface LocalProjectExport {
  schemaVersion: number
  exportedAt: string
  scope: 'local'
  project: LocalExportedProject
  meta: ExportMeta
}

export interface CloudProjectExport {
  schemaVersion: number
  exportedAt: string
  scope: 'cloud-projection'
  /** 云端快照必须带免责说明 */
  notice: string
  project: ExportedCloudProject
  lists: {
    tasks: ExportProjectionList<ExportedCloudTask>
    evidence: ExportProjectionList<ExportedCloudEvidence>
    progress: ExportProjectionList<ExportedProgressRecord>
    materials: ExportProjectionList<ExportedCloudMaterial>
  }
  meta: ExportMeta
}

export type ProjectExportDocument = LocalProjectExport | CloudProjectExport

export interface BuildLocalProjectExportInput {
  project: Project
  /** ISO 时间；不传取当前时间。测试请传固定值 */
  exportedAt?: string
  /** 默认 false：聊天是否纳入尚未裁决，见文件头第 4 条 */
  includeChat?: boolean
}

export interface BuildCloudProjectExportInput {
  project: CloudProject
  exportedAt?: string
  /** 传数组 = 已加载；不传 = 未加载（导出为 loaded: false），不要传空数组冒充 */
  tasks?: CloudTask[]
  evidence?: CloudEvidence[]
  progress?: ProgressRecord[]
  materials?: CloudMaterial[]
}

/* ------------------------------------------------------------------ 工具 */

function isoNow(): string {
  return new Date().toISOString()
}

function copyProfile(profile: ProjectProfile): ExportedProfile {
  return {
    goal: profile.goal,
    expectedOutcome: profile.expectedOutcome,
    // 复制数组：导出的对象不能和 store 共享引用
    memberNames: [...profile.memberNames],
    researchPeriod: profile.researchPeriod,
    scope: profile.scope,
    outOfScope: profile.outOfScope,
  }
}

function copyMilestone(milestone: Milestone): Milestone {
  return { t: milestone.t, s: milestone.s, p: milestone.p, sub: milestone.sub }
}

function copySourceRef(ref: MaterialSourceRef): MaterialSourceRef {
  return {
    materialId: ref.materialId,
    materialName: ref.materialName,
    materialVersion: ref.materialVersion,
    segmentId: ref.segmentId,
    startLine: ref.startLine,
    endLine: ref.endLine,
  }
}

function copyTask(task: Task): ExportedTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    doneCriteria: task.doneCriteria,
    owner: task.owner,
    suggestedOwner: task.suggestedOwner,
    milestone: task.milestone,
    why: task.why,
    draftKey: task.draftKey,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

function copyEvidence(record: Evidence): ExportedEvidence {
  return {
    id: record.id,
    submissionId: record.submissionId,
    taskId: record.taskId,
    didWhat: record.didWhat,
    foundWhat: record.foundWhat,
    stillUnsure: record.stillUnsure,
    attachmentName: record.attachmentName,
    author: record.author,
    createdAt: record.createdAt,
  }
}

function copyDoubt(doubt: Doubt): ExportedDoubt {
  return {
    id: doubt.id,
    text: doubt.text,
    status: doubt.status,
    sourceEvidenceId: doubt.sourceEvidenceId,
    createdAt: doubt.createdAt,
    resolvedAt: doubt.resolvedAt,
  }
}

function copyMaterial(material: Material): ExportedMaterial {
  return {
    materialId: material.materialId,
    name: material.name,
    type: material.type,
    size: material.size,
    encoding: material.encoding,
    state: material.state,
    version: material.version,
    failureReason: material.failureReason,
    needsReupload: material.needsReupload,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
  }
}

function copyUnderstandingBlock(block: UnderstandingBlock): ExportedUnderstandingBlock {
  return {
    id: block.id,
    itemId: block.itemId,
    kind: block.kind,
    materialId: block.materialId,
    materialVersion: block.materialVersion,
    content: block.content,
    sources: block.sources.map(copySourceRef),
    status: block.status,
    originalContent: block.originalContent,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  }
}

function copyChatMessage(message: ChatMessage): ExportedChatMessage {
  return {
    who: message.who,
    text: message.text,
    me: message.me,
    source: message.source,
    fallbackReason: message.fallbackReason ?? null,
    citations: (message.citations ?? []).map(copySourceRef),
  }
}

function copyCloudMilestone(milestone: CloudMilestone): ExportedCloudMilestone {
  return {
    milestoneId: milestone.milestoneId,
    name: milestone.name,
    goal: milestone.goal,
    doneCriteria: milestone.doneCriteria,
    dueAt: milestone.dueAt,
    status: milestone.status,
    orderIndex: milestone.orderIndex,
    revision: milestone.revision,
    source: milestone.source,
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
    completedAt: milestone.completedAt,
    archivedAt: milestone.archivedAt,
    taskStats: { ...milestone.taskStats },
  }
}

function copyCloudTask(task: CloudTask): ExportedCloudTask {
  return {
    taskId: task.taskId,
    milestoneId: task.milestoneId,
    milestoneName: task.milestoneName,
    title: task.title,
    doneCriteria: task.doneCriteria,
    status: task.status,
    assigneeUserId: task.assigneeUserId,
    orderIndex: task.orderIndex,
    source: task.source,
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    archivedAt: task.archivedAt,
  }
}

function copyCloudEvidence(item: CloudEvidence): ExportedCloudEvidence {
  return {
    evidenceId: item.evidenceId,
    taskId: item.taskId,
    milestoneId: item.milestoneId,
    milestoneNameSnapshot: item.milestoneNameSnapshot,
    submissionId: item.submissionId,
    didWhat: item.didWhat,
    foundWhat: item.foundWhat,
    stillUnsure: item.stillUnsure,
    attachmentName: item.attachmentName,
    status: item.status,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    redactedAt: item.redactedAt,
  }
}

function copyProgressRecord(record: ProgressRecord): ExportedProgressRecord {
  return {
    progressId: record.progressId,
    milestoneId: record.milestoneId,
    taskId: record.taskId,
    evidenceIds: [...record.evidenceIds],
    summary: record.summary,
    occurredAt: record.occurredAt,
    status: record.status,
    supersedesProgressId: record.supersedesProgressId,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function copyCloudMaterial(material: CloudMaterial): ExportedCloudMaterial {
  return {
    materialId: material.materialId,
    name: material.name,
    type: material.type,
    size: material.size,
    status: material.status,
    materialVersion: material.materialVersion,
    revision: material.revision,
    failureReason: material.failureReason,
    isCurrent: material.isCurrent,
    readOnly: material.readOnly,
    createdAt: material.createdAt,
    updatedAt: material.updatedAt,
    archivedAt: material.archivedAt,
  }
}

/** 已加载的列表原样复制；未加载时显式标 loaded: false，绝不塞空数组 */
function projectionOf<T, U>(
  value: T[] | undefined,
  copy: (item: T) => U,
): ExportProjectionList<U> {
  if (value === undefined) return { loaded: false, items: null }
  return { loaded: true, items: value.map(copy) }
}

const PENDING_DECISION_CHAT =
  '已确认：聊天记录默认不导出（本地为内存态、云端在契约第 30 节落地前无读回端点）；' +
  '调用方仍可显式 includeChat: true 导出本地消息。'

const PENDING_DECISION_SEGMENTS =
  '已确认：材料片段正文（materialSegments）本阶段不导出，如需资料级导出另立契约。'

/* ------------------------------------------------------------ 本地项目导出 */

/**
 * 本地项目 → 导出文档。
 * 输入就是 localStorage 里的 `Project`，不读 store、不读时钟（除非未传 exportedAt）。
 */
export function buildLocalProjectExport(
  input: BuildLocalProjectExportInput,
): LocalProjectExport {
  const { project } = input
  const includeChat = input.includeChat === true

  const exported: LocalExportedProject = {
    projectId: project.projectId,
    name: project.name,
    short: project.short,
    projectRevision: project.projectRevision,
    sourceSchemaVersion: project.schemaVersion,
    profile: copyProfile(project.profile),
    milestones: project.ms.map(copyMilestone),
    tasks: project.tasks.map(copyTask),
    evidence: project.evidenceRecords.map(copyEvidence),
    doubts: project.doubtRecords.map(copyDoubt),
    materials: project.materialRecords.map(copyMaterial),
    understanding: project.understandingBlocks.map(copyUnderstandingBlock),
  }

  const omitted = [
    '展示投影字段（steps / evidence / doubts / banner / updated / group / members / weekly）未导出：可由任务、证据、疑问重建，导出会造成同一事实两份。',
    '旧材料占位列表 materials（MaterialItem[]）未导出：已被 materialRecords 取代。',
    '论文方向 papers 未导出：来自题目模板，可随时重建。',
    'AI 检索方向 aiPapers 未导出：属于运行期生成的过程性界面状态。',
    '材料片段正文 materialSegments 未导出：体积大且属于上传原文。',
    '账号、Cookie、令牌等凭证字段一律不导出。',
  ]

  if (includeChat) {
    exported.chat = project.chat.map(copyChatMessage)
  } else {
    omitted.push('聊天记录 chat 未导出（默认关闭，可用 includeChat: true 开启）。')
  }

  return {
    schemaVersion: PROJECT_EXPORT_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? isoNow(),
    scope: 'local',
    project: exported,
    meta: {
      omitted,
      pendingDecision: [PENDING_DECISION_CHAT, PENDING_DECISION_SEGMENTS],
    },
  }
}

/* ------------------------------------------------------------ 云端项目导出 */

/**
 * 云端项目 → 只读投影快照。
 *
 * 只接受**当前已加载**的数据：传数组即视为已加载，不传则导出 `loaded: false`。
 * 不在这里补空数组、不读 cloud store、不发请求。
 */
export function buildCloudProjectExport(
  input: BuildCloudProjectExportInput,
): CloudProjectExport {
  const { project } = input

  return {
    schemaVersion: PROJECT_EXPORT_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? isoNow(),
    scope: 'cloud-projection',
    notice: CLOUD_EXPORT_NOTICE,
    project: {
      projectId: project.projectId,
      name: project.name,
      short: project.short,
      profile: copyProfile(project.profile),
      status: project.status,
      projectRevision: project.projectRevision,
      currentMilestoneId: project.currentMilestoneId,
      currentMilestone: project.currentMilestone,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      archivedAt: project.archivedAt,
      deletedAt: project.deletedAt,
      taskStats: { ...project.taskStats },
      milestones: project.milestones.map(copyCloudMilestone),
    },
    lists: {
      tasks: projectionOf(input.tasks, copyCloudTask),
      evidence: projectionOf(input.evidence, copyCloudEvidence),
      progress: projectionOf(input.progress, copyProgressRecord),
      materials: projectionOf(input.materials, copyCloudMaterial),
    },
    meta: {
      omitted: [
        '项目所有者 ownerUserId 未导出：对「带走自己的项目」无价值，按身份信息最小化处理。',
        '疑问未导出：V3 没有疑问读取端点，前端拿不到可信数据。',
        '材料片段与正文未导出：云端读取按 materialId 分页，不属于一次性快照。',
        '聊天记录未导出：云端聊天尚无持久化端点（契约第 30 节尚未合入 main）。',
        '阶段候选未导出：临时数据，会过期。',
        '账号、Cookie、令牌等凭证字段一律不导出。',
      ],
      pendingDecision: [PENDING_DECISION_CHAT, PENDING_DECISION_SEGMENTS],
    },
  }
}

/* ---------------------------------------------------------------- 序列化 */

/** 导出为 JSON 文本（2 空格缩进，便于学生自己打开看） */
export function serializeProjectExport(document: ProjectExportDocument): string {
  return JSON.stringify(document, null, 2)
}

/** 便捷入口：本地项目 → JSON 文本 */
export function serializeLocalProject(input: BuildLocalProjectExportInput): string {
  return serializeProjectExport(buildLocalProjectExport(input))
}

/** 便捷入口：云端投影 → JSON 文本 */
export function serializeCloudProject(input: BuildCloudProjectExportInput): string {
  return serializeProjectExport(buildCloudProjectExport(input))
}

/** 供界面提示「这是什么版本的导出文件」 */
export const PROJECT_EXPORT_SCHEMA_LABEL = `scp-project-export-v${PROJECT_EXPORT_SCHEMA_VERSION}`

/** 本地导出时的结构版本，便于界面同时展示两套版本号 */
export const LOCAL_PROJECT_SCHEMA_VERSION = PROJECT_SCHEMA_VERSION
