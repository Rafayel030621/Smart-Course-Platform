# 姜厚禄：V3-V4 后端待办工作清单（2026-10-22）

> 依据：`docs/v3-v4-gap-audit.md`（缺什么）、`docs/v3-v4-gap-ownership.md`（谁负责哪一行）、`docs/contracts.md`（冻结契约）、`docs/ai/prompt-spec.md` 第 11 节（吴佳璐的提示词规格）。
> 本文只写后端与契约侧要做的事，按**依赖顺序**排。规模用 S/M/L 表示，不代表工时承诺。
> 所有条目都必须满足：**现有 296 条后端用例保持全绿**、`v1/v2` 行为不变（契约 23.1 兼容面）、不伪造模型结果、不把未确认材料放进提示词。

## 0. 优先级总览

| 优先级 | 编号 | 事项 | 规模 | 解锁谁 |
| --- | --- | --- | --- | --- |
| **P0** | B1 | 建议/聊天 v3（`milestoneContext` + `mvp-prompt-v3`/`advisor-chat-v3` + 响应新字段） | L | 吴佳璐跑真实评估、李焰彬接上下文、雍蕾的 AI 区块 |
| **P0** | B2 | 契约 23.3 服务端材料确认门禁 | M | 上面三人的安全边界 |
| **P0** | B3 | 阶段候选接口 `POST /milestones/candidates` | M | 雍蕾的候选入口、吴佳璐候选评估 |
| **P0** | B4 | 契约 22.4 补 supersede 请求字段表（后端已实现） | S | 李焰彬接进展更正 |
| **P1** | B5 | 聊天落库（契约 + `GET/POST /chats`） | M | 云端聊天、换设备续看 |
| **P1** | B6 | 疑问写入/解决/归档接口（契约 + 实现） | S | 云端疑问管理 |
| **P2** | B7 | 项目时间线 `GET /timeline` | M | 时间线页面、聊天/材料事件 |
| **P2** | B8 | 证据/进展单条读取（契约 + 实现） | S | 详情页 |
| **P2** | B9 | 审计记录 + 指标口径 | M | 生产验收 |
| **P2** | B10 | 发布记录模板 + 生产验收报告 | S | 交付 |

---

## B1（P0）建议 / 聊天 v3 —— 整条链路都没实现

**现在为什么不行**：`server/src/advisor/types.ts:17-19` 的版本清单只有 `mvp-prompt-v1/v2`、`advisor-chat-v1/v2`；`server/src/advisor/validation.ts:624-627` 遇到不在清单里的 `promptVersion` 直接判 `INVALID_INPUT`。所以前端一发 `mvp-prompt-v3` 就是 400，整条阶段化 AI 走不通。

**契约依据**：`docs/contracts.md:3132`（23.2 `milestoneContext` 六个规则）、`3342`（23.7 聊天 v3）、`3298`（23.6 建议 v3 响应示例）。

### 要改的文件与顺序

1. **`server/src/advisor/types.ts`**
   - `ADVISOR_PROMPT_VERSIONS` 加 `'mvp-prompt-v3'`；`ADVISOR_CHAT_PROMPT_VERSIONS` 加 `'advisor-chat-v3'`；`MILESTONE_CANDIDATE_PROMPT_VERSION = 'milestone-candidate-v1'`（供 B3 复用）。
   - 新增 `MilestoneContext`：`milestoneId`、`currentMilestone`、`milestoneRevision`、`milestoneGoal`、`milestoneDoneCriteria`、`milestoneStatus`、`milestoneTasks`、`recentProgress`、`milestoneEvidence`。
   - `MilestoneTaskSnapshot` 与现有 `TaskSnapshot`（`types.ts:29`）字段完全一致，**直接复用**，不要新造一套；`EvidenceSnapshot`（`types.ts:39`）沿用；只需新增 `ProgressSnapshot { progressId, summary, milestoneId, taskId, occurredAt }`。
   - `AdvisorRequest` / `AdvisorChatRequest` 加可选 `milestoneContext?: MilestoneContext | null`。
   - `Suggestion`（`types.ts:131-138`）加 `basisMaterialRefs?: MaterialRef[]`；新增 `MaterialRef { materialId, materialName, materialVersion, segmentId, startLine, endLine, itemId }`。
   - 聊天响应类型加 `citations: MaterialRef[]`、`milestoneRevision: number | null`。

