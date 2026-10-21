# V3 三类路径 · 评估集清单与契约测试样例

> 用途：回应 2026-10-21 负责人对后端契约测试的两项要求——① 三类路径评估集各多少条、文件在哪；② 每类 2 条「输入 + 期望输出」，供服务端把**来源回填**写成断言。
>
> **本文件不含结论性决策**，只提供可对照的数据；待拍板的两条与三个方案在 §2 末尾与 §4 中标出，以契约为准。
>
> 基线：`90885e0`。文中所有 ID、行号、文案都取自入库的 fixture（`tests/fixtures/ai/stageScenarios.ts`），**可以与代码逐字对照**，不是另编的一套数据。
>
> 规格出处：`docs/ai/prompt-spec.md` §11.6（校验矩阵）、§11.7（来源说明规则）；契约出处：`docs/contracts.md` §23.2 / §23.3 / §23.6 / §23.7。

---

## 一、评估集：各多少条、文件在哪

| 路径 | `promptVersion` | 评估场景 | 反例 | 合法样例 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 建议 | `mvp-prompt-v3` | **7 条**（S7–S13） | 5 条（S-R2/3/4/8/9） | — | 每场景含输入上下文 + 预期要点 + 禁止内容 + 实际结果四列 |
| 聊天 | `advisor-chat-v3` | **1 条**（S15） | 3 条（S-R10/11/12） | — | 长问题 + 步骤列表场景 |
| 阶段候选 | `milestone-candidate-v1` | **0 条** | 5 条（S-R1/5/6/7/15） | 请求 1 组 + 响应 1 组（3 条候选） | 见下方说明 |
| 跨路径 | — | 1 条（S14 故障注入） | 2 条（S-R13/S-R14 版本组合） | — | S14 覆盖建议与候选两条路径的兜底 |

**合计：9 个评估场景 + 15 条反例 + 33 条自动断言。**

| 东西 | 位置 |
| --- | --- |
| 评估场景表（人读） | `docs/ai/evaluation.md` §9.1，第 308–318 行 |
| 场景与规格条款的对应 | `docs/ai/evaluation.md` §9.6，第 401–409 行 |
| 可执行的场景数据 | `tests/fixtures/ai/stageScenarios.ts` → `STAGE_SCENARIOS`（S7–S15） |
| 反例集 | 同上 → `STAGE_COUNTEREXAMPLES`（S-R1–S-R15） |
| 候选合法样例 | 同上 → `STAGE_CANDIDATE_REQUEST`（第 700 行）、`STAGE_CANDIDATE_EXAMPLE`（第 632 行） |
| 自动断言 | `tests/content/stageAiFixtures.test.ts`（33 条） |

跑法（在仓库根目录）：

```bash
node ./node_modules/vitest/vitest.mjs run tests/content/stageAiFixtures.test.ts
```

**候选为什么是 0 条评估场景**：候选接口（文档编号 D12）还没实现，没有可调用的端点，跑真实模型评估会直接 404。我不拿 mock 结果冒充模型结果，所以如实记 0。等 D12 落地后我会补 3 条：空白项目不得自动生成候选 / 有已确认材料时可回填 sources / 无材料时 `sources: []`。**这 3 条的判定标准已经在 §9.3 的 MC1–MC9 里写好了，接口一通就能补。**

---

## 二、回填的通用规则（写断言前先对齐）

这 7 条来自契约 §23.3 / §23.6 / §23.7 与 `prompt-spec` §11.6 / §11.7，可以直接逐条写成断言：

1. **回填字段一律取数据库值**：`materialId`、`materialName`、`materialVersion`、`startLine`、`endLine`、`itemId`。客户端传来的 `name` / `startLine` / `endLine` / `text` 一律不采信（契约 §23.3 规则 1）。
2. **只认 `status = "confirmed"`**：`pending` / `modified` / 归档材料 / 旧版本都算未确认。整段引用不合法时返回 400 `UNCONFIRMED_MATERIAL` 或 409 `MATERIAL_VERSION_OUTDATED`，**不是静默丢弃**（契约 §23.3 规则 2）。
3. **未知 `segmentId` → 剔除单条引用，不整条回退**（`prompt-spec` §11.6「三条共同底线」第 2 条）。
   - 候选：剔除后为空 → 保留候选、`sources: []`，并在 `notice` 说明"未引用材料"；
   - 建议：剔除后为空 → `basisMaterialRefs: []`；
   - 聊天：剔除后为空 → `citations: []`，`answer` **保留**，但前端不得展示"依据来自某材料"。
