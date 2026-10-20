# 智慧课程平台 · 前后端接口契约

> 文档修订：v3.7（只改文档、不改接口：第 0 节重写为 V2/V3 双代入口与四条通则；密码哈希改为如实描述 bcrypt cost 12；`PROJECT_MISMATCH` 标注为保留码、跨项目实体统一 404；Session 30 天保留标注为部署侧待实现）
> 编制日期：2026-09-25（v2.0：2026-10-12；v3.0：2026-10-19，PR1 冻结 V3/V4 账号、阶段、进展、AI 上下文与迁移）
> owner：负责人（后端）
> 地位：**本文件是前后端唯一契约。** 四名成员不得自行新增字段或创建第二套 DTO。
> 适用范围：V2 的 `POST /api/advisor/recommendations`、`POST /api/advisor/chat`、`POST /api/materials`、`POST /api/materials/understanding`；V3/V4 的账号、项目、阶段、任务、证据、进展、时间线、阶段候选、本地迁移与 AI 阶段上下文。
> v2 章节（第 12–18 节）是 M1 冻结内容：本轮只支持 `md` / `txt`（M2-A）；CSV/XLSX 属 M2-B，PDF/DOCX/ZIP 属 M4。
> v3 章节（第 20–27 节）是 V3 契约：定义账号、项目域、材料、迁移与 AI 上下文的接口语义。后端已实现其中一部分，**实现进度与缺口统一见 `docs/v3-v4-pr2-status.md`**。接口以本契约为准：代码与契约不一致时，要么按契约修代码，要么先改契约再改代码，不得默认以代码为准。
> 节号说明：原第 11 节“变更记录”已移到文末第 28 节；为避免破坏既有引用，其余旧节号不重排；V3 章节从第 20 节开始。
> **本文定义接口，不能替代部署验证。** 当前线上验证结果与仍需复验的事项见第 7 节。

本文引用并取代《首轮 MVP 任务分配与智能体提示词》第 4 节的草案；差异逐条列在第 9 节。

---

## 0. 一分钟版

本文件是前后端唯一契约，同时覆盖两代接口，靠 `contractVersion` 区分：

| 代 | `contractVersion` | 范围 | 章节 |
| --- | --- | --- | --- |
| V2 | `"1.0"` | 建议、聊天、材料登记与理解；字段与行为冻结 | 4–19 |
| V3 | `"3.0"` | 账号与会话、项目/阶段/任务/证据/进展、材料读写、本地迁移 | 20–26 |

V3 的四条通则，任何接口都不得违反：

1. **归属**：先认证，再按 `userId + projectId` 校验所有权；跨用户项目一律 404 `PROJECT_NOT_FOUND`，同一用户跨项目实体一律 404 `RESOURCE_NOT_FOUND`，不得用 409/403 泄露资源是否存在。
2. **并发**：写接口必须带 `projectRevision`（单实体更新再加 `expectedRevision`）与 `idempotencyKey`；不匹配返回 `STALE_REVISION`，且不写入任何数据。
3. **幂等**：同键同体重放返回首次响应并置 `replayed: true`；同键不同体返回 409 `IDEMPOTENCY_CONFLICT`，不写入。
4. **读不写**：读接口不递增版本、不写幂等记录、不改变任何业务状态。

接口覆盖范围以本文件为准，**实现进度不在本文件内维护**：已实现、未实现和半成品的能力见 `docs/v3-v4-pr2-status.md`。本文件描述目标语义，状态文档标注代码与契约的差距。

V2 建议与聊天仍有三层来源（`model` / `fallback` / `local-rule`）；任何响应都要用 `projectId` + `projectRevision` + `requestId` 三者校验，不匹配就丢弃。模型永远不能把任务标记为完成、不能解决疑问、不能改变项目事实。

---

## 1. 契约边界

### 1.1 本轮包含

| 内容 | 说明 |
| --- | --- |
| `POST /api/advisor/recommendations` | 唯一的业务接口：根据项目当前状态生成 1～3 条下一步建议 |
| `GET /health` | 健康检查（只回服务状态，不含业务数据） |
| store action 契约 | 6 个 action 的入参、返回与失败码 |
| 领域对象最小字段 | `Task` / `Evidence` / `Doubt` / `Recommendation` / `projectRevision` |

### 1.2 本轮明确不包含

| 不做 | 原因 |
| --- | --- |
| 任务、证据、疑问的写入接口 | MVP 由前端 localStorage 持久化；接口只读取状态快照 |
| 账号、登录、权限 | 首轮任务文档第 1 节已排除 |
| 材料解析、项目问答、计划生成接口 | 只预留键名与路径，见第 8 节 |
| 论文相关接口 | `src/services/papers.ts` 本轮保持现状，不在契约范围 |
| 附件上传 | 只保留证据里的文件名字段，不定义上传协议 |

### 1.3 各成员各自需要什么

| 成员 | 只看这些 | 要交付的东西 |
| --- | --- | --- |
| 李焰彬 | 第 2、3、4、6、8 节 | `src/types/platform.ts` 的 DTO、`src/stores/**` 的 6 个 action、`src/services/advisorApi.ts` 的 HTTP 适配、进度与活动映射 |
| 雍蕾 | 第 3、5、6 节 | 建议区的 6 个状态、建议卡片字段映射、证据提交与失败保留 |
| 吴佳璐 | 第 4.1、4.3、6、8 节 | `promptVersion` 取值、提示词规格、非法输出与引用越界的反例样例 |

---

## 2. 领域对象最小字段

**通用约定**

| 项 | 约定 |
| --- | --- |
| ID 形态 | `<前缀>_<可打印字符串>`，长度 ≤ 64；示例：`tsk_5b21c0e4_0`、`tsk_2da77a87_dd5f3f0c5`；**由前端生成**，服务端只当不透明字符串。契约不要求固定 32 位十六进制 |
| ID 前缀 | 项目 `prj_`、任务 `tsk_`、证据 `evd_`、疑问 `dbt_` |
| 时间 | ISO 8601 带时区偏移，例如 `2026-09-25T10:12:00+08:00`。**不存展示字符串**，界面格式化由前端负责 |
| 缺失值 | 一律用 `null`，不用空字符串，不用省略字段（见第 9 节差异 2） |
| 枚举 | 只允许表中列出的值，不接受同义写法 |

### 2.1 Project（只列契约相关字段）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 项目稳定 ID |
| `name` | string | 是 | 项目完整名称 |
| `short` | string | 是 | 项目短名/标签名（不是描述）；1～20 字；用于标签与地图中心；完整名称用 `name` |
| `projectRevision` | number | 是 | 见 2.6 |
| `currentMilestone` | string \| null | 是 | 当前里程碑名称；无则 `null` |
| `milestones` | Milestone[] | 是 | 里程碑列表（`{ name, status, progress }`，`status ∈ done/cur/todo`，`progress: 0..100`） |
| `schemaVersion` | number | 是 | localStorage 结构版本；V2 业务请求不发送，迁移时放在 `source.schemaVersion` |

### 2.2 Task

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | `tsk_` 前缀 |
| `projectId` | string | 是 | 所属项目，本地存储用于隔离 |
| `title` | string | 是 | 任务标题，1～60 字 |
| `status` | `'todo' \| 'doing' \| 'done'` | 是 | 三态由三个动作分别驱动，见 3.2 |
| `doneCriteria` | string \| null | 是 | 完成标志；缺失时必须为 `null` |
| `owner` | string \| null | 是 | 建议负责人；MVP 无成员名单，一律 `null` |
| `milestone` | string \| null | 是 | 所属里程碑名称 |
| `createdAt` | string | 是 | ISO 时间 |
| `updatedAt` | string | 是 | ISO 时间 |

### 2.3 Evidence

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | `evd_` 前缀 |
| `projectId` | string | 是 | 所属项目 |
| `submissionId` | string | 是 | **幂等键**，前端每次提交生成一次；重复提交同一个值不得重复写入 |
| `taskId` | string \| null | 是 | 关联任务；自由记录进展时为 `null` |
| `didWhat` | string | 是 | 完成了什么，1～300 字 |
| `foundWhat` | string \| null | 是 | 发现了什么 |
| `stillUnsure` | string \| null | 是 | 还有什么不确定；非空时同时生成一条 `Doubt` |
| `attachmentName` | string \| null | 是 | MVP 只记文件名，不定义上传 |
| `author` | string \| null | 是 | MVP 一律 `null` |
| `createdAt` | string | 是 | ISO 时间 |

### 2.4 Doubt

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | `dbt_` 前缀 |
| `projectId` | string | 是 | 所属项目 |
| `text` | string | 是 | 疑问内容 |
| `status` | `'open' \| 'resolved'` | 是 | 只有 `open` 会进入建议请求 |
| `sourceEvidenceId` | string \| null | 是 | 由哪条证据产生；模板自带疑问为 `null` |
| `createdAt` | string | 是 | ISO 时间 |
| `resolvedAt` | string \| null | 是 | 未解决时为 `null` |

### 2.5 Recommendation

Recommendation 有两个形态，**字段名完全一致，只是前端多两个本地字段**，不存在第二套 DTO：

**（a）服务端 DTO：一条 suggestion 的线格式**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | 建议标题，1～60 字 |
| `whyNow` | string | 是 | 为什么现在做，1～300 字 |
| `doneCriteria` | string | 是 | 完成标志，1～200 字 |
| `existingTaskId` | string \| null | 是 | 见 4.6：`null` = 提出新任务候选 |
| `basisEvidenceIds` | string[] | 是 | 依据的证据 ID，可为空数组 |
| `basisDoubtIds` | string[] | 是 | 依据的疑问 ID，可为空数组 |

**（b）前端领域对象 `Recommendation`：在 (a) 之外增加以下本地字段**

| 本地字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 前端生成：`rec_<requestId>_<index>`，本地规则为 `rec_local_<revision>_<index>`；**只用于列表 key 与去重** |
| `source` | `'model' \| 'fallback' \| 'local-rule'` | 与响应同值；本地规则固定 `local-rule` |
| `requestId` | string \| null | 来自响应；本地规则为 `null` |
| `projectRevision` | number | 生成该建议时的项目版本 |
| `generatedAt` | string | 落库时间（ISO） |

### 2.6 projectRevision

| 项 | 约定 |
| --- | --- |
| 类型 | 正整数，从 1 开始 |
| 所有者 | 前端（MVP 无服务端持久化，服务端只回显） |
| 何时 +1 | 每一次会改变项目状态的本地写入：`createProject`、`claimTask`、`submitEvidence`（含幂等命中时不加）、`resolveDoubt`；v2 增加：保存项目基本信息、材料登记、草稿条目确认/修改/删除、整份草稿确认 |
| 何时不变 | 纯读取、切换项目、界面筛选、建议请求本身 |
| 用途 | ① 丢弃过期响应；② 服务端缓存键；③ 将来服务端持久化后判断冲突 |
| 不可变性 | 递增，不重用，回退不还原 |

> **当前实现（2026-09-28）**：`Project.projectRevision` 已是项目字段中的递增整数；前端在成功写入项目状态时递增，重复 `submissionId` 命中时不递增。旧版项目由 `src/stores/persistence.ts` 迁移到当前结构。


---

## 3. 前端 store action 契约

### 3.1 统一结果类型

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }
```

规则：

1. 页面**不得**通过 toast 文案判断成功，只能看 `ok`；
2. `message` 是给人看的，`code` 是给逻辑判断的；
3. 失败时 `data` 不存在，`ok: true` 时 `code` 不存在（不要写"既有 data 又有 code"的中间态）。

### 3.2 六个 action

| action | 入参 | 成功 `data` | 是否访问网络 |
| --- | --- | --- | --- |
| `createProject(input)` | `{ topicId: string \| null; customName?: string; members: number; manualName?: string \| null; dataName?: string \| null }` | `{ projectId; projectRevision }` | 否 |
| `selectProject(projectId)` | `string` | `{ projectId; projectRevision }` | 否 |
| `claimTask(input)` | `{ taskId: string } \| { draft: NewTaskDraft }`（二者互斥） | `{ taskId; status: 'doing'; projectRevision }` | 否 |
| `submitEvidence(input)` | `{ submissionId; taskId: string \| null; didWhat; foundWhat?; stillUnsure?; attachmentName?; complete: boolean }` | `{ evidenceId; submissionId; deduplicated: boolean; doubtId: string \| null; taskStatus: 'doing' \| 'done' \| null; projectRevision }` | **间接访问**：证据成功保存后自动触发 `refreshRecommendations`；建议请求失败不影响证据结果 |
| `resolveDoubt(doubtId)` | `string` | `{ doubtId; projectRevision }` | 否 |
| `refreshRecommendations(options?)` | `{ forceRefresh?: boolean }` | `{ source; suggestions: Recommendation[]; cached: boolean; fallbackReason: string \| null; requestId: string \| null }` | **是** |

`NewTaskDraft` 用于「建议对应的是**新任务候选**」（即 `existingTaskId === null`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 取建议的 `title` |
| `doneCriteria` | string | 取建议的 `doneCriteria` |
| `requestId` | string \| null | 该候选来自哪次建议请求；本地规则为 `null` |
| `basisEvidenceIds` | string[] | 原样保存，供日后追溯「这条任务为什么会出现」 |
| `basisDoubtIds` | string[] | 同上 |

约束：

1. 传 `draft` 时由**前端**生成 `taskId`，任务直接以 `doing` 落库（不经过 `todo`），并 `projectRevision + 1`；
2. 传 `taskId` 时任务必须存在且不能是 `done`，否则返回 `NOT_FOUND` 或 `TASK_NOT_CLAIMABLE`；
3. 两种入参不得同时出现，同时出现按 `INVALID_INPUT` 处理；
4. 同一项目中，字段完全相同的 `draft` 重复提交必须幂等：返回同一个 `taskId`，不得新增第二条任务或再次递增 `projectRevision`。实现可使用规范化后的 draft 内容生成稳定键；不同 draft 可以生成不同任务。

三条动作语义（必须互相独立，见首轮任务文档 4.1）：

| 动作 | 状态变化 | 不允许发生的事 |
| --- | --- | --- |
| 认领 `claimTask` | `todo` → `doing` | **不得**增加任何完成比例 |
| 记录进展 `submitEvidence({ complete: false })` | 追加证据、必要时追加疑问 | **不得**把任务置为 `done` |
| 确认完成 `submitEvidence({ complete: true })` | `doing` → `done`，进度由已完成任务重新推导 | 必填字段缺失时整个调用失败，不得部分写入 |

### 3.3 store action 的失败码（本地错误，非 HTTP 错误码）

| code | 触发 | 页面该做什么 |
| --- | --- | --- |
| `NOT_FOUND` | 传入的 id 在当前项目中不存在 | 刷新列表，提示"该条目已不存在" |
| `PROJECT_MISMATCH` | id 属于另一个项目 | 不提示用户，清理并重新加载 |
| `INVALID_INPUT` | 必填字段为空、超出长度上限 | 高亮出错的字段 |
| `TASK_NOT_CLAIMABLE` | 对 `done` 任务再次认领 | 提示"该任务已完成" |
| `ALREADY_RESOLVED` | 预留；当前 `resolveDoubt` 重复调用直接返回 `ok: true`，不改状态、不递增版本 | 不作为失败处理 |
| `STORAGE_FULL` | localStorage 写入失败 | 提示"本地存储已满"，**保留表单内容** |
| `NETWORK_ERROR` | 只由 `refreshRecommendations` 返回：未收到契约定义的 HTTP 响应 | 切到 `local-rule`，见 5.1 |

---

## 4. `POST /api/advisor/recommendations`

### 4.0 路由与请求约定

| 项 | 约定 |
| --- | --- |
| 完整 URL | `https://api.xinxian-music.xyz/api/advisor/recommendations` |
| 前端拼接 | `import.meta.env.VITE_API_BASE_URL` **不含** `/api`；适配层自行追加 `/api/advisor/recommendations`，避免出现 `/api/api/...` |
| Method / 头 | `POST`，`Content-Type: application/json`（`charset=utf-8`） |
| 鉴权 | MVP 无账号，**不带** Cookie、不带自定义 token；当前部署使用生产来源白名单，IP 限流暂未启用 |
| 请求体上限 | 256 KB，超出返回 400 `INVALID_INPUT` |
| 连接超时 | 当前前端适配层为 20 秒；服务端 provider 为 20 秒，服务层安全网为 25 秒。目标前端单次请求为 30 秒，见 7.5 的待修正项 |
| 重试 | 适配层最多自动重试 1 次，仅限 `retryable: true` 的失败，退避 1 秒 |

### 4.1 请求字段

| 字段 | 类型 | 必须 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `contractVersion` | string | 是 | 本轮固定 `"1.0"` | 契约版本；不匹配返回 400 |
| `requestId` | string | 是 | UUID v4（36 字符） | 本次调用的唯一标识，响应原样回显 |
| `projectId` | string | 是 | ≤ 64 | 项目 ID |
| `projectRevision` | number | 是 | ≥ 1 的整数 | 前端发出请求时的项目版本 |
| `projectName` | string | 是 | 1～120 | 项目完整名称 |
| `currentMilestone` | string \| null | 是 | ≤ 60 | 当前里程碑名称 |
| `confirmedContext` | string[] | 是 | ≤ 10 条，每条 ≤ 200 字 | 已确认的项目事实（目标、交付、已定范围等）；没有就传 `[]` |
| `tasks` | TaskSnapshot[] | 是 | ≤ 100 条 | **该项目全部任务（含已完成）**，否则无法判断"不得推荐已完成任务" |
| `evidence` | EvidenceSnapshot[] | 是 | ≤ 30 条，按 `createdAt` 倒序 | 只发最近若干条 |
| `doubts` | DoubtSnapshot[] | 是 | ≤ 30 条 | **只发 `status: 'open'` 的疑问** |
| `promptVersion` | string | 是 | 须在服务端支持列表内 | 本轮支持 `"mvp-prompt-v1"`；取值由吴佳璐的 `docs/ai/prompt-spec.md` 维护 |
| `forceRefresh` | boolean | 是 | — | `true` 表示绕过服务端缓存重新请求（对应页面「重新判断下一步」） |

快照字段（**不含** `projectId`，由顶层 `projectId` 决定归属）：

| 快照 | 字段 |
| --- | --- |
| `TaskSnapshot` | `taskId`、`title`、`status`、`doneCriteria`、`owner`、`milestone`、`updatedAt` |
| `EvidenceSnapshot` | `evidenceId`、`submissionId`、`taskId`、`didWhat`、`foundWhat`、`stillUnsure`、`author`、`createdAt` |
| `DoubtSnapshot` | `doubtId`、`text`、`status`、`sourceEvidenceId`、`createdAt` |

请求中**不允许**出现其他项目的 ID。服务端以顶层 `projectId` 为准；发现无法归属的 ID 按 4.6 处理。

> **v2 新增可选字段（M2-A）**：请求体可携带 `projectProfile`（项目基本信息）与 `confirmedMaterials`（已确认材料片段），字段、上限与版本要求见第 17 节；两个字段缺失时行为与 v1.3 完全一致。

### 4.2 完整请求 JSON 示例

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 12,
  "projectName": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
  "currentMilestone": "选题确认与文献调研",
  "confirmedContext": [
    "项目目标：构建极端风浪事件识别与预警的原型系统，为海上作业安全提供参考",
    "交付内容：可交互原型 + 正文不超过 4 页的会议论文",
    "已确认范围：先做西北太平洋，暂不覆盖全球海域"
  ],
  "tasks": [
    {
      "taskId": "tsk_5b21c0e4a1f04f0e9c7d3b6a2e8f105c",
      "title": "调研极端风浪事件的定义与识别方法",
      "status": "doing",
      "doneCriteria": "一页调研笔记：3 类定义 + 阈值方法对比 + 初步倾向",
      "owner": null,
      "milestone": "选题确认与文献调研",
      "updatedAt": "2026-09-25T10:12:00+08:00"
    },
    {
      "taskId": "tsk_77aa10b9d3e2410f8a6c5b9d7e2f0418",
      "title": "跑通 ERA5 与浮标数据的下载链路",
      "status": "todo",
      "doneCriteria": "下载一段样例数据，并能用 Python 读出关键变量",
      "owner": null,
      "milestone": "数据获取与预处理",
      "updatedAt": "2026-09-24T20:40:00+08:00"
    },
    {
      "taskId": "tsk_1c4e8f02b7a94d3e8f1a6c0b5d7e2934",
      "title": "确定研究海域与时间范围",
      "status": "done",
      "doneCriteria": "一句话范围说明 + 数据可用性确认",
      "owner": null,
      "milestone": "选题确认与文献调研",
      "updatedAt": "2026-09-23T15:02:00+08:00"
    }
  ],
  "evidence": [
    {
      "evidenceId": "evd_a03d51f6c9e24b7f8d1a3c5e0b7f2946",
      "submissionId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
      "taskId": "tsk_5b21c0e4a1f04f0e9c7d3b6a2e8f105c",
      "didWhat": "查了 6 篇关于极端风浪事件定义与阈值方法的文献",
      "foundWhat": "多数研究用有效波高第 95 或 99 百分位做阈值，也有用风速与浪高联合判定的",
      "stillUnsure": "ERA5 海浪场 0.5 度的分辨率与需求方要的公里级判断差距怎么处理",
      "author": null,
      "createdAt": "2026-09-25T10:05:00+08:00"
    }
  ],
  "doubts": [
    {
      "doubtId": "dbt_6e2b8c07f1d3490a8c5e2b7f0d3a9186",
      "text": "ERA5 海浪场分辨率与需求方要的公里级判断存在数量级差距，要不要换数据源",
      "status": "open",
      "sourceEvidenceId": "evd_a03d51f6c9e24b7f8d1a3c5e0b7f2946",
      "createdAt": "2026-09-25T10:05:00+08:00"
    }
  ],
  "promptVersion": "mvp-prompt-v1",
  "forceRefresh": false
}
```

### 4.3 成功响应（模型生成）

HTTP `200`。

| 字段 | 类型 | 必须 | 说明 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | 与请求一致 |
| `requestId` | string | 是 | 与请求一致 |
| `projectId` | string | 是 | 与请求一致 |
| `projectRevision` | number | 是 | 与请求一致 |
| `source` | `'model' \| 'fallback'` | 是 | 服务端**只**会返回这两个值；`local-rule` 不出现在 HTTP 响应中 |
| `fallbackReason` | string \| null | 是 | `source: 'model'` 时必须是 `null`；`source: 'fallback'` 时为第 6 节的失败原因码 |
| `cached` | boolean | 是 | 是否直接复用服务端缓存 |
| `promptVersion` | string | 是 | 本次实际使用的提示词版本，必须等于请求值 |
| `suggestions` | Suggestion[] | 是 | 1～3 条，见 4.5 |

`title`、`whyNow`、`doneCriteria` 是直接展示给用户的文本，必须使用自然、易懂的中文。模型不得在这些文本中输出字段名、JSON 键名、变量名或内部状态名；例如 `currentMilestone`、`confirmedContext`、`projectRevision`、`doneCriteria`、`evidence`、`doubts`、`tasks`、`doing`、`done` 必须分别改写为“当前里程碑”“已确认背景”“项目版本”“完成标准”“证据”“未解决疑问”“任务”“进行中”“已完成”。服务端检测到内部词或非中文用户文案时按非法模型输出进入规则兜底，不把原始模型文本返回给客户端。

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 12,
  "source": "model",
  "fallbackReason": null,
  "cached": false,
  "promptVersion": "mvp-prompt-v1",
  "suggestions": [
    {
      "title": "把 ERA5 海浪场的分辨率缺口写成待确认事项并向助教核实",
      "whyNow": "你们刚提交的证据已经指出 0.5 度海浪场与公里级判断存在数量级差距，而下一步要做的数据下载会直接建立在这个分辨率上；现在不确认，后面所有阈值结果都要重算。",
      "doneCriteria": "一页说明：0.5 度对应的实际距离、缺口量化、两个可选替代数据源、一句换或不换的结论",
      "existingTaskId": "tsk_5b21c0e4a1f04f0e9c7d3b6a2e8f105c",
      "basisEvidenceIds": ["evd_a03d51f6c9e24b7f8d1a3c5e0b7f2946"],
      "basisDoubtIds": ["dbt_6e2b8c07f1d3490a8c5e2b7f0d3a9186"]
    },
    {
      "title": "核对浮标数据与 ERA5 的时间与空间覆盖是否重叠",
      "whyNow": "你们已确定研究海域，但还没有确认现场浮标数据能否覆盖同一时段；没有重叠就做不了验证，而验证是识别方法的必要前提。",
      "doneCriteria": "一张对照表：浮标站点经纬度、可用时段、与 ERA5 网格的重叠情况",
      "existingTaskId": null,
      "basisEvidenceIds": [],
      "basisDoubtIds": []
    }
  ]
}
```

### 4.4 成功响应（服务端规则兜底）

HTTP `200`，结构完全相同，仅 `source` 与 `fallbackReason` 不同。`suggestions` 由服务端规则生成，`existingTaskId` 与 `basis*Ids` 同样必须落在本次请求范围内。

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 12,
  "source": "fallback",
  "fallbackReason": "MODEL_TIMEOUT",
  "cached": false,
  "promptVersion": "mvp-prompt-v1",
  "suggestions": [
    {
      "title": "先把进行中的任务收尾：调研极端风浪事件的定义与识别方法",
      "whyNow": "该项目当前有一个进行中的任务，且已有一条证据留下未解决的问题；先把它收尾，后面的数据下载才有明确的阈值口径。",
      "doneCriteria": "补齐完成标志里要求的调研笔记，并提交证据",
      "existingTaskId": "tsk_5b21c0e4a1f04f0e9c7d3b6a2e8f105c",
      "basisEvidenceIds": ["evd_a03d51f6c9e24b7f8d1a3c5e0b7f2946"],
      "basisDoubtIds": []
    },
    {
      "title": "处理未解决疑问：ERA5 海浪场分辨率缺口",
      "whyNow": "这是项目里唯一未解决的疑问，它会直接影响数据获取阶段的全部结论。",
      "doneCriteria": "给出结论并标记该疑问已解决",
      "existingTaskId": null,
      "basisEvidenceIds": [],
      "basisDoubtIds": ["dbt_6e2b8c07f1d3490a8c5e2b7f0d3a9186"]
    },
    {
      "title": "启动「数据获取与预处理」的第一个任务：跑通 ERA5 与浮标数据的下载链路",
      "whyNow": "数据下载链路是大数据项目最常见的卡点，越早验证越好。",
      "doneCriteria": "下载一段样例数据，并能用 Python 读出关键变量",
      "existingTaskId": "tsk_77aa10b9d3e2410f8a6c5b9d7e2f0418",
      "basisEvidenceIds": [],
      "basisDoubtIds": []
    }
  ]
}
```

### 4.5 失败响应

HTTP 状态码见第 6 节。响应体结构固定，**不含** `suggestions`。

| 字段 | 类型 | 必须 | 说明 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | 固定 `"1.0"`，请求无法解析时也返回 |
| `requestId` | string \| null | 是 | 请求体可解析时回显；**JSON 无法解析或字段缺失导致无法取值时为 `null`** |
| `code` | string | 是 | 第 6 节的错误码 |
| `message` | string | 是 | 面向开发者的一句话，不含密钥、不含模型原始输出 |
| `retryable` | boolean | 是 | 见第 6 节 |
| `retryAfterSeconds` | number \| null | 是 | 只有 `RATE_LIMITED` 时给整数，其余为 `null` |

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "code": "MODEL_TIMEOUT",
  "message": "模型调用超过 20 秒未返回，已改用规则建议",
  "retryable": true,
  "retryAfterSeconds": null
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": null,
  "code": "INVALID_INPUT",
  "message": "请求体不是合法 JSON 或缺少必填字段",
  "retryable": false,
  "retryAfterSeconds": null
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "code": "RATE_LIMITED",
  "message": "请求过于频繁，请稍后重试",
  "retryable": true,
  "retryAfterSeconds": 30
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "code": "MODEL_NOT_CONFIGURED",
  "message": "服务端未配置模型密钥，已改用规则建议",
  "retryable": false,
  "retryAfterSeconds": null
}
```

