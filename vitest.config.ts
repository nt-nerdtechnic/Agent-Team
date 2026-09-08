import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// Renderer-only unit/component tests. Pure functions (lib/, data/) run in the
// default `node` environment; composable tests opt into happy-dom per-file via
// `// @vitest-environment happy-dom`. We mirror the renderer's build-time global
// (`__APP_BUILD__`) so importing modules that reference it doesn't throw.
export default defineConfig({
  // Mirrors electron.vite.config.ts: <webview> carries in-window plugin
  // contributions and is a built-in tag, not a Vue component.
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'webview' } } })],
  resolve: {
    alias: {
      '@navide/plugin-contracts': resolve(__dirname, 'packages/plugin-contracts/src/index.ts'),
      '@navide/plugin-sdk': resolve(__dirname, 'packages/plugin-sdk/src/index.ts'),
      '@navide/plugin-ui/styles.css': resolve(__dirname, 'packages/plugin-ui/src/foundation/styles.css'),
      '@navide/plugin-ui/shared/testing': resolve(__dirname, 'packages/plugin-ui/src/shared/testing.ts'),
      '@navide/plugin-ui/shared': resolve(__dirname, 'packages/plugin-ui/src/shared/index.ts'),
      '@navide/plugin-ui/foundation': resolve(__dirname, 'packages/plugin-ui/src/foundation/index.ts'),
      '@navide/plugin-ui': resolve(__dirname, 'packages/plugin-ui/src/index.ts'),
      '@navide/terminal/testing': resolve(__dirname, 'src/renderer/src/platform/terminal/testing.ts'),
      '@navide/terminal': resolve(__dirname, 'src/renderer/src/platform/terminal/index.ts'),
      '@navide/plugin-shell': resolve(__dirname, 'src/renderer/src/platform/plugin-shell/index.ts'),
    },
  },
  define: {
    __APP_BUILD__: JSON.stringify('test')
  },
  test: {
    environment: 'node',
    // Renderer tests plus electron-free main-process modules (e.g. window-registry).
    include: [
      'vitest.*.{test,spec}.ts',
      'src/renderer/src/**/*.{test,spec}.ts',
      'src/renderer/plugins/**/*.{test,spec}.ts',
      'src/main/**/*.{test,spec}.ts',
      'src/shared/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.ts',
      'packages/plugin-sdk/src/**/*.{test,spec}.ts',
      'packages/plugin-ui/src/**/*.{test,spec}.ts',
      'plugins/navide-git/src/**/*.{test,spec}.ts',
      'plugins/navide-git/tests/**/*.{test,spec}.ts',
      'plugins/navide-plans/src/**/*.{test,spec}.ts',
      'plugins/navide-plans/tests/**/*.{test,spec}.ts'
    ],
    // Playwright E2E lives in e2e/ and is run by `test:e2e`, not Vitest.
    exclude: ['e2e/**', 'node_modules/**'],
    globals: false,
    server: {
      deps: {
        // pluginExternalWorkspace.test.ts imports the *built* plugin bundle out
        // of a mkdtemp directory to prove the packaged artifact loads as a real
        // ES module. Vite 6 pulls such a path through its transform pipeline and
        // rejects it for sitting outside the project root; externalizing hands
        // the file to Node's own loader, which is what the assertion is about.
        external: [/navide-plugin-external-/]
      }
    }
  }
})
