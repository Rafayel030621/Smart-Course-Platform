# 雍蕾：当前阻塞项与交接要求（2026-10-22）

> 结论先说：**我这边只有 1 项必须等姜厚禄**（阶段候选接口），1 项等李焰彬（材料数据层），其余 4 项已经能交付，不用等任何人。
> 细节证据见 `docs/v3-v4-gap-ownership.md`。

## 1. 我的任务逐项状态

| 任务 | 状态 | 卡在谁 | 具体卡点 |
| --- | --- | --- | --- |
| 1. 里程碑闭环（新建/编辑/顺序/完成/重开/归档/目标/完成标准/截止/任务数与完成比例） | **已完成 9/9** | — | — |
| 1b. 「根据项目资料生成候选」入口 | **入口在、点不通** | **姜厚禄** | `POST /projects/{id}/milestones/candidates` 没有路由（`server/src/v3/router.ts:199`） |
| 2. 阶段推进界面（当前阶段卡片/目标/完成标准/任务列表/下一步动作） | **已完成** | — | — |
| 2b. 「项目资料」标签页 | **只有说明卡** | **李焰彬** | 后端读接口已就绪，前端 `projectsApi` 没有 materials 函数、`cloud` store 无 materials 状态 |
| 2c. 页面里显示 AI 建议 | 未做（不是我的必交项） | 姜厚禄 + 李焰彬 | 服务端 v3 未实现（`advisor/types.ts:17-19`）；前端也未传 `milestoneContext`（`workbench.ts:2156`） |
| 3. 登录/注册/退出/迁移界面 | **已完成**（迁移已端到端实测） | — | — |
| 4. 响应式与可访问性（390px、键盘切换、焦点） | **已完成** | — | — |

## 2. 需要姜厚禄交付的那一项（唯一硬依赖）

**需求**：阶段候选接口，契约已冻结在 `docs/contracts.md:3342`（23.7）。

我需要他给我四样东西，缺一样我就只能继续挂占位提示：

1. **路由可用**：`POST /api/projects/{projectId}/milestones/candidates`，请求字段 `contractVersion / requestId / idempotencyKey / projectRevision / promptVersion: "milestone-candidate-v1" / maxCandidates(1–3) / focus`；
2. **响应形状**：每个候选 `candidateId / name / goal / doneCriteria / suggestedTasks[{title, doneCriteria}] / risks[] / sources[] / expiresAt`，顶层 `source / fallbackReason / notice`；
3. **失败语义**：`source: "fallback"` 时候选可能为空、`notice` 是中文；确认过期候选返回 409 `CANDIDATE_EXPIRED`（我要据此给中文提示）；
4. **确认链路不变**：候选不写项目，用户确认后仍走现有创建阶段接口带 `source: "ai-candidate"` + `candidateId` + `confirmedByUser: true`。

**他做完我能立刻做的**：把 `CloudProjectWorkbench.vue:182-184` 的占位换成真实调用，候选卡逐条「确认写入 / 丢弃」，确认后刷新阶段列表。

**我还需要李焰彬补一行**：`milestone-candidate-v1` 没有前端常量（`src/domain/recommendation.ts`），接接口时容易误发 `mvp-prompt-v3` 被 400。

## 3. 需要李焰彬交付的那一项

**材料数据层**：`listMaterials / getMaterial / listSegments / getUnderstanding` 四个函数 + `cloud` store 的 materials 状态。后端 `materialReads.ts` 已实现，我只需要能在页面拿到「材料名 + 状态 + 已确认条目数」，就能把「项目资料」从说明卡换成真实列表。

## 4. 我在等的这段时间可以自己做完的

- 候选卡组件（纯展示 + 状态机 + 单测），**不伪造成功**：接口未接通前按钮仍然给“暂未接入”提示，只是把 UI 骨架和测试先写好；
- 证据「挂到任务」入口（`cloud.attachEvidenceToTask` 已有，页面没按钮）——这条不依赖任何人；
- 空状态与错误态复核：候选失败、材料为空、时间线不可用三种情况的文案。

## 5. 可以直接发给姜厚禄的一段话

> 阶段候选这块我这边卡住了：契约 23.7 已冻结，但 `router.ts:199` 的 milestones 分支没有 `candidates` 路由，`milestone-candidates` 表已建。麻烦给一个可用的 `POST /projects/{id}/milestones/candidates`，我需要：① 上面 4 个字段的请求/响应示例；② `fallback` 时候选为空 + 中文 `notice`；③ 过期确认返回 409 `CANDIDATE_EXPIRED`。确认链路我不改，仍走现有创建阶段接口带 `source: "ai-candidate"`。另外请同步告诉李焰彬加 `milestone-candidate-v1` 前端常量，否则我接的时候会误发 `mvp-prompt-v3`。
