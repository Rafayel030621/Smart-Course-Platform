# V5 前端数据层交付说明

> 状态：**已完成开发与回归，待推送并创建 PR**（不合并，等李焰彬与队友确认后再走合并）。
> 分支：`feature/liyanbin-v5-papers`
> 基线：`origin/main` = `b0d90aa8393711f1a3d293dfb9e0465060d2f157`（PR #45 + 契约 v4.1 之后）。
> 本文只描述 V5 前端数据层实际交付并验证的部分，不代表 V5 整体完成。
> 范围：**只含数据层**（service / domain / store / 测试）。页面接线归雍蕾，`server/` 一行未改。

---

## 1. 三个功能提交

| # | SHA | 标题 | 主要文件 | 功能摘要 |
| --- | --- | --- | --- | --- |
| 1 | `7573991f7eddbf429ca1cd6362201cfbabbc4565` | `feat(papers): 新增论文检索前端数据层（契约第 29 节）` | `src/services/papersApi.ts`、`src/services/v3Http.ts`、`src/stores/cloud.ts`、两个测试文件 | `GET /api/papers/search` 客户端 + `cloud.papers` 状态机；`fallback` 独立状态并保留 notice；错误码中文化；`query` 长度按 UTF-16 码元（契约 v4.1 §29.2） |
| 2 | `f51654ceb44314dbc43bacb64437b3c73e6ee8eb` | `feat(export): 新增项目 JSON 导出 domain 层与论文检索 HTTP 集成测试` | `src/domain/projectExport.ts`、两个测试文件 | 纯函数白名单序列化（本地项目 / 云端投影），凭据零导出；论文检索真实 HTTP 集成用例 |
| 3 | `85d43bec2bb7b2ffc255179ceff45afa86c7eb1d` | `feat(chat): 接入云端聊天持久化（契约第 30 节）并冻结导出取舍` | `src/services/chatSessionsApi.ts`、`src/stores/cloud.ts`、`src/services/advisorApi.ts`、`src/types/platform.ts`、`src/services/v3Http.ts`、四个测试文件 | 会话 get-or-create + 历史恢复 + `sessionId`/`messageId` 记录 + 重试复用 requestId；导出取舍定稿 |

合计：13 个新增文件、10 个修改文件；单测 +45 条、集成 +19 条。

---

## 2. 给雍蕾的接入清单

### 2.1 论文检索

```ts
// 只读状态：cloudStore.papers（类型 CloudPapersState）
//   status: 'idle' | 'loading' | 'ready' | 'fallback' | 'error'
//   papers: PaperSearchItem[]      ← 失败时保留上一次结果，不清空
//   source: 'openalex' | 'fallback' | null
//   notice: string | null          ← fallback 时的中文说明
//   error:  { code, message } | null
//   requestId / query / loadedAt

const requestId = crypto.randomUUID() // 同一次检索的重试必须复用同一个值
const result = await cloudStore.searchPapers({ query: '波浪预测', limit: 5, requestId })
```

界面渲染要点：

1. **`status === 'fallback'` 必须渲染 `notice`，不能走「没有相关论文」的空列表分支**。这是契约 29.1 规则 4 的硬要求：降级不是零结果。
2. `status === 'error'` 时 `papers` 仍是上一次的可用数据，建议保留列表 + 顶部错误条，而不是清空。
3. `paper.openAccessUrl === null` 时只展示 DOI 链接，不要拼一个不存在的开放获取地址。
4. 点击「重试」时把同一个 `requestId` 传回去（服务端按它重放，避免重复打上游）；换检索词则生成新 `requestId`。
5. `papersApi` 已在本地拦掉 `query` 为空/超 200 字、`limit` 越界，界面上仍建议做字数提示。

### 2.2 项目 JSON 导出

```ts
import {
  buildLocalProjectExport,
  buildCloudProjectExport,
  serializeProjectExport,
} from '@/domain/projectExport'

// 本地项目：直接传本地持久化模型里的 Project
const doc = buildLocalProjectExport({
  project,                        // 来自本地 store 的 Project
  exportedAt: new Date().toISOString(),
  // includeChat: true,           // 默认 false（已定稿：默认不导出聊天）
})

// 云端项目：只传**已经加载**的列表；没加载就不要传（会导出 loaded: false）
const cloudDoc = buildCloudProjectExport({
  project: cloudStore.project!,
  tasks: cloudStore.tasks,
  evidence: cloudStore.evidence,
  progress: cloudStore.progress,
  materials: cloudStore.materials,
  exportedAt: new Date().toISOString(),
})

const text = serializeProjectExport(doc)
const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
const url = URL.createObjectURL(blob)
const anchor = document.createElement('a')
anchor.href = url
anchor.download = `${project.short || project.name}-export.json`
anchor.click()
URL.revokeObjectURL(url)
```

