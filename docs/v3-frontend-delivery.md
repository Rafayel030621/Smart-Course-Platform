# V3 前端交付说明（李焰彬）

> 状态：**工作区未提交**。本文只描述当前工作区里的实现与验证结果，不宣称已合并或已部署。
> 相关记录：`李焰彬_v2联调与交接记录.md` §14（历史测试失败诊断）与 §14.7/§14.9（A/B/C 决策）。
>
> 一句话结论：**V3 数据层与本地真实后端联调已完成；页面只接入了只读的云端视图，登录、云端新建项目、云端写入入口仍未接线。**

---

## 1. 已实现范围与明确未完成项

### 1.1 数据层（已完成）

| 模块 | 文件 | 能力 |
| --- | --- | --- |
| V3 HTTP 适配 | `src/services/v3Http.ts` | 契约版本、`requestId`、幂等键、超时/取消、错误归一化（`V3Result`/`V3ApiError`）、写操作响应回显校验、`replayed` 标记 |
| 鉴权 | `src/services/authApi.ts` | `GET /api/auth/me`、登录、退出（Cookie 会话，前端不读取 Cookie） |
| 项目/阶段/任务/证据/进展 | `src/services/projectsApi.ts` | 契约 22.1–22.5 的读写封装，含版本冲突、幂等键与跨项目校验 |
| 会话状态 | `src/stores/session.ts` | `loading / authenticated / unauthenticated / error` 四态，项目列表状态，401 清理，epoch 丢弃迟到响应 |
| 云端领域状态 | `src/stores/cloud.ts` | 项目/阶段/任务/证据/进展的单一副本；写后合并、失败不半更新、`busy`/`isActionLoading` |
| 来源编排 | `src/stores/platform.ts` | 本地/云端来源切换、初始化、登录退出、选择/创建云端项目、迁移入口 |
| 云端只读投影 | `src/domain/cloudView.ts` | 服务端数据 → 旧页面 `Project` 视图；不伪造任务/疑问/材料/聊天 |
| 本地迁移 | `src/domain/localMigration.ts` + `src/stores/migration.ts` | 只读检测、显式确认、`migrationId` 复用重试、schema 版本拦截、失败保留 localStorage |
| AI 上下文 | `src/domain/v3Advisor.ts` + `cloud.buildAdvisorContext()` | 任务列表不完整时显式 `TASKS_NOT_AVAILABLE`，不拿空数组冒充完整上下文 |

### 1.2 页面接线（部分完成，需雍蕾继续）

| 页面 | 现状 |
| --- | --- |
| `src/App.vue` | 启动时调用一次 `platform.initialize()`（路由切换不重复请求）；右上角显示已确认的用户名 |
| `src/views/WorkbenchView.vue` | 已接入：来源切换、云端只读视图、云端写入入口隐藏（`guardCloudWrite`）、读取失败/加载中提示、迁移相关入口的占位文案 |
| `src/views/ProjectMapView.vue` | 云端模式下展示服务端阶段/统计；无云端数据时不伪造 |
| 未接线 | 登录/退出 UI、云端新建项目入口、云端写入（阶段/任务/证据/进展）入口、迁移确认弹窗、`chatError`/`fallbackReason` 展示 |

> **目标基线提醒（2026-10-20 隔离验证）**：上表的页面接线基于 `ac65287` 的旧页面结构。`origin/main` 已把工作台重构为「项目推进 / 项目资料」tabs（PR #16），因此这些页面补丁**不能直接应用到 main**：`src/views/WorkbenchView.vue` 冲突，需按新结构重做；`src/App.vue`、`src/views/ProjectMapView.vue` 可应用但需一并回归。数据层与本表页面接线应分两个 PR，详见 `docs/v3-commit-plan.md` §4。

### 1.3 真实本地后端已验证（有条件）

`npm run test:integration:v3-local` 在 loopback 后端上 **12/12 通过**，覆盖：注册/会话、项目归属、资料更新与 `STALE_REVISION`、阶段/任务/证据/进展全链路、跨项目越权、幂等回放、归档/软删/恢复、未冻结端点 404、退出保留本地项目。
**该后端来源未知，无法从当前仓库复现**，详见 §4.3。

### 1.4 受接口缺口阻塞（未实现，不伪造）

- 时间线、阶段候选、evidence/progress 单条读取仍未实现。
- 任务列表、材料读取（列表/单份/片段/理解条目）、进展 supersede **数据层已接入**（见 §2.5 / §2.5.1），页面尚未接线。
- 云端聊天仍是无状态接口（不落库）：会话/消息读写端点缺失，聊天历史只存在本次会话内存（见 §3 第 10 项）。
- 建议/聊天已支持 v3 阶段上下文（D13 `f83291d`）：云端项目发 v3 + `milestoneContext`，本地工作台仍发 v2（见 §2.5）。
- 聊天回答的 `citations` 服务端目前恒为空（D15 未做），客户端已能解析，但界面不要暗示「有材料依据」（见 §3 第 11 项）。
- 因此「云端聊天历史」在页面上仍不可用，界面已如实提示，不用空数组冒充成功。

---

## 2. 给雍蕾的接线指南

### 2.0 通用约定

- 所有 action 返回 `ActionResult<T>`：`{ ok: true, data }` 或 `{ ok: false, code, message }`。
  **不要把 `ok: false` 当成功**；`code` 用于分支，`message` 已是中文可直接展示。
