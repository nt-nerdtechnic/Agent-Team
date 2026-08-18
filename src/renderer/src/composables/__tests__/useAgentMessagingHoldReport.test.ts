import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  type MessageHold,
  type MessagingDeps,
} from '../useAgentMessaging'

/**
 * Reporting a hold back to the backend, so an MCP caller can see WHY its
 * message is still queued rather than only that it is.
 *
 * The whole cost of this feature is on the wire, so that is what these assert:
 * a report on every real change of the reason, and not one message more — not
 * per pump tick, not for a message the backend does not know, and not after it
 * has been told the outcome.
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging — hold reporting', () => {
  let clock: number
  let idlePanes: Set<string>
  let holdKeys: Map<string, string>
  let deliverResult: boolean
  let holds: Array<{ msgKey: string; hold: MessageHold | null }>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async () => deliverResult,
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    idleHoldKey: (paneId) => (idlePanes.has(paneId) ? null : holdKeys.get(paneId) ?? 'busy'),
    reportDelivery: () => { /* the outcome path has its own tests */ },
    reportHold: (msgKey, hold) => {
      holds.push({ msgKey, hold })
    },
  }

  /** An MCP cli_send arriving for a pane in this window. */
  function accept(msgKey: string, content = 'do the thing'): boolean {
    return m.acceptRemoteMessage({
      msgKey,
      targetPaneId: 'p2',
      fromDisplay: 'an external client',
      content,
    })
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1'])
    holdKeys = new Map([['p2', 'typing']])
    deliverResult = true
    holds = []
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
  })

  it('reports the reason a tracked message is held', () => {
    accept('mcp:1')

    expect(holds).toEqual([{ msgKey: 'mcp:1', hold: { key: 'typing' } }])
  })

  it('does not report again while the reason stays the same', () => {
    accept('mcp:1')
    holds = []

    for (let i = 0; i < 5; i++) m.pump()

    expect(holds).toEqual([])
  })

  it('reports each time the reason changes', () => {
    accept('mcp:1')
    holdKeys.set('p2', 'mid-turn')
    m.pump()
    holdKeys.set('p2', 'settling')
    m.pump()

    expect(holds.map((h) => h.hold?.key)).toEqual(['typing', 'mid-turn', 'settling'])
  })

  it('says nothing when a re-annotation changes nothing', () => {
    accept('mcp:1')
    accept('mcp:2')
    accept('mcp:3')
    holds = []

    m.pump()

    expect(holds).toEqual([])
  })

  it('ignores a queue position moving up, which explains nothing new', () => {
    // The one case the key-only guard is for. Withdraw the head and the queue
    // shuffles: the new head's reason genuinely changed (`behind` → whatever is
    // holding the pane), but the message behind it only went from third to
    // second — same reason, new number, and nothing an MCP caller can act on.
    accept('mcp:1', 'first')
    accept('mcp:2', 'second')
    accept('mcp:3', 'third')
    m.pump()
    holds = []

    const first = m.messages.value.find((x) => x.content === 'first')
    expect(first && m.cancelMessage(first.id)).toBe(true)
    m.pump()

    expect(holds).toEqual([{ msgKey: 'mcp:2', hold: { key: 'typing' } }])
  })

  it('reports the hold clearing when the pane frees up', async () => {
    accept('mcp:1')
    holds = []
    idlePanes.add('p2')

    m.pump()
    await flush()

    expect(holds).toEqual([{ msgKey: 'mcp:1', hold: null }])
  })

  it('stops reporting once the message has been delivered', async () => {
    accept('mcp:1')
    idlePanes.add('p2')
    m.pump()
    await flush()
    holds = []

    // The pane goes back to being typed in; the delivered message is nobody's
    // business any more, and the backend already cleared its hold.
    idlePanes.delete('p2')
    m.pump()

    expect(holds).toEqual([])
  })

  it('stops reporting once the message has failed', async () => {
    deliverResult = false
    accept('mcp:1')
    idlePanes.add('p2')
    m.pump()
    await flush()
    holds = []

    idlePanes.delete('p2')
    m.pump()

    expect(holds).toEqual([])
  })

  it('says nothing about a message the backend does not know', () => {
    // A pane-to-pane send inside this window has no msg_key anywhere else.
    m.sendMessage('sender', 'target', 'hello')

    expect(holds).toEqual([])
  })

  it('reports the global pause, which is a hold like any other', () => {
    accept('mcp:1')
    holds = []

    m.pauseMessaging()

    expect(holds).toEqual([{ msgKey: 'mcp:1', hold: { key: 'paused' } }])
  })
})
