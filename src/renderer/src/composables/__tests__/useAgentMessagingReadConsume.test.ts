import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  QUEUE_CAP,
  READ_RESERVE_TIMEOUT_MS,
  type MessageReason,
  type MessagingDeps,
} from '../useAgentMessaging'

/**
 * reserveIncoming()/settleIncomingRead() is the delivery path the RECIPIENT
 * starts: an agent asks for the messages addressed to it (`cli_read_incoming`)
 * instead of waiting for Navide to type them in, and reading them consumes
 * them.
 *
 * The answer travels back over `ui.invoke` — a 15-second RPC that fails
 * silently — so the property under test throughout is that a message can never
 * be spent by a hand-over that did not land. Every failure mode below has to
 * end with the message still in its queue, in its original position, or with
 * its sender told it genuinely arrived. Nothing may end with it gone.
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — recipient-initiated read', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let deliverGate: ((ok: boolean) => void) | null
  let reports: Array<{ msgKey: string; ok: boolean; reason: MessageReason | null }>
  let updates: Array<{ uid: string; status?: string }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      if (deliverGate) return new Promise<boolean>((res) => { deliverGate = res })
      return true
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    reportDelivery: (msgKey, ok, reason) => {
      reports.push({ msgKey, ok, reason })
    },
    persistUpdate: (rows) => {
      updates.push(...rows)
    },
  }

  /** The ids still waiting for `to`, as the log sees them. `delivering` counts:
   *  a reserved row has not left its queue, which is the whole point. */
  function pending(to: string): string[] {
    return m.messages.value
      .filter((msg) => msg.to === to && (msg.status === 'queued' || msg.status === 'delivering'))
      .map((msg) => msg.content)
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    deliverGate = null
    reports = []
    updates = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'claude', 'target')
    m.registerPane('p3', 'claude', 'sender2')
    m.registerPane('p4', 'claude', 'sender3')
    m.registerPane('p5', 'claude', 'sender4')
  })

  // ── 1. uid → id ───────────────────────────────────────────────────────────
  it('finds a logged message by the uid the store and the MCP tools use', () => {
    idlePanes.clear()
    const first = m.sendMessage('sender', 'target', 'first')
    const second = m.sendMessage('sender', 'target', 'second')

    // The in-memory maps are keyed by a local `id` that restarts at 0 every
    // reload; `uid` is the only key a caller outside this window can hold.
    expect(m.findByUid(first.uid)?.content).toBe('first')
    expect(m.findByUid(second.uid)?.content).toBe('second')
    expect(first.uid).not.toBe(second.uid)
    expect(m.findByUid('nobody:99')).toBeUndefined()
  })

  // ── 2. The head being written into the pane is not the reader's to take ────
  it('refuses the head while it is mid-injection, and reserves the rest', async () => {
    // The injection hangs, so the head stays in flight for the whole test.
    deliverGate = () => {}
    const first = m.sendMessage('sender', 'target', 'first')
    const second = m.sendMessage('sender', 'target', 'second')
    m.pump()
    await flush()
    expect(delivered).toHaveLength(1)

    const taken = m.reserveIncoming('p2', [first.uid, second.uid])

    // Refusing it is the point: the text is already being written into the
    // pane, so handing it to the reader as well would deliver it twice.
    expect(taken.map((t) => t.content)).toEqual(['second'])
    expect(first.status).toBe('delivering')
    expect(first.route).toBeUndefined()
    expect(second.route).toBe('read')
  })

  it('refuses a message queued for a different pane', () => {
    idlePanes.clear()
    const msg = m.sendMessage('sender', 'target', 'for p2 only')

    expect(m.reserveIncoming('p1', [msg.uid])).toEqual([])
    expect(msg.status).toBe('queued')
  })

  // ── 3. Reserving is not consuming ─────────────────────────────────────────
  it('leaves the reserved message in its queue, in its place', () => {
    idlePanes.clear()
    const first = m.sendMessage('sender', 'target', 'first')
    m.sendMessage('sender', 'target', 'second')

    const taken = m.reserveIncoming('p2', [first.uid])
    expect(taken).toEqual([
      {
        uid: first.uid,
        from: 'sender',
        to: 'target',
        content: 'first',
        createdAt: clock,
        remoteWorkspace: undefined,
      },
    ])

    // Still queued, still first, and marked as being handed over rather than
    // gone — the same state pumpPane keeps a message in while its write is
    // unconfirmed.
    expect(first.status).toBe('delivering')
    expect(first.route).toBe('read')
    expect(pending('target')).toEqual(['first', 'second'])
  })

  it('does not let the ordinary paths take a message it has promised away', async () => {
    idlePanes.add('p2')
    const first = m.sendMessage('sender', 'target', 'first')
    m.reserveIncoming('p2', [first.uid])

    // Neither the typed path nor the Stop-hook path may touch it: the reader
    // has been told it is theirs.
    m.pump()
    await flush()
    expect(delivered).toEqual([])
    expect(m.drainForHook('p2')).toBeNull()
    expect(first.status).toBe('delivering')
  })

  // ── 4. A landed hand-over consumes ────────────────────────────────────────
  it('takes the message out of the queue once the read is confirmed', async () => {
    const first = m.sendMessage('sender', 'target', 'first')
    const second = m.sendMessage('sender', 'target', 'second')

    m.reserveIncoming('p2', [first.uid])
    m.settleIncomingRead('p2', [first.uid], true)

    expect(first.status).toBe('delivered')
    expect(first.deliveredAt).toBe(clock)
    expect(pending('target')).toEqual(['second'])

    // The one behind it moves up and goes out the ordinary way — the queue is
    // running again, not stalled behind a consumed row.
    m.pump()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain('second')
    expect(second.status).toBe('delivered')
  })

  it('never types a message that was read', async () => {
    // Read means read: the pane's input box must stay untouched, before and
    // after the reservation is settled.
    const msg = m.sendMessage('sender', 'target', 'run the suite')

    m.reserveIncoming('p2', [msg.uid])
    m.settleIncomingRead('p2', [msg.uid], true)
    m.pump()
    await flush()

    expect(delivered).toEqual([])
    expect(msg.status).toBe('delivered')
  })

  it('gives the freed slot back to the queue cap', () => {
    idlePanes.clear()
    // Two senders, because one pair may only send RATE_LIMIT_MAX (5).
    for (let i = 0; i < 5; i += 1) m.sendMessage('sender', 'target', `a${i}`)
    for (let i = 0; i < QUEUE_CAP - 5; i += 1) m.sendMessage('sender2', 'target', `b${i}`)
    expect(pending('target')).toHaveLength(QUEUE_CAP)

    const head = m.findByUid(m.messages.value[0].uid)!
    m.reserveIncoming('p2', [head.uid])
    // While merely reserved the slot is still occupied — the row has not left.
    // Fresh senders for the two probes: the per-pair rate limit is checked
    // before the cap, and both senders above have spent their budget.
    expect(m.sendMessage('sender3', 'target', 'too many').reason?.key).toBe('queue-full')

    m.settleIncomingRead('p2', [head.uid], true)
    expect(m.sendMessage('sender4', 'target', 'now there is room').status).toBe('queued')
  })

  // ── 5. THE one that matters: a hand-over that did not land ────────────────
  it('returns an unconfirmed message to the queue, unchanged and in place', async () => {
    idlePanes.clear()
    const first = m.sendMessage('sender', 'target', 'first')
    const second = m.sendMessage('sender', 'target', 'second')
    const third = m.sendMessage('sender', 'target', 'third')

    // The reader asked for two and the answer never reached it — the RPC timed
    // out, the tool call was abandoned. Nothing was written to any pane and no
    // agent saw the text, so nothing may have been spent.
    m.reserveIncoming('p2', [first.uid, second.uid])
    m.settleIncomingRead('p2', [first.uid, second.uid], false)

    expect(first.status).toBe('queued')
    expect(first.route).toBeUndefined()
    expect(first.deliveredAt).toBeUndefined()
    expect(second.status).toBe('queued')
    expect(second.route).toBeUndefined()
    expect(third.status).toBe('queued')
    // Same three, same order: a returned message keeps its place in line rather
    // than going to the back of it.
    expect(pending('target')).toEqual(['first', 'second', 'third'])

    // And it is a whole message again, not a husk: the ordinary path delivers
    // it, in order, with its envelope intact.
    idlePanes.add('p2')
    m.pump()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain('first')
    expect(first.status).toBe('delivered')
  })

  it('mirrors the return into the log store, so a reload does not find it mid-flight', () => {
    const msg = m.sendMessage('sender', 'target', 'run the suite')
    m.reserveIncoming('p2', [msg.uid])
    m.settleIncomingRead('p2', [msg.uid], false)

    expect(updates).toEqual([
      { uid: msg.uid, status: 'delivering' },
      { uid: msg.uid, status: 'queued' },
    ])
  })

  it('tells the sending window nothing about a hand-over that did not land', () => {
    idlePanes.clear()
    m.acceptRemoteMessage({
      msgKey: 'k-1',
      targetPaneId: 'p2',
      fromDisplay: 'beta/builder',
      content: 'rebased onto main',
      remoteWorkspace: '/ws/beta',
    })
    const msg = m.messages.value.find((x) => x.content === 'rebased onto main')!

    m.reserveIncoming('p2', [msg.uid])
    expect(reports).toEqual([])
    m.settleIncomingRead('p2', [msg.uid], false)
    expect(reports).toEqual([])
  })

  it('ignores a settle from a pane that holds no such reservation', () => {
    idlePanes.clear()
    const msg = m.sendMessage('sender', 'target', 'first')
    m.reserveIncoming('p2', [msg.uid])

    m.settleIncomingRead('p1', [msg.uid], true)

    expect(msg.status).toBe('delivering')
    expect(pending('target')).toEqual(['first'])
  })

  // ── 6. No settle at all: the RPC simply vanished ──────────────────────────
  it('keeps an unsettled message queued rather than losing it', async () => {
    idlePanes.clear()
    const first = m.sendMessage('sender', 'target', 'first')
    m.sendMessage('sender', 'target', 'second')

    m.reserveIncoming('p2', [first.uid])
    // Nobody ever settles. Time passes, pumps happen.
    m.pump()
    await flush()

    expect(first.status).toBe('delivering')
    expect(first.route).toBe('read')
    expect(first.deliveredAt).toBeUndefined()
    // Reserved, not consumed: it is still in the queue with the one behind it.
    expect(pending('target')).toEqual(['first', 'second'])
  })

  // ── 7. What the sender is told ────────────────────────────────────────────
  it('reports a read message to its sender as arrived, not as failed', () => {
    idlePanes.clear()
    m.acceptRemoteMessage({
      msgKey: 'k-1',
      targetPaneId: 'p2',
      fromDisplay: 'beta/builder',
      content: 'rebased onto main',
      remoteWorkspace: '/ws/beta',
    })
    const msg = m.messages.value.find((x) => x.content === 'rebased onto main')!

    m.reserveIncoming('p2', [msg.uid])
    m.settleIncomingRead('p2', [msg.uid], true)

    // `ok: true` is the load-bearing half. A withdrawn message reports
    // ok: false / 'cancelled' and lands the sender's row on `failed`, which an
    // agent answers by sending the same instruction again — the message DID
    // arrive here, so that would get one job done twice.
    expect(reports).toEqual([{ msgKey: 'k-1', ok: true, reason: { key: 'read' } }])
    expect(msg.status).toBe('delivered')
    expect(msg.status).not.toBe('cancelled')
  })

  it('reports a read cross-workspace message exactly once', () => {
    idlePanes.clear()
    m.acceptRemoteMessage({
      msgKey: 'k-1',
      targetPaneId: 'p2',
      fromDisplay: 'beta/builder',
      content: 'rebased onto main',
    })
    const msg = m.messages.value.find((x) => x.content === 'rebased onto main')!

    m.reserveIncoming('p2', [msg.uid])
    m.settleIncomingRead('p2', [msg.uid], true)
    m.settleIncomingRead('p2', [msg.uid], true)

    expect(reports).toHaveLength(1)
  })

  // ── 8. History ────────────────────────────────────────────────────────────
  it('lets a delivered message be looked up without letting it be read again', async () => {
    const msg = m.sendMessage('sender', 'target', 'run the suite')
    m.pump()
    await flush()
    expect(msg.status).toBe('delivered')

    // Readable as history…
    expect(m.findByUid(msg.uid)?.content).toBe('run the suite')
    // …but there is nothing left to reserve: it already went in, and marking it
    // `delivering` again would put a delivered row back in flight.
    expect(m.reserveIncoming('p2', [msg.uid])).toEqual([])
    expect(msg.status).toBe('delivered')
    expect(msg.deliveredAt).toBe(clock)
  })

  it('refuses a message that already failed', () => {
    const msg = m.sendMessage('sender', 'nobody', 'goes nowhere')
    expect(msg.status).toBe('failed')

    expect(m.reserveIncoming('p2', [msg.uid])).toEqual([])
    expect(msg.status).toBe('failed')
  })

  // ── 9/10. The reservation itself expires ──────────────────────────────────
  it('returns a reservation nobody settled, so the pane cannot go deaf', async () => {
    idlePanes.clear()
    const first = m.sendMessage('sender', 'target', 'first')
    m.sendMessage('sender', 'target', 'second')
    m.reserveIncoming('p2', [first.uid])

    clock += READ_RESERVE_TIMEOUT_MS
    m.pump()
    await flush()

    // Nothing else expires an inbound reservation — expireStaleRemotes only
    // covers OUTBOUND messages — so without this the reserved head would block
    // this pane's queue silently and for good.
    expect(first.status).toBe('queued')
    expect(first.route).toBeUndefined()
    expect(pending('target')).toEqual(['first', 'second'])
    expect(updates).toEqual([
      { uid: first.uid, status: 'delivering' },
      { uid: first.uid, status: 'queued' },
    ])
  })

  it('holds a reservation that is merely slow', () => {
    idlePanes.clear()
    const msg = m.sendMessage('sender', 'target', 'first')
    m.reserveIncoming('p2', [msg.uid])

    clock += READ_RESERVE_TIMEOUT_MS - 1
    m.pump()

    // A settle still in flight must not lose its race with the clock.
    expect(msg.status).toBe('delivering')
    expect(msg.route).toBe('read')
  })

  it('leaves an expired message fully usable — re-readable, then deliverable', async () => {
    idlePanes.clear()
    const msg = m.sendMessage('sender', 'target', 'run the suite')
    m.reserveIncoming('p2', [msg.uid])

    clock += READ_RESERVE_TIMEOUT_MS
    m.pump()
    await flush()

    // Whole, not half-released: it can be reserved again…
    const again = m.reserveIncoming('p2', [msg.uid])
    expect(again.map((t) => t.content)).toEqual(['run the suite'])
    m.settleIncomingRead('p2', [msg.uid], false)

    // …and the pane is receiving again, envelope intact.
    idlePanes.add('p2')
    m.pump()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].paneId).toBe('p2')
    expect(delivered[0].text).toContain('run the suite')
    expect(msg.status).toBe('delivered')
  })
})
