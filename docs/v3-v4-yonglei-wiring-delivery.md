# 页面接线交付（雍蕾，2026-10-23）

> 基线：`HEAD = 08cbb72`（`main` 与 `yl` 同点）。`f83291d` 已在本分支历史里（`git merge-base --is-ancestor f83291d HEAD` 通过），**不用 rebase**；下文行号都按 08cbb72 报。
> 前置：李焰彬的材料/更正/聊天数据层已合（`fa01aab`、`1a1eed9`）；姜厚禄 D13（v3 建议与聊天）已合，D12（阶段候选）仍未做。
> 更正一处我上次说错的话：`MILESTONE_CANDIDATE_PROMPT_VERSION = 'milestone-candidate-v1'` **确实早就在 `src/domain/recommendation.ts:63`**，上次是我看了旧文档误判，抱歉。

## 1. 本轮五项交付

| # | 要求 | 落在哪 | 状态 |
| --- | --- | --- | --- |
| 1 | 项目资料页：材料列表 / 详情 / 片段 / 理解内容 + 加载 / 空 / 失败重试 | 新组件 `src/components/CloudMaterialsPanel.vue`，挂在 `CloudProjectWorkbench.vue` 的「项目资料」标签页 | ✅ |
| 2 | 材料操作：上传 / 归档 / 恢复 / 重新解析 | 同上（上传前置校验 md/txt 与 1 MB，`File → bytesToBase64 → cloud.uploadMaterial`） | ✅ |
| 3 | 进展更正：入口 + 成功后刷新列表与阶段统计 + 版本冲突 | `CloudProjectWorkbench.vue` 进展区（行内更正表单 + 已更正历史折叠） | ✅ |
| 4 | 云聊天：消息展示 / 发送 / 失败重试 | 新组件 `src/components/CloudChatPanel.vue` | ✅（历史不持久化，已如实标注） |
| 5 | 页面验收：真实数据加载、上传、更正、聊天、切项目隔离 | 真后端 + 真 Chrome，见 §4 | ✅ |

### 1.1 项目资料页

- 列表：材料名、状态（等待解析/已解析/解析失败/格式不支持/已归档）、内容版本 + 元数据版本、大小、更新时间、只读标记；`显示已归档` 勾选后才拉归档材料。
- 详情：点开任意一条 → 并行读片段与理解条目（命中 store 缓存则不发请求），片段显示「第 N 段 · 行 a–b · 字数」与正文，理解条目显示中文块名、确认状态、「来自第 x–y 行」。
- 三态严格区分：`loading` 只说“正在读取”；`error` 显示服务端 `message` 并给「重试」；只有 `materialsHydrated && status === 'ready'` 且为空才说“还没有材料”。
- 解析失败的材料不进片段区，直接给“可以重新解析或删除重传”的下一步。

### 1.2 材料操作

- 上传：页面只发 `{ name, contentBase64 }`；非 md/txt、超 1 MB 在客户端就拦下并给中文原因；`deduplicated=true` 提示“之前传过，已复用”；`parse_failed` 明确“已保存但解析失败”。
- 归档/恢复/重新解析：按钮按 `readOnly`、`archivedAt`、`isCurrent` 决定显示；成功后按服务端返回重拉列表与详情（重新解析会推版本号，理解条目需重新确认）。
- 失败一律展示 `message`，不展示 `code`。

### 1.3 进展更正

- 每条当前进展右侧「更正」→ 行内表单，预填原文；提交带 `expectedRevision`。
- `STALE_REVISION` → 中文提示“刚被更新过，已刷新”，并 `refreshProgress()`，不静默覆盖。
- 成功后旧记录变 `superseded`：从当前进展移出，收进「已更正的进展（N 条，正文保留）」折叠区，不再计入当前进展。

### 1.4 云聊天

- 标题标注「本次会话」，正文说明“刷新或换设备会清空”。
- 回答带来源标签（AI 模型回答 / 服务端规则兜底）与兜底原因中文（超时、不可用、未配置、输出不合规、限流），引用显示“依据：《材料》第 x–y 行”。
- 失败保留原问题（`chat.pendingQuestion`），「重试」一键重发；在途时禁用输入与发送。

