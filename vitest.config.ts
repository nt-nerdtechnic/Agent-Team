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
      '@navide/git-shared': resolve(__dirname, 'packages/features/git-ui/src'),
      '@navide/git-feature': resolve(__dirname, 'packages/features/git/src'),
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
      'packages/features/git/src/**/*.{test,spec}.ts',
      'packages/features/git-ui/src/**/*.{test,spec}.ts',
      'plugins/navide-git/src/**/*.{test,spec}.ts',
      'plugins/navide-git/tests/**/*.{test,spec}.ts'
    ],
    // Playwright E2E lives in e2e/ and is run by `test:e2e`, not Vitest.
    exclude: ['e2e/**', 'node_modules/**'],
    globals: false
  }
})
