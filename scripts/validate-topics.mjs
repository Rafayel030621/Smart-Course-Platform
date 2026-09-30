#!/usr/bin/env node
/**
 * 题目与论文数据校验（owner：吴佳璐）
 * ----------------------------------------------------------------------------
 * 校验 `src/data/topics.ts` 的 9 套题目模板。这些数据会在「创建项目」时被实例化成
 * 里程碑、任务（steps → tasks）、启动疑问、开场说明与论文检索方向，
 * 所以任何结构缺失或超长都会变成「学生创建出来的项目不完整」。
 *
 * 用法：
 *   node scripts/validate-topics.mjs              # 报告 + 退出码
 *   node scripts/validate-topics.mjs --quiet      # 只打印问题
 *   node scripts/validate-topics.mjs --strict     # 警告也算失败
 *   node scripts/validate-topics.mjs --check-links  # 额外访问 DOI 链接（需要联网）
 *   node scripts/validate-topics.mjs --file=<路径>  # 校验另一份数据文件（自检用）
 *
 * 与 `tests/content/topics.test.ts` 的分工：
 *   - 测试跑在 vitest 里，覆盖面更细，但需要先 `npm install`；
 *   - 本脚本**零依赖**（不需要 node_modules），适合改完数据立刻自查，
 *     以及在没有开发环境的机器上跑。两边都改数据时都要过。
 *
 * 运行前提：Node ≥ 22.6（需要 TypeScript 类型擦除来直接读取 `.ts` 数据文件）。
 *   Node ≥ 22.18 开箱可用；22.6–22.17 会在检测到报错后**自动**带
 *   `--experimental-strip-types` 旗标重启一次，无需手动加参数。
 *
 * 上限取自 `docs/contracts.md` §2.2 / §4.1 与 `docs/ai/prompt-spec.md` §3.1。
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ 常量 */

const LIMITS = {
  projectName: 120,
  milestone: 60,
  taskTitle: 60,
  doneCriteria: 200,
  whyNow: 300,
  doubtText: 500,
}

const EXPECTED_TOPIC_COUNT = 9
const EXPECTED_MILESTONES = 5
const EXPECTED_STEPS = 3
const EXPECTED_PAPERS = 3

const MILESTONE_STATUSES = new Set(['done', 'cur', 'todo'])
/** 模板里的「建议负责人」只允许是占位名，不能是真实姓名（契约 §2.2 owner 恒为 null） */
const PLACEHOLDER_OWNER = /^成员[ABC]$/

/** 空话黑名单（`docs/ai/prompt-spec.md` §6.2） */
const EMPTY_TALK_BLACKLIST = [
  '检索该方向近年综述',
  '多查阅相关文献',
  '注意数据质量',
  '保证精度',
  '提高效率',
  '完善项目文档',
  '做好分工',
  '进行深入研究',
  '加强分析',
]

const HAS_LATIN_KEYWORDS = /[A-Za-z]{3,}/

/**
 * 每套题目应当出现的方法 / 工具 / 数据产品锚点（`docs/ai/prompt-spec.md` §6.3）。
 * 命中数少于 `MIN_ANCHOR_HITS` 会告警：题目内容正在退化成通用项目管理建议。
 */
const MIN_ANCHOR_HITS = 3
const DOMAIN_ANCHORS = {
  0: ['梯度', '直方图', '深度学习', '语义分割', 'SST', 'SSH', 'OISST', 'MODIS', '舟山', '东海', 'CPUE'],
  1: ['Global Fishing Watch', 'AIS', 'kW', '作业时长', 'GAM', 'SHAP', 'Kroodsma'],
  2: ['DINEOF', 'MODIS', 'VIIRS', 'L2', 'L3', '云掩膜', 'STL', 'EEMD', '小波', '缺测'],
  3: ['OpenFOAM', 'Fluent', 'SUBOFF', 'k-ε', 'k-ω', 'y+', '网格无关性', '边界层'],
  4: ['Argo', '中尺度涡', '主动学习', '数据立方体', '近似查询', 'AQP', 'DuckDB', 'ClickHouse', 'SciServer'],
  5: ['访谈', 'JSON', 'Schema', 'LLM', 'JSON mode', 'PBL', '脚手架'],
  6: ['UWSim', 'Gazebo', 'HoloOcean', 'Stonefish', '任务分配', '声呐', '融合', 'ROS'],
  7: ['Hobday', '百分位', '气候态', '共现', 'BGC-Argo', 'pH', '缺氧', '酸化'],
  8: ['百分位', 'GEV', 'POT', 'ERA5', '浮标', '有效波高', '第 95', '第 99'],
}