4. **响应必须始终含该字段**：v3 三个接口在无引用时返回 `[]`，**不是 `null`、不是省略**（契约 §23.6 字段规则、§23.7 规则）。
5. **条数上限**：候选 `sources` 0–3、建议 `basisMaterialRefs` 0–3、聊天 `citations` 0–5。超出部分丢弃，不报错。
6. **模型侧只回 `segmentIds`**：响应里不得保留 `segmentIds` 数组，也不得出现模型自造的 `materialName` / `startLine`（对应反例 S-R8）。
7. **`milestoneRevision` 回显**：建议与聊天响应回显请求里的 `milestoneRevision`；候选响应不带该字段。

**两条待拍板的（契约没写，规格不单方面定）**：

- **重复 `segmentId`**：同一条建议里 `segmentIds: ["seg_1","seg_1","seg_2"]` 怎么处理？我建议按首次出现去重，保留 2 条。
- **超上限时保留哪几条**：模型给 6 条、上限 3 条时，我建议按模型给定顺序保留前 3 条，不做相关性重排（服务端不判断哪条更相关）。负责人拍板后写入 `prompt-spec.md` §11.7。

---

## 三、六个样例（三类各 2 条）

### 3.0 共用测试数据（数据库里的已确认片段）

| materialId | materialName | version | segmentId | 行号 | 正文（摘要） |
| --- | --- | --- | --- | --- | --- |
| `mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215` | `实验手册.md` | 1 | `seg_1` | 10–18 | `## 数据说明 … 采样间隔 1 小时，空间分辨率 0.5 度。` |
| `mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215` | `实验手册.md` | 1 | `seg_2` | 24–26 | `缺失率超过 5% 的时间段需要单独记录…` |

项目：`prj_9f3c1a7b5d2e4c6081a4b7d9e2f5c830`，`projectRevision = 15`。

> **六个样例都只用这一份材料**，这样"模型回 `seg_1`"没有歧义、期望输出是唯一的、可以直接写死断言。多材料的情况见第四节——那里有个必须在实现前定掉的问题。

---

### C1 · 阶段候选：正常回填

**请求关键字段**

```json
{
  "contractVersion": "3.0",
  "projectId": "prj_9f3c1a7b5d2e4c6081a4b7d9e2f5c830",
  "projectRevision": 15,
  "promptVersion": "milestone-candidate-v1",
  "maxCandidates": 3,
  "focus": "围绕数据获取和预处理生成阶段"
}
```

**模型原始输出**（只有 `segmentIds`，没有材料名和行号）

```json
{
  "candidates": [
    {
      "name": "数据获取与预处理",
      "goal": "拿到可复现的样例数据，并确认字段口径与缺失率",
      "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
      "suggestedTasks": [
        {
          "title": "跑通 ERA5 与浮标数据的下载链路",
          "doneCriteria": "下载一段样例数据，并能用 Python 读出有效波高与风速"
        }
      ],
      "risks": ["0.5 度分辨率可能不满足公里级判断"],
      "segmentIds": ["seg_1", "seg_2"]
    }
  ]
}
```

**期望响应（只摘 `candidates[0]`）**

```json
{
  "candidateId": "<服务端生成，cand_ 前缀>",
  "name": "数据获取与预处理",
  "goal": "拿到可复现的样例数据，并确认字段口径与缺失率",
  "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
  "suggestedTasks": [
    {
      "title": "跑通 ERA5 与浮标数据的下载链路",
      "doneCriteria": "下载一段样例数据，并能用 Python 读出有效波高与风速"
    }
  ],
  "risks": ["0.5 度分辨率可能不满足公里级判断"],
  "sources": [
    {
      "materialId": "mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215",
      "materialName": "实验手册.md",
      "materialVersion": 1,
      "segmentId": "seg_1",
      "startLine": 10,
      "endLine": 18,
      "itemId": null
    },
    {
      "materialId": "mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215",
      "materialName": "实验手册.md",
      "materialVersion": 1,
      "segmentId": "seg_2",
      "startLine": 24,
      "endLine": 26,
      "itemId": null
    }
  ],
  "expiresAt": "<服务端生成，约 now + 30 分钟>"
}
```

**断言**

