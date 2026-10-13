import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 单元测试配置
 * ----------------------------------------------------------------------------
 * 只跑纯逻辑与 store / 适配层：不启动浏览器，也不访问真实后端。
 *
 * `tests/setup.ts` 提供最小浏览器桩（`window.localStorage` / `window.setTimeout` /
 * `window.scrollTo`），因为 `src/stores/**` 会用到它们；HTTP 请求一律通过
 * `fetchImpl` 注入假实现，断言的是"发出去的请求体"与"响应处理"，不是网络。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // setupFiles 里的钩子（beforeEach）需要全局 API 才能使用
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
  },
})
