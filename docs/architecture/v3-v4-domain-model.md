# 智慧课程平台 V3/V4 领域模型（PR1 冻结）

> 状态：**已冻结（PR1 已合并；2026-10-19 补充草稿撤销与归档确认规则）**
> 适用版本：V3/V4 产品化阶段，`contractVersion = "3.0"`
> 关联文档：`docs/contracts.md` 第 20～27 节（接口契约）、`项目文档v2.md`、`V3-V4任务分配与实施计划.md`
> 本文只冻结模型、关系和规则，**不实现数据库、不实现 API、不修改前端**。

---

## 1. 目标与边界

本模型解决四件事：

1. 用户、项目、阶段、任务、证据、材料、进展、疑问和聊天有稳定的所属关系；
2. 所有写操作有版本号、幂等键和过期响应规则；
3. 用户之间、项目之间不能互相读取或串联数据；
4. 当前只支持学生个人项目，但数据模型为教师端和多人协作保留扩展位，不把临时结构固化。

本阶段明确不做：

- 教师端、教师批注、班级总览；
- 多人实时协作、成员邀请和角色权限界面；
- CSV、XLSX、PDF、DOCX、ZIP 正文解析；
- 服务端项目模板自动注入；
- 论文自动生成、自动执行上传代码；
- 生产部署、Nginx、Cloudflare 隧道、18080 或服务器配置变更。

---

## 2. 实体关系总览

```text
User (usr_)
  ├── Session (ses_)                        1:N，登录会话（HttpOnly Cookie）
  └── Project (prj_)                        1:N，唯一所有者 ownerUserId
        ├── Milestone (ms_)                 1:N，可为空（空白项目）
        │     └── Task (tsk_)               1:N，task.milestoneId 可空
        │           └── Evidence (evd_)     1:N，evidence.taskId 可空
        ├── Material (mat_)                 1:N
        │     ├── MaterialSegment (seg_)    1:N，按 materialId + version 隔离
        │     └── MaterialUnderstandingItem (cnd_) 1:N，确认门禁
        ├── ProgressRecord (prg_)           1:N，可关联 milestone / task
        ├── Doubt (dbt_)                    1:N，可由 evidence 产生
        └── ChatSession (chat_)             1:N
              └── ChatMessage (msg_)        1:N，按 sequence 排序
```

补充关系：

- `Evidence` 同时保留 `taskId` 与提交时的 `milestoneId` 快照；任务之后被移动到其他阶段，不重写历史证据的阶段归属。
- `ProgressRecord` 可以只关联项目、只关联阶段，或同时关联阶段与任务；三者至少有一个项目归属。
- `Doubt` 可由一条 `Evidence` 自动产生（`sourceEvidenceId`），也可以手工创建。
- `MaterialUnderstandingItem` 是模型/人工生成的候选，只有 `status = confirmed` 的条目及其来源片段可以进入 AI 可信上下文。
- `ChatMessage` 是项目数据，但**不递增 `projectRevision`**；聊天会话使用独立的 `chatRevision`，避免聊天写入让正在生成的建议响应全部过期。

---

## 3. 通用约定

### 3.1 ID

| 项 | 约定 |
| --- | --- |
| 形态 | `<prefix>_<26 位 Crockford Base32 ULID>`，例：`prj_01JBC9R7T3K8QW4M2N6P5X0ZYA` |
| 前缀 | 用户 `usr_`、项目 `prj_`、阶段 `ms_`、任务 `tsk_`、证据 `evd_`、材料 `mat_`、片段 `seg_`、理解条目 `cnd_`、进展 `prg_`、疑问 `dbt_`、聊天会话 `chat_`、聊天消息 `msg_`、事件 `evt_`、候选 `cand_` |
| 生成方 | V3 新实体一律由**服务端**生成；客户端不得指定 `userId`、`projectId` 或新实体 ID |
| 兼容 | V2 已有的 `prj_` / `tsk_` / `evd_` / `dbt_` / `mat_` 字符串继续接受为不透明 ID；迁移时由服务端重写并返回 `idMap` |
| 长度 | 8～64 个可打印 ASCII 字符；仅允许 `[A-Za-z0-9_-]` |
| 唯一性 | 全局唯一，不用数组下标、不用名称派生 |
| 不透明 | 前端只比较相等，不解析 ID 内容 |

### 3.2 时间

| 项 | 约定 |
| --- | --- |
| 存储 | ISO 8601 UTC，毫秒精度，例：`2026-10-19T02:30:00.000Z` |
| 服务端字段 | `createdAt`、`updatedAt`、`deletedAt`、`archivedAt`、`completedAt`、`resolvedAt` 由服务端生成 |
| 客户端时间 | 只允许作为业务时间输入（如 `occurredAt`、`dueAt`）；服务端仍记录 `createdAt`/`updatedAt` |
| 展示 | 前端负责本地化和格式化，不把展示字符串写回服务端 |
| 空值 | 一律 `null`，不用空字符串，不省略字段 |

### 3.3 revision / version

| 实体 | 版本字段 | 初值 | 递增时机 |
| --- | --- | --- | --- |
| User | `revision` | 1 | 昵称、状态、密码等资料变更 |
| Session | 无业务 revision | — | 只记录 `status`、`lastSeenAt`、`expiresAt`、`revokedAt`；不参与项目版本 |
| Project | `projectRevision` | 1 | 项目领域状态每次成功写入（见 3.4） |
| Milestone | `revision` | 1 | 名称、目标、完成标准、截止时间、状态、排序变更 |
| Task | `revision` | 1 | 标题、完成标准、所属阶段、状态、归档变更 |
| Evidence | `revision` | 1 | 建立/修改任务或阶段关联；正文不可改 |
| Material | `version` + `revision` | 1 / 1 | `version`：内容重新上传 +1；`revision`：元数据或归档状态变更 +1 |
| MaterialSegment | 无（不可变） | — | 随材料版本生成；旧版本由派生状态标记 `superseded` |
| MaterialUnderstandingItem | `revision` | 1 | 确认、修改、撤销确认、移除 |
| ProgressRecord | `revision` | 1 | 更正/取代/归档 |
| Doubt | `revision` | 1 | 解决、重新打开、归档 |
| ChatSession | `chatRevision` | 1 | 消息追加、会话归档/恢复 |
| ChatMessage | 无 | — | 不可变，不提供 revision |

规则：

1. 版本从 1 开始，只增不减，不重用，不因回滚还原；
2. `projectRevision` 是**项目聚合版本**，服务端权威；V2 的本地模式仍由前端递增，迁移后以服务端为准；
3. 实体 revision 只在该实体成功变更时 +1；父项目同一次事务中只 +1 一次；
4. 幂等重放不递增任何版本；
5. 读取接口不递增版本；
6. AI 阶段候选生成不递增 `projectRevision`，只有用户确认创建阶段后才 +1。

### 3.4 `projectRevision` 的递增事件

以下成功写入使 `projectRevision + 1`：

- 创建项目（初始化为 1）；
- 阶段：创建、编辑、排序、完成、重新打开、归档、恢复、硬删除空阶段；
- 任务：创建、编辑、移动阶段、开始、完成、重新打开、归档、恢复、硬删除无历史任务；
- 证据：创建、关联/重新关联任务或阶段、脱敏；
- 材料：登记、重新上传、确认/撤销确认、归档、恢复；
- 进展：创建、取代、归档；
- 疑问：创建、解决、重新打开、归档；
- 本地迁移成功（新项目 `projectRevision = 1`，不继承本地旧版本号）。