1. `sources` 长度 = 2，顺序与模型的 `segmentIds` 顺序一致；
2. `sources[0].materialName === "实验手册.md"`、`materialVersion === 1`、`startLine === 10`、`endLine === 18`、`itemId === null`；
3. `sources[1].startLine === 24`、`endLine === 26`；
4. 响应里**不存在** `segmentIds` 字段；
5. `projectRevision` 仍为 15（候选不写库、不递增），响应顶层 `source === "model"`、`notice === null`。

---

### C2 · 阶段候选：`segmentIds` 全部未知

**请求**：同 C1。

**模型原始输出**

```json
{
  "candidates": [
    {
      "name": "数据获取与预处理",
      "goal": "拿到可复现的样例数据，并确认字段口径与缺失率",
      "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
      "suggestedTasks": [],
      "risks": [],
      "segmentIds": ["seg_3", "seg_9"]
    }
  ]
}
```

（`seg_3` 不属于本次已确认片段，`seg_9` 根本不存在。）

**期望响应**

```json
{
  "candidates": [
    {
      "candidateId": "<服务端生成>",
      "name": "数据获取与预处理",
      "goal": "拿到可复现的样例数据，并确认字段口径与缺失率",
      "doneCriteria": "样例数据可下载，字段说明与缺失率记录完整",
      "suggestedTasks": [],
      "risks": [],
      "sources": [],
      "expiresAt": "<服务端生成>"
    }
  ],
  "source": "model",
  "notice": null
}
```

**断言**

1. 候选**保留**（不是整条丢弃），`sources === []`；
2. `source` 仍为 `"model"`——引用不合法不等于模型失败，**不退化成 fallback**；
3. 两条未知 ID 都进日志（建议日志字段：`unknownSegmentIds`），但**不得出现在响应任何字段里**。

> **⚠️ 这条样例有两处措辞要你先定，定完我再改期望值。** 我按能确定的部分写了，不确定的没写死：
>
> **① `notice` 到底要不要？** `prompt-spec` §11.6 写的是"剔除后为空 → 保留候选但 `sources: []`，并在 `notice` 里说明'未引用材料'"。但契约 §15.2 对材料理解规定"`source: "model"` 且成功时为 `null`"，§23.7 也只把 `notice` 用在兜底场景。按这个口径，`source: "model"` 时不该有 `notice`，所以上面写的是 `null`。**如果按 §11.6 走，就要允许 model + notice 并存**——这是契约的一句话缺口；确认后同步改规格。
>
> **② §23.8 那句"候选无来源则丢弃该条"包不包括材料来源？** 原文在"阶段上下文引用"这一行下面（`milestoneId` / `taskId` 必须在本次请求范围内），但"无来源"可以被读成"没有任何 `sources`"。两种读法结果差别很大：
>
> - 只指 `milestoneId` / `taskId` → 材料为空**保留**候选（我 §11.6 的写法）；
> - 也包含 `sources` → 材料为空就**丢掉整条候选**（C2 的期望要整个改成 `candidates: []`）。
>
> 我倾向前者（材料为空是正常状态，项目刚建时本来就没有材料），但契约由负责人维护，待其确认。

---

### A1 · 阶段建议：`basisMaterialRefs` 正常回填

**请求关键字段**：`promptVersion: "mvp-prompt-v3"`，`milestoneContext` 为 active 阶段（`ms_4a2e7c1f9b3d5a6082c4e7b1d9f3a562`，1 条 `doing` 任务、1 条 `todo`），`confirmedMaterials` 为 3.0 节的这份材料。

**模型原始输出**

```json
{
  "suggestions": [
    {
      "title": "把 0.5 度分辨率的缺口写成待确认事项",
      "whyNow": "当前阶段的完成标准要求确认字段口径与缺失率，而现有证据已指出分辨率与公里级判断存在差距；现在不确认，后续阈值结果都要重算。",
      "doneCriteria": "一页说明：0.5 度对应的实际距离、缺口量化、两个可选替代数据源",
      "existingTaskId": "tsk_5f1a8c3e9b2d4a6073c6e9b2d5f8a142",
      "basisEvidenceIds": ["evd_3e7b1c5a9d2f4b6081c4e7b2d9a5f306"],
      "basisDoubtIds": [],
      "segmentIds": ["seg_1"]
    }
  ]
}
```

**期望响应（只摘 `suggestions[0]` 的引用字段）**

