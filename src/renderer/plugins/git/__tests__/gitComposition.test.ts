import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const pluginRoot = resolve(repositoryRoot, 'src/renderer/plugins/git')

function resolveRelativeImport(sourcePath: string, specifier: string): string | null {
  const base = resolve(dirname(sourcePath), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.vue`,
    `${base}.js`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.vue'),
  ]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

function collectImportGraph(entry: string): Map<string, string> {
  const sources = new Map<string, string>()
  const pending = [entry]
  while (pending.length) {
    const sourcePath = pending.pop()!
    if (sources.has(sourcePath)) continue
    const source = readFileSync(sourcePath, 'utf8')
    sources.set(sourcePath, source)
    const imports = source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g)
    for (const match of imports) {
      const target = resolveRelativeImport(sourcePath, match[1])
      if (target) pending.push(target)
    }
  }
  return sources
}

describe('plugin Git production composition', () => {
  it('constructs the SDK adapter at mount and injects named ports into GitWindowApp', () => {
    const mountSource = readFileSync(resolve(pluginRoot, 'mount.ts'), 'utf8')
    const appSource = readFileSync(resolve(repositoryRoot, 'src/renderer/src/GitWindowApp.vue'), 'utf8')

    expect(mountSource).toContain('createPluginGitTransport')
    for (const provider of [
      'GIT_TRANSPORT_KEY, surfacePorts.gitTransport',
      'GIT_FILE_ACCESS_KEY, surfacePorts.fileAccess',
      'GIT_UI_KEY, surfacePorts.ui',
      'GIT_BRANCH_DIFF_KEY, surfacePorts.branchDiff',
      'GIT_CREDENTIALS_KEY, surfacePorts.credentials',
      'GIT_ACCOUNTS_KEY, surfacePorts.accounts',
      'GIT_ISSUES_KEY, surfacePorts.issues',
      'TERMINAL_DOCK_KEY, terminalPort',
    ]) {
      expect(mountSource).toContain(`app.provide(${provider})`)
    }
    expect(appSource).toContain('inject(GIT_TRANSPORT_KEY)')
    expect(appSource).toContain('useGit(() => workspacePath, gitTransport, credentialPort)')
    expect(appSource).not.toMatch(/useBackend|backend\.send|backend\.on|window\.agentTeam|:backend=/)
  })

  it('keeps Host adapters and Host-only review code out of the real plugin import graph', () => {
    const graph = collectImportGraph(resolve(pluginRoot, 'mount.ts'))
    const graphPaths = [...graph.keys()].map((sourcePath) => sourcePath.slice(repositoryRoot.length + 1))
    const graphText = [...graph.values()].join('\n')

    expect(graphPaths).toContain('src/renderer/plugins/git/mount.ts')
    expect(graphPaths).toContain('src/renderer/src/GitWindowApp.vue')
    expect(graphPaths).toContain('src/renderer/plugins/git/sdkGitTransport.ts')
    expect(graphPaths).toContain('src/renderer/plugins/git/pluginSurfacePorts.ts')
    expect(graphPaths).not.toContain('src/renderer/src/composables/hostGitTransport.ts')
    expect(graphPaths).not.toContain('src/renderer/src/composables/hostSurfacePorts.ts')
    expect(graphPaths).not.toContain('src/renderer/src/components/ReviewPane.vue')
    expect(graphText).not.toContain('createHostGitTransport')
    expect(graphText).not.toContain('createHostGitSurfacePorts')

    const compositionBoundary = new Set([
      'src/renderer/plugins/git/mount.ts',
      'src/renderer/plugins/git/capabilityBackend.ts',
      'src/renderer/plugins/git/pluginSurfacePorts.ts',
      'src/renderer/plugins/git/sdkGitTransport.ts',
    ])
    for (const [sourcePath, source] of graph) {
      const relativePath = sourcePath.slice(repositoryRoot.length + 1)
      if (compositionBoundary.has(relativePath)) continue
      expect(source, relativePath).not.toMatch(/useBackend|backend\.send|backend\.on|window\.agentTeam|:backend=/)
    }

    for (const relativePath of [
      'src/renderer/src/GitWindowApp.vue',
      'src/renderer/src/editor/DiffPane.vue',
      'src/renderer/src/editor/ConflictPane.vue',
      'src/renderer/src/editor/BranchDiffPane.vue',
      'src/renderer/src/components/AiCliDock.vue',
      'src/renderer/src/components/AiCliTerminal.vue',
      'src/renderer/src/composables/useTerminal.ts',
    ]) {
      const sourcePath = resolve(repositoryRoot, relativePath)
      expect(graph.has(sourcePath), relativePath).toBe(true)
      expect(graph.get(sourcePath), relativePath).not.toMatch(/useBackend|backend\.send|backend\.on|window\.agentTeam|:backend=/)
    }
  })

  it('keeps the Issue 10 Git inventory free of unconsumed capabilities', () => {
    const featureSource = readFileSync(resolve(repositoryRoot, 'packages/features/git/src/gitTransport.ts'), 'utf8')
    const pluginSource = readFileSync(resolve(pluginRoot, 'pluginSurfacePorts.ts'), 'utf8')
    expect(featureSource).not.toContain('git.diff_all')
    expect(pluginSource).not.toContain('git.diff_all')
  })

})
