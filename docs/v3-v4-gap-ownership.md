# V3-V4 缺口责任与文件定位（2026-10-22）

> 配套 `docs/v3-v4-gap-audit.md`：那份说“缺什么”，这份说“**谁**、**哪个文件哪一行**、**下一步改哪里**”。
> 责任边界取自《V3-V4任务分配与实施计划》第三节原文：姜厚禄 = 全部后端 + 契约 + 数据安全 + 生产验收；李焰彬 = 前端 store / API client / 领域接入（`src/stores`、`src/services`、`src/domain`）；雍蕾 = 页面与交互（`src/views`、`src/components`）；吴佳璐 = AI 输入输出规格与评估（`docs/ai/**`、`tests/fixtures/ai/**`）。

## 1. 姜厚禄（后端 / 契约）——8 项

| # | 问题 | 出问题的文件:行 | 缺什么 | 下一步动作 |
| --- | --- | --- | --- | --- |
| J1 | **建议/聊天 v3 完全没有实现**（最致命） | `server/src/advisor/types.ts:17-19` 版本清单只有 `mvp-prompt-v1/v2`、`advisor-chat-v1/v2`；`server/src/advisor/validation.ts:624-627` 不在清单直接判 `INVALID_INPUT`；`server/src/advisor/prompt.ts:190、244` 只有 v1/v2 两个分支 | 没有 `milestoneContext` 的类型、校验、提示词分支；`grep -rn milestoneContext server/src` 零命中 | `types.ts` 加 `mvp-prompt-v3`/`advisor-chat-v3`；`validation.ts` 解析并校验 `milestoneContext`；`prompt.ts` 加阶段化系统提示词分支 |
| J2 | **契约 23.3 的服务端材料门禁没做** | `docs/contracts.md:3179` 写着“服务端按 `materialId + version + segmentId` 回查、只接受 confirmed”；`server/src/advisor/validation.ts:668` 只校验结构 | 服务端不复核，未确认片段可进提示词；实际过滤只在 `src/domain/v3Advisor.ts:154`（前端） | 在建议/聊天入口按契约回查 `understanding_items`，不合法返回 400 `UNCONFIRMED_MATERIAL` / 409 `MATERIAL_VERSION_OUTDATED` |
| J3 | **阶段候选没有接口** | `server/src/v3/router.ts:199`（milestones 分支只有 `reorder` 和 `{id}/{action}`）；`server/src/v3/milestones.ts:63` 只有校验用的 `assertCandidate()` | `candidates` 表建好了，没有生成路由；契约在 `docs/contracts.md:3342`（23.7） | 新增 `POST /projects/{id}/milestones/candidates`，走 `milestone-candidate-v1` |
| J4 | **聊天没有读写接口** | `server/src/v3/migrations.ts:233` 建表；`server/src/v3/migration.ts:953` 是**唯一**写入点（迁移时补录）；`server/src/v3/router.ts` 全文无 `chat` 分支 | 换设备看不到历史；历史可被客户端篡改（现在靠前端回传） | 加 `GET/POST /projects/{id}/chats`，落 `chat_sessions/chat_messages` |
| J5 | **疑问没有接口** | `server/src/v3/evidence.ts:201` 是唯一写入点（证据自动建疑）；`router.ts` 无 `doubts` 分支 | 云端不能新建/解决/归档疑问 | 加 `POST /doubts`、`POST /doubts/{id}/resolve`、`/archive` |
| J6 | **项目时间线没有接口** | `docs/contracts.md:2703`（22.6）有契约；`router.ts` 无 `timeline` 分支 | 前端只能降级：`src/services/projectsApi.ts:1481` 的 `timelineEndpointUnavailable()` | 加 `GET /projects/{id}/timeline`（跨阶段聚合） |
| J7 | **证据/进展没有单条读取** | `server/src/v3/router.ts:252`（progress 只有列表/创建/supersede）、`router.ts:267`（evidence 只有列表/创建/links） | 详情页只能从列表里筛 | 补 `GET /progress/{id}`、`GET /evidence/{id}` |
| J8 | **审计与可观测性** | 全仓无 audit 表、无审计写入（`docs/contracts.md:1787` 只在密码条款里提了一句“审计记录”）；`server/src/routes/health.ts:5` 只返回固定四字段 | 没有审计记录、没有成功率/延迟/失败原因 | 加审计表与写入点；补指标口径（建议/聊天成功率、429 次数、P95） |
| J9 | **进展更正的请求字段没写进契约** | `docs/contracts.md:2573` 只写“更正通过 supersede 创建新记录”，没有请求字段表；后端其实已实现（`server/src/v3/progress.ts:299-336`，接受 `summary/taskId/milestoneId/evidenceIds/occurredAt`） | 客户端不敢接，`src/stores/cloud.ts:315` 留了注释“契约没字段表，未实现客户端调用” | 契约 22.4 补请求字段表（一行工作量，能解锁前端） |
| J10 | **发布记录 / 生产验收报告** | `docs/` 下无发布记录；`docs/acceptance/` 是验收证据不是发布记录 | 计划要求“发布记录” | 建 `docs/releases/`，每次上线记版本、迁移号、回滚点 |

