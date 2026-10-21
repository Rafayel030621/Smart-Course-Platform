import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

/**
 * 本地真实后端集成测试配置（opt-in）
 * ----------------------------------------------------------------------------
 * 与 vitest.config.ts 分开的原因：
 *   - 普通 `npm test` 只跑离线单测，绝不连接后端；
 *   - 这里只收集 `tests/integration/**\/*.integration.test.ts`，由
 *     `npm run test:integration:v3-local` 显式触发。
 *
 * 刻意**不读取也不设置** `VITE_API_BASE_URL`：后端地址只来自
 * `V3_LOCAL_API_BASE_URL`，且必须是 loopback（localhost / 127.0.0.1 / ::1）。
 *
 * 用例依赖 Pinia 与 localStorage，所以仍使用 jsdom 环境。
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/integration/**/*.integration.test.ts'],
      exclude: ['node_modules', 'dist', 'server', 'legacy-v0', 'legacy-v1'],
      restoreMocks: true,
      // 真实 HTTP 往返比单测慢；单个用例内部再按需放宽
      testTimeout: 60_000,
      hookTimeout: 60_000,
      // 集成用例会写同一个本地后端，串行执行避免相互干扰
      fileParallelism: false,
    },
  }),
)
