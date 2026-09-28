# 后端服务：配置、启动、健康检查与建议接口（首轮 MVP）

> 编制日期：2026-09-25（2026-09-28 同步 CORS 与测试现状）
> 对应契约：`docs/contracts.md`（第 4 节建议接口、第 6 节错误码、第 7 节域名与端口）
> 当前已实现：`GET /health`、`POST /api/advisor/recommendations`。
> **运行时默认使用真实模型 provider（OpenAI 兼容）**；mock provider 只在 `ADVISOR_PROVIDER=mock`（本地联调）或测试注入时使用。

---

## 1. 前置条件

| 项 | 要求 | 本机实测 |
| --- | --- | --- |
| Node.js | ≥ 20.19（与前端 Vite 要求一致） | v22.14.0 |
| npm | ≥ 10 | 10.9.2 |
| 网络 | 首次 `npm install` 需要能访问 npm registry；调用真实模型需要能访问模型网关 | — |

后端是**独立**的 npm 包：`server/` 有自己的 `package.json`、`node_modules` 和 `tsconfig.json`，与仓库根目录的前端依赖互不影响。根目录现已配置前端 Vitest；它不参与后端的 `npm test`。

**不使用任何模型 SDK**：调用真实模型用的是 Node 22 原生 `fetch` + `AbortController`。

## 2. 安装

```powershell
cd D:\智慧课程平台\server
npm install
```

后端**没有任何运行时依赖**（只用 Node 内置模块）。`devDependencies` 只有三个：`typescript`、`@types/node`、`tsx`（仅 `npm run dev` 用）。

## 3. 编译与启动

```powershell
cd D:\智慧课程平台\server

npm run dev        # 开发：tsx watch，改动源码自动重启
# 或
npm run build
npm start
```

启动成功会打印（端口取自配置，**不含任何密钥**）：

```text
[course-platform-api] listening on http://127.0.0.1:8080
[course-platform-api] health: http://127.0.0.1:8080/health
[course-platform-api] advisor provider: openai-compatible (model=gpt-4o-mini, host=your-gateway.example.com, timeout=20000ms)
[course-platform-api] advisor route: POST http://127.0.0.1:8080/api/advisor/recommendations
```

配置不完整时，第三行会变成：

```text
[course-platform-api] advisor provider: openai-compatible（未配置：MODEL_API_URL / MODEL_API_KEY / MODEL_NAME）
[course-platform-api] 模型配置不完整，建议接口将改用规则兜底（fallbackReason=MODEL_NOT_CONFIGURED）。缺失：MODEL_API_URL / MODEL_API_KEY / MODEL_NAME
```

日志里只出现**环境变量名**和模型名/主机名，不会出现密钥，也不会打印完整 URL。

### 端口与监听地址

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | **必须与 Cloudflare API 隧道指向的端口一致**（现有隧道指向本机 8080） |
| `HOST` | `127.0.0.1` | 只监听本机，由 Nginx / 隧道对外；不要在本机开发时改成 `0.0.0.0` |

`PORT` 非法（非整数、0、超过 65535）时**启动直接报错**，不回退到默认值——宁可启动失败，也不要让服务悄悄跑在别的端口上。

## 4. 环境变量与真实模型配置

