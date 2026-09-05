import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const repositoryRoot = resolve(__dirname, '../..')
const packageRoot = resolve(__dirname)
const frontendRoot = resolve(packageRoot, 'frontend')
const pluginDistDir = process.env.NAVIDE_PLANS_DIST_DIR
  ? resolve(process.env.NAVIDE_PLANS_DIST_DIR)
  : resolve(repositoryRoot, 'dist-plugins/navide-plans')
const frontendOutDir = resolve(pluginDistDir, 'frontend')
const legacyAssetsDir = resolve(pluginDistDir, 'assets')
function sourceFiles(directory: string): string[] {
  return readdirSync(resolve(packageRoot, directory), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? (entry.name === '__pycache__' ? [] : sourceFiles(`${directory}/${entry.name}`))
      : [`${directory}/${entry.name}`])
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.pyc'))
    .sort()
}
const provenanceInputs = [...sourceFiles('src'), ...sourceFiles('backend'), 'manifest.json', 'vite.config.ts']
const buildId = createHash('sha256')
  .update(provenanceInputs.map((file) => `${file}\0${readFileSync(resolve(packageRoot, file), 'utf8')}\0`).join(''))
  .update(readFileSync(resolve(repositoryRoot, 'package.json')))
  .digest('hex')
  .slice(0, 16)

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
  define: {
    __NAVIDE_PLANS_BUILD_ID__: JSON.stringify(buildId),
  },
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
