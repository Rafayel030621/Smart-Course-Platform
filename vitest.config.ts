import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

/**
 * Vitest 配置（前端单测环境）
 * ----------------------------------------------------------------------------
 * 直接复用 vite.config.ts：插件（@vitejs/plugin-vue）与 `@` → `src` 的别名
 * 都来自那里，避免两处各写一份、以后改一处忘一处。
 *
 * 环境选择：
 *   - `environment: 'jsdom'` —— 需要 DOM 与 localStorage（Pinia store 与组件测试都要）。
 *     jsdom 自带 localStorage 实现，无需额外 polyfill；`window.scrollTo` 由
 *     tests/setup.ts 补空实现。
 *   - `globals: true` —— 用例里可以直接写 describe / it / expect，不必逐个 import；
 *     相应类型已加进 tsconfig 的 `types`（vitest/globals），所以 `npm run typecheck`
 *     也会检查测试文件。
 *
 * 只收集 `tests/**` 下的用例：仓库里还有后端自己的测试（`server/test/**`，用的是
 * Node 内置 node:test），不能混进来，所以在 exclude 里显式排除。
 *
 * 测试文件由李焰彬按 tests/domain、tests/stores、tests/services 分目录编写；
 * 本文件只负责环境，不包含任何业务断言。
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.{test,spec}.ts'],
      exclude: ['node_modules', 'dist', 'server', 'legacy-v0', 'legacy-v1'],
      // 每个用例之间还原 vi.spyOn / vi.fn 的替身，避免互相影响
      restoreMocks: true,
    },
  }),
)