### 4.1 变量清单

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ADVISOR_PROVIDER` | 否 | `openai-compatible` | `openai-compatible` = 真实模型；`mock` = 本地联调用，**不要用于部署** |
| `MODEL_API_URL` | **是** | 无 | 模型服务地址，**必须是完整请求地址**。服务端不拼接任何路径、不补 `/v1` 后缀，填什么就请求什么 |
| `MODEL_API_KEY` | **是** | 无 | 模型密钥。只在服务端读取，绝不进响应、日志或前端产物 |
| `MODEL_NAME` | **是** | 无 | 网关要求的 `model` 值 |
| `MODEL_TIMEOUT_MS` | 否 | `20000` | provider 单次调用超时（毫秒），范围 100～120000 |
| `MOCK_PROVIDER_MODE` | 否 | `ok` | **仅 `ADVISOR_PROVIDER=mock` 时生效**：`ok` / `empty` / `invalid` / `throw` / `not-configured` / `slow` |

`MODEL_API_URL` / `MODEL_API_KEY` / `MODEL_NAME` 三者**任一为空**就算"未配置"：接口不会去请求一个假地址，而是按契约返回 `MODEL_NOT_CONFIGURED`（见 4.4）。

### 4.2 Linux 服务器怎么设置

推荐用 systemd 的环境文件，密钥不进代码、不进命令行历史：

```bash
# 1) 只在服务器上创建，权限收紧（不要提交）
sudo install -m 600 -o w-4090 -g w-4090 /dev/null /home/w-4090/wzh-jhl/advisor.env
sudo -u w-4090 tee /home/w-4090/wzh-jhl/advisor.env >/dev/null <<'EOF'
ADVISOR_PROVIDER=openai-compatible
MODEL_API_URL=https://your-gateway.example.com/v1/chat/completions
MODEL_API_KEY=在这里填真实密钥
MODEL_NAME=your-model-name
MODEL_TIMEOUT_MS=20000
PORT=8080
HOST=127.0.0.1
EOF

# 2) systemd 里引用环境文件（示例片段）
#    [Service]
#    EnvironmentFile=/home/w-4090/wzh-jhl/advisor.env
#    ExecStart=/usr/bin/node /home/w-4090/wzh-jhl/backend/dist/src/index.js
sudo systemctl daemon-reload
sudo systemctl restart <你的服务名>
```

临时前台运行（只用于排查，注意 shell 历史会记录密钥，建议先 `unset HISTFILE`）：

```bash
export MODEL_API_URL='https://your-gateway.example.com/v1/chat/completions'
export MODEL_API_KEY='...'
export MODEL_NAME='...'
cd /home/w-4090/wzh-jhl/backend && npm start
```

### 4.3 Windows 本地怎么设置

```powershell
# 只对当前 PowerShell 窗口有效（推荐，不会残留）
$env:ADVISOR_PROVIDER='openai-compatible'
$env:MODEL_API_URL='https://your-gateway.example.com/v1/chat/completions'
$env:MODEL_API_KEY='...'
$env:MODEL_NAME='...'
$env:MODEL_TIMEOUT_MS='20000'

