# V3-V4 未实现功能审计（2026-10-22）

> 基线：`origin/main` `ce3d772` + 工作区未提交的雍蕾 UI 批次。
> 方法：**以代码和测试为准**，不采信文档里的“已完成”措辞；每条结论给出文件级证据。
> 范围：对照《V3-V4任务分配与实施计划》第二节“本阶段建设内容”、第七节“完成标准”和 M3 验收场景。
> 本文只做审计，不改代码。

## 0. 一句话结论

“项目 → 阶段 → 任务 → 证据 → 进展”这条记录链，后端接口、数据层、页面**已经打通**；账号、会话、项目隔离、本地迁移**已经打通**。

断掉的是四类：

1. **AI 阶段化链路整条没有实现**：服务端只认 `mvp-prompt-v1/v2` 与 `advisor-chat-v1/v2`，`milestoneContext` 在 `server/src` 里**零命中**；
2. **聊天 / 疑问 / 时间线**三个能力后端没有读写接口；
3. **云端材料页**后端有读取接口，前端数据层没接，所以页面只能占位；
4. **审计日志、指标、发布记录**没有；生产部署按计划未执行。

## 1. 已实现且可核对（不是缺口）

| 能力 | 证据 | 验证 |
| --- | --- | --- |
| 里程碑 CRUD / 排序 / 完成 / 重开 / 归档 / 恢复 + 任务统计 | `server/src/v3/milestones.ts`、`src/stores/cloud.ts`、`src/components/CloudProjectWorkbench.vue` | 后端 296 用例、前端 888 用例、浏览器实测 |
| 任务挂阶段、开始/完成/重开/归档、改挂阶段 | `server/src/v3/tasks.ts`、`taskReads.ts`、`cloud.linkTaskToMilestone` | 同上 |
| 证据创建 + 关联任务/阶段、进展追加、按时间倒序 | `server/src/v3/evidence.ts`、`progress.ts` | 同上 |
| 版本号 / `STALE_REVISION` / 幂等键 / 过期响应丢弃 | `server/src/v3/idempotency.ts`、`src/services/v3Http.ts`、`src/stores/cloud.ts`（epoch） | 单测 + 集成用例 |
| 注册 / 登录 / 退出 / 会话保持 / bcrypt / HttpOnly / 限流 | `server/src/v3/auth.ts`、`rateLimiter.ts`、`src/components/AuthPanel.vue` | 浏览器实测（含错误密码中文提示） |
| 项目按用户隔离、跨用户 404 | 所有查询带 `userId + projectId`；`v3-projects.test.ts` | 后端用例 |
| 本地项目迁移（确认后上传、幂等、失败保留本地） | `server/src/v3/migration.ts`、`src/stores/migration.ts`、`LocalMigrationPanel.vue` | **本轮浏览器实测**：迁移成功、刷新后云端 1 个项目、本地 628 字节仍保留 |
| 项目地图 / 阶段进度 / 390px / 键盘标签页 | `CloudProjectMapView.vue`、`CloudProjectWorkbench.vue` | 截图 + `scrollWidth=390` |
| 材料上传 / 解析 / 理解草稿确认（**仅本地模式**） | 后端有接口，前端走 V2 本地链路 | 既有用例 |

## 2. 未实现清单

### A. 后端接口未实现（前端无法补）