界面提示要点：

1. 云端导出必须同时展示 `notice`（「这是只读投影快照，不是完整备份」），不能只给一个下载按钮。
2. 云端导出里 `lists.*.loaded === false` 表示「导出时没加载」，界面上不要宣称「没有任务/没有证据」。
3. 导出内容**不含**聊天记录与材料片段正文（已定稿），界面如需说明可直接引用 `meta.omitted`。
4. 文档格式版本是 `schemaVersion: 1`，与本地 `PROJECT_SCHEMA_VERSION = 3` 是两个概念（导出里叫 `project.sourceSchemaVersion`）。

### 2.3 聊天历史恢复

`CloudChatState` 新增三个字段：

| 字段 | 含义 | 界面建议 |
| --- | --- | --- |
| `sessionId: string \| null` | 当前项目对应的服务端会话 | 只用于排查，不建议展示 |
| `historyStatus: 'idle' \| 'loading' \| 'ready' \| 'error'` | 历史恢复状态 | `error` 时提示「历史记录暂时没拉到」并保留「本次会话」语义，不要当成空历史 |
| `historyError: { code, message } \| null` | 失败原因（中文） | 与 `chat.error` 分开：`chat.error` 只表示「这次提问失败」 |

`CloudChatMessage` 新增：

| 字段 | 含义 |
| --- | --- |
| `messageId?: string \| null` | 服务端消息 ID；`null` = 未落库（本地项目 / 落库失败） |
| `persisted?: boolean` | 是否已由服务端持久化；**`messageId === null` 时恒为 false**，不得显示「已保存」 |

**重要**：恢复出来的历史消息是从契约 30.2 读回的，**没有 `source` / `fallbackReason`**。
它们运行期是 `undefined`。当前 `CloudChatPanel.vue` 的 `sourceText()` 直接索引 `SOURCE_TEXT[message.source]`，
运行期拿到 `undefined` 会返回 `undefined`（模板渲染为空，不会误显示「AI 模型回答」），
但类型层面 `CloudChatMessage.source` 仍是必填（本批次不改界面）。

建议界面层补一个分支：

```ts
function sourceText(message: CloudChatMessage): string {
  if (message.source === undefined) return '历史记录'   // 或直接不渲染徽标
  return SOURCE_TEXT[message.source]
}
```

补完之后可以把类型改成可选、去掉 `cloud.ts` 里 `toHistoryChatMessage()` 的那一次窄转换。

`loadChatHistory` 已随修复批次对外导出，历史加载失败时界面可调用 `cloudStore.loadChatHistory()` 就地重试，不必提示用户刷新页面。

---

## 3. 契约问题与 v4.1 裁定对照

> 契约 v4.1（`b0d90aa`，2026-10-26）已把下列 11 条逐条裁定，并明确「与已合并实现 #42–#45 对齐」。
> 「v4.1 裁定」列是裁定结果；**前端仅 P6 需要改代码**，已在本 PR 的 papers 提交内修正（码元计数 + emoji 用例）。

### 3.1 论文检索（第 29 节）