> 注意：`MODEL_TIMEOUT` 与 `MODEL_NOT_CONFIGURED` 在**正常实现下不会到达前端**——服务端在这两种情况下会自行兜底并返回 4.4 的成功响应。保留这两个错误码是为了：① 兜底模块本身失败时仍能给出可读错误；② 前端把两种情况的日志分开，便于排查。

### 4.6 校验规则

**服务端对模型输出的校验（任一不通过按"处理方式"列执行）**

| 检查 | 规则 | 不通过时 |
| --- | --- | --- |
| 建议数量 | `1 ≤ suggestions.length ≤ 3` | 整份判非法 → 走服务端规则兜底 |
| `title` | 非空，trim 后 1～60 字 | 超长截断；为空 → 丢弃该条建议 |
| `whyNow` | 非空，trim 后 1～300 字 | 超长截断；为空 → 丢弃该条建议 |
| `doneCriteria` | 非空，trim 后 1～200 字 | 超长截断；为空 → 丢弃该条建议 |
| `existingTaskId` | `null`，或必须是本次请求 `tasks` 中的 `taskId` | ① 不存在于请求中 → 降级为 `null`（当作新任务候选）并记日志；② 指向 `status: 'done'` 的任务 → **丢弃该条建议** |
| `basisEvidenceIds` | 数组必须存在；每个 ID 必须在请求 `evidence` 中 | 未知 ID → 从数组里剔除并记日志（不丢弃整条建议） |
| `basisDoubtIds` | 数组必须存在；每个 ID 必须在请求 `doubts` 中 | 同上 |
| 丢弃后的数量 | `1 ≤ 剩余条数 ≤ 3` | 为 0 → 整份判非法 → 走服务端规则兜底 |

**服务端对请求的校验**

| 检查 | 不通过时 |
| --- | --- |
| `Content-Type: application/json` 且请求体可解析 | 400 `INVALID_INPUT`，`requestId: null` |
| 所有必填字段存在、类型正确、枚举合法 | 400 `INVALID_INPUT` |
| `contractVersion === "1.0"` | 400 `INVALID_INPUT` |
| `promptVersion` 在支持列表内 | 400 `INVALID_INPUT`（不做静默降级，避免"以为用了新提示词其实没换"） |
| 各数组长度、字符串长度、请求体大小在 4.1 范围内 | 400 `INVALID_INPUT` |
| `projectRevision` 为 ≥ 1 的整数 | 400 `INVALID_INPUT`；**MVP 不校验它是否"过期"**，见 4.7 |

**服务端不做的事**：不判断某条建议"该不该现在做"，不修改任务状态，不生成或保存任何 ID。

### 4.7 过期响应与丢弃规则

**服务端**：MVP 无项目持久化，服务端**不知道**当前真实 `projectRevision`，因此只做回显，**不返回** `STALE_REVISION`。等进入服务端持久化阶段（阶段 5）再启用该码。

**前端**：收到响应后依次校验，任一不通过就整份丢弃，不写入建议数据：

| 顺序 | 条件 | 处理 |
| --- | --- | --- |
| 1 | `response.requestId !== 本次请求的 requestId` | 丢弃（视为串包，记日志） |
| 2 | `response.projectId !== 当前项目 projectId` | 丢弃（用户已切项目） |
| 3 | 响应版本不等于本次请求版本，或当前项目版本已不同于请求发出时 | 丢弃（响应串包或项目状态已变化） |
| 4 | 期间又发起过新的 `refreshRecommendations` | 丢弃（只保留最后一次，建议用 `AbortController` 取消前一次） |
| 5 | 用户已离开工作台或进入创建页 | 丢弃 |

补充约定：

1. 过期响应不能覆盖当前项目的 `suggestions`、`aiError`、任务、证据、疑问或 `projectRevision`；
2. 如果期间已有更新的 `refreshRecommendations`，由更新的请求负责 `loading` 和最终状态，旧请求只能静默结束；
3. 如果当前项目没有更新的有效请求接管（例如认领任务后版本变化，或服务端回显与本次请求不符），旧请求必须结束，当前项目回到可重试的 `idle`，不得留下没有在途请求却永久 `loading` 的状态；
4. `projectRevision` 只在本地写入成功后 +1，因此第 3 条校验天然排除了"请求发出后用户又提交了证据"的旧响应；提交证据本身会在保存后自动发起新建议请求；
5. 通过校验后写入 store 的 `recommendations` 必须整体替换，不是追加（避免同一轮出现两批建议）。

---

## 5. 失败分层与页面表达

### 5.1 谁生成规则建议

**两层兜底，覆盖不同的失败面，缺一层就会出现白屏。**

| 失败面 | 谁兜底 | `source` | 页面状态 |
| --- | --- | --- | --- |
| 模型超时 / 限流 / 上游 5xx / 输出非法 / 未配密钥 | **服务端规则**（后端知道失败原因，且只有它能校验引用 ID） | `fallback` | `AiStatus` = 「使用规则结果」 |
| 后端不可达、DNS / CORS 失败、响应不是合法 JSON、返回 5xx 无响应体 | **前端本地规则**（`src/domain/recommendation.ts` + `src/data/mvpFallbacks.ts`） | `local-rule` | `AiStatus` = 「后端暂不可用，使用本地规则」 |
| 服务端返回 4xx 契约错误（`INVALID_INPUT` 等） | 前端本地规则 + 显示错误原因 | `local-rule` | `AiStatus` = 「请求未被接受」+ 错误码 |

理由：

1. 服务端在输出阶段校验引用 ID；前端掌握本次请求快照，收到响应后也能校验引用 ID，并防御残缺或错误响应；
2. 前端兜底能覆盖"后端整个不可用"的情况，而验收要求"API 失败时证据不丢且显示 fallback"；
3. 两层**内容不共享文件**：后端的兜底规则写在 `server/` 内，只依赖请求体；前端的 `src/data/mvpFallbacks.ts`（吴佳璐）只被前端使用。服务端不导入 `src/` 下任何文件。

### 5.2 「证据已保存但建议生成失败」如何表达

**这是两个独立动作，不是一个原子操作。**

```text
submitEvidence()  → 先落 localStorage，证据写入结果不因建议失败而变成失败
        ↓ 成功后
refreshRecommendations()  → 网络请求，允许失败（submitEvidence 内部自动触发）
```

| 不变量 | 说明 |
| --- | --- |
| 建议失败不得回滚证据 | 证据写入与建议请求之间没有事务关系 |
| 建议失败不得改变 `projectRevision` | 只有本地写入才 +1 |
| 建议失败不得改变任务状态 | 任务状态只由三个动作改变 |
| 建议失败必须留下可见提示 | 页面同时显示"证据已保存"与"建议状态"，不能只显示其中一个 |

页面文案由雍蕾定，语义必须包含这三段：

1. 证据已保存（含时间）；
2. 建议来源（模型 / 规则 / 本地规则）；
3. 失败原因（用 `fallbackReason` 或错误 `code` 映射成人话，不显示原始英文码给最终用户）。

### 5.3 `aiStatus` 状态机（页面建议区）

| 状态 | 何时进入 | 页面表现 |
| --- | --- | --- |
| `idle` | 初始、切换项目后，或旧请求失效且无新请求接管 | 显示"点击获取下一步建议"；允许重新请求 |
| `loading` | 请求发出 | 骨架或转圈；**禁止**在此期间重复点击触发并发请求 |
| `model` | `source: 'model'` | 显示 1～3 条建议与依据（可展开看到依据的证据/疑问原文） |
| `fallback` | `source: 'fallback'` | 同上，另加一条"本次使用规则结果（原因：…）" |
| `local-rule` | `source: 'local-rule'` | 同上，另加"后端暂不可用"；若 `retryable` 提供"重试" |
| `error` | 校验第 6 节的不可重试错误且本地规则也生成不出建议 | 只显示错误与重试入口，不显示空列表 |

### 5.4 建议与任务的衔接

1. `existingTaskId` 非空 → 建议卡上的主按钮是「认领这一步」（调用 `claimTask`）；
2. `existingTaskId` 为 `null` → 属于**新任务候选**：MVP 不自动创建任务，按钮文案是「就按这个做」，点击后调用 `claimTask({ draft })`，由前端生成任务并直接置为 `doing`，`projectRevision + 1`；
3. 已经 `done` 的任务不得出现在建议里；服务端负责过滤，前端按本次请求快照再核验一次；
4. 页面用建议 `id` 防止同一张卡重复点击；store 还必须按第 3.2 条对完全相同的 draft 幂等，不能只依赖页面状态。

---

## 6. 错误码、HTTP 状态码与 retryable

### 6.1 本轮启用的错误码

| code | HTTP | retryable | 触发条件 | 前端行为 |
| --- | --- | --- | --- | --- |
| `INVALID_INPUT` | 400 | `false` | 请求体非法、缺必填字段、超长度上限、`contractVersion` 或 `promptVersion` 不支持 | 不重试；切 `local-rule`；把 `code` 写进控制台日志 |
| `RATE_LIMITED` | 429 | `true` | 预留给服务端或上游限流；当前部署未启用 IP 限流 | 按 `retryAfterSeconds` 提示后重试；仍失败则切 `local-rule` |
| `MODEL_TIMEOUT` | 504 | `true` | 模型调用超过 20 秒 | 自动重试 1 次；失败切 `local-rule` |
| `INVALID_MODEL_OUTPUT` | 502 | `true` | 模型输出违反 4.6 规则，**且**服务端规则兜底也未能产出建议 | 自动重试 1 次；失败切 `local-rule` |
| `MODEL_UNAVAILABLE` | 503 | `true` | 上游 5xx、连接失败、上游返回无法归类的错误 | 同上 |
| `MODEL_NOT_CONFIGURED` | 503 | `false` | 服务端没有可用密钥或配置缺失 | 不重试（重试不会变好）；切 `local-rule`；日志中标记为配置问题 |

> v2（M2-A）新增的错误码（材料类型、文件过大、空文件、编码不可读、解析失败等）见第 16 节；`retryable` 语义相同。

`retryable` 的含义统一为：**"在用户不改变输入的前提下，稍后重试有可能成功"**。

- `true` 只用于瞬态失败（限流、超时、上游故障）；
- `false` 用于确定性失败（输入问题、配置缺失）；
- `retryable: true` 不代表前端必须无限重试，适配层上限是 1 次。

### 6.2 特殊与预留错误码

| code | HTTP | 用途 |
| --- | --- | --- |
| `INTERNAL` | 500 | **当前可能返回**：服务端未预期异常，`message` 不含堆栈与密钥；前端按契约失败处理并尝试本地规则 |
| `STALE_REVISION` | 409（预留） | 服务端开始保存项目状态后，`projectRevision` 落后于服务端时返回；MVP 不返回 |
| `UNAUTHORIZED` | 401（预留） | 引入账号体系后；MVP 不返回 |

### 6.3 `GET /health`

```http
GET /health
```

```json
{
  "status": "ok",
  "service": "course-platform-api",
  "contractVersion": "1.0",
  "checkedAt": "2026-09-25T11:03:00.000Z"
}
```

- 健康时返回 `200`；当前实现只报告进程健康，不探测模型依赖，因此不返回 `degraded` 或 `modelConfigured` 字段；
- 该接口不得返回任何项目数据。

### 6.4 `POST /api/advisor/chat`

聊天接口接收当前项目快照和有限聊天上下文，调用服务端模型生成纯文本回答。请求必须使用
`contractVersion: "1.0"`、`promptVersion: "advisor-chat-v1"`，并包含 `requestId`、`projectId`、正整数
`projectRevision`、`projectName`、`currentMilestone`、`tasks`、`evidence`、`doubts`、`chatHistory` 和非空 `question`。
`chatHistory` 最多 20 条，每条 `role` 只能为 `user` 或 `assistant`，文本最多 2000 字；问题最多 2000 字。
任务、证据和疑问沿用 4.1 的数组上限，请求体最多 256 KB。

```http
POST /api/advisor/chat
Content-Type: application/json
```

```json
{
  "contractVersion": "1.0",
  "promptVersion": "advisor-chat-v1",
  "requestId": "req_...",
  "projectId": "prj_...",
  "projectRevision": 1,
  "projectName": "项目名称",
  "currentMilestone": "首轮 MVP",
  "tasks": [],
  "evidence": [],
  "doubts": [],
  "chatHistory": [{"role": "user", "text": "上一轮问题"}],
  "question": "我下一步应该做什么？"
}
```

成功响应为 HTTP 200，`source` 为 `model` 或 `fallback`；模型成功时 `fallbackReason` 为 `null`，并返回非空 `answer`。
模型不可用、超时或输出非法时，服务端返回安全的推进提示，`source: "fallback"`，并设置对应的
`fallbackReason`（例如 `MODEL_TIMEOUT`），不返回 API Key、环境变量、服务器路径或上游响应原文。
面向用户的建议文本和聊天回答必须使用自然、易懂的中文。模型不得在用户可见文本中输出字段名、JSON 键名、变量名或内部状态名（例如 `currentMilestone`、`doneCriteria`、`evidence`、`doubts`、`tasks`、`doing`、`done`）；需要表达这些概念时应使用“当前里程碑”“完成标准”“证据”“未解决疑问”“任务”“进行中”“已完成”等中文。服务端检测到这类内部词时按模型输出非法处理并安全兜底，不把原始模型文本返回给客户端。
非法 JSON、缺字段、超限请求返回 400 `INVALID_INPUT`；GET 返回 405；允许的 CORS 预检返回 204，其他来源返回 403。

---

## 7. 部署现状与边界

> 本节区分「约定」与「已验证事实」。**契约不代表接口已上线。**

### 7.1 域名与链路（约定）

| 项 | 值 |
| --- | --- |
| 前端站点 | `https://course.xinxian-music.xyz`（Vue hash 路由，论文页为 `/#/papers`） |
| API 入口 | `https://api.xinxian-music.xyz` |
| 健康检查 | `https://api.xinxian-music.xyz/health` |
| 建议接口 | `https://api.xinxian-music.xyz/api/advisor/recommendations` |
| 前端环境变量 | `VITE_API_BASE_URL=https://api.xinxian-music.xyz`（不含 `/api`）；本地开发可用 `http://localhost:8080` 或开发代理 |

### 7.2 服务器侧端口

- 现有 API 隧道 `wzh-jhl-xinxian-api-tunnel` 在 Cloudflare 控制台配置为 `api.xinxian-music.xyz` → `http://127.0.0.1:8080`。
- **约定**：后端监听 `127.0.0.1:8080`，与现有隧道对齐；端口不写入本契约的 URL，改动端口只需要改隧道与 Nginx，不影响前端。
- 计划文档中"例如 127.0.0.1:3000"是早期建议值，**以 8080 为准**（见第 9 节差异 12）。
- 后端内部端口不得对公网开放。

### 7.3 部署验证状态（写进契约是为了避免误判）

| 事项 | 状态 |
| --- | --- |
| `api.xinxian-music.xyz` 的 DNS 与证书 | **已验证**（2026-09-25） |
| 8080 上是否已有服务占用 | **已验证**：后端由 systemd 监听 `127.0.0.1:8080` |
| API 隧道 `cloudflared.service` 与 8080 的连通、CORS、健康检查 | **已验证**（OPTIONS 204、POST 200、source=model） |
| 前端隧道与静态站点 | 已验证过一次外网 `200 OK`（2026-09-23 记录） |
| 建议接口本身 | **已验证并部署**：公网 POST 返回 200、source=model、建议 3 条 |

以上线上事项已经完成一次实测。后续每次后端或隧道变更后都必须重新验证，不得把历史验证结果当成当前部署状态。

### 7.4 跨域与访问控制（约定）

| 项 | 约定 |
| --- | --- |
| 允许来源 | 允许生产来源 `https://course.xinxian-music.xyz` 与本地开发来源 `http://localhost:5173`、`http://127.0.0.1:5173`；其他带 `Origin` 的来源返回 403 |
| 方法 | V2：`POST`、`OPTIONS`；V3：`GET`、`POST`、`PATCH`、`DELETE`、`OPTIONS`（预检必须显式处理） |
| 请求头 | `Content-Type`、`X-Request-Id`；V2 不使用 Cookie，`Access-Control-Allow-Credentials` 关闭；V3 启用 Cookie，必须为 `true` |
| 缓存 | API 响应禁止公共边缘缓存（`Cache-Control: no-store`）；当前未实现服务端建议缓存，`cached` 固定为 `false` |
| 限流 | 当前部署尚未启用 IP 限流；`RATE_LIMITED` 保留为契约错误码，启用限流后才返回 |
| 预算 | 单日调用上限与单次 token 上限尚未在本轮部署中启用；启用后超限应走 `fallback`，不返回 5xx 给前端 |

> v2 新增的 `POST /api/materials`、`POST /api/materials/understanding` 路径沿用本节 CORS 策略（同一份白名单与预检处理），不新增第二套跨域规则。
>
> **V2/V3 凭据策略不同**：V2 建议/聊天/材料接口仍不带 Cookie，`Access-Control-Allow-Credentials` 保持关闭；V3 账号与项目接口必须带 Cookie，返回 `Access-Control-Allow-Credentials: true`、精确回显 `Origin` 并设置 `Vary: Origin`，禁止 `*`。两套策略按路径族切换，不能全局放开。详细约定见 21.2.3。

### 7.5 超时与重试（约定）

| 层 | 值 | 说明 |
| --- | --- | --- |
| 前端适配层（当前实现） | 20 秒 | 超时按 `NETWORK_ERROR` 处理 → `local-rule` |
| 服务端 provider | 20 秒 | provider 超时 → 服务端规则兜底（`fallbackReason: MODEL_TIMEOUT`） |
| 服务层安全网（当前实现） | 25 秒 | 仅兜住 provider 未遵守超时的异常情况 |
| 目标前端单次请求 | 30 秒，待实现 | 比服务层安全网多 5 秒，给服务端规则兜底和响应传输留时间；当前 20 秒可能先触发 `local-rule`，收不到服务端 `fallback` |
| 反向代理 / Cloudflare | 至少 35 秒，待核验 | 代理早于服务端结束会导致前端收到网络/5xx，而不是契约响应；可重试时前端最多发两次请求，每次各自计时 |

---

## 8. 预留扩展位

**原则**：只预留键名与版本机制，**不设计这些功能的完整接口**。

### 8.1 版本字段

| 字段 | 本轮 | 用途 |
| --- | --- | --- |
| `contractVersion` | V2 建议 / 聊天 / 材料接口：`"1.0"`；V3 新接口：`"3.0"` | 契约结构版本；不兼容变更时 +1，服务端对不支持的版本返回 400。组合规则见 20.1.1 |
| `promptVersion` | 建议 / 聊天：`mvp-prompt-v1` / `mvp-prompt-v2` / `mvp-prompt-v3`、`advisor-chat-v1` / `advisor-chat-v2` / `advisor-chat-v3`；材料理解：`material-understanding-v1`；阶段候选：`milestone-candidate-v1` | 提示词版本，由吴佳璐在 `docs/ai/prompt-spec.md` 维护；服务端支持列表必须以本契约为准同步更新。取值与切换规则见第 17.4、23.4 节；v3 必须与 `milestoneContext` 成对使用 |

### 8.2 预留键名（本轮不发送、不定义结构，服务端必须忽略）

| 键名 | 计划用途 | 预计阶段 |
| --- | --- | --- |
| `materialUnderstanding` | 材料理解：从材料生成四块理解草稿及其来源 | 阶段 4 |
| `qaTurn` | 项目问答：一轮提问与回答的上下文 | 阶段 5 |
| `planDraft` | 计划建议：按阶段生成任务草稿 | 阶段 3 |
| `suggestion.suggestedOwner` | 建议负责人（需要成员名单） | 阶段 6 |
| `knowledgeRevision` | 已确认项目理解的版本（确认门禁恢复后） | 阶段 4 |

### 8.3 预留路径（只登记，不定义请求与响应）

| 路径 | 用途 |
| --- | --- |
| `POST /api/materials/understanding` | 材料 → 四块理解草稿 |
| `POST /api/advisor/qa` | 项目问答 |
| `POST /api/plan/draft` | 计划草稿 |

这三个接口**必须**沿用本契约的：`contractVersion`、`requestId`、`projectId`、`projectRevision`、`promptVersion`、失败响应结构、错误码表，以及 4.7 的丢弃规则。

### 8.4 未知字段处理规则

| 场景 | 处理 |
| --- | --- |
| 请求中出现契约未定义的字段 | 服务端**忽略**，不报错（便于前后端并行开发） |
| 请求中缺少必填字段 | 400 `INVALID_INPUT` |
| 响应中出现前端未定义的字段 | 前端**忽略**，不得因此报错 |
| 响应中缺少必需字段 | 前端视为契约违规：按 `NETWORK_ERROR` 处理并记录日志，不得静默使用残缺数据 |

---

## 9. 与现有草案的差异

对照《首轮 MVP 任务分配与智能体提示词》第 4 节。

| # | 草案写法 | 本契约的最终选择 | 理由 |
| --- | --- | --- | --- |
| 1 | 无 `contractVersion` | 新增必填 `contractVersion: "1.0"` | 需要为材料理解、问答、计划三个后续接口留出版本协商位；不兼容变更时才 +1 |
| 2 | `existingTaskId?: string`（可选） | **必填可空**：`existingTaskId: string \| null` | JSON 里"字段缺失"与"值为 null"在 TS 中分别落到 `undefined` 与 `null`，两种写法都会出现；统一成必填可空后，前端只需要判断 `null`，也不必为 `undefined` 写分支 |
| 3 | `source: 'model' \| 'fallback'` | 扩为 `'model' \| 'fallback' \| 'local-rule'`（HTTP 响应仍只含前两个） | 后端完全不可达时前端必须自己出建议，这个来源也要能被页面区分，否则 `AiStatus` 会少一个状态 |
| 4 | 无 `fallbackReason` | 新增必填可空 `fallbackReason` | 页面提示要能区分"超时"与"没配密钥"；也便于把配置问题和瞬态故障分开排查 |
| 5 | 无缓存相关字段 | 新增必填 `forceRefresh`（请求）与 `cached`（响应）；缓存键 = `projectId + projectRevision + promptVersion` | 「重新判断下一步」需要一个明确开关；同时避免同一状态反复调用产生费用 |
| 6 | 错误码 5 个 | 增加 `MODEL_NOT_CONFIGURED`（503，`retryable: false`） | 验收要求"没有 API Key 时仍可用"；这种情况给"重试"按钮是误导，`retryable` 必须为假 |
| 7 | 无重试提示字段 | 新增必填可空 `retryAfterSeconds` | 429 的界面提示需要具体秒数，避免前端自己猜 |
| 8 | 失败响应 `requestId: string` | `requestId: string \| null` | 请求体无法解析时服务端取不到 `requestId`，强行返回字符串会造假 |
| 9 | 未规定时间格式 | 统一 ISO 8601 带时区；展示格式化交给前端 | 现有 `EvidenceItem.time` 是 `"09-23 14:05"` 这类展示字符串，无法排序、无法比较、无法跨时区 |
| 10 | 只写 `TaskSnapshot[]` 等，未定字段名 | 快照内固定用 `taskId` / `evidenceId` / `doubtId` | JSON 里出现裸 `id` 无法判断归属；顶层 `projectId` 已表明项目，快照内不再重复 `projectId` |
| 11 | 未规定长度与大小上限 | 4.1 明确了各数组条数、字符串长度与 256 KB 请求体上限 | `INVALID_INPUT` 需要可判定的边界，否则测试无法写反例 |
| 12 | 计划文档建议后端端口 `127.0.0.1:3000` | 以 `127.0.0.1:8080` 为准；契约 URL 不写端口 | 现有 API 隧道已指向 8080；改服务端口比改隧道与 Nginx 更省事，且契约本身只写路径 |
| 13 | `INVALID_MODEL_OUTPUT` 作为普通失败码 | 模型输出非法时**服务端先兜底**返回 `200 + source: 'fallback'`；该码只在兜底也失败时返回 | 后端既然已有兜底能力，就不应把可恢复的错误抛给前端，否则会出现两层兜底互相覆盖、页面状态来回跳 |
| 14 | 未规定 `evidence` / `doubts` 的发送范围 | `tasks` 发全部（含已完成）；`evidence` 发最近 30 条；`doubts` 只发 `open` | 不发已完成任务，服务端无法执行"已完成任务不得再推荐"；已解决疑问不参与判断 |
| 15 | `claimTask(taskId)` 只能认领已有任务 | 入参扩为 `{ taskId } \| { draft: NewTaskDraft }` | 建议里存在"新任务候选"（`existingTaskId: null`），而约定的 6 个 action 中没有创建任务的入口。不新增第 7 个 action（会破坏"雍蕾只调这些 action"的约定），也不允许组件自己造任务 |

**前端迁移状态（2026-09-28）**：上述旧模型差异已在 `main` 的 `src/types/platform.ts`、`src/stores/workbench.ts`、`src/stores/persistence.ts` 和 `src/domain/**` 中处理。结构化任务与证据使用稳定 ID 和 ISO 时间；认领不改变完成比例；`submitEvidence` 使用 `submissionId` 幂等键；公开 action 返回 `ActionResult<T>`。为兼容旧页面，部分 action 仍接受旧入参并在内部转换；新调用方应使用本契约规定的 ID 与结构化入参。前端环境与业务测试现已合入 `main`，当前验收仍发现 draft 幂等和过期响应状态收尾问题，修复后需重新运行完整验收。

---

## 10. 尚待负责人决定的问题

| # | 问题 | 我的默认选择 | 影响 |
| --- | --- | --- | --- |
| 1 | 服务端建议缓存本轮就做，还是推迟到阶段 5？ | **推迟到阶段 5**；当前 `cached` 固定为 `false`，`forceRefresh` 保留以兼容后续缓存 | 本轮不宣称已有服务端缓存 |
| 2 | 4.1 的数组上限（任务 100 / 证据 30 / 疑问 30 / 请求体 256 KB）是否合适？ | **已确认，按现值** | 影响 `INVALID_INPUT` 反例的构造与前端截断逻辑 |
| 3 | `promptVersion` 的首个取值是否确定用 `"mvp-prompt-v1"`？ | **已确认，用该值** | 吴佳璐的提示词规格与前端常量必须与此一致 |
| 4 | MVP 是否需要一层极简鉴权？ | **暂不增加 token**；当前使用生产来源白名单，IP 限流待后续启用 | 若增加 token，前端需要新增鉴权分支 |
| 5 | 服务器 8080 是否空闲？ | **已确认使用 `127.0.0.1:8080`**，Cloudflare 隧道已对齐 | 后端端口变化时必须同步修改隧道 |
| 6 | 切换项目时是否用 `AbortController` 主动取消在途请求？ | **已实现**；同时保留 requestId/projectId/projectRevision 丢弃校验 | 取消只用于节省流量，正确性仍由丢弃规则保证 |
| 7 | 是否需要 `suggestedOwner` 提前启用？ | **本轮不启用**（无成员名单） | 后续先确定成员名单来源 |

---

