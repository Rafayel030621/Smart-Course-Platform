# V3-V4 雍蕾交付说明：里程碑 / 阶段推进 / 账号界面

> 分支：`yl`（基于 `origin/main` `ce3d772`）
> 范围：仅前端页面与交互（`src/App.vue`、`src/views/**`、`src/components/**`、对应 UI 测试与验收截图）。
> 不修改后端实现、不改契约，不伪造接口成功状态。
> 相关依据：`V3-V4任务分配与实施计划.md` 第三节第 3 条（雍蕾）、`docs/v3-v4-interface-status.md`、`docs/v3-frontend-delivery.md`。

## 1. 结论

四项任务**功能面已完成**，其中两项受后端/数据层缺口限制，页面按“暂不支持”如实显示，不用假数据代替：

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| 1. 里程碑功能闭环 | ✅ 完成 | 新建/编辑/目标/完成标准/截止时间/排序/完成/重开/归档/恢复，阶段任务数与完成比例，空状态双入口；AI 阶段候选只做入口与说明，**接口未实现** |
| 2. 阶段推进界面 | ✅ 完成 | 当前阶段卡片、目标与完成标准、阶段任务、进度、关联证据、最近进展、「下一步做什么」入口；保持「项目推进｜项目资料」双标签布局 |
| 3. 登录/注册/退出/迁移界面 | ✅ 完成 | 登录、注册（用户名/昵称/密码/确认密码/邀请码）、退出、当前用户、本地迁移确认与重试、中文失败提示 |
| 4. 响应式与可访问性 | ✅ 完成 | 390px 无横向溢出（实测 `scrollWidth=390`）、标签页方向键/Home/End、表单与按钮可键盘操作、切换标签与项目不丢输入 |

阻塞项（不是本页能补的）：阶段候选接口、项目时间线接口、云端材料列表、云端阶段化 AI 建议、证据/进展单条读取。见 §5。

## 2. 页面入口

| 页面 | 文件 | 说明 |
| --- | --- | --- |
| 应用外壳 | `src/App.vue` | 启动调 `/api/auth/me`；未登录显示登录卡片，已登录显示昵称 + 云端/本地切换 + 退出；登录后检测本地项目并弹出迁移面板；刷新后自动恢复上次项目 |
| 登录 / 注册 | `src/components/AuthPanel.vue` | 单组件双模式，前端先校验（密码 ≥ 8 位、两次一致、邀请码必填），失败保留输入并显示中文原因 |
| 本地迁移 | `src/components/LocalMigrationPanel.vue` | 只在用户点「确认迁移」时发请求；失败给「重试」，成功显示「已迁移」；可「稍后处理」回到本地项目 |
| 云端工作台 | `src/components/CloudProjectWorkbench.vue` | 「项目推进 / 项目资料」两个标签页（`v-show` 常驻，切换不丢输入）；里程碑管理、阶段任务、最近进展、关联证据、「下一步做什么」 |
| 云端项目地图 | `src/components/CloudProjectMapView.vue` | 复用 `ProjectMindMap`，任务未加载成功时不把空列表当“没有任务” |
| 页面接线 | `src/views/WorkbenchView.vue`、`src/views/ProjectMapView.vue` | 云端来源时切换到云端视图，本地流程保持不变 |

## 3. 本轮实际修掉的问题

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 新建任务默认是「待办任务」，落库后 `milestoneId=null`，阶段视图按阶段过滤 → **任务建完就“消失”**（浏览器验收第一次跑出来的真实缺陷） | 新建任务默认挂当前阶段；另列出「未挂阶段的任务」并提供「挂到当前阶段」（`linkTaskToMilestone`） |
| 2 | 刷新页面后已登录但显示「创建云端项目」，看不到已有项目 | 会话恢复时 `isAuthenticated` 早于项目列表返回，只靠登录 watcher 会读到空列表；改为等列表就绪后补选第一个项目 |
| 3 | 有项目时无法新建第二个项目（创建表单只在“无项目”时出现） | 顶栏加「新建云端项目」，创建成功回到项目视图 |
| 4 | 编辑阶段时截止时间按 UTC 截断，编辑框里的时间比实际早 8 小时 | `toLocalDateTimeInput()` 转本地时间 |
| 5 | 任务「开始/完成/重开」按钮的忙碌态用了不存在的 action 键（`taskAction`） | 改为 `task.start` / `task.complete` / `task.reopen` |
| 6 | 缺少任务要求里的「下一步做什么」入口与无里程碑双入口 | 新增 `nextSteps` 推导与空状态区块（见 §4） |
| 7 | 云端模式下整页替换掉工作台，「项目推进｜项目资料」布局丢失 | 补回双标签页；项目资料页如实说明云端材料未接入 |

## 4. 「下一步做什么」的边界