以下**不**递增 `projectRevision`：

- 纯读取、列表、统计、时间线查询；
- 项目切换、前端筛选、排序展示；
- 建议、聊天、材料理解等 AI 请求；
- 阶段候选生成；
- 聊天消息追加、聊天会话归档（只递增 `chatRevision`）；
- 幂等重放；
- 失败或被拒绝的请求。

### 3.5 状态枚举总表

| 实体 | 枚举 | 说明 |
| --- | --- | --- |
| User | `active` \| `disabled` | 本阶段不提供自助注销；`disabled` 仅管理员操作 |
| Session | `active` \| `expired` \| `revoked` | 登录会话；到期或退出后失效 |
| Project | `active` \| `archived` \| `deleted` | `deleted` 为软删除，保留 30 天 |
| Milestone | `planned` \| `active` \| `completed` \| `archived` | 展示映射：`planned→todo`、`active→cur`、`completed→done` |
| Task | `todo` \| `doing` \| `done` | 与 V2 完全一致；归档用独立 `archivedAt` 表示 |
| Evidence | `active` \| `redacted` | 只追加，不删除；脱敏仅管理员 |
| Material | `registered` \| `parsed` \| `parse_failed` \| `unsupported` \| `archived` | 新上传只产生 `parsed` / `parse_failed`；`unsupported` 只用于迁移旧材料 |
| MaterialSegment | `active` \| `superseded` | 按材料当前版本派生；旧版本片段只读 |
| MaterialUnderstandingItem | `pending` \| `modified` \| `confirmed` \| `archived` | 只有 `confirmed` 进入 AI 可信上下文 |
| ProgressRecord | `active` \| `superseded` \| `archived` | 更正生成新记录，旧记录置 `superseded` |
| Doubt | `open` \| `resolved` \| `archived` | 只有 `open` 进入 AI 上下文 |
| ChatSession | `active` \| `archived` | 清空会话 = 归档，不物理删除 |
| ChatMessage | `user` \| `assistant`（role） | 不可变 |

### 3.6 幂等键

| 场景 | 幂等键 | 作用域 | 保留 |
| --- | --- | --- | --- |
| 所有 V3 写接口 | `idempotencyKey` | `(userId, idempotencyKey)` | 24 小时 |
| 注册 | `accountNormalized` 唯一约束 | 全局 | 永久 |
| 登录 | 无幂等键；每次成功登录轮换 Session | 用户内 | — |
| 退出 | 按当前 Session 撤销，天然幂等 | 会话内 | — |
| 创建项目 | `idempotencyKey` + `clientProjectId`（迁移时） | `(userId, idempotencyKey)` / `(userId, clientProjectId)` | 24 小时 / 永久 |
| 证据提交 | `idempotencyKey` + 兼容字段 `submissionId` | `(projectId, submissionId)` | 永久 |
| 材料上传 | `(projectId, materialId, version)` 唯一 | 项目内 | 永久 |
| 材料草稿确认/编辑/移除/撤销 | `idempotencyKey` + `itemId` + `materialVersion` + `expectedRevision` | 材料版本内 | 永久（按条目 revision） |
| 本地迁移 | `migrationId` + `(userId, clientProjectId)` | 用户内 | 永久 |
| 聊天发送 | `clientMessageId` | `(chatId, clientMessageId)` | 永久 |

规则：

1. 同一个键 + 相同请求体哈希：返回首次成功响应，`replayed: true`，不重复写入、不递增版本；
2. 同一个键 + 不同请求体哈希：409 `IDEMPOTENCY_CONFLICT`，不得部分写入；
3. 幂等查询发生在版本校验之前；重放响应可能带有旧 `projectRevision`，客户端仍须按 3.7 丢弃；
4. 过期后的同键请求按新请求处理；证据 `submissionId` 和迁移 `migrationId` 永久唯一；
5. 未提供 `idempotencyKey` 的写请求一律 400 `INVALID_INPUT`。

### 3.7 项目切换与过期响应

客户端必须维护：

```text
activeProjectId
activeProjectRevision
activeMilestoneId（可空）
实体本地 revision 表
```

收到任何响应后依次校验，任一不通过整份丢弃，不写 store、不提示成功：

| 顺序 | 条件 | 处理 |
| --- | --- | --- |
| 1 | 响应 `projectId !== activeProjectId` | 丢弃；用户已切项目 |
| 2 | 响应 `projectRevision < activeProjectRevision` | 丢弃；旧响应 |
| 3 | 响应实体 revision 小于本地同实体 revision | 丢弃该实体 |
| 4 | 请求发出后用户已切换项目、退出登录或进入其他阶段 | 丢弃 |
| 5 | 响应 `requestId` 与本次请求不一致 | 丢弃并记录日志 |

补充：

1. 切换项目时用 `AbortController` 取消在途请求；取消只节省流量，正确性仍由上述校验保证；
2. 写接口返回 409 `STALE_REVISION` 时，前端刷新该项目后提示“内容已更新，请确认后重试”，**不得自动重放破坏性写操作**；
3. 幂等重放返回旧版本号时，按第 2 条丢弃，不要用旧响应覆盖当前状态；
4. 服务端不信任客户端版本：所有写操作都以数据库当前版本为准做乐观并发校验。

---

## 4. 实体定义

### 4.1 User

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `userId` | string | 是 | `usr_` 前缀，服务端生成 |
| `account` | string | 是 | 用户名或学号，3～32 字符，全局唯一（大小写不敏感） |
| `accountNormalized` | string | 是 | 小写规范化值，仅服务端使用 |
| `displayName` | string | 是 | 昵称，1～30 字 |
| `passwordHash` | string | 是 | 只存 Argon2id 或 bcrypt 哈希，**永不返回** |
| `passwordAlgo` | `argon2id` \| `bcrypt` | 是 | 哈希算法标记 |
| `status` | `active` \| `disabled` | 是 | 本阶段只允许 `active`；禁用仅管理员 |
| `role` | `student` | 是 | 预留 `teacher` / `assistant`，本阶段不启用 |
| `revision` | number | 是 | ≥ 1 |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |
| `lastLoginAt` | string \| null | 是 | 最近成功登录时间 |

关系：`User 1:N Project`、`User 1:N Session`。用户只能访问 `ownerUserId = 当前会话 userId` 的项目。

删除规则：本阶段不提供自助删除；管理员可将 `status` 置为 `disabled`。禁用后所有会话立即失效，项目数据保留，便于恢复。用户表不做级联物理删除。

未来扩展：`role` 和独立的 `ProjectMember` 表预留；本阶段不暴露教师端接口。

#### 4.1.1 Session（登录会话）