## 12. v2 契约（M1 冻结）：项目基本信息与材料

> 版本：v2.0（2026-10-12，姜-1 冻结）。`contractVersion` 仍为 `"1.0"`：本轮是**增量扩展**（两个新接口 + 若干可选字段），既有字段语义不变，旧客户端行为不变。
> 本轮范围：M1 + M2-A，文件白名单只有 `.md` / `.txt`；CSV/XLSX 属 M2-B（M2-A 验收通过后），PDF/DOCX/ZIP 属 M4，**本轮不得实现**。
> 分工：接口字段以本节为准；提示词内容以 `docs/ai/prompt-spec.md` 为准；页面文案由前端负责。

### 12.1 新增与修订一览

| 位置 | 内容 |
| --- | --- |
| 第 2.6 节 | `projectRevision` 的 +1 事件增加：保存项目基本信息、材料登记、草稿条目确认/修改/删除、整份草稿确认 |
| 第 13 节 | 项目基本信息（ProjectProfile）字段与请求接入 |
| 第 14 节 | 材料元数据、分段、理解草稿的领域对象 |
| 第 15 节 | `POST /api/materials`、`POST /api/materials/understanding` |
| 第 16 节 | 材料与理解相关的新错误码（稳定 code + 中文 message + retryable） |
| 第 17 节 | 建议 / 聊天的“已确认材料上下文”最小接入与 `promptVersion` 取值 |
| 第 18 节 | 给李焰彬 / 雍蕾 / 吴佳璐使用的 mock JSON |

### 12.2 边界与不变式

1. 服务端**仍然无状态**：材料、草稿与确认状态保存在浏览器 `localStorage`，服务端不保存材料正文，也不生成项目事实；
2. 只有学生**确认**过的材料片段能进入建议与聊天请求；未确认草稿绝不进入请求体；
3. 材料解析失败只影响该份材料：不阻塞项目创建，不影响已有项目与其他接口；
4. 上传被拒绝必须给中文提示，不做静默忽略，不返回 500；
5. 错误响应不回显材料正文，不含服务器路径、密钥或上游响应原文；
6. 模型输出一律是“候选 / 草稿”，不是事实；学生确认前不得被当作项目事实使用；
7. 服务端日志与错误响应只记录类别与数量（例如未知引用次数、丢弃条数），不记录材料正文、模型原始文本或原始引用编号——模型输出不可信，原始编号可能夹带敏感内容。

---

## 13. 项目基本信息（ProjectProfile）

### 13.1 字段

| 字段 | 类型 | 必填 | 约束 | 中文含义 |
| --- | --- | --- | --- | --- |
| `goal` | string \| null | 是 | ≤ 300 字 | 项目目标 |
| `expectedOutcome` | string \| null | 是 | ≤ 300 字 | 预期结果或交付物 |
| `memberNames` | string[] | 是 | ≤ 10 人，每人 1～30 字 | 项目成员姓名 |
| `researchPeriod` | string \| null | 是 | ≤ 100 字 | 研究周期（本轮为自由文本，结构化日期推迟） |
| `scope` | string \| null | 是 | ≤ 300 字 | 项目范围 |
| `outOfScope` | string \| null | 是 | ≤ 300 字 | 暂不处理的内容 |

约定：

1. 缺失值一律 `null`，空字符串按 `null` 处理（与第 2 节通用约定一致）；
2. 这些字段必须保存在项目结构化状态里（默认值与旧数据迁移由前端负责），不能只作为一段聊天文本保存；
3. 修改并保存后 `projectRevision + 1`（见 2.6）。

### 13.2 请求接入（可选字段）

`POST /api/advisor/recommendations` 与 `POST /api/advisor/chat` 的请求体新增**可选**字段 `projectProfile`：

| 情形 | 行为 |
| --- | --- |
| 缺失 / `null` | 与 v1.3 完全一致（旧客户端不受影响） |
| 存在 | 必须满足 13.1 的类型与长度约束，否则 400 `INVALID_INPUT` |
| 存在时的版本要求 | 必须使用 v2 提示词版本（17.4）；与 v1 组合 → 400 `INVALID_INPUT` |

服务端在提示词中用中文标签呈现（“项目目标：……”“项目范围：……”“暂不处理：……”），不发送字段名。`confirmedContext` 保留原语义；v2 前端不应把基本信息重复写进 `confirmedContext`。

---

## 14. 材料领域对象（M2-A）

### 14.1 MaterialMetadata（材料元数据）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `materialId` | string | 是 | `mat_` 前缀 + 可打印字符串，≤ 64；**前端生成**，服务端只当不透明字符串 |
| `projectId` | string | 是 | 所属项目 |
| `name` | string | 是 | 原始文件名，1～200 字；扩展名必须是 `.md` 或 `.txt`（不区分大小写） |
| `type` | `'md' \| 'txt'` | 是 | 服务端按扩展名推导并回显，统一小写 |
| `size` | number | 是 | 原始字节数（服务端按 base64 解码后的实际字节数计算），1～1,048,576 |
| `encoding` | `'utf-8' \| 'gbk'` | 是 | 实际用于解码的编码：UTF-8 优先，失败回退 GBK |
| `state` | `'parsed' \| 'parse_failed'` | 是 | 解析状态；被拒绝的文件不产生材料记录，只返回错误响应 |
| `version` | number | 是 | 前端维护的整数，≥ 1；同一 `materialId` 重新上传时必须 +1 |
| `createdAt` / `updatedAt` | string | 是 | ISO 8601 带时区；服务端生成，同一次解析内两值相同 |
| `failureReason` | string \| null | 是 | `state: 'parse_failed'` 时为中文原因；否则为 `null` |

前端本地另需保存“已读状态”（仅登记文件名 / 待确认草稿 / 已确认）：这是界面展示口径，不进接口。

> V3 持久化使用 `status`（`registered` / `parsed` / `parse_failed` / `unsupported` / `archived`）和 `revision`；V2 线格式字段仍是 `state`。服务端内部映射 `state → status`，`POST /api/materials` 响应不新增字段，旧客户端不受影响。`needsReupload` 是本地展示字段，不进接口、不迁移。

### 14.2 MaterialSegment（分段）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `segmentId` | string | 服务端生成，`seg_<序号>`；**只在同一 `materialId` + `version` 内唯一** |
| `index` | number | 从 0 开始的稳定序号 |
| `startLine` / `endLine` | number | 1 起始、包含两端；同一行内被切分时两段都指向该行 |
| `text` | string | 分段正文，1～2,000 字 |

> V3 扩展：`MaterialSegment` 增加派生 `status`（`active` / `superseded`）与 `charCount`；V2 线格式字段不变。片段不可变，旧版本只读。

### 14.3 MaterialUnderstandingDraft（理解草稿）

服务端响应里的线格式（`draft`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `goalCandidates` | DraftItem[] | 项目目标候选 |
| `outcomeCandidates` | DraftItem[] | 预期产出候选 |
| `dataNotes` | DraftItem[] | 数据字段与数据规模线索 |
| `methodNotes` | DraftItem[] | 方法或约束线索 |
| `openQuestions` | DraftItem[] | 待确认问题；材料中找不到某类依据时也要在这里用中文说明 |

DraftItem：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `itemId` | string | 服务端生成 `cnd_<块短名>_<序号>`；只在**本次响应内**唯一，用作列表 key |
| `text` | string | 1～300 字自然中文 |
| `sources` | MaterialSourceRef[] | 1～3 条；模型只允许引用本次请求中出现的 `segmentId`，材料名、行号、版本由服务端回填 |

MaterialSourceRef：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `materialId` | string | 材料 ID |
| `materialName` | string | 材料名（服务端回填） |
| `materialVersion` | number | 材料版本（服务端回填） |
| `segmentId` | string | 片段 ID（模型唯一允许提供的内容） |
| `startLine` / `endLine` | number | 行号（服务端回填，模型不得自造） |

前端本地字段（不在服务端响应里，由前端 store 维护）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `'pending' \| 'confirmed' \| 'modified'` | 待确认 / 已确认 / 已修改；单块确认、修改、删除与整份确认都只改本地状态，并按 2.6 递增 `projectRevision` |
| `originalContent` | string | 服务端原始文本；修改后仍保留，用于撤销确认时判断回到 `pending` 还是 `modified` |
| `id` | string | 项目内本地唯一键；V3 确认接口使用服务端 `itemId`，不使用该本地键 |

> V3 扩展（第 22.7 节）：草稿条目新增 `archived` 状态、`removedAt`、`originalText` 与服务端稳定 `itemId`；V2 的 `pending/confirmed/modified` 语义不变。`pending` 与 `modified` 都**不是**已确认，只有 `confirmed` 进入 AI 上下文。

### 14.4 分段规则（必须确定性）

1. 统一换行后按行切分（`\r\n`、`\r` 视为 `\n`）；
2. 连续非空行构成一个自然段；空行（仅含空白字符的行）是段落分隔；
3. 相邻自然段合并为一段，直到再加入下一段会超过 2,000 字；单个自然段本身超过 2,000 字时在 2,000 字处切分；
4. 每段记录 `startLine` / `endLine`（1 起始、包含两端）；同一行内发生切分时，两段都指向该行；
5. 相同输入与相同版本必须得到**完全一致**的分段结果（同一文件两次解析结果稳定）。

### 14.5 材料版本与过期响应

1. 材料登记成功后 `projectRevision + 1`；
2. 草稿条目确认 / 修改 / 删除、整份确认后 `projectRevision + 1`；
3. 旧的理解响应、建议响应、聊天响应一律按 4.7 丢弃（`requestId` / `projectId` / `projectRevision` 三项校验）；
4. 重新上传同一 `materialId` 时 `version + 1`；旧版本的片段引用视为过期，不得再进入任何请求。

### 14.6 重新生成草稿与确认继承（前端本地约定，线上字段不变）

`itemId` 只在单次响应内唯一（14.3），因此两次理解请求里出现同名 `itemId` **不代表同一个候选**。前端把服务端草稿写入本地状态时按本节口径处理；17.2 的「确认内容变化时递增 `projectRevision`」以本节为准：

1. 同一材料、同一版本重新生成时，服务端返回的新草稿**整体替换**该材料当前版本的本地条目（沿用已批准的重生成替换策略，不追加、不合并）；
2. 一条本地条目保持 `confirmed` 的条件是四项全部一致：候选身份（`materialId` + 块类型 + `itemId`）、`text`、材料版本、规范化后的来源集合（`materialId` + `materialVersion` + `segmentId` + 行号，排序后比较）。任一项不一致——包括「同文案换来源」——都回到 `pending`，不得把学生没确认过的内容当成已确认发出；
3. 服务端本次没有返回的条目从本地移除；
4. 只有「已确认内容、其来源或发给 AI 的确认集合」发生变化时才 `projectRevision + 1`（使在途旧建议 / 旧聊天响应按 4.7 失效）；普通待确认草稿的刷新**不**递增版本；与现有草稿完全相同的重复写入保持幂等（不写盘、不递增版本）；
5. `source: 'fallback'` 或四类候选全空时：不覆盖学生已确认的条目，也不视为「生成成功」，界面必须按 15.2 的 `notice` 如实说明。

---

## 15. 材料接口

### 15.0 公共约定

| 项 | 约定 |
| --- | --- |
| 路径 | `POST /api/materials`、`POST /api/materials/understanding` |
| 方法 | 只支持 `POST`；其他方法 405，并返回 `Allow: POST` |
| 头 | `Content-Type: application/json`（charset 可选） |
| 公共字段 | 两个接口都使用 `contractVersion`、`requestId`、`projectId`、`projectRevision`，并在响应中回显 |
| 版本字段 | 理解接口（调用模型）额外使用 `promptVersion`、`source`、`fallbackReason`；上传接口不调用模型，因此**不使用**这三个字段（不返回、也不接受） |
| 失败结构 | 完全沿用 4.5：`contractVersion` / `requestId`（取不到时为 `null`）/ `code` / `message` / `retryable` / `retryAfterSeconds` |
| 跨域 | 沿用 7.4 白名单与预检处理 |
| 缓存 | 响应一律 `Cache-Control: no-store`（沿用 7.4） |

### 15.1 POST /api/materials（材料登记与解析）

用途：校验、解码、分段，并把结果**完整返回**给客户端；服务端不保存材料。

请求字段：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `contractVersion` | string | 是 | 固定 `"1.0"` | 契约版本 |
| `requestId` | string | 是 | 可打印，≤ 64 | 响应原样回显 |
| `projectId` | string | 是 | ≤ 64 | 项目 ID |
| `projectRevision` | number | 是 | ≥ 1 整数 | 前端发出请求时的版本 |
| `materialId` | string | 是 | `mat_` 前缀，≤ 64 | 前端生成 |
| `version` | number | 是 | ≥ 1 整数 | 前端维护的材料版本 |
| `name` | string | 是 | 1～200 字，扩展名 `.md` / `.txt` | 原始文件名 |
| `contentBase64` | string | 是 | 标准 base64（不带 data URL 前缀） | 文件原始字节 |

为什么用 base64：GBK 检测必须在**原始字节**上做（浏览器按 UTF-8 读文本会把 GBK 内容写成替换字符，服务端再无法判定编码）；同时保持 JSON 单协议，复用现有 CORS、校验与体积上限结构，不引入 multipart 依赖。

校验顺序（固定，测试与反例按此构造）：

1. 方法 / Content-Type / JSON 可解析；
2. `contractVersion` 必须是 `"1.0"`；`requestId`、`projectId`、`projectRevision`、`materialId`、`version`、`name`、`contentBase64` 的存在性、类型与长度；
3. `name` 扩展名白名单（不区分大小写）：不是 `.md` / `.txt` → `UNSUPPORTED_MATERIAL_TYPE`；
4. `contentBase64` 必须是合法 base64 → 否则 `INVALID_INPUT`；解码后字节数 > 1 MB → `MATERIAL_TOO_LARGE`；
5. 解码顺序：UTF-8（严格）→ GBK（严格）；都失败 → `MATERIAL_ENCODING_UNREADABLE`；
6. 内容特征：解码结果含 NUL（U+0000）→ `UNSUPPORTED_MATERIAL_TYPE`（判为二进制内容）；
7. 解码结果为空或仅空白 → `EMPTY_MATERIAL`；
8. 按 14.4 分段；分段过程异常 → `MATERIAL_PARSE_FAILED`。

成功响应 200：`material`（14.1）+ `segments`（14.2）+ `segmentCount` + 回显字段；示例见 18.2。

> 上传失败不会产生材料记录；前端必须保留用户已填内容并允许重试（与 5.2“证据与建议相互独立”同一原则）。

### 15.2 POST /api/materials/understanding（材料理解草稿）

用途：把**客户端选定**的材料片段发送给服务端，生成四块理解草稿；模型失败时服务端规则兜底（`source: "fallback"`）。

请求字段：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | `"1.0"` |
| `promptVersion` | string | 是 | `"material-understanding-v1"` |
| `requestId` | string | 是 | 可打印，≤ 64，响应回显 |
| `projectId` | string | 是 | ≤ 64 |
| `projectRevision` | number | 是 | ≥ 1 整数 |
| `projectName` | string \| null | 是 | ≤ 120 字；可为 `null` |
| `material` | object | 是 | 见下表 |

`material`：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `materialId` | string | 是 | ≤ 64 |
| `name` | string | 是 | 1～200 字 |
| `type` | `'md' \| 'txt'` | 是 | 必须与 `name` 扩展名一致，否则 `INVALID_INPUT` |
| `version` | number | 是 | ≥ 1 整数 |
| `segments` | SegmentInput[] | 是 | 1～100 条；合计文本 ≤ 24,000 字 |

`SegmentInput`：`segmentId`（1～64）、`startLine` / `endLine`（≥ 1 整数，`endLine ≥ startLine`）、`text`（1～2,000 字）。

**唯一性**：同一份材料的 `segments` 内 `segmentId` 必须唯一；出现重复返回 400 `INVALID_INPUT`（message 中文说明），服务端不依赖"后写覆盖"来容忍重复编号。

> 为什么只发片段、且要限长：控制 token、超时与费用；前端默认从第 1 段开始累计发送直到到达上限（未发送部分留给下一批做片段检索）。超过上限返回 400 `INVALID_INPUT`，message 用中文说明。

响应 200：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `contractVersion` / `requestId` / `projectId` / `projectRevision` | | 回显 |
| `materialId` / `materialVersion` | | 回显 |
| `promptVersion` | string | 与请求一致 |
| `source` | `'model' \| 'fallback'` | 与建议接口同一语义 |
| `fallbackReason` | string \| null | `source: "model"` 时为 `null`；fallback 时为第 16 节的稳定原因码 |
| `notice` | string \| null | 中文说明，≤ 300 字；`source: "model"` 且成功时为 `null` |
| `draft` | MaterialUnderstandingDraft | 见 14.3 |

1. `source: "model"`：`draft` 五块合计至少 1 条候选；
2. `source: "fallback"`：`notice` 必填（中文说明模型未参与、用户可以先做什么）；`draft` 允许四块为空数组；**兜底不得编造材料中不存在的事实**，也不得把猜测写成确定事实；
3. 未配置 / 超时 / 上游故障 / 输出非法**不返回 4xx / 5xx**，而是 200 + `fallback`（与 5.1 的分层一致）；`MODEL_*` 失败码只在兜底本身也失败时才返回（见第 16 节）。

### 15.3 模型输出校验与清理

模型只输出五块候选文本与 `segmentIds` 引用（不输出材料名与行号）：

```json
{
  "goalCandidates": [{ "text": "……", "segmentIds": ["seg_0"] }],
  "outcomeCandidates": [],
  "dataNotes": [],
  "methodNotes": [],
  "openQuestions": [{ "text": "材料中没有出现数据规模说明，需要补充", "segmentIds": ["seg_2"] }]
}
```

处理规则（与 4.6 同一风格：能修就修、不能修就丢）：

| 检查 | 规则 | 不通过时 |
| --- | --- | --- |
| `text` | 非空，trim 后 1～300 字 | 超长截断；为空 → 丢弃该条 |
| `segmentIds` | 数组必须存在；每个 ID 必须在本次请求的 `segments` 中 | 未知 ID 剔除并记日志；剔除后为空 → **丢弃该条**（无来源不可用） |
| 单块数量 | 每块 ≤ 5 条 | 超出部分丢弃并记日志 |
| 五块合计 | ≥ 1 条 | 为 0 → 判非法输出 → 走 fallback |
| 用户可见文本 | 自然中文，且不含内部字段名（沿用 4.3 的检查，词表扩充 `materialId`、`segments`、`draft`、`goalCandidates`、`dataNotes` 等） | 判非法输出 → 走 fallback，不把原始文本返回客户端 |

服务端不做的事：不修改材料正文，不生成行号（行号一律由 `segmentId` 回填），不判断“这条候选对不对”。

### 15.4 上限汇总

| 项 | 值 |
| --- | --- |
| 上传请求体上限 | 2 MB（1 MB 文件的 base64 约 1.37 MB） |
| 理解请求体上限 | 256 KB（沿用 4.0） |
| 单份材料大小 | 1,048,576 字节（1 MB，按解码后字节数） |
| 单段长度 | ≤ 2,000 字 |
| 理解片段数 / 合计 | ≤ 100 条 / ≤ 24,000 字 |
| 模型调用超时 | 20 秒，安全网 25 秒（沿用 7.5） |
| 重试 | 适配层最多自动重试 1 次，仅 `retryable: true`（沿用 4.0） |

### 15.5 兼容性

1. 未知字段一律忽略（8.4）；`projectName` 必须存在但可为 `null`；
2. 两个接口不改变 `/health`、建议、聊天接口的既有行为；
3. 旧前端（不带材料功能）不调用这两个接口、不带新字段，行为与 v1.3 完全一致。

---

## 16. 材料与理解相关错误码

新增码（建议与聊天接口继续使用第 6 节的码；`retryable` 语义与 6.1 相同）：

| code | HTTP | retryable | 触发条件 | 对外中文 message |
| --- | --- | --- | --- | --- |
| `INVALID_INPUT` | 400 | false | 请求非法：缺字段、类型 / 长度 / 数量超限、Content-Type 错误、`contractVersion` / `promptVersion` 不支持、base64 非法 | `请求内容不合法：<第一条具体问题>` |
| `UNSUPPORTED_MATERIAL_TYPE` | 400 | false | 扩展名不是 `.md` / `.txt`，或内容特征判为二进制（含 NUL） | `当前只支持 md、txt 文件；CSV、XLSX 将在下一批支持，PDF、DOCX、ZIP 将在后续版本支持` |
| `MATERIAL_TOO_LARGE` | 400 | false | 解码后字节数超过 1 MB | `文件超过 1 MB 上限，请压缩或拆分后再上传` |
| `EMPTY_MATERIAL` | 400 | false | 解码后内容为空或仅空白 | `文件内容为空，请检查后再上传` |
| `MATERIAL_ENCODING_UNREADABLE` | 400 | false | UTF-8 与 GBK 均无法解码 | `文件编码无法识别（已尝试 UTF-8 与 GBK），请另存为 UTF-8 后重试` |
| `MATERIAL_PARSE_FAILED` | 400 | false | 校验通过但分段失败 | `材料解析失败，请检查文件内容后重试` |
| `MODEL_TIMEOUT` | 504 | true | provider 超时，且服务端兜底也失败（正常不返回） | `模型调用超时，材料已保留，请稍后重试` |
| `INVALID_MODEL_OUTPUT` | 502 | true | 模型输出非法，且服务端兜底也失败（正常不返回） | `模型返回内容不合法，请稍后重试` |
| `MODEL_UNAVAILABLE` | 503 | true | 上游故障，且服务端兜底也失败（正常不返回） | `模型服务暂不可用，请稍后重试` |
| `MODEL_NOT_CONFIGURED` | 503 | false | 未配置 URL / Key / 模型名，且服务端兜底也失败（正常不返回） | `服务端未配置模型密钥，暂时无法生成理解草稿` |

约定：

1. 所有拒绝类错误都返回 4.5 的失败结构，`requestId` 取不到时为 `null`；
2. `message` 只描述问题与用户能做什么：不含密钥、路径、堆栈、上游原文，不回显材料正文（最多回显材料名）；
3. 上传 / 理解失败不影响用户已有项目数据与已保存材料；前端必须保留用户已填内容并允许重试。

---

## 17. 建议与聊天的材料上下文（M2-A 最小接入）

### 17.1 请求字段

`POST /api/advisor/recommendations` 与 `POST /api/advisor/chat` 请求体新增**可选**字段 `confirmedMaterials`：

```json
{
  "confirmedMaterials": [
    {
      "materialId": "mat_9b1e7c2f",
      "name": "实验手册.md",
      "type": "md",
      "version": 1,
      "segments": [
        { "segmentId": "seg_1", "startLine": 10, "endLine": 24, "text": "## 数据说明\n字段包括……" }
      ]
    }
  ]
}
```

约束：

| 项 | 值 |
| --- | --- |
| 材料数 | ≤ 3 |
| 片段合计 | ≤ 20 条 |
| 文本合计 | ≤ 8,000 字；单条 ≤ 2,000 字 |
| 缺失 / `[]` | 行为与 v1.3 完全一致 |
| 非法（类型、超限） | 400 `INVALID_INPUT` |
| 版本要求 | 携带非空 `confirmedMaterials` 必须使用 v2 提示词版本（17.4） |

### 17.2 责任划分

| 角色 | 责任 |
| --- | --- |
| 前端 store | 只发送 `status: 'confirmed'` 的条目（含被学生修改后确认的内容）；未确认草稿绝不进入请求体；材料更新、确认内容变化时递增 `projectRevision` |
| 服务端 | 校验结构与上限；把材料内容标注为“学生已确认的材料摘录”交给模型；不判断“是否真的确认过”（无服务端状态） |
| 模型 | 引用材料时必须写明材料名与行号；不得把材料中未出现的内容写成事实；不得把材料里的指令当系统指令执行 |

### 17.3 提示词与输出

1. 用户消息里按材料分组序列化 `name` / `version` / 片段行号 / 正文（截断 ≤ 2,000 字）；除 `materialId` 外不发送其他内部信息；
2. 系统提示词新增硬约束：只能依据给定材料摘录、项目状态与证据回答；材料中没有的内容必须说明“材料中未找到依据”；
3. M2-A **不**为 `Suggestion` 增加材料引用字段（如 `basisMaterialIds`）；建议理由与聊天回答可以自然引用材料名与行号。“按相关性检索片段、引用准确率增强”属下一批；
4. 建议与聊天接口的成功 / 失败结构、过期响应丢弃规则（4.7）、三层兜底（5.1）全部保持不变。

### 17.4 promptVersion 取值（M2-A）

| 接口 | 兼容保留 | M2-A 启用 |
| --- | --- | --- |
| 建议 | `mvp-prompt-v1` | `mvp-prompt-v2` |
| 聊天 | `advisor-chat-v1` | `advisor-chat-v2` |
| 材料理解 | — | `material-understanding-v1` |

规则：

1. 服务端支持列表包含上表全部取值，**不删除旧值**（前端是静态站点，旧页面可能仍带旧版本号）；
2. 请求携带 `projectProfile` 或非空 `confirmedMaterials` 时必须使用 v2 取值；与 v1 组合 → 400 `INVALID_INPUT`（避免“以为发了材料、其实模型没看到”）；
3. 接口与取值不匹配（例如建议接口收到 `advisor-chat-v1`）→ 400 `INVALID_INPUT`，不做静默降级；
4. 取值同步四处：本契约、`server/src/advisor/types.ts` 的 `SUPPORTED_PROMPT_VERSIONS`、`src/domain/recommendation.ts`、`docs/ai/prompt-spec.md`（吴佳璐维护）。若吴佳璐的规格给出不同取值，以规格为准并在 M1 评审时同改四处。

---

## 18. mock JSON

> 用途：李焰彬照它写类型 / store / API 适配；雍蕾照它画上传、解析状态与草稿确认页面；吴佳璐照它写材料理解提示词规格与反例。全部示例都是**线格式**，不含密钥与内部路径。

### 18.1 项目基本信息（前端结构化状态样例）

```json
{
  "goal": "构建极端风浪事件识别与预警的原型系统，为海上作业安全提供参考",
  "expectedOutcome": "可交互原型 + 正文不超过 4 页的会议论文",
  "memberNames": ["张同学", "李同学", "王同学"],
  "researchPeriod": "第 3 周至第 14 周",
  "scope": "先做西北太平洋，暂不覆盖全球海域",
  "outOfScope": "不做实时业务系统，不做移动端"
}
```

### 18.2 POST /api/materials：请求与成功响应

请求：

```json
{
  "contractVersion": "1.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 12,
  "materialId": "mat_9b1e7c2f",
  "version": 1,
  "name": "实验手册.md",
  "contentBase64": "IyDlrp7pqozmiYvlhowK"
}
```

成功响应（`encoding: "utf-8"` 的示例；GBK 文件同样结构，`encoding` 为 `"gbk"`）：

```json
{
  "contractVersion": "1.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 12,
  "material": {
    "materialId": "mat_9b1e7c2f",
    "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
    "name": "实验手册.md",
    "type": "md",
    "size": 20480,
    "encoding": "utf-8",
    "state": "parsed",
    "version": 1,
    "createdAt": "2026-10-12T10:12:00+08:00",
    "updatedAt": "2026-10-12T10:12:00+08:00",
    "failureReason": null
  },
  "segmentCount": 3,
  "segments": [
    {
      "segmentId": "seg_0",
      "index": 0,
      "startLine": 1,
      "endLine": 8,
      "text": "# 实验手册\n本实验使用 ERA5 海浪场数据，任务是复现极端风浪事件的识别流程。"
    },
    {
      "segmentId": "seg_1",
      "index": 1,
      "startLine": 10,
      "endLine": 24,
      "text": "## 数据说明\n主要字段：有效波高、风速、时间、经纬度；单次样例约 20 万行。"
    },
    {
      "segmentId": "seg_2",
      "index": 2,
      "startLine": 26,
      "endLine": 30,
      "text": "## 交付要求\n提交一页方法说明和可复现的实验记录。"
    }
  ]
}
```