- 云端写 action 额外提供 `busy`、`isActionLoading(name)`、`sync.status`（`idle/loading/saving/ready/error`）与 `lastError`。
- 网络失败时页面**必须保留用户输入**（表单内容、聊天草稿、迁移确认状态），不得清空。
- 云端项目是**只读接入**：不得调用 `useWorkbenchStore()` 的本地写 action（`claimTask` / `submitEvidence` / `sendChat` / `updateProjectProfile` 等）。这些 action 会写本地 localStorage，与云端项目无关。页面已用 `guardCloudWrite` 拦截，新增入口需自行守卫。

### 2.1 会话初始化 / 登录 / 退出

| 入口 | 参数 | 返回 | 状态与失败处理 |
| --- | --- | --- | --- |
| `platform.initialize(options?)` | `{ signal?, timeoutMs?, fetchImpl? }` | `ActionResult<AuthSnapshot>` | 启动调用一次即可（内部复用 Promise）；失败写 `platform.initError`，用 `platform.retryInitialize()` 显式重试，不自动轮询 |
| `platform.login(account, password, options?)` | 账号、密码 | `ActionResult<AuthSnapshot>` | 成功后 `source='cloud'`；失败保留输入、显示 `message`；`authStatus='error'` 表示网络/服务异常，不等于未登录 |
| `platform.logout(options?)` | 同上 | `ActionResult<{ loggedOut: true }>` | 即使服务端退出失败也会清理内存会话，并返回错误供提示；**本地项目与 localStorage 不会被删除**，来源回到 `local` |

可读状态：`platform.authStatus`（`loading / authenticated / unauthenticated / error`）、`platform.currentUser`、`platform.displayName`、`platform.isAuthenticated`、`platform.source`（`local`/`cloud`）。

### 2.2 云端项目列表、选择、创建

| 入口 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `platform.refreshCloudProjects(options?)` | 同上 | `ActionResult<CloudProjectSummary[]>` | 未登录返回 `UNAUTHORIZED`，不发请求；列表状态见 `projectsStatus`（`idle/loading/ready/error`）与 `projectsError` |
| `platform.selectCloudProject(projectId, options?)` | 项目 ID | `ActionResult<CloudProject>` | 只允许当前用户列表中的 ID，否则 `PROJECT_NOT_FOUND` 且不发请求；加载中 `cloudLoading`，失败 `cloudError`；切换后的迟到响应由 epoch 丢弃 |
| `platform.createCloudProject(input, options?)` | `{ name, short?, profile }`，`profile` 必填（契约 22.1） | `ActionResult<CloudProject>` | 成功后刷新列表并切到云端；**请求体不含阶段/模板**；若服务端擅自返回阶段，客户端以 `INVALID_RESPONSE` 拒绝，不写入状态 |

只读视图：`platform.cloudProjectView`（旧页面 `Project` 形状，含 `ms`/`tasks`/`evidence`/`banner` 等），`platform.cloudProject` 是原始 `CloudProject`。
未登录时页面应保持本地视图，不显示云端分组，也不清空本地项目。

### 2.3 本地迁移（只有显式确认才发请求）

| 入口 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `platform.detectLocalMigration()` | 无 | `LocalMigrationCandidate[]` | **只读**，不发请求；候选带 `blockReason`（`schema-outdated / schema-unsupported / malformed / duplicate-id / missing-reference`） |
| `platform.confirmLocalMigration(projectId, options?)` | 本地项目 ID | `ActionResult<LocalMigrationResponse>` | 内部固定 `userConfirmed: true`；成功才标记完成，失败保留 localStorage |
| `platform.retryLocalMigration(projectId, options?)` | 同上 | `ActionResult<LocalMigrationResponse>` | 复用同一 `migrationId`，不得生成新 ID |
| `migrationStore.status` | — | `idle / pending-confirmation / migrating / succeeded / failed / blocked` | 页面按状态展示对应提示；`migrationStatusLabel()`（`src/domain/localMigration.ts`）已提供中文文案，但页面尚未接线（见 §1.2）。`migrationStore.error` 为中文原因，候选级原因在 `candidates[].blockReason` / `errorMessage` |

约束：`pending-confirmation` 时不得自动发请求；迁移成功后本地项目仍保留（服务端已确认，但本地不删除）。

### 2.4 云端阶段 / 任务 / 证据 / 进展

所有 action 均带可选 `projectId`（传入时必须等于当前项目，用于防串项目），并返回 `ActionResult<T>`。