> 生产部署未做**不算问题**：计划明确“未经项目负责人确认不部署”，`docs/deployment/backend-sqlite.md` 已备好备份/恢复/回滚步骤。

## 2. 李焰彬（前端 store / API client / domain）——5 项

| # | 问题 | 出问题的文件:行 | 缺什么 | 下一步动作 |
| --- | --- | --- | --- | --- |
| L1 | **云端材料读写没接**（直接导致我的「项目资料」页只能占位） | `src/services/projectsApi.ts` 导出清单（426–1641）里**没有任何 materials 函数**；`src/stores/cloud.ts` 无 materials 状态 | 后端已就绪：`server/src/v3/materialReads.ts`、`materialWrites.ts`（列表/片段/理解草稿/归档/重解析） | 补 `listMaterials/getMaterial/listSegments/getUnderstanding` 与 store 状态 |
| L2 | **阶段上下文根本没传给 AI** | `src/stores/workbench.ts:2156` 调 `buildAdvisorRequest` 时没传 `milestoneContext`；`src/domain/v3Advisor.ts:72` 的 `buildMilestoneContext()` 无调用方；`src/stores/cloud.ts:1690` 的 `buildAdvisorContext()` 无调用方 | 即使 J1 修好，前端也只会发 v2 请求 | 在建议/聊天的输入组装处调用 `buildMilestoneContext`，并传进请求 |
| L3 | **进展更正没接** | `src/stores/cloud.ts:315` 注释“未实现客户端调用” | 后端有、契约缺字段（见 J9） | 等 J9 补完，加 `supersedeProgress` action |
| L4 | **云端聊天没有** | `src/stores/cloud.ts` 无 chat 状态/动作 | 依赖 J4 | 后端接口就绪后接 |
| L5 | 时间线降级是**对的**，不是缺陷 | `src/services/projectsApi.ts:1481`、`src/stores/cloud.ts:646` | 无（等 J6） | 后端出接口后替换 stub |

## 3. 雍蕾（页面与交互）——3 项 + 1 项说明

| # | 问题 | 出问题的文件:行 | 缺什么 | 下一步动作 |
| --- | --- | --- | --- | --- |
| Y1 | 「项目资料」在云端只有说明卡 | `src/components/CloudProjectWorkbench.vue:754` | 完全依赖 L1 | L1 落地后接材料列表与已确认条目 |
| Y2 | 建议卡不显示**材料来源** | `src/components/SuggestionCard.vue:63`（`basisCount = evidence + doubts`）；`server/src/advisor/types.ts:131-138` 的 `Suggestion` 也没有 `basisMaterialRefs` | 依赖 J1（服务端目前不返回该字段） | 服务端出字段后加“依据的材料”折叠区 |
| Y3 | 证据改挂任务没有入口 | 能力已有：`src/stores/cloud.ts:1528`（`attachEvidenceToTask`）、后端 `/evidence/{id}/links`；页面无按钮 | 缺一个交互动作 | 在证据列表加“挂到任务” |
| Y4 | 候选入口是占位提示 | `src/components/CloudProjectWorkbench.vue:182-184`（提示“接口暂未接入”）、按钮在 `604`/`668` | 依赖 J3 + 李焰彬的 `milestone-candidate-v1` 常量 | 接口就绪后换成真实调用 + 逐条确认 |

> 说明：里程碑只提供“归档”没有“删除”，任务书写的是“删除**或**归档”，**不算缺口**。

## 4. 吴佳璐（AI 规格与评估）——0 项未交付，1 项被阻塞

| 交付物 | 状态 | 证据 |
| --- | --- | --- |
| 阶段候选提示词规格 | ✅ 已交 | `docs/ai/prompt-spec.md:927`（§11.3，MC1–MC9） |
| 阶段化建议 / 聊天提示词规格 | ✅ 已交 | `docs/ai/prompt-spec.md:1002`、`1026` |
| 九类场景评估集（S7–S15） | ✅ 已定稿 | `docs/ai/evaluation.md:297`、`tests/fixtures/ai/stageScenarios.ts` |
| 真实模型一轮评估记录 | ⛔ 阻塞 | `docs/ai/evaluation.md` 表格“实际结果”全部写“未实测”，原因写明是 **J1/J3** 未实现，v3 请求会被 400 |

**结论**：她这边没有漏交，缺的是“姜厚禄把 v3 落地后跑一轮真实模型”的输入。她自己的文档已把 D12–D17 登记出来，责任人也标了。

## 5. 三条跨人依赖链（按落地顺序）

1. **AI 阶段化**：J1（服务端认 v3）→ L2（前端传上下文）→ 吴佳璐补真实评估 → Y2（材料来源展示）
2. **阶段候选**：J3（接口）→ 李焰彬加 `milestone-candidate-v1` 常量与 client → Y4（页面真实调用）
3. **云端材料**：后端已就绪 → L1（数据层）→ Y1（项目资料页）→ 云端 AI 才能真正用到“已确认材料”

## 6. 一行话总结

真正卡住整条 AI 的，是 **`server/src/advisor/types.ts:17-19` 那两行版本清单**；卡住云端材料的，是 **`src/services/projectsApi.ts` 少一组 materials 函数**；页面侧只剩三个小口子，且都必须等前两步。