2. **`server/src/advisor/validation.ts`**
   - 新增 `parseMilestoneContext(body, issues, projectId)`，按 23.2 校验：`milestoneId` 非空时三个数组非空、文本长度（阶段名 ≤60、目标/标准 ≤300）、`milestoneRevision ≥1`、`milestoneStatus` 只允许 `planned`/`active`、数组上限（任务 50、进展 20、证据 20）、`milestoneContext` 与顶层 `currentMilestone` 不一致则 `INVALID_INPUT`；`milestoneId` 为空时六个字段必须全 `null`、三个数组必须为空。
   - 校验 `confirmedMaterials` 与 `milestoneContext` 同时存在时的总文本上限（请求体仍 256 KB）。
   - **注意分层**：这一层是纯函数、拿不到 DB，所以“实体是否属于该项目/该阶段”“阶段是否归档”这类**数据库校验不能写在这里**，放到路由层（见第 4 步）。

3. **`server/src/advisor/prompt.ts`**
   - 新增 `ADVISOR_SYSTEM_PROMPT_V3`、`CHAT_SYSTEM_PROMPT_V3`，内容按 `docs/ai/prompt-spec.md` §11.4 / §11.5（硬约束、禁止输出内部键名、必须中文）。
   - `build` 函数按 `request.promptVersion` 选提示词（现在只有 `prompt.ts:190` 和 `:244` 两处三元表达式，改成三支）；payload 里加入 `milestoneContext`（不要顺手把内部字段名写进用户可见文本）。
   - v3 的兜底也要在：模型失败仍走 `fallback.ts`，`source: 'fallback'` + 中文 `notice`（契约 5.x / 23.8）。

4. **`server/src/routes/advisor.ts`、`server/src/routes/advisorChat.ts`（DB 校验落点）**
   - 校验通过后、调用 provider 前，新增数据库复核：
     - `milestoneContext.milestoneTasks / recentProgress / milestoneEvidence` 里的每个 ID 必须属于**当前用户 + 当前项目**，且属于该 `milestoneId`；跨项目或不属于该阶段 → 400 `INVALID_INPUT`（契约 23.2 规则 1）；
     - `milestoneContext` 指向的阶段已归档 → 400 `INVALID_INPUT`（规则 4）；
     - `milestoneRevision` 与会话中的阶段版本不符时，按契约 4.7 的旧请求丢弃语义处理，不要静默接受。
   - 响应加 `milestoneRevision`（回显请求里的值）；聊天响应加 `citations`。
   - 引用的材料名、版本、行号由服务端回填（`material_segments` + `materials` 读），**不接受客户端传的行号与正文**。

5. **`server/src/advisor/mockProvider.ts`**
   - 扩展 mock：按 `promptVersion` 返回带 `basisMaterialRefs` / `citations` 的 v3 形状，方便你在没有真实模型时跑测试。不要用 mock 结果冒充“模型评估结果”（评估记录归吴佳璐）。

6. **`server/test/advisor-v3.test.ts`（新增）**
   - v3 请求被接受；v1/v2 请求行为不变（回归）；
   - `milestoneContext` 七种非法形态各返回 400，且中文提示；
   - 跨项目 ID、归档阶段、`currentMilestone` 不一致 → 400；
   - 响应含 `milestoneRevision`；`basisMaterialRefs` 缺失时前端按空数组处理，但 v3 必须返回该字段（可为 `[]`）。

**验收命令**：`cd server && npm test`（全绿）；再用 curl 发一份 23.6 的示例请求，确认 `source`、`promptVersion`、`milestoneRevision` 正确。

**风险**：`milestoneContext` 是新增可选字段，**不能**让 v1/v2 请求因为多传字段而失败（宪法式约束：旧客户端行为不变）。

---

## B2（P0）契约 23.3 的服务端材料确认门禁

**现状**：契约 `docs/contracts.md:3179` 要求服务端按 `materialId + version + segmentId` 回读数据库、只接受 `status = 'confirmed'`；实际过滤只在**前端** `src/domain/v3Advisor.ts:154`（`selectConfirmedMaterials()`）。服务端 `validation.ts:668` 只校验结构，不查库。前端一旦漏发，未确认草稿就能进提示词。

