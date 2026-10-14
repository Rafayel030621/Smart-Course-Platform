import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // node_modules_legacy_vue2 是早前 Vue2 版本留下的依赖目录：它已被 .gitignore 忽略，
    // 但 flat config 不读 .gitignore，且名称不等于 `node_modules`，所以必须显式排除，
    // 否则 `npx eslint .` 会把整目录当源码扫（本机上曾产生 6 万+ 条无关报错）。
    ignores: [
      'dist/**',
      'node_modules/**',
      'node_modules_legacy_vue2/**',
      'src/content/**',
      'public/**',
      '.codex/**',
    ],
  },
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
)