### 18.3 POST /api/materials/understanding：请求与 model 响应

请求：

```json
{
  "contractVersion": "1.0",
  "promptVersion": "material-understanding-v1",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 13,
  "projectName": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
  "material": {
    "materialId": "mat_9b1e7c2f",
    "name": "实验手册.md",
    "type": "md",
    "version": 1,
    "segments": [
      {
        "segmentId": "seg_0",
        "startLine": 1,
        "endLine": 8,
        "text": "# 实验手册\n本实验使用 ERA5 海浪场数据，任务是复现极端风浪事件的识别流程。"
      },
      {
        "segmentId": "seg_1",
        "startLine": 10,
        "endLine": 24,
        "text": "## 数据说明\n主要字段：有效波高、风速、时间、经纬度；单次样例约 20 万行。"
      },
      {
        "segmentId": "seg_2",
        "startLine": 26,
        "endLine": 30,
        "text": "## 交付要求\n提交一页方法说明和可复现的实验记录。"
      }
    ]
  }
}
```

model 响应：

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 13,
  "materialId": "mat_9b1e7c2f",
  "materialVersion": 1,
  "promptVersion": "material-understanding-v1",
  "source": "model",
  "fallbackReason": null,
  "notice": null,
  "draft": {
    "goalCandidates": [
      {
        "itemId": "cnd_goal_0",
        "text": "使用 ERA5 海浪场数据复现极端风浪事件的识别流程",
        "sources": [
          {
            "materialId": "mat_9b1e7c2f",
            "materialName": "实验手册.md",
            "materialVersion": 1,
            "segmentId": "seg_0",
            "startLine": 1,
            "endLine": 8
          }
        ]
      }
    ],
    "outcomeCandidates": [
      {
        "itemId": "cnd_outcome_0",
        "text": "提交一页方法说明和可复现的实验记录",
        "sources": [
          {
            "materialId": "mat_9b1e7c2f",
            "materialName": "实验手册.md",
            "materialVersion": 1,
            "segmentId": "seg_2",
            "startLine": 26,
            "endLine": 30
          }
        ]
      }
    ],
    "dataNotes": [
      {
        "itemId": "cnd_data_0",
        "text": "数据包含有效波高、风速、时间与经纬度字段，单次样例约 20 万行",
        "sources": [
          {
            "materialId": "mat_9b1e7c2f",
            "materialName": "实验手册.md",
            "materialVersion": 1,
            "segmentId": "seg_1",
            "startLine": 10,
            "endLine": 24
          }
        ]
      }
    ],
    "methodNotes": [],
    "openQuestions": [
      {
        "itemId": "cnd_question_0",
        "text": "材料中没有给出数据时间范围与统计口径，需要补充确认",
        "sources": [
          {
            "materialId": "mat_9b1e7c2f",
            "materialName": "实验手册.md",
            "materialVersion": 1,
            "segmentId": "seg_1",
            "startLine": 10,
            "endLine": 24
          }
        ]
      }
    ]
  }
}
```

### 18.4 POST /api/materials/understanding：fallback 响应

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 13,
  "materialId": "mat_9b1e7c2f",
  "materialVersion": 1,
  "promptVersion": "material-understanding-v1",
  "source": "fallback",
  "fallbackReason": "MODEL_TIMEOUT",
  "notice": "模型调用超时，未生成理解草稿；材料已解析成功，可以先手动登记要点，稍后重新生成。",
  "draft": {
    "goalCandidates": [],
    "outcomeCandidates": [],
    "dataNotes": [],
    "methodNotes": [],
    "openQuestions": []
  }
}
```

### 18.5 建议接口 v2 请求片段（`projectProfile` + `confirmedMaterials`）

```json
{
  "contractVersion": "1.0",
  "promptVersion": "mvp-prompt-v2",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": "prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031",
  "projectRevision": 14,
  "projectName": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
  "currentMilestone": "数据获取与预处理",
  "projectProfile": {
    "goal": "构建极端风浪事件识别与预警的原型系统，为海上作业安全提供参考",
    "expectedOutcome": "可交互原型 + 正文不超过 4 页的会议论文",
    "memberNames": ["张同学", "李同学", "王同学"],
    "researchPeriod": "第 3 周至第 14 周",
    "scope": "先做西北太平洋，暂不覆盖全球海域",
    "outOfScope": "不做实时业务系统，不做移动端"
  },
  "confirmedContext": [],
  "confirmedMaterials": [
    {
      "materialId": "mat_9b1e7c2f",
      "name": "实验手册.md",
      "type": "md",
      "version": 1,
      "segments": [
        {
          "segmentId": "seg_1",
          "startLine": 10,
          "endLine": 24,
          "text": "## 数据说明\n主要字段：有效波高、风速、时间、经纬度；单次样例约 20 万行。"
        }
      ]
    }
  ],
  "tasks": [],
  "evidence": [],
  "doubts": [],
  "forceRefresh": false
}
```

### 18.6 错误响应示例

```json
{
  "contractVersion": "1.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "code": "UNSUPPORTED_MATERIAL_TYPE",
  "message": "当前只支持 md、txt 文件；CSV、XLSX 将在下一批支持，PDF、DOCX、ZIP 将在后续版本支持",
  "retryable": false,
  "retryAfterSeconds": null
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "code": "MATERIAL_TOO_LARGE",
  "message": "文件超过 1 MB 上限，请压缩或拆分后再上传",
  "retryable": false,
  "retryAfterSeconds": null
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "code": "EMPTY_MATERIAL",
  "message": "文件内容为空，请检查后再上传",
  "retryable": false,
  "retryAfterSeconds": null
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "code": "MATERIAL_ENCODING_UNREADABLE",
  "message": "文件编码无法识别（已尝试 UTF-8 与 GBK），请另存为 UTF-8 后重试",
  "retryable": false,
  "retryAfterSeconds": null
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": null,
  "code": "INVALID_INPUT",
  "message": "请求内容不合法：contentBase64 不是合法的 base64",
  "retryable": false,
  "retryAfterSeconds": null
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "code": "MODEL_NOT_CONFIGURED",
  "message": "服务端未配置模型密钥，暂时无法生成理解草稿",
  "retryable": false,
  "retryAfterSeconds": null
}
```

前端应对每个 code 映射中文提示（沿用 `src/domain/recommendation.ts` 的 `describeAdvisorFailure()` 思路扩充）。

## 20. V3/V4 契约冻结总则

> 本节是 V3/V4 的入口。实体字段、状态机、删除/归档规则和未来扩展位以 `docs/architecture/v3-v4-domain-model.md` 为准；本节只定义线格式、错误行为和兼容边界。

### 20.1 两个版本面

| 版本面 | `contractVersion` | 接口 | 本次处理 |
| --- | --- | --- | --- |
| V2 稳定面 | `"1.0"` | 建议、聊天、材料上传、材料理解 | **不改字段、不改行为**；AI 阶段上下文只做向后兼容的可选扩展 |
| V3 新面 | `"3.0"` | 账号、项目、阶段、任务、证据、进展、时间线、材料草稿确认、阶段候选、本地迁移 | 本次冻结，后续 PR 实现 |

规则：

1. V3 接口收到非 `"3.0"` 的 `contractVersion` 返回 400 `CONTRACT_VERSION_MISMATCH`，不做静默降级；
2. V2 接口继续只接受 `"1.0"`；携带其他版本返回 400 `CONTRACT_VERSION_MISMATCH`；V3 前端调用 V2 接口时仍带 `"1.0"`；
3. 同一请求不得混用两套信封字段；
4. 未知字段按 8.4 忽略；缺少必填字段返回 400 `INVALID_INPUT`。

#### 20.1.1 接口与版本组合（必须成对使用）

| 接口 | `contractVersion` | `promptVersion` | `milestoneContext` |
| --- | --- | --- | --- |
| `POST /api/advisor/recommendations`（v1/v2） | `"1.0"` | `mvp-prompt-v1` / `mvp-prompt-v2` | 必须不出现 |
| `POST /api/advisor/recommendations`（v3） | `"1.0"` | `mvp-prompt-v3` | 必须出现 |
| `POST /api/advisor/chat`（v1/v2） | `"1.0"` | `advisor-chat-v1` / `advisor-chat-v2` | 必须不出现 |
| `POST /api/advisor/chat`（v3） | `"1.0"` | `advisor-chat-v3` | 必须出现 |
| `POST /api/materials` | `"1.0"` | 不适用 | 不适用 |
| `POST /api/materials/understanding` | `"1.0"` | `material-understanding-v1` | 不适用 |
| `POST /api/projects/{projectId}/milestones/candidates` | `"3.0"` | `milestone-candidate-v1` | 不适用 |
| 账号、项目、阶段、任务、进展、证据、时间线、材料草稿确认、迁移 | `"3.0"` | 不适用 | 不适用 |

组合规则：

1. V2 的四个 AI/材料接口**只接受** `contractVersion: "1.0"`；携带 `"3.0"` 返回 400 `CONTRACT_VERSION_MISMATCH`，不得为了“兼容”而接受；
2. V3 新接口**只接受** `contractVersion: "3.0"`；携带 `"1.0"` 返回 400 `CONTRACT_VERSION_MISMATCH`；
3. 建议/聊天使用 `mvp-prompt-v3` / `advisor-chat-v3` 时，`contractVersion` 仍是 `"1.0"`（这是 V2 接口的向后兼容扩展），但 `milestoneContext` 必填；缺少返回 400 `CONTRACT_VERSION_MISMATCH`；
4. 建议/聊天使用 v1/v2 提示词时，`milestoneContext` 必须不出现；出现即返回 400 `CONTRACT_VERSION_MISMATCH`，**不得静默忽略**；
5. 未知 `promptVersion` 返回 400 `INVALID_INPUT`，不做静默降级；
6. 材料接口不接受 `milestoneContext`；阶段候选接口不接受建议/聊天提示词版本；
7. **禁止前端静默降级**：收到版本组合 400 后，前端不得自动改用低版本 `contractVersion`、不得丢弃 `milestoneContext` 重发 v2、不得把 v3 请求降级为 v1/v2；只能显示中文提示、记录 `requestId`，由用户刷新页面或升级应用后重试；
8. 版本组合错误不重试、不切换本地规则；它不是网络失败，不得触发 `local-rule`。

### 20.2 通用写请求信封

除注册、登录、退出、创建项目、本地迁移外，所有 V3 写接口都使用以下信封。创建项目与迁移的目标项目尚不存在，因此不带 `projectId` / `projectRevision`，但 `contractVersion`、`requestId`、`idempotencyKey` 仍必填：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "idempotencyKey": "ms-create-01JBC9R7T3K8QW4M2N6P5X0ZYC",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 12
}
```

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `contractVersion` | string | 是 | 固定 `"3.0"` | 契约版本 |
| `requestId` | string | 是 | UUID v4，36 字符 | 响应原样回显 |
| `idempotencyKey` | string | 是 | 8～64 个可打印 ASCII | 幂等键；同一用户内唯一 |
| `projectId` | string | 是 | `prj_` 前缀，≤ 64 | 必须与路径参数一致 |
| `projectRevision` | number | 是 | ≥ 1 的整数 | 客户端已知的项目版本 |
| `expectedRevision` | number | 条件必填 | ≥ 1 的整数 | 更新/完成/归档单个实体时必填 |
| `expectedTaskRevision` | number | 条件必填 | ≥ 1 的整数 | 证据提交同时完成任务时必填 |

补充：

- 创建类操作不需要 `expectedRevision`；排序操作只校验 `projectRevision`；
- `projectId` 只允许出现在路径和顶层信封，子实体不重复携带；
- 客户端不得在请求体里传 `userId`、`ownerUserId`、`createdAt`、`updatedAt` 或服务端生成的 ID。

### 20.3 通用成功响应

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 13,
  "replayed": false,
  "data": {
    "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
    "revision": 1
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `contractVersion` | string | `"3.0"` |
| `requestId` | string | 与请求一致 |
| `projectId` | string | 与请求一致 |
| `projectRevision` | number | 本次写入后的项目版本；幂等重放时为首次响应中的版本 |
| `replayed` | boolean | `true` 表示命中幂等键，未重复写入 |
| `data` | object | 各接口定义的实体或结果 |

成功统一返回 HTTP 200（包括创建），不使用 201/204，避免幂等重放时状态码不一致。

### 20.4 通用失败响应

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "code": "STALE_REVISION",
  "message": "项目内容已更新，请刷新后重试",
  "retryable": false,
  "retryAfterSeconds": null,
  "currentProjectRevision": 14,
  "currentEntityRevision": 5,
  "details": null
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | `"3.0"` |
| `requestId` | string \| null | 是 | 请求体可解析时回显，否则 `null` |
| `projectId` | string \| null | 是 | 可确定项目时回显，否则 `null` |
| `code` | string | 是 | 第 25 节错误码 |
| `message` | string | 是 | 中文，可展示给用户；不含路径、密钥、SQL、堆栈、模型原文 |
| `retryable` | boolean | 是 | 见 25.2 |
| `retryAfterSeconds` | number \| null | 是 | 仅 `RATE_LIMITED` 给整数 |
| `currentProjectRevision` | number \| null | 是 | `STALE_REVISION` / `PROJECT_MISMATCH` 时给当前值 |
| `currentEntityRevision` | number \| null | 是 | 实体版本冲突时给当前值 |
| `details` | object \| null | 是 | 只允许字段名、数量、类别；不得含用户正文、路径、密钥、模型原文 |

### 20.5 写操作字段矩阵

| 操作 | `idempotencyKey` | `projectRevision` | `expectedRevision` | 其他必要字段 |
| --- | --- | --- | --- | --- |
| 创建项目 | 必填 | 不需要 | 不需要 | `name`、`short`、`profile` |
| 编辑项目 | 必填 | 必填 | 不需要 | `name`/`short`/`profile` |
| 创建阶段 | 必填 | 必填 | 不需要 | `name`、`goal`、`doneCriteria`、`dueAt` |
| 编辑阶段 | 必填 | 必填 | 必填 | 至少一个可编辑字段 |
| 阶段排序 | 必填 | 必填 | 不需要 | `order` 全量有序 ID |
| 完成/重开/归档/恢复阶段 | 必填 | 必填 | 必填 | — |
| 创建任务 | 必填 | 必填 | 不需要 | `title`、`milestoneId` |
| 编辑/移动/开始/完成/重开/归档/恢复任务 | 必填 | 必填 | 必填 | 目标状态或字段 |
| 提交进展 | 必填 | 必填 | 不需要 | `summary`、`milestoneId`、`taskId` |
| 提交证据 | 必填 | 必填 | `expectedTaskRevision`（完成时） | `didWhat`、`taskId`、`milestoneId` |
| 证据关联 | 必填 | 必填 | 必填 | `taskId`、`milestoneId` |
| 材料草稿确认/编辑/移除/撤销 | 必填 | 必填 | 必填 | `materialVersion`、`itemId` |
| 材料草稿整份确认 | 必填 | 必填 | 逐条 `expectedRevision` | `materialVersion`、`items` 全量 |
| 阶段候选生成 | 必填 | 必填 | 不需要 | `promptVersion`、可选的已确认材料 |
| 本地迁移 | 必填 | 不需要 | 不需要 | `migrationId`、`userConfirmed`、`localProject` |

### 20.6 幂等、并发与过期

1. 幂等键作用域 `(userId, idempotencyKey)`，保留 24 小时；请求指纹必须绑定规范化 HTTP 方法、服务端操作类别、资源目标（如 `projectId` / `projectId/entityId`）和有效请求体；同一键 + 完全相同的操作/资源/请求体返回首次响应并置 `replayed: true`，不递增版本；
2. 同一键被用于不同操作、不同资源或不同请求体返回 409 `IDEMPOTENCY_CONFLICT`，不写入任何数据；密码、邀请码等敏感字段不进入快速哈希指纹，由业务层用 bcrypt/常量时间比较单独验证；
3. 幂等查询先于版本校验；重放响应可能带旧版本号，客户端必须按 20.7 丢弃；
4. `projectRevision` 不匹配返回 409 `STALE_REVISION`，响应带 `currentProjectRevision`，不执行部分写入；
5. `expectedRevision` 不匹配返回 409 `STALE_REVISION`，响应带 `currentEntityRevision`；
6. 服务端在事务内重新读取当前版本并加锁；并发写只有一个成功；
7. 客户端收到 `STALE_REVISION` 后刷新项目，提示“内容已更新，请确认后重试”，不得自动重放破坏性写操作；
8. 旧响应按 `requestId + projectId + projectRevision + 实体 revision` 丢弃；切换项目时取消在途请求。

### 20.7 项目切换与响应丢弃

收到响应后依次校验，任一不通过整份丢弃：

| 顺序 | 条件 | 处理 |
| --- | --- | --- |
| 1 | `response.projectId !== activeProjectId` | 丢弃 |
| 2 | `response.projectRevision < activeProjectRevision` | 丢弃 |
| 3 | 实体 revision 小于本地同实体 revision | 丢弃该实体 |
| 4 | 请求发出后已切换项目、退出登录或进入其他页面 | 丢弃 |
| 5 | 响应 `requestId` 与本次请求不一致 | 丢弃并记录日志 |

切换项目必须清理旧项目的 loading 状态；旧请求只能静默结束，不能把新项目置为永久 loading。

### 20.8 权限、Cookie 与 CORS 前置

1. 除 `GET /health`、`POST /api/auth/register`、`POST /api/auth/login` 外，所有 V3 接口必须带有效会话 Cookie；
2. 浏览器请求必须使用 `credentials: "include"`；
3. CORS 只允许明确白名单来源，返回 `Access-Control-Allow-Credentials: true`，禁止 `*`；
4. 写请求必须校验 `Origin`；缺失或不在白名单返回 403 `FORBIDDEN_ORIGIN`；
5. 响应一律 `Cache-Control: no-store`；
6. 服务端只从会话读取 `userId`，忽略请求体或查询参数中的用户标识。

---

## 21. 账号契约

### 21.1 账号、密码与邀请码规则

| 项 | 规则 |
| --- | --- |
| 账号 | 用户名或学号；3～32 字符；允许 `[A-Za-z0-9_]`，或 6～20 位纯数字；大小写不敏感 |
| 昵称 | 1～30 字，去除首尾空白后非空；允许中文 |
| 密码 | 8～64 个字符；按 UTF-8 字节数 ≤ 72（兼容 bcrypt）；不去除首尾空格 |
| 密码哈希 | 当前实现为 **bcrypt（cost 12）**，使用纯 JS 的 `bcryptjs`，不引入原生依赖。Argon2id 仅作为可选升级：若采用需满足 memory ≥ 64 MiB、iterations ≥ 3、parallelism ≥ 1，并同时提供已存哈希的迁移路径；未迁移前不得混用两种算法 |
| 邀请码 | 8～64 个可打印字符；只保存哈希；常量时间比较；不写日志 |
| 注册凭据 | 账号 + 密码 + 昵称 + 邀请码，四者缺一不可 |
| 登录标识 | 账号 + 密码 |
| 会话 | 服务端会话，不签发可被前端读取的 token |

密码规则：

1. 密码只以哈希形式保存，响应、日志、错误信息、审计记录中**永远不出现**密码或哈希；
2. 登录时如果哈希参数低于当前标准，在验证成功后透明重算并更新；
3. 不支持邮箱、短信、社交登录、密码找回、邮箱验证；
4. 账号不存在与密码错误使用同一错误码 `AUTH_FAILED`、同一文案、相近耗时；内部可记录不同原因，但日志不含密码。

### 21.2 会话 Cookie

| 项 | 约定 |
| --- | --- |
| Cookie 名 | `scp_session` |
| 值 | 256 位随机令牌的 base64url，43 字符；服务端只保存 SHA-256 哈希 |
| `HttpOnly` | 必须 |
| `Secure` | 生产环境必须；仅本地 `http://localhost` 开发可省略 |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Domain` | 不设置（host-only） |
| `Max-Age` | 604800 秒（7 天） |
| 续期 | 绝对过期，不滑动；`GET /api/auth/me` 返回 `sessionExpiresAt` |
| 登录 | 成功时轮换会话 ID，旧会话立即失效 |
| 退出 | 服务端撤销会话并清除 Cookie |
| 过期 | 返回 401 `UNAUTHORIZED`，前端清理内存态并跳转登录；不得清理 `localStorage` 旧项目 |
| 存储位置 | **禁止**把会话令牌放进 `localStorage`、`sessionStorage`、IndexedDB 或 URL |
| CSRF | `SameSite=Lax` + 写请求 `Origin` 白名单校验；不额外下发 CSRF token |
| 响应体 | 不返回 Cookie 值、token 或哈希 |

#### 21.2.1 服务端 Session 记录

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | `ses_` 前缀，服务端生成 |
| `userId` | string | 所属用户 |
| `tokenHash` | string | 会话令牌的 SHA-256 哈希；**不保存明文令牌** |
| `status` | `active` \| `expired` \| `revoked` | 会话状态 |
| `createdAt` | string | 创建时间 |
| `lastSeenAt` | string | 最近校验时间 |
| `expiresAt` | string | 绝对过期时间（创建后 7 天） |
| `revokedAt` | string \| null | 撤销时间 |
| `rotatedFromSessionId` | string \| null | 登录轮换前旧会话 ID |

规则：

- 登录成功创建新 Session 并撤销旧 Session；退出撤销当前 Session；
- `expiresAt` 到期即 `expired`；用户禁用时全部 Session 置 `revoked`；
- Session 不参与项目 `projectRevision`；过期/撤销记录的目标保留期为 30 天。**当前代码没有自动清理任务**，记录会一直保留；30 天保留期由部署侧定时任务执行，未实现前不得在文档或界面上宣称已按 30 天清理。

#### 21.2.2 前端请求约定

所有需要登录的请求必须显式携带 Cookie：

```ts
await fetch(`${API_BASE}/api/projects`, {
  method: 'GET',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
})
```

约定：

1. 统一使用 `credentials: "include"`；不得依赖浏览器默认值；
2. 不设置 `Authorization` 头，不把 token 放进请求体、URL、`localStorage`、`sessionStorage` 或 IndexedDB；
3. 不手工读写 `document.cookie`；Cookie 由浏览器与服务端管理；
4. 收到 401 `UNAUTHORIZED`：清理**内存中的用户态**，跳转登录页；保留 `localStorage` 旧项目和用户已输入内容；服务端可同时下发 `Set-Cookie: scp_session=; Max-Age=0`，但前端必须以 401 状态码为准，不能依赖 Cookie 是否被清除；
5. 收到 403 `FORBIDDEN_ORIGIN`：不重试，提示“请求来源不受信任”，记录 `requestId`；
6. 网络失败与 401 分开处理：网络失败不能当作“未登录”，不能清空项目状态。

#### 21.2.3 CORS、Origin 与 CSRF

| 项 | 约定 |
| --- | --- |
| 允许来源 | 生产 `https://course.xinxian-music.xyz`；本地开发 `http://localhost:5173`、`http://127.0.0.1:5173`；其他来源拒绝 |
| `Access-Control-Allow-Origin` | 回显精确来源，禁止 `*` |
| `Access-Control-Allow-Credentials` | `true` |
| `Vary` | `Origin` |
| 预检 | `OPTIONS` 返回 204；允许 `GET, POST, PATCH, DELETE, OPTIONS` 与 `Content-Type, X-Request-Id` |
| 写请求 Origin | 必须存在且在允许列表内；缺失或非法返回 403 `FORBIDDEN_ORIGIN` |
| CSRF 防护 | `SameSite=Lax` + 精确 Origin 校验 + `Content-Type: application/json`；不提供 GET 写操作；不把令牌放 URL |
| 额外校验 | 若浏览器提供 `Sec-Fetch-Site`，只接受 `same-origin` / `same-site`；`cross-site` 一律 403 |
| CSRF token | 本阶段不额外下发；若未来需要跨站嵌入，再评审 double-submit token |
| 缓存 | 所有认证与业务响应 `Cache-Control: no-store` |

说明：`SameSite=Lax` 阻止大多数跨站表单提交；JSON 请求会触发预检；服务端仍必须校验 `Origin`，不能只依赖 Cookie。

### 21.3 POST /api/auth/register

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "idempotencyKey": "register-01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "account": "2023123456",
  "password": "correct-horse-battery-staple",
  "displayName": "张同学",
  "inviteCode": "INVITE-2026-ABCD"
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | `"3.0"` |
| `requestId` | string | 是 | UUID v4 |
| `idempotencyKey` | string | 是 | 8～64 个可打印字符 |
| `account` | string | 是 | 见 21.1 |
| `password` | string | 是 | 见 21.1 |
| `displayName` | string | 是 | 1～30 字 |
| `inviteCode` | string | 是 | 8～64 个字符 |

成功响应（HTTP 200，并 `Set-Cookie: scp_session=...`）：

```json
{
  "contractVersion": "3.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "user": {
    "userId": "usr_01JBC9R7T3K8QW4M2N6P5X0ZYE",
    "account": "2023123456",
    "displayName": "张同学",
    "status": "active",
    "revision": 1,
    "createdAt": "2026-10-19T02:30:00.000Z",
    "updatedAt": "2026-10-19T02:30:00.000Z"
  },
  "sessionExpiresAt": "2026-10-26T02:30:00.000Z",
  "replayed": false
}
```

首次注册响应丢失后的恢复响应额外包含 `"replayed": true`、`"recovered": true`；首次响应为 `"replayed": false`。

重复注册与邀请码错误：

- 统一返回 409 `REGISTER_REJECTED`，文案固定为“注册未完成，请检查用户名、密码和邀请码”；
- 不区分“账号已存在”“邀请码错误”“账号被禁用”；
- 不覆盖已有账号，不返回已有用户信息；
- **响应丢失恢复**：重复使用同一 `idempotencyKey` + 相同非敏感请求内容（账号、昵称）时，服务端必须重新校验密码（bcrypt）和邀请码；验证通过返回 200 + 新 `Set-Cookie`，并标记 `replayed: true`、`recovered: true`；密码或邀请码不匹配仍返回 409 `REGISTER_REJECTED`，不得仅凭 `account + idempotencyKey` 签发会话；
- 同一 `idempotencyKey` 但昵称等非敏感内容不同：409 `IDEMPOTENCY_CONFLICT`；
- 使用新 `idempotencyKey` 重复注册：409 `REGISTER_REJECTED`。

### 21.4 POST /api/auth/login

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "account": "2023123456",
  "password": "correct-horse-battery-staple"
}
```

成功响应与注册相同（HTTP 200，设置新 Cookie，轮换会话）。

失败：

- 账号不存在、密码错误、账号禁用统一 401 `AUTH_FAILED`，文案“用户名或密码不正确”；
- 不返回“账号不存在”“密码错误”“剩余尝试次数”等可枚举信息；
- 按 IP + 账号限流，超限 429 `RATE_LIMITED`，`retryAfterSeconds` 为正整数；
- **限流预算必须在 bcrypt 之前预占**：并发请求共享同一窗口计数，不能全部进入密码比较；默认账号 5 次 / IP 50 次每 15 分钟，超限请求直接 429；成功登录只清账号预算，不清 IP 预算；
- 客户端地址默认取 TCP socket 地址，**不信任任意 `X-Forwarded-For`**；只有显式配置 `SCP_TRUST_PROXY_HOPS=N`（表示前面有 N 层可信反代）时，才从 XFF 右侧取第 N 个合法 IP；
- 登录请求不要求 `idempotencyKey`；每次成功登录都生成新会话；旧会话撤销与新会话创建必须在同一事务，失败时整体回滚。

### 21.5 POST /api/auth/logout

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90"
}
```