/* ------------------------------------------------------------------ 报告 */

const problems = []
const warnings = []

/** 记录一个使脚本失败的硬问题 */
function error(scope, message) {
  problems.push({ scope, message })
}

/** 记录一个不影响正确性、但值得看一眼的问题 */
function warn(scope, message) {
  warnings.push({ scope, message })
}

const isText = (value) => typeof value === 'string' && value.trim().length > 0

/**
 * 校验一个必填字符串字段：非空、无首尾空白、不超上限。
 * 返回 trim 后的值，便于后续做包含性检查。
 */
function checkText(scope, label, value, maxLength) {
  if (!isText(value)) {
    error(scope, `${label} 必须是去空白后非空的字符串（当前：${JSON.stringify(value)}）`)
    return ''
  }
  if (value !== value.trim()) {
    warn(scope, `${label} 首尾有多余空白`)
  }
  if (value.length > maxLength) {
    error(scope, `${label} 超过上限 ${maxLength} 字（当前 ${value.length} 字）`)
  } else if (value.length > maxLength * 0.9) {
    warn(scope, `${label} 已用掉 ${Math.round((value.length / maxLength) * 100)}% 的长度上限`)
  }
  return value
}

/* -------------------------------------------------------------- 读取数据 */

async function loadTopics() {
  const url =
    sourceFileArg === undefined || sourceFileArg === ''
      ? new URL('../src/data/topics.ts', import.meta.url)
      : pathToFileURL(resolve(process.cwd(), sourceFileArg))
  try {
    return await import(url.href)
  } catch (cause) {
    const message = cause && cause.message ? cause.message : String(cause)

    // Node 22.6–22.17 不认识 .ts 扩展名：自动带上旗标重启一次本脚本。
    // 重启后的进程 execArgv 里已含旗标，若仍失败就不会再递归。
    const alreadyFlagged = process.execArgv.some((arg) =>
      arg.includes('experimental-strip-types'),
    )
    if (!alreadyFlagged && /Unknown file extension|\.ts/i.test(message)) {
      const retry = spawnSync(
        process.execPath,
        ['--experimental-strip-types', ...process.argv.slice(1)],
        { stdio: 'inherit' },
      )
      process.exit(retry.status ?? 1)
    }

    console.error(`[ERROR] 无法读取 ${url.href}`)
    console.error(`        原因：${message}`)
    console.error('        本脚本用 Node 的类型擦除直接 import .ts 数据文件，需要 Node >= 22.6。')
    console.error('        Node 22.6–22.17 请这样运行：')
    console.error('          node --experimental-strip-types scripts/validate-topics.mjs')
    process.exit(2)
  }
}

/* ------------------------------------------------------------ 逐套校验 */

