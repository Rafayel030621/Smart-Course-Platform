# V3/V4 接口可用性清单

> 用途：**一页纸回答“这个接口现在能不能接”**。
> 不替代契约：字段、错误码、状态机一律以 [`docs/contracts.md`](contracts.md) 为准。
> 分工不在这里：四个人的任务边界见 `V3-V4任务分配与实施计划.md` 第三节。
> 更新规则：本页只反映实现状态；接口语义变更必须先改契约，再改本页。

## 怎么用这页

- **李焰彬（前端数据层）**：只看“状态=✅/🟡”的行，可以直接写 store 和 API client；⬜ 的行不要接。
- **雍蕾（界面）**：✅ 的行对应的页面可以先做；⬜ 的行对应的界面先放占位或不做入口。
- **吴佳璐（提示词/评估）**：看第 8、9 节，提示词依赖的接口还没实现时，用 mock JSON 先评估。
- **后端（姜厚禄）**：每完成一个 ⬜，把状态改成 ✅ 并写清“限制”列。

状态含义：**✅ 已实现并有用例** / **🟡 已实现但有已知限制** / **⬜ 未实现**。
“依据”列给的是实现文件，方便核对；状态不是靠文档承诺，而是靠代码和测试。

---

## 1. 账号与会话

| 状态 | 方法 | 路径 | 接入方 | 说明 |
| --- | --- | --- | --- | --- |
| ✅ | POST | `/api/auth/register` | 李、雍 | 账号+密码+昵称+邀请码；错误统一中文，不暴露账号是否存在 |
| ✅ | POST | `/api/auth/login` | 李、雍 | 成功后下发 HttpOnly Cookie；前端只 `credentials: 'include'` |
| ✅ | POST | `/api/auth/logout` | 李、雍 | 撤销当前 Session |
| ✅ | GET | `/api/auth/me` | 李、雍 | 应用启动先调它判断登录态；未登录 401 |

依据：`server/src/v3/auth.ts`；测试 `server/test/v3-auth.test.ts`

## 2. 项目与迁移

| 状态 | 方法 | 路径 | 接入方 | 说明 |
| --- | --- | --- | --- | --- |
| ✅ | GET | `/api/projects` | 李、雍 | 当前用户项目列表；支持 `includeArchived`；**不分页**，一次返回全部 |
| ✅ | POST | `/api/projects` | 李、雍 | 创建项目；空项目不会自动注入模板阶段 |
| ✅ | GET | `/api/projects/{projectId}` | 李、雍 | 项目详情 + `projectRevision` |
| ✅ | PATCH | `/api/projects/{projectId}` | 李、雍 | 改名/简介等；需 `projectRevision` |
| ✅ | POST | `/api/projects/{projectId}/archive` | 雍 | 归档；归档后所有写接口 409 `PROJECT_ARCHIVED` |
| ✅ | POST | `/api/projects/{projectId}/restore` | 雍 | 恢复归档项目 |
| ✅ | POST | `/api/projects/{projectId}/delete` | 雍 | 软删除，30 天内可恢复 |
| ✅ | POST | `/api/projects/{projectId}/restore-deleted` | 雍 | 恢复软删除项目 |
| ✅ | POST | `/api/projects/migrate-local` | 李 | 本地 localStorage 项目迁移；幂等，重复迁移不产生重复项目 |
| ✅ | GET | `/api/projects/migrations/{migrationId}` | 李 | 查询迁移结果/警告 |

依据：`server/src/v3/projects.ts`、`migration.ts`；测试 `v3-projects.test.ts`、`v3-migration.test.ts`

## 3. 阶段（Milestone）

| 状态 | 方法 | 路径 | 接入方 | 说明 |
| --- | --- | --- | --- | --- |
| ✅ | GET | `/api/projects/{projectId}/milestones` | 李、雍 | 列表含 `taskStats`；默认排除归档阶段 |
| ✅ | POST | `/api/projects/{projectId}/milestones` | 李、雍 | 创建；空白项目由学生手动建 |
| ✅ | PATCH | `/api/projects/{projectId}/milestones/{milestoneId}` | 李、雍 | 改名/目标/完成标准/截止时间 |
| ✅ | POST | `/api/projects/{projectId}/milestones/reorder` | 李、雍 | 整组排序 |
| ✅ | POST | `/api/projects/{projectId}/milestones/{milestoneId}/{action}` | 李、雍 | `complete` / `reopen` / `archive` / `restore` |
| ✅ | POST | `/api/projects/{projectId}/milestones/candidates` | 吴（评估）、李 | AI 生成阶段候选（D12）；需 `projectRevision` + `promptVersion: milestone-candidate-v1`；候选 30 分钟过期、不写项目；确认走创建阶段接口 |

