# V3 前端提交方案（建议稿，未执行；含隔离验证结论）

> 状态：**仅建议**。本文不表示已暂存、已提交或已推送；本轮未执行 `git add` / `commit` / `push` / `reset` / `checkout` / `clean` / `stash`。
> 配套材料：PR 描述草稿 `docs/v3-pr-draft.md`，实现说明 `docs/v3-frontend-delivery.md`。
> 验证日期：2026-10-20。验证方式：独立 `git worktree`，detached HEAD，不改动主工作区与暂存区。

---

## 0. 结论摘要

| # | 结论 |
| --- | --- |
| 1 | **A 组不能以当前分支 HEAD `ac65287` 为目标基线独立交付。** 该基线本身 typecheck 21 错、62 条用例失败；A 组不引入回归，但也无法让基线变绿，且 `src/domain/cloudView.ts` 真实依赖 v2 的 `Task.draftKey` 类型。 |
| 2 | **A 组可以以 `origin/main`（`a71b1e1`）为基线，按"数据层"独立交付**：实测 typecheck 0 错、`npm test` 815/815（34 文件）、build 通过、eslint 0。 |
| 3 | **页面接线不能随数据层一起进 `origin/main`**：`src/views/WorkbenchView.vue` 在 main 已被 PR #16 重构（拆 tabs），A 组的页面补丁冲突，必须按新结构重做；`src/App.vue`、`src/views/ProjectMapView.vue` 可应用但需与页面重构一并验证。 |
| 4 | 原提交方案把 `src/types/platform.ts` 整文件计入 A 组**不准确**：该文件 3 个 hunk 中，前 2 个（`SuggestedStep.taskId/status`、`Task.draftKey`）属 v2，只有第 3 个（423 行 V3 契约类型）属 V3。`src/domain/recommendation.ts` 同理（`ClaimTaskResult.status` 与 `describeAdvisorFailure` 属 v2/§14）。 |
| 5 | B 组的 v2 实现修复（`draftKey` 持久化、聊天长度校验）**已合入 `origin/main`**（PR #14 / #15），因此在 main 基线上不再构成 V3 的前置依赖；在 `ac65287` 基线上则必须补齐，且补齐量等价于整个 B 组。 |

---

## 1. 评审基线与假设

### 1.1 候选基线

| 候选 | 提交 | 状态 | 说明 |
| --- | --- | --- | --- |
| 当前分支 HEAD | `ac65287` | 与 `origin/feature/liyanbin-v2-materials` 一致 | 工作区全部改动的实际 diff 基础；**落后 `origin/main` 36 个提交**，基线自身红灯 |
| 默认合并目标 | `origin/main` = `a71b1e1` | `Merge pull request #19 from meeluu/codex/v3-v4-backend` | 已含 PR #14（draftKey 幂等）、#15（v2 集成修复）、#16（工作台拆分 tabs）、#17–#19（契约与 V3 后端）；基线自身 typecheck 0 错、25 个测试文件全绿 |
| 本机 `main` | `c617222` | 落后 origin/main 36 个提交 | 不可用于验证 |

**假设（未经负责人确认）**：`origin/main` 是 PR 的合并目标。本文所有"可独立交付"的结论都基于该假设；若实际目标仍是 `ac65287`，则按 §3 的依赖结论执行——A 组必须与 B 组同批交付。

### 1.2 隔离验证目录（保留供复核，未清理）

| 目录 | 内容 |
| --- | --- |
| `D:/bdana_program/scp-v3-verify-baseline` | 纯净 `ac65287`，无任何改动（对照基线） |
| `D:/bdana_program/scp-v3-verify-ac65287` | `ac65287` + 原方案 A 组（`types/platform.ts` 整文件） |
| `D:/bdana_program/scp-v3-verify-agroup-strict` | `ac65287` + 严格 A 组（`types/platform.ts` 只取 V3 hunk） |
| `D:/bdana_program/scp-v3-verify-main` | 纯净 `origin/main`（`a71b1e1`） |
| `D:/bdana_program/scp-v3-verify-main-data` | `origin/main` + V3 数据层（不含页面文件与 2 个页面测试） |