function validateTopic(index, topic, template) {
  const scope = `#${index + 1} ${topic}`

  if (typeof template !== 'object' || template === null) {
    error(scope, '模板缺失：TEMPLATES 里没有这道题的条目')
    return null
  }

  const stats = { milestones: 0, steps: 0, papers: 0, doubts: 0 }

  /* ---- 短名 ---- */
  checkText(scope, 'short', template.short, 20)

  /* ---- 里程碑 ---- */
  const milestones = Array.isArray(template.ms) ? template.ms : []
  stats.milestones = milestones.length
  if (milestones.length !== EXPECTED_MILESTONES) {
    error(scope, `里程碑应为 ${EXPECTED_MILESTONES} 个，实际 ${milestones.length} 个`)
  }

  const milestoneNames = []
  milestones.forEach((milestone, i) => {
    const where = `ms[${i}]`
    if (typeof milestone !== 'object' || milestone === null) {
      error(scope, `${where} 必须是对象`)
      return
    }
    const name = checkText(scope, `${where}.t`, milestone.t, LIMITS.milestone)
    milestoneNames.push(name)

    if (!MILESTONE_STATUSES.has(milestone.s)) {
      error(scope, `${where}.s 必须是 done / cur / todo 之一（当前：${JSON.stringify(milestone.s)}）`)
    }
    if (!Number.isInteger(milestone.p) || milestone.p < 0 || milestone.p > 100) {
      error(scope, `${where}.p 必须是 0–100 的整数（当前：${JSON.stringify(milestone.p)}）`)
    }
    checkText(scope, `${where}.sub`, milestone.sub, 20)
  })

  if (new Set(milestoneNames).size !== milestoneNames.length) {
    error(scope, '里程碑名称有重复')
  }

  // 模板代表「刚创建的项目」：必须恰好一个 cur，且它就是第一个
  const runningIndexes = milestones
    .map((milestone, i) => (milestone && milestone.s === 'cur' ? i : -1))
    .filter((i) => i >= 0)
  if (runningIndexes.length !== 1) {
    error(scope, `进行中（cur）的里程碑应恰好 1 个，实际 ${runningIndexes.length} 个`)
  } else if (runningIndexes[0] !== 0) {
    error(scope, '刚创建的项目里，进行中的里程碑必须是第 1 个')
  }

  /* ---- 启动疑问 ---- */
  const doubts = Array.isArray(template.doubts) ? template.doubts : []
  stats.doubts = doubts.length
  if (doubts.length === 0) {
    error(scope, '至少要有 1 条启动疑问')
  }
  doubts.forEach((doubt, i) => checkText(scope, `doubts[${i}]`, doubt, LIMITS.doubtText))

  /* ---- 开场说明 ---- */
  checkText(scope, 'banner', template.banner, 400)

  /* ---- 三步建议 ---- */
  const steps = Array.isArray(template.steps) ? template.steps : []
  stats.steps = steps.length
  if (steps.length !== EXPECTED_STEPS) {
    error(scope, `建议（steps）应为 ${EXPECTED_STEPS} 条，实际 ${steps.length} 条`)
  }

  const stepTitles = []
  steps.forEach((step, i) => {
    const where = `steps[${i}]`
    if (typeof step !== 'object' || step === null) {
      error(scope, `${where} 必须是对象`)
      return
    }
    stepTitles.push(checkText(scope, `${where}.t`, step.t, LIMITS.taskTitle))

    if (typeof step.owner !== 'string' || !PLACEHOLDER_OWNER.test(step.owner)) {
      error(
        scope,
        `${where}.owner 必须是「成员A/B/C」占位名（当前：${JSON.stringify(step.owner)}）——写真实姓名会污染 Task.owner`,
      )
    }

    const why = checkText(scope, `${where}.why`, step.why, LIMITS.whyNow)
    const done = checkText(scope, `${where}.done`, step.done, LIMITS.doneCriteria)

    for (const phrase of EMPTY_TALK_BLACKLIST) {
      if (why.includes(phrase) || done.includes(phrase)) {
        warn(scope, `${where} 出现空话黑名单句子：「${phrase}」`)
      }
    }
  })

  if (new Set(stepTitles).size !== stepTitles.length) {
    error(scope, '建议标题有重复')
  }

  /* ---- 论文检索方向 ---- */
  const papers = Array.isArray(template.papers) ? template.papers : []
  stats.papers = papers.length
  if (papers.length !== EXPECTED_PAPERS) {
    error(scope, `论文方向应为 ${EXPECTED_PAPERS} 条，实际 ${papers.length} 条`)
  }

  const paperTitles = []
  papers.forEach((paper, i) => {
    const where = `papers[${i}]`
    if (typeof paper !== 'object' || paper === null) {
      error(scope, `${where} 必须是对象`)
      return
    }
    paperTitles.push(checkText(scope, `${where}.title`, paper.title, 120))
    const meta = checkText(scope, `${where}.meta`, paper.meta, 120)
    checkText(scope, `${where}.why`, paper.why, 300)
    const prompt = checkText(scope, `${where}.prompt`, paper.prompt, 1000)

    if (!HAS_LATIN_KEYWORDS.test(prompt)) {
      warn(scope, `${where}.prompt 里没有英文检索关键词，检索召回可能变差`)
    }

    if (paper.link !== undefined) {
      if (typeof paper.link !== 'string' || !paper.link.startsWith('https://doi.org/')) {
        error(scope, `${where}.link 只能是 https 的 DOI 地址（当前：${JSON.stringify(paper.link)}）`)
      } else {
        try {
          new URL(paper.link)
        } catch {
          error(scope, `${where}.link 不是合法 URL：${paper.link}`)
        }
      }
      if (!meta.includes('已定位到具体论文')) {
        error(scope, `${where}.meta 填了 link，却没有标明「已定位到具体论文」`)
      }
    }
  })

  if (new Set(paperTitles).size !== paperTitles.length) {
    error(scope, '论文方向标题有重复')
  }

  /* ---- 领域具体性（软检查） ---- */
  const anchorPool = DOMAIN_ANCHORS[index] ?? []
  if (anchorPool.length > 0) {
    const haystack = JSON.stringify(template)
    const hits = anchorPool.filter((anchor) => haystack.includes(anchor))
    if (hits.length < MIN_ANCHOR_HITS) {
      warn(
        scope,
        `领域锚点只命中 ${hits.length} 个（要求 >= ${MIN_ANCHOR_HITS}）：${hits.join(' / ') || '一个都没有'}`,
      )
    }
    stats.anchorHits = hits.length
  }

  return { stats, milestoneNames }
}

