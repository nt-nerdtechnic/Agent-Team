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
})
