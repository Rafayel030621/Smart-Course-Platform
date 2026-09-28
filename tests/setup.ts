import { afterEach } from 'vitest'

/**
 * Vitest 全局环境准备（只管环境，不含任何业务断言）
 * ----------------------------------------------------------------------------
 * 1. localStorage：由 jsdom 提供，测试里直接用 `localStorage` 即可。
 *    这里在每个用例之后清空它——store 将来落 localStorage 时，用例之间不会互相污染。
 * 2. window.scrollTo：jsdom 没有实现，而 store 的 `showCreate()` / `createProject()`
 *    会调用它；不补空实现的话，jsdom 会打印 "Not implemented: window.scrollTo" 噪音。
 */

afterEach(() => {
  localStorage.clear()
})

// 用 defineProperty 而不是直接赋值：scrollTo 有重载签名，直接赋值类型不匹配
Object.defineProperty(window, 'scrollTo', {
  value: () => {},
  writable: true,
})