| action | 入参 | 返回 `data` | loading / 失败 |
| --- | --- | --- | --- |
| `cloud.openProject(projectId, options?)` | 项目 ID | `CloudProject` | `loadingProject=true`；失败 `lastError` |
| `cloud.refreshMilestones()` | 无 | `void` | 仅刷新阶段列表 |
| `cloud.refreshEvidence()` / `cloud.refreshProgress()` | 无 | `CloudEvidence[]` / `ProgressRecord[]` | 失败不改已有列表 |
| `cloud.loadTimeline()` | 无 | — | 恒返回 `TIMELINE_NOT_AVAILABLE`（契约端点未实现），**不会**发请求 |
| `cloud.createMilestone({name, goal?, doneCriteria?, dueAt?, status?, source?, candidateId?, confirmedByUser?})` | 见左 | `CloudMilestone` | 本地先查重名；成功后写入列表并递增版本 |
| `cloud.updateMilestone({milestoneId, expectedRevision, name?, goal?, doneCriteria?, dueAt?})` | 必填 `expectedRevision` | `CloudMilestone` | 版本不匹配 → `STALE_REVISION`，提示后刷新阶段 |
| `cloud.reorderMilestones({order})` | 阶段 ID 数组 | `CloudMilestone[]` | 顺序以服务端返回为准 |
| `cloud.activateMilestone / completeMilestone / reopenMilestone / archiveMilestone / restoreMilestone({milestoneId, expectedRevision})` | 同上 | `CloudMilestone` | 失败不改状态；归档后写任务会被服务端拒绝 |
| `cloud.createTask({title, doneCriteria?, milestoneId?, status?, assigneeUserId?})` | `status` 只能是 `todo/doing` | `CloudTask` | 成功后进入 `tasks` 并标记 `tasksHydrated` |
| `cloud.updateTask({taskId, expectedRevision, title?, doneCriteria?})` | 同上 | `CloudTask` | 失败保留原值 |
| `cloud.linkTaskToMilestone({taskId, milestoneId, expectedRevision, reopenMilestone?})` | `milestoneId` 可为 `null` | `CloudTask` | 跨项目 ID 本地拒绝 |
| `cloud.startTask / completeTask / reopenTask / archiveTask / restoreTask({taskId, expectedRevision, targetStatus?})` | `targetStatus` 仅 `reopen` 使用（`doing`/`todo`） | `CloudTask` | `complete` 只允许 `doing`；`reopen` 从 `done` 回到 `todo/doing` |
| `cloud.submitProgress({milestoneId, taskId, summary, evidenceIds?, occurredAt?})` | `milestoneId`/`taskId` 可空 | `ProgressRecord` | `summary` 1–1000 字；阶段与任务不一致时服务端 `INVALID_INPUT` |
| `cloud.createEvidence({taskId, milestoneId, didWhat, foundWhat?, stillUnsure?, attachmentName?, completeTask?, expectedTaskRevision?, submissionId?})` | 不传 `submissionId` 时内部生成并复用，用于重试幂等 | `{ evidence, doubt, task }` | `completeTask` 需任务为 `doing` 且必须给 `expectedTaskRevision`；失败整体不写入 |
| `cloud.attachEvidenceToTask({evidenceId, taskId, milestoneId, expectedRevision})` | 解绑传 `null` | `CloudEvidence` | 证据版本不匹配本地拒绝 |
| `cloud.archiveProject / restoreProject / deleteProject / restoreDeletedProject({projectId?})` | — | `CloudProject` | 归档/删除后写操作由服务端拒绝；恢复删除仅在宽限期内 |
| `cloud.buildAdvisorContext()` | 无 | `MilestoneContext` | 任务列表不完整时 `TASKS_NOT_AVAILABLE`；页面不得用空任务调用 AI |

幂等语义（已固化在 `tests/services/projectsIdempotency.test.ts`）：
- **同一逻辑操作重试**：同一 `projectRevision` + 同一 `idempotencyKey` → 服务端回放，`replayed=true`；
- **版本推进后的同内容**：属于新的逻辑操作，默认幂等键必须变化，否则服务端 `IDEMPOTENCY_CONFLICT`。

### 2.5 材料、进展更正与云端 AI（本次新增）

**材料读取（契约 22.8）**——`cloud.openProject()` 会自动调用 `refreshMaterials()`；页面也可以手动刷新：

| 入口 | 入参 | 返回 `data` | 状态与失败 |
| --- | --- | --- | --- |
| `cloud.refreshMaterials({ includeArchived?, limit?, silent?, projectId? })` | 分页拉全（内部按 `nextCursor` 循环） | `CloudMaterial[]` | `materialsStatus`（`idle/loading/ready/error`）、`materialsError`、`materialsHydrated`；失败保留原列表，不把「没读到」当「没有材料」 |
| `cloud.loadMaterialDetail(materialId, { version?, includeArchived? })` | 读历史版本传 `version` | `CloudMaterial` | 当前版本会同步回 `materials`；失败 `lastError` |
| `cloud.loadMaterialSegments(materialId, { version?, forceRefresh? })` | — | `CloudMaterialSegment[]` | 按 `materialId@version` 缓存（`cloud.cachedSegments()`），重复调用不发请求；`includeArchived=true` 不走缓存 |
| `cloud.loadMaterialUnderstanding(materialId, { version?, forceRefresh? })` | — | `CloudUnderstandingItem[]` | 同上（`cloud.cachedUnderstanding()`）；`sources[].startLine/endLine` 由服务端回填 |
| `cloud.buildConfirmedMaterialsContext()` | 无 | `ConfirmedMaterial[]` | 需要材料已读；任一份可入 AI 的材料还没读 → `MATERIALS_NOT_AVAILABLE`，不返回「空材料」 |
| `cloud.archiveMaterial(materialId)` / `cloud.restoreMaterial(materialId)` | 无需 `expectedRevision`（服务端只校验 `projectRevision`） | `CloudMaterial` | 归档后本地保留该行（`status='archived'`、`readOnly=true`）供页面展示，随后不带 `includeArchived` 的 `refreshMaterials()` 会把它移除；重复归档/恢复 → `INVALID_STATE_TRANSITION` |
| `cloud.reparseMaterial(materialId)` | 同上 | `CloudMaterial`（新 `materialVersion`） | 新版本片段直接写入缓存；新版本理解条目需重新生成，`buildConfirmedMaterialsContext()` 返回 `MATERIALS_NOT_AVAILABLE`，**不会**沿用旧版本的已确认内容 |
| `cloud.uploadMaterial({ name, contentBase64 })` | `name` 扩展名必须是 md/txt；`contentBase64` 是标准 base64（不带 data URL 前缀），解码后 ≤ 1 MB | `CloudMaterial` | 提交状态见 `cloud.materialUpload`（`idle/submitting/done/error` + `error` + `lastUpload`）；成功后列表立即包含该材料并推进 `projectRevision`；`deduplicated=true` 表示同项目同 sha256 命中既有材料（无新版本、revision 不变）；`parse_failed` 仍是提交成功，但**理解草稿未生成** |