| # | 问题 | 前端当前行为 | v4.1 裁定 |
| --- | --- | --- | --- |
| P1 | 29.4 只说「同一 requestId 重放返回同一结果」，未定义响应是否带 `replayed` 之类的标志 | 只保证「重试复用同一 requestId、不做前端缓存」，无法校验服务端是否真的没二次打上游 | 已明确：重放响应**不带** `replayed`，返回与首次完全相同的响应体 |
| P2 | 503 `PAPERS_UPSTREAM_ERROR` 是否可自动重试、`retryAfterSeconds` 是否有语义未写 | 按不可自动重试处理（未加入 `RETRYABLE_CODES`），由用户手动点重试 | 已明确：**不自动重试**（只在配置缺失时发生），`retryAfterSeconds` 恒为 null，属预留 |
| P3 | 29.1 要求 fallback 必带中文 `notice`，但没规定「服务端漏带时前端怎么办」 | 补一条本地兜底文案（`PAPERS_FALLBACK_NOTICE`），保证界面不把降级显示成零结果 | 已明确：服务端保证 `notice` 非空；前端保留兜底文案属防御，允许 |
| P4 | 29.3 没标注 `year` / `venue` / `doi` 是否可为 null（后端实现确实会返回 null） | 按可空解析；若契约意图是必填，需要同步文档或后端 | 已补 29.3 字段可空性表：`title`/`citedByCount` 非空，`year`/`venue`/`doi`/`openAccessUrl` 可空 |
| P5 | 同一项目并发两次检索的优先级未定义 | 采用「后发起者接管，旧响应按 `STALE_RESPONSE` 丢弃」 | 已补 29.1 规则 6：后发者接管；**新检索必须用新 `requestId`**，复用旧 ID 且参数变化会 409 |
| P6 | `query` 长度计数口径不一致：前端按 Unicode 码点，后端按 UTF-16 码元（emoji 记 2） | **已修**：改为 `query.trim().length`（UTF-16 码元），并补 100/101 个 emoji 的边界用例 | 已明确：按 UTF-16 码元（JS `string.length`），先 trim 再判 |

### 3.2 聊天持久化（第 30 节）

| # | 问题 | 前端当前行为 | v4.1 裁定 |
| --- | --- | --- | --- |
| C1 | 30.2 未写 `limit` 省略时的语义，也未写返回的是「最新 N 条」还是「最早 N 条」 | 直接采用服务端返回顺序（后端取最新 N 条再反转为升序）；未在客户端重排 | 已明确：省略 `limit` 取**最新 200 条**，再反转为升序返回 |
| C2 | 30 未写「重试发送消息如何防重复写入」 | 前端失败重试复用同一 `requestId`（服务端按它去重） | 已补 30.4 规则 5：重试**必须复用原 `requestId`**，服务端查重与写入在同一事务内 |
| C3 | 聊天历史/会话接口实际返回 `requestId: null`，会话与历史响应还省略 `projectRevision`，与 22.1「读接口不返回 requestId」表述不一致 | 已放宽 `v3Http`：读接口的 `requestId: null` 与省略 `projectRevision` 视为合法；写接口仍严格回显 | 已在 §20.3 / §22.0 统一：读接口顶层 `requestId` 固定 `null`、`projectRevision` 可省略，强校验仅限写接口 |
| C4 | `POST /chat/sessions` 语义是 get-or-create、不改项目状态，但要求完整写信封（含 `projectRevision`）；契约未说明它是否应校验/递增 `projectRevision` | 每次调用带上当前已确认的 `projectRevision`，未做乐观锁校验 | 已明确：`projectRevision` 只做格式校验（≥1 整数），不校验时效、不递增 |
| C5 | 500 条上限只说「最多保留 500 条」，未写裁剪时机与 `sequence` 是否重排 | 前端不做任何提示、不做本地裁剪（已定决策：页面不提示） | 已明确：写入同一事务内删除最旧、`sequence` 不重排（保留空洞） |

---

## 4. 未验证范围

1. **真实模型路径**：所有聊天集成用例用 `ADVISOR_PROVIDER=mock`；`source: "model"` 的真实回答、模型超时降级后的落库行为未验证。
2. **生产环境**：未在 HTTPS + `SCP_COOKIE_SECURE=1` + 真实 CORS 白名单下运行；Cookie 会话与跨域 `Set-Cookie` 的真实行为未验证。
3. **`before` 分页**：后端明确「暂不支持」，客户端未实现、也未留半成品调用。
4. **500 条上限裁剪**：未构造超限数据实测删除行为。
5. **真实 OpenAlex 命中**：`source: "openalex"` 与上游超时触发的 `200 + fallback` 均属人工验收范围，不在自动套件内。
6. **mock 测试 ≠ 真实联调**：单测全部基于契约 mock 响应；集成测试虽然连真实后端，但后端是本地 `mock` provider 与临时库。

---