依据：`server/src/v3/milestones.ts`；测试 `v3-projects.test.ts`

## 4. 任务（Task）

| 状态 | 方法 | 路径 | 接入方 | 说明 |
| --- | --- | --- | --- | --- |
| ✅ | GET | `/api/projects/{projectId}/tasks` | 李、雍 | `milestoneId` / `status` / `includeArchived` / `limit` / `cursor` |
| ✅ | GET | `/api/projects/{projectId}/tasks/{taskId}` | 李、雍 | 单任务；`includeArchived=true` 可读归档任务 |
| ✅ | POST | `/api/projects/{projectId}/tasks` | 李、雍 | 创建，可挂 `milestoneId` |
| ✅ | PATCH | `/api/projects/{projectId}/tasks/{taskId}` | 李、雍 | 编辑；需 `expectedRevision` |
| ✅ | POST | `/api/projects/{projectId}/tasks/{taskId}/link-milestone` | 李、雍 | 改挂阶段 |
| ✅ | POST | `/api/projects/{projectId}/tasks/{taskId}/{action}` | 李、雍 | `start` / `complete` / `reopen` / `archive` / `restore` |

依据：`server/src/v3/tasks.ts`、`taskReads.ts`；测试 `v3-read-apis.test.ts`

## 5. 证据与进展

| 状态 | 方法 | 路径 | 接入方 | 说明 |
| --- | --- | --- | --- | --- |
| ✅ | POST | `/api/projects/{projectId}/evidence` | 李、雍 | 提交证据；可带 `attachmentName`，**没有文件上传** |
| ✅ | POST | `/api/projects/{projectId}/evidence/{evidenceId}/links` | 李、雍 | 关联任务/阶段 |
| ✅ | GET | `/api/projects/{projectId}/evidence` | 李、雍 | 列表 |
| ⬜ | GET | `/api/projects/{projectId}/evidence/{evidenceId}` | 李、雍 | **单条读取未实现**，详情页暂时只能从列表筛 |
| ✅ | POST | `/api/projects/{projectId}/progress` | 李、雍 | 记录进展（只追加） |
| ✅ | GET | `/api/projects/{projectId}/progress` | 李、雍 | 进展列表 |
| ✅ | POST | `/api/projects/{projectId}/progress/{progressId}/supersede` | 李、雍 | 更正进展，旧记录转 `superseded` |
| ⬜ | GET | `/api/projects/{projectId}/progress/{progressId}` | 李、雍 | **单条读取未实现** |

依据：`server/src/v3/evidence.ts`、`progress.ts`

## 6. 材料读取

| 状态 | 方法 | 路径 | 接入方 | 说明 |
| --- | --- | --- | --- | --- |
| ✅ | GET | `/api/projects/{projectId}/materials` | 李、雍 | 每个 materialId 只返回当前版本；默认排除归档 |
| ✅ | GET | `/api/projects/{projectId}/materials/{materialId}` | 李、雍 | `version=N` 读历史版本，返回 `isCurrent` / `readOnly` |
| ✅ | GET | `/api/projects/{projectId}/materials/{materialId}/segments` | 李、雍 | 按 `index` 排序，分页 |
| ✅ | GET | `/api/projects/{projectId}/materials/{materialId}/understanding` | 李、雍、吴 | 理解草稿；`sources` 由服务端回填真实行号 |

依据：`server/src/v3/materialReads.ts`；测试 `v3-read-apis.test.ts`

## 7. 材料写入

| 状态 | 方法 | 路径 | 接入方 | 说明 |
| --- | --- | --- | --- | --- |
| ✅ | POST | `/api/projects/{projectId}/materials` | 李、雍 | base64 JSON，上限 2 MB 请求 / 1 MB 文件；只支持 `md`/`txt` |
| 🟡 | — | 同上 | 李、雍 | 响应最多返回前 20 个片段，`segmentCount` 是真实总数；完整片段走分页读取 |
| ✅ | POST | `/api/projects/{projectId}/materials/{materialId}/archive` | 雍 | 只归档当前版本 |
| ✅ | POST | `/api/projects/{projectId}/materials/{materialId}/restore` | 雍 | 恢复当前版本 |
| 🟡 | POST | `/api/projects/{projectId}/materials/{materialId}/reparse` | 雍 | 只有新上传的材料能重解析；迁移来的旧材料返回 409 `MATERIAL_CONTENT_UNAVAILABLE` |
| ✅ | POST | `/api/projects/{projectId}/materials/{materialId}/understanding/items/{itemId}/{action}` | 李、雍 | `confirm` / `remove` / `undo` |
| ✅ | PATCH | `/api/projects/{projectId}/materials/{materialId}/understanding/items/{itemId}` | 李、雍 | 编辑草稿文字 |
| ✅ | POST | `/api/projects/{projectId}/materials/{materialId}/understanding/confirm-all` | 李、雍 | 整份确认；任一条目无有效来源整单失败 |