> 上传不是 multipart：服务端只接受 `name` + `contentBase64` 的 JSON 包络，`materialId` / `materialVersion` 由服务端生成（上传固定 `version=1`）。

字段以服务端 DTO 为准：材料是 `materialVersion`（内容版本）+ `revision`（元数据/归档版本）、`parse_failed`（下划线）、`isCurrent`、`readOnly`、`failureReason`、`sha256`；片段是 `index`（不是 `orderIndex`）、`charCount`、`status`；理解条目是 `sources[]`，`status` 为 `pending/confirmed/modified/archived`。

**进展更正（契约 22.4）**

`cloud.supersedeProgress({ progressId, expectedRevision, summary?, taskId?, milestoneId?, evidenceIds?, occurredAt? })` → `data` 为新 `ProgressRecord`。成功后旧记录本地置 `superseded`（正文保留），新记录 `active`，并应用响应里的 `milestoneStats` 与 `projectRevision`；`buildAdvisorContext()` 只取 `active`，所以更正后的正文必然进入 AI 上下文。已 `superseded` 的记录重复更正返回 `INVALID_STATE_TRANSITION`。

**云端 AI（契约 23.1 / 23.5 / 23.7，D13 `f83291d` 之后）**

| 入口 | 说明 |
| --- | --- |
| `cloud.refreshAdvisor({ forceRefresh?, projectId? })` | 组装 `milestoneContext` + `confirmedMaterials` + 任务/证据快照后调用 `POST /api/advisor/recommendations`（**固定 v3**）；状态见 `cloud.advisor`（`status/suggestions/source/cached/fallbackReason/error/contextAttached`） |
| `cloud.sendChat({ question, projectId? })` | 调用 `POST /api/advisor/chat`（**固定 `advisor-chat-v3`**），历史由客户端 `chatHistory` 回传；成功后用户消息与回答一起入列，失败保留 `chat.pendingQuestion` |
| `cloud.retryChat()` / `cloud.clearChat()` | 重发失败的问题 / 清空本次会话消息 |
| `cloud.chat` | `messages`（`clientId/role/text/source/fallbackReason/citations/createdAt`）、`status`、`error`、`pendingQuestion` |

版本选择（不要再加开关）：
- 只有**云端项目**能发 v3：`supportsMilestoneContext('cloud') === true`，cloud store 里的建议/聊天都走 `mvp-prompt-v3` / `advisor-chat-v3` 并携带 `milestoneContext`；
- **本地工作台**继续 v2：`workbench` store 走 `mvp-prompt-v2` / `advisor-chat-v2`，请求体不带 `milestoneContext`（本地实体 ID 服务端不认识，发 v3 必 400）；
- 服务端按 `projectId` 校验阶段/任务/证据/进展归属，失败返回 400 `INVALID_INPUT`；契约 23.1 禁止自动降级，客户端原样报错，不重发 v2。

约束：
- `milestoneContext` 由 `cloud.buildAdvisorContext()` 产出：阶段只允许 `planned/active`，已完成/已归档阶段给全 null 的空上下文，顶层 `currentMilestone` 同步为 null；
- `doubts` 目前只能发空数组（V3 没有疑问读取端点），这是已知信息缺口；
- 同一时刻只允许一个在途建议/聊天请求；切项目、退出登录会清空 `advisor`/`chat` 并丢弃迟到响应；
- 聊天**不落库**：刷新、换设备都看不到历史，页面不要展示「云端会话列表」；
- 回答里的 `citations` 已按契约解析（名称/版本/行号全部用服务端回填值），但服务端 D15 之前恒返回 `[]`，页面不要暗示「有材料依据」。

### 2.5.1 「项目资料」页接线（给雍蕾的可复制入口）

四个读取函数都在 `src/services/projectsApi.ts`，全部 `export`，签名固定（页面不要自己拼 URL）：

```ts
import type { CloudMaterial, CloudMaterialSegment, CloudUnderstandingItem } from '@/types/platform'
import type {
  CloudMaterialPage,
  CloudMaterialSegmentsPage,
  CloudMaterialUnderstandingPage,
  MaterialListQuery,
  MaterialPageQuery,
  MaterialReadQuery,
} from '@/services/projectsApi'

// 列表：默认只返回每个 materialId 的当前版本；includeArchived 才会带上已归档
listMaterials(
  projectId: string,
  query?: MaterialListQuery,          // { includeArchived?: boolean; limit?: number; cursor?: string }
  options?: ProjectApiOptions,        // { signal?, timeoutMs?, fetchImpl? }
): Promise<V3Result<CloudMaterialPage>>          // data: { materials: CloudMaterial[]; nextCursor: string | null }

// 单份：version 不传 = 当前版本，传了读历史版本（此时 readOnly=true）
getMaterial(
  projectId: string,
  materialId: string,
  query?: MaterialReadQuery,          // { version?: number; includeArchived?: boolean }
  options?: ProjectApiOptions,
): Promise<V3Result<{ material: CloudMaterial }>>

// 片段：按 index 升序；响应头自带 materialVersion / isCurrent / readOnly
listMaterialSegments(
  projectId: string,
  materialId: string,
  query?: MaterialPageQuery,          // { version?; includeArchived?; limit?; cursor? }
  options?: ProjectApiOptions,
): Promise<V3Result<CloudMaterialSegmentsPage>>  // data: { materialId, materialVersion, isCurrent, readOnly, segments, nextCursor }

// 理解条目（草稿）：sources[] 里的行号由服务端回填
listMaterialUnderstanding(
  projectId: string,
  materialId: string,
  query?: MaterialPageQuery,
  options?: ProjectApiOptions,
): Promise<V3Result<CloudMaterialUnderstandingPage>> // data: { materialId, materialVersion, isCurrent, readOnly, items, nextCursor }
```