该入口**不调用模型**：按当前阶段数据推导 4 条以内的行动（开始阶段、补完成标准、拆任务、开始任务、补证据、记录进展、收尾阶段），按钮直接调用对应 store action。

页面明确写着“这里的顺序由当前阶段的任务、证据和进展推导，不是 AI 建议”，因为：

- **服务端没有 v3 实现**：`server/src/advisor/types.ts:17-21` 只认 `mvp-prompt-v1/v2` 与 `advisor-chat-v1/v2`，`milestoneContext` 在 `server/src` 零命中，带 `mvp-prompt-v3` 的请求会被 `400 INVALID_INPUT`；
- 数据层也没有把 `milestoneContext` 传给建议接口（`buildMilestoneContext()` 与 `cloud.buildAdvisorContext()` 都没有调用方）；
- 建议上下文里的 `confirmedMaterials` 需要云端材料/片段/理解条目回读，数据层未接；服务端 23.3 的复核门禁也未实现；
- 契约 23.7 的阶段候选接口在后端仍无路由。

在这三项就绪前，用本地规则结果冒充 AI 结果会违反“不使用假 AI 结果”的要求，因此只做规则推导并标注来源。

## 5. 无法完成的部分（依赖他人或接口缺失）

| 能力 | 阻塞原因 | 依据 | 页面当前表现 |
| --- | --- | --- | --- |
| AI 阶段候选 | 后端 `server/src/v3/router.ts` 无 `milestones/candidates` 路由，表已建接口未实现 | `docs/v3-v4-interface-status.md` §3 ⬜ | 按钮可点，提示“阶段候选接口暂未接入，不会用本地数据代替” |
| 项目时间线 | 契约 22.11 端点未实现，`cloud.loadTimeline()` 恒返回 `TIMELINE_NOT_AVAILABLE` | 同上 §8 ⬜ | 用「最近进展」列表代替，不显示假时间线 |
| 云端材料列表 / 项目资料 | 后端材料读取（列表/片段/理解草稿）已实现，但前端数据层没有云端材料状态（`projectsApi` 无 materials 读取，`cloud` store 无 materials） | `docs/v3-frontend-delivery.md` §3 第 5 项 | 「项目资料」页说明未接入，并指引用本地模式继续上传 MD/TXT |
| 云端阶段化 AI 建议 | **服务端也没有 v3 实现**：`server/src/advisor/types.ts` 只认 `mvp-prompt-v1/v2`、`advisor-chat-v1/v2`，`milestoneContext` 在 `server/src` 零命中，v3 请求会被 400；数据层也还没把 `milestoneContext` 传给建议接口 | `docs/v3-v4-gap-audit.md` A2/B4、`docs/ai/prompt-spec.md` §9.3 D13 | 「下一步做什么」只给规则推导并标注不是 AI |
| 证据 / 进展单条读取 | 后端无 `GET /evidence/{id}`、`GET /progress/{id}` | `docs/v3-v4-interface-status.md` §5 ⬜ | 详情只能从列表展示，不做单条详情页 |
| 本地项目迁移的真实浏览器验收 | — | 已补：见 §6.4 |

> 项目资料页是唯一“有标签但内容受限”的地方。选择保留标签并如实说明，而不是删掉标签或把本地材料伪装成云端材料。

## 6. 验证

### 6.1 命令（工作区 `C:/Users/30575/Documents/GitHub/Smart-Course-Platform`）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元/组件测试 | `node_modules/.bin/vitest run` | 见 §6.2 |
| 类型检查 | `node_modules/.bin/vue-tsc --noEmit` | 0 错误 |
| 生产构建 | `node_modules/.bin/vite build` | 通过 |
| 代码规范 | `node_modules/.bin/eslint .` | 通过（未用 `--fix`） |

> 本机没有注册 `npm` 命令，因此直接调用 `node_modules/.bin` 下的等价工具。首次运行时 `vue-tsc` 报 `Cannot find type definition file for 'node'`——原因是 `npm` 把 `@types/node` 放进了 `node_modules/.ignored/`，属于本地依赖不完整，不是代码错误；把该目录复制回 `node_modules/@types/node` 后为 0 错误。

### 6.2 测试规模

- 全量：**40 个测试文件、888 条用例通过**（本轮改动前基线 883 条，新增 5 条云端工作台用例）。
- 本轮新增/修改用例（`tests/ui/CloudProjectWorkbench.test.ts`）：标签页切换不丢输入、无里程碑双入口与聚焦、下一步入口与“不是 AI 建议”标注、任务按钮忙碌态键名、新建任务默认挂阶段 + 未挂任务补挂。

### 6.3 真实浏览器验收（本地后端 + Vite dev server）

环境：`server` 用 SQLite 临时库（`SCP_DB_PATH` 指向系统临时目录）、`SCP_COOKIE_SECURE=0`、`INVITE_CODE=scp-local-invite`、`ADVISOR_PROVIDER=mock`，监听 `127.0.0.1:8080`；前端 `vite --port 5173`；Chrome headless（puppeteer-core）驱动，非 mock 前端、非假登录。

