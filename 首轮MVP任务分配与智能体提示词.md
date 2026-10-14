# 首轮 MVP 任务分配与智能体交接文档

> 版本：v2.0  
> 日期：2026-09-23  
> 适用范围：第一轮 MVP，目标是跑通“创建项目 → 保存 → 提交证据 → 调用大模型 → 显示下一步建议”。  
> 后端全部由负责人完成。其他三位成员不修改 `server/**`。  
> 本文是发给新智能体的交接文档。每位成员可以自行编写自己的智能体提示词，但必须先阅读本文件并遵守文件边界和接口契约。

> 进度说明（2026-09-28）：本文的分工与验收标准继续有效；第 2 节的首次建分支流程是启动阶段的历史步骤。后端建议接口、CORS、前端结构化状态与持久化已合入 `main`；前端 Vitest 环境已在 `4271d0c` 合入，李焰彬的业务测试也已合入。本地前端测试 187 条通过；浏览器集成验收仍发现过期建议使页面卡在 `loading`、相同 draft 重复认领创建两个任务，以及新任务候选按钮尚未接线。修复要求以 [接口契约](docs/contracts.md) v1.3 为准，测试通过不等于这些路径已验收。

## 1. 本轮最终要实现什么

本轮只做一条可演示闭环：

```text
创建项目
  → 刷新页面后项目仍然存在
  → 认领任务
  → 记录进展或确认完成
  → 保存证据和疑问
  → 请求后端 AI 建议
  → 显示 1～3 条下一步建议
  → 模型失败时显示规则 fallback
```

完成本轮后，用户可以：

1. 创建至少两个项目并切换；
2. 刷新浏览器后恢复项目；
3. 认领任务，但不会虚增完成进度；
4. 区分“记录进展”和“确认完成”；
5. 提交结构化证据；
6. 看到时间线和未解决疑问；
7. 请求后端大模型生成下一步建议；
8. 看到建议的原因、完成标准和依据；
9. 在没有 API Key、超时、限流或模型返回错误时继续使用规则建议。

本轮暂不做：

- 完整账号系统；
- 多人实时同步；
- PDF/DOCX 自动解析；
- 向量数据库；
- 流式聊天；
- 移动端重构；
- 全部题目内容重写；
- 自动生成和写入论文 DOI；
- 复杂的计划排期页面。

## 2. 第一次开发前：所有人如何获取代码

### 2.1 负责人先做基线

启动阶段的基线确认与合并已完成。后续开始新任务时先确认独立工作区没有会被覆盖的未提交改动，再从最新 `origin/main` 建新分支；不要为了清理工作区执行 `reset` 或 `clean`。

### 2.2 三位成员第一次开始工作

基线 PR 合并后，三位成员都必须从最新 `main` 开始：

```bash
git status --short --branch
git fetch origin
git switch main
git pull --ff-only origin main
```

已经合并的分支不要复用。新任务从最新 `main` 创建一个新分支，例如李焰彬接下来的业务测试：

```bash
git switch -c feature/mvp-liyanbin-tests
```

如果已有**尚未合并**的本人任务分支：

1. 不改名；
2. 不重复创建；
3. 先检查是否有未提交改动；
4. 获取最新远端；
5. 在自己的分支合并最新 `origin/main`：

```bash
git status --short --branch
git fetch origin
git switch <已有的本人分支>
git merge origin/main
```

如果合并出现冲突，只处理自己负责的文件；发现共享接口冲突时停止修改，报告负责人。不能使用 `reset --hard`、`git clean`、`--ours` 或 `--theirs` 一键覆盖。

每个人必须使用独立 clone 或独立 worktree。不能让三个智能体在同一个目录中轮流切换分支。

## 3. 文件所有权

同一个文件同一时间只能有一个修改者。表中“负责人”指本轮唯一允许直接修改该文件的人。

