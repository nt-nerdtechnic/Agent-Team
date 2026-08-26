import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ── App version — single source of truth is package.json ─────────────────────
const APP_VERSION: string = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')).version

// Build-time tag shown in the header: "v<APP_VERSION> @MM/DD HH:mm".
// The timestamp distinguishes each dev-mode launch; the version string stays
// fixed until you bump APP_VERSION above.
function buildTag(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return `v${APP_VERSION} @${stamp}`
}

const APP_BUILD = buildTag()

// Generate a fresh random token each dev session and write to tmpdir.
// The Electron main process reads this file and injects the token into every
// renderer request via session.webRequest — browsers can't guess the token.
const DEV_TOKEN = randomBytes(32).toString('hex')
writeFileSync(join(tmpdir(), 'agent-team-dev-token'), DEV_TOKEN)

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@navide/git-feature': resolve(__dirname, 'plugins/navide-git/src/git-feature/index.ts'),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // `ws` (pulled in by the plugin WebSocket client) does an optional
        // `require('bufferutil')` / `require('utf-8-validate')` for native
        // speedups. They aren't installed and ws falls back to JS at runtime,
        // but the bundler still tries to resolve them at build time and fails.
        // Externalize so the optional requires are left alone.
        external: ['bufferutil', 'utf-8-validate']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Dedicated minimal preload for plugin WebContentsViews (Phase 2 M1).
          'plugin-preload': resolve(__dirname, 'src/preload/plugin-preload.ts')
        }
      }
    },
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION)
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@navide/git-feature': resolve(__dirname, 'plugins/navide-git/src/git-feature/index.ts'),
        '@navide/shared': resolve(__dirname, 'packages/plugin-ui-vue/src/shared/index.ts'),
        '@navide/terminal': resolve(__dirname, 'src/renderer/src/platform/terminal/index.ts'),
        '@navide/plugin-shell': resolve(__dirname, 'src/renderer/src/platform/plugin-shell/index.ts'),
        '@navide/ui-foundation/styles.css': resolve(__dirname, 'packages/plugin-ui-vue/src/foundation/styles.css'),
        '@navide/ui-foundation': resolve(__dirname, 'packages/plugin-ui-vue/src/foundation/index.ts'),
      },
    },
    server: {
      port: 5174,
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // No-op plugin entry (Phase 2 M1). Lives under the renderer root so the
          // dev server serves it and the build emits it to out/renderer/plugins/
          // noop/ without shifting the main index.html output path.
          'noop-plugin': resolve(__dirname, 'src/renderer/plugins/noop/index.html'),
          // FS probe plugin entry (Phase 2 M2): exercises a real brokered
          // capability call + server-push event over the backend WS.
          'fs-probe-plugin': resolve(__dirname, 'src/renderer/plugins/fs_probe/index.html')
        }
      }
    },
    define: {
      __APP_BUILD__: JSON.stringify(APP_BUILD)
    },
    // Pre-bundle monaco-editor at startup so Vite doesn't trigger a mid-session
    // dependency re-optimization the first time Monaco lazily imports a language
    // chunk (e.g. yaml). That re-optimization forces a full reload and drops the
    // in-flight dynamic import → "Failed to fetch dynamically imported module".
    optimizeDeps: {
      include: ['monaco-editor'],
    },
    plugins: [
      vue(),
      // Block all non-Electron requests with a per-session random token.
      // The main process reads the token from tmpdir and injects it via
      // session.webRequest — no browser can guess a 32-byte random value.
      {
        name: 'electron-only',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.headers['x-electron-token'] !== DEV_TOKEN) {
              res.writeHead(403, { 'Content-Type': 'text/plain' })
              res.end('403 Forbidden')
              return
            }
            next()
          })
        },
      },
    ]
  }
})
