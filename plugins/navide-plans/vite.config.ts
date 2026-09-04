import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(__dirname, '../..')
const packageRoot = resolve(__dirname)
const frontendRoot = resolve(packageRoot, 'frontend')
const pluginDistDir = process.env.NAVIDE_PLANS_DIST_DIR
  ? resolve(process.env.NAVIDE_PLANS_DIST_DIR)
  : resolve(repositoryRoot, 'dist-plugins/navide-plans')
const frontendOutDir = resolve(pluginDistDir, 'frontend')
const legacyAssetsDir = resolve(pluginDistDir, 'assets')

const emitManifest: Plugin = {
  name: 'emit-navide-plans-manifest',
  buildStart() {
    rmSync(legacyAssetsDir, { recursive: true, force: true })
  },
  closeBundle() {
    const appVersion = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
    ).version
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8'),
    )
    manifest.version = appVersion
    mkdirSync(pluginDistDir, { recursive: true })
    writeFileSync(resolve(pluginDistDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  },
}

export default defineConfig({
  root: frontendRoot,
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
    outDir: frontendOutDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        left: resolve(frontendRoot, 'left/index.html'),
        window: resolve(frontendRoot, 'window/index.html'),
      },
    },
  },
})