Session 是**服务端会话记录**，与 `ChatSession` 无关。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | string | 是 | `ses_` 前缀，服务端生成 |
| `userId` | string | 是 | 所属用户 |
| `tokenHash` | string | 是 | 会话令牌的 SHA-256 哈希；**不保存明文令牌**，不返回 |
| `status` | `active` \| `expired` \| `revoked` | 是 | `expired` 由 `expiresAt` 到期判定；`revoked` 由退出或管理员禁用产生 |
| `createdAt` | string | 是 | 创建时间 |
| `lastSeenAt` | string | 是 | 最近一次通过校验的请求时间 |
| `expiresAt` | string | 是 | 绝对过期时间，创建后 7 天，不滑动续期 |
| `revokedAt` | string \| null | 是 | 撤销时间 |
| `rotatedFromSessionId` | string \| null | 是 | 登录轮换时指向旧会话，便于审计 |
| `updatedAt` | 无 | — | 会话用 `lastSeenAt` / `revokedAt`，不存在 `updatedAt` |

规则：

1. 浏览器只持有 `HttpOnly` Cookie 中的随机令牌；服务端只保存 `tokenHash`；
2. 登录成功创建新 Session 并撤销旧 Session（防会话固定）；退出撤销当前 Session；
3. `expiresAt` 到期即视为 `expired`，返回 401 `UNAUTHORIZED`；
4. Session 不参与项目 `projectRevision`，没有业务 revision；
5. 过期/撤销记录保留 30 天用于审计，之后由后台清理；本 PR 不实现清理任务；
6. 用户被禁用时，其全部 Session 立即置 `revoked`；
7. 任何人不能用 `sessionId` 访问他人会话；Cookie 令牌只映射到唯一 Session。

### 4.2 Project

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | `prj_` 前缀，服务端生成 |
| `ownerUserId` | string | 是 | 所有者；来自会话，不接受客户端传入 |
| `name` | string | 是 | 项目完整名称，1～120 字 |
| `short` | string | 是 | **项目短名/标签名，不是描述**；1～20 字；用于项目切换器、地图中心和标签；完整名称用 `name`，目标/范围用 `profile.goal` / `profile.scope`；自动生成时取名称前 12 字，超出加 `…` |
| `profile` | ProjectProfile | 是 | 目标、预期结果、成员姓名、研究周期、范围、暂不处理 |
| `status` | `active` \| `archived` \| `deleted` | 是 | 见 4.2.1 |
| `visibility` | `private` | 是 | 预留 `shared`，本阶段固定 `private` |
| `projectRevision` | number | 是 | 项目聚合版本，≥ 1 |
| `currentMilestoneId` | string \| null | 是 | 当前阶段指针；无阶段为 `null` |
| `lastActivityAt` | string | 是 | 最后一次领域写入时间 |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |
| `archivedAt` | string \| null | 是 | 归档时间 |
| `deletedAt` | string \| null | 是 | 软删除时间 |
| `purgeAfter` | string \| null | 是 | 软删除后 30 天；到期由后台任务清理 |
| `migratedFromRevision` | number \| null | 是 | 本地迁移来源版本，仅诊断用 |
| `createdByUserId` | string | 是 | 创建者，当前恒等于 `ownerUserId` |

ProjectProfile 字段与 V2 契约 13.1 完全一致：`goal`、`expectedOutcome`、`memberNames`、`researchPeriod`、`scope`、`outOfScope`。

**字段命名澄清（`short`）**：`short` 是 V2 已有的项目短名，不是“简短描述”。它的长度上限为 20 字，只用于空间有限的标签、项目切换器和地图中心；不要把项目目标、范围或摘要塞进 `short`。V3 为兼容旧数据继续使用该名称；前端展示时按“项目短名”理解，不按 `description` 理解。若后续需要长描述，使用 `profile.goal` 或新增独立字段，不复用 `short`。

关系：

- `Project 1:N Milestone`（可为 0 条）；
- `Project 1:N Task`（任务可以不归属阶段）；
- `Project 1:N Evidence` / `Material` / `ProgressRecord` / `Doubt` / `ChatSession`。

空白项目：创建后 `milestones = []`、`tasks = []`、`materials = []`、`progress = []`、`doubts = []`、`chat = []`。**禁止注入模板阶段、模板任务或示例证据**。`currentMilestoneId = null`。

`currentMilestoneId` 由服务端维护，客户端不能直接设置：

1. 优先取 `orderIndex` 最小的 `active` 阶段；
2. 没有 `active` 时取 `orderIndex` 最小的 `planned` 阶段；
3. 都没有（或全部完成/归档）时为 `null`；
4. 阶段创建、排序、激活、完成、重开、归档、恢复后在同一事务内重算；
5. 响应中的 `currentMilestone` 是 `currentMilestoneId` 对应名称的只读投影。

#### 4.2.1 项目状态与删除/恢复

| 操作 | 状态变化 | 规则 |
| --- | --- | --- |
| 归档 | `active → archived` | 可逆；归档后默认不出现在项目列表，`includeArchived=true` 可查 |
| 恢复 | `archived → active` | 恢复原 `projectRevision`，不重置数据 |
| 删除 | `active/archived → deleted` | 软删除；`deletedAt`、`purgeAfter = deletedAt + 30 天` |
| 恢复删除 | `deleted → active` | 30 天内可恢复；恢复后 `purgeAfter = null` |
| 物理清理 | `deleted → 物理删除` | 30 天后由后台任务执行；本 PR 不实现 |

删除项目不立即删除材料正文、证据或聊天；在保留期内全部可恢复。跨用户访问一律 404。

### 4.3 Milestone

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `milestoneId` | string | 是 | `ms_` 前缀 |
| `projectId` | string | 是 | 所属项目 |
| `userId` | string | 是 | 冗余租户键，等于项目所有者 |
| `name` | string | 是 | 1～60 字；同一项目内未归档阶段不得重名（规范化后比较） |
| `goal` | string \| null | 是 | 阶段目标，≤ 300 字 |
| `doneCriteria` | string \| null | 是 | 完成标准，≤ 300 字 |
| `dueAt` | string \| null | 是 | 截止时间，ISO 8601 |
| `status` | `planned` \| `active` \| `completed` \| `archived` | 是 | 展示映射见 3.5 |
| `orderIndex` | number | 是 | 0 起连续整数；仅未归档阶段参与排序 |
| `source` | `manual` \| `ai-candidate` \| `migration` | 是 | 创建来源 |
| `revision` | number | 是 | ≥ 1 |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |
| `completedAt` | string \| null | 是 | 完成时间 |
| `archivedAt` | string \| null | 是 | 归档时间 |
| `archivedFromStatus` | `planned` \| `active` \| `completed` \| null | 是 | 恢复时回到原状态 |
| `createdByUserId` | string | 是 | 创建者 |

状态转换：

```text
planned ──activate──> active ──complete──> completed
   │                    │                    │
   │                    └──archive──> archived <──archive──┘
   └──────────────archive──────────────┘
archived ──restore──> archivedFromStatus
completed ──reopen──> active（清除 completedAt）
```

规则：

1. `completed` 是用户显式动作，不因任务全部完成自动置位；允许 `planned` 直接标记完成（表示该阶段无需激活即已完成），也允许 `active → completed`；
2. 重新打开：`completed → active`，清除 `completedAt`，任务状态不变，进度重新计算；
3. 给 `completed` 阶段新增任务或移入任务，必须显式 `reopenMilestone: true`，否则 409 `MILESTONE_COMPLETED`；
4. 归档不删除任务、证据、进展或聊天引用；默认查询排除，`includeArchived=true` 可查；
5. `archived` 阶段不能新增任务、不能提交关联证据、不能作为 AI 当前阶段；历史证据仍可按 `milestoneId` 查询；
6. 删除 = 归档；只有**没有任何任务、证据、进展或聊天引用**的阶段才允许硬删除，否则 409 `MILESTONE_NOT_EMPTY`；
7. 重名（未归档范围内）返回 409 `MILESTONE_NAME_CONFLICT`；
8. `orderIndex` 由排序接口整体重写为 `0..N-1`，不允许重复或跳跃。