```json
{
  "basisMaterialRefs": [
    {
      "materialId": "mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215",
      "materialName": "实验手册.md",
      "materialVersion": 1,
      "segmentId": "seg_1",
      "startLine": 10,
      "endLine": 18,
      "itemId": null
    }
  ]
}
```

**断言**

1. `basisMaterialRefs` 在**每条 suggestion 内**（不是响应顶层），长度 1；
2. 六个回填字段与 3.0 节一致，`itemId === null`；
3. suggestion 内不再有 `segmentIds`；
4. `existingTaskId` 原样保留（它指向的是**未完成**的 todo 任务，属合法指向）；
5. 响应顶层 `milestoneRevision === 4`（回显请求值）。

---

### A2 · 阶段建议：模型没有给任何引用

**请求**：同 A1。

**模型原始输出**（注意：**`segmentIds` 键缺失**）

```json
{
  "suggestions": [
    {
      "title": "先补齐样例数据的字段说明",
      "whyNow": "当前阶段目标是拿到可复现的样例数据，字段说明仍未成形。",
      "doneCriteria": "一页字段说明：每个字段的含义、单位、缺失率",
      "existingTaskId": null,
      "basisEvidenceIds": [],
      "basisDoubtIds": []
    }
  ]
}
```

**期望响应（只摘 `suggestions[0]` 的引用字段）**

```json
{
  "basisMaterialRefs": []
}
```

**断言**

1. `basisMaterialRefs` **必须存在**且 === `[]`，不能是 `null`、不能省略（契约 §23.6 字段规则明确"v3 服务端必须返回该字段"）；
2. suggestion 本身保留（缺引用不是失败，是正常的"无材料依据"）；
3. `whyNow` 中**不得**出现"根据材料""材料中写明"这类话（对应 §11.7 末尾那条"空数组不是错误，编一个来源才是"）。

---

### H1 · 聊天：合法引用 + 未知引用混合

**请求**：`promptVersion: "advisor-chat-v3"`，`milestoneRevision = 4`，`milestoneContext` 同 A1，`question` 为学生追问。

**模型原始输出**

```json
{
  "answer": "先把两件事落到纸面：一是把 0.5 度分辨率的缺口写成一条待确认事项，注明对应的实际距离和两个可选数据源；二是补齐缺失率记录，缺失率超过 5% 的时间段要单独列出并说明处理方式。两件都完成后，再进入阈值方案对比。",
  "segmentIds": ["seg_1", "seg_2", "seg_9"]
}
```

**期望响应**

```json
{
  "answer": "<与模型原文一字不差>",
  "citations": [
    {
      "materialId": "mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215",
      "materialName": "实验手册.md",
      "materialVersion": 1,
      "segmentId": "seg_1",
      "startLine": 10,
      "endLine": 18,
      "itemId": null
    },
    {
      "materialId": "mat_1d7a4c2e8b5f4a6093d6b1e8c4a7f215",
      "materialName": "实验手册.md",
      "materialVersion": 1,
      "segmentId": "seg_2",
      "startLine": 24,
      "endLine": 26,
      "itemId": null
    }
  ],
  "milestoneRevision": 4
}
```

**断言**

1. `citations` 长度 = 2（`seg_9` 被剔除），顺序保持模型给定顺序；
2. `answer` 一个字都不改——剔除引用不修改回答正文；
3. `milestoneRevision === 4`；
4. `seg_9` **不得写入历史消息**（契约 §23.7：不把未知引用写入历史），下次请求回放历史时不应出现它。

---

### H2 · 聊天：唯一引用未知，但回答声称有依据

**请求**：同 H1。

**模型原始输出**

```json
{
  "answer": "依据你上传的实验手册，缺失率超过 5% 的时间段必须单独记录，建议先把这一条补进阶段说明里。",
  "segmentIds": ["seg_9"]
}
```

**期望响应**

```json
{
  "answer": "依据你上传的实验手册，缺失率超过 5% 的时间段必须单独记录，建议先把这一条补进阶段说明里。",
  "citations": [],
  "milestoneRevision": 4
}
```

**断言**

1. `citations === []`；
2. `answer` **保留**，不因无合法引用而退回 fallback（契约 §23.7：模型声称有材料依据但没有合法引用时，仍可保留回答）；
3. `source` 仍为 `"model"`；
4. **前端侧断言（转李焰彬）**：`citations.length === 0` 时，界面**不得**渲染"依据来自《实验手册》"这类来源标签——对应反例 S-R11。