## 5. 回归结果（本分支最终状态）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（`vue-tsc --noEmit`，无输出） |
| `npm test` | `Test Files 58 passed (58)`、`Tests 1070 passed (1070)` |
| `npx eslint src tests` | 通过，0 error / 0 warning |
| `npm run build` | `✓ 113 modules transformed`、`✓ built in 3.79s` |
| 集成（`vitest.integration.config.ts`） | `Test Files 5 passed (5)`、`Tests 41 passed (41)` |

基线变化：单测 **991 → 1070**（V5 开工前 991，V5 第一批前 1024，本批次开工时 1040，契约 v4.1 后补 emoji 边界 +1）；集成 **22 → 41**。
集成构成：`v3LocalBackend 12` + `advisorV3 5` + `materialUpload 5` + `papersSearch 10` + `chatPersistence 9`。

---

## 6. 对其他成员的影响面

**`src/services/v3Http.ts` 的信封校验放宽了两处**，所有走 `requestV3Envelope` 的读接口都受影响：

| 变化 | 之前 | 现在 | 影响 |
| --- | --- | --- | --- |
| 读接口 `requestId: null` | 判为 `INVALID_RESPONSE`（null 与请求的 requestId 不相等） | 视为「未回显」，合法 | 聊天历史接口才能真正可用；不会让错配的响应通过 |
| 读接口省略 `projectRevision` | 判为 `INVALID_RESPONSE` | 视为 `null`，合法 | 同上；`expectedMinRevision` 校验在有值时才生效 |

写接口仍严格要求回显 `requestId`，`replayed` 校验未改。既有 22 条集成用例与全部单测重跑通过，说明没有回归。

此外 `advisorApi.asChatSuccess` 新增了两个可选字段的解析（`sessionId` / `messageId`），对 v1/v2 路径完全无影响（字段缺失时保持 `undefined`）。

---

## 7. PR 草稿

### 标题

`feat(v5): 前端数据层——论文检索、项目 JSON 导出、云端聊天持久化`

### 描述

**基线**：`main` = `b0d90aa8393711f1a3d293dfb9e0465060d2f157`
（开发期基线 `bae9148`；收尾时 main 先后前进到 `71ab395`（PR #45）与 `b0d90aa`（契约 v4.1，仅改 docs），已在分支内两次 rebase，均无冲突）

**包含三个功能提交**：

1. `7573991` 论文检索数据层（契约第 29 节）
   - `GET /api/papers/search` 客户端：只传 `projectId/query/limit/contractVersion/requestId`，检索词由服务端组装
   - `cloud.papers` 状态机：`idle/loading/ready/fallback/error`，`fallback` 保留中文 `notice`
   - 404 / 400 / 503 中文化；论文专用限流码已按契约移除，429 统一走通用 `RATE_LIMITED`
   - `query` 长度按 UTF-16 码元计（契约 v4.1 §29.2），含 emoji 边界用例
2. `f51654c` 项目 JSON 导出 domain + 论文检索集成测试
   - 纯函数白名单序列化；本地项目导出真实持久化字段，云端只导出已加载的只读投影（`scope: "cloud-projection"` + `notice`）
   - 未加载列表用 `loaded: false`，不用空数组冒充；任何 scope 都不含凭证字段
   - 默认不导出聊天与材料片段正文（已定稿）
3. `85d43be` 云端聊天持久化（契约第 30 节）
   - 会话 get-or-create + 历史恢复（升序、不补造 `source`）
   - `sendChat` 记录 `sessionId` / `messageId`；`messageId === null` 不标记已保存
   - 失败重试复用同一 `requestId`；epoch/token/abort 丢弃迟到响应

**测试基线**：单测 991 → 1070，集成 22 → 41（新增 `papersSearch` 10 条、`chatPersistence` 9 条，全部真实 HTTP、仅 loopback）。

**影响面**：
- `v3Http.ts` 读接口信封放宽两处（`requestId: null`、省略 `projectRevision`），写接口不变；
- `advisorApi.ts` 聊天响应新增两个可选字段解析，v1/v2 路径行为不变；
- 未改动任何 `.vue` 组件与 `server/`。

**合并前请确认**：
- 雍蕾：界面需处理 `fallback` 的 `notice`、云端导出的 `loaded: false`、历史消息 `source === undefined`；
- 姜厚禄：11 条契约问题已由 v4.1（`b0d90aa`）全部裁定，前端已逐条对照并在第 3 节标注；若裁定与实现有出入请直接指出。
