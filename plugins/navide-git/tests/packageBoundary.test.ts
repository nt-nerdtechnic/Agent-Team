import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPluginDir } from '../../../src/main/plugins/installedPlugins'

const repositoryRoot = resolve(process.cwd())
const packageRoot = resolve(repositoryRoot, 'plugins/navide-git')

const gitOwnedPaths = [
  'GitWindowApp.vue',
  'components/GitHistoryModal.vue',
  'components/GitPane.vue',
  'components/MultiRepoGit.vue',
  'components/NotificationHost.vue',
  'composables/useGit.ts',
  'composables/useIssues.ts',
  'composables/useRepoDiscovery.ts',
  'editor/BranchDiffPane.vue',
  'editor/ConflictPane.vue',
  'editor/DiffPane.vue',
  'ports/gitBackend.ts',
  'ports/gitContribution.ts',
  'ports/gitSurface.ts',
  'lib/conflict-parser.ts',
  'lib/discardConfirm.ts',
  'lib/git-diff.ts',
  'lib/git-graph.ts',
  'lib/gitMenuEscape.ts',
  'lib/imageData.ts',
]

const formerGitPackagePaths = gitOwnedPaths.map((relativePath) =>
  resolve(repositoryRoot, 'packages/features/git-ui/src', relativePath),
)
formerGitPackagePaths.push(resolve(repositoryRoot, 'packages/features/git-ui/src/components/GitCredentialModal.vue'))

function sourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.(ts|vue)$/.test(entry.name)) files.push(path)
  }
  return files
}

const privateFeatureRoots = ['shared', 'ui-foundation', 'terminal', 'plugin-shell', 'git']
const productionRoots = [
  'src/main',
  'src/preload',
  'src/renderer/src',
  'src/renderer/plugins/git',
  'plugins/navide-git/src',
  ...privateFeatureRoots.map((owner) => `packages/features/${owner}/src`),
]

function isProductionSource(path: string): boolean {
  return !/(?:^|\/)__(?:tests|mocks)__(?:\/|$)|(?:^|\/)tests(?:\/|$)|\.(?:test|spec)\.ts$/.test(path)
}

