# 本地 V3 后端集成测试（opt-in）

> 对应测试：`tests/integration/v3LocalBackend.integration.test.ts`
> 运行命令：`npm run test:integration:v3-local`
> 目标：在**本机 loopback** 上验证前端 V3 数据层与真实后端的往返，包括版本冲突、
> 跨项目越权、幂等回放、归档 / 软删除等流程。

这份测试**不属于**普通 `npm test`。普通单测全部离线，不会发起任何网络请求。

## 1. 它验证什么

| 范围 | 内容 |
| --- | --- |
| 账号与会话 | 未登录态、注册、`/api/auth/me`、登录、退出 |
| 项目 | 创建、读取归属与初始版本、资料更新、过期版本被拒绝（`STALE_REVISION`） |
| 阶段 | 创建、编辑、排序、激活、完成、重开、归档、恢复 |
| 任务 | 创建、编辑、启动、完成、重开、移动阶段、归档、恢复 |
| 证据 / 进展 | 证据创建与解除关联、空关联与关联进展、阶段与任务不一致被拒绝 |
| 归属校验 | 跨项目改任务、跨项目用阶段建任务被拒绝；过期阶段版本被拒绝 |
| 幂等 | 同内容在新版本下换幂等键；同一 `idempotencyKey` 重试回放同一条进展 |
| 项目生命周期 | 归档、恢复、软删除、恢复删除；归档 / 删除后禁写 |
| 已知缺口 | 未冻结端点仍返回 404；客户端对未提供的时间线给出 `TIMELINE_NOT_AVAILABLE` |

未覆盖：`POST /api/projects/:id/progress/:pid/supersede`——路由存在，但契约中的字段表
尚未冻结，因此不写入测试，避免固化未定行为。

## 2. 前置条件

1. **一份实现了 V3/V4 契约的后端**（`docs/contracts.md` 第 20~22 节：`/api/auth/*`、
   `/api/projects*`）。注意：当前仓库 `server/` 只实现 V2 接口，V3 路由需由后端分支
   或本地构建提供；启动方式以后端所在目录的说明为准。
2. 后端监听在**本机**，例如 `http://127.0.0.1:8099`。集成测试只允许 loopback 地址
   （`localhost`、`127.0.0.0/8`、`::1`），其他地址会在**发请求之前**失败。
3. Node.js 20.19+ 或 22.12+（与 Vite 8 一致）。
4. 后端需要配置：
   - 独立数据库文件（`SCP_DB_PATH`），**不要指向任何共享或生产库**；
   - 一个可用于本地注册的邀请码（`INVITE_CODE` 明文，或 `INVITE_CODE_SHA256` 哈希）；
   - 本地 http 会话需要 `SCP_COOKIE_SECURE=0`（默认 `1`，会让浏览器/客户端拒绝非
     HTTPS 下的 Cookie）；
   - CORS 白名单包含 `http://localhost:5173`（后端默认白名单已包含该来源）。

## 3. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `V3_LOCAL_API_BASE_URL` | 是 | 本地后端地址，不含 `/api`。例如 `http://127.0.0.1:8099` |
| `V3_LOCAL_INVITE_CODE` | 是 | 本地后端的注册邀请码明文（测试会用它注册一次性账号） |
| `V3_LOCAL_TEST_PASSWORD` | 否 | 测试账号密码；不设置时每次运行随机生成，且不会打印 |

补充约定：

- **不需要、也不会设置 `VITE_API_BASE_URL`**。客户端解析出的基地址（默认
  `127.0.0.1:8080`）会被测试装置统一改写到 `V3_LOCAL_API_BASE_URL`；任何非 loopback
  的请求都会被拒绝，所以即使本机环境里配了别的地址也不会误连。
- 邀请码与密码只从环境变量读取：不写入测试文件、文档、日志或错误信息。
- 运行结束时只打印测试账号与项目 ID（可识别的测试标记），不打印凭据。

## 4. 运行

PowerShell：