---

## 四、一个会立刻卡住多材料回填的问题：`segmentId` 只在材料内唯一

这一条不是挑刺，是**写多材料回填时一定会撞上**的，越早定越省事。

**证据**

1. 契约 §14.3（第 934 行）明确写着：`segmentId` "**只在同一 `materialId` + `version` 内唯一**"；
2. 服务端生成规则是 `server/src/materials/parseText.ts:114` → `segmentId: \`seg_${index}\``，**每份材料都从 `seg_0` 重新开始**；
3. 现有测试数据就是这种情况：`实验手册.md v1` 有 `seg_1`，`数据字段说明.txt v2` 也有 `seg_1`（`stageScenarios.ts` 第 132 行、第 153 行）。

**撞在哪**

模型只回一个 `seg_1`，服务端在"本次已确认片段"里能查到**两条**同名记录：

- `实验手册.md` v1 → 第 10–18 行
- `数据字段说明.txt` v2 → 第 3–5 行

回填取哪条？取错就是**材料名和行号张冠李戴**——学生看到的"依据"指向了另一份文件的另一段话。而评估场景 S12（2 份材料、3 条已确认片段）**只要跑第一次真实模型就会遇到**。

**三个可选做法**

| 方案 | 做法 | 成本 | 契约要改吗 |
| --- | --- | --- | --- |
| **A（我推荐）** | 服务端组提示词时把引用标识重写成带材料序号的**提示词内虚拟 ID**（例如 `m1:seg_1`），模型原样回，服务端映射回真实 `materialId + segmentId` | 低，零迁移 | 只需补一句说明，不动字段 |
| B | 生成时就全局唯一（`seg_<materialId 短码>_<序号>`） | 高：要改 `parseText` + 迁移已存片段 | 要改 §14.3 |
| C | 每次请求只发一份材料的已确认片段，多材料分多次调用 | 低 | 要改 §23.3 的"本次请求"语义 |

**为什么推荐 A**：契约"模型只输出 `segmentIds`"这条**不用破**——模型看到的仍然是 segmentId，只是这个 ID 的空间是"本次提示词内的"。服务端掌握映射表，模型没法伪造材料名和行号，正好符合负责人回信里说的"不想给伪造开口子"。代价只是契约 §23.3 规则 3 后面加一句：

> 提示词内可使用带材料前缀的引用标识（如 `m1:seg_1`），由服务端映射回真实 `materialId + segmentId`；响应中一律输出真实 `segmentId`。

**若选 C**，那六个样例不用改（本来就是单材料），但建议/聊天就失去了跨材料关联能力，要在 §11.2 的"不发送清单"里写清楚。

---

## 五、编号对照：负责人排期编号 vs `prompt-spec.md` §9.3

负责人 2026-10-21 回信中的编号跟 §9.3 错开了一位（除 D17 对得上），为避免后续 PR 标题与代码注释串号，先对一下：

| 负责人说的 | 内容 | §9.3 里的编号 |
| --- | --- | --- |
| D12 + D13 | 版本列表 + `milestoneContext` 类型/校验/提示词分支 | **D13** |
| D14 | 服务端材料门禁（只认 confirmed） | **D15** |
| D15 | 阶段候选接口 | **D12** |
| D16 | 前端常量与命名（李焰彬） | **D14** |
| D17 | "四块"改"五块" | **D17** ✅ |

**建议**：后续统一按 §9.3 的编号（本文件已随本轮 PR 提交，改编号会让已经核对过的行号失效）。若更习惯另一套，可把这段对照表加进 §9.3，让两套编号同时可查。

**顺带确认排期理解一致**（按 §9.3 编号）：

```text
第一步  D13（版本列表 + milestoneContext）        ← 负责人原编号 D12+D13
第二步  D15（服务端材料门禁）                     ← 负责人原编号 D14
第三步  D12（阶段候选接口，依赖前两步）           ← 负责人原编号 D15
第四步  D17（"五块"文案 + 与评估集一起验）
第五步  D14（前端常量与命名 → 转李焰彬）
```

D17 要跟评估集一起验这点我完全同意，而且**顺序上必须排在 D13 之后**：五块改动会影响候选与建议的输入（`methodNotes`），没有 v3 链路就没法验证改动是否真的让模型多产出那一块。

