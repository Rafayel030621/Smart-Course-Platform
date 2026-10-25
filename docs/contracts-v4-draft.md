# 契约 v4.0 草案（待评审，未生效）

> 状态：**草案**。本文不是契约正文；评审通过后由姜厚禄合并进 `docs/contracts.md`，
> 版本升 v4.0 并在第 28 节补变更记录。**评审通过前，后端不得按本文件写实现。**
>
> 范围：论文推荐真实化、聊天持久化、V3 材料理解门禁。
> 依据：`V5任务分配与实施计划.md` 第二节。

## 1. 本轮新增与变更

| 项 | 类型 | 说明 |
| --- | --- | --- |
| `GET /api/papers/search` | 新增 | 服务端代理 OpenAlex 检索真实论文；**模型不参与** |
| `POST /api/projects/{id}/chat/sessions` | 新增 | 取得或创建当前项目的聊天会话 |
| `GET /api/projects/{id}/chat/sessions/{sid}/messages` | 新增 | 读取历史消息（升序，上限 200） |
| `POST /api/advisor/chat`（v3） | 变更 | 响应新增 `sessionId`、`messageId`；其余字段不变 |
| `POST /api/materials/understanding-v3` | 新增 | 带项目归属与材料门禁的理解草稿；v2 路径保持不变 |
| 错误码 | 新增 | `PAPERS_UPSTREAM_ERROR`、`PAPERS_RATE_LIMITED` |
| 环境变量 | 新增 | `OPENALEX_MAILTO`（必填）、`OPENALEX_TIMEOUT_MS`（默认 8000） |

## 2. 论文检索 `GET /api/papers/search`

### 2.1 设计约定

1. **论文只能来自真实检索**：OpenAlex 免费、无需 Key；服务端代理，前端不直连（避免暴露联系邮箱与限流策略）。
2. **模型不生成论文**：标题、作者、DOI、链接全部来自上游；本阶段没有“推荐理由”字段。
3. 请求必须带联系邮箱进入 OpenAlex 礼貌池；未配置 `OPENALEX_MAILTO` 时接口返回 503 `PAPERS_UPSTREAM_ERROR`（配置问题按上游错误处理，不静默）。
4. 上游超时/5xx/限流 → **200 + 空列表 + 中文 notice**，不把上游错误抛给学生（与 AI 建议的降级策略一致）。

### 2.2 请求（Query）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `projectId` | string | 是 | 项目归属，用于权限校验与日志 |
| `query` | string | 是 | 学生输入的方向，1–200 字；服务端会与项目名、当前阶段一起组装最终检索词 |
| `limit` | number | 否 | 默认 5，最大 10 |
| `contractVersion` | string | 是 | 必须为 `3.0`（沿用现有信封规则） |
| `requestId` | string | 是 | UUID |

> 组装规则：最终检索词 = `项目名 + 当前阶段名 + query`，由服务端拼接；
> 客户端传入的 `query` 之外的任何内容都不参与检索。

### 2.3 响应

```json
{
  "contractVersion": "3.0",
  "requestId": "…",
  "projectId": "prj_…",
  "source": "openalex",
  "notice": null,
  "papers": [
    {
      "title": "Wave height forecasting with…",
      "authors": ["Li W.", "Chen X."],
      "year": 2024,
      "venue": "Ocean Engineering",
      "doi": "10.1016/j.oceaneng.2024.118xxx",
      "openAccessUrl": "https://…",
      "citedByCount": 37
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | `"openalex"` \| `"fallback"` | `fallback` 时 `papers` 为空数组 |
| `notice` | string \| null | 降级原因（中文），正常为 `null` |
| `papers[]` | array | 0–10 条；按相关度排序，服务端去重（同 DOI 只留一条）、过滤无标题条目 |
| `openAccessUrl` | string \| null | 开放获取链接，可能为 `null`；前端此时只显示 DOI 链接 |

### 2.4 失败路径

| 场景 | 行为 |
| --- | --- |
| `projectId` 不属于当前用户 | 404 `PROJECT_NOT_FOUND` |
| `query` 为空或超长 | 400 `INVALID_INPUT` |
| OpenAlex 超时 / 5xx / 限流 | 200 + `source: "fallback"` + 中文 `notice` + 空数组 |
| `OPENALEX_MAILTO` 未配置 | 503 `PAPERS_UPSTREAM_ERROR` |
| 连续失败重试 | 同一 `requestId` 重放返回同一结果；不重复打上游 |

## 3. 聊天持久化

### 3.1 `POST /api/projects/{id}/chat/sessions`

取得当前项目的会话（已存在则返回已有，不存在则创建）。

请求：标准信封 + `projectId`。
响应：`{ contractVersion, requestId, projectId, projectRevision, data: { sessionId, createdAt } }`

### 3.2 `GET /api/projects/{id}/chat/sessions/{sid}/messages`

| Query | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | number | 否 | 默认 200，最大 200 |
| `before` | string | 否 | ISO 时间，取更早的消息（为将来分页预留，本阶段可不实现） |

响应：`data.messages[]`，按时间升序：

```json
{ "messageId": "msg_…", "role": "user" | "assistant", "content": "…",
  "citations": [], "createdAt": "2026-10-25T12:00:00.000Z" }