`V3Result<T>` 是 `{ ok: true, data: T, requestId, projectRevision, replayed, changed } | { ok: false, code, message }`（`code: V3ErrorCode`）。
`nextCursor !== null` 表示还有下一页：把 `cursor` 传回去继续拉（store 的 `refreshMaterials()` 已经内部循环拉全，页面一般不需要自己翻页）。

**推荐直接用 store**（已包含分页拉全、loading/error/清空、切项目隔离）：

```ts
const cloud = useCloudStore()

// 打开项目时会自动加载一次：cloud.materials / materialsStatus / materialsError / materialsHydrated
await cloud.openProject(projectId)

// 手动刷新（forceRefresh 用于「重新读取并丢弃缓存」的按钮）
await cloud.refreshMaterials({ forceRefresh: true })

// 详情面板
const segments = await cloud.loadMaterialSegments(materialId)      // 命中缓存则不发请求
const drafts = await cloud.loadMaterialUnderstanding(materialId)
if (segments.ok) renderSegments(segments.data)                     // CloudMaterialSegment[]
else toast(segments.message)                                       // 中文原因，直接展示 message
```

渲染时注意：
- 判断「空」要看 `cloud.materialsHydrated && cloud.materialsStatus === 'ready'`，`materialsError !== null` 时是「没读到」而不是「没有材料」；
- 材料状态是 `registered / parsed / parse_failed / unsupported / archived`；`readOnly=true` 时不要渲染编辑/删除按钮；
- 片段序号用 `index`（服务端字段名，不是 `orderIndex`），行号用 `startLine/endLine`；
- 归档用 `cloud.archiveMaterial(materialId)`、恢复用 `cloud.restoreMaterial(materialId)`、重新解析用 `cloud.reparseMaterial(materialId)`；
- 上传用 `cloud.uploadMaterial({ name, contentBase64 })`，`File` → base64 直接复用 `@/services/materialsApi` 的 `bytesToBase64(new Uint8Array(await file.arrayBuffer()))`。

**上传接线示例**（页面只做 UI，不做协议）：

```ts
const cloud = useCloudStore()

async function onPick(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const result = await cloud.uploadMaterial({
    name: file.name,                       // 扩展名必须是 md/txt，否则服务端返回 UNSUPPORTED_MATERIAL_TYPE
    contentBase64: bytesToBase64(bytes),   // 不带 data URL 前缀；> 1 MB 客户端会直接拒绝
  })
  if (!result.ok) {
    // code: MATERIAL_TOO_LARGE / EMPTY_MATERIAL / UNSUPPORTED_MATERIAL_TYPE /
    //       MATERIAL_ENCODING_UNREADABLE / STALE_REVISION / PROJECT_ARCHIVED / DUPLICATE_REQUEST …
    toast(result.message)                  // 中文原因，直接展示；STALE_REVISION 时先 refreshProject 再重试
    return
  }
  const { material, status } = result.data
  // 提交成功 ≠ 理解已生成：status='parse_failed' 时提示「解析失败，可重新上传」；
  // 想把新材料作为 AI 依据，必须先确认理解条目（loadMaterialUnderstanding + 确认流程），
  // 否则 buildConfirmedMaterialsContext() 不会包含它。
  await cloud.refreshMaterials({ forceRefresh: true })   // 需要服务端顺序/归档过滤时以服务端为准
}
```

`cloud.materialUpload` 用于驱动「上传中」按钮与错误提示：`status`（`idle/submitting/done/error`）、`error {code,message}`、`lastUpload {materialId, materialVersion, materialStatus, deduplicated, segmentCount}`。
注意：上传响应的 `segments` 最多只有前 20 条（`segmentCount` 是真实总数），需要完整片段时调 `loadMaterialSegments()`。

### 2.6 页面必须遵守的展示规则

1. 云端模式下隐藏/禁用本地写入口（`guardCloudWrite` 已提供示例），并显示「只读接入」说明。
2. `tasksHydrated=false` 时不要展示「暂无任务」以外的结论；需提示契约缺口（`cloud.contractBlockers`）。
3. 证据/进展/阶段列表为空必须区分「真的为空」与「加载失败/未实现」：用 `lastError`、`sync.status` 判断，不用空数组当成功。
4. 失败提示使用 `message`，不显示 `code`/字段名（契约 4.3 / 17.3）。

---

## 3. 给姜厚禄的接口缺口清单

> 2026-10-20 更新：`origin/main` 已补齐任务/材料读取与材料写入（PR #20 / #21），下表按最新 `docs/v3-v4-interface-status.md` 修正。

