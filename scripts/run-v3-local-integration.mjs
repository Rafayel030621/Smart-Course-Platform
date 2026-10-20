#!/usr/bin/env node
/**
 * 本地 V3 后端集成测试入口（opt-in）
 * ----------------------------------------------------------------------------
 * 为什么需要这一层：
 *   - 直接跑 vitest 时，配置缺失的用例会「跳过」并以 0 退出，容易被误读成通过；
 *   - 这里先做环境变量预检，缺失时打印可操作的提示并以非 0 退出。
 *
 * 只打印变量名与示例主机，不打印任何变量值（邀请码 / 密码不会出现在终端）。
 */
import { spawn } from 'node:child_process'

const base = (process.env.V3_LOCAL_API_BASE_URL ?? '').trim()
const invite = (process.env.V3_LOCAL_INVITE_CODE ?? '').trim()

const missing = []
if (base === '') missing.push('V3_LOCAL_API_BASE_URL')
if (invite === '') missing.push('V3_LOCAL_INVITE_CODE')

if (missing.length > 0) {
  console.error(`[v3-local-it] 未运行：缺少环境变量 ${missing.join('、')}`)
  console.error('  PowerShell 示例：')
  console.error("    $env:V3_LOCAL_API_BASE_URL='http://127.0.0.1:8099'")
  console.error("    $env:V3_LOCAL_INVITE_CODE='<本地后端邀请码>'")
  console.error('    npm run test:integration:v3-local')
  console.error('  说明见 docs/integration-v3-local.md')
  process.exit(1)
}

const child = spawn(
  process.execPath,
  ['./node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts'],
  { stdio: 'inherit', env: process.env },
)

child.on('close', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