cd D:\智慧课程平台\server
npm run build; npm start
```

或者用 `.env` 文件（服务**不会自动读取**，要显式 `--env-file`）：

```powershell
Copy-Item .env.example .env      # 然后编辑 .env 填入真实值
node --env-file=.env dist/src/index.js
```

需要长期保留时用 `setx MODEL_API_KEY "..."`，但要注意它写进注册表、对新开的终端才生效，且**不要**在共享机器上这么做。

### 4.4 怎么确认配置缺失

三种确认方式，任选：

1. **启动日志**：出现 `模型配置不完整，建议接口将改用规则兜底（fallbackReason=MODEL_NOT_CONFIGURED）`，并列出缺失的变量名；
2. **发一个请求**：响应的 `source` 是 `fallback`、`fallbackReason` 是 `MODEL_NOT_CONFIGURED`；
3. **只看变量是否存在**（不打印值）：

```powershell
node -e "for (const n of ['ADVISOR_PROVIDER','MODEL_API_URL','MODEL_API_KEY','MODEL_NAME','MODEL_TIMEOUT_MS']) console.log(n+': '+(process.env[n] ? '已设置' : '未设置'))"
```

注意第 2 条的语义：配置缺失时**不是**直接返回 503，而是按契约先走规则兜底（`source: "fallback"`）。
只有**兜底也生成不出建议**时，才会返回 `503 MODEL_NOT_CONFIGURED`（契约 4.3 的说明与本实现一致）。

### 4.5 密钥安全

- `MODEL_API_KEY` **只能**来自环境变量：不写进代码、测试、文档、日志或响应；
- 仓库根 `.gitignore` 已忽略 `.env`、`.env.local`、`.env.*.local`，所以 `server/.env` 不会进版本库；
  **`server/.env.example` 只放变量名与说明，不要填真实值**；
- 单元测试里的 key 是明显的假值（`sk-test-...`），并且有专门的用例断言它不会出现在日志和错误信息里；
- 怀疑泄露时：先去模型网关吊销该 key，再重新下发。

## 5. 测试

```powershell
cd D:\智慧课程平台\server
npm test
```

`npm test` 先编译再运行测试，使用 Node 内置的 `node:test` + `node:assert`，**没有引入 jest / vitest**。HTTP 测试用随机空闲端口（`port: 0`），不占用 8080。

2026-09-28 本地结果：**86 条用例，全部通过**。

**测试不会调用真实模型**：

- 真实 provider 的单元测试全部通过 `fetchImpl` 注入替换 `fetch`（`test/advisor-model-provider.test.ts`），**不发任何网络请求**，也不读取环境变量里的真实密钥；
- HTTP 集成测试显式注入 mock provider，离线且确定性；
- 因此无需配置模型也能跑通 `npm test`。

| 测试文件 | 覆盖内容 |
| --- | --- |
| `test/health.test.ts` | `/health` 的状态码、字段、默认端口、环境变量、不泄露信息 |
| `test/advisor-recommendations.test.ts` | 建议接口的 HTTP 行为：请求校验、错误响应、引用清理、兜底、405/404 |
| `test/advisor-service.test.ts` | 校验层与服务层：不补默认值、截断与丢弃规则、超时/失败映射、兜底失败 |
| `test/advisor-model-provider.test.ts` | 真实 provider：请求形态、响应解析、各类失败映射、超时中断、不泄露密钥 |
| `test/cors.test.ts` | 生产来源的 OPTIONS/POST CORS 头，以及其他来源的拒绝行为 |

## 6. 健康检查

```powershell
curl.exe -i http://127.0.0.1:8080/health     # Windows：PowerShell 的 curl 是别名，要用 curl.exe
curl -i http://127.0.0.1:8080/health          # Linux / macOS
```

```http
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
cache-control: no-store

{"status":"ok","service":"course-platform-api","contractVersion":"1.0","checkedAt":"2026-09-25T02:58:52.630Z"}
```

响应体只包含这四个字段：不含环境变量、密钥、文件路径，也不含任何项目数据。

## 7. 建议接口

```http
POST /api/advisor/recommendations
```

字段名、状态码、错误码与响应结构全部以 `docs/contracts.md` 第 4、6 节为准。三条容易踩的约定：

1. `tasks` 必须包含该项目**全部**任务（含已完成）——否则服务端无法执行"已完成任务不得再推荐"；
2. `doubts` **只发 `status: "open"`** 的疑问；
3. 时间字段必须是 ISO 8601 带时区（`2026-09-25T10:12:00+08:00`）。

### 7.1 最小合法请求

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_demo",
  "projectRevision": 1,
  "projectName": "面向海洋环境安全保障的极端风和浪事件的智能分析系统",
  "currentMilestone": "选题确认与文献调研",
  "confirmedContext": [],
  "tasks": [
    {
      "taskId": "tsk_1",
      "title": "调研极端风浪事件的定义与识别方法",
      "status": "doing",
      "doneCriteria": "一页调研笔记",
      "owner": null,
      "milestone": "选题确认与文献调研",
      "updatedAt": "2026-09-25T10:12:00+08:00"
    }
  ],
  "evidence": [
    {
      "evidenceId": "evd_1",
      "submissionId": "sub_1",
      "taskId": "tsk_1",
      "didWhat": "查了 6 篇文献",
      "foundWhat": "多数研究用第 95 百分位做阈值",
      "stillUnsure": null,
      "author": null,
      "createdAt": "2026-09-25T10:05:00+08:00"
    }
  ],
  "doubts": [],
  "promptVersion": "mvp-prompt-v1",
  "forceRefresh": false
}
```

