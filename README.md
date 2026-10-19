# 《大数据分析实践》智慧课程平台 · AI 项目顾问

以**项目当前状态**为核心的课程项目推进平台。

学生选定课程题目、上传实验手册与数据集说明后，AI 项目顾问按项目所在阶段给出 **1~3 步建议**——
每步都写清「为什么现在做」和「完成标志」；学生认领步骤、做完后提交证据，平台据此更新里程碑状态，
并给出下一步建议。

> AI 不给现成答案，也不给现成的文献链接。它给的是**检索提示词**与**下一步该做什么**；
> 判断和文献阅读仍然由学生完成。

## 三个页签

| 页签 | 路径 | 内容 |
| --- | --- | --- |
| 工作台 | `/` | 没有项目时是创建页；有项目时是「五段里程碑流程条 + 三栏工作台」 |
| 项目地图 | `/#/map` | 里程碑与当前实际步骤的关系图，顶点是项目本体 |
| 论文推荐 | `/#/papers` | AI 结合项目当前阶段生成检索提示词；每个项目自带 3 条启动期方向 |

**工作台三栏**

- **左**：我的项目（多项目切换）· 项目资料 · 里程碑进度 · 近 4 周活跃度 · 未解决的疑问
- **中**：AI 项目顾问（步骤建议 · 认领 / 提问 / 相关论文）· 项目地图 · 向顾问提问（答疑模式）
- **右**：提交步骤证据（完成了什么 / 发现了什么 / 解决了哪个问题 / 还有什么不确定 + 附件）· 最近证据

## 运行

```bash
npm install
npm run dev        # 打开 http://localhost:5173/
npm run build      # 产物到 dist/
npm run typecheck
npm test           # 前端 Vitest 测试（用例数以命令输出为准，不在此处固化）
```

Node 20.19+ 或 22.12+（Vite 8 的要求）。

建议接口由独立的 `server/` 服务提供。启动方式和模型环境变量见 [后端配置说明](docs/mvp-backend-setup.md)；前端通过 `VITE_API_BASE_URL` 指向 API 域名（不含 `/api`）。后端使用自己的 `cd server && npm test`，与根目录的前端测试分开运行。

## 数据

- 内置 **9 套课程题目模板**（`src/data/topics.ts`），每套含 5 个里程碑、启动期疑问、
  AI 顾问的 3 步建议、3 条论文检索方向。创建项目时按题目实例化，也可自定义题目。
- 项目、任务、证据、疑问和当前项目保存在浏览器 `localStorage`，刷新后可恢复；换浏览器或设备不会同步这些数据。`server/src/v3` 已实现账号与 SQLite 云端读写，但**前端尚未接入**，所以对用户而言当前仍是纯本地存储。
- 提交证据会写入「最近证据」时间线；「还有什么不确定」会生成未解决疑问。证据保存成功后，前端请求建议接口；模型不可用时按服务端或本地规则兜底。

接口字段与错误码以 [接口契约](docs/contracts.md) 为准；当前已实现能力与剩余缺口见 [PR2 状态](docs/v3-v4-pr2-status.md)。

## 目录

```
src/
├── views/WorkbenchView.vue            工作台（创建页 + 三栏）
├── views/ProjectMapView.vue           项目地图页（页签入口）
├── views/PapersView.vue               论文推荐
├── components/ProjectCreate.vue       创建项目表单
├── components/ProjectMindMap.vue      项目地图（SVG：里程碑 / 项目 / 当前步骤）
├── components/PaperDirectionCard.vue  论文检索方向卡
├── stores/workbench.ts                多项目 / 材料 / 证据 / 问答 / 论文推荐
├── stores/persistence.ts              项目状态的 localStorage 保存与迁移
├── services/http.ts                    浏览器 HTTP 封装
├── services/advisorApi.ts              建议接口适配
├── domain/                             进度、活动与建议领域逻辑
├── data/topics.ts                     9 套题目模板
├── types/platform.ts                  领域类型
└── styles/platform.css                界面样式（与设计稿同源）

server/                                 独立的后端服务与测试
tests/                                  前端 Vitest 测试
```

## 说明

- 界面参照 `platform-ui-mockup(3).html`（设计稿，本地保留，未纳入版本库）。
- `legacy-v0/`、`legacy-v1/` 是前两版的界面代码归档，**未纳入版本库**（本地保留）。
  需要取回时用 `git show 05c5eb1:<路径>`。
- `public/images/` 是往届项目缩略图与教师照片，当前界面未使用，**未纳入版本库**（本地保留）。
- 真实会议记录、需求文档等课程素材同样不进版本库，见 `.gitignore`。