**要做**：
1. 新增 `server/src/v3/materialGate.ts`（或放 `advisor/` 下），导出 `resolveConfirmedMaterials(db, projectId, items)`：
   - 以 `(materialId, materialVersion, segmentId)` 查 `material_segments`，并 join `materials` 确认 `project_id` 一致、`status = 'active'`、未 `archived_at`；
   - 该片段必须有对应的 `understanding_items` 且 `status = 'confirmed'`、`removed_at IS NULL`；
   - 用数据库值**覆盖**客户端传来的 `name`、`startLine`、`endLine`、`text`；
   - 版本不匹配 → `MATERIAL_VERSION_OUTDATED`（409）；未确认/归档/不存在 → `UNCONFIRMED_MATERIAL`（400）。两个码在 `server/src/v3/errors.ts:36-38、113-115` **已经定义好了**，直接用，别新造。
2. 在建议、聊天、阶段候选三个入口统一调用（候选也必须只引用已确认片段，契约 23.7）。
3. 测试：构造“草稿 pending”“材料归档”“版本过期”“客户端篡改 text/行号”四类输入，断言 400/409 且服务端回填值正确。

**注意**：契约 23.3 表格里写了 `mvp-prompt-v1/v2` 保持“信任客户端已确认”的老行为 —— 门禁**只对 v3 生效**，否则会打断旧前端。

---

## B3（P0）阶段候选接口

**现状**：`server/src/v3/router.ts:199` 的 milestones 分支只有 `reorder` 和 `{id}/{action}`，没有 `candidates`；`server/src/v3/milestones.ts:63` 只有确认时用的 `assertCandidate()`；表已建：`server/src/v3/migrations.ts:268` 的 `milestone_candidates`。

**要做**：
1. **新增 `server/src/v3/milestoneCandidates.ts`**，实现 `POST /api/projects/{projectId}/milestones/candidates`（契约 `docs/contracts.md:3342`）：
   - 入参：`contractVersion`、`requestId`、`idempotencyKey`、`projectRevision`、`promptVersion: 'milestone-candidate-v1'`、`maxCandidates`（1–3）、`focus`；
   - 幂等：复用 `server/src/v3/idempotency.ts`，operation 名建议 `milestones.candidates`；
   - 上下文：项目基本信息 + 已确认材料（走 B2 的门禁）+ 当前阶段/任务（已有阶段时不要重复造同名阶段；空白项目按“元动作”给候选）；
   - 模型失败 → `source: 'fallback'` + 中文 `notice`，`candidates` 可为空，**不得**用模板阶段顶替；
   - 写库：每条候选写 `milestone_candidates`（`payload_json` 存完整候选，`expires_at = now + 30min`）；
   - **不写项目、不递增 `projectRevision`、不进时间线**（契约 23.7 第一条）。
2. `router.ts` 在 `rest[0] === 'milestones'` 分支里加 `rest.length === 2 && rest[1] === 'candidates'` 的 POST 分发（放在 `reorder` 附近）。
3. 确认链路已就绪、不用重写：`milestones.ts:155-160` 已校验 `source === 'ai-candidate'` → `confirmedByUser === true` → `assertCandidate()`（项目/用户归属 + `expires_at`，过期抛 `CANDIDATE_EXPIRED`）。你只需保证候选确实落库、过期时间正确。
4. 测试 `server/test/v3-milestone-candidates.test.ts`：生成 → 库里可查 → 带 `candidateId` 创建阶段成功 → 过期后确认返回 409 → 别的项目用这个 `candidateId` 返回 404/409 → 重复 `idempotencyKey` 返回同一批候选。

**顺带**：`docs/v3-v4-interface-status.md` 里候选接口的状态从 ⬜ 改为 ✅，并把 `docs/ai/prompt-spec.md` §9.3 的 D12 标记为已解决（文档状态由吴佳璐更新，你只需在群里给结论）。

---

## B4（P0，十分钟）契约 22.4 补 supersede 请求字段表

**现状**：后端已实现 `POST /api/projects/{id}/progress/{progressId}/supersede`（`server/src/v3/progress.ts:299-336`，接受 `summary?`、`taskId?`、`milestoneId?`、`evidenceIds?`、`occurredAt?`，未传字段沿用旧值）；契约 `docs/contracts.md:2573` 只写了一句语义，没有请求字段表，所以李焰彬在 `src/stores/cloud.ts:315` 留注释“未实现客户端调用”。