成功响应：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "loggedOut": true
}
```

规则：

- 无论 Cookie 是否存在、是否已过期，都返回 200 并清除 Cookie；
- 服务端撤销当前会话；重复退出幂等；
- 退出不删除项目、材料、证据或聊天；
- 退出不清理浏览器本地旧项目数据；前端清理云端内存态即可。

### 21.6 GET /api/auth/me

请求：无请求体，依赖 Cookie。

成功响应：

```json
{
  "contractVersion": "3.0",
  "requestId": null,
  "user": {
    "userId": "usr_01JBC9R7T3K8QW4M2N6P5X0ZYE",
    "account": "2023123456",
    "displayName": "张同学",
    "status": "active",
    "revision": 1,
    "createdAt": "2026-10-19T02:30:00.000Z",
    "updatedAt": "2026-10-19T02:30:00.000Z"
  },
  "sessionExpiresAt": "2026-10-26T02:30:00.000Z"
}
```

未登录或会话过期：401 `UNAUTHORIZED`，文案“登录状态已失效，请重新登录”。前端只能依据 HTTP 状态判断，不能靠响应体里的用户字段判断。

### 21.7 账号错误行为总表

| 场景 | HTTP | code | 中文 message | 前端行为 |
| --- | --- | --- | --- | --- |
| 字段格式错误 | 400 | `INVALID_INPUT` | 请求内容不合法：<字段说明> | 高亮字段 |
| 重复注册 / 邀请码错误 | 409 | `REGISTER_REJECTED` | 注册未完成，请检查用户名、密码和邀请码 | 停留在注册页 |
| 账号或密码错误 | 401 | `AUTH_FAILED` | 用户名或密码不正确 | 不提示账号是否存在 |
| 未登录 / 会话过期 | 401 | `UNAUTHORIZED` | 登录状态已失效，请重新登录 | 清理内存态，跳登录 |
| 来源不合法 | 403 | `FORBIDDEN_ORIGIN` | 请求来源不受信任 | 不重试 |
| 尝试过多 | 429 | `RATE_LIMITED` | 尝试次数过多，请稍后再试 | 按秒数等待 |
| 服务异常 | 500 | `INTERNAL` | 服务内部错误，请稍后重试 | 保留输入，允许重试 |

安全底线：

1. 错误信息不含账号是否存在、密码、哈希、Cookie、邀请码、服务器路径、SQL、堆栈或上游原文；
2. 日志记录 `requestId`、`userId`（如已登录）、结果码、耗时；不记录密码、Cookie、邀请码、材料正文；
3. 注册与登录响应不得包含 `passwordHash`、`passwordAlgo` 之外的任何密码派生信息；实际上 `passwordAlgo` 也不返回。

---

## 22. V3 项目、阶段、任务、证据与进展接口

### 22.0 公共约定

| 项 | 约定 |
| --- | --- |
| 前缀 | 所有项目接口以 `/api/projects/{projectId}` 开头 |
| 认证 | 必须登录；项目必须属于当前用户 |
| 信封 | 写接口使用 20.2；读接口返回 `contractVersion` / `projectId` / `projectRevision` / `data` |
| 幂等 | 所有写接口必须带 `idempotencyKey` |
| 并发 | 所有写接口按 `projectRevision` 校验；单实体更新加 `expectedRevision` |
| 归档写保护 | 项目状态为 `archived` 时，所有领域写接口在 `loadProject` 后返回 409 `PROJECT_ARCHIVED`，不得写入；仅 `POST /projects/{id}/restore` 与 `POST /projects/{id}/delete` 例外；所有 GET 不受限 |
| 错误 | 使用第 25 节错误码；跨用户项目 404 `PROJECT_NOT_FOUND`；跨项目实体 ID 一律 404 `RESOURCE_NOT_FOUND`，避免通过 ID 探测其他项目数据 |
| 时间 | 服务端生成 `createdAt`/`updatedAt`；客户端只传业务时间 |
| 空值 | 缺失值一律 `null`，不省略字段 |
| 读分页 | 列表读接口使用 `limit`（默认 50，最大 100；片段/草稿条目最大 200）和 opaque `cursor`；非法 limit/cursor 返回 400 `INVALID_INPUT`；排序规则见各接口 |
| 读操作 | 读接口不要求 `idempotencyKey`，不递增 `projectRevision`，不写幂等记录 |
| 疑问 | 本 PR 只冻结 `Doubt` 模型与读取语义；手工创建/解决/归档写接口留给后续 PR；证据自动创建疑问、迁移导入疑问，AI 继续使用顶层 `doubts` |

### 22.1 项目列表与创建

#### GET /api/projects

查询参数：`includeArchived=false|true`，默认 `false`。

响应：

```json
{
  "contractVersion": "3.0",
  "projectId": null,
  "projectRevision": null,
  "data": {
    "projects": [
      {
        "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
        "name": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
        "short": "极端风浪",
        "status": "active",
        "projectRevision": 12,
        "currentMilestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
        "currentMilestone": "数据获取与预处理",
        "milestoneCount": 3,
        "taskCount": 8,
        "doneTaskCount": 3,
        "updatedAt": "2026-10-19T02:30:00.000Z"
      }
    ]
  }
}
```

规则：

- 只返回当前用户的项目；不返回其他用户的项目数量或名称；
- 归档项目默认不返回；
- 项目列表不返回材料正文、证据正文或聊天内容；
- 列表接口没有单一项目，顶层 `projectId` / `projectRevision` 为 `null`，客户端以每个列表项的 `projectRevision` 为准。

#### POST /api/projects

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "idempotencyKey": "project-create-01JBC9R7T3K8QW4M2N6P5X0ZYC",
  "name": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
  "short": "极端风浪",
  "profile": {
    "goal": "构建极端风浪事件识别与预警的原型系统",
    "expectedOutcome": "可交互原型 + 会议论文",
    "memberNames": ["张同学", "李同学"],
    "researchPeriod": "第 3 周至第 14 周",
    "scope": "先做西北太平洋",
    "outOfScope": "不做实时业务系统"
  }
}
```

请求字段：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `name` | string | 是 | 1～120 字 |
| `short` | string | 否 | 项目短名/标签名，**不是描述**；1～20 字；缺失时服务端取名称前 12 个字，超出加 `…`（最长 13 字） |
| `profile` | ProjectProfile | 是 | 字段同 13.1；缺失字段补 `null`，`memberNames` 缺失补 `[]` |

成功响应：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 1,
  "replayed": false,
  "data": {
    "project": {
      "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
      "ownerUserId": "usr_01JBC9R7T3K8QW4M2N6P5X0ZYE",
      "name": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
      "short": "极端风浪",
      "profile": {
        "goal": "构建极端风浪事件识别与预警的原型系统",
        "expectedOutcome": "可交互原型 + 会议论文",
        "memberNames": ["张同学", "李同学"],
        "researchPeriod": "第 3 周至第 14 周",
        "scope": "先做西北太平洋",
        "outOfScope": "不做实时业务系统"
      },
      "status": "active",
      "visibility": "private",
      "projectRevision": 1,
      "currentMilestoneId": null,
      "currentMilestone": null,
      "createdAt": "2026-10-19T02:30:00.000Z",
      "updatedAt": "2026-10-19T02:30:00.000Z",
      "milestones": [],
      "taskStats": {
        "total": 0,
        "done": 0,
        "doing": 0,
        "todo": 0,
        "archived": 0,
        "progress": 0
      }
    }
  }
}
```

规则：

- **空白项目**：`milestones` 必须为 `[]`，不得注入模板阶段、模板任务、示例证据或示例聊天；
- `projectRevision` 初始为 1；
- `currentMilestoneId` / `currentMilestone` 初始为 `null`；
- `short` 未提供时由服务端取名称前 12 个字，超出加 `…`，但不得为空；
- `short` 的语义是“项目短名/标签名”，只用于项目切换器、地图中心和空间有限的标签；不是项目描述，不承载目标、范围或摘要。完整名称用 `name`，目标/范围用 `profile.goal` / `profile.scope`；
- 创建项目只写项目本身，不触发 AI。

#### GET /api/projects/{projectId}

返回项目基本信息、阶段列表和任务统计（结构同 22.1 创建响应中的 `data.project`）。不存在或不属于当前用户：404 `PROJECT_NOT_FOUND`。

#### PATCH /api/projects/{projectId}

可编辑 `name`、`short`、`profile`。请求带 `projectRevision` 与 `idempotencyKey`，不需要 `expectedRevision`。成功返回更新后的项目，`projectRevision + 1`。

#### POST /api/projects/{projectId}/archive|restore|delete|restore-deleted

| 路径 | 语义 | 可恢复 |
| --- | --- | --- |
| `POST /api/projects/{projectId}/archive` | `active → archived` | 是，调用 `/restore` |
| `POST /api/projects/{projectId}/restore` | `archived → active` | — |
| `POST /api/projects/{projectId}/delete` | `active/archived → deleted`，软删除 30 天 | 30 天内调用 `/restore-deleted` |
| `POST /api/projects/{projectId}/restore-deleted` | `deleted → active` | — |

四个操作都要求 `projectRevision` 与 `idempotencyKey`；重复调用幂等，不重复递增版本。软删除不立即删除材料、证据或聊天。

### 22.2 阶段（Milestone）接口

#### GET /api/projects/{projectId}/milestones

查询参数：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `includeArchived` | boolean | `false` | 是否包含已归档阶段 |
| `includeTaskStats` | boolean | `true` | 是否返回任务统计 |

响应：

```json
{
  "contractVersion": "3.0",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 12,
  "data": {
    "currentMilestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
    "milestones": [
      {
        "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
        "name": "数据获取与预处理",
        "goal": "拿到可复现的样例数据并确认字段口径",
        "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
        "dueAt": "2026-11-02T15:59:59.000Z",
        "status": "active",
        "orderIndex": 1,
        "revision": 4,
        "source": "manual",
        "createdAt": "2026-10-15T08:00:00.000Z",
        "updatedAt": "2026-10-18T09:20:00.000Z",
        "completedAt": null,
        "archivedAt": null,
        "taskStats": {
          "total": 3,
          "done": 1,
          "doing": 1,
          "todo": 1,
          "archived": 0,
          "progress": 33
        }
      }
    ],
    "projectStats": {
      "milestoneCount": 1,
      "activeMilestoneCount": 1,
      "completedMilestoneCount": 0,
      "taskTotal": 3,
      "taskDone": 1,
      "taskDoing": 1,
      "taskTodo": 1,
      "taskArchived": 0,
      "progress": 33
    }
  }
}
```

规则：

- 默认按 `orderIndex` 升序；
- `taskStats.total` 不含归档任务；`progress = floor(done * 100 / total)`，`total = 0` 时为 0；
- 归档阶段默认不返回；`includeArchived=true` 时返回，并带 `archivedAt`；
- `currentMilestoneId` 由服务端按“第一个 `active`；否则第一个 `planned`；否则 `null`”推导，客户端不能直接设置；
- 响应不包含任务正文，只包含统计。

#### POST /api/projects/{projectId}/milestones

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "idempotencyKey": "ms-create-01JBC9R7T3K8QW4M2N6P5X0ZYC",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 12,
  "name": "数据获取与预处理",
  "goal": "拿到可复现的样例数据并确认字段口径",
  "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
  "dueAt": "2026-11-02T15:59:59.000Z",
  "status": "planned",
  "source": "manual"
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `name` | string | 是 | 1～60 字，同项目未归档阶段内唯一 |
| `goal` | string \| null | 是 | ≤ 300 字 |
| `doneCriteria` | string \| null | 是 | ≤ 300 字 |
| `dueAt` | string \| null | 是 | ISO 8601 |
| `status` | `planned` \| `active` | 否 | 默认 `planned` |
| `source` | `manual` \| `ai-candidate` | 否 | 默认 `manual` |
| `candidateId` | string | 条件必填 | `source: "ai-candidate"` 时必填 |
| `confirmedByUser` | boolean | 条件必填 | `source: "ai-candidate"` 时必须为 `true` |

成功响应：`data.milestone`（结构同列表项，`taskStats` 全为 0），`projectRevision + 1`。

错误：

| 场景 | code | HTTP |
| --- | --- | --- |
| 阶段重名 | `MILESTONE_NAME_CONFLICT` | 409 |
| 候选过期 | `CANDIDATE_EXPIRED` | 409 |
| 未确认候选 | `CONFIRMATION_REQUIRED` | 400 |
| 项目版本过期 | `STALE_REVISION` | 409 |
| 项目不存在 / 非本人 | `PROJECT_NOT_FOUND` | 404 |

AI 候选确认规则见 23.7；**服务端不得因“项目为空”自动创建模板阶段**。

#### PATCH /api/projects/{projectId}/milestones/{milestoneId}

请求字段：`name`、`goal`、`doneCriteria`、`dueAt`，至少一个；必须带 `expectedRevision`。

```json
{
  "contractVersion": "3.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "idempotencyKey": "ms-update-01JBC9R7T3K8QW4M2N6P5X0ZYD",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 12,
  "expectedRevision": 4,
  "goal": "拿到可复现的样例数据，并确认字段口径和缺失率"
}
```

成功返回更新后的阶段，`projectRevision + 1`，实体 `revision + 1`。`name` 冲突返回 `MILESTONE_NAME_CONFLICT`；版本冲突返回 `STALE_REVISION` 并带 `currentEntityRevision`。

#### POST /api/projects/{projectId}/milestones/reorder

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "idempotencyKey": "ms-reorder-01JBC9R7T3K8QW4M2N6P5X0ZYF",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 12,
  "order": [
    "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
    "ms_01JBC9R7T3K8QW4M2N6P5X0ZYG",
    "ms_01JBC9R7T3K8QW4M2N6P5X0ZYH"
  ]
}
```

规则：

- `order` 必须包含当前项目**全部未归档阶段**，恰好一次，不允许遗漏、重复或包含归档阶段；
- 不满足返回 400 `INVALID_ORDER`；
- 服务端在一个事务内重写 `orderIndex = 0..N-1`，`projectRevision + 1`；
- 同一顺序重复提交幂等，不重复递增；
- 成功返回全部阶段列表。

#### 阶段状态动作

| 路径 | 请求 | 成功语义 | 幂等 |
| --- | --- | --- | --- |
| `POST .../milestones/{id}/activate` | 信封 + `expectedRevision` | `planned → active` | 已 `active` 时返回当前状态，不递增 |
| `POST .../milestones/{id}/complete` | 信封 + `expectedRevision` | `planned/active → completed`，写 `completedAt` | 已 `completed` 时返回当前状态 |
| `POST .../milestones/{id}/reopen` | 信封 + `expectedRevision` | `completed → active`，清 `completedAt` | 已 `active` 时返回当前状态 |
| `POST .../milestones/{id}/archive` | 信封 + `expectedRevision` | 任意非归档 → `archived`，记录 `archivedFromStatus` | 已归档时返回当前状态 |
| `POST .../milestones/{id}/restore` | 信封 + `expectedRevision` | `archived → archivedFromStatus` | 非归档时返回当前状态 |

补充规则：

- **删除 = 归档**；V3 不暴露阶段硬删除接口，避免误删历史证据；
- 完成阶段不要求所有任务 `done`，但响应必须返回 `taskStats`，页面提示未完成任务数；
- 给 `completed` 阶段新增任务或移入任务，必须带 `reopenMilestone: true`，否则 409 `MILESTONE_COMPLETED`；
- 归档阶段不能新增任务、不能提交关联证据、不能作为 AI 当前阶段；违反返回 409 `MILESTONE_ARCHIVED`，历史证据仍保留。

合法状态转换：

| 当前状态 | `activate` | `complete` | `reopen` | `archive` | `restore` |
| --- | --- | --- | --- | --- | --- |
| `planned` | `active` | `completed`（允许直接完成） | 不合法 | `archived` | `no-op`（非归档） |
| `active` | `active`（幂等） | `completed` | `no-op`（幂等，不递增） | `archived` | `no-op`（非归档） |
| `completed` | 不合法 | `completed`（幂等） | `active`，清 `completedAt` | `archived` | `no-op`（非归档） |
| `archived` | 不合法 | 不合法 | 不合法 | 幂等 | `archivedFromStatus` |

必须明确：

1. **阶段不强制显式 `activate`**：`planned` 可以创建任务，也可以直接 `complete`；`activate` 只表示“当前推进中”，并影响 `currentMilestoneId` 的选择；
2. `completed → active` 是唯一 reopen 路径；任务状态不变，进度重新计算；
3. 归档记录 `archivedFromStatus`；恢复回到该状态，不重置 revision；
4. 归档阶段新增任务/证据返回 409 `MILESTONE_ARCHIVED`；必须先 `restore`；
5. `active → planned`、`completed → planned`、`archived` 直接 `complete` 返回 409 `INVALID_STATE_TRANSITION`；
6. `active` 再 `reopen`、非归档阶段 `restore` 为幂等 no-op：返回当前状态，`changed: false`，不递增实体 revision 或 `projectRevision`；`planned`/`archived` 不能通过 `reopen` 跳过其他转换；
7. `restore` 恢复出的名称若与当前未归档阶段重名，返回 409 `MILESTONE_NAME_CONFLICT`；整个事务回滚，阶段保持归档、版本不变，也不写入成功幂等记录；用户可先给现有同名阶段改名再恢复。

### 22.3 任务（Task）接口

#### GET /api/projects/{projectId}/tasks

查询参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `milestoneId` | 无 | 只返回该阶段任务；阶段必须属于当前项目 |
| `status` | 无 | `todo` / `doing` / `done` |
| `includeArchived` | `false` | 是否包含归档任务及归档阶段下的任务 |
| `limit` | 50 | 1～100 |
| `cursor` | 无 | 上一页返回的 opaque `nextCursor` |

排序：`createdAt DESC, taskId DESC`；任务 `milestoneName` 由服务端回填。

默认规则：

- 默认排除 `archivedAt != null` 的任务；
- 默认排除所属阶段已归档（`milestones.archived_at != null`）的任务；`includeArchived=true` 时一并返回；
- 项目软删除后所有读取 404 `PROJECT_NOT_FOUND`；归档项目仍可读；
- 不返回材料正文、证据正文或聊天内容。

成功响应：`data.tasks` 为任务 DTO 列表，`data.nextCursor` 为 `null` 或下一页游标；顶层带 `projectRevision`。

#### GET /api/projects/{projectId}/tasks/{taskId}

查询参数：`includeArchived=false|true`，默认 `false`。

- 任务必须同时匹配 `taskId + projectId`；跨项目一律 404 `RESOURCE_NOT_FOUND`；
- 归档任务或所属阶段归档的任务默认 404；`includeArchived=true` 返回完整详情。Task DTO **没有** `readOnly` 字段，只读状态由前端依据 `archivedAt` 和项目状态自行判断；
- 响应 `data.task`，不改变任务状态或 `projectRevision`。

#### POST /api/projects/{projectId}/tasks

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "idempotencyKey": "task-create-01JBC9R7T3K8QW4M2N6P5X0ZYJ",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 13,
  "title": "跑通 ERA5 与浮标数据的下载链路",
  "doneCriteria": "下载一段样例数据，并能用 Python 读出关键变量",
  "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
  "status": "todo"
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `title` | string | 是 | 1～60 字 |
| `doneCriteria` | string \| null | 是 | ≤ 200 字 |
| `milestoneId` | string \| null | 是 | 同项目；`null` 表示项目待办 |
| `status` | `todo` \| `doing` | 否 | 默认 `todo` |
| `reopenMilestone` | boolean | 否 | 目标阶段为 `completed` 时必须为 `true`；为 `true` 时同一事务把阶段改回 `active` 并清除 `completedAt`，`projectRevision` 只 +1 |

成功响应：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 14,
  "replayed": false,
  "data": {
    "task": {
      "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYK",
      "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
      "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
      "milestoneName": "数据获取与预处理",
      "title": "跑通 ERA5 与浮标数据的下载链路",
      "doneCriteria": "下载一段样例数据，并能用 Python 读出关键变量",
      "status": "todo",
      "assigneeUserId": null,
      "orderIndex": 2,
      "source": "manual",
      "revision": 1,
      "createdAt": "2026-10-19T02:30:00.000Z",
      "updatedAt": "2026-10-19T02:30:00.000Z",
      "startedAt": null,
      "completedAt": null,
      "archivedAt": null
    },
    "milestoneStats": {
      "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
      "total": 4,
      "done": 1,
      "doing": 1,
      "todo": 2,
      "archived": 0,
      "progress": 25
    }
  }
}
```

错误：目标阶段归档 `MILESTONE_ARCHIVED`；目标阶段完成且未重开 `MILESTONE_COMPLETED`；目标阶段不属于当前项目返回 404 `RESOURCE_NOT_FOUND`（与 22.0 一致，不使用 `PROJECT_MISMATCH`）。

#### PATCH /api/projects/{projectId}/tasks/{taskId}

可编辑 `title`、`doneCriteria`；必须带 `expectedRevision`。返回更新后的任务；如果任务所属阶段进度受影响（仅标题/完成标准不影响），不重算时也要返回当前 `milestoneStats`。

#### POST /api/projects/{projectId}/tasks/{taskId}/link-milestone

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "idempotencyKey": "task-link-01JBC9R7T3K8QW4M2N6P5X0ZYM",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 14,
  "expectedRevision": 2,
  "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYG"
}
```

规则：

- `milestoneId` 可为 `null`（移回项目待办）；
- 目标阶段必须同项目、未归档；`completed` 阶段需 `reopenMilestone: true`，为 `true` 时同一事务把阶段改回 `active` 并清除 `completedAt`；
- 源阶段和目标阶段的进度同时重算，响应返回两个阶段的 `milestoneStats`；
- 任务的既有证据不重新归属，证据保留提交时的 `milestoneId` 快照；
- 重复关联到同一阶段幂等，不递增 revision。

#### 任务状态动作

| 路径 | 请求 | 语义 | 幂等 |
| --- | --- | --- | --- |
| `POST .../tasks/{id}/start` | 信封 + `expectedRevision` | `todo → doing`，写 `startedAt` | `doing` 时返回当前状态 |
| `POST .../tasks/{id}/complete` | 信封 + `expectedRevision` | `todo/doing → done`，写 `completedAt` | `done` 时返回当前状态 |
| `POST .../tasks/{id}/reopen` | 信封 + `expectedRevision` + `targetStatus` | `done → doing`（默认）或 `done → todo`，清 `completedAt` | 目标状态已满足时幂等 |
| `POST .../tasks/{id}/archive` | 信封 + `expectedRevision` | 任意状态 → 归档 | 已归档时幂等 |
| `POST .../tasks/{id}/restore` | 信封 + `expectedRevision` | 清除 `archivedAt`，恢复原状态 | 未归档时幂等 |

所有动作成功都返回任务与所属阶段 `milestoneStats`；任务无阶段时 `milestoneStats: null`。

合法状态转换：

| 当前状态 | `start` | `complete` | `reopen` | `archive` | `restore` |
| --- | --- | --- | --- | --- | --- |
| `todo` | `doing` | `done`（允许直接完成） | 不合法 | `archivedAt` 非空 | 不合法 |
| `doing` | `doing`（幂等） | `done` | 不合法 | `archivedAt` 非空 | 不合法 |
| `done` | 不合法 | `done`（幂等） | `doing`（默认）或 `todo` | `archivedAt` 非空 | 不合法 |
| `archived` | 不合法 | 不合法 | 不合法 | 幂等 | 恢复归档前状态 |

规则：

1. 归档任务不能开始、完成、重开、提交证据或进展；必须先 `restore`；
2. `done → todo` 只能通过 `reopen` 的 `targetStatus`，不能通过普通字段更新；
3. 任务完成不自动改变阶段状态；阶段进度按 `done / total` 重算；
4. 在 `planned` 阶段开始任务不会自动激活阶段；激活仍是显式动作；
5. 归档任务不计入进度分母，历史证据仍可查询。

### 22.4 进展（ProgressRecord）接口

#### POST /api/projects/{projectId}/progress

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "idempotencyKey": "progress-01JBC9R7T3K8QW4M2N6P5X0ZYN",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 14,
  "summary": "完成样例数据下载，确认了 4 个关键字段和缺失率口径",
  "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
  "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
  "evidenceIds": ["evd_01JBC9R7T3K8QW4M2N6P5X0ZYP"],
  "occurredAt": "2026-10-19T02:20:00.000Z"
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `summary` | string | 是 | 1～1,000 字 |
| `milestoneId` | string \| null | 是 | 同项目；归档阶段拒绝 |
| `taskId` | string \| null | 是 | 同项目；归档任务拒绝 |
| `evidenceIds` | string[] | 是 | ≤ 10，同项目 |
| `occurredAt` | string \| null | 否 | 不传则用服务端当前时间 |

规则：

- 如果同时传 `milestoneId` 和 `taskId`，任务的当前阶段必须等于 `milestoneId`，否则 400 `INVALID_INPUT`（字段级冲突，不执行写入）；
- 任务已归属阶段时，`milestoneId` 缺失或 `null` **不能绕过归档限制**：服务端以数据库中的任务阶段为准；有效阶段已归档返回 409 `MILESTONE_ARCHIVED`；显式传入不同阶段返回 400 `INVALID_INPUT`；拒绝时不得写入进展或递增版本；
- 提交进展**不改变任务状态**；完成任务必须调用任务完成动作；
- 成功返回 `data.progress` 与 `data.milestoneStats`（可空）；
- 进展只追加；更正通过 `POST /api/projects/{projectId}/progress/{progressId}/supersede` 创建新记录，旧记录置 `superseded`，正文保留；
- 重复提交同一 `idempotencyKey` 返回同一条进展。

#### GET /api/projects/{projectId}/progress

查询参数：`milestoneId`、`taskId`、`limit`（默认 50，最大 100）、`cursor`、`includeArchived`。

响应按 `occurredAt` 倒序，字段：`progressId`、`summary`、`milestoneId`、`taskId`、`evidenceIds`、`occurredAt`、`status`、`revision`、`createdAt`、`nextCursor`。

### 22.5 证据（Evidence）接口

#### POST /api/projects/{projectId}/evidence

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "idempotencyKey": "evidence-01JBC9R7T3K8QW4M2N6P5X0ZYQ",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 14,
  "submissionId": "6e2b8c07-f1d3-490a-8c5e-2b7f0d3a9186",
  "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
  "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
  "didWhat": "下载了 2024 年 1 月的 ERA5 样例数据",
  "foundWhat": "有效波高与风速字段完整，缺失率低于 1%",
  "stillUnsure": "0.5 度分辨率是否满足公里级判断",
  "attachmentName": "era5-sample-202401.csv",
  "completeTask": false
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `submissionId` | string | 否 | 8～64 可打印字符；不传由服务端生成；同项目内唯一 |
| `taskId` | string \| null | 是 | 同项目；归档任务拒绝 |
| `milestoneId` | string \| null | 是 | 同项目；归档阶段拒绝；任务已归属阶段时必须与任务当前阶段一致（缺失/`null` 按任务阶段处理，不同阶段 400 `INVALID_INPUT`） |
| `didWhat` | string | 是 | 1～300 字 |
| `foundWhat` | string \| null | 是 | ≤ 500 字 |
| `stillUnsure` | string \| null | 是 | ≤ 500 字；非空时创建疑问 |
| `attachmentName` | string \| null | 是 | ≤ 200 字；不上传文件 |
| `completeTask` | boolean | 否 | 默认 `false` |
| `expectedTaskRevision` | number | 条件必填 | `completeTask: true` 时必填 |