所有目录均用 `npm ci` 按 `package-lock.json` 安装依赖，未复制主工作区的 `node_modules`、`dist` 或 `.tmp-v3-backend/`。

---

## 2. 隔离验证结果

### 2.1 对照：纯净基线 `ac65287`

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | **21 处错误**（`Task.draftKey` 类型缺失被测试引用、`Project.profile` 必填、`ProjectProfileForm` 旧 props、`askAboutStep` 签名） |
| `npm test` | **717 用例：655 通过 / 62 失败**（24 文件，5 个文件失败） |

结论：`ac65287` 不是绿色基线。这解释了为什么"完整工作区全绿"不能直接推断"拟提交子集也全绿"。

### 2.2 严格 A 组（`ac65287` + 仅 V3 hunk）

应用内容：10 个新增源码、9 个数据层测试 + 2 个页面测试、3 个 support、`vitest.config.ts`、`vitest.integration.config.ts`、脚本、`package.json`、`README.md`、`src/types/platform.ts` 的 V3 hunk（423 行）、`src/domain/recommendation.ts` 的 V3 hunk（59 行）、`src/services/{http,advisorApi}.ts`、`App.vue`、两个页面。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | **23 处错误** = 基线 21 + 新增 **2** 处 |
| 新增错误 | `src/domain/cloudView.ts(79,5)`、`tests/stores/migration.test.ts(37,9)`：`draftKey` 不存在于 `Task` |
| `npm test` | **789 用例：727 通过 / 62 失败**；失败集合与基线**逐条一致（零差异）**；A 组新增 72 用例**全部通过** |
| `npm run build` | 通过（exit 0） |
| `npx eslint .` | 通过（exit 0） |

结论：A 组代码**不引入测试回归**，构建与 lint 正常；但类型上真实依赖 v2 的 `Task.draftKey`，且在旧基线上无法让 typecheck / test 变绿。

### 2.3 原方案 A 组（`ac65287` + `types/platform.ts` 整文件）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | **10 处错误**：因整文件带入 `Task.draftKey`、`SuggestedStep.status`，基线实现（`persistence.ts`/`workbench.ts`）未补，新增 3 处"缺 draftKey"错误 |
| `npm test` | 789 用例：727 通过 / 62 失败（失败集合与基线一致） |
| `npm run build` / `npx eslint .` | 通过 / 0 |

结论：typecheck 错误数看似减少（21→10），实际是"把错误从测试文件挪到实现文件"，并不代表更健康；原方案的分组不成立。

### 2.4 `origin/main` + V3 数据层（不含页面）

应用内容：V3 类型 hunk、`recommendation.ts` V3 hunk、`http.ts`/`advisorApi.ts`/`vitest.config.ts`/`package.json`/`README.md` 补丁、10 个新增源码、9 个数据层测试、3 个 support、集成配置与脚本。**不含** `App.vue`、`views/**`、`AppSession.test.ts`、`WorkbenchViewCloud.test.ts`。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | **0 错误** |
| `npm test` | **815/815 通过**（34 文件 = main 25 + V3 9），0 失败 |
| `npm run build` | 通过（exit 0） |
| `npx eslint .` | 通过（exit 0） |

补丁可应用性：`http.ts`、`advisorApi.ts`、`vitest.config.ts`、`package.json`、`README.md`、`types/platform.ts` 的 V3 hunk、`recommendation.ts` 的 V3 hunk 均 `git apply --check` 通过。

### 2.5 完整混合工作区（主目录，未隔离）

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | 0 错误 | 含 B 组的 `draftKey`/测试适配 |
| `npm test` | 787/787 通过（35 文件） | 基于 `ac65287`，用例数少于 main；**不代表拟提交版本** |
| `npm run build` / `npx eslint .` | 通过 / 0 | — |
| `npm run test:integration:v3-local` | 12/12（2026-10-20 最近一次实际运行） | 后端来源未知，见 PR 草稿 §5；未在 `origin/main` 基线上重跑 |