#### 4.3.1 合法状态转换矩阵

| 当前状态 | `activate` | `complete` | `reopen` | `archive` | `restore` |
| --- | --- | --- | --- | --- | --- |
| `planned` | `active` | `completed`（允许直接完成） | 不合法 | `archived` | `no-op`（非归档） |
| `active` | `active`（幂等，不递增） | `completed` | `no-op`（幂等，不递增） | `archived` | `no-op`（非归档） |
| `completed` | 不合法 | `completed`（幂等，不递增） | `active`，清 `completedAt` | `archived` | `no-op`（非归档） |
| `archived` | 不合法 | 不合法 | 不合法 | `archived`（幂等） | `archivedFromStatus` |

必须明确的规则：

1. **阶段不强制显式 activate**：`planned` 可以创建任务，也可以直接 `complete`；`activate` 只用于把阶段标记为“当前推进中”，并影响 `currentMilestoneId` 的优先选择；
2. **完成后 reopen**：只能 `completed → active`；清除 `completedAt`；任务状态不变；进度按当前任务重新计算；
3. **归档**：任何非归档状态都可以归档，记录 `archivedAt` 与 `archivedFromStatus`；归档不删除任务、证据、进展或聊天引用；
4. **恢复**：`archived → archivedFromStatus`，恢复后回到归档前状态，不重置 revision；
5. **归档阶段不能新增任务、不能提交关联证据、不能作为 AI 当前阶段**；必须先 `restore`；已有任务和证据仍可查询；
6. `active → planned`、`completed → planned`、`archived` 直接 `complete` 都不是合法转换，返回 409 `INVALID_STATE_TRANSITION`；
7. 同一状态动作重复调用按上表幂等，不递增 `revision` 与 `projectRevision`；
8. `active` 再 `reopen`、非归档阶段 `restore` 是幂等 no-op；`planned`/`archived` 不能通过 `reopen` 跳过其他转换；`completed → active` 仍是唯一实际 reopen 路径。

任务统计（响应计算字段，不落库）：

```text
MilestoneTaskStats {
  total, done, doing, todo, archived,
  progress: 0..100
}
```

### 4.4 Task

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taskId` | string | 是 | `tsk_` 前缀 |
| `projectId` | string | 是 | 所属项目 |
| `milestoneId` | string \| null | 是 | 所属阶段；`null` 表示项目待办 |
| `userId` | string | 是 | 冗余租户键 |
| `title` | string | 是 | 1～60 字 |
| `doneCriteria` | string \| null | 是 | 完成标准，≤ 200 字 |
| `status` | `todo` \| `doing` \| `done` | 是 | 与 V2 一致 |
| `assigneeUserId` | string \| null | 是 | 本阶段恒为 `null`；预留多人协作 |
| `orderIndex` | number | 是 | 阶段内或项目待办内排序 |
| `source` | `manual` \| `ai-suggestion` \| `migration` | 是 | 创建来源 |
| `revision` | number | 是 | ≥ 1 |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |
| `startedAt` | string \| null | 是 | 开始时间 |
| `completedAt` | string \| null | 是 | 完成时间 |
| `archivedAt` | string \| null | 是 | 归档时间 |
| `createdByUserId` | string | 是 | 创建者 |

状态转换：

```text
todo ──start──> doing ──complete──> done
  │                │                  │
  └────complete────┴──────reopen──────┘
       （需显式确认）      done → doing 或 todo
