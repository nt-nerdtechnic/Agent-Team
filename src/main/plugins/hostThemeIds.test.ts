import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `plugins:hostThemeChanged` constrains the theme id it will broadcast to
 * plugins, but main cannot import the authoritative list: it lives in
 * useTheme.ts, which imports Vue. The list is therefore duplicated in
 * index.ts — and a duplicated list drifts. This pins the two together so the
 * drift shows up here instead of as a theme the Host silently refuses to
 * forward.
 */
const repoRoot = resolve(import.meta.dirname, '../../..')

function ids(source: string, pattern: RegExp): string[] {
  const block = source.match(pattern)?.[1] ?? ''
  return [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort()
}

describe('host theme id list', () => {
  it('matches the themes useTheme ships', () => {
    const main = readFileSync(resolve(repoRoot, 'src/main/index.ts'), 'utf8')
    const theme = readFileSync(
      resolve(repoRoot, 'packages/plugin-ui/src/foundation/composables/useTheme.ts'),
      'utf8'
    )
    const hostIds = ids(main, /const HOST_THEME_IDS = new Set\(\[([\s\S]*?)\]\)/)
    // Scoped to the BUILTIN_THEMES block: CUSTOMIZABLE_TOKENS in the same file
    // has the same `{ id: '…' }` shape and would otherwise be swept in.
    const builtinBlock = theme.match(/BUILTIN_THEMES: ThemeMeta\[\] = \[([\s\S]*?)\]/)?.[1] ?? ''
    const builtinIds = [...builtinBlock.matchAll(/id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]).sort()

    expect(theme).toContain('export const BUILTIN_THEMES')
    expect(hostIds.length).toBeGreaterThan(0)
    expect(builtinIds.length).toBeGreaterThan(0)
    expect(hostIds).toEqual(builtinIds)
  })
})