| 文件或目录 | 负责人 | 文件作用 |
| --- | --- | --- |
| `server/**` | 负责人 | 后端服务、API 路由、AI provider、数据库、认证、权限、服务端测试 |
| `deploy/**`、`.env.example` | 负责人 | 服务器部署、反向代理、环境变量示例 |
| `docs/contracts.md` | 负责人 | 前后端唯一接口契约，冻结请求、响应、错误码和版本 |
| `src/App.vue`、`src/router/index.ts`、`src/main.ts` | 负责人 | 应用入口、全局导航、路由和启动配置 |
| 根目录 `package.json`、锁文件、Vite/TypeScript/ESLint 配置 | 负责人 | 工程脚本、依赖和质量检查 |
| `src/views/WorkbenchView.vue` | 雍蕾 | 工作台页面布局和交互接入 |
| `src/components/**` | 雍蕾 | 表单、建议卡片、AI 状态、项目相关界面组件 |
| `tests/ui/**` | 雍蕾 | 页面行为测试 |
| `src/types/platform.ts` | 李焰彬 | 前端领域类型和接口 DTO 类型 |
| `src/stores/**` | 李焰彬 | Pinia 状态、action、项目切换和持久化 |
| `src/domain/progress.ts` | 李焰彬 | 进度和任务状态纯函数 |
| `src/domain/recommendation.ts` | 李焰彬 | 本地规则建议纯函数 |
| `src/domain/activity.ts` | 李焰彬 | 活跃度和时间计算 |
| `src/services/http.ts`、`src/services/advisorApi.ts` | 李焰彬 | 浏览器调用后端的 API 适配层；不能放模型 SDK 和密钥 |
| `tests/domain/**`、`tests/stores/**`、`tests/services/**` | 李焰彬 | 状态、持久化和前端接口测试 |
| `src/data/topics.ts` | 吴佳璐 | 9 套题目模板的内容资产 |
| `src/data/mvpFallbacks.ts` | 吴佳璐 | 无模型时使用的少量通用建议 |
| `docs/ai/prompt-spec.md` | 吴佳璐 | 运行时提示词的需求规格和版本说明 |
| `docs/ai/evaluation.md` | 吴佳璐 | AI 评估场景、反例和人工验收标准 |
| `tests/fixtures/ai/**`、`tests/content/**` | 吴佳璐 | 脱敏输入、期望字段和内容完整性测试 |
| `scripts/validate-topics.mjs` | 吴佳璐 | 题目模板和论文数据校验 |

本轮 `src/services/papers.ts` 保持现状，不作为新功能重构范围。后续如果需要修改，先由负责人重新分配 owner。

## 4. 统一接口契约

正式契约由负责人写入 `docs/contracts.md`。三位成员不得自行创建第二套字段。

### 4.1 任务和证据的核心概念

- `Task`：项目中实际存在的任务；
- `Recommendation`：当前推荐的任务视图，可以来自已有 Task，也可以是候选草稿；
- `Evidence`：学生提交的结构化证据；
- `Doubt`：证据产生的未解决疑问；
- `ProjectRevision`：项目状态版本，防止旧请求覆盖新状态。

认领任务、记录进展、确认完成必须是三个不同动作：

- 认领：任务从 `todo` 变为 `doing`，不增加完成比例；
- 记录进展：保存证据和疑问，不自动完成任务；
- 确认完成：学生明确确认，且必填证据通过校验，任务才变为 `done`。

### 4.2 前端 store action

李焰彬提供以下稳定 action，雍蕾只调用这些 action：

```ts
createProject(input)
selectProject(projectId)
claimTask({ taskId }) / claimTask({ draft })
submitEvidence(input)
resolveDoubt(doubtId)
refreshRecommendations()
```

