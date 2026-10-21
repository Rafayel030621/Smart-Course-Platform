# V3 前端交付说明（李焰彬）

> 状态：**本轮 D14 修改已在本地提交（未推送）**。本文只描述当前分支里的实现与验证结果，不宣称已合并或已部署。
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

- 时间线、阶段候选、evidence/progress 单条读取仍未实现；材料读取与进展 supersede 已由后端实现但前端尚未接入；**任务列表已在本 PR 接入**（详见 §3）。
- 因此「刷新后恢复任务」「云端 AI 上下文」「云端证据/材料写入」在页面上仍不可用，界面已如实提示，不用空数组冒充成功。

### 1.5 D14：提示词常量区分 + 聊天引用展示（本轮完成）

**1）提示词常量（`src/domain/recommendation.ts`）**

| 常量 | 值 | 允许使用的接口 |
| --- | --- | --- |
| `ADVISOR_V3_PROMPT_VERSION` | `mvp-prompt-v3` | **仅**建议接口 `POST /api/advisor/recommendations`（必须与 `milestoneContext` 成对出现） |
| `MILESTONE_CANDIDATE_PROMPT_VERSION` | `milestone-candidate-v1` | **仅**阶段候选接口 `POST /api/projects/{projectId}/milestones/candidates`；**只定义、不使用** |

- 旧的 `MILESTONE_PROMPT_VERSION` 已删除，`buildAdvisorRequest()` 的 v3 分支改用 `ADVISOR_V3_PROMPT_VERSION`；全仓检索旧名 0 命中。
- **D12 仍受阻**：`server/src/v3/router.ts` 的 `milestones` 分支没有 `candidates` 路由（请求会被当成 `milestoneId` 走 PATCH），因此本轮没有装配候选请求、没有猜端点、没有发请求；常量的存在不代表候选能力可用。
- 依据说明：当前分支的 `docs/ai/prompt-spec.md` **没有** §9.3 / §11.5 / §11.7（§9 只有 9.1/9.2，§11 是附录 A），D14 的取值拆分依据来自任务要求转述；权威规格章节**待文档负责人确认**后再对齐，本轮未自行创建或改写这些章节。

**2）聊天 citations 全链路（契约 23.3 / 23.7）**

| 环节 | 位置 | 行为 |
| --- | --- | --- |
| 解析 | `src/services/advisorApi.ts`（`asChatSuccess`） | 已有实现：逐条校验引用，非法条目剔除；`citations` 不是数组 → 整份响应按 `invalid-response` 丢弃；字段完全缺失 → 不补造 |
| 保存 | `src/stores/workbench.ts`（`sendChat` → `appendAssistant`） | 成功回答把适配层校验后的引用写进消息；只保留 `MaterialSourceRef` 的六个展示字段，适配层多解析的 `itemId` 不落盘；用户消息、失败回答、无引用回答一律 `[]` |
| 类型 | `src/types/platform.ts`（`ChatMessage.citations`） | 必填 `MaterialSourceRef[]`，与「无引用 = 空数组」一致 |
| 旧数据 | `src/stores/persistence.ts`（`normalizeChatMessage`） | 旧 localStorage 记录没有该字段 → 补 `[]`，**消息一条不丢**；引用逐条校验，缺材料名的引用剔除（不拿 `materialId` 顶替）；学生消息的引用强制清空 |
| 展示 | `src/views/WorkbenchView.vue`（`chatCitationsText`） | **仅非空时**显示 `依据材料：实验手册.md（版本 2）第 10–24 行`；同一材料多段合并；只显示材料名/版本/行号，不显示 `materialId`/`segmentId` |

空引用行为（契约 23.7：不得暗示存在材料依据）：服务端返回 `[]`、字段缺失、或非法引用被全部过滤成空时，**不渲染任何来源标签**，`answer` 照常显示；前端不从本地材料或聊天历史补造引用。

兼容性：属于附加字段 + 读取归一化，**未升 `schemaVersion`（仍为 3）**，不需要新增迁移分支；旧版本代码读到新记录会忽略该字段。

**3）本轮明确未做**

- suggestion 的 `basisMaterialRefs` **仍未展示**：`src/components/SuggestionCard.vue` 的「依据」只有证据与疑问（`basisCount = evidence + doubts`），建议卡上的材料引用既没有渲染也没有测试；本轮按要求没有顺带扩大改动。

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

