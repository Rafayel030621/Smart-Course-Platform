# 智慧课程平台 · 前后端接口契约（首轮 MVP）

> 文档修订：v1.3（接口 `contractVersion` 仍为 `"1.0"`）
> 编制日期：2026-09-25
> owner：负责人（后端）
> 地位：**本文件是首轮 MVP 前后端唯一契约。** 三位成员不得自行新增字段或创建第二套 DTO。
> 适用范围：`POST /api/advisor/recommendations`、前端 store action 契约、任务 / 证据 / 疑问 / 建议的最小字段。
> **本文定义接口，不能替代部署验证。** 当前线上验证结果与仍需复验的事项见第 7 节。

本文引用并取代《首轮 MVP 任务分配与智能体提示词》第 4 节的草案；差异逐条列在第 9 节。

---

## 0. 一分钟版

1. 本轮只有**一条**新接口：`POST /api/advisor/recommendations`。任务、证据、疑问都保存在浏览器（localStorage），不经过该接口写入。
2. 页面只调用 6 个 store action，不直接 `fetch`，不直接改项目深层对象。
3. 建议有三个来源：`model`（模型）、`fallback`（服务端规则兜底）、`local-rule`（前端本地规则兜底）。三者共用同一份数据结构。
4. 任何响应都要用 `projectId` + `projectRevision` + `requestId` 三者校验，不匹配就丢弃。
5. 模型永远不能把任务标记为完成、不能解决疑问、不能改变项目事实。

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

### 1.3 三位成员各自需要什么

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
| `short` | string | 是 | 短名，用于标签与地图中心 |
| `projectRevision` | number | 是 | 见 2.6 |
| `currentMilestone` | string \| null | 是 | 当前里程碑名称；无则 `null` |
| `milestones` | Milestone[] | 是 | 里程碑列表（`{ name, status, progress }`，`status ∈ done/cur/todo`，`progress: 0..100`） |
| `schemaVersion` | number | 是 | localStorage 结构版本，只有李焰彬使用，**不进请求体** |

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
| 何时 +1 | 每一次会改变项目状态的本地写入：`createProject`、`claimTask`、`submitEvidence`（含幂等命中时不加）、`resolveDoubt` |
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
| 允许来源 | 当前部署只允许生产来源 `https://course.xinxian-music.xyz`；其他来源返回 403。本地开发需使用 Vite 代理或部署同源环境 |
| 方法 | `POST`、`OPTIONS`（预检必须显式处理） |
| 请求头 | `Content-Type`；MVP 不使用 Cookie，因此 `Access-Control-Allow-Credentials` 保持关闭 |
| 缓存 | API 响应禁止公共边缘缓存（`Cache-Control: no-store`）；当前未实现服务端建议缓存，`cached` 固定为 `false` |
| 限流 | 当前部署尚未启用 IP 限流；`RATE_LIMITED` 保留为契约错误码，启用限流后才返回 |
| 预算 | 单日调用上限与单次 token 上限尚未在本轮部署中启用；启用后超限应走 `fallback`，不返回 5xx 给前端 |

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
| `contractVersion` | `"1.0"` | 契约结构版本；不兼容变更时 +1，服务端对不支持的版本返回 400 |
| `promptVersion` | `"mvp-prompt-v1"` | 提示词版本，由吴佳璐在 `docs/ai/prompt-spec.md` 维护；服务端支持列表必须以本契约为准同步更新 |

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

## 11. 变更记录

| 版本 | 日期 | 变更 | 作者 |
| --- | --- | --- | --- |
| v1.0 | 2026-09-25 | 首版：确定建议接口、store action、最小字段、错误码、失败分层、扩展位 | 负责人（后端） |
| v1.1 | 2026-09-25 | 同步已实现的健康检查、生产域名、CORS、缓存现状、ID 形态和线上验收状态；接口版本仍为 1.0 | 负责人（后端） |
| v1.2 | 2026-09-28 | 更新前端结构化状态迁移的实现说明；请求与响应字段及接口版本不变 | 负责人（后端） |
| v1.3 | 2026-09-28 | 明确过期响应状态收尾、draft 幂等责任、证据提交后的网络调用及超时层级；接口版本不变 | 负责人（后端） |