**要做**：在契约 22.4 补一张请求字段表（字段、类型、必填、约束、说明）+ 一个示例请求/响应 + 三条规则（旧记录置 `superseded` 且正文保留；`revision + 1`；重复 `idempotencyKey` 幂等）。补完通知李焰彬即可解锁。

---

## B5（P1）聊天落库

**现状**：表已建（`server/src/v3/migrations.ts:233` 的 `chat_sessions`、`:248` 的 `chat_messages`），但只有迁移时写过（`server/src/v3/migration.ts:953`），没有读写接口；`router.ts` 全文无 `chat` 分支。计划第三节要求“**聊天记录按用户隔离**”。

**要做**：
1. 契约新增 22.9（聊天记录）：`GET /api/projects/{id}/chats`（列表，分页）、`GET /api/projects/{id}/chats/{chatId}/messages`（按 `sequence` 分页）；`POST /api/advisor/chat` 增加可选 `chatId`，已登录且带 `projectId` 时把用户消息与助手回答写入 `chat_messages`（`citations_json` 落服务端回填后的引用）。
2. 现有 `uq_chat_client_message` 唯一索引已就绪，用它做客户端重试幂等（`client_message_id`）。
3. 匿名/V2 聊天保持不变：没有登录态就不落库，响应结构不变。
4. 安全：`chat_id`、`chatId` 必须校验属于当前用户 + 当前项目，否则 `RESOURCE_NOT_FOUND`（不要返回 403，避免探测）。
5. 测试：写入后列表可见、跨用户 404、重复 `client_message_id` 不产生两条、`citations` 只含已确认片段。

---

## B6（P1）疑问接口

**现状**：`doubts` 表存在（`migrations.ts:161`），唯一写入点是证据创建时自动生成（`server/src/v3/evidence.ts:201`）；`router.ts` 无 `doubts` 分支；契约 22 章没有疑问章节（§1.2 那句“疑问写入接口不做”是 V2 MVP 的旧话，理由已过时）。

**要做**：契约新增 22.10（疑问）：`POST /api/projects/{id}/doubts`、`POST /doubts/{id}/resolve`、`POST /doubts/{id}/archive`、`GET /doubts?status=`；写入时校验项目归属与 `revision`；解决时写 `resolved_at` / `resolved_by_user_id`；归档不删记录。测试覆盖跨用户 404、重复解决幂等、证据自动生成的疑问可被手工解决。

> 如果这轮时间不够，这一条可以放到 V4：计划正文只要求“聊天记录隔离”，没点名疑问 CRUD。

---

## B7（P2）项目时间线

**现状**：契约 `docs/contracts.md:2703`（22.6）已冻结；`router.ts` 无 `timeline` 分支；前端只能降级（`src/services/projectsApi.ts:1481`）。

**要做**：
1. 新增 `server/src/v3/timeline.ts`：从 `milestones`、`tasks`、`evidence`、`progress_records`、`materials`、`doubts`（+ 聊天，依赖 B5）聚合事件，字段严格按契约（`timelineItemId`、`type`、`occurredAt`、`title`、`summary`、`milestoneId`、`milestoneNameSnapshot`、`taskId`、`evidenceId`、`progressId`、`materialId`、`chatId`、`actorUserId`、`entityRevision`、`archived`）。
2. 排序：`occurredAt` 倒序，同刻按 `timelineItemId` 倒序；游标用 `(occurredAt, timelineItemId)` 编码成不透明串，非法游标 400 `INVALID_INPUT`。
3. `types` 逗号过滤、`includeArchived`、`summary` 截 200 字、绝不返回材料正文/模型原文。
4. 测试：分页不重不漏、归档事件 `archived: true`、跨项目不出现、`types` 过滤、非法游标 400。

---

## B8（P2）证据 / 进展单条读取

契约 22.4 / 22.5 目前只有列表、创建、`links`、`supersede`。要补 `GET /progress/{progressId}`、`GET /evidence/{evidenceId}`：契约加两小节 + 实现（可直接复用 `progress.ts` / `evidence.ts` 里的行映射函数），校验用户与项目归属，不存在统一 `RESOURCE_NOT_FOUND`。

---

## B9（P2）审计与可观测性