function privateFeatureBoundaryViolations(path: string, source: string): string[] {
  const violations: string[] = []
  const specifierPattern = /(?:import\s*(?:[^'"()]*?\s+from\s*)?|export\s+[^'"()]*?\s+from\s*|import\s*\()(['"])([^'"]+)\1/g
  for (const match of source.matchAll(specifierPattern)) {
    const specifier = match[2]
    if (/^@navide\/(?:shared|ui-foundation|terminal|plugin-shell|git-feature)\/(?!testing$|styles\.css$)/.test(specifier)) {
      violations.push(`deep private alias '${specifier}'`)
      continue
    }
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(path), specifier)
      if (privateFeatureRoots.some((owner) => target.startsWith(resolve(repositoryRoot, `packages/features/${owner}/src`)))) {
        const ownerRoot = resolve(repositoryRoot, `packages/features/${privateFeatureRoots.find((owner) => target.startsWith(resolve(repositoryRoot, `packages/features/${owner}/src`)))}/src`)
        if (!path.startsWith(ownerRoot)) violations.push(`relative private feature source '${specifier}'`)
      }
    }
  }
  return violations
}

describe('navide.git production package boundary', () => {
  it('scans every production graph for static, side-effect, dynamic, export, and relative feature-source imports', () => {
    for (const root of productionRoots) {
      for (const path of sourceFiles(resolve(repositoryRoot, root)).filter(isProductionSource)) {
        expect(privateFeatureBoundaryViolations(path, readFileSync(path, 'utf8')), relative(repositoryRoot, path)).toEqual([])
      }
    }
  })

  it('recognizes dynamic imports alongside the other ESM import forms', () => {
    const source = [
      "import '@navide/git-feature/internal'",
      "import type { Thing } from '@navide/git-feature/internal'",
      "export { Thing } from '@navide/git-feature/internal'",
      "await import('@navide/git-feature/internal')",
    ].join('\n')
    expect(privateFeatureBoundaryViolations(resolve(repositoryRoot, 'src/main/example.ts'), source)).toHaveLength(4)
  })
  it('declares both canonical custom contributions in one manifest', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'manifest.json'), 'utf8')) as {
      schemaVersion: number
      id: string
      permissions: { system?: string[]; shell?: string }
      contributes?: { views?: Array<{ id: string; kind: string; location: string; entry: string }> }
    }
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.id).toBe('navide.git')
    expect(manifest.permissions.system).toEqual(['fs', 'ui', 'aiCli'])
    expect(manifest.permissions.shell).toBe('allowlist')
    expect(manifest.contributes?.views).toEqual([
      { id: 'left', kind: 'custom', location: 'left', title: 'Git', entry: 'frontend/left/index.html' },
      { id: 'window', kind: 'custom', location: 'window', title: 'Git', entry: 'frontend/window/index.html' },
    ])
  })

  it('passes the Host loader as one package identity', () => {
    const scanned = loadPluginDir(packageRoot)
    expect(scanned.error).toBeUndefined()
    expect(scanned.descriptor?.id).toBe('navide.git')
    expect(scanned.descriptor?.packageVersion).toBe('0.1.0')
    expect(scanned.descriptor?.views?.map((view) => view.contributionKey)).toEqual([
      'navide.git.left',
      'navide.git.window',
    ])
  })

  it('keeps production AI and Host operations behind v2 bridges', () => {
    const entry = readFileSync(resolve(packageRoot, 'src/index.ts'), 'utf8')
    const backend = readFileSync(resolve(packageRoot, 'src/capabilityBackend.ts'), 'utf8')
    const surfaces = readFileSync(resolve(packageRoot, 'src/pluginSurfacePorts.ts'), 'utf8')
    expect(entry).not.toContain('src/renderer/plugins/git/mount')
    expect(backend).toContain('callHostAction')
    expect(surfaces).toContain("'aiCli.startSession'")
    expect(surfaces).not.toContain("'terminal.create'")
    expect(surfaces).not.toContain('requestBody.command')
  })

  it('keeps Git-specific production source in the plugin package', () => {
    for (const relativePath of gitOwnedPaths) {
      expect(existsSync(resolve(packageRoot, 'src', relativePath)), relativePath).toBe(true)
    }
    for (const path of formerGitPackagePaths) {
      expect(existsSync(path), path).toBe(false)
    }
  })

  it('rejects Host renderer imports and the retired Git UI alias from the plugin graph', () => {
    const source = sourceFiles(resolve(packageRoot, 'src'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
    expect(source).not.toContain('@navide/git-ui')
    expect(source).not.toMatch(/from ['"][^'"]*src\/renderer\//)
    expect(source).not.toContain('packages/features/git-ui/src')
    expect(source).not.toMatch(/from ['"](?:\.\.\/){3,}/)
    expect(source).not.toContain('GitCredentialPort')
    expect(source).not.toContain('GIT_CREDENTIALS_KEY')
    expect(source).not.toContain('git.credential_request')
    expect(source).not.toContain('git.credential_submit')
    expect(source).not.toContain('git.credential_cancel')
  })

  it('uses private feature roots through their explicit export surfaces', () => {
    const source = sourceFiles(resolve(packageRoot, 'src'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
    expect(source).toContain("from '@navide/shared'")
    expect(source).toContain("from '@navide/ui-foundation'")
    expect(source).toContain("from '@navide/terminal'")
    expect(source).toContain("from '@navide/plugin-shell'")
    expect(source).not.toMatch(/from ['"]@navide\/(?:shared|terminal|plugin-shell)\/(?!testing(?:['"]|$))|from ['"]@navide\/ui-foundation\/(?!styles\.css(?:['"]|$))/)
    expect(source).not.toContain("@navide/plugin-shell/styles.css")
  })

  it('keeps Git-specific code out of generic private feature owners', () => {
    for (const owner of ['shared', 'ui-foundation', 'terminal', 'plugin-shell']) {
      const source = sourceFiles(resolve(repositoryRoot, 'packages/features', owner, 'src'))
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n')
      expect(source, owner).not.toContain('packages/features/git')
      expect(source, owner).not.toContain('plugins/navide-git')
      expect(source, owner).not.toContain('@navide/git-feature')
    }
  })
})