action 返回明确结果，不允许页面通过 toast 文案判断成功：

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }
```

### 4.3 后端建议接口

负责人实现：

```http
POST /api/advisor/recommendations
```

请求至少包含：

```ts
{
  requestId: string
  projectId: string
  projectRevision: number
  projectName: string
  currentMilestone: string
  confirmedContext: string[]
  tasks: TaskSnapshot[]
  evidence: EvidenceSnapshot[]
  doubts: DoubtSnapshot[]
  promptVersion: string
}
```

成功响应：

```ts
{
  requestId: string
  projectId: string
  projectRevision: number
  source: 'model' | 'fallback'
  suggestions: Array<{
    title: string
    whyNow: string
    doneCriteria: string
    existingTaskId?: string
    basisEvidenceIds: string[]
    basisDoubtIds: string[]
  }>
  promptVersion: string
}
```

失败响应：

```ts
{
  requestId: string
  code: 'INVALID_INPUT' | 'MODEL_TIMEOUT' | 'RATE_LIMITED' |
    'INVALID_MODEL_OUTPUT' | 'MODEL_UNAVAILABLE'
  message: string
  retryable: boolean
}
```

约束：

1. 最多返回 3 条建议；
2. 已完成任务不能再次推荐；
3. 引用 ID 必须属于本次请求；
4. 模型不能直接调用“完成任务”；
5. projectRevision 不匹配时，前端丢弃旧响应；
6. 证据保存成功后，即使模型失败也不能回滚证据；
7. `src/services/advisorApi.ts` 负责 HTTP，页面不能直接 fetch；
8. 后续增加材料理解、聊天和计划生成时，沿用 `requestId`、`projectRevision`、`promptVersion` 和统一错误结构。

## 5. 负责人本轮必须完成的功能

负责人独占后端和工程集成，具体完成：

1. 建立 `server/` 服务；
2. 配置 `OPENAI_API_KEY`，只从服务端环境读取；
3. 实现 `POST /api/advisor/recommendations`；
4. 实现 provider、提示词加载、结构化输出校验和 fallback；
5. 增加超时、429、5xx、非法 JSON 和无 key 错误处理；
6. 校验项目 revision 和引用 ID；
7. 写 `docs/contracts.md`；
8. 写服务器启动、环境变量和健康检查说明；
9. 使用 `course.xinxian-music.xyz` 作为前端域名、`api.xinxian-music.xyz` 作为 API 域名；
10. 配置 HTTPS、反向代理、CORS 和 API 访问限制；
11. 增加后端 mock provider 和接口测试；
12. 集成三位成员的 PR，处理接口冲突。

本轮后端不必一次完成账号、数据库和实时协作，但 API 必须预留 projectId、projectRevision、requestId 和 promptVersion。

## 6. 雍蕾本轮必须完成的功能

允许修改：

- `src/views/WorkbenchView.vue`
- `src/components/ProjectCreate.vue`
- `src/components/ProjectMindMap.vue`
- 新增 `src/components/AiStatus.vue`
- 新增 `src/components/RecommendationList.vue`
- 新增 `src/components/EvidenceForm.vue`
- `tests/ui/**`

功能：

1. 展示当前任务建议；
2. 展示 AI loading、model success、fallback 和 error；
3. 展示建议标题、whyNow、doneCriteria 和依据；
4. 将“记录进展”和“确认完成”做成明确不同的交互；
5. 提交失败时保留表单；
6. 证据保存成功但 AI 失败时提示“证据已保存，建议暂时使用规则结果”；
7. 切换项目时清理旧项目的 taskId 和表单；
8. 页面只调用 store action，不直接修改项目深层对象；
9. 使用 scoped style，不修改全局 CSS；
10. 保持当前设计稿风格，不引入新的 UI 框架。

组件职责：

- `AiStatus.vue`：展示 loading、来源、失败和重试状态；
- `RecommendationList.vue`：展示最多 3 条建议和依据；
- `EvidenceForm.vue`：收集证据字段，发出 submit 事件；
- `WorkbenchView.vue`：组合组件并调用 store，不实现业务规则；
- `ProjectCreate.vue`：保持创建流程，与新状态模型兼容；
- `ProjectMindMap.vue`：保持现有地图功能，本轮只修必要兼容问题。

不修改 store、类型、服务、后端、全局样式和根依赖。

## 7. 李焰彬本轮必须完成的功能

允许修改：

- `src/types/platform.ts`
- `src/stores/**`
- `src/domain/progress.ts`
- `src/domain/recommendation.ts`
- `src/domain/activity.ts`
- `src/services/http.ts`
- `src/services/advisorApi.ts`
- `tests/domain/**`
- `tests/stores/**`
- `tests/services/**`

功能：

1. 为项目、任务、证据和疑问建立稳定 ID；
2. 增加 schemaVersion 和 localStorage 迁移；
3. 处理损坏数据和存储容量错误；
4. 实现项目保存、恢复和项目隔离；
5. 实现认领、记录进展、确认完成三个 action；
6. 使用 submissionId 保证重复提交幂等；
7. 进度由已完成任务推导，认领不增加完成比例；
8. 生成规则版 Recommendation；
9. 过滤已完成任务，保留依据 ID；
10. 实现前端 HTTP 和 advisor API 适配；
11. 保存证据后再调用 AI；
12. 处理 loading、fallback、超时、旧响应和项目切换；
13. 不直接在页面里写状态逻辑；
14. 不在浏览器端写模型 SDK 或 API Key。

兼容要求：

- 当前旧页面仍能 typecheck/build；
- 现有 `t/why/done` 模板字段先保留兼容；
- 新模型字段逐步映射，不一次删除旧字段；
- 任务 ID 设计要支持以后新增计划页、材料理解和多人协作。

## 8. 吴佳璐本轮必须完成的功能

允许修改：

- `src/data/topics.ts`
- 新增 `src/data/mvpFallbacks.ts`
- 新增 `docs/ai/prompt-spec.md`
- 新增 `docs/ai/evaluation.md`
- `tests/fixtures/ai/**`
- `tests/content/**`
- 新增或修改 `scripts/validate-topics.mjs`

功能：

1. 检查 9 套题目的阶段、步骤、why、done 和论文方向；
2. 为第一轮建议提供 prompt 需求规格；
3. 明确提示词必须要求模型给方向，不直接代做；
4. 规定建议必须带完成标准和真实依据；
5. 提供无模型时的少量通用 fallback 内容；
6. 提供启动、记录进展、确认完成、新疑问、无材料、自定义题目等脱敏样例；
7. 提供非法 JSON、缺字段、引用不存在、推荐已完成任务、直接代做请求和 prompt injection 反例；
8. 检查可靠论文链接，不制造 DOI；
9. 维护 promptVersion；
10. 不修改 server、store、类型、页面和根工程配置。

`docs/ai/prompt-spec.md` 是给负责人实现运行时 prompt 的规格，不是第二套运行时代码。不要新建和 server 中重复的 `prompts.ts`。

## 9. 统一交接前置提示词

以下内容是三位成员新对话的共同起点。它不是具体实现提示词；成员可以在阅读后自行编写更适合自己的工作提示词。

~~~text
你正在参与“智慧课程平台”第一轮 MVP 开发。请先阅读：
1. 首轮 MVP 任务分配与智能体交接文档.md；
2. 正式开发计划与四人分工.md；
3. README.md；
4. DESIGN.md；
5. 当前分支中的 docs/contracts.md（如果已存在）；
6. 仓库中的 AGENTS.md（如果存在）。

你的目标不是重写项目，而是在现有 Vue 3 + TypeScript 原型上完成自己被分配的一个小功能。第一轮只围绕：
创建项目 → 保存 → 提交证据 → 后端 AI 建议 → 页面展示。
不要提前做计划页、账号、PDF/DOCX 解析、实时协作或移动端。

开始工作前必须：
- 运行 git status --short --branch；
- 确认自己当前分支；
- 如果没有自己的分支，从最新 main 创建；
- 如果已有自己的分支，不改名、不重复创建，先合并最新 origin/main；
- 确认自己的文件白名单；
- 阅读接口契约，不自行设计第二套 DTO。

Git 规则：
- 只在自己的 clone/worktree 中工作；
- 不切换其他成员分支；
- 不执行 reset --hard、git clean、覆盖式 checkout；
- 不使用 git add .；
- 只提交自己白名单内的文件；
- 遇到接口冲突先记录并报告负责人；
- 不修改其他成员负责的文件来“顺手修复”。

代码规则：
- 不使用 any 或无理由的类型断言绕过契约；
- 不直接复制旧版目录实现新功能；
- 不把业务状态散落在页面组件；
- 不重复实现 HTTP、持久化或 Recommendation 类型；
- 新增代码要考虑后续增加材料理解、计划页、账号和多人协作；
- 真实 API Key、课程私密资料、数据库文件和 .env 不得进入提交。

检查规则：
- 运行 npm run typecheck；
- 运行 npm run build；
- 有统一测试脚本时运行自己模块的测试；
- 当前 npm run lint 可能会自动修改文件，运行前先确认负责人是否已拆分 lint 和 lint:fix；
- 不要声称没有运行的检查已经通过。

完成后报告：
- 实际修改的文件；
- 每个文件的作用；
- 对外依赖的接口；
- 运行的检查和结果；
- 未完成内容；
- 推荐的 PR 标题和简短说明。
~~~

## 10. 合并顺序

1. 负责人确认当前基线并合并基线 PR；
2. 负责人发布 `docs/contracts.md`；
3. 李焰彬提交类型、持久化和 action 的兼容 PR；
4. 吴佳璐提交题目校验、fallback 和 AI 评估样例；
5. 负责人实现后端 AI API；
6. 李焰彬接入前端 API adapter；
7. 雍蕾接入 store action 和页面展示；
8. 负责人做域名、服务器和完整集成验收。

独立组件可以提前开发，但不能在没有契约时自行发明数据结构。每个 PR 合并前必须说明“修改文件”和“未修改的共享文件”。

## 11. 本轮验收

必须完整通过：

- 两个项目创建与切换；
- 刷新后数据恢复；
- 认领任务不增加完成比例；
- 记录进展不自动完成；
- 确认完成后状态正确更新；
- 相同 submissionId 不重复写入；
- 真实 API 至少成功调用一次；
- API 失败时证据不丢且显示 fallback；
- 已完成任务不再推荐；
- 旧 projectRevision 响应不会覆盖新状态；
- 前端和 Git 历史中没有 API Key；
- course.xinxian-music.xyz 可访问前端；
- api.xinxian-music.xyz 的健康检查和建议接口可访问；
- npm run typecheck 和 npm run build 通过。

## 12. 当前状态

本文件只定义首轮任务和接口，不创建分支、不提交代码、不推送 PR、不部署服务。

已合并的任务分支不要复用；新任务从最新 `main` 建新分支。后续进入计划页、项目理解、账号或附件阶段时，重新分配任务，不沿用本轮边界。
