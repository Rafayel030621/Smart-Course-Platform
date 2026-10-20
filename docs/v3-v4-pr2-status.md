# PR2 后端基础能力：完成度与后续依赖

> 对应分支：`codex/v3-v4-pr2b-read`
> 对应契约：`docs/contracts.md` 第 20～25 节
> 本文只描述当前代码能力，不代表生产已部署。
>
> **PR2B 第一阶段只补齐云端读取；不包含材料上传/重新解析、聊天、疑问写入、时间线、阶段候选、AI 上下文门禁和前端接入。**

## 1. 本 PR 已完成

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| SQLite 持久化 | 完成 | WAL、事务、唯一约束、`schema_migrations` |
| 注册/登录/退出/会话 | 完成 | bcrypt、HttpOnly Cookie、会话轮换、注册响应丢失恢复 |
| 会话安全 | 完成 | token 只存 SHA-256；登录/注册限流在 bcrypt 前预占 |
| 项目归属与隔离 | 完成 | 所有查询带 `userId + projectId`；跨用户 404 |
| 项目基本读写 | 完成 | 列表、创建、详情、编辑、归档、软删除/恢复 |
| 阶段 | 完成 | 创建、编辑、排序、状态机、归档/恢复、任务统计 |
| 任务 | 完成 | 创建、编辑、关联阶段、开始/完成/重开/归档/恢复 |
| 任务读取 | 完成（PR2B） | 列表/单任务；归档任务与归档阶段默认隐藏，支持 `includeArchived`、过滤和分页 |
| 进展 | 完成 | 创建、列表、更正（supersede） |
| 证据 | 完成 | 创建、列表、关联任务/阶段、历史快照 |
| 材料读取 | 完成（PR2B） | 当前版本列表/单材料；历史版本 `version` 只读；分页 |
| 片段与草稿读取 | 完成（PR2B） | 按 `materialId + materialVersion` 读取片段与理解条目；来源从数据库回填 |
| 材料草稿五动作 | 完成 | confirm/edit/remove/undo/confirm-all |
| 本地迁移 | 完成 | 单事务、幂等、去重、失败回滚、`originalText` |
| 幂等/版本/权限 | 完成 | 指纹绑定操作+资源；`expectedRevision`；`STALE_REVISION` |
| 日志安全 | 完成 | 无正文/密码/Cookie/邀请码/路径；字段长度边界 |

## 2. 仍未提供的云端读取/持久化能力

PR2B 第一阶段已经补齐任务、材料、片段和理解草稿读取；以下能力仍未提供：

- V3 材料上传、重新解析、材料归档/恢复写接口（V2 `POST /api/materials` 仍保持原行为）；
- 证据单条读取（条件允许时）、附件；
- 进展单条读取；
- 疑问的手工创建/解决/归档写接口（目前只有证据自动创建、迁移导入）；
- 聊天会话/消息的读取、发送和持久化接口；
- 项目时间线 `GET /api/projects/{projectId}/timeline`；
- 阶段候选 `POST /api/projects/{projectId}/milestones/candidates`；
- V3 AI 上下文门禁和“仅 confirmed 草稿进入上下文”的服务端接入。

因此**不能宣称前端已经可以完整切换到云端**：任务、材料、片段、草稿可以读取，但材料上传/解析、聊天、疑问和时间线仍依赖后续阶段或 V2 旧路径。

## 2.1 本阶段新增只读接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/projects/{projectId}/tasks` | 任务列表，支持 `milestoneId`、`status`、`includeArchived`、`limit`、`cursor` |
| `GET /api/projects/{projectId}/tasks/{taskId}` | 单任务读取，`includeArchived=true` 可读归档任务/归档阶段任务 |
| `GET /api/projects/{projectId}/materials` | 当前版本材料元数据列表，支持 `includeArchived`、`limit`、`cursor` |
| `GET /api/projects/{projectId}/materials/{materialId}` | 单材料；`version=N` 读取历史版本，响应 `isCurrent/readOnly` |
| `GET /api/projects/{projectId}/materials/{materialId}/segments` | 指定材料版本片段，按 `index` 排序，分页 |
| `GET /api/projects/{projectId}/materials/{materialId}/understanding` | 指定材料版本理解草稿，默认隐藏 archived，来源从数据库真实片段回填 |

读取接口不要求 `idempotencyKey`，不递增 `projectRevision`，不写幂等记录。软删除项目 404；归档项目只读可访问。

## 3. 前端数据层接入前置条件

1. 登录后所有请求 `credentials: 'include'`，不把会话 token 写入 localStorage/sessionStorage/IndexedDB/URL；
2. 写请求统一带 `contractVersion: "3.0"`、UUID v4 `requestId`、`idempotencyKey`、`projectRevision`，单实体写操作带 `expectedRevision`；
3. 收到 `409 STALE_REVISION` 先刷新项目再让用户确认，不自动重放破坏性写；
4. 注册响应丢失时用同一 `idempotencyKey` 和同一账号/昵称/密码/邀请码重试，接收新的 `Set-Cookie` 和 `replayed: true`；
5. 迁移成功前不得删除 localStorage；成功后至少保留 7 天；
6. 不要用项目详情中的统计代替任务/材料/证据/聊天列表。

## 4. 明确不在本 PR 内

- 前端页面与状态层改造；
- V3 材料上传/重新解析/归档写接口；
- 证据/进展单条读取、疑问写入、聊天、时间线、阶段候选、AI 上下文门禁；
- 生产部署、Nginx、Cloudflare 隧道、18080、密钥或模型配置；
- 大规模 AI 提示词修改；
- 多实例部署或从 SQLite 迁移到 PostgreSQL/MySQL。

部署相关要求见 `docs/deployment/backend-sqlite.md`。