### 7.2 发送请求（Windows 注意）

**PowerShell 下不要用 `--data-raw "<json>"`**：内联 JSON 会被 PowerShell 改写，服务端会正确判为"请求体不是合法 JSON"。用文件方式：

```powershell
[System.IO.File]::WriteAllText("$PWD\request.json", $json, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -i -X POST -H "Content-Type: application/json" --data-binary "@request.json" `
  http://127.0.0.1:8080/api/advisor/recommendations
```

### 7.3 成功响应（`source: "model"`）

由真实模型生成，结构如下（`cached` 本轮恒为 `false`）：

```json
{
  "contractVersion": "1.0",
  "requestId": "9c1f0a6b-2c4d-4e77-9a3f-7b5e8d1c2043",
  "projectId": "prj_demo",
  "projectRevision": 1,
  "source": "model",
  "fallbackReason": null,
  "cached": false,
  "promptVersion": "mvp-prompt-v1",
  "suggestions": [
    {
      "title": "先把进行中的任务收尾：调研极端风浪事件的定义与识别方法",
      "whyNow": "它是当前唯一进行中的任务，收尾之后后续判断才有稳定前提。",
      "doneCriteria": "补齐一页调研笔记并提交证据",
      "existingTaskId": "tsk_1",
      "basisEvidenceIds": ["evd_1"],
      "basisDoubtIds": []
    }
  ]
}
```

### 7.4 兜底响应（`source: "fallback"`）

模型超时、上游故障、配置缺失或输出非法时，服务端**自己**用规则生成建议，仍返回 `200`，并把原因写进 `fallbackReason`：

取值：`MODEL_TIMEOUT` / `MODEL_UNAVAILABLE` / `MODEL_NOT_CONFIGURED` / `INVALID_MODEL_OUTPUT` / `RATE_LIMITED`。

### 7.5 失败响应

只有**兜底也失败**时才返回失败响应：

| code | HTTP | retryable | 触发条件 |
| --- | --- | --- | --- |
| `INVALID_INPUT` | 400 | false | 请求体非法、缺必填字段、超长度/条数上限、版本不受支持、Content-Type 不对 |
| `RATE_LIMITED` | 429 | true | 限流（本轮未实现限流，码先按契约保留） |
| `MODEL_TIMEOUT` | 504 | true | provider 超时，且规则兜底也失败 |
| `INVALID_MODEL_OUTPUT` | 502 | true | 输出非法被清理到 0 条，且规则兜底也失败 |
| `MODEL_UNAVAILABLE` | 503 | true | 上游故障，且规则兜底也失败 |
| `MODEL_NOT_CONFIGURED` | 503 | **false** | 未配置 URL/Key/模型名（重试不会变好），且规则兜底也失败 |
| `INTERNAL` | 500 | true | 服务端未预期异常；只返回通用文案，不含堆栈 |

请求体解析失败时 `requestId` 必须为 `null`。错误响应不含密钥、环境变量、堆栈、绝对路径，也不含上游响应原文。

### 7.6 provider 的实现与替换位置

| 项 | 位置 |
| --- | --- |
| provider 选型与装配（唯一替换点） | `src/index.ts` 的 `createAdvisorProvider` |
| 真实 provider（OpenAI 兼容） | `src/advisor/openaiCompatibleProvider.ts` |
| 提示词（系统提示词 + 数据脱敏序列化） | `src/advisor/prompt.ts` |
| 失败原因归类与兜底决策 | `src/advisor/service.ts` |
| 输出校验（截断、丢弃、剔除未知引用） | `src/advisor/validation.ts` |
| 规则兜底 | `src/advisor/fallback.ts` |
| HTTP 状态码与对外文案 | `src/routes/advisor.ts` |

请求形态（严格按契约要求的 OpenAI 兼容格式）：

```http
POST ${MODEL_API_URL}
Content-Type: application/json
Authorization: Bearer ${MODEL_API_KEY}
```

```json
{
  "model": "${MODEL_NAME}",
  "messages": [
    { "role": "system", "content": "（只返回符合契约的 JSON，不要 Markdown 或解释文字；引用只能用给定 ID）" },
    { "role": "user", "content": "（脱敏并序列化后的项目状态 JSON）" }
  ],
  "temperature": 0.2
}
```

只读取 `choices[0].message.content`，把它解析成 JSON 后交给**输出校验层**处理；
provider 层不做建议字段校验（避免同一套规则写两遍）。

超时用 `AbortController`；失败原因映射：

| 情况 | 失败原因 |
| --- | --- |
| 超过 `MODEL_TIMEOUT_MS` | `MODEL_TIMEOUT` |
| 网络错误 / 非 2xx | `MODEL_UNAVAILABLE` |
| 缺少 `choices[0].message.content`，或 content 不是合法 JSON | `INVALID_MODEL_OUTPUT` |
| `MODEL_API_URL` / `MODEL_API_KEY` / `MODEL_NAME` 缺失 | `MODEL_NOT_CONFIGURED` |

服务层额外有一层安全网超时（`MODEL_TIMEOUT_MS + 5000`，见 `src/index.ts`），只用于兜住"provider 没有遵守超时"的异常情况。

### 7.7 本地联调：用 mock provider

需要在不消耗模型额度、不联网的情况下验证前端状态时：

```powershell
$env:ADVISOR_PROVIDER='mock'
$env:MOCK_PROVIDER_MODE='throw'   # ok / empty / invalid / throw / not-configured / slow
npm start
```

`ADVISOR_PROVIDER=mock` 只应在本地使用；**部署环境不要设置它**，启动日志也会明确提示"仅限本地联调"。

## 8. 目录结构

```text
server/
├── package.json / package-lock.json / tsconfig.json / .env.example
├── src/
│   ├── index.ts                        # 依赖装配、注册路由、兜底 404、启动监听
│   ├── config.ts                       # 端口/监听地址 + 模型相关环境变量读取
│   ├── routes/
│   │   ├── health.ts                   # GET /health
│   │   └── advisor.ts                  # POST /api/advisor/recommendations（HTTP 层）
│   └── advisor/
│       ├── types.ts                    # 领域类型、provider 接口、错误类型、日志接口
│       ├── prompt.ts                   # 系统提示词 + 项目数据脱敏序列化
│       ├── openaiCompatibleProvider.ts # 真实模型 provider（原生 fetch + AbortController）
│       ├── mockProvider.ts             # 确定性 mock provider（离线联调 / 测试注入）
│       ├── validation.ts               # 请求校验 + 输出校验
│       ├── fallback.ts                 # 服务端规则兜底
│       └── service.ts                  # 编排：provider → 输出校验 → 兜底 → 最终失败码
├── test/
│   ├── health.test.ts
│   ├── advisor-recommendations.test.ts
│   ├── advisor-service.test.ts
│   └── advisor-model-provider.test.ts
└── dist/                               # 编译产物（npm run build 生成）
```

写新代码时的约定：

- 源码里的相对导入**带 `.js` 后缀**（如 `import { config } from './config.js'`），这是 NodeNext 的要求；
- 业务逻辑写在 `src/routes/*.ts` 或 `src/advisor/*.ts`，`src/index.ts` 只做装配；
- 所有 JSON 响应走 `sendJson()`，统一带 `no-store`；
- 日志只打印 ID、状态码、原因等非敏感字段，不打请求体、不打密钥、不打完整 URL。

## 9. 与部署的关系

| 项 | 状态 |
| --- | --- |
| 本地 `127.0.0.1:8080` | 已实测：`GET /health` 与 `POST /api/advisor/recommendations` 均返回预期结果 |
| 服务器上的 8080 端口 | 后端 systemd 服务监听 `127.0.0.1:8080`（2026-09-25 验收记录） |
| 服务器上的 **18080** 端口 | **由现有 Python 进程占用，禁止停止、修改或复用** |
| `api.xinxian-music.xyz` 的 DNS、证书、隧道连通、CORS | **已验证**（2026-09-25；OPTIONS 204、POST 200、生产来源白名单生效） |
| 真实模型调用 | 服务器侧已用 DeepSeek 验证返回 `source: model`；本地离线测试仍不调用真实端点 |

因此：上表结果是历史验收记录。后续后端、前端静态文件、隧道或环境变量变更后，必须重新实测，不能只依据 Git 合并记录宣称当前线上状态。

## 10. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动报 `EADDRINUSE` | 8080 被占用。先确认占用者是谁，不要直接杀掉不认识的进程；也可以临时换 `PORT` |
| 启动报「环境变量 PORT 必须是 1-65535 之间的整数」 | `PORT` 非法。有意行为，不会静默回退 |
| 响应里 `source` 一直是 `fallback` | 看 `fallbackReason`：`MODEL_NOT_CONFIGURED` = 缺配置；`MODEL_UNAVAILABLE` = 上游/网络；`MODEL_TIMEOUT` = 超时；`INVALID_MODEL_OUTPUT` = 模型没按 JSON 输出 |
| 模型总是返回不合法内容 | 检查该网关是否按要求返回 `choices[0].message.content`，以及是否忽略了系统提示词；必要时调大 `MODEL_TIMEOUT_MS` 或换模型 |
| PowerShell 里 `curl` 返回的不是 JSON | PowerShell 把 `curl` 映射到了 `Invoke-WebRequest`，改用 `curl.exe` |
| POST 返回 `请求体不是合法 JSON` | 多半是 PowerShell 内联 JSON 被改写。改用 7.2 的文件方式 |
| 改了源码但 `npm start` 没变化 | `npm start` 跑的是 `dist/`，需要先 `npm run build`；开发时用 `npm run dev` |

## 11. 已知遗留

1. **`MODEL_TIMEOUT_MS` 与模型变量都在 `src/config.ts` 统一读取**；服务层的安全网超时写在 `src/index.ts`（`MODEL_TIMEOUT_MS + 5000`）。
2. **`INTERNAL`（500）会被返回**：契约 6.2 把它标为"保留码"，实现中只在出现未预期异常时返回（通用文案），比让请求挂掉更安全。
3. **`forceRefresh` / `cached` 已按契约出现，但服务端还没有缓存层**：`cached` 恒为 `false`。
4. **提示词与 `docs/ai/prompt-spec.md` 需要对齐**：运行时提示词在 `src/advisor/prompt.ts`，版本号在 `src/advisor/types.ts` 的 `SUPPORTED_PROMPT_VERSIONS`；改内容时要同步升级版本号。
5. **provider 对 ```json 代码块做了最小宽容**：系统提示词已禁止围栏输出，这里只在明显带围栏时剥掉，避免个例导致整次调用作废。
6. **`server/dist` 已加入仓库根 `.gitignore`**：`npm run build` 会产生该目录，但不会作为源码提交。

## 12. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-25 | 首版：后端骨架 + `GET /health` + 12 条测试 |
| 2026-09-25 | 建议接口：请求校验、统一错误响应、规则兜底、mock provider + 49 条测试 |
| 2026-09-25 | 接入真实模型 provider（OpenAI 兼容，原生 fetch）：环境变量配置、提示词模块、超时与失败映射 + 22 条测试（合计 83 条） |
| 2026-09-25 | 增加生产来源 CORS 白名单与预检处理；后端测试达到 86 条并通过 |