> 因此：**787/787 只能证明"混合工作区在旧基线上自洽"，不能用于暗示"拟提交子集在目标基线上全绿"。** 拟提交版本的可验证结果见 §2.4（815/815）。

### 2.6 失败用例集合对比

对 `scp-v3-verify-baseline` 与 `scp-v3-verify-agroup-strict` 的 JSON 报告做规范化比较（按文件名 + 用例全名）：

```
baselineFailed = 62
agroupFailed  = 62
only in baseline = (空)
only in agroup   = (空)
```

即 A 组**没有引入任何一条新失败，也没有修复任何一条基线失败**。

---

## 3. A 组对 B 组的真实依赖

| 依赖 | 证据 | 性质 |
| --- | --- | --- |
| `Task.draftKey` 类型 | `src/domain/cloudView.ts(79,5)` 在构造本地 `Task` 时写入 `draftKey`；`tests/stores/migration.test.ts(37,9)` 同样 | **代码级依赖**，必须随 V3 提供该字段（可仅取 `types/platform.ts` 第 2 个 hunk） |
| `persistence.ts` 的 `draftKey` 读取 | 一旦 `Task.draftKey` 为必填，`persistence.ts(112)` 构造 `Task` 即报错 | **类型连带依赖**：需要 B1 的 +3 行 |
| `workbench.ts` 的 `draftKey` 写入 | 同上，`workbench.ts(490,1452)` 两处 | **类型连带依赖** |
| `tests/domain/fixtures.ts` 的 `profile/material*` | `Project.profile` 必填，基线夹具缺字段 | 基线已有错误，与 V3 无关，但 typecheck 覆盖 `tests/**` |
| `workbench.test.ts` / `ProjectProfileForm.test.ts` 的类型错误 | 基线遗留（`askAboutStep` 签名、组件 props 已改） | 基线已有错误，与 V3 无关 |
| 62 条测试失败 | 基线遗留（A1/B1/C1 测试适配未提交） | 需 B2 全部才能归零 |

**在 `ac65287` 基线上的最小前置集合**（使 typecheck 归零 + 测试全绿）：

1. `src/types/platform.ts` 的 `Task.draftKey` hunk（V3 必需）；
2. `src/stores/persistence.ts` 的 `draftKey` 读取（3 行）；
3. `src/stores/workbench.ts` 的 `draftKey` 写入（2 处）；
4. `tests/domain/fixtures.ts` 的 `profile/material*` 补齐；
5. `tests/stores/workbench.test.ts` 的 2 处签名适配；
6. `tests/ui/ProjectProfileForm.test.ts` 重写；
7. 其余 4 个测试文件的 A1/B1/C1 适配（消除 62 条失败）。

第 1–7 项合计即 **B 组全部内容**。故"最小前置"在此基线上等于"把 B 组整个带入"，与"V3 独立 PR"目标矛盾——这是不推荐方案 A 的原因。

**在 `origin/main` 基线上**：第 2、3、4、5、6 项已合入，第 1 项已存在；V3 只需自己的类型/实现，**不依赖 B 组**（实测 §2.4）。

---

## 4. 修正后的提交方案：拆成两个交付单元

### PR-1（推荐先行）：V3 数据层，基线 `origin/main`