| # | 功能 | 现状证据 | 影响 | 谁来补 |
| --- | --- | --- | --- | --- |
| A1 | **阶段候选** `POST /milestones/candidates` | `server/src/v3/router.ts` 的 milestones 分支只有 `reorder` 与 `{id}/{action}`，无 `candidates`；`candidates` 表已建 | AI 生成阶段只能做成入口占位；吴佳璐的候选评估只能用 mock JSON | 后端 |
| A2 | **建议 / 聊天 v3**（`mvp-prompt-v3`、`advisor-chat-v3`、`milestoneContext`） | `server/src/advisor/types.ts:17-21` 只有 `v1/v2`；`grep -rn milestoneContext server/src` **零命中**；请求带 v3 会被 `400 INVALID_INPUT` | “AI 建议结合当前里程碑 / 任务状态 / 已确认材料”整条**不可用**；前端 `advisorApi.ts:176` 的 v3 分支是死代码（没有调用方传 `milestoneContext`） | 后端 |
| A3 | **服务端材料门禁**（只接受 `confirmed` 片段、行号由服务端回填） | 契约 23.3 要求；`confirmedMaterials` 目前完全由前端 `selectConfirmedMaterials()` 过滤，服务端不复核 | 前端漏发时未确认内容可进入提示词；属安全边界缺口 | 后端 |
| A4 | **聊天持久化** | `chat_sessions` / `chat_messages` 表只在 `migration.ts` 写入；无读写接口；V2 聊天由前端回传历史 | 换设备看不到历史对话；历史可被客户端篡改 | 后端 |
| A5 | **项目时间线** `GET /projects/{id}/timeline`（契约 22.6） | `router.ts` 无 timeline 分支；`cloud.loadTimeline()` 恒返回 `TIMELINE_NOT_AVAILABLE` 且不发请求 | 只有“最近进展”列表，没有跨阶段时间线 | 后端 |
| A6 | **疑问手工创建 / 解决 / 归档** | `doubts` 表只由 `evidence.ts:201`（证据自动创建）与迁移写入，无独立接口 | 云端无法新建或解决疑问 | 后端 |
| A7 | **证据 / 进展单条读取** | `router.ts` 证据只有列表/创建/links；进展只有列表/创建/supersede | 详情只能从列表里筛，做不了详情页 | 后端 |

### B. 后端已有、前端数据层未接（李焰彬范围）

| # | 功能 | 现状证据 | 影响 |
| --- | --- | --- | --- |
| B1 | **云端材料读取**（列表 / 单材料 / 片段 / 理解草稿） | 后端 `materialReads.ts` 已实现；`src/services/projectsApi.ts` **没有 materials 读取函数**，`src/stores/cloud.ts` **没有 materials 状态** | 我的「项目资料」页只能如实占位；云端看不到材料与已确认条目 |
| B2 | **云端材料写入 / 归档 / 重解析** | 后端 `materialWrites.ts` 已实现；前端未接 | 云端不能上传 MD/TXT，只能回本地模式做 |
| B3 | **进展更正 supersede** | 后端 `POST /progress/{id}/supersede` 已实现；数据层无 action | 提交错的进展改不了（只能再写一条） |
| B4 | **阶段化上下文传递** | `src/domain/v3Advisor.ts` 的 `buildMilestoneContext()` **无调用方**；`cloud.buildAdvisorContext()` 导出但没有任何页面/store 调用 | 即使后端支持 v3，当前前端也不会带上阶段上下文 |
| B5 | **云端聊天** | `cloud.ts` 无 chat 相关状态/动作 | 云端没有 AI 问答；只有本地模式有 V2 聊天 |

### C. 页面侧缺口（雍蕾范围）

| # | 功能 | 现状 | 原因 |
| --- | --- | --- | --- |
| C1 | 「项目资料」在云端模式只有说明卡片 | `CloudProjectWorkbench.vue` 数据面板 | 依赖 B1（数据层），不是页面能单独补的 |
| C2 | 建议卡只显示“证据 / 疑问”依据，**不显示材料来源** | `SuggestionCard.vue:63` 的 `basisCount = evidence + doubts`；`basisMaterialRefs` 只被解析，从未渲染 | 依赖 A2（服务端目前根本不返回该字段） |
| C3 | 证据改挂任务没有界面 | `cloud.attachEvidenceToTask` 存在但无入口；后端 `/evidence/{id}/links` 可用 | 可以补，但当前没有产品动作要求 |
| C4 | 云端没有疑问与时间线区块 | — | 依赖 A5 / A6 |

> 里程碑“删除”只提供归档：任务书写的是“删除**或**归档”，归档已满足，不算缺口。

### D. 工程与运维