```

> `citations` 形状与 v3 聊天响应一致；`fallbackReason`、`source` 不落库
> （历史消息只保留“学生问了什么、系统答了什么”）。

### 3.3 `POST /api/advisor/chat`（v3）变更

响应在现有字段基础上新增：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | 本次消息所属会话；未落库时（本地项目）为 `null` |
| `messageId` | string \| null | 助手消息 ID，落库失败时为 `null` |

其余字段（`answer`、`citations`、`milestoneRevision`、`source`、`fallbackReason`）不变。

### 3.4 规则

1. 会话与消息按 `projectId + userId` 归属校验；跨项目读会话返回 404。
2. 学生消息与助手消息在**同一事务**内写入，避免出现“问了没答”或“答了没问”的孤儿记录。
3. 本地项目（无云端 projectId）不落库，`sessionId` 为 `null`，页面继续显示“刷新后清空”。
4. 上限保护：单会话最多保留 500 条，超出时最旧的消息在写入新消息时删除（避免无限增长）。

## 4. V3 材料理解 `POST /api/materials/understanding-v3`

### 4.1 请求

标准信封 + 项目归属 + **只传 segmentIds**：

```json
{
  "contractVersion": "3.0",
  "requestId": "…",
  "idempotencyKey": "…",
  "projectId": "prj_…",
  "projectRevision": 3,
  "promptVersion": "material-understanding-v3",
  "segments": [
    { "materialId": "mat_…", "version": 1, "segmentId": "seg_1" }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `segments[]` | array | 是 | 每条 = materialId + version + segmentId；**不含 name / 行号 / 正文** |
| `promptVersion` | string | 是 | 必须为 `material-understanding-v3` |

### 4.2 服务端行为

1. 复用 `server/src/v3/materialGate.ts`：按 `materialId + version + segmentId` 回库，只接受 `understanding_items.status = 'confirmed'` 引用的片段；
2. 客户端自报的名称、行号、正文一律丢弃；未确认 → 400 `UNCONFIRMED_MATERIAL`；版本旧或已归档 → 409 `MATERIAL_VERSION_OUTDATED`；
3. 模型输入 = 服务端组装的已确认片段；输出五块草稿 + `segmentIds`（虚拟标识 `m1:seg_1`），引用同样过门禁回填；
4. 模型不可用 → 200 + `source: "fallback"` + 中文 notice + 规则草稿；
5. 响应结构沿用契约 14.3 的 `draft` 五块，新增 `projectId`、`projectRevision`。

### 4.3 兼容

v2 路径 `POST /api/materials/understanding` **完全不变**（无项目归属、不过门禁），旧本地项目继续可用；前端按项目类型选择路径。

## 5. 新增错误码

| 错误码 | HTTP | 中文提示 | 出现场景 |
| --- | --- | --- | --- |
| `PAPERS_UPSTREAM_ERROR` | 503 | 论文检索暂不可用，请稍后重试 | OpenAlex 超时/5xx/未配置联系邮箱 |
| `PAPERS_RATE_LIMITED` | 429 | 检索太频繁了，稍等一下再试 | 上游限流且短期重试仍失败 |

## 6. 新增环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `OPENALEX_MAILTO` | 论文检索开启时必填 | 无 | 联系邮箱，进入 OpenAlex 礼貌池；用学校邮箱 |
| `OPENALEX_TIMEOUT_MS` | 否 | 8000 | 上游超时；超过即降级 |

## 7. 前端影响

| 页面 | 变化 |
| --- | --- |
| 论文推荐 | 卡片改为真实论文（标题/作者/年份/来源/被引/DOI 链接）；新增加载与无结果态；去掉“AI 已生成”文案 |
| 聊天 | 进入云端项目时拉历史；发送后落库；本地项目保持“刷新后清空” |
| 材料理解 | 云端项目走 `understanding-v3`；本地项目仍走 v2 |
| 其他 | 无 |

## 8. 待评审问题（需要姜厚禄/雍蕾/李焰彬答复）

1. `GET /api/papers/search` 用 Query 传参会把检索词写进访问日志，可接受吗？（建议可接受：日志不记学生正文，检索词是方向关键词）
2. 聊天消息上限 500 条/会话，超出删最旧——是否需要先告诉学生“只保留最近 500 条”？
3. `understanding-v3` 是独立路径，还是在同一路径加 `contractVersion` 区分？（草案选独立路径，回滚更容易）
4. 论文检索是否需要按项目缓存（同一项目 10 分钟内复用结果）？5–20 人规模下倾向不缓存，避免陈旧。
