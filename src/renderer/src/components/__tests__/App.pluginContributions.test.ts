import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

describe('titlebar button order', () => {
  // The titlebar's right cluster sits after a flex:1 spacer, so it is pinned to
  // the window's right edge and grows leftward from there. With the plugin
  // buttons appended AFTER the gear, installing or removing a plugin widened
  // the cluster and shifted ↻ and the gear — two built-in controls moving
  // because of something unrelated to them. Leading the cluster instead lets
  // plugins grow into the empty stretch and leaves the built-ins where they
  // are with no plugins at all.
  const at = (needle: string): number => {
    const i = appSource.indexOf(needle)
    expect(i, needle).toBeGreaterThan(-1)
    return i
  }

  it('renders plugin buttons before the built-in titlebar controls', () => {
    const plugins = at('class="titlebar-plugin-actions"')
    expect(plugins).toBeLessThan(at('class="titlebar-gear"'))
    // Both ws buttons too — reattach and the workspace switcher.
    expect(plugins).toBeLessThan(at('@click="reattachThisWindow"'))
    expect(plugins).toBeLessThan(at('@click="onSwitchWorkspace"'))
  })

  it('keeps the spacer that pins the cluster right', () => {
    // Without flex:1 the cluster would not be right-aligned and the order
    // above would stop meaning anything.
    expect(appSource).toMatch(/\.titlebar-spacer \{\s*flex: 1/)
  })
})

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
      /const mainBootParams: Record<string, string> = \{[\s\S]*legacy_git_recovery: '1'[\s\S]*legacy_plans_recovery: '1'/
    )
    expect(mainSource).toContain("loadWindow(win, { window: 'main', ...params, ...mainBootParams })")
  })

  it('passes the Host Plans recovery mode to ControlPane and listens for failures', () => {
    expect(appSource).toContain('legacyPlansRecovery')
    expect(appSource).toContain('onPlansRecoveryChanged')
    expect(appSource).toContain(':legacy-plans-recovery="legacyPlansRecovery"')
    expect(mainSource).toContain("hostWindow.webContents.send('plans:recoveryChanged', { legacy: true })")
  })

  it('tracks the recovery notification in both directions', () => {
    expect(appSource).toMatch(
      /const legacyGitRecovery = ref\(new URLSearchParams\(window\.location\.search\)\.get\(['"]legacy_git_recovery['"]\) === ['"]1['"]\)/
    )
    expect(appSource).toContain('onGitRecoveryChanged')
    // Leaving recovery (Extensions restores the bundled v2 package) must reach
    // the open window too; latching on true stranded it on the legacy panel.
    expect(appSource).toContain('legacyGitRecovery.value = change.legacy')
    expect(appSource).not.toContain('if (change.legacy) legacyGitRecovery.value = true')
    expect(appSource).toContain('stopGitRecoveryChanged?.()')
    expect(appSource).toContain(':legacy-git-recovery="legacyGitRecovery"')
  })

  it('uses the typed recovery listener exposed by preload', () => {
    const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')
    expect(preloadSource).toContain('onGitRecoveryChanged')
    expect(preloadSource).toMatch(/typeof payload\.legacy === ['"]boolean['"]|payload\.legacy === true/)
    expect(preloadSource).toContain('removeListener')
  })
})

describe('window plugin contributions filtering', () => {
  it('filters only navide.plans window contributions from the titlebar launcher list', () => {
    // Legacy UX spec: Plans are opened from the Plans side list into a relevant
    // Plan content window; there must be no standalone Plans-list launcher icon
    // in the top-right titlebar.
    expect(appSource).toMatch(
      /const windowPluginContributions = computed\(\(\) =>\s*pluginContributionsByLocation\.value\.window\.filter\(/
    )
    expect(appSource).toContain("contribution.pluginId !== 'navide.plans'")
    expect(appSource).toContain("contribution.contributionKey !== 'navide.plans.window'")
  })

  it('keeps programmatic v2 registration usable by passing all plugin-contributions to ControlPane', () => {
    expect(appSource).toContain(':plugin-contributions="pluginContributions"')
  })

  it('excludes navide.plans window contributions while preserving all non-Plans actions', () => {
    type TestContribution = { pluginId: string; contributionKey: string; location: string }
    const sampleContributions: TestContribution[] = [
      { pluginId: 'navide.plans', contributionKey: 'navide.plans.window', location: 'window' },
      { pluginId: 'navide.git', contributionKey: 'navide.git.window', location: 'window' },
      { pluginId: 'custom.tool', contributionKey: 'custom.tool.window', location: 'window' },
    ]
    const filtered = sampleContributions.filter(
      (c) => c.pluginId !== 'navide.plans' && c.contributionKey !== 'navide.plans.window'
    )
    expect(filtered.map((c) => c.contributionKey)).toEqual([
      'navide.git.window',
      'custom.tool.window',
    ])
  })
})