| # | 缺口 | 证据 |
| --- | --- | --- |
| D1 | **审计记录**没有 | `grep -rn audit server/src` 只命中 `docs/contracts.md` 的一句要求；无审计表、无审计写入 |
| D2 | **可观测性**只有 `/health` | `server/src/routes/health.ts` 返回固定四字段；没有成功率、延迟、失败原因的统计口径；`logger.ts` 只打控制台 |
| D3 | **发布记录**没有 | `docs/` 下无发布记录文件；`docs/acceptance/` 是验收证据，不是发布记录 |
| D4 | 生产部署未执行 | 计划要求“未经项目负责人确认不部署”，符合预期，不算缺陷 |

## 3. 本地模式 vs 云端模式

| 能力 | 本地模式 | 云端模式 |
| --- | --- | --- |
| 项目 / 阶段 / 任务 / 证据 / 进展 | ✅（localStorage） | ✅（服务端） |
| 材料上传与理解草稿确认 | ✅（V2） | ❌ 未接（B1/B2） |
| AI 建议 | ✅ V2（无阶段上下文） | ❌ 无入口（A2/B4/B5） |
| AI 聊天 | ✅ V2（历史回传，不落库） | ❌ 无（A4/B5） |
| 疑问 | ✅ 本地解决 | ❌ 只能由证据自动生成（A6） |
| 时间线 | 用进展列表代替 | ❌（A5） |
| 阶段候选 | ❌ 接口不存在 | ❌（A1） |

## 4. 本轮验证证据

| 检查 | 结果 |
| --- | --- |
| 前端 `vitest run` | **888/888，40 文件** |
| 后端 `npm test`（`tsc` + `node --test`） | **296/296，14 suites，0 fail** |
| 前端 `vue-tsc --noEmit` | 0 错误 |
| 前端 `vite build` | 通过 |
| 前端 `eslint .` | 通过（未 `--fix`） |
| 浏览器主流程（真后端 + 真浏览器） | 注册 → 建项目 → 建阶段 → 建任务 → 开始 → 进展 → 证据 → 双标签 → 地图 → 刷新恢复 → 390px → 键盘切换 → 退出 → 错误密码 → 重新登录：全通过 |
| 本地迁移端到端 | 建本地项目 628 字节 → 注册 → 面板提示 → 确认迁移 → 云端 1 个项目 → 刷新仍在、本地数据未删：通过 |

截图与日志：`docs/acceptance/v3-ui/`（`migration-log.txt`、`acceptance-log.txt`）。

## 5. 建议补齐顺序（按依赖）

1. **后端 v3 AI**：`SUPPORTED_PROMPT_VERSIONS` 增加 `mvp-prompt-v3` / `advisor-chat-v3`，校验 `milestoneContext`，按 23.3 做服务端材料复核 —— 这是解锁“阶段化 AI”的唯一前置；
2. **前端数据层**：把 `milestoneContext` 真正传给建议/聊天（接上 B4 的死代码）+ 材料读取（B1）+ supersede（B3）；
3. **阶段候选**（A1）→ 前端常量 → 我把候选入口换成真实调用与逐条确认；
4. **时间线 / 聊天 / 疑问**（A4/A5/A6）→ 页面对应区块；
5. **审计 + 指标 + 发布记录**（D1–D3）。

## 6. 需要修正的文档口径

- 我上一份 `docs/v3-v4-yonglei-ui-delivery.md` 把「云端阶段化 AI 建议」写成“需要数据层接入”，**不准确**：服务端根本没有 v3 实现（A2），数据层接上也只会拿到 400。以本文为准。
- `docs/v3-v4-interface-status.md` §8 已标 ⬜，但没有给出“v3 请求会 400”的证据；建议把 `server/src/advisor/types.ts:17-21` 补进该行。
- `docs/v3-frontend-delivery.md` 的“数据层可用”只描述了解析与状态机，未说明 v3 分支当前无调用方、服务端不认 v3 —— 容易让评审误以为阶段化已经能用。