依据：`server/src/v3/materialWrites.ts`、`drafts.ts`；测试 `v3-material-writes.test.ts`、`v3-drafts.test.ts`

## 8. AI 与尚未实现的能力

| 状态 | 能力 | 现状 | 影响谁 |
| --- | --- | --- | --- |
| ✅ | 建议 v1/v2 `POST /api/advisor/recommendations` | 可用，`contractVersion: "1.0"` | 吴（提示词） |
| ✅ | 建议 v3 `mvp-prompt-v3` | 已实现（D13）；**必须带 `milestoneContext`，且只对云端项目可用**；响应每条 suggestion 含 `basisMaterialRefs`（门禁回填，无已确认材料时为 `[]`） | 吴、李 |
| 🟡 | 聊天 v1/v2 `POST /api/advisor/chat` | 可用，但**不落库**；每次由前端回传历史 | 吴、李 |
| ✅ | 聊天 v3 `advisor-chat-v3` | 已实现（D13）；必须带 `milestoneContext`，仅云端项目；响应含 `milestoneRevision` 与 `citations`（门禁回填，无已确认材料时为 `[]`） | 吴、李、雍 |
| ⬜ | V3 材料理解生成 | 未实现；当前仍走 V2 `POST /api/materials/understanding`（无项目归属、不过门禁） | 吴 |
| ✅ | 阶段候选 | 已实现（D12）；接口见第 4 节末行 | 吴、李 |
| ⬜ | 聊天读写（会话/消息持久化） | 未实现；**迁移已写入 `chat_sessions` / `chat_messages`，但没有读取接口** | 李、雍 |
| ⬜ | 疑问手工创建/解决/归档 | 未实现；只有证据自动创建与迁移导入 | 李、雍 |
| ⬜ | 项目时间线 `GET /projects/{id}/timeline` | 未实现 | 李、雍 |
| ✅ | V3 AI 材料门禁（仅 `confirmed` 片段进入上下文） | 已实现（D15）：按 materialId+version+segmentId 回库，只认 `confirmed`；客户端自报的名称/行号/正文一律丢弃 | 吴、后端 |

> **v3 只对云端项目可用**：服务端按 `projectId + milestoneId` 查库校验上下文实体（契约 §23.2），
> 本地项目的实体 ID 不在库中，发 v3 会返回 400 `INVALID_INPUT`。本地工作台继续用 v2，迁移后再切。
>
> **引用字段现为占位**：`basisMaterialRefs` / `citations` 按契约必须返回，但 D15 未做前一律为 `[]`，
> 因此这一阶段的评估只能覆盖“结构与安全边界”，不能覆盖“引用准确性”。

## 9. 前端接入前必读（六条）

1. **Cookie 会话**：所有请求 `credentials: 'include'`；不得把令牌写进 `localStorage` / `sessionStorage` / URL。
2. **版本号**：V3 请求一律 `contractVersion: "3.0"`；V2 的四个 AI/材料接口仍是 `"1.0"`，混填返回 400。
3. **并发**：写接口带 `projectRevision`；单实体更新再带 `expectedRevision`；409 `STALE_REVISION` 时刷新重试，不要静默重发。
4. **幂等**：写接口必须带 `idempotencyKey`；重试复用同一个键，换键等于新请求。
5. **错误语义**：跨用户项目 404 `PROJECT_NOT_FOUND`；同用户跨项目实体 404 `RESOURCE_NOT_FOUND`；归档项目写操作 409 `PROJECT_ARCHIVED`。**不要用 403/409 区分“是否存在”**。
6. **读接口不写库**：读不递增 `projectRevision`，也不写幂等记录，可以放心重试。

## 10. 维护约定

- 本页与 `docs/v3-v4-pr2-status.md` 的分工：**本页按接口列状态，状态文档按“PR 交付了什么”叙述**。新增接口先改契约，再改本页。
- 每次合并 PR 时，顺手把受影响的行改掉；状态与代码不一致时，以代码和测试为准，并在当天修正本页。
- 本页不写“谁负责”，避免和分工文档产生第二份口径。