**现状**：全仓没有审计表、没有审计写入（`docs/contracts.md:1787` 只在密码条款里提到“审计记录”四个字）；`server/src/routes/health.ts:5` 只返回 `status/service/contractVersion/checkedAt`。

**要做**（保持“不记录正文/密码/邀请码/路径/密钥”的既有纪律，见 `server/src/v3/logger.ts` 头注释）：
1. 审计表 `audit_events(audit_id, user_id, action, entity_type, entity_id, result, request_id, created_at)` + 写入点：登录成功/失败、注册、项目创建/归档/删除、阶段/任务/证据/材料写入、AI 调用（`model` / `fallback` / 失败码）、迁移。
2. 指标：至少给 `POST /api/advisor/recommendations`、`POST /api/advisor/chat`、`POST /milestones/candidates` 的成功率、`fallback` 占比、429 次数、P95 延迟；输出方式二选一（`GET /metrics` 纯文本，或结构化日志固定字段），口径写进 `docs/deployment/backend-sqlite.md`。
3. 测试：审计写入不含正文与密钥；429 计数正确。

---

## B10（P2）发布记录与生产验收

1. 新建 `docs/releases/`，模板：版本、提交范围、迁移号、环境变量变更、回滚点（对应 `docs/deployment/backend-sqlite.md` §5.3 的“回滚应用要同时恢复对应数据库备份”）。
2. 出生产验收报告：把 `docs/acceptance/` 的前端证据 + 后端 `npm test` 结果 + 冒烟结果合成一份，附在发布记录里。
3. 部署本身**仍要等项目负责人确认**（计划第三节明确），本文不包含执行。

---

## 集成侧要一并交付的东西

| 事项 | 具体动作 |
| --- | --- |
| 给李焰彬的联调清单 | 新增/变更端点：`/milestones/candidates`、`/timeline`、`/chats`、`/doubts`、`/progress/{id}`、`/evidence/{id}`、supersede 请求字段；每条给一份请求/响应示例 + 错误码。材料读写端点已就绪（`materialReads.ts` / `materialWrites.ts`），可直接给。 |
| 给吴佳璐的确认 | v3 提示词版本已在 `SUPPORTED_PROMPT_VERSIONS` 注册、`milestoneContext` 按 23.2 校验、`basisMaterialRefs`/`citations` 按 23.6/23.7 回填；让她据此把评估集 S7–S15 跑成真实记录。 |
| 文档同步 | `docs/v3-v4-interface-status.md` 按完成情况改状态；`docs/contracts.md` 补 22.4 字段表、22.6 已冻结无需改、22.9/22.10 新章节；`docs/ai/prompt-spec.md` §9.3 的 D12–D17 由吴佳璐改状态，你提供结论。 |
| 回归底线 | `cd server && npm test` 296 条全绿；`npm run typecheck` 0 错误；v1/v2 请求与响应字段一个都不能变。 |

## 完成定义（逐条打勾）

- [ ] `mvp-prompt-v3` / `advisor-chat-v3` 可被接受，v1/v2 行为不变
- [ ] `milestoneContext` 七种非法形态都返回 400，跨项目/归档阶段被拒
- [ ] 建议响应含 `milestoneRevision` + `basisMaterialRefs`；聊天响应含 `citations` + `milestoneRevision`
- [ ] 未确认材料进不了提示词（服务端校验，不依赖前端）
- [ ] `POST /milestones/candidates` 可用、30 分钟过期、确认走已有 `assertCandidate`
- [ ] 契约 22.4 有 supersede 字段表
- [ ] 聊天可落库、跨用户不可见、重复发送幂等
- [ ] 时间线可分页、只含本项目事件
- [ ] 审计有记录、指标有口径
- [ ] 发布记录模板 + 验收报告就位
- [ ] `npm test` 全绿、`typecheck` 0 错误

## 明确不要做的事

- 不要改前端（`src/**`）——那是李焰彬和雍蕾的范围；需要前端配合时给联调清单。
- 不要为了“看起来能用”用模板数据伪造候选或建议（契约 23.7 明确禁止空白项目自动生成候选）。
- 不要动迁移已写入的 `chat_sessions` / `chat_messages` 结构去“顺手重构”，`idMap.chats` 还在用。
- 不要把审计做成“记正文”——现有日志纪律（`logger.ts` 头注释）不能破。