```

规则：

1. 开始：`todo → doing`；对 `doing` 重复开始幂等，返回当前状态，不递增 revision；
2. 完成：`todo|doing → done`；写入 `completedAt`；重复完成幂等；
3. 重新打开：`done → doing`（默认）或 `done → todo`；清除 `completedAt`；
4. 归档：任何状态 → `archivedAt` 非空；归档任务不进入进度分母，不能提交证据或进展；
5. 恢复：清除 `archivedAt`，状态保持归档前值；
6. 移动阶段：`milestoneId` 可改为同项目其他未归档阶段或 `null`；源/目标阶段进度同时重算；
7. 硬删除只允许没有证据、没有进展、没有聊天引用的任务；否则归档；
8. 同一项目内任务标题不要求唯一，但客户端应提示重复。

#### 4.4.1 合法状态转换矩阵

`archivedAt` 是独立归档标记；任务归档前的 `status` 保留，恢复时恢复该值。

| 当前状态 | `start` | `complete` | `reopen` | `archive` | `restore` |
| --- | --- | --- | --- | --- | --- |
| `todo` | `doing` | `done`（允许直接完成） | 不合法 | `archivedAt` 非空 | 不合法 |
| `doing` | `doing`（幂等） | `done` | 不合法 | `archivedAt` 非空 | 不合法 |
| `done` | 不合法 | `done`（幂等） | `doing`（默认）或 `todo` | `archivedAt` 非空 | 不合法 |
| `archived` | 不合法 | 不合法 | 不合法 | 幂等 | 清除 `archivedAt`，恢复归档前状态 |

规则：

1. 归档任务不能开始、完成、重开、提交证据或进展；必须先 `restore`；
2. `done → todo` 只能通过 `reopen` 的 `targetStatus`，不能通过普通字段更新；
3. 开始/完成/重开/归档/恢复成功都必须递增任务 `revision` 与 `projectRevision`；同状态幂等调用不递增；
4. 任务完成不自动改变阶段状态；阶段进度按 5.1 公式重算；
5. 在 `planned` 阶段开始任务不会自动激活阶段；激活仍是显式动作；
6. 归档任务不计入阶段进度分母，但历史证据仍可查询。

兼容：V2 的 `milestone` 名称字段在 V3 响应中同时返回 `milestoneId` 与 `milestoneName`；`owner` 旧字段映射为 `null`，`suggestedOwner` 只保留为前端展示，不进入 V3 DTO。

### 4.5 Evidence

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `evidenceId` | string | 是 | `evd_` 前缀 |
| `projectId` | string | 是 | 所属项目 |
| `taskId` | string \| null | 是 | 关联任务 |
| `milestoneId` | string \| null | 是 | 提交时关联阶段的快照 |
| `milestoneNameSnapshot` | string \| null | 是 | 提交时阶段名称快照，防阶段改名/归档后历史失真 |
| `userId` | string | 是 | 冗余租户键 |
| `submissionId` | string | 是 | V2 兼容幂等键；V3 新建时也生成 |
| `didWhat` | string | 是 | 1～300 字 |
| `foundWhat` | string \| null | 是 | 发现，≤ 500 字 |
| `stillUnsure` | string \| null | 是 | 仍不确定，≤ 500 字；非空时创建 `Doubt` |
| `attachmentName` | string \| null | 是 | 只记文件名，不定义上传 |
| `status` | `active` \| `redacted` | 是 | 脱敏仅管理员 |
| `authorUserId` | string | 是 | 提交者 |
| `revision` | number | 是 | 正文不可改；关联变更时 +1 |
| `createdAt` | string | 是 | 提交时间，不可变 |
| `updatedAt` | string | 是 | 关联变更时间 |
| `redactedAt` | string \| null | 是 | 脱敏时间 |

规则：

1. 证据正文只追加，不提供普通删除；阶段归档或项目归档不删除证据；
2. 允许把证据关联到任务和阶段；重新关联时保留 `milestoneNameSnapshot` 的原值直到显式更新，并在时间线记录变更事件；
3. `stillUnsure` 非空时自动创建一条 `Doubt`，`sourceEvidenceId` 指向本证据；重复提交同一 `submissionId` 不重复创建疑问；
4. `taskId` 与 `milestoneId` 必须属于同一项目；任务已归属阶段时，证据写入的 `milestoneId` 必须与任务当前阶段一致；缺失/`null` 按任务阶段处理，显式不同返回 400 `INVALID_INPUT`；有效阶段归档返回 409 `MILESTONE_ARCHIVED`；历史证据的 `milestoneNameSnapshot` 保留提交时值，不因任务移动静默改写；
5. 归档阶段下的证据仍可查询：`GET /evidence?milestoneId=...&includeArchived=true`；
6. 证据不可进入已归档/已删除项目之外的其他项目；跨项目引用一律 404/409（见第 6 节）。

### 4.6 Material / MaterialSegment / MaterialUnderstandingItem

#### 4.6.1 Material

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `materialId` | string | 是 | `mat_` 前缀；跨版本稳定 |
| `projectId` | string | 是 | 所属项目 |
| `userId` | string | 是 | 冗余租户键 |
| `name` | string | 是 | 原始文件名，1～200 字 |
| `type` | `md` \| `txt` | 是 | 本阶段只允许这两种 |
| `size` | number | 是 | 解码后字节数，1～1,048,576 |
| `encoding` | `utf-8` \| `gbk` | 是 | 实际解码编码 |
| `status` | `registered` \| `parsed` \| `parse_failed` \| `unsupported` \| `archived` | 是 | 见 3.5 |
| `version` | number | 是 | 内容版本，≥ 1；重新上传 +1 |
| `revision` | number | 是 | 元数据/归档版本 |
| `sha256` | string \| null | 是 | 内容摘要，用于识别重复上传 |
| `failureReason` | string \| null | 是 | 中文原因；成功时为 `null` |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |
| `archivedAt` | string \| null | 是 | 归档时间 |

规则：

1. 新上传仅接受 `.md` / `.txt`；CSV、XLSX、PDF、DOCX、ZIP 一律 400 `UNSUPPORTED_MATERIAL_TYPE`，不产生材料记录；
2. `unsupported` 只用于迁移旧元数据：保留文件名和版本，标记“当前格式不支持”，不解析、不进入 AI；
3. 同一 `materialId` 重新上传时 `version + 1`；旧版本及其片段保留为只读历史，不再进入 AI 上下文，除非重新确认；
4. 材料归档是可逆软归档；被证据/进展引用时不得物理删除；
5. 已有 MD/TXT 上传与解析接口 `POST /api/materials` 继续使用，V3 不改其字段和错误码。

#### 4.6.2 MaterialSegment

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `segmentId` | string | 是 | `seg_` + 序号；只在 `materialId + materialVersion` 内唯一 |
| `materialId` | string | 是 | 所属材料 |
| `materialVersion` | number | 是 | 所属内容版本 |
| `index` | number | 是 | 0 起稳定序号 |
| `startLine` / `endLine` | number | 是 | 1 起、包含两端 |
| `text` | string | 是 | 分段正文，1～2,000 字 |
| `charCount` | number | 是 | `text` 的字符数，服务端计算 |
| `status` | `active` \| `superseded` | 是 | 按材料当前版本派生：当前版本 `active`，旧版本 `superseded`；不单独存储 |
| `createdAt` | string | 是 | 解析/生成时间，不可变 |
| `updatedAt` | 无 | — | 片段不可变，不存在 `updatedAt` |

关系与规则：

1. `Material 1:N MaterialSegment`；片段属于唯一 `materialId + materialVersion`；
2. 分段不可变；重新上传生成新版本片段，旧版本片段保留为 `superseded` 只读历史，不进入 AI 上下文；
3. 片段没有用户可执行的删除/归档动作，生命周期跟随材料版本；
4. `(materialId, materialVersion, segmentId)` 唯一；同一输入与版本的分段结果必须确定；
5. `MaterialUnderstandingItem.sources` 只能引用同一 `materialId + materialVersion` 的片段。

#### 4.6.3 MaterialUnderstandingItem

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `itemId` | string | 是 | `cnd_` 前缀；服务端落库后的稳定 ID，项目内唯一 |
| `clientItemId` | string \| null | 是 | 迁移/旧前端使用的原始 `itemId`，仅用于 `idMap` 追溯；新请求不再使用 |
| `materialId` / `materialVersion` | string / number | 是 | 来源材料与版本 |
| `kind` | `goalCandidates` \| `outcomeCandidates` \| `dataNotes` \| `methodNotes` \| `openQuestions` | 是 | 与 V2 `UnderstandingBlock.kind` 完全一致，不另造枚举 |
| `text` | string | 是 | 展示/确认后的正文，1～300 字；对应本地字段 `content` |
| `originalText` | string | 是 | 服务端原始候选文本，用于撤销修改/撤销确认；对应本地 `originalContent` |
| `sources` | MaterialSourceRef[] | 是 | 1～3 条；来源片段必须属于同一材料版本 |
| `status` | `pending` \| `modified` \| `confirmed` \| `archived` | 是 | 只有 `confirmed` 进入可信上下文；`modified` 必须再次确认 |
| `source` | `model` \| `manual` \| `migration` | 是 | 候选来源；`fallback` 不产生伪造候选 |
| `revision` | number | 是 | ≥ 1；确认、修改、撤销、移除各 +1 |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |
| `confirmedAt` / `confirmedByUserId` | string \| null | 是 | 最近一次确认信息；撤销/修改后清空 |
| `removedAt` | string \| null | 是 | 移除时间；移除 = `status: archived`，不物理删除 |

状态转换：

```text
pending ──confirm──> confirmed
pending ──edit─────> modified
modified ──confirm─> confirmed
confirmed ──edit────> modified（清空 confirmedAt/By）
confirmed ──undo────> pending（text == originalText）或 modified（清空确认信息）
任意非归档 ──remove──> archived（写 removedAt）
archived ──×────────> pending / modified / confirmed（不可恢复）
```

关系：`Material 1:N MaterialUnderstandingItem`；`MaterialUnderstandingItem.sources` 通过 `materialId + materialVersion + segmentId` 引用 `MaterialSegment`，不得跨材料版本。

确认门禁与规则：

1. 未确认条目**不得**进入 `confirmedMaterials`，服务端在 v3 提示词下必须按数据库确认状态复核；
2. 模型只能返回 `segmentId`；材料名、版本、行号由服务端从数据库回填；
3. 材料新版本发布后，旧版本条目自动转 `archived`，需要重新确认；
4. `itemId` 在项目内唯一；V2 的 `itemId` 只在单次响应内唯一，迁移时由服务端重新分配稳定 `itemId`，旧值放 `clientItemId`；
5. 确认/修改/撤销/移除都必须带 `materialVersion` 与 `expectedRevision`；版本不符返回 409；
6. 重复确认、重复撤销、重复移除是幂等的：状态已满足时返回 `changed: false`，不递增 `revision` 与 `projectRevision`；
7. 移除不删除来源片段；已归档条目不能再确认，必须重新生成草稿；
8. 编辑文本与当前 `text` 完全相同时是无操作，不改变状态、不递增版本；
9. 本地迁移必须分别保留 `text` 与 `originalText`；旧数据缺少 `originalText` 时保留 `text`、返回 `UNDERSTANDING_ORIGINAL_TEXT_MISSING` 并置 `pending`（`archived` 保持不变），不得假装原文已完整保留；
10. 确认（单条或整份）必须有至少一个能按 `materialId + materialVersion + segmentId` 查询到、且 `text.trim().length > 0` 的真实片段（空字符串、普通空格、Tab、换行、全角空格均为无效正文）；`sources_json` 中的材料 ID、版本和行号不可信；无有效来源返回 409 `DRAFT_SOURCE_MISSING`（包括历史已 `confirmed` 但来源无效的条目），整份确认任一条失败则整单不写入；迁移时空来源/全部失效来源降为 `pending` 并返回 `UNDERSTANDING_SOURCE_MISSING`，`archived` 不复活；材料片段正文原样保留。

`undoDraftItem` 的确定规则：

1. 先校验 `materialId`、`materialVersion`、`itemId`、`expectedRevision`，再判断状态；只有校验通过后，`pending` / `modified` 调用才返回 `changed: false`；
2. 使用保存的 `text` 与 `originalText` 做完全字符串比较：相同 → `pending`，不同 → `modified`；
3. 成功时清空 `confirmedAt` 与 `confirmedByUserId`；
4. 成功状态变化时条目 `revision +1`、`projectRevision +1`，且只递增一次；
5. `materialId`、`materialVersion`、`itemId`、`expectedRevision` 任一不匹配必须拒绝，不写入；
6. 已归档条目返回 409 `DRAFT_ITEM_ARCHIVED`，**不得恢复**为 `pending` 或 `modified`。

`confirmAllDraft` 的确定规则：

1. `items` 必须包含当前材料版本的全部未归档条目，不能包含任何 `archived` 条目；
2. 任一条目是 `archived` → 整个请求 409 `DRAFT_ITEM_ARCHIVED`（archived 检查先于 revision 校验），不得部分成功，也不得把 archived 恢复为 `pending` 或 `confirmed`；
3. 所有 `itemId`、`materialVersion`、`expectedRevision` 校验通过后才允许进入单事务写入；
4. 事务内只将 `pending` / `modified` 改为 `confirmed`；已确认条目跳过；
5. 成功时每条变化条目 `revision +1`，`projectRevision` 只 +1 一次；
6. 失败时 `projectRevision` 不递增，不得部分写入；
7. 旧前端重新提交已删除条目的 `itemId` 不得使其复活。

### 4.7 ProgressRecord

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `progressId` | string | 是 | `prg_` 前缀 |
| `projectId` | string | 是 | 所属项目 |
| `milestoneId` | string \| null | 是 | 关联阶段 |
| `taskId` | string \| null | 是 | 关联任务 |
| `userId` | string | 是 | 冗余租户键 |
| `summary` | string | 是 | 进展正文，1～1,000 字 |
| `evidenceIds` | string[] | 是 | 关联证据，≤ 10 条，必须同项目 |
| `occurredAt` | string | 是 | 业务发生时间；默认服务端当前时间 |
| `status` | `active` \| `superseded` \| `archived` | 是 | 更正/归档 |
| `supersedesProgressId` | string \| null | 是 | 本记录取代的旧记录 |
| `authorUserId` | string | 是 | 提交者 |
| `revision` | number | 是 | ≥ 1 |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |

规则：

1. 进展只追加；更正时创建新记录并把旧记录置 `superseded`，旧正文保留；
2. 进展不直接改变任务状态；完成任务必须走任务完成动作；
3. 进展可只关联项目、只关联阶段、只关联任务或同时关联阶段与任务；
4. 归档可逆；不提供普通物理删除；
5. 时间线按 `occurredAt` 倒序展示，`createdAt` 作为同秒排序的次键。

### 4.8 Doubt

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `doubtId` | string | 是 | `dbt_` 前缀 |
| `projectId` | string | 是 | 所属项目 |
| `milestoneId` | string \| null | 是 | 关联阶段 |
| `taskId` | string \| null | 是 | 关联任务 |
| `userId` | string | 是 | 冗余租户键 |
| `text` | string | 是 | 1～500 字 |
| `status` | `open` \| `resolved` \| `archived` | 是 | 只有 `open` 进入 AI 上下文 |
| `sourceEvidenceId` | string \| null | 是 | 由哪条证据产生；手工创建为 `null` |
| `revision` | number | 是 | ≥ 1 |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |
| `resolvedAt` / `resolvedByUserId` | string \| null | 是 | 解决信息 |

规则：解决/重新打开幂等；重复解决不递增 revision；归档可逆；不提供物理删除。

### 4.9 ChatHistory

ChatHistory 由会话与消息两部分组成。

#### ChatSession（`chat_`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `chatId` | string | 是 | `chat_` 前缀 |
| `projectId` | string | 是 | 所属项目 |
| `milestoneId` | string \| null | 是 | 会话发起时的阶段上下文；阶段归档后保留快照 |
| `userId` | string | 是 | 冗余租户键 |
| `title` | string \| null | 是 | 会话标题，≤ 60 字 |
| `status` | `active` \| `archived` | 是 | 清空 = 归档 |
| `chatRevision` | number | 是 | 消息追加/归档 +1；不影响 `projectRevision` |
| `messageCount` | number | 是 | 当前消息数（不含已删除，消息本身不可删） |
| `lastMessageAt` | string \| null | 是 | 最后一条消息时间 |
| `createdAt` / `updatedAt` | string | 是 | 服务端时间 |
| `archivedAt` | string \| null | 是 | 归档时间 |

关系与规则：

1. `Project 1:N ChatSession`、`ChatSession 1:N ChatMessage`；
2. 会话归档可恢复；归档会话不进入默认 AI 历史上下文，但历史消息仍可查询；
3. 聊天消息追加只递增 `chatRevision`，不递增 `projectRevision`；
4. 会话标题可为 `null`；清空会话 = 归档，不物理删除消息。

#### ChatMessage（`msg_`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | string | 是 | `msg_` 前缀，服务端生成 |
| `chatId` | string | 是 | 所属会话 |
| `projectId` | string | 是 | 冗余项目键 |
| `sequence` | number | 是 | 会话内 1 起连续序号，唯一且不可重排 |
| `role` | `user` \| `assistant` | 是 | 角色；对应本地 `me` 的反向映射 |
| `content` | string | 是 | 1～4,000 字；对应本地 `text` |
| `source` | `model` \| `fallback` \| `local-rule` \| `error` \| null | 是 | 用户消息为 `null`；`local-rule`/`error` 只用于本地展示，V3 服务端只持久化 `model`/`fallback` 或用户消息 |
| `fallbackReason` | string \| null | 是 | 安全原因码，不是模型原文 |
| `promptVersion` | string \| null | 是 | 助手消息使用的提示词版本 |
| `requestId` | string \| null | 是 | 产生该回答的请求 ID，便于追踪；用户消息为 `null` |
| `projectRevisionAtSend` | number | 是 | 发送时的项目版本，用于过期追溯 |
| `citations` | MaterialSourceRef[] | 是 | 仅已确认材料；服务端回填名称与行号；用户消息为 `[]` |
| `clientMessageId` | string \| null | 是 | 用户消息幂等键；助手消息为 `null` |
| `createdAt` | string | 是 | 不可变 |
| `updatedAt` | 无 | — | 消息不可变，不存在 `updatedAt` |

规则：

1. 消息不可编辑、不可物理删除；清空会话只归档；
2. 聊天写入不递增 `projectRevision`，避免把所有在途 AI 响应判为过期；
3. 会话归档可恢复；归档会话不进入默认 AI 历史上下文；
4. 历史上下文最多 20 条，超出由服务端截断最早消息，并在日志记录条数，不记录正文；
5. `(chatId, clientMessageId)` 唯一；重复发送同一 `clientMessageId` 返回首次消息，不重复追加；
6. `sequence` 在事务内连续递增；并发发送由 `chatRevision` 乐观锁保护。

### 4.10 MaterialSourceRef（引用结构）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `materialId` | string | 材料 ID |
| `materialName` | string | 服务端回填 |
| `materialVersion` | number | 服务端回填 |
| `segmentId` | string | 模型唯一允许提供的引用 |
| `startLine` / `endLine` | number | 服务端回填 |
| `itemId` | string \| null | 确认条目 ID，可选 |

### 4.11 实体规则汇总

| 实体 | ID | 所属关系 | 时间字段 | 版本 | 状态 | 删除 / 归档 / 恢复 | 幂等键 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| User | `usr_` | 权限根 | `createdAt`、`updatedAt`、`lastLoginAt` | `revision` | `active` / `disabled` | 无自助删除；管理员禁用/恢复 | `accountNormalized` 唯一 |
| Session | `ses_` | `userId` | `createdAt`、`lastSeenAt`、`expiresAt`、`revokedAt` | 无业务 revision | `active` / `expired` / `revoked` | 退出/过期/禁用即失效；审计保留 30 天 | 登录轮换；退出幂等 |
| Project | `prj_` | `ownerUserId` | `createdAt`、`updatedAt`、`archivedAt`、`deletedAt` | `projectRevision` | `active` / `archived` / `deleted` | 归档可逆；软删除 30 天可恢复 | `idempotencyKey` / `clientProjectId` |
| Milestone | `ms_` | `projectId` + `userId` | `createdAt`、`updatedAt`、`completedAt`、`archivedAt` | `revision` | `planned` / `active` / `completed` / `archived` | 删除 = 归档；恢复回 `archivedFromStatus` | `idempotencyKey` |
| Task | `tsk_` | `projectId` + `milestoneId`（可空） | `createdAt`、`updatedAt`、`startedAt`、`completedAt`、`archivedAt` | `revision` | `todo` / `doing` / `done` + `archivedAt` | 删除 = 归档；恢复原状态 | `idempotencyKey` |
| Evidence | `evd_` | `projectId` + `taskId`（可空）+ `milestoneId` 快照 | `createdAt`、`updatedAt`、`redactedAt` | `revision` | `active` / `redacted` | 不删除；阶段归档不影响历史 | `submissionId` + `idempotencyKey` |
| Material | `mat_` | `projectId` + `userId` | `createdAt`、`updatedAt`、`archivedAt` | `version` + `revision` | `registered` / `parsed` / `parse_failed` / `unsupported` / `archived` | 软归档可恢复；被引用时禁止物理删除 | `(projectId, materialId, version)` |
| MaterialSegment | `seg_` | `materialId` + `materialVersion` | `createdAt` | 无（不可变） | `active` / `superseded`（按材料版本派生） | 随材料版本保留；不单独删除 | `(materialId, materialVersion, segmentId)` |
| MaterialUnderstandingItem | `cnd_` | `materialId` + `materialVersion` | `createdAt`、`updatedAt`、`confirmedAt`、`removedAt` | `revision` | `pending` / `modified` / `confirmed` / `archived` | 移除 = 归档；不物理删除 | `itemId` + `materialVersion` + `expectedRevision` |
| ProgressRecord | `prg_` | `projectId` + `milestoneId` / `taskId`（可空） | `createdAt`、`updatedAt`、`occurredAt` | `revision` | `active` / `superseded` / `archived` | 软归档；更正用新记录取代 | `idempotencyKey` |
| Doubt | `dbt_` | `projectId` + `milestoneId` / `taskId`（可空） | `createdAt`、`updatedAt`、`resolvedAt` | `revision` | `open` / `resolved` / `archived` | 软归档可恢复；不物理删除 | `idempotencyKey`；来源证据唯一 |
| ChatSession | `chat_` | `projectId` + `userId` | `createdAt`、`updatedAt`、`lastMessageAt`、`archivedAt` | `chatRevision` | `active` / `archived` | 清空 = 归档；可恢复 | `idempotencyKey` |
| ChatMessage | `msg_` | `chatId` + `projectId` | `createdAt` | 无（不可变） | 无业务状态；`role` 为 `user` / `assistant` | 不删除 | `clientMessageId` |

所有实体的“项目切换和过期响应规则”统一适用第 3.7 节：响应必须匹配 `activeProjectId`，`projectRevision` 不得回退，实体 revision 不得小于本地值；不匹配整份丢弃。

---

## 5. 阶段进度与任务统计

### 5.1 计算公式

```text
tasks(M) = 所有 milestoneId = M 且 archivedAt IS NULL 的任务
total    = |tasks(M)|
done     = tasks(M) 中 status = 'done' 的数量
doing    = tasks(M) 中 status = 'doing' 的数量
todo     = tasks(M) 中 status = 'todo' 的数量
archived = 所有 milestoneId = M 且 archivedAt 非空的任务数量

