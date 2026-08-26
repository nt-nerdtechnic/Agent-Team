import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// Renderer-only unit/component tests. Pure functions (lib/, data/) run in the
// default `node` environment; composable tests opt into happy-dom per-file via
// `// @vitest-environment happy-dom`. We mirror the renderer's build-time global
// (`__APP_BUILD__`) so importing modules that reference it doesn't throw.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@navide/plugin-contracts': resolve(__dirname, 'packages/plugin-contracts/src/index.ts'),
      '@navide/plugin-sdk': resolve(__dirname, 'packages/plugin-sdk/src/index.ts'),
      '@navide/plugin-ui-vue/shared/testing': resolve(__dirname, 'packages/plugin-ui-vue/src/shared/testing.ts'),
      '@navide/plugin-ui-vue/shared': resolve(__dirname, 'packages/plugin-ui-vue/src/shared/index.ts'),
      '@navide/plugin-ui-vue/foundation': resolve(__dirname, 'packages/plugin-ui-vue/src/foundation/index.ts'),
      '@navide/plugin-ui-vue': resolve(__dirname, 'packages/plugin-ui-vue/src/index.ts'),
      '@navide/git-feature/testing': resolve(__dirname, 'plugins/navide-git/src/git-feature/testing.ts'),
      '@navide/git-feature': resolve(__dirname, 'plugins/navide-git/src/git-feature/index.ts'),
      '@navide/shared/testing': resolve(__dirname, 'packages/plugin-ui-vue/src/shared/testing.ts'),
      '@navide/shared': resolve(__dirname, 'packages/plugin-ui-vue/src/shared/index.ts'),
      '@navide/terminal/testing': resolve(__dirname, 'src/renderer/src/platform/terminal/testing.ts'),
      '@navide/terminal': resolve(__dirname, 'src/renderer/src/platform/terminal/index.ts'),
      '@navide/plugin-shell': resolve(__dirname, 'src/renderer/src/platform/plugin-shell/index.ts'),
      '@navide/ui-foundation/styles.css': resolve(__dirname, 'packages/plugin-ui-vue/src/foundation/styles.css'),
      '@navide/ui-foundation': resolve(__dirname, 'packages/plugin-ui-vue/src/foundation/index.ts'),
    },
  },
  define: {
    __APP_BUILD__: JSON.stringify('test')
  },
  test: {
    environment: 'node',
    // Renderer tests plus electron-free main-process modules (e.g. window-registry).
    include: [
      'src/renderer/src/**/*.{test,spec}.ts',
      'src/renderer/plugins/**/*.{test,spec}.ts',
      'src/main/**/*.{test,spec}.ts',
      'src/shared/**/*.{test,spec}.ts',
      'packages/plugin-sdk/src/**/*.{test,spec}.ts',
      'packages/plugin-ui-vue/src/**/*.{test,spec}.ts',
      'plugins/navide-git/src/**/*.{test,spec}.ts',
      'plugins/navide-git/tests/**/*.{test,spec}.ts'
    ],
    // Playwright E2E lives in e2e/ and is run by `test:e2e`, not Vitest.
    exclude: ['e2e/**', 'node_modules/**'],
    globals: false
  }
})
