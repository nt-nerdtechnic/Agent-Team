import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// ── Plans plugin bundle ──────────────────────────────────────────────────────
// A SEPARATE Vite build from the core renderer (electron.vite.config.ts),
// mirroring vite.mini-ide.config.ts. The separation is load-bearing: it lets
// this bundle alias `composables/useBackend` to the `capabilityBackend` shim
// WITHOUT touching the core renderer, which keeps its real WebSocket-backed
// `useBackend`. (A shared build can't diverge a module per entry —
// PlanWindowApp is one module in the graph.)
//
// Output: dist-plugins/plans/ — NOT part of the app package (electron-builder
// only ships out/**). In dev, AGENT_TEAM_PLUGIN_DEV=1 registers a descriptor
// pointing straight at this local build.

const APP_VERSION: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version

// Root at the plugin dir so its index.html emits directly at the outDir root
// rather than nested. Imports reach outside this root into src/ — fine for a
// build (no dev-server fs restriction).
const pluginRoot = resolve(__dirname, 'src/renderer/plugins/plans')
const capabilityBackend = resolve(pluginRoot, 'capabilityBackend')

export default defineConfig({
  root: pluginRoot,
  // Relative base so emitted asset URLs resolve under file:// in the packaged
  // WebContentsView (no dev server here — this entry is always loadFile'd).
  base: './',
  plugins: [vue()],
  resolve: {
    // Redirect the Plans UI's `useBackend` to the capability shim — for THIS
    // bundle only. Covers every relative form the tree uses:
    //   ./composables/useBackend  ../composables/useBackend
    //   ../../composables/useBackend  ./useBackend  ../useBackend
    alias: [
      { find: /^(?:\.\.?\/)+(?:composables\/)?useBackend$/, replacement: capabilityBackend },
    ],
  },
  define: {
    __APP_BUILD__: JSON.stringify(`v${APP_VERSION} plugin`),
  },
  build: {
    outDir: resolve(__dirname, 'dist-plugins/plans'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(pluginRoot, 'index.html') },
    },
  },
})
