import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  bindBackendPluginActivationCatalog,
  handConfirmKey,
  mintTrustConfirmation,
  waitForHealth,
} from './backend'

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


// -- The trust-confirmation key -----------------------------------------------
//
// The check the backend performs rests entirely on where this key is and is
// not. Until now that rested on comments and one manual sweep; these are what
// notice when it moves.

describe('the trust-confirmation key', () => {
  it('goes over stdin once and closes the pipe', () => {
    // Not a file and not an environment variable, deliberately: `cat` and
    // `ps -E` are the two things a CLI agent on this machine does without
    // trying, and this key is the only thing telling that agent apart from the
    // window a person is looking at.
    const writes: string[] = []
    let ended = false
    const proc = { stdin: { write: (s: string) => writes.push(s), end: () => { ended = true } } }
    handConfirmKey(proc as unknown as Parameters<typeof handConfirmKey>[0])

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/^[0-9a-f]{64}\n$/)
    expect(ended).toBe(true)
  })

  it('is a different key for every backend', () => {
    const first: string[] = []
    const second: string[] = []
    const proc = (into: string[]) =>
      ({ stdin: { write: (s: string) => into.push(s), end: () => {} } }) as unknown as Parameters<
        typeof handConfirmKey
      >[0]
    handConfirmKey(proc(first))
    handConfirmKey(proc(second))
    expect(first[0]).not.toEqual(second[0])
  })

  it('never puts the key anywhere a file or an env dump would show it', () => {
    // A source scan, which is weak evidence in general and the right kind here:
    // what it guards is that nobody adds the convenient line. The key is
    // referenced by exactly one name, so every use of it is greppable.
    const source = readFileSync(resolve(__dirname, 'backend.ts'), 'utf8')
    const uses = source.split('\n').filter((line) => line.includes('confirmKey'))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) {
      expect(line).not.toMatch(/env\[|env\.|process\.env|writeFile|writeFileSync|appendFile/)
    }
  })

  it('signs the same bytes the backend verifies', () => {
    // The one place two languages have to agree. If either side's payload
    // changes shape, every trust action starts refusing and nothing else here
    // would say why - so this recomputes the backend's formula independently
    // rather than calling the same helper.
    const writes: string[] = []
    handConfirmKey({
      stdin: { write: (s: string) => writes.push(s), end: () => {} },
    } as unknown as Parameters<typeof handConfirmKey>[0])
    const key = writes[0].trim()

    const token = mintTrustConfirmation('p2p.trust.device.approve', 'dev-1')
    expect(token).not.toBeNull()
    const payload = [
      'navide/trust-confirm/v1',
      token!.nonce,
      token!.expires,
      'p2p.trust.device.approve',
      'dev-1',
    ].join('\u0000')
    expect(token!.mac).toBe(createHmac('sha256', key).update(payload).digest('hex'))
  })

  it('binds the action and the device, so one token cannot stand in for another', () => {
    handConfirmKey({
      stdin: { write: () => {}, end: () => {} },
    } as unknown as Parameters<typeof handConfirmKey>[0])
    const approve = mintTrustConfirmation('p2p.trust.device.approve', 'dev-1')!
    const block = mintTrustConfirmation('p2p.trust.block', 'dev-1')!
    const other = mintTrustConfirmation('p2p.trust.device.approve', 'dev-2')!
    expect(new Set([approve.mac, block.mac, other.mac]).size).toBe(3)
    // And a fresh nonce each time, which is what makes one-time use possible.
    expect(approve.nonce).not.toBe(other.nonce)
  })
})