/* ------------------------------------------------------------ 跨套校验 */

/** 同一段内容在多套题目里重复出现，通常意味着复制粘贴时忘了改 */
function checkCrossTopicDuplicates(templateList) {
  const seen = new Map()
  const record = (kind, text, scope) => {
    const key = `${kind}\u0000${text}`
    const previous = seen.get(key)
    if (previous !== undefined) {
      warn(scope, `${kind}与其他题目重复：「${text.slice(0, 24)}…」（另见 ${previous}）`)
      return
    }
    seen.set(key, scope)
  }

  for (const { scope, template } of templateList) {
    if (typeof template !== 'object' || template === null) continue
    if (isText(template.banner)) record('banner', template.banner, scope)
    for (const doubt of Array.isArray(template.doubts) ? template.doubts : []) {
      if (isText(doubt)) record('启动疑问', doubt, scope)
    }
    for (const paper of Array.isArray(template.papers) ? template.papers : []) {
      if (typeof paper === 'object' && paper !== null && isText(paper.link)) {
        record('DOI 链接', paper.link, scope)
      }
    }
  }
}

/* ------------------------------------------------------- DOI 链接（可选） */

async function checkDoiLinks(templateList) {
  const links = []
  for (const { scope, template } of templateList) {
    if (typeof template !== 'object' || template === null) continue
    for (const paper of Array.isArray(template.papers) ? template.papers : []) {
      if (typeof paper === 'object' && paper !== null && isText(paper.link)) {
        links.push({ scope, link: paper.link })
      }
    }
  }
  if (links.length === 0) {
    console.log('  （没有填写 DOI 链接，跳过）')
    return
  }

  for (const { scope, link } of links) {
    try {
      const response = await fetch(link, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      })
      if (response.ok) {
        console.log(`  [OK]   ${link}  (${response.status})`)
      } else {
        warn(scope, `DOI 链接返回 ${response.status}：${link}`)
      }
    } catch (cause) {
      // 网络不通是常态（离线开发），所以只告警不失败
      warn(scope, `DOI 链接无法访问：${link}（${cause && cause.name ? cause.name : 'Error'}）`)
    }
  }
}

/* -------------------------------------------------------------- 主流程 */

const argv = new Set(process.argv.slice(2))
const QUIET = argv.has('--quiet')
const STRICT = argv.has('--strict')
const CHECK_LINKS = argv.has('--check-links')
/** `--file=<路径>`：校验另一份数据文件，用于自检脚本本身的错误分支 */
const sourceFileArg = process.argv
  .slice(2)
  .find((item) => item.startsWith('--file='))
  ?.slice('--file='.length)

const { TOPICS, TEMPLATES } = await loadTopics()

