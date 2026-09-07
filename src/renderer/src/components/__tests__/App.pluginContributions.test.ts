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
    expect(plugins).toBeLessThan(at('class="titlebar-account"'))
    // Reattach too. The workspace switcher is deliberately absent from this
    // list: it left the cluster for the centred identity block, where it reads
    // as Back — see the titlebar-id test below.
    expect(plugins).toBeLessThan(at('@click="reattachThisWindow"'))
  })

  it('keeps the workspace switcher out of the right-hand cluster', () => {
    // It leads .titlebar-id, ahead of the workspace name it takes you out of.
    const id = at('class="titlebar-id"')
    const name = at('class="titlebar-name titlebar-name--ws"')
    const back = at('@click="onSwitchWorkspace"')
    expect(back).toBeGreaterThan(id)
    expect(back).toBeLessThan(name)
    expect(back).toBeLessThan(at('class="titlebar-plugin-actions"'))
  })

  it('reveals the workspace switcher only while the identity block is hovered', () => {
    // Same rule .titlebar-reveal follows. It is what keeps the button
    // clickable: the hover that shows it also swaps the name for the longer
    // path, so a permanently visible button would slide as the row re-centres.
    expect(appSource).toContain('class="titlebar-ws-btn titlebar-back"')
    expect(appSource).toMatch(/\.titlebar-back \{ display: none; \}/)
    expect(appSource).toMatch(/\.titlebar-id:hover \.titlebar-back \{ display: flex; \}/)
    // display:none has to land after .titlebar-ws-btn's display:flex — equal
    // specificity, so the later rule is the only reason it wins.
    expect(appSource.indexOf('.titlebar-back { display: none; }')).toBeGreaterThan(
      appSource.indexOf('.titlebar-ws-btn {')
    )
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
      /const mainBootParams(?:: Record<string, string>)? = gitRecoveryEnabled \? \{ legacy_git_recovery: '1' \} : \{\}/
    )
    expect(mainSource).toContain("loadWindow(win, { window: 'main', ...params, ...mainBootParams })")
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
    expect(preloadSource).toMatch(/payload\.legacy === true/)
    expect(preloadSource).toContain('removeListener')
  })
})
