# PR 描述草稿：V3 前端数据层

> 状态：**草稿，未提交、未推送、未创建 PR**。
> 目标基线：`origin/main` = `a71b1e1`（**假设**，尚未经负责人确认；当前分支 HEAD `ac65287` 落后 36 个提交且自身红灯，不适合作为目标）。
> 范围：本 PR 只含**数据层**；页面接线另开 PR，见 `docs/v3-commit-plan.md` §4。
> 说明：本文只描述已在隔离目录实际验证的交付集合，不代表 V3/V4 平台整体完成。

---

## 标题建议

`feat(v3): 前端 V3 数据层（会话、云端资源、本地迁移与顾问上下文）`

## 1. 解决的问题

V3 契约（账号会话、云端项目/阶段/任务/证据/进展、本地项目迁移）在前端缺少对应实现：页面只能操作 localStorage 中的本地项目，无法读取服务端已确认的数据，也无法在换设备后恢复。旧 store 把"本地写入"与"云端只读数据"混在一起，直接接线会出现两类错误：

1. **写错地方**：云端模式下调用本地写 action，数据进了 localStorage 而不是服务端，刷新后"消失"；
2. **失败被伪装成成功**：接口 404/400 时用空数组渲染，用户看到"暂无任务"，实际是契约缺口。

本 PR 提供独立数据层：会话、云端资源、迁移各自成 store，所有 action 统一返回 `ActionResult<T>`，失败保留原状态并给中文原因；同时提供云端数据的只读投影，供后续页面接线使用。

## 2. 实现后的行为

### 2.1 数据层（本 PR 完成）

| 模块 | 文件 | 行为 |
| --- | --- | --- |
| 契约 HTTP 适配 | `src/services/v3Http.ts` | 契约版本、`requestId`、幂等键、超时/取消、错误归一化（`V3Result`/`V3ApiError`）、写响应回显校验、`replayed` 标记 |
| 鉴权 | `src/services/authApi.ts` | `GET /api/auth/me`、登录、退出；Cookie 由浏览器管理，前端不读取不保存 |
| 资源 API | `src/services/projectsApi.ts` | 契约 22.1–22.5 项目/阶段/任务/证据/进展读写，含版本冲突、幂等键、跨项目校验 |
| 会话 store | `src/stores/session.ts` | `idle/loading/authenticated/unauthenticated/error`；项目列表；401 清理；epoch 丢弃迟到响应 |
| 云端 store | `src/stores/cloud.ts` | 单一数据副本；写后合并、失败不半更新；`busy` / `isActionLoading` / `sync.status` / `lastError` / `contractBlockers` |
| 来源编排 | `src/stores/platform.ts` | 本地/云端来源切换、初始化、登录退出、选择/创建云端项目、迁移入口 |
| 只读投影 | `src/domain/cloudView.ts` | 服务端数据 → 旧页面 `Project` 形状；不伪造任务/疑问/材料/聊天 |
| 本地迁移 | `src/domain/localMigration.ts` + `src/stores/migration.ts` | 只读检测、显式确认、`migrationId` 复用重试、schema 版本拦截、失败保留 localStorage |
| AI 上下文 | `src/domain/v3Advisor.ts` + `cloud.buildAdvisorContext()` | 组装阶段上下文；任务列表不完整时显式 `TASKS_NOT_AVAILABLE`，不用空数组冒充完整上下文 |
| 传输扩展 | `src/services/http.ts` | 支持 `PATCH`/`DELETE` 与 `credentials: 'include'`；默认值不变，既有 V2 调用方行为不变 |
| 顾问上下文字段 | `src/services/advisorApi.ts` + `src/domain/recommendation.ts` | 建议/聊天携带 `milestoneContext` 与 v3 提示词；解析 `citations` / `milestoneRevision` |

一致语义（已由单测固化）：

- 所有 action 返回 `{ ok: true, data }` 或 `{ ok: false, code, message }`；`message` 为中文，可直接展示。
- 写失败不产生"半更新"：列表、版本号、`lastError` 要么整体成功，要么保持原值。
- 迁移只在 `userConfirmed: true` 时发请求；`pending-confirmation` 不会自动上传。
- 迁移成功后**不删除**本地项目；失败/超时重试复用同一 `migrationId`。