| # | 能力 | 现状分类 | 依据 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | 任务列表/单条读取（`GET /projects/:id/tasks`、`GET /tasks/:id`） | **已接入（本 PR）** | `server/src/v3/taskReads.ts`（支持 `milestoneId`/`status`/`includeArchived`/`limit`/`cursor`） | `refreshTasks()` 在打开项目、切换阶段、任务写成功后校正列表：分页合并、按 `taskId` 去重、失败保留原任务且不置 `tasksHydrated`；成功后 AI 上下文可用 |
| 2 | 时间线（契约 22.11） | **缺实现** | 后端 `server/src/v3` 无 timeline 路由 | `loadTimeline()` 恒返回 `TIMELINE_NOT_AVAILABLE`，页面无时间线 |
| 3 | 阶段候选（契约 23.7 `POST .../milestones/candidates`） | **缺实现（表已建）** | 后端 router 无该路由 | 客户端未实现调用；AI 生成阶段候选不可用 |
| 4 | 进展 supersede（契约 22.4） | **已接入（本次）** | `server/src/v3/progress.ts#handleProgressSupersede`：`expectedRevision` 必填，`summary/taskId/milestoneId/evidenceIds/occurredAt` 可选，响应 `{progress, supersededProgressId, milestoneStats}` | `cloud.supersedeProgress()` 已可用；**契约正文仍没有请求字段表**，需补文档 |
| 5 | 材料读取（`GET /materials`、`/materials/:id`、`/segments`、`/understanding`） | **已接入（本次）** | `server/src/v3/materialReads.ts`（`includeArchived`/`version`/`limit`/`cursor`） | `cloud.refreshMaterials()/loadMaterialSegments()/loadMaterialUnderstanding()` 已可用；页面尚未接线（§2.5） |
| 6 | evidence/progress 单条读取 | **缺实现** | 后端无 `GET /evidence/:id`、`GET /progress/:id` | 详情只能从列表筛 |
| 7 | 服务端聊天问题长度校验（契约 6.4，≤2000 字） | **两者不一致（历史遗留）** | 前端已在 store 前置拒绝；服务端应返回 400 `INVALID_INPUT` | 若后端仍截断，用户会误以为问题已完整提交 |
| 8 | 创建项目不得注入模板阶段（契约 22.1） | **实现一致性防御已加** | 客户端请求体不含 `milestones`，且服务端返回阶段时以 `INVALID_RESPONSE` 拒绝 | 后端若改变行为，会立即被测试与客户端拦下 |
| 9 | 顾问/聊天接受 v3 阶段上下文（契约 23.1 / 23.4） | **已实现并已接入（D13 `f83291d`）** | `server/src/advisor/types.ts` 的 `ADVISOR_PROMPT_VERSIONS` / `ADVISOR_CHAT_PROMPT_VERSIONS` 含 v3；`validation.ts#parseMilestoneContext` 校验 23.2；`index.ts#createMilestoneContextValidator` 按 `projectId` 校验阶段/任务/证据/进展归属 | cloud store 固定发 v3 并携带 `milestoneContext`；本地工作台仍发 v2（`supportsMilestoneContext()` 按来源判定）；真实联调用例见 `tests/integration/advisorV3.integration.test.ts` |
| 10 | 云端聊天会话/消息持久化（`chat_sessions` / `chat_messages` 读写） | **缺实现** | 后端只有 `POST /api/advisor/chat`（无状态、不落库）；`chat_sessions`/`chat_messages` 表存在，但 `server/src/v3/router.ts` 没有任何会话/消息读写路由 | `cloud.sendChat()` 只在本次会话内存里维护消息，刷新/换设备即丢失；页面不要展示「云端历史会话」。需要后端补：会话列表、会话消息分页、按会话继续聊 |
| 11 | 聊天响应 `citations` / `milestoneRevision`（契约 23.7） | **字段已回显，引用为空（D15 未做）** | `server/src/routes/advisorChat.ts` 现在返回 `promptVersion`/`milestoneRevision`，但 `citations` 恒为空数组：`validation.ts` 还没有解析模型返回的 `segmentId`，`prompt.ts` 只生成了 `m1:seg_x` 虚拟标识 | 客户端已按契约解析真实 `segmentId/materialName/startLine/endLine`；后端补上映射后前端无需改动 |
| 12 | 疑问读取（V3 doubts） | **缺实现** | 无 `GET /projects/:id/doubts` | 建议/聊天的 `doubts` 只能发空数组，未解决疑问不进 AI 上下文 |
| 13 | 材料上传的客户端函数（`POST /projects/:id/materials`） | **已接入（材料上传分支）** | `server/src/v3/materialWrites.ts#handleMaterialUpload`（`name` + `contentBase64`，非 multipart）；服务端按解码后字节判 1 MB，响应 `segments` 只回前 20 条 | `uploadMaterial()` + `cloud.uploadMaterial()` 已可用；真实联调用例 `tests/integration/materialUpload.integration.test.ts`；页面接线见 §2.5.1 |

> 第 2、3、6、10、11、12 项是真实的后端缺口；第 4、5、13 项数据层已接入、页面待接线（§2.5.1）；第 9 项已由 D13 完成并被客户端用上；第 1 项在上一 PR 接入。客户端已把缺口收敛到 `cloud.contractBlockers`、`advisor.contextAttached` 与对应错误码。

---

## 4. 验证与复现

### 4.1 已执行的命令（未注入 `VITE_API_BASE_URL`）

**必须按形态区分，数字不可互换（2026-10-20 隔离验证）：**

