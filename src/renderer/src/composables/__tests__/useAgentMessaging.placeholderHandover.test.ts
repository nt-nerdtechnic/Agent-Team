import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentMessaging, _resetMessagingForTest, type MessagingDeps } from '../useAgentMessaging'

// A cold-restored pane exists as a placeholder until it is clicked, and for a
// month it existed to nothing else: the restore path never registered a
// messaging handle, so `messagingName` stayed undefined and every reader that
// filters on it — the @-mention menu, the cross-workspace mirror behind
// cli_list_targets — skipped the pane entirely. Typing "@" simply did not open
// the menu, because it had nothing to offer.
//
// Lazy CLI restore (81c9148c) landed five days after the mention menu
// (91f36cc1): a later feature added a third pane state to code that knew two.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('a restore placeholder owns its messaging handle', () => {
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => 1_000_000,
    deliver: async () => true,
    isPaneIdle: () => true,
  }

  beforeEach(() => {
    _resetMessagingForTest()
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  // Registering the placeholder is only half of it. Realizing one does not
  // reuse its id — it spawns a replacement with a fresh one — so the handle has
  // to be handed over, not registered twice.
  it('hands the name to the replacement instead of suffixing it', () => {
    expect(m.registerPane('placeholder-id', 'claude', 'Anroute-Map')).toBe('Anroute-Map')

    // What createPane does for a replacement, in order: release, then claim.
    m.unregisterPane('placeholder-id')
    expect(m.registerPane('realized-id', 'claude', 'Anroute-Map')).toBe('Anroute-Map')
    expect(m.paneIdOf('Anroute-Map')).toBe('realized-id')
  })

  it('suffixes the replacement when the old id is left registered', () => {
    // The failure this guards: skip the release and the name is still taken, so
    // the pane the user addresses by name is silently renamed under them.
    m.registerPane('placeholder-id', 'claude', 'Anroute-Map')
    expect(m.registerPane('realized-id', 'claude', 'Anroute-Map')).toBe('Anroute-Map-2')
  })

  it('registers the placeholder before it joins the pane list', () => {
    const at = appSource.indexOf('panes.value.push(placeholder)')
    expect(at).toBeGreaterThan(0)
    const block = appSource.slice(Math.max(0, at - 1200), at)
    expect(block).toContain('registerPaneMessaging(placeholder,')
  })

  it('releases a replaced pane id before the replacement claims a handle', () => {
    const release = appSource.indexOf('unregisterPaneMessaging(opts.replacePaneId')
    const claim = appSource.indexOf('registerPaneMessaging(pane, opts.preferredMessagingName)')
    expect(release).toBeGreaterThan(0)
    expect(claim).toBeGreaterThan(release)
    // Guarded: replacing a pane with its own id must not drop its handle.
    expect(appSource.slice(release - 200, release)).toContain('opts.replacePaneId !== id')
  })
})
