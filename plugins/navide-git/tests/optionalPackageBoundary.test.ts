import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function sourceText(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) return sourceText(path)
      return /\.(?:ts|vue)$/.test(entry.name) ? readFileSync(path, 'utf8') : ''
    })
    .join('\n')
}

describe('factory first-party package boundary', () => {
  it('does not keep a second private feature package system', () => {
    expect(existsSync(join(repositoryRoot, 'packages', 'features'))).toBe(false)
    expect(existsSync(join(repositoryRoot, 'packages', 'internal'))).toBe(false)
  })

  it('builds navide.git only from public plugin packages', () => {
    const manifest = readJson(join(repositoryRoot, 'plugins', 'navide-git', 'package.json'))
    const dependencies = Object.keys((manifest.dependencies ?? {}) as Record<string, string>)

    expect(dependencies.sort()).toEqual([
      '@navide/plugin-ui',
      'vue',
      'vue-i18n',
    ])
  })

  it('does not import Host implementation aliases', () => {
    const source = sourceText(join(repositoryRoot, 'plugins', 'navide-git', 'src'))
    for (const privateAlias of ['@navide/git-feature', '@navide/terminal', '@navide/plugin-shell']) {
      expect(source.includes(privateAlias), privateAlias).toBe(false)
    }
  })

  it('ships factory v2 and legacy recovery artifacts without changing their runtime seam', () => {
    const manifest = readJson(join(repositoryRoot, 'package.json'))
    const scripts = (manifest.scripts ?? {}) as Record<string, string>
    const build = (manifest.build ?? {}) as { extraResources?: Array<{ from?: string }> }
    const resourceSources = (build.extraResources ?? []).map((entry) => entry.from ?? '')

    expect(scripts.build).toContain('build:git')
    expect(resourceSources).toContain('dist-plugins/git')
    expect(resourceSources).toContain('dist-plugins/navide-git')
  })
})
