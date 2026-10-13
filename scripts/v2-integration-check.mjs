/**
 * v2（M1 + M2-A）本地联调检查
 * ----------------------------------------------------------------------------
 * 对着**真实 HTTP** 走一遍契约第 13–17 节的关键路径与反例，用来回答两个问题：
 *   1. 前端发出去的请求体能不能被后端接受（否则只会得到 400）；
 *   2. 后端返回的结构是不是契约描述的线格式（前端适配层能不能解析）。
 *
 * 用法（先起 mock provider，不需要任何密钥）：
 *
 *   cd server
 *   set ADVISOR_PROVIDER=mock
 *   set PORT=8123
 *   npm run build && node dist/src/index.js
 *
 *   node scripts/v2-integration-check.mjs http://127.0.0.1:8123
 *
 * 只用 Node 内置能力（fetch / TextDecoder），不装额外依赖，也不打印任何密钥。
 * 退出码：0 = 全部通过；1 = 有失败项（逐条打印原因）。
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8123').replace(/\/+$/, '')

const PROJECT_ID = 'prj_3f7a91d24c8b4e0a9d5f1b7c2e6a8031'
const MATERIAL_ID = 'mat_9b1e7c2f'
const REVISION = 12

let passed = 0
let failed = 0

function ok(label, detail = '') {
  passed += 1
  console.log(`  ✔ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
}

function bad(label, detail) {
  failed += 1
  console.log(`  ✖ ${label} —— ${detail}`)
}

function check(label, condition, detail = '') {
  if (condition) ok(label, detail)
  else bad(label, detail)
}

async function call(path, { method = 'POST', body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, text, json, headers: response.headers }
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function identity(extra = {}) {
  return {
    contractVersion: '1.0',
    requestId: `req-${Math.random().toString(36).slice(2, 12)}`,
    projectId: PROJECT_ID,
    projectRevision: REVISION,
    ...extra,
  }
}

/* ------------------------------------------------------------- 样例数据 */

const MD_UTF8 = [
  '# 实验手册',
  '',
  '本实验使用 ERA5 海浪场数据，任务是复现极端风浪事件的识别流程。',
  '',
  '## 数据说明',
  '主要字段：有效波高、风速、时间、经纬度；单次样例约 20 万行。',
].join('\n')

const SEGMENTS = [
  { segmentId: 'seg_0', startLine: 1, endLine: 3, text: '# 实验手册\n本实验使用 ERA5 海浪场数据。' },
  { segmentId: 'seg_1', startLine: 5, endLine: 6, text: '## 数据说明\n主要字段：有效波高、风速。' },
]

const CONFIRMED_MATERIALS = [
  {
    materialId: MATERIAL_ID,
    name: '实验手册.md',
    type: 'md',
    version: 1,
    segments: SEGMENTS.map((segment) => ({ ...segment })),
  },
]

const PROJECT_PROFILE = {
  goal: '构建极端风浪事件识别与预警的原型系统',
  expectedOutcome: '可交互原型 + 4 页会议论文',
  memberNames: ['张同学', '李同学'],
  researchPeriod: '第 3 周至第 14 周',
  scope: '先做西北太平洋',
  outOfScope: '不做移动端',
}

const LEAK_MARKER = 'DRAFT_SHOULD_NOT_LEAK_7f3a'

/* ---------------------------------------------------------------- 用例 */