| 提交 | 标题 | 文件 | 理由 |
| --- | --- | --- | --- |
| C1 | `feat(v3): add contract types and authenticated HTTP/API clients` | `src/types/platform.ts`（**仅 V3 hunk，423 行**）、`src/services/http.ts`、`src/services/v3Http.ts`、`src/services/authApi.ts`、`src/services/projectsApi.ts` | 纯契约与传输层；`--check` 已验证可干净应用 |
| C2 | `feat(v3): add cloud view, advisor context and local migration domain` | `src/domain/cloudView.ts`、`localMigration.ts`、`v3Advisor.ts`、`src/domain/recommendation.ts`（仅 V3 hunk）、`src/services/advisorApi.ts` | 依赖 C1；`cloudView.ts` 需要 main 已有的 `Task.draftKey` |
| C3 | `feat(v3): add session, cloud, migration and platform stores` | `src/stores/session.ts`、`cloud.ts`、`migration.ts`、`platform.ts` | 依赖 C1/C2；不含页面 |
| C4 | `test(v3): cover V3 data layer and keep npm test offline` | 9 个数据层测试、3 个 support、`vitest.config.ts` | 依赖 C1–C3；实测 815/815 |
| C5 | `test(v3): add opt-in integration suite` | `tests/integration/v3LocalBackend.integration.test.ts`、`vitest.integration.config.ts`、`scripts/run-v3-local-integration.mjs`、`package.json`、`README.md` | 独立执行入口，避免与离线单测混淆 |
| C6 | `docs: add V3 delivery and PR materials` | `docs/v3-frontend-delivery.md`、`docs/integration-v3-local.md`、`docs/v3-pr-draft.md`、`docs/v3-commit-plan.md` | 与代码同 PR，独立提交便于对照 |

验证目标：`typecheck` 0 错、`npm test` 815/815、`build` 通过、`eslint` 0（均已在 `scp-v3-verify-main-data` 实测）。

### PR-2（页面接线，需按 main 新结构重做）：基线 PR-1 合并后

| 文件 | 现状 | 说明 |
| --- | --- | --- |
| `src/App.vue` | 补丁可应用 | 启动初始化 + 用户名展示 |
| `src/views/ProjectMapView.vue` | 补丁可应用 | 云端只读展示 |
| `src/views/WorkbenchView.vue` | **补丁冲突** | main 已拆分为「项目推进 / 项目资料」tabs（PR #16）；A 组改动基于旧结构，需由页面负责人重新接线 |
| `tests/ui/AppSession.test.ts`、`WorkbenchViewCloud.test.ts` | 依赖上面三个文件 | 随 PR-2 提交 |

本单元**未验证**，不能声称成立。这也是 `docs/v3-frontend-delivery.md` §1.2 已声明的"页面接线部分完成"。

### 不再纳入

- **B 组全部内容**：`src/stores/persistence.ts`、`src/stores/workbench.ts`、`types/platform.ts` 的 v2 hunk、`recommendation.ts` 的 `describeAdvisorFailure` hunk、`tests/**` 的 v2 适配、交接记录 §14。原因：其实现部分已合入 `origin/main`（PR #14/#15）；测试适配已在 main 的 25 个绿色文件中。若仍需要提交它们，应作为独立的 v2 收尾 PR，与 V3 无关。

---

## 5. 纳入 / 排除

### 5.1 PR-1 纳入（21 个文件）

```
新增源码（10）
src/domain/cloudView.ts        src/domain/localMigration.ts   src/domain/v3Advisor.ts
src/services/authApi.ts        src/services/projectsApi.ts    src/services/v3Http.ts
src/stores/cloud.ts            src/stores/migration.ts        src/stores/platform.ts
src/stores/session.ts

修改源码（4，均按 hunk 精确取用）
src/types/platform.ts（V3 hunk）      src/services/http.ts
src/services/advisorApi.ts            src/domain/recommendation.ts（V3 hunk）

新增测试（9）
tests/domain/cloudView.test.ts        tests/domain/v3Advisor.test.ts
tests/stores/cloud.test.ts            tests/stores/cloudWrites.test.ts
tests/stores/migration.test.ts        tests/stores/platform.test.ts
tests/stores/session.test.ts          tests/services/projectsIdempotency.test.ts
tests/services/v3LocalTarget.test.ts

测试基建（3）与配置（2）
tests/support/v3Fixtures.ts  tests/support/v3LocalHarness.ts  tests/support/v3LocalTarget.ts
vitest.config.ts             vitest.integration.config.ts

集成设施（3）与文档（4）
tests/integration/v3LocalBackend.integration.test.ts
scripts/run-v3-local-integration.mjs   package.json   README.md
docs/v3-frontend-delivery.md  docs/integration-v3-local.md  docs/v3-pr-draft.md  docs/v3-commit-plan.md
```

