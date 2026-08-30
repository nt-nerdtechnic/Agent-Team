// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { revealPath } from '../capabilityShell'
import { MINI_IDE_PLUGIN_REQUIRES } from '../../../../shared/pluginCapabilities'

// ── Compile-time interface parity ────────────────────────────────────────────
// The plugin build aliases `composables/hostShell` to this module; if the two
// surfaces drift, these assignments stop type-checking (caught by vue-tsc).
type Host = typeof import('../../../src/composables/hostShell')
type Shim = typeof import('../capabilityShell')
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _shimAssignableToHost: Host = undefined as unknown as Shim
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _hostAssignableToShim: Shim = undefined as unknown as Host

const callCapability = vi.fn(async () => ({ reqId: '1', ok: true }))

beforeEach(() => {
  callCapability.mockClear()
  ;(window as unknown as { nav: unknown }).nav = { callCapability, on: () => () => {}, ready: () => {} }
})

describe('capabilityShell.revealPath', () => {
  it('routes through the ui capability the broker maps to showItemInFolder', async () => {
    await revealPath('/Users/me/project/src/main.ts')
    expect(callCapability).toHaveBeenCalledWith('ui', 'reveal_path', {
      path: '/Users/me/project/src/main.ts',
    })
  })

  it('never touches window.agentTeam — a plugin view has none', async () => {
    // The bug this module fixes: `window.agentTeam?.revealPath(...)` inside a
    // plugin resolves on undefined and no-ops silently.
    expect((window as unknown as { agentTeam?: unknown }).agentTeam).toBeUndefined()
    await revealPath('/tmp/x')
    expect(callCapability).toHaveBeenCalledOnce()
  })

  it('does not throw when the host bridge is missing', async () => {
    delete (window as unknown as { nav?: unknown }).nav
    await expect(revealPath('/tmp/x')).resolves.toBeUndefined()
  })
})

describe('mini-IDE manifest', () => {
  it('requires the ui namespace the broker scopes reveal_path to', () => {
    // planCapabilityCall denies `ui.*` unless the manifest granted `ui`, so
    // dropping it here would silently break reveal again.
    expect(MINI_IDE_PLUGIN_REQUIRES).toContain('ui')
  })
})