### 2.5 页面必须遵守的展示规则

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
| 4 | 进展 supersede（契约 22.4） | **后端已实现；前端未接入** | `POST /progress/:id/supersede`，旧记录转 `superseded` | 页面无法修正已提交进展 |
| 5 | 材料读取（`GET /materials`、`/materials/:id`、`/segments`、`/understanding`） | **后端已实现；前端未接入** | `server/src/v3/materialReads.ts` | `confirmedMaterials` 仍需调用方显式传入；页面无法回读 |
| 6 | evidence/progress 单条读取 | **缺实现** | 后端无 `GET /evidence/:id`、`GET /progress/:id` | 详情只能从列表筛 |
| 7 | 服务端聊天问题长度校验（契约 6.4，≤2000 字） | **两者不一致（历史遗留）** | 前端已在 store 前置拒绝；服务端应返回 400 `INVALID_INPUT` | 若后端仍截断，用户会误以为问题已完整提交 |
| 8 | 创建项目不得注入模板阶段（契约 22.1） | **实现一致性防御已加** | 客户端请求体不含 `milestones`，且服务端返回阶段时以 `INVALID_RESPONSE` 拒绝 | 后端若改变行为，会立即被测试与客户端拦下 |

> 第 2、3、6 项是真实的后端缺口；第 4、5 项属"后端就绪、前端待接"的后续任务；第 1 项已在本 PR 接入。客户端已预留 `contractBlockers` 与错误码，补接线不需要改数据层结构。

---

## 4. 验证与复现

### 4.1 已执行的命令（未注入 `VITE_API_BASE_URL`）

**必须按形态区分，数字不可互换（2026-10-20 隔离验证）：**

| 形态 | `npm test` | `typecheck` | `build` | `eslint` |
| --- | --- | --- | --- | --- |
| **PR-1 分支** `feature/v3-frontend-data-layer`（`origin/main` + V3 数据层，不含页面） | **815/815，34 文件** | **0 错误** | 通过 | 通过 |
| PR-1 分支合并 main `2cde85f` 后（HEAD `251dfb3`） | **815/815，34 文件** | **0 错误** | 通过 | 通过 |
| **PR-1 分支评审修复后（本次修复提交）** | **820/820，35 文件** | **0 错误** | 通过 | 通过 |
| **D14（常量区分 + 聊天引用链路，本轮本地提交）** | **835/835，35 文件** | **0 错误** | 通过 | 通过 |
| 隔离验证目录 `scp-v3-verify-main-data` | 815/815，34 文件 | 0 错误 | 通过 | 通过 |
| 完整混合工作区（主目录，基线 `ac65287`） | 787/787，35 文件 | 0 错误 | 通过 | 通过 |
| 严格 A 组（`ac65287` + 仅 V3 hunk） | 789 用例：727 通过 / 62 失败 | 23 错误（基线 21 + 2） | 通过 | 通过 |
| 纯净基线 `ac65287` | 717 用例：655 通过 / 62 失败 | 21 错误 | — | — |

- V3 专项 11 个文件 72/72 通过（在 `ac65287` 基线上测得）。
- D14 新增 15 条用例（820 → 835）：parser 4（引用解析/非数组拒绝/空数组/字段缺失）、store 4（落库与不补造）、UI 2（展示与空引用不显示）、持久化 4（旧记录补空数组/加载不丢消息/非法剔除/往返）、常量 1（两个 v3 常量互不顶替）。
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

### 5.1.1 D14 追加文件（本轮，覆盖 §5.1 中的“不纳入”表述）

D14 要保存并展示聊天引用，因此本轮**修改了 3 个此前标为“不纳入”的文件**；改动只限引用链路，不夹带 v2 修复或云端接线：

| 文件 | 本轮改动 | 为什么必须动 |
| --- | --- | --- |
| `src/stores/persistence.ts` | 新增 `normalizeChatMessage` / `normalizeCitationRef`，`chat` 改为逐条归一化 | 旧 localStorage 没有 `citations`，必须补空数组且不丢消息 |
| `src/stores/workbench.ts` | `appendAssistant` 增加 `citations` 参数；`sendChat` 成功时落库 | 引用要进聊天记录，页面才有数据可展示 |
| `src/views/WorkbenchView.vue` | 新增 `chatCitationsText()` 与 `.chat-citations` 渲染 | 契约 23.7：有引用才显示来源，空引用不得暗示材料依据 |

其余 9 个文件：`src/domain/recommendation.ts`、`src/services/advisorApi.ts`、`src/types/platform.ts`（常量、类型与解析接线），以及 `tests/domain/v3Advisor.test.ts`、`tests/services/advisorApi.test.ts`、`tests/stores/materials.test.ts`、`tests/stores/migration.test.ts`（仅类型必填补 `citations: []`）、`tests/stores/persistence.test.ts`、`tests/ui/WorkbenchView.test.ts`。

> 范围提醒：`WorkbenchView.vue` 的这次改动**只是聊天引用渲染**，不包含 §1.2 列出的云端接线（来源切换、`guardCloudWrite`、迁移弹窗）。

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
- 仅 `src/views/WorkbenchView.vue` 在 D14 中被修改（聊天引用渲染）；`src/App.vue` 与 `src/views/ProjectMapView.vue` 本轮未改，云端只读接线仍由雍蕾在后续 PR 完成。