if (!Array.isArray(TOPICS)) {
  error('topics.ts', '缺少导出的 TOPICS 数组')
} else {
  if (TOPICS.length !== EXPECTED_TOPIC_COUNT) {
    error('topics.ts', `题目应为 ${EXPECTED_TOPIC_COUNT} 套，实际 ${TOPICS.length} 套`)
  }
  TOPICS.forEach((topic, i) => {
    if (!isText(topic)) {
      error('topics.ts', `TOPICS[${i}] 必须是非空字符串`)
      return
    }
    if (topic !== topic.trim()) warn('topics.ts', `TOPICS[${i}] 首尾有多余空白`)
    if (topic.length > LIMITS.projectName) {
      error('topics.ts', `TOPICS[${i}] 超过项目名上限 ${LIMITS.projectName} 字`)
    }
  })
  if (new Set(TOPICS).size !== TOPICS.length) {
    error('topics.ts', '题目名称有重复')
  }
}

const topics = Array.isArray(TOPICS) ? TOPICS : []
if (typeof TEMPLATES !== 'object' || TEMPLATES === null) {
  error('topics.ts', '缺少导出的 TEMPLATES 对象')
}

const templateKeys = typeof TEMPLATES === 'object' && TEMPLATES !== null ? Object.keys(TEMPLATES) : []
const missing = topics.filter((topic) => !templateKeys.includes(topic))
const extra = templateKeys.filter((key) => !topics.includes(key))
if (missing.length > 0) error('topics.ts', `以下题目没有对应模板：${missing.join('、')}`)
if (extra.length > 0) error('topics.ts', `以下模板不在 TOPICS 里：${extra.join('、')}`)
if (topics.length > 0 && templateKeys.join('\u0000') !== topics.join('\u0000')) {
  warn('topics.ts', 'TEMPLATES 的键顺序与 TOPICS 不一致')
}

/* 逐套校验 */
const templateList = topics.map((topic, index) => ({
  scope: `#${index + 1} ${topic}`,
  template: typeof TEMPLATES === 'object' && TEMPLATES !== null ? TEMPLATES[topic] : undefined,
  index,
}))

const perTopicStats = []
for (const { scope, template, index } of templateList) {
  const result = validateTopic(index, topics[index] ?? '', template)
  if (result !== null) perTopicStats.push({ scope, ...result.stats })
}

checkCrossTopicDuplicates(templateList)

/* -------------------------------------------------------------- 打印 */

if (!QUIET) {
  console.log('题目与论文数据校验（src/data/topics.ts）')
  console.log('='.repeat(72))
  console.log(`题目数量：${topics.length}`)
  console.log(`模板数量：${templateKeys.length}`)
  console.log('')
  console.log('逐套概览：')
  for (const item of perTopicStats) {
    const parts = [
      `里程碑 ${item.milestones}`,
      `建议 ${item.steps}`,
      `疑问 ${item.doubts}`,
      `论文 ${item.papers}`,
    ]
    if (typeof item.anchorHits === 'number') parts.push(`领域锚点 ${item.anchorHits}`)
    console.log(`  ${item.scope}`)
    console.log(`      ${parts.join(' · ')}`)
  }
  console.log('')
}

if (CHECK_LINKS) {
  console.log('DOI 链接可达性（--check-links）：')
  await checkDoiLinks(templateList)
  console.log('')
}

if (problems.length > 0) {
  console.log(`[ERROR] ${problems.length} 处：`)
  for (const item of problems) {
    console.log(`  ${item.scope}`)
    console.log(`      ${item.message}`)
  }
  console.log('')
}

if (warnings.length > 0) {
  const label = STRICT ? '[WARN→ERROR]' : '[WARN]'
  console.log(`${label} ${warnings.length} 处：`)
  for (const item of warnings) {
    console.log(`  ${item.scope}`)
    console.log(`      ${item.message}`)
  }
  console.log('')
}

const failed = problems.length > 0 || (STRICT && warnings.length > 0)
if (failed) {
  console.log(`结果：失败（${problems.length} 个错误${STRICT ? `，${warnings.length} 个警告按错误计` : `，${warnings.length} 个警告`}）`)
  process.exit(1)
}

console.log(`结果：通过（0 个错误，${warnings.length} 个警告）`)