### 2.2 页面入口（不在本 PR）

`src/App.vue`、`src/views/WorkbenchView.vue`、`src/views/ProjectMapView.vue` 的云端只读接线**不随本 PR 提交**。原因：`origin/main` 已将工作台重构为「项目推进 / 项目资料」tabs（PR #16），现有页面补丁无法直接应用，需按新结构重做。

因此本 PR 合入后：

- 数据层可用、可测；
- **页面行为不变**，仍以本地项目为主路径；
- 云端只读展示、来源切换、`guardCloudWrite` 拦截等由后续页面 PR 提供。

## 3. 后端端点缺口与影响

| # | 能力 | 现状 | 对前端的影响 |
| --- | --- | --- | --- |
| 1 | `GET /api/projects/:id/tasks` | `origin/main` 后端只有 `POST /tasks`、`PATCH /tasks/:id`、`POST /tasks/:id/:action`、`link-milestone`，**无 GET** | **刷新/重进项目后任务丢失**（阶段统计仍可读）；`tasksHydrated=false`；`buildAdvisorContext()` 返回 `TASKS_NOT_AVAILABLE`，页面不能用空任务调用 AI |
| 2 | 时间线（契约 22.11） | 后端 `server/src/v3` 无 timeline 路由 | `cloud.loadTimeline()` 恒返回 `TIMELINE_NOT_AVAILABLE`，不发请求 |
| 3 | 阶段候选（契约 23.7） | 后端 router 无 `milestones/candidates` 路由（仅有候选表与内部查询） | 客户端未实现调用，AI 生成阶段候选不可用 |
| 4 | 进展 supersede（契约 22.4） | **后端已实现** `POST /progress/:id/supersede` | **客户端尚未接入**，页面无法修正已提交进展；属后续功能，不是本 PR 缺陷 |
| 5 | 已确认材料读取 | 后端 materials 路由只有 understanding 的写操作，无列表/详情 GET | `confirmedMaterials` 需调用方显式传入，无法回读 |
| 6 | 聊天问题长度（契约 6.4） | 历史行为不一致 | 前端已前置拒绝（该修复已在 `origin/main`）；后端应返回 400 `INVALID_INPUT` 而非静默截断 |
| 7 | 创建项目不得注入模板阶段（契约 22.1） | 客户端已加防御 | 请求体不含 `milestones`；服务端若返回阶段，客户端以 `INVALID_RESPONSE` 拒绝 |

> 第 1 项是**任务刷新恢复与云端 AI 上下文的硬阻塞**；第 4、5 项字段未冻结，客户端刻意不实现。

## 4. 验证（针对本 PR 实际交付集合）

验证方式：在本 PR 分支 `feature/v3-frontend-data-layer`（6 个提交，基于 `origin/main` = `a71b1e1`）上执行，`npm ci` 按 `package-lock.json` 安装。验证日期 2026-10-20。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | **0 错误** |
| `npm test` | **815/815 通过（34 文件，0 失败）** = `origin/main` 原有 25 个文件 + V3 数据层 9 个文件 |
| `npm run build` | 通过（exit 0） |
| `npx eslint .` | 通过（exit 0，无输出） |

**必须区分的三组数字（避免误读）**

| 形态 | 结果 | 含义 |
| --- | --- | --- |
| **本 PR 分支** `feature/v3-frontend-data-layer` | **815/815，typecheck 0，build/eslint 通过** | 本 PR 的实际状态（已实际运行） |
| 隔离验证目录 `scp-v3-verify-main-data` | 815/815，typecheck 0 | 与分支结果逐项一致，无差异 |
| 完整混合工作区（主目录，基线 `ac65287`） | 787/787，typecheck 0 | 含 v2 修复与页面接线；**不等于本 PR** |
| 旧基线 `ac65287` 本身 | 717 用例 62 失败，typecheck 21 错 | 基线自身不绿，不能作为目标 |

**测试性质**：815 条用例全部离线，`fetch` 被替身化，不发网络请求。它们验证前端状态机与契约解析，**不是真实联调**。