成功响应：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 15,
  "replayed": false,
  "data": {
    "evidence": {
      "evidenceId": "evd_01JBC9R7T3K8QW4M2N6P5X0ZYP",
      "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
      "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
      "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
      "milestoneNameSnapshot": "数据获取与预处理",
      "submissionId": "6e2b8c07-f1d3-490a-8c5e-2b7f0d3a9186",
      "didWhat": "下载了 2024 年 1 月的 ERA5 样例数据",
      "foundWhat": "有效波高与风速字段完整，缺失率低于 1%",
      "stillUnsure": "0.5 度分辨率是否满足公里级判断",
      "attachmentName": "era5-sample-202401.csv",
      "status": "active",
      "revision": 1,
      "createdAt": "2026-10-19T02:30:00.000Z"
    },
    "doubt": {
      "doubtId": "dbt_01JBC9R7T3K8QW4M2N6P5X0ZYR",
      "text": "0.5 度分辨率是否满足公里级判断",
      "status": "open",
      "sourceEvidenceId": "evd_01JBC9R7T3K8QW4M2N6P5X0ZYP",
      "createdAt": "2026-10-19T02:30:00.000Z"
    },
    "task": null,
    "milestoneStats": {
      "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
      "total": 3,
      "done": 1,
      "doing": 1,
      "todo": 1,
      "archived": 0,
      "progress": 33
    }
  }
}
```

规则：

- 证据正文不可修改；`stillUnsure` 非空自动创建一条 `Doubt`，重复 `submissionId` 不重复创建；
- 任务已归属阶段时，`milestoneId` 缺失或 `null` 不能绕过归档限制：服务端以数据库中的任务阶段为准，有效阶段归档返回 409 `MILESTONE_ARCHIVED`；显式传入不同阶段返回 400 `INVALID_INPUT`；拒绝时不得写入证据、疑问或改变任务状态；
- `completeTask: true` 时在同一事务中把任务置 `done`、写 `completedAt`、重算阶段进度、创建证据与疑问、`projectRevision` 只 +1；
- `completeTask` 对 `done` 任务幂等；对归档任务返回 `TASK_ARCHIVED`；
- 证据不因阶段归档而删除；`milestoneNameSnapshot` 固定为提交时名称，任务后续移动阶段不静默改写历史快照；
- 不提供证据删除接口。

#### POST /api/projects/{projectId}/evidence/{evidenceId}/links

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "idempotencyKey": "evidence-link-01JBC9R7T3K8QW4M2N6P5X0ZYS",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 15,
  "expectedRevision": 1,
  "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
  "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB"
}
```

规则：

- `taskId` / `milestoneId` 可为 `null`，表示解除关联；
- 两者必须同项目；归档任务/阶段拒绝；
- 任务已归属阶段时，`milestoneId` 缺失/`null` 按任务阶段处理；显式不同阶段返回 400 `INVALID_INPUT`；有效阶段归档返回 409 `MILESTONE_ARCHIVED`，拒绝时不修改关联或版本；
- 更新证据关联使证据 `revision + 1`、`projectRevision + 1`；
- 仅当本次显式改变关联阶段时更新 `milestoneNameSnapshot`；之后任务移动阶段不得静默改写历史快照；
- 重复设置相同关联幂等，不递增版本。

#### GET /api/projects/{projectId}/evidence

查询参数：`taskId`、`milestoneId`、`limit`（默认 50，最大 100）、`cursor`、`includeArchived`。返回证据列表，不含材料正文。

### 22.6 项目时间线

`GET /api/projects/{projectId}/timeline`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | number | 50 | 1～100 |
| `cursor` | string \| null | `null` | 上一页返回的不透明游标 |
| `types` | string | 全部 | 逗号分隔：`milestone,task,evidence,progress,material,doubt,chat` |
| `includeArchived` | boolean | `false` | 是否包含归档实体事件 |

响应：

```json
{
  "contractVersion": "3.0",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 15,
  "data": {
    "items": [
      {
        "timelineItemId": "evt_01JBC9R7T3K8QW4M2N6P5X0ZYT",
        "type": "evidence",
        "occurredAt": "2026-10-19T02:30:00.000Z",
        "title": "提交证据：下载了 2024 年 1 月的 ERA5 样例数据",
        "summary": "有效波高与风速字段完整，缺失率低于 1%",
        "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
        "milestoneNameSnapshot": "数据获取与预处理",
        "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
        "evidenceId": "evd_01JBC9R7T3K8QW4M2N6P5X0ZYP",
        "progressId": null,
        "materialId": null,
        "chatId": null,
        "actorUserId": "usr_01JBC9R7T3K8QW4M2N6P5X0ZYE",
        "entityRevision": 1,
        "archived": false
      }
    ],
    "nextCursor": null
  }
}
```

规则：

- 按 `occurredAt` 倒序；同一时间按 `timelineItemId` 倒序；
- 归档阶段/任务的事件仍保留，`archived: true`；
- 时间线只返回当前用户当前项目的事件；跨项目 ID 不出现；
- `summary` 截断到 200 字，不返回完整材料正文或模型原文；
- 非法游标返回 400 `INVALID_INPUT`。

---


### 22.7 材料理解草稿确认接口

材料理解草稿的确认状态属于项目领域数据；本节冻结五个写动作。V2 的本地 action 名称与 HTTP 路由映射如下：

| 前端 action | HTTP | 说明 |
| --- | --- | --- |
| `confirmDraftItem` | `POST .../items/{itemId}/confirm` | 确认单条 |
| `editDraftItem` | `PATCH .../items/{itemId}` | 修改正文，退回 `modified` |
| `removeDraftItem` | `POST .../items/{itemId}/remove` | 移除（归档），不物理删除 |
| `undoDraftItem` | `POST .../items/{itemId}/undo` | 撤销确认 |
| `confirmAllDraft` | `POST .../confirm-all` | 整份确认当前版本全部条目 |

路径前缀：`/api/projects/{projectId}/materials/{materialId}/understanding`。

#### 22.7.1 公共请求字段

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "idempotencyKey": "draft-confirm-01JBC9R7T3K8QW4M2N6P5X0ZZB",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 16,
  "materialVersion": 1,
  "itemId": "cnd_01JBC9R7T3K8QW4M2N6P5X0ZZC",
  "expectedRevision": 2
}
```

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | `"3.0"` |
| `requestId` | string | 是 | UUID v4 |
| `idempotencyKey` | string | 是 | 8～64 可打印字符 |
| `projectId` | string | 是 | 必须与路径一致 |
| `projectRevision` | number | 是 | 必须等于服务端当前项目版本 |
| `materialVersion` | number | 是 | 必须等于该材料当前版本；否则 409 `MATERIAL_VERSION_OUTDATED` |
| `itemId` | string | 条件必填 | 单条动作必填；必须是服务端稳定 `itemId`，不接受本地 `blockId` |
| `expectedRevision` | number | 条件必填 | 单条动作必填；必须等于条目当前 `revision` |
| `text` | string | 条件必填 | 仅 `editDraftItem`；1～300 字 |
| `items` | array | 条件必填 | 仅 `confirmAllDraft`；`[{ itemId, expectedRevision }]`，1～50 条 |

规则：

1. 单条动作必须校验 `materialId + materialVersion + itemId` 三者同时匹配；跨材料/跨项目返回 404 `RESOURCE_NOT_FOUND`；
2. 已归档条目不接受确认、修改、撤销或整份确认；返回 409 `DRAFT_ITEM_ARCHIVED`，且不得恢复；
3. 所有写操作在同一事务内递增 `projectRevision` 一次；无状态变化时返回 `changed: false`，不递增任何版本；
4. 同一 `idempotencyKey` + 相同请求体返回首次响应；不同请求体返回 409 `IDEMPOTENCY_CONFLICT`；
5. 版本冲突返回 409 `STALE_REVISION`，带 `currentProjectRevision` / `currentEntityRevision`，不执行部分写入。

#### 22.7.2 五个动作的语义

| 动作 | 合法前置状态 | 结果状态 | `revision` / `projectRevision` | 幂等行为 |
| --- | --- | --- | --- | --- |
| `confirmDraftItem` | `pending` / `modified` | `confirmed` | 各 +1 | 已 `confirmed`：`changed: false`，不递增 |
| `editDraftItem` | `pending` / `modified` / `confirmed` | `modified`，清空确认信息 | 各 +1 | 文本与当前 `text` 相同：`changed: false`，状态不变 |
| `removeDraftItem` | `pending` / `modified` / `confirmed` | `archived`，写 `removedAt` | 各 +1 | 已 `archived`：`changed: false` |
| `undoDraftItem` | `confirmed` | 比较 `text` 与 `originalText`：相同 → `pending`，不同 → `modified`；清空 `confirmedAt` / `confirmedByUserId` | 各 +1；`projectRevision` 只 +1 一次 | 非 `confirmed`：`changed: false`；已归档：409 |
| `confirmAllDraft` | 当前版本全部未归档条目 | 全部变为 `confirmed`；不得包含或恢复 archived | 每条变化的条目 `revision +1`；`projectRevision` 只 +1 一次 | 全部已确认：`changed: false`；任一 archived：整单 409，不写入 |

补充：

- `editDraftItem` 修改已确认条目时，必须立即清空 `confirmedAt` / `confirmedByUserId`，该条从 AI 可信上下文移除，直到再次确认；
- `removeDraftItem` 只归档，不删除来源片段；同一 `itemId` 不能通过 `confirmAllDraft` 被恢复；
- `undoDraftItem` 只撤销确认，不是删除；`pending` / `modified` 条目调用它是无操作；
- **确认必须有可验证来源**：单条确认和整份确认在写入前，必须按条目的 `materialId + materialVersion` 查询 `material_segments`，至少解析到一个真实存在且 `text.trim().length > 0` 的 `segmentId`；空字符串、普通空格、Tab、换行、回车、全角空格等纯空白正文都不算有效来源；`sources_json` 中的材料 ID、版本、行号等元数据不可信，不能替代数据库校验；
- 没有有效来源时返回 409 `DRAFT_SOURCE_MISSING`，不得把条目变为 `confirmed`；学生点击确认不能补足缺失来源；无来源手工事实不属于材料理解条目；
- 已 `confirmed` 且来源有效的历史条目再次单条确认仍按幂等返回 `changed: false`；已 `confirmed` 但无有效来源的条目也返回 409 `DRAFT_SOURCE_MISSING`，不得返回成功；整份确认会校验所有提交条目，任一条无有效来源则整单失败；
- `confirmAllDraft` 的 `items` 必须覆盖当前版本全部未归档条目，遗漏返回 400 `INVALID_INPUT`；任一条目 revision 不匹配返回 409 `STALE_REVISION`，整单不写入；
- `confirmAllDraft` 只把 `pending` / `modified` 改为 `confirmed`；已确认条目跳过，`skippedCount` 计数；响应 `items` 返回本次提交的全部条目最终状态，`confirmedCount` 只统计本次实际变更的条目。

#### 22.7.2.1 `undoDraftItem` 的确定规则

1. 先校验 `materialId`、`materialVersion`、`itemId`、`expectedRevision`，再判断状态；只有全部校验通过后，`pending` / `modified` 重复撤销才返回 200 `changed: false`，不递增任何版本；
2. 服务端使用**已保存的** `item.text` 与 `item.originalText` 做完全字符串比较（不做 trim、大小写或标点归一化）：
   - 两者完全一致 → 撤销后 `status: pending`；
   - 两者不同 → 撤销后 `status: modified`；
3. 成功撤销必须清空 `confirmedAt` 与 `confirmedByUserId`（置 `null`）；
4. 成功状态变化时：条目 `revision +1`，`projectRevision +1`，且**只递增一次**；无状态变化时不递增；
5. 以下任一不匹配必须拒绝，且不写入：
   - `materialId` 与路径不一致，或 `itemId` 不属于该材料：404 `RESOURCE_NOT_FOUND`；
   - `materialVersion` 不是该材料当前版本：409 `MATERIAL_VERSION_OUTDATED`；
   - `expectedRevision` 不等于条目当前 `revision`：409 `STALE_REVISION`，带 `currentEntityRevision`；
   - 条目已 `archived`：409 `DRAFT_ITEM_ARCHIVED`，**不得恢复为 `pending` 或 `modified`**；
6. 同一 `idempotencyKey` + 相同请求体重放返回首次响应；重复撤销已撤销的条目返回 `changed: false`，不重复递增；
7. `undoDraftItem` 不删除条目、不删除来源片段、不改变材料版本。

#### 22.7.2.2 `confirmAllDraft` 的确定规则

1. `items` 必须覆盖当前材料版本的全部未归档条目，恰好一次；遗漏、重复或未知 `itemId` 返回 400 `INVALID_INPUT` 或 404 `RESOURCE_NOT_FOUND`；
2. `items` **不能包含任何 `archived` 条目**；只要发现任意一条 archived，整个请求返回 409 `DRAFT_ITEM_ARCHIVED`（archived 检查先于 revision 校验），不得部分成功，也不得把 archived 恢复为 `pending` 或 `confirmed`；
3. 所有条目先校验 `materialId`、`materialVersion`、`itemId` 与 `expectedRevision`；任一不匹配返回 404 / 409 `MATERIAL_VERSION_OUTDATED` / 409 `STALE_REVISION`；随后逐条校验真实来源，任一条目没有有效来源返回 409 `DRAFT_SOURCE_MISSING`；**所有校验通过后才允许进入单事务写入**；
4. 事务内只把 `pending` / `modified` 改为 `confirmed`，写 `confirmedAt` / `confirmedByUserId`；已确认条目跳过；
5. 任一条目状态变化时 `revision +1`；整次成功 `projectRevision` **只 +1 一次**；
6. 失败（包括 archived、版本冲突、revision 冲突、未知条目、无有效来源）时 `projectRevision` **不递增**，且不得出现部分写入；其他条目的状态、确认人、确认时间、条目 revision 和成功幂等记录均保持不变；
7. 全部条目已确认时返回 200 `changed: false`，`projectRevision` 不变；
8. 已删除条目只能保持 archived；旧前端列表重新提交 archived `itemId` 时必须整单拒绝，不能因为重新提交而复活；
9. 同一 `idempotencyKey` + 相同请求体重放返回首次响应；不同请求体返回 409 `IDEMPOTENCY_CONFLICT`。

`confirmAllDraft` 请求示例：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "idempotencyKey": "draft-confirm-all-01JBC9R7T3K8QW4M2N6P5X0ZZE",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 16,
  "materialVersion": 1,
  "items": [
    {
      "itemId": "cnd_01JBC9R7T3K8QW4M2N6P5X0ZZC",
      "expectedRevision": 2
    },
    {
      "itemId": "cnd_01JBC9R7T3K8QW4M2N6P5X0ZZD",
      "expectedRevision": 1
    }
  ]
}
```

#### 22.7.3 成功响应

单条动作：

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 17,
  "replayed": false,
  "data": {
    "materialId": "mat_01JBC9R7T3K8QW4M2N6P5X0ZYV",
    "materialVersion": 1,
    "changed": true,
    "item": {
      "itemId": "cnd_01JBC9R7T3K8QW4M2N6P5X0ZZC",
      "kind": "goalCandidates",
      "text": "使用 ERA5 海浪场数据复现极端风浪事件识别流程",
      "originalText": "使用 ERA5 海浪场数据复现极端风浪事件识别流程",
      "sources": [
        {
          "materialId": "mat_01JBC9R7T3K8QW4M2N6P5X0ZYV",
          "materialName": "实验手册.md",
          "materialVersion": 1,
          "segmentId": "seg_0",
          "startLine": 1,
          "endLine": 8
        }
      ],
      "status": "confirmed",
      "revision": 3,
      "confirmedAt": "2026-10-19T02:35:00.000Z",
      "confirmedByUserId": "usr_01JBC9R7T3K8QW4M2N6P5X0ZYE",
      "removedAt": null
    }
  }
}
```

整份确认：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 17,
  "replayed": false,
  "data": {
    "materialId": "mat_01JBC9R7T3K8QW4M2N6P5X0ZYV",
    "materialVersion": 1,
    "changed": true,
    "confirmedCount": 2,
    "skippedCount": 1,
    "items": [
      {
        "itemId": "cnd_01JBC9R7T3K8QW4M2N6P5X0ZZC",
        "status": "confirmed",
        "revision": 3
      },
      {
        "itemId": "cnd_01JBC9R7T3K8QW4M2N6P5X0ZZD",
        "status": "confirmed",
        "revision": 2
      }
    ]
  }
}
```

#### 22.7.4 失败与中文提示

| 场景 | code | HTTP | 中文 message |
| --- | --- | --- | --- |
| 材料版本已更新 | `MATERIAL_VERSION_OUTDATED` | 409 | 材料已更新，请重新生成理解草稿 |
| 条目版本/项目版本过期 | `STALE_REVISION` | 409 | 内容已更新，请刷新后重试 |
| 条目不存在或不属于该材料 | `RESOURCE_NOT_FOUND` | 404 | 这条理解不存在或已失效 |
| 条目已归档 / 整份确认包含 archived | `DRAFT_ITEM_ARCHIVED` | 409 | 这条理解已移除，不能恢复或再次确认，请重新生成 |
| 条目没有可验证的材料来源 | `DRAFT_SOURCE_MISSING` | 409 | 这条理解没有可验证的材料来源，不能确认，请重新生成理解草稿 |
| 文本为空或超长 | `INVALID_INPUT` | 400 | 理解内容需为 1～300 字 |
| 整份确认遗漏条目 | `INVALID_INPUT` | 400 | 整份确认需要包含当前版本的全部理解条目 |
| 同键不同内容 | `IDEMPOTENCY_CONFLICT` | 409 | 重复请求的内容不一致，请刷新后重试 |

### 22.8 材料与理解草稿读取接口

本阶段只提供读取，不提供 V3 材料上传、重新解析、删除或归档写接口。

#### Material DTO

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `materialId` | string | 跨版本稳定 |
| `materialVersion` | number | 内容版本，≥ 1 |
| `name` | string | 原始文件名 |
| `type` | `md` \| `txt` | V3 上传白名单只有 md/txt（见 14.6 / 21 节）；迁移的旧材料可能保留 `csv`/`xlsx`/`pdf`/`docx` 等其他类型 |
| `size` | number | 文件字节数 |
| `encoding` | string | 实际解码编码 |
| `status` | string | `registered` / `parsed` / `parse_failed` / `unsupported` / `archived` |
| `revision` | number | 元数据/归档版本 |
| `sha256` | string \| null | 内容摘要 |
| `failureReason` | string \| null | 解析失败原因 |
| `createdAt` / `updatedAt` | string | 服务端时间 |
| `archivedAt` | string \| null | 归档时间 |
| `isCurrent` | boolean | 是否为该 `materialId` 的当前版本 |
| `readOnly` | boolean | 历史版本、材料归档或项目归档时为 `true` |

#### GET /api/projects/{projectId}/materials

查询参数：`includeArchived=false|true`、`limit`（默认 50，最大 100）、`cursor`。

- 默认只返回每个 `materialId` 的**当前版本**元数据，不返回历史版本；
- 默认排除归档材料；`includeArchived=true` 时包含当前版本已归档的材料；
- 排序：`updatedAt DESC, materialId DESC`；
- 成功响应 `data.materials` + `data.nextCursor`，不包含片段正文或理解条目正文。

#### GET /api/projects/{projectId}/materials/{materialId}

查询参数：`version`（可选，≥ 1）、`includeArchived=false|true`。

- 默认返回当前版本；
- `version` 指向历史版本时返回只读历史，`isCurrent=false`、`readOnly=true`；
- 历史版本和归档材料默认不可见时返回 404 `RESOURCE_NOT_FOUND`；归档材料需 `includeArchived=true`；
- 材料必须同时匹配 `materialId + projectId`，跨项目 404；
- 响应 `data.material`，不改变 `projectRevision`。

#### GET /api/projects/{projectId}/materials/{materialId}/segments

查询参数：`version`、`includeArchived`、`limit`（默认 100，最大 200）、`cursor`。

- 只返回该 `materialId + materialVersion` 的片段，绝不混合其他材料或版本；
- 排序：`index ASC, segmentId ASC`；
- `status` 由版本派生：当前版本 `active`，历史版本 `superseded`；
- 响应 `data.materialId`、`data.materialVersion`、`data.isCurrent`、`data.readOnly`、`data.segments`、`data.nextCursor`；
- 片段正文原样返回，不做 trim 或改写。

片段 DTO：`segmentId`、`materialId`、`materialVersion`、`index`、`startLine`、`endLine`、`text`、`charCount`、`status`、`createdAt`。

#### GET /api/projects/{projectId}/materials/{materialId}/understanding

查询参数：`version`、`includeArchived`、`limit`（默认 100，最大 200）、`cursor`。

- 只返回该 `materialId + materialVersion` 的理解条目；
- 默认排除 `status=archived` 的条目；`includeArchived=true` 同时包含归档条目；
- 排序：`createdAt ASC, itemId ASC`；
- 条目 `sources` 必须按 `materialId + materialVersion + segmentId` 查询数据库真实片段生成，忽略 `sources_json` 中的材料 ID、版本、行号；无效来源不返回；
- 响应 `data.materialId`、`data.materialVersion`、`data.isCurrent`、`data.readOnly`、`data.items`、`data.nextCursor`；
- 条目 DTO 复用 `itemId`、`kind`、`text`、`originalText`、`sources`、`status`、`revision`、`confirmedAt`、`confirmedByUserId`、`removedAt`。

#### 共同读取规则

- 所有接口要求登录，并先校验 `userId + projectId` 所有权；
- 软删除项目 404 `PROJECT_NOT_FOUND`；归档项目仍可读，但所有领域写接口返回 409 `PROJECT_ARCHIVED`（项目 `restore`/`delete` 例外）；
- 材料、片段、理解草稿的 `readOnly` 由「历史版本、材料/条目归档或项目归档」派生；项目归档时 `readOnly=true` 而 `isCurrent` 仍按材料版本语义返回；
- 跨用户 404 `PROJECT_NOT_FOUND`；同用户跨项目实体 404 `RESOURCE_NOT_FOUND`；
- 读取不递增项目/实体 revision、不创建幂等记录、不改变任何业务状态；
- 非法 `version`、`limit`、`cursor` 返回 400 `INVALID_INPUT`。

---

## 23. AI 阶段上下文契约

### 23.1 兼容面

`POST /api/advisor/recommendations` 与 `POST /api/advisor/chat` 的路径、`contractVersion: "1.0"`、既有必填字段、失败结构、超时和兜底规则**全部不变**。本节只新增：

1. 可选 `milestoneContext`；
2. 新的提示词版本 `mvp-prompt-v3` / `advisor-chat-v3`；
3. 可选的已确认材料来源引用；
4. 阶段候选生成接口（只生成候选，不写项目）。

不携带 `milestoneContext` 的 v1/v2 请求行为与第 4、6.4、17 节完全一致。v3 提示词必须与 `milestoneContext` 成对使用；版本组合不成立时返回 400 `CONTRACT_VERSION_MISMATCH`，前端不得自动降级到 v1/v2。

### 23.2 `milestoneContext` 字段

```json
{
  "milestoneContext": {
    "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
    "currentMilestone": "数据获取与预处理",
    "milestoneRevision": 4,
    "milestoneGoal": "拿到可复现的样例数据并确认字段口径",
    "milestoneDoneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
    "milestoneStatus": "active",
    "milestoneTasks": [],
    "recentProgress": [],
    "milestoneEvidence": []
  }
}
```

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `milestoneId` | string \| null | 是 | `ms_` 前缀或 `null` | 空白项目为 `null` |
| `currentMilestone` | string \| null | 是 | ≤ 60 字 | 必须与顶层 `currentMilestone` 一致（两者都非空时） |
| `milestoneRevision` | number \| null | 是 | ≥ 1 整数 | 客户端已知的阶段版本 |
| `milestoneGoal` | string \| null | 是 | ≤ 300 字 | 阶段目标 |
| `milestoneDoneCriteria` | string \| null | 是 | ≤ 300 字 | 阶段完成标准 |
| `milestoneStatus` | `planned` \| `active` \| null | 是 | — | 当前阶段只允许 `planned` / `active`；`completed` / `archived` 不作为当前阶段 |
| `milestoneTasks` | MilestoneTaskSnapshot[] | 是 | ≤ 50 条 | 该阶段全部任务（含已完成），用于避免重复建议 |
| `recentProgress` | ProgressSnapshot[] | 是 | ≤ 20 条，按 `occurredAt` 倒序 | 最近进展摘要 |
| `milestoneEvidence` | EvidenceSnapshot[] | 是 | ≤ 20 条，按 `createdAt` 倒序 | 该阶段最近证据 |

快照字段：

| 快照 | 字段 |
| --- | --- |
| `MilestoneTaskSnapshot` | `taskId`、`title`、`status`、`doneCriteria`、`owner`、`milestone`、`updatedAt` |
| `ProgressSnapshot` | `progressId`、`summary`、`milestoneId`、`taskId`、`occurredAt` |
| `EvidenceSnapshot` | 沿用 4.1：`evidenceId`、`submissionId`、`taskId`、`didWhat`、`foundWhat`、`stillUnsure`、`author`、`createdAt` |

规则：

1. `milestoneId` 非空时，`milestoneTasks`、`milestoneEvidence`、`recentProgress` 中出现的实体必须属于该项目和该阶段；服务端校验失败返回 400 `INVALID_INPUT`，不把跨项目内容放入提示词；
2. `milestoneId` 为空时，三个数组必须为空；`currentMilestone`、`milestoneGoal`、`milestoneDoneCriteria`、`milestoneRevision`、`milestoneStatus` 必须为 `null`；
3. `milestoneTasks` 必须包含已完成任务，服务端据此执行“不得重复推荐已完成任务”；
4. 只有未归档阶段的上下文可以发送；归档阶段返回 400 `INVALID_INPUT`；
5. `milestoneContext` 与顶层 `currentMilestone` 不一致时返回 400 `INVALID_INPUT`；
6. 请求体总上限仍为 256 KB；`milestoneContext` 中的文本也计入该上限。

### 23.3 已确认材料上下文与确认门禁

V3 继续使用 `confirmedMaterials` 字段（结构同 17.1），但增加服务端复核：

| 提示词版本 | 行为 |
| --- | --- |
| `mvp-prompt-v1` / `mvp-prompt-v2` | 与 17.1 完全一致：服务端校验结构与上限，信任客户端已确认 |
| `mvp-prompt-v3` / `advisor-chat-v3` | 服务端按 `materialId + version + segmentId` 重新读取数据库；只接受 `MaterialUnderstandingItem.status = "confirmed"` 的片段；`pending` 与 `modified` 均视为未确认 |

v3 规则：

1. 客户端传来的 `name`、`startLine`、`endLine`、`text` **不作为可信内容**；服务端一律用数据库值覆盖；
2. 片段未确认、属于待确认草稿、属于归档材料或旧版本：返回 400 `UNCONFIRMED_MATERIAL` 或 409 `MATERIAL_VERSION_OUTDATED`；
3. 模型只能返回 `segmentId`；材料名、版本、行号由服务端回填；
4. 响应中的 `basisMaterialRefs` / `citations` 只允许包含本次请求中已确认的片段；
5. 未确认材料不得进入系统提示词、用户消息或任何缓存键；
6. 旧客户端继续使用 v1/v2，行为不变；v3 前端不得再依赖客户端自报的材料名和行号。

