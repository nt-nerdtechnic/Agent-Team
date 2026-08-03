import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  RATE_LIMIT_MAX,
  QUEUE_CAP,
  type MessagingDeps,
  type RouteResult,
} from '../useAgentMessaging'
import { MSG_ENVELOPE_PREFIX } from '../../lib/agentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — cross-workspace routing', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let deliverResult: boolean
  let routed: Array<{ fromPaneId: string; fromName: string; to: string; content: string; msgKey: string }>
  let routeResult: RouteResult
  let reports: Array<{ msgKey: string; ok: boolean; reason: string }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      return deliverResult
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    routeRemote: async (args) => {
      routed.push(args)
      return routeResult
    },
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason })
    },
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    deliverResult = true
    routed = []
    routeResult = { ok: true, targetDisplay: 'beta/reviewer', targetWorkspacePath: '/ws/beta' }
    reports = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  // ── Outbound ─────────────────────────────────────────────────────────────
  it('routes a qualified target this window does not own', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'run the tests')
    await flush()

    expect(routed).toHaveLength(1)
    expect(routed[0]).toMatchObject({
      fromPaneId: 'p1',
      fromName: 'sender',
      to: 'beta/reviewer',
      content: 'run the tests',
    })
    expect(msg.status).toBe('queued')
    expect(msg.remote).toBe('outbound')
    expect(msg.remoteWorkspace).toBe('/ws/beta')
  })

  it('leaves an unqualified unknown target failing immediately, as before', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'nobody', 'hi')
    await flush()

    expect(routed).toEqual([])
    expect(msg.status).toBe('failed')
    expect(msg.reason).toContain('unknown target')
  })

  it('prefers a local pane whose own name contains a slash', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'fix/bug')
    const msg = m.sendMessage('sender', 'fix/bug', 'local please')
    await flush()

    expect(routed).toEqual([])
    expect(msg.status).toBe('queued')
    expect(msg.remote).toBeUndefined()
  })

  it('fails the message when the backend cannot resolve the target', async () => {
    m.registerPane('p1', 'claude', 'sender')
    routeResult = { ok: false, error: 'unknown workspace "gamma"' }
    const msg = m.sendMessage('sender', 'gamma/reviewer', 'hi')
    await flush()

    expect(msg.status).toBe('failed')
    expect(msg.reason).toContain('unknown workspace')
  })

  it('reports a routing exception rather than hanging in queued', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.configureMessaging({
      ...deps,
      routeRemote: async () => {
        throw new Error('backend down')
      },
    })
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    expect(msg.status).toBe('failed')
    expect(msg.reason).toContain('backend down')
  })

  it('degrades to the old local-only failure when no router is configured', async () => {
    m.configureMessaging({
      now: deps.now,
      deliver: deps.deliver,
      isPaneIdle: deps.isPaneIdle,
    })
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    expect(msg.status).toBe('failed')
    expect(msg.reason).toContain('unknown target')
  })

  it('applies the per-pair rate limit to cross-workspace sends', async () => {
    m.registerPane('p1', 'claude', 'sender')
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      m.sendMessage('sender', 'beta/reviewer', `msg ${i}`)
    }
    await flush()
    const blocked = m.sendMessage('sender', 'beta/reviewer', 'one too many')
    await flush()

    expect(routed).toHaveLength(RATE_LIMIT_MAX)
    expect(blocked.status).toBe('failed')
    expect(blocked.reason).toContain('rate limit')
  })

  it('refuses to route when the sender is not a registered pane', async () => {
    const msg = m.sendMessage('Navide', 'beta/reviewer', 'hi')
    await flush()

    expect(routed).toEqual([])
    expect(msg.status).toBe('failed')
  })

  // ── Delivery result ──────────────────────────────────────────────────────
  it('marks the outbound entry delivered when the receiver reports success', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.resolveRemoteDelivery(routed[0].msgKey, true, '')
    expect(msg.status).toBe('delivered')
    expect(msg.deliveredAt).toBe(clock)
  })

  it('marks the outbound entry failed with the receiver reason', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.resolveRemoteDelivery(routed[0].msgKey, false, 'injection failed (echo not verified)')
    expect(msg.status).toBe('failed')
    expect(msg.reason).toContain('echo not verified')
  })

  it('ignores a delivery result belonging to another window', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.resolveRemoteDelivery('someone-else:7', true, '')
    expect(msg.status).toBe('queued')
  })

  // ── Inbound ──────────────────────────────────────────────────────────────
  it('rejects a delivery whose target pane is not in this window', () => {
    m.registerPane('p1', 'claude', 'local')
    const accepted = m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'not-ours',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    expect(accepted).toBe(false)
    expect(m.messages.value).toHaveLength(0)
  })

  it('delivers an inbound message through the normal queue and reports back', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    const accepted = m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'run the tests',
      remoteWorkspace: '/ws/alpha',
    })
    expect(accepted).toBe(true)
    await flush()

    expect(delivered).toHaveLength(1)
    expect(delivered[0].paneId).toBe('p2')
    expect(delivered[0].text).toContain(`${MSG_ENVELOPE_PREFIX} alpha/sender`)
    expect(delivered[0].text).toContain('run the tests')
    expect(reports).toEqual([{ msgKey: 'k1', ok: true, reason: '' }])

    const entry = m.messages.value[0]
    expect(entry.remote).toBe('inbound')
    expect(entry.from).toBe('alpha/sender')
    expect(entry.to).toBe('reviewer')
    expect(entry.status).toBe('delivered')
  })

  it('honours the idle gate for inbound messages', async () => {
    m.registerPane('p3', 'claude', 'busy')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p3',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    await flush()
    expect(delivered).toEqual([])
    expect(reports).toEqual([])

    idlePanes.add('p3')
    m.pump()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(reports[0].ok).toBe(true)
  })

  it('reports a failed injection back to the sending window', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    deliverResult = false
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    await flush()

    expect(reports).toHaveLength(1)
    expect(reports[0].ok).toBe(false)
    expect(reports[0].reason).toContain('echo not verified')
  })

  it('applies the rate limit to inbound messages that ask for it', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      m.acceptRemoteMessage({
        msgKey: `k${i}`,
        targetPaneId: 'p2',
        fromDisplay: 'alpha/spammer',
        content: `msg ${i}`,
        rateLimit: true,
      })
      await flush()
    }
    reports = []
    m.acceptRemoteMessage({
      msgKey: 'over',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/spammer',
      content: 'one too many',
      rateLimit: true,
    })
    await flush()

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ msgKey: 'over', ok: false })
    expect(reports[0].reason).toContain('rate limit')
    expect(delivered).toHaveLength(RATE_LIMIT_MAX)
  })

  it('leaves inbound messages that carry their own accounting unlimited', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    for (let i = 0; i < RATE_LIMIT_MAX + 2; i++) {
      m.acceptRemoteMessage({
        msgKey: `k${i}`,
        targetPaneId: 'p2',
        fromDisplay: 'alpha/sender',
        content: `msg ${i}`,
      })
      await flush()
    }
    expect(delivered).toHaveLength(RATE_LIMIT_MAX + 2)
  })

  it('rejects an inbound message when the target queue is full', async () => {
    m.registerPane('p3', 'claude', 'busy') // not idle → queue never drains
    for (let i = 0; i < QUEUE_CAP; i++) {
      m.acceptRemoteMessage({
        msgKey: `k${i}`,
        targetPaneId: 'p3',
        fromDisplay: 'alpha/sender',
        content: `msg ${i}`,
      })
    }
    reports = []
    const accepted = m.acceptRemoteMessage({
      msgKey: 'overflow',
      targetPaneId: 'p3',
      fromDisplay: 'alpha/sender',
      content: 'too much',
    })

    expect(accepted).toBe(true)
    expect(reports).toEqual([
      { msgKey: 'overflow', ok: false, reason: `target queue full (${QUEUE_CAP})` },
    ])
  })

  it('sanitizes markers in inbound content so it cannot re-trigger the parser', async () => {
    m.registerPane('p2', 'claude', 'reviewer')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'nested ---MSG-START--- to: someone',
    })
    await flush()

    // The forwarded body is broken up; the reply hint's own markers are the
    // envelope's, not the sender's, and stay intact by design.
    expect(delivered[0].text).toContain('nested -​--MSG-START-​--')
    expect(delivered[0].text).not.toContain('nested ---MSG-START---')
  })

  it('reports back when the target pane closes before its queue drains', async () => {
    m.registerPane('p3', 'claude', 'busy') // not idle → stays queued
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p3',
      fromDisplay: 'alpha/sender',
      content: 'hi',
    })
    await flush()
    expect(reports).toEqual([])

    m.unregisterPane('p3')
    expect(reports).toEqual([{ msgKey: 'k1', ok: false, reason: 'target pane closed' }])
  })

  it('fails an outbound message whose target window never reports back', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()
    expect(msg.status).toBe('queued')

    clock += 29 * 60_000
    m.pump()
    expect(msg.status).toBe('queued')

    clock += 2 * 60_000
    m.pump()
    expect(msg.status).toBe('failed')
    expect(msg.reason).toContain('no delivery report')
  })

  it('expires stale outbound messages even while delivery is paused', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'hi')
    await flush()

    m.pauseMessaging()
    clock += 31 * 60_000
    m.pump()
    expect(msg.status).toBe('failed')
  })

  it('does not hand out a fresh rate-limit budget per target spelling', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const spellings = [
      'beta/reviewer',
      '/ws/beta/reviewer',
      'parent/beta/reviewer',
      'beta/reviewer',
      '/ws/beta/reviewer',
    ]
    for (const to of spellings) m.sendMessage('sender', to, 'hi')
    await flush()
    const blocked = m.sendMessage('sender', 'parent/beta/reviewer', 'one too many')
    await flush()

    expect(routed).toHaveLength(RATE_LIMIT_MAX)
    expect(blocked.status).toBe('failed')
    expect(blocked.reason).toContain('rate limit')
  })

  it('keeps separate rate-limit budgets for local panes whose names contain a slash', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'claude', 'fix/bug')
    m.registerPane('p3', 'claude', 'feat/bug')
    for (let i = 0; i < RATE_LIMIT_MAX; i++) m.sendMessage('sender', 'fix/bug', `m${i}`)
    const other = m.sendMessage('sender', 'feat/bug', 'still allowed')
    await flush()

    expect(other.status).not.toBe('failed')
    expect(routed).toEqual([])
  })

  it('local same-workspace delivery is untouched by the remote wiring', async () => {
    m.registerPane('p1', 'claude', 'a')
    m.registerPane('p2', 'claude', 'b')
    const msg = m.sendMessage('a', 'b', 'hello')
    m.pump()
    await flush()

    expect(routed).toEqual([])
    expect(reports).toEqual([])
    expect(msg.status).toBe('delivered')
    expect(delivered[0].paneId).toBe('p2')
  })
})