progress = total = 0 ? 0 : floor(done * 100 / total)
```

规则：

1. 进度是**计算字段**，不单独存储；读取时按当前任务状态计算；
2. 归档任务不计入分母和分子；
3. 任务移动到其他阶段后，源阶段和目标阶段都重新计算；
4. 阶段 `completed` 不冻结进度；重新打开后按当前任务重新计算；
5. 任务完成/重新打开/归档必须在同一事务内更新 `projectRevision` 并返回最新统计；
6. 阶段完成不要求所有任务 `done`；是否允许完成由用户决定，但响应同时返回 `taskStats`，页面应提示未完成任务数；
7. 项目级统计 = 各未归档阶段统计之和 + 未归属阶段任务；项目进度不取平均，避免阶段权重失真。

### 5.2 响应示例

```json
{
  "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
  "name": "数据获取与预处理",
  "status": "active",
  "goal": "拿到可复现的样例数据并确认字段口径",
  "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
  "dueAt": "2026-11-02T15:59:59.000Z",
  "orderIndex": 1,
  "revision": 4,
  "taskStats": {
    "total": 3,
    "done": 1,
    "doing": 1,
    "todo": 1,
    "archived": 0,
    "progress": 33
  }
}
```

---

## 6. 权限、项目隔离与删除/归档矩阵

### 6.1 权限规则

1. 除 `GET /health`、注册、登录外，所有 V3 接口必须携带有效会话 Cookie；
2. `userId` 只从会话读取，忽略请求体/查询参数中的任何用户标识；
3. 每条业务表都保存 `userId` 冗余租户键，查询必须同时带 `userId` 与 `projectId`；
4. 跨用户访问统一返回 404 `PROJECT_NOT_FOUND` / `RESOURCE_NOT_FOUND`，不返回 403，避免泄露资源是否存在；
5. 同一用户但 ID 属于另一个项目：返回 409 `PROJECT_MISMATCH`（客户端同时持有两个项目时才会出现，属于客户端错误）；
6. 路径 `projectId` 与请求体 `projectId` 不一致：400 `INVALID_INPUT`，不执行任何写入；
7. 所有写操作校验 `projectRevision` 和目标实体 `expectedRevision`；
8. 任何关联写入必须验证 `taskId`、`milestoneId`、`evidenceIds`、`chatId` 全部属于同一个 `projectId`；任一不属于当前项目都不得写入，跨项目关联返回 409 `PROJECT_MISMATCH` 或 404 `RESOURCE_NOT_FOUND`；
9. 材料、任务、证据、进展、疑问和聊天查询都必须带 `projectId` 过滤，禁止只按实体 ID 查询；跨项目 ID 不得出现在响应、提示词或时间线中；
10. 数据库层面使用复合唯一约束与索引：`(user_id, project_id)`、`(user_id, project_id, milestone_id)`、`(project_id, submission_id)`、`(project_id, material_id, version)`、`(chat_id, sequence)`、`(user_id, idempotency_key)`。

### 6.2 删除、归档和恢复矩阵

| 实体 | 用户可执行 | 默认语义 | 可恢复 | 物理删除 |
| --- | --- | --- | --- | --- |
| User | 无自助删除 | 管理员禁用 | 管理员恢复 | 不提供 |
| Project | 归档 / 删除 | 删除 = 软删除 30 天 | 是 | 30 天后后台任务 |
| Milestone | 归档 / 删除 | 删除 = 归档 | 是 | 仅空阶段 |
| Task | 归档 / 删除 | 删除 = 归档 | 是 | 仅无历史任务 |
| Evidence | 无删除 | 只追加 | — | 不提供 |
| Material | 归档 | 软归档 | 是 | 被引用时禁止 |
| ProgressRecord | 归档 | 软归档 | 是 | 不提供 |
| Doubt | 归档 | 软归档 | 是 | 不提供 |
| ChatSession | 归档 | 清空 = 归档 | 是 | 不提供 |
| ChatMessage | 无删除 | 不可变 | — | 不提供 |

### 6.3 阶段归档后的历史证据

阶段归档或“删除”后：

1. 任务、证据、进展、疑问、聊天记录**全部保留**，不级联删除；
2. 证据保存 `milestoneId` 与 `milestoneNameSnapshot`；阶段改名或归档后，历史证据仍能显示提交时的阶段名；
3. `GET /evidence?milestoneId=...&includeArchived=true` 可查询归档阶段证据；
4. 时间线保留 `milestoneArchived` 事件与证据提交事件，不因归档重写；
5. 默认 AI 上下文只包含当前未归档阶段；归档阶段内容不得被自动当作当前事实；
6. 只有空阶段允许硬删除；有任务或证据的阶段只能归档。

---

## 7. AI 阶段候选与确认

### 7.1 候选不是正式数据

`POST /api/projects/{projectId}/milestones/candidates` 生成的阶段是**候选**：

- 有 `candidateId`（`cand_`）、`name`、`goal`、`doneCriteria`、`suggestedTasks`、`risks`、`sources`、`promptVersion`、`expiresAt`；
- 保存在短期缓存（建议 30 分钟），不写 `milestones` 表，不进入时间线，不递增 `projectRevision`；
- 只能引用已确认材料片段；材料名、版本、行号由服务端回填；
- 模型失败时返回安全中文 fallback（候选可以为空，附 `notice`），不写入任何项目事实。

### 7.2 用户确认后才写入

确认路径：调用 `POST /api/projects/{projectId}/milestones`，请求体带：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "idempotencyKey": "milestone-confirm-01JBC9R7T3K8QW4M2N6P5X0ZYC",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 12,
  "name": "数据获取与预处理",
  "goal": "拿到可复现的样例数据并确认字段口径",
  "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
  "dueAt": "2026-11-02T15:59:59.000Z",
  "source": "ai-candidate",
  "candidateId": "cand_01JBC9R7T3K8QW4M2N6P5X0ZYD",
  "confirmedByUser": true
}
```