## 2. 验收暴露并修掉的三个页面缺陷

| 缺陷 | 原因 | 修法 |
| --- | --- | --- |
| 空白项目（无阶段）里记的进展/证据“记完就消失” | 过滤条件写的是 `item.milestoneId === currentMilestone?.milestoneId`，没有阶段时右侧是 `undefined`，`null !== undefined` 全部被滤掉 | 抽 `matchesCurrentStage()`：无当前阶段时匹配 `milestoneId === null` |
| 新建项目后发聊天直接报「任务列表尚未加载完整」 | `cloud.createProject()` 之后 `tasksHydrated` 仍为 false（只有 `openProject()` 会读任务），AI 上下文前置校验挡住 | `createProject()` 成功后补 `refreshTasks({silent})` 与 `refreshMaterials({silent})` |
| 新建/切换项目后聊天串台 | `cloud.chat` 是单份内存状态、无 projectId；新建项目路径不清空，且组件会随 `v-if` 重挂载，普通 watch 判不出变化 | 模块作用域记住上次展示的 projectId，挂载时不一致就 `clearChat()`；同实例内切换再走 watch |

## 3. 本轮没做 / 等别人（不是页面能补的）

| 事项 | 现状 | 谁 |
| --- | --- | --- |
| **云端理解条目永远是 0 条** | 后端上传只切片段，`understanding_items` 全仓只有迁移写入（`server/src/v3/migration.ts:888`），没有任何生成接口 → 页面接好读取与空态，但拿不到内容，AI 也用不到云端材料 | 姜厚禄：补“生成理解草稿”接口 |
| 阶段候选入口 | 仍是“接口暂未接入”提示（D12 未做） | 姜厚禄 |
| 项目时间线 | 无接口，页面不展示 | 姜厚禄 |
| 聊天历史刷新恢复 | 后端无落库端点，只能本次会话 | 姜厚禄 |
| AI 建议卡片 | 数据层已就绪（`refreshAdvisor` + `buildAdvisorContext`），但不在本轮 5 项内，页面未加入口 | 我，下一轮 |
| 本地模式挂 v3 | 按提醒**没有**给本地工作台加入口，本地仍走 v2 | — |

## 4. 验证

| 项 | 结果 |
| --- | --- |
| 全量 `vitest run` | **979 通过** |
| 本轮新增用例 | 材料面板 8 条、聊天面板 6 条、工作台 +5 条（更正成功/版本冲突/已更正历史/空白项目进展/未挂阶段证据） |
| `vue-tsc --noEmit` | 0 错误 |
| `eslint .` | 0 问题 |
| `vite build` | 通过 |
| 浏览器全流程（桌面 1440） | 注册 → 建项目 → 空态 → 上传 → 片段/理解 → 重新解析（版本 2）→ 归档（列表归零）→ 显示已归档 → 恢复 → 记进展 → 更正 → 聊天提问 → 新建第二个项目验证隔离：**全通过，页面异常 0** |
| 390px 窄屏 | 项目资料、更正表单、聊天三处 `scrollWidth` 均为 390，无横向溢出 |

证据：`docs/acceptance/v3-ui/` 下 `page-wiring-log.txt`、`narrow-log.txt`，截图 `16`–`23`。

## 5. 回给两位的话

**给姜厚禄**：D13 已用上——云端建议/聊天都发 v3 且带 `milestoneContext`，聊天在 mock provider 下能正常回答，兜底原因与引用展示都按契约走。还需要你补三件：① 云端材料理解条目的生成接口（现在上传只有片段，`understanding_items` 只有迁移写入，页面显示 0 条且 AI 用不到材料）；② 阶段候选（D12）；③ 聊天落库。另外契约 22.4 仍缺 supersede 的请求字段表，我是照 `server/src/v3/progress.ts:325-336` 实现的，建议补进契约。

**给李焰彬**：数据层接口齐全，页面基本是直连。两个小坑你那边顺手修更好：`createProject()` 之后 `tasksHydrated` 仍是 false（新建项目直接聊天会报“任务列表尚未加载完整”）、`chat` 不随新建项目清空（切项目串台）。我已在页面兜底，但根上在 store 更合适。
