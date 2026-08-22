import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(process.cwd(), 'src/renderer/src')
// GitWindowApp is bundled as the navide.git plugin, so Issue 12 owns that
// composition rather than the Host entry router.
const issue12OwnedSources = new Set(['GitWindowApp.vue'])

function collectProductionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory() && entry.name === '__tests__') return []
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) return collectProductionSources(entryPath)
      return entry.isFile() && /\.(ts|vue)$/.test(entry.name) ? [entryPath] : []
    })
    .sort()
}

function collectHostOwnedSources(): string[] {
  return collectProductionSources(rendererRoot)
    .filter((sourcePath) => !issue12OwnedSources.has(relative(rendererRoot, sourcePath)))
}

function gitPaneMounts(source: string): string[] {
  return [...source.matchAll(/<(?:GitPane|git-pane)\b[\s\S]*?(?:\/>|<\/(?:GitPane|git-pane)>)/g)].map(([mount]) => mount)
}

describe('Host Git composition', () => {
  it('keeps the plugin-owned GitWindowApp outside the Host entry router', () => {
    const mainSource = readFileSync(join(rendererRoot, 'main.ts'), 'utf8')
    expect(mainSource).not.toMatch(/GitWindowApp/)
  })

  it('injects a GitTransport into every Host-owned GitPane mount', () => {
    const mounts = collectHostOwnedSources()
      .filter((sourcePath) => sourcePath.endsWith('.vue'))
      .flatMap((sourcePath) => gitPaneMounts(readFileSync(sourcePath, 'utf8')))

    expect(mounts.length).toBeGreaterThan(0)
    for (const mount of mounts) {
      expect(mount).toContain(':git-transport=')
    }
  })

  it('requires explicit transport composition for Host-owned Git composables', () => {
    const rawGitCall = /useGit\(\(\) => (?:props\.)?workspacePath,\s*(?:props\.)?backend\)/
    const rawRepoDiscoveryCall = /useRepoDiscovery\(\(\) => props\.workspacePath,\s*props\.backend\)/

    for (const sourcePath of collectHostOwnedSources()) {
      const relativePath = relative(rendererRoot, sourcePath)
      const source = readFileSync(sourcePath, 'utf8')
      expect(source, relativePath).not.toMatch(rawGitCall)
      expect(source, relativePath).not.toMatch(rawRepoDiscoveryCall)
    }
  })
})
