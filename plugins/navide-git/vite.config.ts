import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  },
}

export default defineConfig({
  root: packageRoot,
  base: './',
  plugins: [vue(), emitManifest],
  resolve: {
    alias: {
      '@navide/shared': resolve(repositoryRoot, 'packages/features/shared/src'),
      '@navide/ui-foundation': resolve(repositoryRoot, 'packages/features/ui-foundation/src'),
      '@navide/ui-foundation/styles.css': resolve(repositoryRoot, 'packages/features/ui-foundation/src/styles.css'),
      '@navide/terminal': resolve(repositoryRoot, 'packages/features/terminal/src'),
      '@navide/plugin-shell': resolve(repositoryRoot, 'packages/features/plugin-shell/src'),
      '@navide/git-feature': resolve(repositoryRoot, 'packages/features/git/src'),
      '@navide/git-feature/testing': resolve(repositoryRoot, 'packages/features/git/src/testing.ts'),
    },
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
