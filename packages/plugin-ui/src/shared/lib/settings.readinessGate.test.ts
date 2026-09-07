// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Before the authoritative snapshot lands, the cache reads empty — which a
// consumer cannot tell apart from "the user never set this". Anything written
// in that window is a default about to bury a real preference, and reconcile()
// will not fix it because a pending key beats the server value. So the queue is
// held until the snapshot arrives, and only then sent.

afterEach(() => { vi.resetModules() })

/** A backend whose snapshot is resolved by the test, not by the harness. */
async function pendingSnapshotHarness(opts: { ownedKeys?: readonly string[] } = {}) {
  vi.resetModules()
  const settings = await import('./settings')
  const setMany = vi.fn(async () => undefined)
  let landSnapshot: (value: Record<string, unknown>) => void = () => undefined
  const snapshot = new Promise<Record<string, unknown>>((resolve) => { landSnapshot = resolve })
  settings.initSettingsBackend({
    status: ref<'connected' | 'disconnected'>('connected'),
    ...(opts.ownedKeys ? { ownedKeys: opts.ownedKeys } : {}),
    getAll: () => snapshot,
    setMany,
    onChanged: () => () => undefined,
  })
  return { settings, setMany, landSnapshot }
}

describe('writes are held until the settings snapshot is authoritative', () => {
  it('covers a port that declares no ownedKeys — the main window', async () => {
    // The gate used to require `ownedKeys`, which no host port sets. The main
    // window — the one whose consumers promote workspace fallbacks — was
    // therefore the only surface it never protected.
    const { settings, setMany, landSnapshot } = await pendingSnapshotHarness()
    expect(settings.settingsReadiness.status).toBe('pending')

    settings.settingsSet('agent-team:theme', '"light"')
    settings.flushSettingsOnExit()
    expect(setMany).not.toHaveBeenCalled()

    landSnapshot({ 'agent-team:theme': '"dark-github"' })
    await vi.waitFor(() => expect(settings.settingsReadiness.status).toBe('ready'))
    expect(setMany).toHaveBeenCalledWith(expect.objectContaining({ 'agent-team:theme': '"light"' }))
  })

  it('still holds writes for an owned store', async () => {
    const { settings, setMany, landSnapshot } = await pendingSnapshotHarness({
      ownedKeys: ['agentTeam.git.logScope'],
    })

    settings.settingsSet('agentTeam.git.logScope', 'current')
    settings.flushSettingsOnExit()
    expect(setMany).not.toHaveBeenCalled()

    landSnapshot({ 'agentTeam.git.logScope': 'all' })
    await vi.waitFor(() => expect(settings.settingsReadiness.status).toBe('ready'))
    expect(setMany).toHaveBeenCalledWith(expect.objectContaining({ 'agentTeam.git.logScope': 'current' }))
  })

  it('holds the write rather than dropping it', async () => {
    // The value must stay readable and stay queued: holding is a delay, not a
    // discard. A dropped write would be a worse bug than the one being fixed.
    const { settings, landSnapshot } = await pendingSnapshotHarness()

    settings.settingsSet('agent-team:language', 'en-US')
    settings.flushSettingsOnExit()
    expect(settings.settingsGet('agent-team:language', 'missing')).toBe('en-US')

    landSnapshot({})
    await vi.waitFor(() => expect(settings.settingsReadiness.status).toBe('ready'))
    expect(settings.settingsGet('agent-team:language', 'missing')).toBe('en-US')
  })

  it('keeps the local write when the snapshot disagrees', async () => {
    // reconcile() lets a pending key beat the server value. That is correct for
    // a write the user actually made — and is exactly why a fallback write made
    // before this point could never be corrected.
    const { settings, landSnapshot } = await pendingSnapshotHarness()

    settings.settingsSet('agent-team:theme', '"light"')
    landSnapshot({ 'agent-team:theme': '"dark-github"' })
    await vi.waitFor(() => expect(settings.settingsReadiness.status).toBe('ready'))

    expect(settings.settingsGet('agent-team:theme', 'missing')).toBe('"light"')
  })
})