**集成测试（不在本 PR 的验证范围）**：`npm run test:integration:v3-local` 最近一次实际运行是 2026-10-20 的 **12/12**，但该次运行在旧基线（混合工作区）上进行，**未在 `origin/main` + 本 PR 的目录中重跑**；后端来源限制见 §5。

## 5. 集成测试的后端来源（重要限制）

- 最近一次 12/12 连接的是 `http://127.0.0.1:8099` 上已运行的本地 V3 后端；
- 该后端来自工作区内**未纳入版本库**的临时构建目录（无 `.git`，`package.json` 版本 `0.1.0`），**无法给出分支或提交 SHA**；
- `origin/main` 已合并 V3 后端（PR #19，`server/src/v3/**`），但该次 12/12 运行的构建产物早于这次合并，**与 main 是否同源无法证明**；即使同源，上述 3 个缺口（GET tasks、timeline、candidates）在 main 后端仍不存在；
- 因此只能表述为"在特定本地后端上的有条件验证"，**不构成生产验收**；
- 复现前置：负责人提供包含 V3 路由的后端（分支、提交或可核验构建产物任一即可）。

测试写入数据带 `[v3local]` / `it_v3local_` 标记，不自动清理；建议一次性数据库文件，详见 `docs/integration-v3-local.md`。

## 6. 本地 A1 模板创建决策的适用范围（勿与云端混淆）

产品方于 2026-10-20 书面确认 **A1 / B1 / C1**（保持现状）。该决策**只适用于本地来源**：

| 场景 | 行为 | 依据 |
| --- | --- | --- |
| 本地 `workbench.createProject`（A1） | 按课程题目模板注入里程碑、初始任务、疑问、论文方向与首条问候语；banner 为静态说明（B1）；工作台内嵌项目地图（C1） | `李焰彬_v2联调与交接记录.md` §14.7 / §14.9；相关实现与测试适配已在 `origin/main` |
| 云端 `platform.createCloudProject` → `cloud.createProject` | **只提交 `name` / `short` / `profile`**，不注入阶段或模板；服务端若擅自返回阶段，客户端以 `INVALID_RESPONSE` 拒绝 | 契约 22.1；`src/stores/cloud.ts` |

即：**"新建项目自动带模板"是本地产品的既定行为，不是云端契约行为**。评审与测试不得据此要求云端创建带初始阶段；云端若要模板，属于新的产品与契约决策。

## 7. 评审关注点

1. **只读边界**：云端来源下所有本地写入口必须经 `guardCloudWrite`（由后续页面 PR 实现）；数据层不主动调用本地写 action。
2. **失败不伪装**：空列表必须区分"真的为空"与"加载失败/未实现"，用 `lastError` / `sync.status` / `contractBlockers` 判断。
3. **迁移不自动发请求**：`pending-confirmation` 只是检测结果，只有用户确认才 POST。
4. **幂等语义**：同一逻辑操作重试复用同一 `idempotencyKey`；版本推进后的同内容属新操作，键必须变化，否则 `IDEMPOTENCY_CONFLICT`。
5. **hunk 边界**：`src/types/platform.ts` 只含 V3 类型块；`src/domain/recommendation.ts` 只含 V3 常量/类型，不含 v2 的 `ClaimTaskResult.status` 与 §14 的失败文案修复（二者已在 `origin/main`）。
6. **展示约束**：用户可见文本不出现错误码、字段名、内部状态名（契约 4.3 / 17.3）。

## 8. 非目标

- 不实现页面接线（登录、来源切换、迁移弹窗、云端写入入口）；
- 不补齐后端缺失端点，不改 `server/`；
- 不修改正式契约（`docs/contracts.md`）；
- 不把云端项目映射成完整的本地 `Project`（缺失字段保持空，不伪造）；
- 不承诺 V3/V4 平台整体可用。

## 9. 配套材料

- 提交拆分、隔离验证与文件清单：`docs/v3-commit-plan.md`
- 实现与接线说明：`docs/v3-frontend-delivery.md`
- 集成测试说明：`docs/integration-v3-local.md`
- 历史背景与产品决策：`李焰彬_v2联调与交接记录.md` §14
