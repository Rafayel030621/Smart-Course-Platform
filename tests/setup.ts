/**
 * 测试环境的浏览器桩
 * ----------------------------------------------------------------------------
 * `src/stores/**` 会用到 `window.localStorage` / `window.setTimeout` / `window.scrollTo`，
 * 但本轮的测试全部是状态层的纯逻辑测试，不需要真实 DOM 与 jsdom：
 * 这里用最小的内存实现替身即可，读取路径与浏览器一致（`persistence.ts` 只调用
 * `getItem` / `setItem` / `removeItem`）。
 */

const store = new Map<string, string>()

const memoryStorage: Storage = {
  get length(): number {
    return store.size
  },
  clear(): void {
    store.clear()
  },
  getItem(key: string): string | null {
    return store.has(key) ? (store.get(key) as string) : null
  },
  key(index: number): string | null {
    return Array.from(store.keys())[index] ?? null
  },
  removeItem(key: string): void {
    store.delete(key)
  },
  setItem(key: string, value: string): void {
    store.set(key, String(value))
  },
}

const windowStub = {
  localStorage: memoryStorage,
  setTimeout: (handler: () => void, timeout?: number): number =>
    Number(setTimeout(handler, timeout)),
  clearTimeout: (handle?: number): void => {
    clearTimeout(handle as unknown as NodeJS.Timeout)
  },
  scrollTo: (): void => {
    /* 测试不关心滚动 */
  },
}

globalThis.window = windowStub as unknown as Window & typeof globalThis
globalThis.localStorage = memoryStorage

/** 每个用例之间清空本地存储，避免相互污染 */
beforeEach(() => {
  memoryStorage.clear()
})

export { memoryStorage }