| 形态 | `npm test` | `typecheck` | `build` | `eslint` |
| --- | --- | --- | --- | --- |
| **PR-1 分支** `feature/v3-frontend-data-layer`（`origin/main` + V3 数据层，不含页面） | **815/815，34 文件** | **0 错误** | 通过 | 通过 |
| PR-1 分支合并 main `2cde85f` 后（HEAD `251dfb3`） | **815/815，34 文件** | **0 错误** | 通过 | 通过 |
| **PR-1 分支评审修复后（本次修复提交）** | **820/820，35 文件** | **0 错误** | 通过 | 通过 |
| **本次补齐（`origin/main` 基线 `ee6cc2d`，材料/上下文/更正/聊天）** | **899/899，42 文件** | **0 错误** | 通过 | 通过 |
| **对齐 v3.10（工作区已同步 `origin/main` 内容至 `90956b8`/`f83291d`）** | **927/927，42 文件** | **0 错误** | 通过 | 通过 |
| **交付分支 `feature/liyanbin-v3-delivery`（`1a1eed9`）** | **927/927，42 文件** | **0 错误** | 通过 | 通过 |
| **材料上传分支 `feature/liyanbin-v3-material-upload`（基于 `1a1eed9`）** | **947/947，44 文件** | **0 错误** | 通过 | 通过 |
| 隔离验证目录 `scp-v3-verify-main-data` | 815/815，34 文件 | 0 错误 | 通过 | 通过 |
| 完整混合工作区（主目录，基线 `ac65287`） | 787/787，35 文件 | 0 错误 | 通过 | 通过 |
| 严格 A 组（`ac65287` + 仅 V3 hunk） | 789 用例：727 通过 / 62 失败 | 23 错误（基线 21 + 2） | 通过 | 通过 |
| 纯净基线 `ac65287` | 717 用例：655 通过 / 62 失败 | 21 错误 | — | — |

- V3 专项 11 个文件 72/72 通过（在 `ac65287` 基线上测得）。
- A 组与基线的失败用例集合逐条一致（62 条，零差异），说明 V3 未引入测试回归，但旧基线本身不绿。
- `npm run test:integration:v3-local`：**12/12**，2026-10-20 最近一次实际运行；该次运行在混合工作区（旧基线）上，**未在 `origin/main` 基线上重跑**，后端来源见 §4.3。

验证目录（保留供复核）：`D:/bdana_program/scp-v3-verify-baseline`、`scp-v3-verify-ac65287`、`scp-v3-verify-agroup-strict`、`scp-v3-verify-main`、`scp-v3-verify-main-data`。
实际提交分支工作区：`D:/bdana_program/Smart-Course-Platform-v3-data-layer`（分支 `feature/v3-frontend-data-layer`，6 个提交）。

### 4.2 集成测试运行方式

```powershell
$env:V3_LOCAL_API_BASE_URL='http://127.0.0.1:8099'
$env:V3_LOCAL_INVITE_CODE='<本地后端邀请码>'
npm run test:integration:v3-local
```

- 只允许 loopback（`localhost` / `127.0.0.0/8` / `::1`），非 http(s)、带凭据、带 `/api` 后缀的地址在**发请求前**失败；
- `fetch` 闸门强制 `redirect: 'error'`，不跟随外部重定向；
- 不读取也不设置 `VITE_API_BASE_URL`；`npm test` 排除 `tests/integration/**`；
- 测试数据带 `[v3local]` 标记，不自动清理（详见 `docs/integration-v3-local.md`）。

### 4.3 后端来源：**未知**

- 验证连接的是 `http://127.0.0.1:8099` 上已运行的本地后端；
- 该后端位于工作区 `.tmp-v3-backend/`（**未纳入版本库**，无 `.git`，`package.json` 版本 `0.1.0`），**无法给出分支或提交 SHA**；
- 该次运行时间早于 `origin/main` 合并 V3 后端（PR #19，`codex/v3-v4-backend`），其构建产物与 main 的 `server/src/v3/**` 是否同源**无法证明**；因此**不能据此断言可从当前仓库复现这 12 条用例**；
- 复现前置：负责人提供与 main 同源的后端（分支/提交/构建产物任一可核验标识），再重跑并记录结果。

### 4.4 本次真实联调（后端来源可核验）

2026-10-22 本次验证改用**仓库内 `server/`**（工作区已同步到 `origin/main` 内容，含 D13 `f83291d`），不再是 `.tmp-v3-backend/`：

```powershell
cd server; npm install; npm run build          # 生成 server/dist
$env:PORT='8099'; $env:HOST='127.0.0.1'
$env:SCP_DB_PATH='d:/.../.tmp-it/advisor-v3.sqlite'
$env:INVITE_CODE='<本地联调邀请码>'; $env:SCP_COOKIE_SECURE='0'
$env:ADVISOR_PROVIDER='mock'
node server/dist/src/index.js                  # 后台运行

$env:V3_LOCAL_API_BASE_URL='http://127.0.0.1:8099'
$env:V3_LOCAL_INVITE_CODE='<同一邀请码>'
npx vitest run --config vitest.integration.config.ts tests/integration/advisorV3.integration.test.ts   # 5/5
npx vitest run --config vitest.integration.config.ts tests/integration/v3LocalBackend.integration.test.ts  # 12/12
```

覆盖范围：
- 材料四个读取接口（`/materials`、`/materials/:id`、`/segments`、`/understanding`）真实 200，字段（`materialVersion/revision/isCurrent/readOnly/index/charCount/startLine`）逐项断言；
- cloud store 链路：`openProject → materials`、`loadMaterialSegments/Understanding` 命中缓存（第二次调用不发请求）；
- 云端建议 v3：请求体 `promptVersion=mvp-prompt-v3` + 完整 `milestoneContext`，服务端 200；
- 负向：把**另一个项目的任务 ID**塞进 `milestoneTasks` → 服务端 400 `INVALID_INPUT`（message 含「任务」），客户端不降级重发；
- 聊天 `advisor-chat-v3` 200，响应 `citations` 缺失/空数组都能解析。

未覆盖：模型真实输出（provider 用 `mock`）、材料上传后的理解草稿生成、D15 引用回填（服务端尚未实现）。

### 4.5 材料上传的真实联调