覆盖并通过的路径（日志：`docs/acceptance/v3-ui/acceptance-log.txt`）：

1. 未登录 → 显示登录/注册入口；
2. 注册（用户名/昵称/密码/确认密码/邀请码）→ 自动登录，右上角显示昵称与退出；
3. 空白项目 → 显示「还没有里程碑」与「新建里程碑 / 根据项目资料生成候选」两个入口；
4. 新建阶段（名称、目标、完成标准、截止时间）→ 列表出现且自动切到该阶段；
5. 新建任务 → 默认挂在当前阶段并立刻出现在阶段任务里；开始任务 → 状态变「进行中」；
6. 保存进展 → 最近进展出现记录；
7. 保存证据 → 关联证据出现记录；
8. 「下一步做什么」渲染，并标注不是 AI 建议；
9. 切「项目资料」→ 如实显示未接入，切回不丢输入；
10. 项目地图展示阶段与任务统计；
11. **刷新页面** → 项目、阶段、任务仍在；
12. 390px（`scrollWidth=390`，无越界元素）；方向键切换标签后 `aria-selected=true`；
13. 退出登录 → 登录页；错误密码 → 中文提示「用户名或密码不正确」；正确密码重新登录 → 项目恢复。

截图：

| 文件 | 内容 |
| --- | --- |
| `01-login-desktop.png` / `02-register-desktop.png` | 登录、注册（桌面） |
| `03-empty-milestone-desktop.png` | 空项目里程碑入口 |
| `04-workbench-progress-desktop.png` | 阶段推进（桌面全流程结果） |
| `05-workbench-data-desktop.png` | 项目资料（未接入说明） |
| `06-map-desktop.png` | 云端项目地图 |
| `07-workbench-390.png` / `08-workbench-data-390.png` | 390px 两个标签页 |
| `09-tab-keyboard-390.png` | 方向键切换标签 |
| `10-logout-login-390.png` / `11-login-failed-390.png` / `12-relogin-390.png` | 退出、登录失败、重新登录 |

控制台：只有两次预期的 401（启动时探测 `/api/auth/me`、故意输错密码），没有其他前端异常。

### 6.4 本地项目迁移端到端（补测，2026-10-22）

同一套环境，用全新浏览器 profile 走完迁移（日志 `docs/acceptance/v3-ui/migration-log.txt`）：

1. 未登录 → 选课程题目 → 「创建空白项目」，localStorage `scp.mvp.projects` **628 字节**；
2. 注册新账号 → 触发表层迁移面板，候选显示项目名与“0 个任务 · 0 条证据”；
3. 点「确认迁移」→ 面板变「已迁移」；
4. 迁移后 localStorage 仍为 **628 字节**（成功不删本地，符合契约）；
5. 刷新页面 → 云端项目列表只有 **1 个**项目（未产生重复）。

截图：`13-migration-prompt-desktop.png`、`14-migration-done-desktop.png`、`15-migration-reload-desktop.png`。

## 7. 文件清单

本轮新增：

```
src/components/AuthPanel.vue
src/components/LocalMigrationPanel.vue
src/components/CloudProjectWorkbench.vue
src/components/CloudProjectMapView.vue
tests/ui/AuthPanel.test.ts
tests/ui/LocalMigrationPanel.test.ts
tests/ui/CloudProjectWorkbench.test.ts
docs/v3-v4-yonglei-ui-delivery.md
docs/acceptance/v3-ui/*.png
docs/acceptance/v3-ui/acceptance-log.txt
```

本轮修改：

```
src/App.vue                 登录态外壳、迁移入口、刷新后恢复项目
src/views/WorkbenchView.vue 云端来源切换（只加分支，不改本地流程）
src/views/ProjectMapView.vue 云端来源切换
src/services/authApi.ts     注册接口（数据层最小缺口，见下）
src/stores/session.ts       注册 action
src/stores/platform.ts      register / useCloudSource / 迁移状态导出
```

> `authApi.ts` / `session.ts` / `platform.ts` 属李焰彬的数据层范围，本轮只加了注册（`POST /api/auth/register`）与两个只读导出，没有改动既有接口语义；合入时请在 PR 说明里点出这三处，便于数据层负责人复核。

## 8. 未做与后续

- 未提交、未推送、未部署：改动仍在工作区（`git status` 可见），按计划等 M2 联调确认后再合并。
- 项目资料在云端模式下需要数据层补 `materials` 读取与理解条目回读；补齐后本页只需替换占位卡片，不需要改布局。
- 阶段候选接口就绪后，`requestMilestoneCandidates()` 换成真实调用，候选必须经用户勾选确认后才 `createMilestone({ source: 'ai-candidate', confirmedByUser: true })`。