### 23.4 提示词版本

| 接口 | 兼容保留 | V3 启用 | 要求 |
| --- | --- | --- | --- |
| 建议 | `mvp-prompt-v1`、`mvp-prompt-v2` | `mvp-prompt-v3` | v3 必须携带 `milestoneContext` |
| 聊天 | `advisor-chat-v1`、`advisor-chat-v2` | `advisor-chat-v3` | v3 必须携带 `milestoneContext` |
| 阶段候选 | — | `milestone-candidate-v1` | 只使用已确认材料，不写项目 |
| 材料理解 | `material-understanding-v1` | 不变 | 沿用第 15 节 |

规则：

1. 服务端支持列表包含全部取值，不删除旧值；
2. 接口与版本不匹配（例如建议接口收到 `advisor-chat-v3`）返回 400 `INVALID_INPUT`；
3. v3 提示词缺少 `milestoneContext` 返回 400 `CONTRACT_VERSION_MISMATCH`，不做静默降级；
4. v1/v2 请求携带 `milestoneContext` 时返回 400 `CONTRACT_VERSION_MISMATCH`，**不静默忽略**；
5. 版本取值同步四处：本契约、`server/src/advisor/types.ts`、`src/domain/recommendation.ts`、`docs/ai/prompt-spec.md`。

### 23.5 建议接口 v3 请求示例

```json
{
  "contractVersion": "1.0",
  "promptVersion": "mvp-prompt-v3",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 15,
  "projectName": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
  "currentMilestone": "数据获取与预处理",
  "milestoneContext": {
    "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
    "currentMilestone": "数据获取与预处理",
    "milestoneRevision": 4,
    "milestoneGoal": "拿到可复现的样例数据并确认字段口径",
    "milestoneDoneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
    "milestoneStatus": "active",
    "milestoneTasks": [
      {
        "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
        "title": "跑通 ERA5 与浮标数据的下载链路",
        "status": "doing",
        "doneCriteria": "下载一段样例数据，并能用 Python 读出关键变量",
        "owner": null,
        "milestone": "数据获取与预处理",
        "updatedAt": "2026-10-18T09:20:00.000Z"
      }
    ],
    "recentProgress": [
      {
        "progressId": "prg_01JBC9R7T3K8QW4M2N6P5X0ZYN",
        "summary": "完成样例数据下载，确认了 4 个关键字段和缺失率口径",
        "milestoneId": "ms_01JBC9R7T3K8QW4M2N6P5X0ZYB",
        "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
        "occurredAt": "2026-10-19T02:20:00.000Z"
      }
    ],
    "milestoneEvidence": [
      {
        "evidenceId": "evd_01JBC9R7T3K8QW4M2N6P5X0ZYP",
        "submissionId": "6e2b8c07-f1d3-490a-8c5e-2b7f0d3a9186",
        "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
        "didWhat": "下载了 2024 年 1 月的 ERA5 样例数据",
        "foundWhat": "有效波高与风速字段完整，缺失率低于 1%",
        "stillUnsure": "0.5 度分辨率是否满足公里级判断",
        "author": null,
        "createdAt": "2026-10-19T02:30:00.000Z"
      }
    ]
  },
  "confirmedMaterials": [
    {
      "materialId": "mat_01JBC9R7T3K8QW4M2N6P5X0ZYV",
      "name": "实验手册.md",
      "type": "md",
      "version": 1,
      "segments": [
        {
          "segmentId": "seg_1",
          "startLine": 10,
          "endLine": 24,
          "text": "## 数据说明\n主要字段：有效波高、风速、时间、经纬度。"
        }
      ]
    }
  ],
  "tasks": [
    {
      "taskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
      "title": "跑通 ERA5 与浮标数据的下载链路",
      "status": "doing",
      "doneCriteria": "下载一段样例数据，并能用 Python 读出关键变量",
      "owner": null,
      "milestone": "数据获取与预处理",
      "updatedAt": "2026-10-18T09:20:00.000Z"
    }
  ],
  "evidence": [],
  "doubts": [],
  "forceRefresh": false
}
```

### 23.6 建议接口 v3 响应示例

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 15,
  "source": "model",
  "fallbackReason": null,
  "cached": false,
  "promptVersion": "mvp-prompt-v3",
  "milestoneRevision": 4,
  "suggestions": [
    {
      "title": "把 0.5 度分辨率的缺口写成待确认事项并向助教核实",
      "whyNow": "当前阶段的完成标准要求确认字段口径，而现有证据已经指出分辨率与公里级判断存在差距；现在不确认，后续阈值结果都要重算。",
      "doneCriteria": "一页说明：0.5 度对应的实际距离、缺口量化、两个可选替代数据源、一句换或不换的结论",
      "existingTaskId": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZYJ",
      "basisEvidenceIds": ["evd_01JBC9R7T3K8QW4M2N6P5X0ZYP"],
      "basisDoubtIds": [],
      "basisMaterialRefs": [
        {
          "materialId": "mat_01JBC9R7T3K8QW4M2N6P5X0ZYV",
          "materialName": "实验手册.md",
          "materialVersion": 1,
          "segmentId": "seg_1",
          "startLine": 10,
          "endLine": 24,
          "itemId": null
        }
      ]
    }
  ]
}
```

字段规则：

- `milestoneRevision`：v3 响应新增，回显请求中的阶段版本；v1/v2 响应不返回该字段；
- `basisMaterialRefs`：v3 建议新增，0～3 条；每条只允许引用本次请求中已确认的 `segmentId`；材料名、版本、行号由服务端回填；
- `basisMaterialRefs` 缺失时前端按空数组处理，但 v3 服务端必须返回该字段（可为 `[]`）；
- 既有字段名、类型和语义不变。

### 23.7 聊天接口 v3 与阶段候选

聊天请求在 6.4 基础上增加 `milestoneContext`，响应增加 `milestoneRevision` 与 `citations`：

```json
{
  "contractVersion": "1.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 15,
  "source": "model",
  "fallbackReason": null,
  "promptVersion": "advisor-chat-v3",
  "milestoneRevision": 4,
  "answer": "先完成当前阶段的两件事：一是把 0.5 度分辨率的缺口写成待确认事项并向助教核实；二是补齐样例数据的字段说明和缺失率记录。两步都完成后，再进入阈值方法对比。",
  "citations": [
    {
      "materialId": "mat_01JBC9R7T3K8QW4M2N6P5X0ZYV",
      "materialName": "实验手册.md",
      "materialVersion": 1,
      "segmentId": "seg_1",
      "startLine": 10,
      "endLine": 24,
      "itemId": null
    }
  ]
}
```

规则：

- `citations` 0～5 条，只允许已确认片段；v3 必须返回该字段（可为 `[]`）；
- 模型只返回 `segmentId`，服务端回填名称、版本、行号；
- 模型返回未知 `segmentId`：剔除该条引用并记日志；不把未知引用写入历史消息；
- 模型声称有材料依据但没有返回任何合法引用：仍可保留回答，但 `citations` 为空，前端不得展示“依据来自某材料”；
- v3 聊天响应不返回模型原始文本、内部字段名、错误码或路径。

阶段候选接口：

`POST /api/projects/{projectId}/milestones/candidates`

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "idempotencyKey": "ms-candidates-01JBC9R7T3K8QW4M2N6P5X0ZYW",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 15,
  "promptVersion": "milestone-candidate-v1",
  "maxCandidates": 3,
  "focus": "围绕数据获取和预处理生成阶段"
}
```

成功响应：

```json
{
  "contractVersion": "3.0",
  "requestId": "5f2c1d0a-8a3e-4b7c-9f21-2d6e5a4c8b90",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZYA",
  "projectRevision": 15,
  "promptVersion": "milestone-candidate-v1",
  "source": "model",
  "fallbackReason": null,
  "notice": null,
  "candidates": [
    {
      "candidateId": "cand_01JBC9R7T3K8QW4M2N6P5X0ZYX",
      "name": "数据获取与预处理",
      "goal": "拿到可复现的样例数据并确认字段口径",
      "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
      "suggestedTasks": [
        {
          "title": "跑通 ERA5 与浮标数据的下载链路",
          "doneCriteria": "下载一段样例数据，并能用 Python 读出关键变量"
        }
      ],
      "risks": ["0.5 度分辨率可能不满足公里级判断"],
      "sources": [
        {
          "materialId": "mat_01JBC9R7T3K8QW4M2N6P5X0ZYV",
          "materialName": "实验手册.md",
          "materialVersion": 1,
          "segmentId": "seg_1",
          "startLine": 10,
          "endLine": 24,
          "itemId": null
        }
      ],
      "expiresAt": "2026-10-19T03:00:00.000Z"
    }
  ]
}
```

规则：

- 候选**不写入项目**，不递增 `projectRevision`，不进入时间线；
- 候选缓存 30 分钟；`expiresAt` 到期后确认返回 409 `CANDIDATE_EXPIRED`；
- `candidates` 0～3 条；模型失败时返回 `source: "fallback"`、`fallbackReason`、中文 `notice`，候选可为空；
- 候选只能引用已确认材料片段；服务端从数据库读取当前项目已确认条目，不信任客户端传来的草稿，并回填材料名、版本、行号；
- 用户确认后调用 22.2 的创建阶段接口，带 `source: "ai-candidate"`、`candidateId`、`confirmedByUser: true`；
- 服务端不得把候选直接写成阶段，也不得在空白项目自动生成候选。

### 23.8 模型输出校验与用户可见文本

在 4.6 / 15.3 基础上增加：

| 检查 | 规则 | 不通过时 |
| --- | --- | --- |
| 阶段上下文引用 | 候选/建议引用的 `milestoneId`、`taskId` 必须在本次请求范围内 | 剔除引用；候选无来源则丢弃该条 |
| 材料引用 | `segmentId` 必须在本次已确认片段内 | 剔除该引用并记日志 |
| 阶段候选数量 | 0～3 条 | 超出丢弃 |
| 候选任务数量 | 每条候选 ≤ 5 个建议任务 | 超出丢弃 |
| 用户可见文本 | 自然中文，不含字段名、状态名、错误码、路径、堆栈、模型原文 | 判非法输出，走安全中文 fallback |

模型超时、上游不可用、输出非法、未配置密钥继续走现有安全兜底：

- 建议/聊天：HTTP 200 + `source: "fallback"` + `fallbackReason`，不返回 4xx/5xx（除非兜底本身失败）；
- 阶段候选：HTTP 200 + `source: "fallback"` + 中文 `notice`，可为空候选；
- 用户可见文本不得出现 `milestoneContext`、`milestoneGoal`、`milestoneDoneCriteria`、`recentProgress`、`milestoneEvidence`、`basisMaterialRefs`、`citations`、`materialId`、`segmentId` 等内部词；
- 前端只展示中文 `message` / `notice` / `answer`，不展示 `code`、堆栈、服务器路径或模型原文。

---

## 24. 本地项目迁移契约

### 24.1 迁移流程

```text
登录成功
→ 检测浏览器 localStorage 旧项目
→ 用户看到迁移说明并明确点击“确认迁移”
→ 前端生成并持久化 migrationId
→ POST /api/projects/migrate-local
→ 成功：保存 idMap，标记 migrated，保留本地原始数据
→ 失败：保留本地数据，允许用同一 migrationId 重试
→ 重复点击：同一 migrationId 幂等，不创建第二个项目
```

硬性规则：

1. 迁移前必须由用户明确确认；请求必须带 `userConfirmed: true` 和 `userConfirmedAt`；
2. 迁移成功前，前端**不得**删除或覆盖 `scp.mvp.projects` / `scp.mvp.currentProjectId`；
3. 迁移成功后，本地原始数据至少保留 7 天，或由用户手动清理；服务端永远不删除浏览器本地数据；
4. 迁移失败可重试；失败不得留下半迁移项目；
5. 重复迁移必须幂等；同一 `clientProjectId` 不产生第二个项目；
6. 项目、阶段、任务、证据、进展、材料、草稿、疑问和聊天保持原有关系；
7. 迁移时校验 `source.schemaVersion`；不合法或过期数据给中文提示。

### 24.2 POST /api/projects/migrate-local

> 迁移是唯一不携带 `projectId` / `projectRevision` 的 V3 写接口：目标项目尚不存在，版本由服务端在创建时初始化为 1。

请求：

```json
{
  "contractVersion": "3.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "idempotencyKey": "migrate-01JBC9R7T3K8QW4M2N6P5X0ZYZ",
  "migrationId": "mig_01JBC9R7T3K8QW4M2N6P5X0ZZ0",
  "userConfirmed": true,
  "userConfirmedAt": "2026-10-19T02:30:00.000Z",
  "source": {
    "schemaVersion": 3,
    "clientProjectId": "prj_local_01JBC9R7T3K8QW4M2N6P5X0ZZ1",
    "appVersion": "v2.2",
    "exportedAt": "2026-10-19T02:25:00.000Z"
  },
  "localProject": {
    "name": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
    "short": "极端风浪",
    "projectRevision": 12,
    "profile": {
      "goal": "构建极端风浪事件识别与预警的原型系统",
      "expectedOutcome": "可交互原型 + 会议论文",
      "memberNames": ["张同学", "李同学"],
      "researchPeriod": "第 3 周至第 14 周",
      "scope": "先做西北太平洋",
      "outOfScope": "不做实时业务系统"
    },
    "milestones": [
      {
        "clientId": "ms_local_1",
        "name": "数据获取与预处理",
        "goal": "拿到可复现的样例数据并确认字段口径",
        "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
        "dueAt": "2026-11-02T15:59:59.000Z",
        "status": "active",
        "orderIndex": 0
      }
    ],
    "tasks": [
      {
        "clientId": "tsk_local_1",
        "milestoneClientId": "ms_local_1",
        "title": "跑通 ERA5 与浮标数据的下载链路",
        "doneCriteria": "下载一段样例数据，并能用 Python 读出关键变量",
        "status": "doing",
        "createdAt": "2026-10-15T08:00:00.000Z",
        "updatedAt": "2026-10-18T09:20:00.000Z"
      }
    ],
    "evidence": [
      {
        "clientId": "evd_local_1",
        "submissionId": "6e2b8c07-f1d3-490a-8c5e-2b7f0d3a9186",
        "taskClientId": "tsk_local_1",
        "milestoneClientId": "ms_local_1",
        "didWhat": "下载了 2024 年 1 月的 ERA5 样例数据",
        "foundWhat": "有效波高与风速字段完整，缺失率低于 1%",
        "stillUnsure": "0.5 度分辨率是否满足公里级判断",
        "attachmentName": null,
        "createdAt": "2026-10-19T02:30:00.000Z"
      }
    ],
    "progress": [
      {
        "clientId": "prg_local_1",
        "summary": "完成样例数据下载，确认了 4 个关键字段和缺失率口径",
        "milestoneClientId": "ms_local_1",
        "taskClientId": "tsk_local_1",
        "occurredAt": "2026-10-19T02:20:00.000Z"
      }
    ],
    "doubts": [
      {
        "clientId": "dbt_local_1",
        "text": "0.5 度分辨率是否满足公里级判断",
        "status": "open",
        "sourceEvidenceClientId": "evd_local_1",
        "createdAt": "2026-10-19T02:30:00.000Z"
      }
    ],
    "materials": [
      {
        "clientId": "mat_local_1",
        "name": "实验手册.md",
        "type": "md",
        "size": 2048,
        "encoding": "utf-8",
        "status": "parsed",
        "version": 1,
        "createdAt": "2026-10-15T08:00:00.000Z",
        "updatedAt": "2026-10-15T08:00:00.000Z",
        "segments": [
          {
            "segmentId": "seg_0",
            "index": 0,
            "startLine": 1,
            "endLine": 8,
            "text": "# 实验手册\n本实验使用 ERA5 海浪场数据。"
          }
        ],
        "understandingItems": [
          {
            "clientId": "cnd_local_1",
            "clientItemId": "cnd_goal_0",
            "kind": "goalCandidates",
            "text": "使用 ERA5 海浪场数据复现极端风浪事件识别流程",
            "sourceSegmentIds": ["seg_0"],
            "status": "confirmed"
          }
        ]
      }
    ],
    "chats": [
      {
        "clientId": "msg_local_1",
        "role": "user",
        "text": "我下一步应该做什么？"
      }
    ]
  }
}
```

字段说明：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `contractVersion` | string | 是 | `"3.0"` |
| `requestId` | string | 是 | UUID v4 |
| `idempotencyKey` | string | 是 | 8～64 可打印字符 |
| `migrationId` | string | 是 | `mig_` 前缀，8～64；重试必须复用 |
| `userConfirmed` | boolean | 是 | 必须为 `true` |
| `userConfirmedAt` | string | 是 | 与服务端时间差 ≤ 30 分钟；未来时间 > 5 分钟拒绝 |
| `source.schemaVersion` | number | 是 | 1～3；当前 `PROJECT_SCHEMA_VERSION = 3` |
| `source.clientProjectId` | string | 是 | 本地项目 ID，用于去重 |
| `source.appVersion` | string | 否 | 诊断用 |
| `source.exportedAt` | string | 否 | 本地数据导出时间 |
| `localProject` | object | 是 | 见 24.3 |

### 24.3 `localProject` 结构与关系映射

> `localProject` 是前端按本节 DTO **归一化后**生成的迁移载荷，不是直接上传原始 localStorage。24.3.1 给出与 `src/stores/persistence.ts` 实际字段的逐项映射；不得把 `ms[].t`、`materialRecords[].state`、`understandingBlocks[].content` 等实际字段名直接写成契约字段名。

| 字段 | 类型 | 必填 | 映射 |
| --- | --- | --- | --- |
| `name` | string | 是 | 项目名称，1～120 字 |
| `short` | string \| null | 是 | 项目短名/标签名，1～20 字；空则服务端截取；不是描述 |
| `projectRevision` | number | 是 | 只写入 `migratedFromRevision`；新项目从 1 开始 |
| `profile` | ProjectProfile | 是 | 字段同 13.1；缺失字段补 `null` |
| `milestones` | array | 是 | `clientId`、`name`、`goal`、`doneCriteria`、`dueAt`、`status`、`orderIndex` |
| `tasks` | array | 是 | `clientId`、`milestoneClientId`、`title`、`doneCriteria`、`status`、`createdAt`、`updatedAt` |
| `evidence` | array | 是 | `clientId`、`submissionId`、`taskClientId`、`milestoneClientId`、`didWhat`、`foundWhat`、`stillUnsure`、`attachmentName`、`createdAt` |
| `progress` | array | 否 | `clientId`、`summary`、`milestoneClientId`、`taskClientId`、`occurredAt`；缺省 `[]`；当前 localStorage 没有独立进展字段，不得伪造 |
| `doubts` | array | 是 | `clientId`、`text`、`status`、`sourceEvidenceClientId`、`createdAt` |
| `materials` | array | 是 | 见 24.4 |
| `chats` | array | 是 | `clientId`、`role`、`text`、可选 `createdAt`、可选 `source` / `fallbackReason`；迁移到项目默认会话 |

映射规则：

1. 旧 `ms` 展示阶段与 `tasks[].milestone` 名称合并为阶段：规范化名称（去首尾空白、合并连续空白）后匹配；同名只建一个阶段；
2. 旧任务没有 `milestoneId`，按名称匹配；任务有 `milestone` 但阶段列表中没有同名项时，创建一个 `source: "migration"`、`status: "planned"` 的阶段，保证任务不丢；这属于保留用户数据，不是模板注入；
3. 旧项目完全没有阶段且任务没有 `milestone` 时，迁移结果必须为 0 个阶段；
4. 旧 `steps`、`evidence`、`doubts` 若只是展示投影，忽略；以 `tasks`、`evidenceRecords`、`doubtRecords` 为准；
5. 旧 `chat` 迁移为一个默认 `ChatSession`，按数组顺序保留；本地 `chat` 没有可靠时间戳，服务端按导入顺序补 `sequence` 与 `importedAt`；超过 500 条保留最近 500 条并返回 `CHAT_HISTORY_TRUNCATED` 警告；
6. 旧 `materialRecords` / `materialSegments` / `understandingBlocks` 迁移到 Material / Segment / UnderstandingItem；确认状态原样保留，不得把 `pending` 提升为 `confirmed`；
7. 旧 `projectRevision` 不继承；新项目 `projectRevision = 1`，`migratedFromRevision` 保存旧值；
8. 所有服务端新 ID 由服务端生成；响应 `idMap` 用于更新本地引用。

### 24.3.1 当前 localStorage 实际结构核对（2026-10-19）

核对基准：

- `src/types/platform.ts`：`PROJECT_SCHEMA_VERSION = 3`；
- `src/stores/persistence.ts`：存储键 `scp.mvp.projects` / `scp.mvp.currentProjectId`，外层信封 `{ schemaVersion, projects }`；
- `src/stores/workbench.ts`：材料草稿确认动作使用 `blockId`（本地 `UnderstandingBlock.id`），不是服务端 `itemId`。

实际字段 → 迁移 DTO 映射：

| 实际字段（localStorage） | 实际类型/取值 | 迁移 DTO | 规则 |
| --- | --- | --- | --- |
| `projectId` | string | `source.clientProjectId` | 用于去重；不直接作为云端 `projectId` |
| `name` | string | `localProject.name` | 1～120 字 |
| `short` | string | `localProject.short` | 1～20 字，项目短名/标签名；不是描述 |
| `projectRevision` | number | `localProject.projectRevision` | 只写入 `migratedFromRevision`，新项目从 1 开始 |
| `profile` | ProjectProfile | `localProject.profile` | 字段一一对应；缺失补 `null` |
| `ms[]` | `{ t, s, p, sub }[]` | `localProject.milestones[]` | `t → name`；`done/cur/todo → completed/active/planned`；`goal` / `doneCriteria` / `dueAt` 在 `ms` 中不存在，迁移为 `null`；`p` 进度重算、`sub` 展示文案忽略；数组顺序 → `orderIndex` |
| `tasks[]` | `Task[]` | `localProject.tasks[]` | `id → clientId`；`milestone`（名称）→ `milestoneClientId`；`doneCriteria` / `createdAt` / `updatedAt` 原样；`owner → assigneeUserId: null`；`suggestedOwner` / `why` / `draftKey` 为展示或本地幂等字段，不迁移 |
| `evidenceRecords[]` | `Evidence[]` | `localProject.evidence[]` | `id → clientId`；`submissionId` 保留；`taskId → taskClientId`；`milestoneClientId` 由该任务当前 `milestone` 推导，无任务或未匹配时为 `null`；`author` 不迁移 |
| `doubtRecords[]` | `Doubt[]` | `localProject.doubts[]` | `id → clientId`；`sourceEvidenceId → sourceEvidenceClientId`；`resolvedAt` 保留 |
| `materialRecords[]` | `Material[]` | `localProject.materials[]` | `materialId → clientId`；`state → status`（`null → registered`）；`needsReupload` 是本地展示字段，不迁移；`version`、时间保留 |
| `materialSegments[]` | `MaterialSegment[]` | `localProject.materials[].segments[]` | 用 `materialId + materialVersion` 归组；`segmentId/index/startLine/endLine/text` 原样；不再重复 `materialId/materialVersion` |
| `understandingBlocks[]` | `UnderstandingBlock[]` | `localProject.materials[].understandingItems[]` | `id → clientId`；`itemId → clientItemId`；`kind` 原样（`goalCandidates` 等五值）；`content → text`；`originalContent → originalText`；`sources → sourceSegmentIds`；`status` 原样；**不得把 `pending`/`modified` 提升为 `confirmed`** |
| `chat[]` | `{ who, text, me, source?, fallbackReason? }[]` | `localProject.chats[]` | `me: true → role: "user"`，`me: false → role: "assistant"`；`text` 原样；`who` 仅展示、不迁移；`source` / `fallbackReason` 保留；本地无 `createdAt`，按数组顺序补 `sequence` |
| `progress`（无独立字段） | 当前 `Project` 没有 `progress` / `progressRecords` | `localProject.progress` | 缺省 `[]`；不得从证据或聊天猜测生成；只有未来导出显式提供时才迁移 |
| `steps` / `evidence` / `doubts` | 兼容投影 | 不读取 | 由 `syncProjectView()` 重建；迁移以 `tasks` / `evidenceRecords` / `doubtRecords` 为准 |
| `materials`（旧 `MaterialItem[]`） | 展示占位 | 不读取 | 以 `materialRecords` 为准；避免把“实验手册/数据集”占位标签当成真实材料 |
| `group` / `members` / `updated` / `banner` / `papers` / `weekly` / `aiPapers` | 展示字段 | 不迁移 | 不属于 V3 领域模型；不得写入不存在的契约字段 |

版本规则：

1. `PROJECT_SCHEMA_VERSION = 3` 已核对；`source.schemaVersion` 取 1 / 2 / 3 时按当前迁移逻辑补齐；
2. `schemaVersion` 缺失、为 0 或无法识别 → 409 `MIGRATION_DATA_OUTDATED`；
3. `schemaVersion > 3` → 409 `MIGRATION_VERSION_UNSUPPORTED`；
4. 迁移 DTO 中不得出现 `state`、`content`、`originalContent`、`ms`、`t`、`s`、`p`、`sub`、`materialRecords`、`understandingBlocks`、`chat`、`me`、`who` 等原始字段名；这些只出现在本映射表的左侧。

### 24.4 材料迁移规则

| 情形 | 处理 |
| --- | --- |
| `type` 为 `md` / `txt`，内容完整 | 正常迁移，保留分段、来源行号和确认状态 |
| `type` 为 `csv` / `xlsx` / `pdf` / `docx` / `zip` 或未知 | 保留材料元数据，`status: "unsupported"`，不迁移正文，返回 `UNSUPPORTED_MATERIAL_SKIPPED` 警告 |
| 材料仅登记、无正文 | `status: "registered"`，保留文件名 |
| 分段文本超过 2,000 字 | 拒绝该材料并返回 `MATERIAL_INVALID_SKIPPED` 警告，不丢项目其他数据 |
| 来源数组为空 / 全部 `segmentId` 不存在 / 全部片段正文 `trim` 后为空 | 保留正文，状态降为 `pending`（`archived` 保持归档），返回 `UNDERSTANDING_SOURCE_MISSING` 警告，不能保留 `confirmed` |
| 部分 `segmentId` 不存在或正文为纯空白 | 移除失效来源；剩余至少一个有效来源时保留原状态 |

材料片段正文必须原样写入，不得为了来源校验改写正文；校验只读取数据库文本并做 `text.trim().length > 0` 判断。
| 单文件超过 1 MB | 保留元数据并标 `unsupported`，返回 `MATERIAL_TOO_LARGE_SKIPPED` 警告 |

材料迁移 DTO 字段：

- `materials[]`：`clientId`（本地 `materialId`）、`name`、`type`、`size`、`encoding`、`status`（本地 `state` 映射）、`version`、`createdAt`、`updatedAt`；
- `materials[].segments[]`：`segmentId`、`index`、`startLine`、`endLine`、`text`；
- `materials[].understandingItems[]`：`clientId`（本地 `UnderstandingBlock.id`）、`clientItemId`（本地 `itemId`）、`kind`（五值原样）、`text`（本地 `content`）、`originalText`（本地 `originalContent`）、`sourceSegmentIds`（本地 `sources[].segmentId`）、`status`（原样）；
- `originalText` 缺失（旧数据）时，服务端保留 `text`、返回 `UNDERSTANDING_ORIGINAL_TEXT_MISSING` 警告并把该条置 `pending`，不得假装原文已完整保留；`archived` 仍保持 `archived`；
- 同时提供 `text` 与 `originalText` 时分别写入；已修改后确认的条目迁移后 `undo` 应回到 `modified`，未修改条目应回到 `pending`。