同一套本地后端（`server/`，基线 `90956b8`，`ADVISOR_PROVIDER=mock`）：

```
npx vitest run --config vitest.integration.config.ts tests/integration/materialUpload.integration.test.ts   # 5/5
npx vitest run --config vitest.integration.config.ts                                                        # 3 文件 / 22 条
```

覆盖：
- store 上传 → 列表立即可见、`projectRevision` +1、`materialUpload.lastUpload.segmentCount` 为服务端真实总数；
- **分段规则实测**：`parseText` 会把连续非空行合并到 2,000 字以内，所以「片段数 > 20（响应截断）」必须用 ≥ 20 个 2,000 字块构造（本次用 12 段 × 2,100 字 ≈ 24 段）；截断响应**不写入**版本缓存，`loadMaterialSegments()` 能拿全；
- 同内容重传 → `deduplicated=true`、`projectRevision` 不变、列表不重复；
- 过期 `projectRevision` → 409 `STALE_REVISION`（带 `currentProjectRevision`），随后重试成功；
- 理解条目读取端点可读，但本环境未配置真实模型，**未验证**上传后的理解草稿生成。

---

## 5. 建议交付与排除

### 5.1 建议纳入交付（只列清单，未暂存）

**新增源码（10）**

```
src/domain/cloudView.ts        src/domain/localMigration.ts   src/domain/v3Advisor.ts
src/services/authApi.ts        src/services/projectsApi.ts    src/services/v3Http.ts
src/stores/cloud.ts            src/stores/migration.ts        src/stores/platform.ts
src/stores/session.ts
```

**修改源码（4，必须按 hunk 取用）**

```
src/types/platform.ts（仅 V3 类型块，423 行）
src/domain/recommendation.ts（仅 V3 常量/类型，59 行）
src/services/http.ts           src/services/advisorApi.ts   README.md
```

> `src/types/platform.ts` 的前 2 个 hunk（`SuggestedStep.taskId/status`、`Task.draftKey`）与 `recommendation.ts` 的 `ClaimTaskResult.status`、`describeAdvisorFailure` 属 v2/§14，**已存在于 `origin/main`**，不属于本交付；整文件提交会把 v2 改动混进 V3 PR。

**页面接线（另开 PR，未验证）**：`src/App.vue`、`src/views/ProjectMapView.vue`、`src/views/WorkbenchView.vue`（后者与 main 的 tabs 重构冲突）。

**v2 收尾（不纳入）**：`src/stores/persistence.ts`、`src/stores/workbench.ts` —— 其 `draftKey` 修复已在 `origin/main`（PR #14/#15）。

**配置 / 脚本（4）**：`package.json`、`vitest.config.ts`、`vitest.integration.config.ts`、`scripts/run-v3-local-integration.mjs`

**新增测试与基建（12 个测试文件 + 3 个 support）**

```
数据层测试（10，随数据层 PR）
tests/domain/cloudView.test.ts        tests/domain/v3Advisor.test.ts
tests/stores/cloud.test.ts            tests/stores/cloudWrites.test.ts
tests/stores/cloudTaskReads.test.ts   tests/stores/migration.test.ts
tests/stores/platform.test.ts         tests/stores/session.test.ts
tests/services/projectsIdempotency.test.ts  tests/services/v3LocalTarget.test.ts

集成测试（1，随数据层 PR）
tests/integration/v3LocalBackend.integration.test.ts

页面测试（2，随页面 PR）
tests/ui/AppSession.test.ts           tests/ui/WorkbenchViewCloud.test.ts

测试基建（3）
tests/support/v3Fixtures.ts  tests/support/v3LocalHarness.ts  tests/support/v3LocalTarget.ts
```

**修改测试（不纳入）**：`tests/domain/fixtures.ts`、`tests/setup.ts`、`tests/stores/workbench.test.ts`、`tests/ui/ProjectCreate.test.ts`、`tests/ui/ProjectMapView.test.ts`、`tests/ui/ProjectProfileForm.test.ts`、`tests/ui/WorkbenchView.test.ts` —— 属 v2/§14 测试适配，`origin/main` 已包含。

**文档（4）**：`docs/integration-v3-local.md`、`docs/v3-frontend-delivery.md`、`docs/v3-pr-draft.md`、`docs/v3-commit-plan.md`（`李焰彬_v2联调与交接记录.md` §14 属 v2 记录，已在 main）。

### 5.2 应排除（本地文件，不提交）

| 路径 | 类别 | 说明 |
| --- | --- | --- |
| `.tmp-v3-backend/` | 本地后端构建 + SQLite 测试库 | 含 `integration.sqlite*`、`.env*`、`dist/`；未入库，禁止提交（可能含本地邀请码配置） |
| `liyanbin-fix.patch` | 补丁快照 | 归属不明，保留在原位，不纳入交付 |
| `debug.log`、`f2.log`~`f7.log`、`m1.log` | 调试日志 | 非本轮产生，`*.log` 已被 `.gitignore` 忽略，保留 |
| `dist/`、`node_modules/`、`.codebuddy/`、`output/` | 构建产物/缓存 | 已忽略，不提交 |

### 5.3 归属说明

- §5.1 的源码/测试/文档均属本次 V3 交付内容；
- `liyanbin-fix.patch`、`debug.log`、`f2.log`~`f7.log`、`m1.log` 在本轮开始前已存在，**归属不明**，本轮未删除、未移动、未暂存；
- 页面文件（`src/App.vue`、`src/views/*.vue`）属于只读云端接入的页面改动，后续页面工作由雍蕾继续；本轮未再修改它们。
