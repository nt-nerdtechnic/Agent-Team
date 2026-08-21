import { describe, it, expect, vi, afterEach } from 'vitest'
import { bindBackendPluginActivationCatalog, waitForHealth } from './backend'

describe('backend plugin activation environment', () => {
  it('replaces directory discovery with a path and exact-byte digest binding', () => {
    expect(
      bindBackendPluginActivationCatalog(
        { AGENT_TEAM_PLUGINS_DIR: '/unsafe-scan', KEEP: 'yes' },
        { path: '/state/catalog.json', sha256: 'a'.repeat(64) }
      )
    ).toEqual({
      KEEP: 'yes',
      AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG: '/state/catalog.json',
      AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG_SHA256: 'a'.repeat(64),
    })
  })
})

// waitForHealth is the low-level poller startBackend() delegates to; testing it
// directly (rather than startBackend, which spawns a real child process and
// touches Electron's `app`) verifies the configured timeout value is actually
// honored end-to-end once threaded through from Settings.
describe('waitForHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves as soon as /health responds ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    await expect(waitForHealth('127.0.0.1', 1234, 5_000)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:1234/health')
  })

  it('gives up around the configured timeout instead of a hardcoded one', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)
    const start = Date.now()
    await expect(waitForHealth('127.0.0.1', 1234, 100)).rejects.toThrow(/did not become healthy within 100ms/)
    // Never healthy — must give up close to the configured bound (~250ms poll
    // granularity), not hang for the old hardcoded 45s.
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  it('keeps retrying until healthy as long as the configured timeout allows it', async () => {
    let calls = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++
      return calls < 3 ? Promise.reject(new Error('not up yet')) : Promise.resolve({ ok: true, status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(waitForHealth('127.0.0.1', 1234, 5_000)).resolves.toBeUndefined()
    expect(calls).toBe(3)
  })
})
