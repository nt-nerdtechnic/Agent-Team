import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  NOTICE_SENDER,
  STALE_HOLD_MS,
  type AgentMessage,
  type MessagingDeps,
} from '../useAgentMessaging'
import { MSG_STALE_PREFIX, MSG_NOTICE_PREFIX, MSG_START } from '../../lib/agentMessaging'

/**
 * Telling a sending pane its message is STILL QUEUED — the gap between "it
 * failed" (already reported) and "it went in" (nothing to report).
 *
 * The risk here is volume, not correctness of the text: the sweep runs on every
 * pump tick, so what these assert is that a stuck message costs its sender one
 * notice, ever, and that nothing which is not stuck produces one at all.
 */
describe('useAgentMessaging — still-held notices', () => {
  let clock: number
  let idlePanes: Set<string>
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async () => true,
    isPaneIdle: (paneId) => idlePanes.has(paneId),
    idleHoldKey: (paneId) => (idlePanes.has(paneId) ? null : 'typing'),
    reportDelivery: () => {
      /* the outcome path has its own tests */
    },
  }

  const notices = (): readonly AgentMessage[] =>
    m.messages.value.filter((entry) => entry.from === NOTICE_SENDER)

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    // p2 is busy from the outset: everything sent to it stays queued.
    idlePanes = new Set(['p1'])
    m = useAgentMessaging()
    m.configureMessaging(deps)
    m.registerPane('p1', 'claude', 'sender')
    m.registerPane('p2', 'codex', 'target')
  })

  it('tells the sender once the message has been held past the threshold', () => {
    m.sendMessage('sender', 'target', 'please review src/main.ts')
    m.pump()
    expect(notices()).toHaveLength(0)

    clock += STALE_HOLD_MS
    m.pump()

    expect(notices()).toHaveLength(1)
    const notice = notices()[0]
    expect(notice.to).toBe('sender')
    expect(notice.kind).toBe('notice')
    // First line separates this from a bounce: nothing failed.
    expect(notice.content.startsWith(`${MSG_STALE_PREFIX} — to: target`)).toBe(true)
    expect(notice.content).not.toContain(MSG_NOTICE_PREFIX)
    // English regardless of the user's UI locale — the agent reads this.
    expect(notice.content).toContain('reason: Someone is typing in the target pane')
    expect(notice.content).toContain('waiting 2 min so far')
    expect(notice.content).toContain('please review src/main.ts')
    // Nothing invites a reply: `Navide` is not an address.
    expect(notice.content).not.toContain(MSG_START)
  })

  it('says it once, not once per tick', () => {
    m.sendMessage('sender', 'target', 'hi')
    clock += STALE_HOLD_MS

    for (let i = 0; i < 10; i++) {
      m.pump()
      clock += 1000
    }

    expect(notices()).toHaveLength(1)
  })

  it('says nothing before the threshold', () => {
    m.sendMessage('sender', 'target', 'hi')

    clock += STALE_HOLD_MS - 1
    m.pump()

    expect(notices()).toHaveLength(0)
  })

  it('says nothing about a message that went in', async () => {
    idlePanes.add('p2')
    m.sendMessage('sender', 'target', 'hi')
    m.pump()
    await new Promise((r) => setTimeout(r, 0))
    expect(m.messages.value[0].status).toBe('delivered')

    clock += STALE_HOLD_MS * 10
    m.pump()

    expect(notices()).toHaveLength(0)
  })

  it('never reports a notice being held, so notices cannot breed', () => {
    // The sender is busy too, so its own notice queues behind nothing and stays.
    m.sendMessage('sender', 'target', 'hi')
    clock += STALE_HOLD_MS
    m.pump()
    expect(notices()).toHaveLength(1)

    clock += STALE_HOLD_MS * 3
    for (let i = 0; i < 5; i++) m.pump()

    expect(notices()).toHaveLength(1)
  })

  it('says nothing when the sender is not a pane in this window', () => {
    // An MCP cli_send from elsewhere: there is no local pane to inject into,
    // and that caller reads cli_inbox_summary instead.
    m.acceptRemoteMessage({
      msgKey: 'mcp:1',
      targetPaneId: 'p2',
      fromDisplay: 'an external client',
      content: 'do the thing',
    })

    clock += STALE_HOLD_MS
    m.pump()

    expect(notices()).toHaveLength(0)
  })

  it('says nothing while delivery is paused', () => {
    // Everything is held on purpose, and the notice would join the same stopped
    // queue — so it is not news, and it could not be delivered either.
    m.sendMessage('sender', 'target', 'hi')
    m.pauseMessaging()

    clock += STALE_HOLD_MS
    m.pump()

    expect(notices()).toHaveLength(0)
  })
})
