import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

describe('generic plugin placement boot wiring', () => {
  it('imports PluginRegionHost at runtime and passes the recovery mode to ControlPane', () => {
    expect(appSource).toMatch(
      /import PluginRegionHost,\s*\{ type PluginRegionContribution \} from ['"]\.\/components\/PluginRegionHost\.vue['"]/
    )
    expect(appSource).not.toMatch(
      /import type \{ PluginRegionContribution \} from ['"]\.\/components\/PluginRegionHost\.vue['"]/,
    )
    expect(appSource).toContain(':legacy-git-recovery="legacyGitRecovery"')
  })

  it('carries the internal legacy boot flag only when recovery is enabled', () => {
    expect(mainSource).toMatch(
      /const mainBootParams(?:: Record<string, string>)? = gitRecoveryEnabled \? \{ legacy_git_recovery: '1' \} : \{\}/
    )
    expect(mainSource).toContain("loadWindow(win, { window: 'main', ...params, ...mainBootParams })")
  })

  it('accepts a recovery notification as a sticky renderer state', () => {
    expect(appSource).toMatch(
      /const legacyGitRecovery = ref\(new URLSearchParams\(window\.location\.search\)\.get\(['"]legacy_git_recovery['"]\) === ['"]1['"]\)/
    )
    expect(appSource).toContain('onGitRecoveryChanged')
    expect(appSource).toContain('legacyGitRecovery.value = true')
    expect(appSource).toContain('stopGitRecoveryChanged?.()')
    expect(appSource).toContain(':legacy-git-recovery="legacyGitRecovery"')
  })

  it('uses the typed recovery listener exposed by preload', () => {
    const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')
    expect(preloadSource).toContain('onGitRecoveryChanged')
    expect(preloadSource).toMatch(/payload\.legacy === true/)
    expect(preloadSource).toContain('removeListener')
  })
})
