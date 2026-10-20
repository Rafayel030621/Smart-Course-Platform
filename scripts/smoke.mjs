#!/usr/bin/env node
import { randomUUID } from 'node:crypto'

/**
 * 端到端冒烟脚本（V3）
 * ----------------------------------------------------------------------------
 * 目的：用一条命令证明“服务真的能跑通一条完整业务链路”，不依赖测试框架。
 * 覆盖：健康检查 → 注册 → 登录态 → 建项目 → 建阶段 → 建任务 → 提交证据
 *       → 记录进展 → 上传材料 → 读材料列表 → 读理解草稿。
 *
 * 用法（先起服务）：
 *   set INVITE_CODE=dev-invite-2026
 *   set SCP_COOKIE_SECURE=0
 *   npm.cmd --prefix server run dev
 *
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --base http://127.0.0.1:8080 --invite dev-invite-2026
 *
 * 说明：
 * - 只依赖 Node 内置 fetch（Node 18+），不引入任何包；
 * - 每次运行创建独立账号与项目；**建议指向本地或临时数据库，不要对生产库执行**；
 * - 任一步失败即退出码 1，并打印该步 HTTP 状态与响应体前 600 字符，便于定位。
 */

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const BASE = (argOf('base', process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080')).replace(/\/+$/, '')
const ORIGIN = argOf('origin', process.env.SMOKE_ORIGIN ?? 'http://localhost:5173')
const INVITE = argOf('invite', process.env.INVITE_CODE ?? 'dev-invite-2026')
const PASSWORD = argOf('password', process.env.SMOKE_PASSWORD ?? 'correct-horse-battery-staple')

let session = null
const results = []

function newId() {
  return randomUUID()
}

function envelope(projectId, projectRevision, extra = {}) {
  return {
    contractVersion: '3.0',
    requestId: newId(),
    idempotencyKey: `smoke-${newId()}`,
    projectId,
    projectRevision,
    ...extra,
  }
}

async function call(path, options = {}) {
  const { method = 'GET', body, auth = true } = options
  const headers = { Origin: ORIGIN }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth && session !== null) headers.Cookie = `scp_session=${session}`

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const setCookie = response.headers.get('set-cookie')
  if (setCookie !== null) {
    const match = /scp_session=([^;]+)/.exec(setCookie)
    if (match !== null) session = match[1]
  }

  const text = await response.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    const took = Date.now() - started
    results.push({ name, ok: true, detail, took })
    console.log(`  ✓ ${name} (${took}ms)${detail === undefined ? '' : ` — ${detail}`}`)
  } catch (error) {
    const took = Date.now() - started
    results.push({ name, ok: false, detail: error.message, took })
    console.log(`  ✗ ${name} (${took}ms)`)
    console.log(`    ${error.message}`)
    throw error
  }
}

function expect(condition, message, response) {
  if (condition) return
  const body = response === undefined ? '' : `\n    响应 ${response.status}: ${response.text.slice(0, 600)}`
  throw new Error(`${message}${body}`)
}

const account = `smoke_${Date.now().toString(36)}`
const state = {}