```powershell
$env:V3_LOCAL_API_BASE_URL='http://127.0.0.1:8099'
$env:V3_LOCAL_INVITE_CODE='<本地后端邀请码>'
npm run test:integration:v3-local
```

Bash / macOS / Linux：

```bash
export V3_LOCAL_API_BASE_URL='http://127.0.0.1:8099'
export V3_LOCAL_INVITE_CODE='<本地后端邀请码>'
npm run test:integration:v3-local
```

行为差异（避免“跳过 = 通过”的误判）：

| 场景 | 行为 |
| --- | --- |
| `npm test` | 不包含 `tests/integration/**`，不连接任何后端 |
| 直接 `vitest run --config vitest.integration.config.ts` 且未设置地址 | 用例标记为 skipped，并打印原因 |
| `npm run test:integration:v3-local` 且缺少任一必填变量 | 打印缺失变量名与示例，**以非 0 退出** |
| 地址不是 loopback / 协议不是 http(s) / 带 `/api` 后缀 | 在发出任何请求前失败，并说明原因 |

## 5. 测试会写入哪些数据

每次运行都会**新建**一个测试账号（`it_v3local_<时间戳>`），并在该账号下创建：

- 项目 A：`[v3local] 项目 A`（含 2 个阶段、1 个任务、1 条证据、若干条进展）；
  流程结束时它会经历「归档 → 恢复 → 软删除 → 恢复删除」，**最终状态为 active**；
- 项目 B：`[v3local] 项目 B`，只用于跨项目越权校验，保持 active；
- 会话 Cookie 只在内存中维护，退出登录后失效。

所有项目名带 `[v3local]` 标记，账号带 `it_v3local_` 前缀，便于在本地库里识别。

## 6. 测试数据如何处理

**测试不会自动清理、也不会重置后端数据。** 原因：当前 V3 后端没有删除账号的接口，
项目只有「软删除 + 30 天后可恢复删除」，没有硬删除；自动写入清理逻辑会引入新的
未冻结接口依赖。

推荐做法（按优先级）：

1. **用一次性数据库文件**：启动本地后端时把 `SCP_DB_PATH` 指向专门的测试库，
   跑完停掉后端，再删除该文件（以及同目录的 `-wal` / `-shm` 文件）。
2. 若共用同一个本地库：残留数据都在 `[v3local]` / `it_v3local_` 标记下，可按标记
   人工清理；不要在生产库上运行这套测试。
3. 不要在测试里加“清库 / 重置”步骤：一旦 `V3_LOCAL_API_BASE_URL` 被误指到有价值
   的环境，破坏性清理的代价远高于留下测试数据。

## 7. 安全边界

- 只允许 loopback；`fetch` 闸门在调用真实网络前校验协议与主机，并强制
  `redirect: 'error'`，后端若重定向到外部地址会直接失败而不是跟随。
- 所有请求都会记录 URL（供断言“确实只访问了 loopback”），但不记录请求体、Cookie、
  邀请码或密码。
- 测试不使用 `VITE_API_BASE_URL`，也不读取其他业务环境变量。

## 8. 常见问题

| 现象 | 处理 |
| --- | --- |
| 报「缺少环境变量 V3_LOCAL_API_BASE_URL」 | 按第 4 节设置后重跑；这是入口脚本的预检，不是测试失败 |
| skipped，并提示未设置地址/邀请码 | 说明直接用了 vitest 且缺少配置；改用 `npm run test:integration:v3-local` |
| 报「只允许 loopback 地址」 | 把地址改成本机地址；集成测试不支持远程后端 |
| 注册返回 `REGISTER_REJECTED` | 邀请码与后端配置不一致，或该账号已存在（换一次运行即可，账号带时间戳） |
| 注册后请求一直 401 | 本地 http 下 `SCP_COOKIE_SECURE` 未设为 `0` |
| 报 404 而不是断言失败 | 确认后端已包含 V3 路由；仓库 `server/` 目前只有 V2 接口 |