迁移是**单事务**：除上述明确的“跳过并警告”外，任何结构错误都整单失败，不产生半迁移项目。

### 24.5 成功响应与 idMap

```json
{
  "contractVersion": "3.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZZ2",
  "projectRevision": 1,
  "migrationId": "mig_01JBC9R7T3K8QW4M2N6P5X0ZZ0",
  "status": "completed",
  "replayed": false,
  "deduplicated": false,
  "appliedChanges": true,
  "idMap": {
    "milestones": {
      "ms_local_1": "ms_01JBC9R7T3K8QW4M2N6P5X0ZZ3"
    },
    "tasks": {
      "tsk_local_1": "tsk_01JBC9R7T3K8QW4M2N6P5X0ZZ4"
    },
    "evidence": {
      "evd_local_1": "evd_01JBC9R7T3K8QW4M2N6P5X0ZZ5"
    },
    "progress": {
      "prg_local_1": "prg_01JBC9R7T3K8QW4M2N6P5X0ZZ6"
    },
    "materials": {
      "mat_local_1": "mat_01JBC9R7T3K8QW4M2N6P5X0ZZ7"
    },
    "understandingItems": {
      "cnd_local_1": "cnd_01JBC9R7T3K8QW4M2N6P5X0ZZ8"
    },
    "doubts": {
      "dbt_local_1": "dbt_01JBC9R7T3K8QW4M2N6P5X0ZZ9"
    },
    "chats": {
      "msg_local_1": "msg_01JBC9R7T3K8QW4M2N6P5X0ZZA"
    }
  },
  "counts": {
    "milestones": 1,
    "tasks": 1,
    "evidence": 1,
    "progress": 1,
    "materials": 1,
    "materialSegments": 1,
    "understandingItems": 1,
    "doubts": 1,
    "chatMessages": 1
  },
  "warnings": [],
  "importedAt": "2026-10-19T02:30:05.000Z"
}
```

规则：

- `projectRevision` 为 1；迁移不继承本地版本；
- `idMap` 只包含实际迁移的实体；被跳过的材料不出现在 `materials`，但会出现在 `warnings`；
- `warnings` 每项包含 `code`、中文 `message`、`count`；不含正文；
- 成功前前端不得删除本地数据；成功后可保留本地数据至少 7 天。

### 24.6 幂等、重复迁移与失败重试

| 场景 | 行为 |
| --- | --- |
| 同一 `migrationId` + 相同请求体 | 200，`replayed: true`，返回首次 `idMap`，不重复创建 |
| 同一 `migrationId` + 不同请求体 | 409 `IDEMPOTENCY_CONFLICT`，不写入 |
| 同一 `(userId, clientProjectId)` + 不同 `migrationId` | 200，`deduplicated: true`，`appliedChanges: false`，返回已有 `projectId` 和 `idMap`；如内容不同，附 `LOCAL_CHANGES_NOT_APPLIED` 警告 |
| 网络超时后重试 | 使用同一 `migrationId`；或调用 `GET /api/projects/migrations/{migrationId}` 查询状态 |
| 服务端 5xx | 事务回滚，无半迁移；本地数据不动；可重试 |
| 数据非法 | 400 `MIGRATION_INVALID_DATA`；本地数据不动；修正或导出后重试 |
| 版本过高/过旧 | 409 `MIGRATION_VERSION_UNSUPPORTED` / `MIGRATION_DATA_OUTDATED`；给出中文提示 |

`GET /api/projects/migrations/{migrationId}` 响应：

```json
{
  "contractVersion": "3.0",
  "migrationId": "mig_01JBC9R7T3K8QW4M2N6P5X0ZZ0",
  "status": "completed",
  "projectId": "prj_01JBC9R7T3K8QW4M2N6P5X0ZZ2",
  "importedAt": "2026-10-19T02:30:05.000Z"
}
```

未找到返回 404 `RESOURCE_NOT_FOUND`；该接口只查当前用户的迁移记录。

### 24.7 数据校验与中文提示

| 检查 | 失败码 | 中文提示 |
| --- | --- | --- |
| `userConfirmed !== true` | `MIGRATION_NOT_CONFIRMED` | 请先在页面上确认迁移，再继续 |
| `userConfirmedAt` 超过 30 分钟 | `MIGRATION_CONFIRMATION_EXPIRED` | 迁移确认已过期，请重新确认后重试 |
| `schemaVersion` 缺失 / 0 / 无法识别 | `MIGRATION_DATA_OUTDATED` | 本地数据版本过旧，无法自动迁移；请先导出备份，再联系管理员 |
| `schemaVersion > 3` | `MIGRATION_VERSION_UNSUPPORTED` | 本地数据来自更高版本，请刷新页面或升级后再迁移 |
| 缺项目名、clientId 重复、引用不存在 | `MIGRATION_INVALID_DATA` | 本地数据不完整或存在重复记录，迁移未执行；请导出备份后重试 |
| 请求体超过 8 MB 或条目超上限 | `MIGRATION_TOO_LARGE` | 本地数据超过迁移上限，请先清理聊天或材料后重试 |
| 同一键不同内容 | `IDEMPOTENCY_CONFLICT` | 重复请求的内容不一致，请刷新后重试 |
| 未登录 | `UNAUTHORIZED` | 登录状态已失效，请重新登录 |

上限：

| 项 | 上限 |
| --- | --- |
| 请求体 | 8 MB |
| 阶段 | 50 |
| 任务 | 500 |
| 证据 | 1,000 |
| 进展 | 500 |
| 材料 | 50 |
| 单材料分段 | 200 |
| 理解条目 | 500 |
| 疑问 | 500 |
| 聊天消息 | 500（超出保留最近 500 条并警告） |

---

## 25. 统一错误码与中文提示

### 25.1 命名与使用规则

1. `code` 使用大写下划线，稳定不变；前端只根据 `code` 做逻辑判断，不解析 `message`；
2. `message` 是可直接展示给用户的中文；不得包含英文错误码、字段名、SQL、路径、堆栈、密钥、模型原文；
3. 同一语义只用一个错误码，不新增同义码；
4. 开发日志可以记录 `code`、`requestId`、`userId`、`projectId`、耗时和数量；不得记录密码、Cookie、邀请码、材料正文、聊天正文或模型原文；
5. 跨用户访问统一 404，不返回 403 或“存在但无权访问”。

### 25.2 错误码总表

| code | HTTP | retryable | 触发条件 | 对外中文 message |
| --- | --- | --- | --- | --- |
| `INVALID_INPUT` | 400 | false | 缺字段、类型/长度/数量超限、未知 `promptVersion`、字段冲突 | 请求内容不合法：<第一条具体问题> |
| `CONTRACT_VERSION_MISMATCH` | 400 | false | `contractVersion` 与接口族不匹配，或 `promptVersion` 与 `milestoneContext` 组合不成立 | 请求版本与接口不匹配，请刷新页面后重试 |
| `UNAUTHORIZED` | 401 | false | 未登录、会话过期、会话被撤销 | 登录状态已失效，请重新登录 |
| `AUTH_FAILED` | 401 | false | 账号不存在、密码错误、账号禁用 | 用户名或密码不正确 |
| `REGISTER_REJECTED` | 409 | false | 重复注册、邀请码错误、账号不可用 | 注册未完成，请检查用户名、密码和邀请码 |
| `FORBIDDEN_ORIGIN` | 403 | false | 写请求 Origin 缺失或不在白名单 | 请求来源不受信任 |
| `RATE_LIMITED` | 429 | true | 登录/注册/写接口触发频率限制 | 尝试次数过多，请稍后再试 |
| `PROJECT_NOT_FOUND` | 404 | false | 项目不存在或不属于当前用户 | 项目不存在或无权访问 |
| `PROJECT_ARCHIVED` | 409 | false | 对归档项目执行领域写操作（项目 restore/delete 除外） | 项目已归档，请先恢复再编辑 |
| `RESOURCE_NOT_FOUND` | 404 | false | 阶段/任务/证据/材料/进展/聊天不存在或不属于当前用户 | 请求的内容不存在或无权访问 |
| `PROJECT_MISMATCH` | 409 | false | **保留码，当前实现不返回**：跨项目实体一律 404 `RESOURCE_NOT_FOUND`（见 22.0）；前端不需要专门分支 | 请求内容与当前项目不匹配 |
| `STALE_REVISION` | 409 | false | `projectRevision` 或实体 revision 落后 | 项目内容已更新，请刷新后重试 |
| `IDEMPOTENCY_CONFLICT` | 409 | false | 同一幂等键对应不同请求体 | 重复请求的内容不一致，请刷新后重试 |
| `INVALID_ORDER` | 400 | false | 排序列表遗漏、重复、包含归档阶段或不是全量 | 阶段顺序不完整，请刷新后重试 |
| `MILESTONE_NAME_CONFLICT` | 409 | false | 同项目未归档阶段重名 | 同一项目中已有同名阶段 |
| `MILESTONE_ARCHIVED` | 409 | false | 对归档阶段新增任务/证据或作为当前阶段 | 该阶段已归档，请先恢复 |
| `MILESTONE_COMPLETED` | 409 | false | 未重开就向已完成阶段新增/移入任务 | 该阶段已完成，请先重新打开 |
| `MILESTONE_NOT_EMPTY` | 409 | false | 尝试硬删除仍有任务/证据/进展的阶段 | 该阶段下仍有内容，不能直接删除，请改为归档 |
| `INVALID_STATE_TRANSITION` | 409 | false | 状态机不允许的转换 | 当前状态不支持该操作 |
| `DRAFT_ITEM_ARCHIVED` | 409 | false | 单条或整份确认请求包含 archived 条目 | 这条理解已移除，不能恢复或再次确认，请重新生成 |
| `DRAFT_SOURCE_MISSING` | 409 | false | 待确认条目没有任何能解析到当前材料版本真实片段的有效来源 | 这条理解没有可验证的材料来源，不能确认，请重新生成理解草稿 |
| `TASK_ARCHIVED` | 409 | false | 对归档任务提交证据/进展/开始/完成 | 该任务已归档，请先恢复 |
| `TASK_NOT_CLAIMABLE` | 409 | false | 旧客户端认领已完成任务 | 该任务已完成 |
| `EVIDENCE_IMMUTABLE` | 409 | false | 尝试修改证据正文或删除证据 | 证据提交后不能修改正文 |
| `CONFIRMATION_REQUIRED` | 400 | false | AI 候选创建阶段未带 `confirmedByUser: true` | 请先确认候选阶段，再创建 |
| `CANDIDATE_EXPIRED` | 409 | false | 候选超过 30 分钟或不属于当前项目 | 候选阶段已过期，请重新生成 |
| `UNCONFIRMED_MATERIAL` | 400 | false | v3 AI 请求包含未确认材料片段 | 所选材料尚未确认，不能作为 AI 依据 |
| `MATERIAL_VERSION_OUTDATED` | 409 | false | v3 AI 请求引用的材料版本已过期 | 材料已更新，请重新确认后重试 |
| `UNSUPPORTED_MATERIAL_TYPE` | 400 | false | 上传或迁移非 md/txt | 当前只支持 md、txt 文件；CSV、XLSX 将在下一批支持，PDF、DOCX、ZIP 将在后续版本支持 |
| `MATERIAL_TOO_LARGE` | 400 | false | 材料超过 1 MB | 文件超过 1 MB 上限，请压缩或拆分后再上传 |
| `EMPTY_MATERIAL` | 400 | false | 材料为空或仅空白 | 文件内容为空，请检查后再上传 |
| `MATERIAL_ENCODING_UNREADABLE` | 400 | false | UTF-8 与 GBK 均无法解码 | 文件编码无法识别（已尝试 UTF-8 与 GBK），请另存为 UTF-8 后重试 |
| `MATERIAL_PARSE_FAILED` | 400 | false | 分段失败 | 材料解析失败，请检查文件内容后重试 |
| `MIGRATION_NOT_CONFIRMED` | 400 | false | 未带 `userConfirmed: true` | 请先在页面上确认迁移，再继续 |
| `MIGRATION_CONFIRMATION_EXPIRED` | 400 | false | `userConfirmedAt` 超过 30 分钟 | 迁移确认已过期，请重新确认后重试 |
| `MIGRATION_VERSION_UNSUPPORTED` | 409 | false | `schemaVersion > 3` | 本地数据来自更高版本，请刷新页面或升级后再迁移 |
| `MIGRATION_DATA_OUTDATED` | 409 | false | `schemaVersion` 缺失/0/无法识别 | 本地数据版本过旧，无法自动迁移；请先导出备份，再联系管理员 |
| `MIGRATION_INVALID_DATA` | 400 | false | 项目名缺失、clientId 重复、引用不存在 | 本地数据不完整或存在重复记录，迁移未执行；请导出备份后重试 |
| `MIGRATION_TOO_LARGE` | 413 | false | 请求体超过 8 MB 或条目超上限 | 本地数据超过迁移上限，请先清理聊天或材料后重试 |
| `INTERNAL` | 500 | true | 未预期异常；日志保留 requestId，响应不含堆栈 | 服务内部错误，请稍后重试 |
| `MODEL_TIMEOUT` | 504 | true | 模型超时且兜底也失败 | 模型调用超时，请稍后重试 |
| `INVALID_MODEL_OUTPUT` | 502 | true | 模型输出非法且兜底也失败 | 模型返回内容不合法，请稍后重试 |
| `MODEL_UNAVAILABLE` | 503 | true | 上游故障且兜底也失败 | 模型服务暂不可用，请稍后重试 |
| `MODEL_NOT_CONFIGURED` | 503 | false | 未配置 URL/Key/模型名且兜底也失败 | 服务端未配置模型密钥，暂时无法生成内容 |

### 25.3 `retryable` 语义

`retryable: true` 只表示“用户不改变输入，稍后重试可能成功”：

- `RATE_LIMITED`：按 `retryAfterSeconds` 等待；
- `INTERNAL`、`MODEL_TIMEOUT`、`INVALID_MODEL_OUTPUT`、`MODEL_UNAVAILABLE`：适配层最多自动重试 1 次；
- `STALE_REVISION`、`IDEMPOTENCY_CONFLICT`、`CONTRACT_VERSION_MISMATCH`、`PROJECT_ARCHIVED`、`DRAFT_ITEM_ARCHIVED`、`DRAFT_SOURCE_MISSING`、`MIGRATION_*`、`AUTH_FAILED`、`REGISTER_REJECTED`：**不自动重试**；需要刷新、恢复项目、修正输入、升级客户端、重新生成草稿或重新确认；
- 前端不得因为 `retryable: true` 无限重试；写操作重试必须复用同一 `idempotencyKey`。

### 25.4 安全与隐私

1. 认证错误不泄露账号是否存在；注册错误不区分账号冲突与邀请码错误；
2. 错误响应不含密码、哈希、Cookie、邀请码、API Key、数据库连接串、服务器路径、堆栈、SQL；
3. 材料/证据/聊天错误只回显类别与数量，不回显正文；
4. 日志中的 `detail` 只记录类别、数量、字段名；模型原始输出不得写入日志或响应；
5. 任何响应都不得包含 `ownerUserId` 之外的其他用户标识；跨用户请求返回 404。

### 25.5 错误响应示例

```json
{
  "contractVersion": "3.0",
  "requestId": "1b7c9e40-6c2f-4f18-8d5a-0e2b7c4a9f31",
  "projectId": null,
  "code": "AUTH_FAILED",
  "message": "用户名或密码不正确",
  "retryable": false,
  "retryAfterSeconds": null,
  "currentProjectRevision": null,
  "currentEntityRevision": null,
  "details": null
}
```

```json
{
  "contractVersion": "3.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": null,
  "code": "MIGRATION_DATA_OUTDATED",
  "message": "本地数据版本过旧，无法自动迁移；请先导出备份，再联系管理员",
  "retryable": false,
  "retryAfterSeconds": null,
  "currentProjectRevision": null,
  "currentEntityRevision": null,
  "details": null
}
```

---

## 26. 与现有 V2 的兼容方式

### 26.1 不变的部分

| 项 | 兼容策略 |
| --- | --- |
| V2 接口 | `/api/advisor/recommendations`、`/api/advisor/chat`、`/api/materials`、`/api/materials/understanding` 路径、字段、错误码、`contractVersion: "1.0"` 全部不变 |
| 本地存储 | 继续使用 `scp.mvp.projects` / `scp.mvp.currentProjectId`；`PROJECT_SCHEMA_VERSION = 3` 不变 |
| 空白项目 | 继续不注入模板阶段/任务/证据；V3 云端创建同样为空白 |
| MD/TXT | 继续使用现有上传、解析、分段和确认流程；`materialId`、`version`、`segmentId` 语义不变 |
| 建议/聊天兜底 | 继续使用服务端规则兜底 + 前端本地规则；v1/v2 请求行为不变 |
| 旧项目数据 | 通过迁移接口导入；导入前本地数据不动 |

### 26.2 字段映射

| V2 本地字段 | V3 字段 | 说明 |
| --- | --- | --- |
| `projectId` | `projectId` | 迁移时重写并返回 `idMap` |
| `name` / `short` | `name` / `short` | 直接映射；`short` 是 1～20 字短名/标签名，不是描述 |
| `projectRevision` | `migratedFromRevision` | 新项目版本从 1 开始 |
| `profile` | `profile` | 字段一致 |
| `ms[].t` / `ms[].s` | `milestones[].name` / `status` | `done/cur/todo → completed/active/planned`；`ms[].p` 重算、`ms[].sub` 忽略 |
| `tasks[].milestone`（名称） | `tasks[].milestoneId` | 按规范化名称匹配；缺失时创建迁移阶段 |
| `tasks[].id` | `tasks[].taskId` | 迁移时重写 |
| `evidenceRecords[].id` | `evidence.evidenceId` | 迁移时重写 |
| `evidenceRecords[].submissionId` | `evidence.submissionId` | 保留，继续作为幂等键 |
| `doubtRecords` | `doubts` | 状态与来源证据保留 |
| `materialRecords` | `materials` | 仅 md/txt 正文迁移；`state` → `status`；`needsReupload` 忽略；其他格式保留元数据并标 `unsupported` |
| `materialSegments` | `materials[].segments` | 按 `materialId + materialVersion` 归组；`segmentId` 在材料版本内保留 |
| `understandingBlocks` | `materials[].understandingItems` | `kind` 五值原样；`content → text`、`originalContent → originalText`、`id → clientId`；`pending`/`modified` 不得升级为 `confirmed` |
| `chat` | `chats` / ChatMessage | `me → role`、`text → content`、`who` 忽略；本地无 `createdAt`，按数组顺序补 `sequence` |

> 完整、逐字段的核对表见 24.3.1；该表是迁移实现的唯一对照基准。

### 26.3 过渡期规则

1. V3 后端未上线前，前端继续以本地模式运行，不伪造云端成功；
2. 登录成功后，前端可以同时持有本地项目和云端项目；必须用 `projectId` + `projectRevision` 区分，禁止把云端响应写入本地项目；
3. 迁移完成后，云端项目成为唯一可写来源；本地旧数据只读保留至少 7 天；
4. V2 旧页面仍可调用 V2 接口；V3 页面调用 V3 接口，二者不得共享同一份未加版本的 DTO；
5. 空白项目、未确认材料、AI 候选三条门禁在本地模式和云端模式一致；
6. 不支持 CSV/XLSX/PDF/DOCX/ZIP 的提示在两种模式下一致，不得静默忽略；
7. 收到 400 `CONTRACT_VERSION_MISMATCH` 时不得降级 `contractVersion`、不得丢弃 `milestoneContext` 重发旧提示词；只能提示用户刷新或升级客户端。

### 26.4 明确不实现

本 PR 不实现，也不在本契约中承诺：

- 教师端、教师批注、班级总览；
- 多人实时协作、成员邀请、角色管理；
- CSV/XLSX/PDF/DOCX/ZIP 解析；
- 邮箱、短信、社交登录、密码找回；
- 生产部署、Nginx、Cloudflare 隧道、18080 或服务器文件修改；
- 完整数据库 schema 与后端路由实现。

---

## 27. 验证与待决策

### 27.1 本 PR 的验证

```text
git diff --check
所有 fenced JSON 示例逐块 JSON.parse
npm.cmd --prefix server run build（无代码改动时用于确认基线）
git status / git diff --name-only 检查是否误改 server/src、src、部署配置或用户本地资料
```

### 27.2 仍需项目负责人决策的冲突

| # | 冲突/问题 | 当前冻结选择 | 影响 |
| --- | --- | --- | --- |
| 1 | 阶段 `planned → active` 是否自动 | 必须用户显式激活；开始任务不自动改阶段状态 | 影响前端阶段卡片交互与“当前阶段”推导 |
| 2 | 会话有效期 | 7 天绝对过期，不滑动 | 影响 `Max-Age` 与前端重新登录频率 |
| 3 | 项目软删除保留期 | 30 天，期间可恢复 | 影响清理任务与用户提示 |
| 4 | 聊天是否计入 `projectRevision` | 不计入，只维护 `chatRevision` | 影响 AI 响应过期判断与聊天写入并发 |
| 5 | V3 材料上传/重新解析持久化接口 | 本 PR 已冻结五个草稿确认接口；上传仍复用 V2 `POST /api/materials`，V3 材料持久化写入接口留给材料 PR | 影响 v3 AI 上下文能否端到端联调 |
| 6 | 迁移冲突策略 | 同一 `clientProjectId` 只迁移一次，不覆盖云端 | 影响“本地比云端新”时的用户选择 |
| 7 | 邀请码发放与轮换 | 由环境变量哈希配置，本 PR 不定义管理后台 | 影响注册可用性与运维流程 |

### 27.3 PR1 完成定义

- 领域模型、关系、状态机、删除/归档规则已冻结；
- 账号、项目、阶段、任务、证据、进展、时间线、候选、迁移接口字段已冻结；
- 幂等、版本、权限、过期响应和错误码已冻结；
- 所有 JSON 示例可解析；
- 未修改后端/前端实现，未部署，未改生产配置。

---

## 28. 变更记录

| 版本 | 日期 | 变更 | 作者 |
| --- | --- | --- | --- |
| v1.0 | 2026-09-25 | 首版：确定建议接口、store action、最小字段、错误码、失败分层、扩展位 | 负责人（后端） |
| v1.1 | 2026-09-25 | 同步已实现的健康检查、生产域名、CORS、缓存现状、ID 形态和线上验收状态；接口版本仍为 1.0 | 负责人（后端） |
| v1.2 | 2026-09-28 | 更新前端结构化状态迁移的实现说明；请求与响应字段及接口版本不变 | 负责人（后端） |
| v1.3 | 2026-09-28 | 明确过期响应状态收尾、draft 幂等责任、证据提交后的网络调用及超时层级；接口版本不变 | 负责人（后端） |
| v2.0 | 2026-10-12 | M1 冻结：新增项目基本信息（第 13 节）、材料元数据 / 分段 / 理解草稿（第 14 节）、`POST /api/materials` 与 `POST /api/materials/understanding`（第 15 节）、材料错误码（第 16 节）、建议与聊天的已确认材料接入与 `promptVersion` 取值（第 17 节）、mock JSON（第 18 节）；`contractVersion` 仍为 `"1.0"` | 姜厚禄（后端） |
| v2.1 | 2026-10-12 | 补充 `segmentId` 唯一性（重复返回 400 `INVALID_INPUT`）与日志卫生边界（只记类别与数量，不记材料正文、模型原始文本与原始引用编号）；接口字段与 `contractVersion` 不变 | 姜厚禄（后端） |
| v2.2 | 2026-10-14 | 澄清边界（不改字段）：新增 14.6「重新生成草稿与确认继承」，明确 `itemId` 只在单次响应内唯一、已确认继承需候选身份 + 文案 + 材料版本 + 规范化来源四项一致、确认集合变化才递增 `projectRevision`；同一时间确认空白项目语义与材料入口口径 | 集成修复（姜厚禄授权） |
| v3.0 | 2026-10-19 | PR1 冻结 V3/V4：新增领域模型文档（第 20 节入口）、账号契约（第 21 节）、项目/阶段/任务/证据/进展/时间线（第 22 节）、AI 阶段上下文与阶段候选（第 23 节）、本地迁移（第 24 节）、统一错误码（第 25 节）、V2 兼容方式（第 26 节）；V3 新接口 `contractVersion = "3.0"`，V2 接口保持 `"1.0"`；本 PR 不实现后端、不修改前端、不部署 | 姜厚禄（后端） |
| v3.1 | 2026-10-19 | PR1 最终收尾：明确 `contractVersion` / `promptVersion` 组合并禁止静默降级；补充 Session 与材料草稿五动作、Milestone/Task 状态机、Cookie/CORS/CSRF 约定；按当前 `PROJECT_SCHEMA_VERSION = 3` 与 localStorage 实际字段修正迁移映射；澄清 `Project.short` 语义 | 姜厚禄（后端） |
| v3.2 | 2026-10-19 | 明确 `undoDraftItem` 按 `text` 与 `originalText` 比较决定 `pending`/`modified`，清空确认信息且 `projectRevision` 只递增一次；明确 `confirmAllDraft` 不得包含或恢复 archived 条目、任一条目 archived 整单 409、所有 revision 校验通过后单事务写入、失败不递增版本；新增错误码 `DRAFT_ITEM_ARCHIVED` | 姜厚禄（后端） |
| v3.3 | 2026-10-19 | 材料理解条目确认必须至少有一个能解析到当前材料版本、且 `text.trim().length > 0` 的真实片段；迁移将空来源/全部失效来源降为 `pending` 并警告，`archived` 保持；单条确认与整份确认共用数据库来源校验，不信任 `sources_json` 元数据；新增错误码 `DRAFT_SOURCE_MISSING` | 姜厚禄（后端） |
| v3.4 | 2026-10-19 | PR2B 第一阶段：新增任务列表/单任务、材料列表/单材料、片段与理解草稿只读接口；材料列表默认当前版本，历史版本通过 `version` 只读访问；任务默认排除归档任务与归档阶段任务；统一 `limit`/`cursor`；读取不递增版本、不写幂等记录 | 姜厚禄（后端） |
| v3.5 | 2026-10-19 | 仅修正表述，不改字段与语义：22.8 `readOnly` 明确只由历史版本与材料/条目归档派生、不含项目归档（项目级写保护留待后续切片）；22.3 明确 Task DTO 无 `readOnly` 字段；22.8 Material DTO 的 `type` 收紧为 `md`/`txt`，迁移旧材料可能保留其他类型 | 姜厚禄（后端） |
| v3.6 | 2026-10-19 | 归档项目写保护：所有领域写接口返回 409 `PROJECT_ARCHIVED`（项目 restore/delete 例外）；材料/片段/草稿 `readOnly` 纳入项目归档；片段读取通过 `materials.project_id` 校验项目归属；不改字段名与响应结构 | 姜厚禄（后端） |
| v3.7 | 2026-10-20 | 只改文档、不改接口：重写第 0 节为 V2/V3 双代入口、四条通则与章节导航，并明确实现进度由 `docs/v3-v4-pr2-status.md` 维护；密码哈希改为如实描述 bcrypt cost 12（Argon2id 仅列为可选升级）；`PROJECT_MISMATCH` 标注为保留码，跨项目实体统一 404；目标阶段不属于本项目由 409 改为 404；Session 30 天保留标注为部署侧尚未实现 | 姜厚禄（后端） |