> 说明：`src/types/platform.ts` 与 `src/domain/recommendation.ts` 必须用 `git add -p` 或等效方式只取 V3 hunk；整文件提交会带入 v2 类型与 §14 修复，改变 PR 性质。

### 5.2 PR-2 纳入（5 个文件，待页面负责人）

`src/App.vue`、`src/views/WorkbenchView.vue`、`src/views/ProjectMapView.vue`、`tests/ui/AppSession.test.ts`、`tests/ui/WorkbenchViewCloud.test.ts`

### 5.3 排除（不随任何提交）

| 路径 | 原因 | 处置 |
| --- | --- | --- |
| `.tmp-v3-backend/`（含 `integration.sqlite*`、`.env*`、`server/dist/`、`server/test/**`） | 本地后端构建与测试库，来源未知，可能含本地邀请码；**`.gitignore` 未覆盖** | 不暂存、不删除、不移动；禁用 `git add .` |
| `liyanbin-fix.patch` | 补丁快照，归属不明 | 保留原位 |
| `debug.log`、`f2.log`~`f7.log`、`m1.log` | 历史调试输出；`*.log` 已忽略 | 保留 |
| `dist/`、`node_modules/`、`output/`、`.codebuddy/` | 构建产物/缓存 | 已忽略 |
| B 组文件 | 已合入 main 或属独立收尾 | 不混入 V3 PR |

**依赖核查**：`src/**`、`tests/**`、`scripts/**`、`docs/**` 无任何对 `.tmp-v3-backend`、`liyanbin-fix.patch`、调试日志的路径引用；集成测试只读环境变量。**无"因排除文件缺失而无法运行"的阻塞。**

---

## 6. 提交前检查与剩余阻塞

### 6.1 提交前必做

1. 先确认 PR 目标基线是否为 `origin/main`（本文假设）；若否，按 §3 改为"V3 + B 组同批"。
2. 禁用 `git add -A` / `git add .`；按 §5 路径逐个暂存。
3. `src/types/platform.ts`、`src/domain/recommendation.ts` 用 `git add -p` 只取 V3 hunk；暂存后 `git diff --cached` 复核不含 `draftKey` 声明、不含 `describeAdvisorFailure`。
4. 暂存后 `git diff --cached --stat` 复核：不应出现 `.tmp-v3-backend`、`*.patch`、`*.sqlite`、`.env*`、`tests/ui/WorkbenchViewCloud.test.ts`（PR-1 阶段）。
5. 在 PR-1 分支上复跑 §4 的四项检查（目标 815/815）。

### 6.2 尚需确认

| # | 阻塞 | 影响 | 需要谁 |
| --- | --- | --- | --- |
| 1 | PR 目标基线是 `origin/main` 还是 `ac65287` | 决定"数据层独立 PR"是否成立 | 主理人 |
| 2 | V3 集成测试后端来源未知（无分支/SHA，仓库 `server/` 至今无 V3 路由） | 12/12 不可由本仓库复现，只能作为有条件验证 | 姜厚禄 |
| 3 | `GET /tasks`、timeline、`milestones/candidates` 在 `origin/main` 后端仍不存在；`progress supersede` 后端已实现但客户端未接入 | 任务刷新恢复与云端 AI 上下文不可用 | 姜厚禄 |
| 4 | 登录/迁移/云端写入 UI 未接线；`WorkbenchView.vue` 需按 main 新结构重做 | 云端仅数据层可用 | 雍蕾 |
| 5 | `types/platform.ts` / `recommendation.ts` 是否接受按 hunk 拆分提交 | 决定 PR 边界是否干净 | 李焰彬（提交人） |

---

## 7. 未执行声明

本轮**未**执行：`git add`、`commit`、`push`、`reset`、`checkout`（主工作区）、`clean`、`stash`、创建 PR、部署、发送消息。
本轮**未**修改：`src/**`、`src/views/**`、`server/**`、`docs/contracts.md`、`.gitignore`、被排除的本地文件。
本轮**仅修改文档**：`docs/v3-commit-plan.md`、`docs/v3-pr-draft.md`、`docs/v3-frontend-delivery.md`。
隔离目录（§1.2）保留不清理，供复核。