async function main() {
  console.log(`\n冒烟目标：${BASE}`)
  console.log(`Origin：${ORIGIN}｜邀请码：${INVITE.slice(0, 4)}***（长度 ${INVITE.length}）\n`)

  await step('健康检查 GET /health', async () => {
    const response = await call('/health', { auth: false })
    expect(response.status === 200, '健康检查未返回 200', response)
    return `status=${response.status}`
  })

  await step('注册 POST /api/auth/register', async () => {
    const response = await call('/api/auth/register', {
      method: 'POST',
      body: {
        contractVersion: '3.0',
        requestId: newId(),
        idempotencyKey: `register-${newId()}`,
        account,
        password: PASSWORD,
        displayName: '冒烟测试',
        inviteCode: INVITE,
      },
    })
    expect(response.status === 200, '注册失败（检查 INVITE_CODE 是否与服务端一致）', response)
    expect(response.json?.user?.userId !== undefined, '注册响应缺少 user.userId', response)
    state.userId = response.json.user.userId
    expect(session !== null, '注册响应没有下发 scp_session Cookie', response)
    return `userId=${state.userId} cookie=已获取`
  })

  await step('登录态 GET /api/auth/me', async () => {
    const response = await call('/api/auth/me')
    expect(response.status === 200, 'me 未返回 200', response)
    expect(response.json?.user?.account === account, 'me 返回的账号与注册账号不一致', response)
    return `account=${response.json.user.account}`
  })

  await step('建项目 POST /api/projects', async () => {
    const response = await call('/api/projects', {
      method: 'POST',
      body: {
        contractVersion: '3.0',
        requestId: newId(),
        idempotencyKey: `project-${newId()}`,
        name: '冒烟测试项目',
        short: '冒烟',
        profile: { goal: '验证云端链路可用', memberNames: ['冒烟测试'] },
      },
    })
    expect(response.status === 200, '建项目失败', response)
    state.projectId = response.json?.projectId
    state.projectRevision = response.json?.projectRevision
    expect(typeof state.projectId === 'string', '响应缺少 projectId', response)
    return `projectId=${state.projectId} revision=${state.projectRevision}`
  })

  await step('建阶段 POST /api/projects/{id}/milestones', async () => {
    const response = await call(`/api/projects/${state.projectId}/milestones`, {
      method: 'POST',
      body: envelope(state.projectId, state.projectRevision, {
        name: '冒烟阶段',
        goal: '验证阶段创建',
        doneCriteria: '冒烟脚本通过',
        dueAt: null,
      }),
    })
    expect(response.status === 200, '建阶段失败', response)
    state.milestoneId = response.json?.data?.milestone?.milestoneId
    state.projectRevision = response.json?.projectRevision
    return `milestoneId=${state.milestoneId} revision=${state.projectRevision}`
  })

  await step('建任务 POST /api/projects/{id}/tasks', async () => {
    const response = await call(`/api/projects/${state.projectId}/tasks`, {
      method: 'POST',
      body: envelope(state.projectId, state.projectRevision, {
        title: '冒烟任务',
        doneCriteria: '证据已提交',
        milestoneId: state.milestoneId,
      }),
    })
    expect(response.status === 200, '建任务失败', response)
    state.taskId = response.json?.data?.task?.taskId
    state.projectRevision = response.json?.projectRevision
    return `taskId=${state.taskId} revision=${state.projectRevision}`
  })

  await step('提交证据 POST .../evidence', async () => {
    const response = await call(`/api/projects/${state.projectId}/evidence`, {
      method: 'POST',
      body: envelope(state.projectId, state.projectRevision, {
        submissionId: `smoke-${newId()}`,
        taskId: state.taskId,
        milestoneId: state.milestoneId,
        didWhat: '冒烟脚本提交了一条证据',
        foundWhat: '链路可用',
        stillUnsure: '无',
        attachmentName: null,
      }),
    })
    expect(response.status === 200, '提交证据失败', response)
    state.evidenceId = response.json?.data?.evidence?.evidenceId
    state.projectRevision = response.json?.projectRevision
    return `evidenceId=${state.evidenceId} revision=${state.projectRevision}`
  })

  await step('记录进展 POST .../progress', async () => {
    const response = await call(`/api/projects/${state.projectId}/progress`, {
      method: 'POST',
      body: envelope(state.projectId, state.projectRevision, {
        summary: '冒烟脚本记录了一条进展',
        milestoneId: state.milestoneId,
        taskId: state.taskId,
        evidenceIds: [state.evidenceId],
      }),
    })
    expect(response.status === 200, '记录进展失败', response)
    state.projectRevision = response.json?.projectRevision
    return `revision=${state.projectRevision}`
  })

  await step('上传材料 POST .../materials', async () => {
    const content = '# 冒烟材料\n\n这是一段用于验证上传链路的文本。\n\n第二段：分段器会把相邻自然段合并到 2000 字以内，所以这里预期仍是 1 段。'
    const response = await call(`/api/projects/${state.projectId}/materials`, {
      method: 'POST',
      body: envelope(state.projectId, state.projectRevision, {
        name: 'smoke.md',
        contentBase64: Buffer.from(content, 'utf8').toString('base64'),
      }),
    })
    expect(response.status === 200, '上传材料失败', response)
    state.materialId = response.json?.data?.material?.materialId
    state.projectRevision = response.json?.projectRevision
    const segmentCount = response.json?.data?.segmentCount
    expect(segmentCount >= 1, '材料未产生任何片段', response)
    return `materialId=${state.materialId} segments=${segmentCount} revision=${state.projectRevision}`
  })

  await step('读材料列表 GET .../materials', async () => {
    const response = await call(`/api/projects/${state.projectId}/materials`)
    expect(response.status === 200, '读材料列表失败', response)
    const found = (response.json?.data?.materials ?? []).some(
      (item) => item.materialId === state.materialId,
    )
    expect(found, '材料列表里找不到刚上传的材料', response)
    return `count=${response.json.data.materials.length}`
  })

  await step('读理解草稿 GET .../understanding', async () => {
    const response = await call(
      `/api/projects/${state.projectId}/materials/${state.materialId}/understanding`,
    )
    expect(response.status === 200, '读理解草稿失败', response)
    const items = response.json?.data?.items ?? []
    return `items=${items.length}（新上传材料为 0 属预期，草稿由 V2 理解接口生成）`
  })

  const failed = results.filter((item) => !item.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 步通过\n`)
  if (failed.length > 0) process.exit(1)
}

main().catch(() => {
  console.log(`\n结果：${results.filter((item) => item.ok).length}/${results.length} 步通过，冒烟失败\n`)
  process.exitCode = 1
})
