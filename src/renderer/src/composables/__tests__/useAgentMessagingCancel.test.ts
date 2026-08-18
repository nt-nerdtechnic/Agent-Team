import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  encodeReason,
  type MessageReason,
  QUEUE_CAP,
  RATE_LIMIT_MAX,
  type MessagingDeps,
  type PersistedMessageUpdate,
} from '../useAgentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — cancel', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  /** Set to hold the next injection open, so a message can be caught in flight. */
  let deliverGate: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null
  let updates: PersistedMessageUpdate[]
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  let cancelRequests: string[]
  let cancelRequestFails: boolean
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      return deliverGate ? deliverGate.promise : true
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason })
    },
    requestRemoteCancel: (msgKey) => {
      cancelRequests.push(msgKey)
      return cancelRequestFails ? Promise.reject(new Error('socket down')) : Promise.resolve()
    },
    routeRemote: async () => ({ ok: true, targetWorkspacePath: '/ws/beta' }),
    persistUpdate: (rows) => {
      updates.push(...rows)
    },
  }

  function openGate(): { resolve: (ok: boolean) => void } {
    let resolve!: (ok: boolean) => void
    const promise = new Promise<boolean>((r) => {
      resolve = r
    })
    deliverGate = { promise, resolve }
    return { resolve }
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    deliverGate = null
    updates = []
    reports = []
    cancelRequests = []
    cancelRequestFails = false
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  // ── Local queue ──────────────────────────────────────────────────────────
  it('withdraws a queued message so it is never injected', () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
    idlePanes.delete('p2') // busy, so the message sits in the queue
    const msg = m.sendMessage('sender', 'target', 'never mind')

    expect(m.cancelMessage(msg.id)).toBe(true)
    expect(msg.status).toBe('cancelled')

    idlePanes.add('p2')
    m.pump()
    expect(delivered).toEqual([])
  })

  it('lets the message behind it through', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
    idlePanes.delete('p2')
    const first = m.sendMessage('sender', 'target', 'first')
    m.sendMessage('sender', 'target', 'second')

    expect(m.cancelMessage(first.id)).toBe(true)
    idlePanes.add('p2')
    m.pump()
    await flush()

    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain('second')
  })

  it('is too late once the injection has started', async () => {
    const gate = openGate()
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
    const msg = m.sendMessage('sender', 'target', 'going in')
    m.pump()
    await flush()

    expect(msg.status).toBe('delivering')
    expect(m.cancelMessage(msg.id)).toBe(false)

    gate.resolve(true)
    await flush()
    expect(msg.status).toBe('delivered')
  })

  it('withdraws a waiting message while the one ahead of it is going in', async () => {
    const gate = openGate()
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
    const head = m.sendMessage('sender', 'target', 'in flight')
    const behind = m.sendMessage('sender', 'target', 'never mind')
    m.pump()
    await flush()
    expect(head.status).toBe('delivering')

    expect(m.cancelMessage(behind.id)).toBe(true)

    gate.resolve(true)
    await flush()
    expect(head.status).toBe('delivered')
    m.pump()
    await flush()
    expect(delivered.map((d) => d.text.includes('never mind'))).toEqual([false])
  })

  it('is too late once the message has been delivered', async () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
    const msg = m.sendMessage('sender', 'target', 'gone')
    m.pump()
    await flush()

    expect(msg.status).toBe('delivered')
    expect(m.cancelMessage(msg.id)).toBe(false)
    expect(msg.status).toBe('delivered')
  })

  it('tells nobody: a withdrawal is not a delivery failure', () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
    idlePanes.delete('p2')
    const msg = m.sendMessage('sender', 'target', 'never mind')

    m.cancelMessage(msg.id)

    // No failure notice was queued back to the sending pane, and the row
    // carries no failure reason to display.
    expect(m.messages.value).toHaveLength(1)
    expect(msg.reason).toBeUndefined()
    expect(updates).toContainEqual({ uid: msg.uid, status: 'cancelled' })
  })

  it('re-sends a withdrawn message as a brand-new one', () => {
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
    idlePanes.delete('p2')
    const msg = m.sendMessage('sender', 'target', 'on second thought')
    m.cancelMessage(msg.id)

    const again = m.retryMessage(msg.id)
    expect(again?.status).toBe('queued')
    expect(again?.content).toBe('on second thought')
  })

  // ── Cross-workspace ──────────────────────────────────────────────────────
  it('asks the window that owns the queue, and lands on its answer', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'never mind')
    await flush()
    expect(msg.hold?.key).toBe('remote-ack')

    expect(m.cancelMessage(msg.id)).toBe(true)
    expect(cancelRequests).toHaveLength(1)
    expect(msg.hold).toEqual({ key: 'cancelling' })
    // Still queued: the other window decides.
    expect(msg.status).toBe('queued')

    m.resolveRemoteDelivery(cancelRequests[0], false, encodeReason({ key: 'cancelled' }))
    expect(msg.status).toBe('cancelled')
    expect(msg.reason).toBeUndefined()
    expect(msg.hold).toBeUndefined()
  })

  it('keeps a message that was delivered while the withdrawal was in flight', async () => {
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'too late')
    await flush()
    m.cancelMessage(msg.id)

    m.resolveRemoteDelivery(cancelRequests[0], true, '')
    expect(msg.status).toBe('delivered')
  })

  it('puts the row back when the request never leaves this machine', async () => {
    cancelRequestFails = true
    m.registerPane('p1', 'claude', 'sender')
    const msg = m.sendMessage('sender', 'beta/reviewer', 'never mind')
    await flush()

    expect(m.cancelMessage(msg.id)).toBe(true)
    await flush()
    expect(msg.hold).toEqual({ key: 'remote-ack' })
    expect(msg.status).toBe('queued')
  })

  it('settles both rows when sender and target are panes of the same window', async () => {
    // A workspace-qualified address can resolve back into this window, and then
    // one message has two rows here: the outbound one dispatchRemote logged and
    // the inbound one the deliver broadcast produced. Both must end withdrawn,
    // and the loop must not double-report.
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
    idlePanes.delete('p2')
    const outbound = m.sendMessage('sender', 'alpha/target', 'never mind')
    await flush()
    const msgKey = 'p1:1'
    // What App.vue does with the backend's agent_msg.deliver broadcast.
    expect(
      m.noteOutboundMessage({
        msgKey,
        fromPaneId: 'p1',
        targetPaneId: 'p2',
        toDisplay: 'alpha/target',
        content: 'never mind',
        crossWorkspace: false,
      })
    ).toBe(false) // already logged by dispatchRemote — no duplicate row
    m.acceptRemoteMessage({
      msgKey,
      targetPaneId: 'p2',
      fromDisplay: 'sender',
      content: 'never mind',
    })
    const inbound = m.messages.value[1]
    expect(m.messages.value).toHaveLength(2)

    expect(m.cancelMessage(outbound.id)).toBe(true)
    // The cancel broadcast comes back to this same window.
    expect(m.cancelRemoteInbound(cancelRequests[0])).toBe(true)
    expect(inbound.status).toBe('cancelled')
    // …and the report it produced resolves the outbound row.
    expect(reports).toHaveLength(1)
    m.resolveRemoteDelivery(reports[0].msgKey, false, encodeReason(reports[0].reason!))
    expect(outbound.status).toBe('cancelled')

    idlePanes.add('p2')
    m.pump()
    await flush()
    expect(delivered).toEqual([])
  })

  // ── Receiving side ───────────────────────────────────────────────────────
  it('drops an inbound message on request and reports it back', () => {
    m.registerPane('p2', 'codex', 'target')
    idlePanes.delete('p2')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'never mind',
    })
    const inbound = m.messages.value[0]

    expect(m.cancelRemoteInbound('k1')).toBe(true)
    expect(inbound.status).toBe('cancelled')
    expect(reports).toEqual([{ msgKey: 'k1', ok: false, reason: { key: 'cancelled' } }])

    idlePanes.add('p2')
    m.pump()
    expect(delivered).toEqual([])
  })

  it('refuses once the inbound message is going in, and reports nothing', async () => {
    const gate = openGate()
    m.registerPane('p2', 'codex', 'target')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'too late',
    })
    await flush()
    const inbound = m.messages.value[0]
    expect(inbound.status).toBe('delivering')

    expect(m.cancelRemoteInbound('k1')).toBe(false)
    expect(reports).toEqual([])

    gate.resolve(true)
    await flush()
    expect(reports).toEqual([{ msgKey: 'k1', ok: true, reason: null }])
  })

  it('ignores a key it does not hold', () => {
    m.registerPane('p2', 'codex', 'target')
    expect(m.cancelRemoteInbound('nobody')).toBe(false)
    expect(reports).toEqual([])
  })

  // ── Interaction with the rest of the machinery ───────────────────────────
  it('gives the freed slot back to the queue cap', () => {
    m.registerPane('p2', 'codex', 'target')
    idlePanes.delete('p2')
    // One pair may only send RATE_LIMIT_MAX before its own guard stops it, so
    // the cap is reached with several senders.
    const senders = Array.from({ length: QUEUE_CAP / RATE_LIMIT_MAX }, (_, i) =>
      m.registerPane(`s${i}`, 'claude', `sender-${i}`)
    )
    const sent = senders.flatMap((from) =>
      Array.from({ length: RATE_LIMIT_MAX }, (_, i) => m.sendMessage(from, 'target', `${from}-${i}`))
    )
    expect(sent).toHaveLength(QUEUE_CAP)
    expect(sent.every((msg) => msg.status === 'queued')).toBe(true)

    // Full: a sender with budget left is still refused.
    const extra = m.registerPane('sx', 'codex', 'late')
    expect(m.sendMessage(extra, 'target', 'overflow').reason?.key).toBe('queue-full')

    m.cancelMessage(sent[3].id)
    expect(m.sendMessage(extra, 'target', 'now there is room').status).toBe('queued')
  })

  it('leaves a withdrawn row withdrawn after a reload, and clears it with the log', () => {
    m.hydrateLog([
      {
        uid: 'oldboot:1',
        created_at: 10,
        status: 'cancelled',
        sender: 'sender',
        recipient: 'target',
        content: 'withdrawn last session',
      },
    ])
    // Not coerced the way an in-flight row is: nothing was lost with the window.
    expect(m.messages.value[0].status).toBe('cancelled')

    m.clearMessageLog()
    expect(m.messages.value).toEqual([])
  })

  it('can be withdrawn again after a Stop-hook reservation was released', () => {
    m.registerPane('p2', 'codex', 'target')
    idlePanes.delete('p2')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'never mind',
    })
    const inbound = m.messages.value[0]

    // Reserved for a Stop hook: held in flight, so it cannot be taken.
    expect(m.drainForHook('p2')).not.toBeNull()
    expect(m.cancelMessage(inbound.id)).toBe(false)

    // The hook gave up before its answer arrived — nothing was written.
    m.settleHookDrain('p2', false)
    expect(inbound.status).toBe('queued')
    expect(m.cancelMessage(inbound.id)).toBe(true)
    expect(inbound.status).toBe('cancelled')
    expect(reports).toEqual([{ msgKey: 'k1', ok: false, reason: { key: 'cancelled' } }])
  })
})
