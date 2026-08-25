import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

const sharedMirrorPaths = [
  'components/AiCliDock.vue',
  'components/AiCliTerminal.vue',
  'composables/useTerminal.ts',
  'composables/useTerminalFontSize.ts',
  'composables/useTerminalResize.ts',
  'lib/aiCliContext.ts',
  'lib/settings.ts',
  ...readdirSync(resolve(repositoryRoot, 'packages/features/git-ui/src/agents'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => `agents/${entry}`),
  ...readdirSync(resolve(repositoryRoot, 'packages/features/git-ui/src/keybindings'))
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => `keybindings/${entry}`),
]

describe('navide.git production package boundary', () => {
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

  it('keeps the transitional shared-shell mirrors synchronized', () => {
    for (const relativePath of sharedMirrorPaths) {
      const hostPath = resolve(repositoryRoot, 'src/renderer/src', relativePath)
      const packagePath = resolve(repositoryRoot, 'packages/features/git-ui/src', relativePath)
      expect(readFileSync(hostPath, 'utf8'), relativePath).toBe(readFileSync(packagePath, 'utf8'))
    }
  })
})
