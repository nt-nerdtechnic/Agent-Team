import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(__dirname, '../..')
const packageRoot = resolve(__dirname)
const outDir = resolve(repositoryRoot, 'dist-plugins/navide-git')

const emitManifest: Plugin = {
  name: 'emit-navide-git-manifest',
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
    const assetsDir = resolve(outDir, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    copyFileSync(resolve(packageRoot, 'assets/git.png'), resolve(assetsDir, 'git.png'))
  },
}

export default defineConfig({
  root: packageRoot,
  base: './',
  plugins: [vue(), emitManifest],
  resolve: {
    alias: [
      { find: '#git-feature', replacement: resolve(packageRoot, 'src/git-feature/index.ts') },
      { find: '@navide/plugin-ui/styles.css', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/foundation/styles.css') },
      { find: '@navide/plugin-ui/shared', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/shared/index.ts') },
      { find: '@navide/plugin-ui/foundation', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/foundation/index.ts') },
      { find: '@navide/plugin-ui', replacement: resolve(repositoryRoot, 'packages/plugin-ui/src/index.ts') },
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
