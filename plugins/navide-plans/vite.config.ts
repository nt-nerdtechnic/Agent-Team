import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(__dirname, '../..')
const packageRoot = resolve(__dirname)
const outDir = resolve(repositoryRoot, 'dist-plugins/navide-plans')

const emitManifest: Plugin = {
  name: 'emit-navide-plans-manifest',
  closeBundle() {
    const appVersion = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
    ).version
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8'),
    )
    manifest.version = appVersion
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  },
}

export default defineConfig({
  root: packageRoot,
  base: './',
  plugins: [vue(), emitManifest],
  resolve: {
    alias: [
      { find: '@navide/plugin-ui/styles.css', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/foundation/styles.css') },
      { find: '@navide/plugin-ui/shared', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/shared/index.ts') },
      { find: '@navide/plugin-ui/foundation', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/foundation/index.ts') },
      { find: '@navide/plugin-ui', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/index.ts') },
      { find: '@navide/plugin-sdk', replacement: resolve(repositoryRoot, 'packages/plugin-sdk/src/index.ts') },
    ],
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        left: resolve(packageRoot, 'frontend/left/index.html'),
        window: resolve(packageRoot, 'frontend/window/index.html'),
      },
    },
  },
})