async function main() {
  console.log(`\n== v2 本地联调：${BASE} ==\n`)

  console.log('[0] 健康检查')
  {
    const health = await call('/health', { method: 'GET' })
    check('GET /health 返回 200', health.status === 200, `status=${health.status}`)
    check('契约版本为 1.0', health.json?.contractVersion === '1.0')
    check('不返回任何项目数据', !JSON.stringify(health.json ?? {}).includes('prj_'))
  }

  console.log('\n[1] POST /api/materials（契约 15.1）')
  {
    const response = await call('/api/materials', {
      body: identity({
        materialId: MATERIAL_ID,
        version: 1,
        name: '实验手册.md',
        contentBase64: base64(Buffer.from(MD_UTF8, 'utf-8')),
      }),
    })
    const material = response.json?.material
    const segments = Array.isArray(response.json?.segments) ? response.json.segments : []
    check('UTF-8 md 返回 200', response.status === 200, `status=${response.status}`)
    check(
      '回显 projectId / projectRevision',
      response.json?.projectId === PROJECT_ID && response.json?.projectRevision === REVISION,
    )
    check(
      'material 是契约 14.1 形状',
      material?.state === 'parsed' && material?.type === 'md' && material?.encoding === 'utf-8',
    )
    check('segmentCount 与 segments 一致', response.json?.segmentCount === segments.length)
    check(
      '分段带 segmentId / index / startLine / endLine / text',
      segments.length > 0 &&
        segments.every(
          (segment) =>
            typeof segment.segmentId === 'string' &&
            Number.isInteger(segment.index) &&
            Number.isInteger(segment.startLine) &&
            Number.isInteger(segment.endLine) &&
            typeof segment.text === 'string',
        ),
    )
    check('materialId 由前端生成、服务端原样回显', material?.materialId === MATERIAL_ID)
    check('响应不含密钥或服务器路径', !/MODEL_API_KEY|sk-|Authorization|[A-Za-z]:\\\\/i.test(response.text))
  }

  console.log('\n[2] 编码回退（GBK）')
  {
    const gbkBytes = Uint8Array.from([0xd6, 0xd0, 0x0a, 0xd6, 0xd0])
    const decoded = new TextDecoder('gbk').decode(gbkBytes).replace(/\s/g, '')
    check('Node 测试字节按 GBK 解码为「中中」', decoded === '中中', `decoded=${JSON.stringify(decoded)}`)

    const response = await call('/api/materials', {
      body: identity({
        materialId: 'mat_gbk0001',
        version: 1,
        name: 'gbk说明.txt',
        contentBase64: base64(gbkBytes),
      }),
    })
    check('GBK 文件被接受（200）', response.status === 200, `status=${response.status}`)
    check(
      'encoding 回显 gbk',
      response.json?.material?.encoding === 'gbk',
      `encoding=${response.json?.material?.encoding}`,
    )
  }

  console.log('\n[3] 反例：类型 / 体积 / 空文件 / 契约版本（契约 15.1 + 16）')
  {
    const csv = await call('/api/materials', {
      body: identity({
        materialId: 'mat_csv0001',
        version: 1,
        name: '数据.csv',
        contentBase64: base64(Buffer.from('a,b\n1,2', 'utf-8')),
      }),
    })
    check(
      'csv 返回 400 UNSUPPORTED_MATERIAL_TYPE',
      csv.status === 400 && csv.json?.code === 'UNSUPPORTED_MATERIAL_TYPE',
      `status=${csv.status} code=${csv.json?.code}`,
    )
    check(
      '中文提示说明后续计划',
      typeof csv.json?.message === 'string' && csv.json.message.includes('md、txt'),
      csv.json?.message,
    )

    const big = await call('/api/materials', {
      body: identity({
        materialId: 'mat_big0001',
        version: 1,
        name: '大文件.md',
        contentBase64: base64(Buffer.alloc(1_100_000, 0x61)),
      }),
    })
    check(
      '超过 1 MB 返回 MATERIAL_TOO_LARGE',
      big.status === 400 && big.json?.code === 'MATERIAL_TOO_LARGE',
      `status=${big.status} code=${big.json?.code}`,
    )

    const empty = await call('/api/materials', {
      body: identity({
        materialId: 'mat_empty001',
        version: 1,
        name: '空.md',
        contentBase64: base64(Buffer.alloc(0)),
      }),
    })
    check(
      '空文件返回 EMPTY_MATERIAL',
      empty.status === 400 && empty.json?.code === 'EMPTY_MATERIAL',
      `status=${empty.status} code=${empty.json?.code}`,
    )

    const wrongVersion = await call('/api/materials', {
      body: {
        ...identity({
          materialId: 'mat_ver00001',
          version: 1,
          name: 'x.md',
          contentBase64: base64(Buffer.from('x')),
        }),
        contractVersion: '2.0',
      },
    })
    check(
      'contractVersion 不支持返回 400 INVALID_INPUT',
      wrongVersion.status === 400 && wrongVersion.json?.code === 'INVALID_INPUT',
    )
  }

  console.log('\n[4] POST /api/materials/understanding（契约 15.2）')
  {
    const response = await call('/api/materials/understanding', {
      body: identity({
        promptVersion: 'material-understanding-v1',
        projectName: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
        material: {
          materialId: MATERIAL_ID,
          name: '实验手册.md',
          type: 'md',
          version: 1,
          segments: SEGMENTS.map((segment) => ({ ...segment })),
        },
      }),
    })
    const draft = response.json?.draft ?? {}
    const kinds = ['goalCandidates', 'outcomeCandidates', 'dataNotes', 'methodNotes', 'openQuestions']
    check('返回 200', response.status === 200, `status=${response.status}`)
    check(
      'source 是 model 或 fallback',
      response.json?.source === 'model' || response.json?.source === 'fallback',
      `source=${response.json?.source}`,
    )
    check('五块草稿齐全', kinds.every((kind) => Array.isArray(draft[kind])))
    const sources = kinds.flatMap((kind) => draft[kind] ?? []).flatMap((item) => item.sources ?? [])
    check(
      '来源由服务端回填材料名与行号',
      sources.length === 0 ||
        sources.every(
          (source) =>
            typeof source.materialName === 'string' &&
            Number.isInteger(source.startLine) &&
            Number.isInteger(source.endLine) &&
            typeof source.segmentId === 'string',
        ),
    )
    check(
      'fallback 时带中文 notice',
      response.json?.source !== 'fallback' ||
        (typeof response.json?.notice === 'string' && response.json.notice.length > 0),
    )

    const dup = await call('/api/materials/understanding', {
      body: identity({
        promptVersion: 'material-understanding-v1',
        projectName: '项目名',
        material: {
          materialId: MATERIAL_ID,
          name: '实验手册.md',
          type: 'md',
          version: 1,
          segments: [{ ...SEGMENTS[0] }, { ...SEGMENTS[0] }],
        },
      }),
    })
    check(
      '重复 segmentId 返回 400 INVALID_INPUT',
      dup.status === 400 && dup.json?.code === 'INVALID_INPUT',
      `status=${dup.status} code=${dup.json?.code}`,
    )

    const badType = await call('/api/materials/understanding', {
      body: identity({
        promptVersion: 'material-understanding-v1',
        projectName: null,
        material: {
          materialId: MATERIAL_ID,
          name: '实验手册.md',
          type: 'txt',
          version: 1,
          segments: [{ ...SEGMENTS[0] }],
        },
      }),
    })
    check(
      'type 与扩展名不一致返回 400 INVALID_INPUT',
      badType.status === 400 && badType.json?.code === 'INVALID_INPUT',
    )
  }

  console.log('\n[5] POST /api/advisor/recommendations（契约 4.1 / 17.4）')
  const advisorBase = {
    projectName: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
    currentMilestone: '选题确认与文献调研',
    confirmedContext: ['项目目标：识别极端风浪事件'],
    tasks: [],
    evidence: [],
    doubts: [],
    forceRefresh: true,
  }
  {
    const v1 = await call('/api/advisor/recommendations', {
      body: identity({ ...advisorBase, promptVersion: 'mvp-prompt-v1' }),
    })
    check('v1 请求（无 v2 字段）返回 200', v1.status === 200, `status=${v1.status} code=${v1.json?.code}`)
    check('v1 响应含 suggestions', Array.isArray(v1.json?.suggestions), `source=${v1.json?.source}`)

    const wrongGate = await call('/api/advisor/recommendations', {
      body: identity({ ...advisorBase, promptVersion: 'mvp-prompt-v1', projectProfile: PROJECT_PROFILE }),
    })
    check(
      '带 projectProfile 却用 v1 → 400 INVALID_INPUT',
      wrongGate.status === 400 && wrongGate.json?.code === 'INVALID_INPUT',
      `status=${wrongGate.status} code=${wrongGate.json?.code}`,
    )

    const v2 = await call('/api/advisor/recommendations', {
      body: identity({
        ...advisorBase,
        promptVersion: 'mvp-prompt-v2',
        projectProfile: PROJECT_PROFILE,
        confirmedMaterials: CONFIRMED_MATERIALS,
      }),
    })
    check('v2 请求（基本信息 + 已确认材料）返回 200', v2.status === 200, `status=${v2.status} code=${v2.json?.code}`)
    check(
      'v2 响应的 source 是 model 或 fallback',
      v2.json?.source === 'model' || v2.json?.source === 'fallback',
      `source=${v2.json?.source}`,
    )

    const badVersion = await call('/api/advisor/recommendations', {
      body: identity({ ...advisorBase, promptVersion: 'advisor-chat-v2' }),
    })
    check(
      '接口与取值不匹配 → 400 INVALID_INPUT',
      badVersion.status === 400 && badVersion.json?.code === 'INVALID_INPUT',
    )
  }

  console.log('\n[6] POST /api/advisor/chat（契约 6.4 / 17.4）')
  {
    const chatBase = {
      projectName: '面向海洋环境安全保障的极端风和浪事件的智能分析系统',
      currentMilestone: '选题确认与文献调研',
      tasks: [],
      evidence: [],
      doubts: [],
      chatHistory: [
        { role: 'user', text: '上一轮问题' },
        { role: 'assistant', text: '上一轮回答' },
      ],
    }

    const v1 = await call('/api/advisor/chat', {
      body: identity({ ...chatBase, promptVersion: 'advisor-chat-v1', question: '我下一步做什么？' }),
    })
    check(
      'chat v1 返回 200 且有非空 answer',
      v1.status === 200 && typeof v1.json?.answer === 'string' && v1.json.answer.trim() !== '',
      `status=${v1.status} source=${v1.json?.source}`,
    )

    const v1WithMaterials = await call('/api/advisor/chat', {
      body: identity({
        ...chatBase,
        promptVersion: 'advisor-chat-v1',
        question: '材料里写了什么？',
        confirmedMaterials: CONFIRMED_MATERIALS,
      }),
    })
    check(
      'chat v1 + 材料 → 400 INVALID_INPUT（版本门禁）',
      v1WithMaterials.status === 400 && v1WithMaterials.json?.code === 'INVALID_INPUT',
      `status=${v1WithMaterials.status} code=${v1WithMaterials.json?.code}`,
    )

    const v2 = await call('/api/advisor/chat', {
      body: identity({
        ...chatBase,
        promptVersion: 'advisor-chat-v2',
        question: '这份材料说明了什么？',
        projectProfile: PROJECT_PROFILE,
        confirmedMaterials: CONFIRMED_MATERIALS,
      }),
    })
    check('chat v2（基本信息 + 已确认材料）返回 200', v2.status === 200, `status=${v2.status} code=${v2.json?.code}`)
    check(
      'chat v2 回答非空',
      typeof v2.json?.answer === 'string' && v2.json.answer.trim() !== '',
      `source=${v2.json?.source}`,
    )
    check(
      '回答不回显内部字段名',
      !/confirmedMaterials|projectProfile|promptVersion|materialId/.test(v2.json?.answer ?? ''),
    )

    const leak = await call('/api/advisor/chat', {
      body: identity({
        ...chatBase,
        promptVersion: 'advisor-chat-v2',
        question: '未确认草稿会不会被看到？',
        understandingBlocks: [{ id: 'ublk_1', kind: 'goalCandidates', content: LEAK_MARKER, status: 'pending' }],
        pendingUnderstandingBlocks: [{ content: LEAK_MARKER }],
      }),
    })
    check('未确认草稿作为未知字段被忽略（仍 200）', leak.status === 200, `status=${leak.status}`)
    check('未确认草稿内容不出现在回答里', !leak.text.includes(LEAK_MARKER))
  }

  console.log('\n[7] 方法与跨域（契约 15.0 / 7.4）')
  {
    const wrongMethod = await call('/api/materials', { method: 'GET' })
    check('GET /api/materials 返回 405', wrongMethod.status === 405, `status=${wrongMethod.status}`)
    check(
      '405 带 Allow: POST',
      String(wrongMethod.headers.get('allow') ?? '').includes('POST'),
      `allow=${wrongMethod.headers.get('allow')}`,
    )

    const allowed = await fetch(`${BASE}/api/materials`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    })
    check('白名单来源预检返回 204', allowed.status === 204, `status=${allowed.status}`)
    check(
      '白名单来源带 CORS 头',
      allowed.headers.get('access-control-allow-origin') === 'http://localhost:5173',
      `origin=${allowed.headers.get('access-control-allow-origin')}`,
    )

    const blocked = await fetch(`${BASE}/api/materials`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    })
    check('非白名单来源预检返回 403', blocked.status === 403, `status=${blocked.status}`)
    check(
      '非白名单来源不返回通配符 CORS',
      blocked.headers.get('access-control-allow-origin') !== '*',
      `origin=${blocked.headers.get('access-control-allow-origin')}`,
    )
  }

  console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==\n`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('\n联调脚本自身出错（后端可能没起或地址不对）：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