规则：

1. `confirmedByUser` 必须为 `true`，否则 400 `CONFIRMATION_REQUIRED`；
2. `candidateId` 必须属于当前用户和当前项目，未过期；过期返回 409 `CANDIDATE_EXPIRED`；
3. 候选内容可以经用户修改后提交，服务端以提交内容为准；
4. 只有创建成功后才写入阶段表并递增 `projectRevision`；
5. 空白项目不会自动生成候选；用户必须主动点击“生成候选”或手动创建。

---

## 8. 未来扩展位

本阶段不实现，但模型保留：

| 扩展 | 预留 | 约束 |
| --- | --- | --- |
| 教师端 | `User.role`、`Project.classId`（暂不暴露） | 教师只能通过新增只读接口查看，不改变学生项目所有权 |
| 多人协作 | `ProjectMember(projectId,userId,role)`、`Task.assigneeUserId` | `ownerUserId` 始终是权限根；成员角色 `owner/editor/viewer` |
| 项目共享 | `Project.visibility` | 本阶段固定 `private`；启用 `shared` 时必须重新评审权限与审计 |
| 更多材料格式 | `Material.type`、`status` | 新增格式必须走白名单、解析器、来源定位和确认门禁 |
| 实时协作 | 实体 `revision` + 事件表 | 先用乐观并发；引入实时通道前不能改变 revision 语义 |

---

## 9. 需要项目负责人确认的冲突

1. **阶段状态自动流转**：本模型规定 `planned → active` 必须由用户显式操作；是否允许“开始第一个任务时自动激活阶段”需要用产品决定，当前不自动。
2. **会话有效期**：本文按 7 天绝对有效期设计；是否改为 30 天或滑动续期需负责人确认。
3. **项目软删除保留期**：本文按 30 天；是否允许用户立即彻底删除需确认（涉及数据安全与审计）。
4. **聊天是否计入项目版本**：本文选择不计入 `projectRevision`，只维护 `chatRevision`；如果负责人要求聊天也参与过期判断，需要同步修改 AI 丢弃规则。
5. **V3 材料上传/重新解析持久化接口**：本 PR 已冻结五个草稿确认接口（确认、修改、移除、撤销、整份确认）；上传与重新解析仍复用 V2 `POST /api/materials`，V3 材料持久化写入接口留给材料 PR，避免两套确认语义。
6. **迁移冲突策略**：本文规定同一 `clientProjectId` 只迁移一次、后续不覆盖云端；是否允许“以本地覆盖云端”需要负责人确认，默认禁止。
