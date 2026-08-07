import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  isBroadcastTarget,
  RATE_LIMIT_MAX,
  QUEUE_CAP,
  type MessagingDeps,
  type PersistedMessageRow,
  type PersistedMessageUpdate,
} from '../useAgentMessaging'
import { MSG_ENVELOPE_PREFIX } from '../../lib/agentMessaging'

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('useAgentMessaging', () => {
  let clock: number
  let idlePanes: Set<string>
  let delivered: Array<{ paneId: string; text: string }>
  let deliverResult: boolean
  let m: ReturnType<typeof useAgentMessaging>

  const deps: MessagingDeps = {
    now: () => clock,
    deliver: async (paneId, text) => {
      delivered.push({ paneId, text })
      return deliverResult
    },
    isPaneIdle: (paneId) => idlePanes.has(paneId),
  }

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set(['p1', 'p2'])
    delivered = []
    deliverResult = true
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  describe('name registry', () => {
    it('auto-assigns unique names per agentKey', () => {
      expect(m.registerPane('p1', 'claude')).toBe('claude-1')
      expect(m.registerPane('p2', 'claude')).toBe('claude-2')
      expect(m.registerPane('p3', 'codex')).toBe('codex-1')
    })

    it('is idempotent per pane and honors a free preferred name', () => {
      expect(m.registerPane('p1', 'claude', 'Backend A')).toBe('Backend A')
      expect(m.registerPane('p1', 'claude')).toBe('Backend A')
      // A taken preferred name keeps its base and gains a -N suffix.
      expect(m.registerPane('p2', 'claude', 'Backend A')).toBe('Backend A-2')
    })

    it('rename enforces validity and uniqueness', () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      expect(m.renamePane('p1', '前端組')).toBe(true)
      expect(m.nameOf('p1')).toBe('前端組')
      expect(m.paneIdOf('前端組')).toBe('p1')
      expect(m.paneIdOf('claude-1')).toBeNull()
      expect(m.renamePane('p2', '前端組')).toBe(false)
      expect(m.renamePane('p2', '   ')).toBe(false)
    })

    it('suggestName returns the base when free, else a suffixed variant', () => {
      m.registerPane('p1', 'claude') // claude-1
      m.renamePane('p1', '後端')
      expect(m.suggestName('前端')).toBe('前端')
      expect(m.suggestName('後端')).toBe('後端-2')
    })

    it('setDerivedName syncs the handle to a new title, suffixing collisions', () => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
      // Title given → handle becomes the title.
      expect(m.setDerivedName('p1', '後端', 'claude')).toBe('後端')
      expect(m.paneIdOf('後端')).toBe('p1')
      expect(m.paneIdOf('claude-1')).toBeNull()
      // Second pane titled the same → suffixed, not stolen.
      expect(m.setDerivedName('p2', '後端', 'codex')).toBe('後端-2')
      // Re-deriving the same title is idempotent (reclaims its own name).
      expect(m.setDerivedName('p1', '後端', 'claude')).toBe('後端')
      // Cleared title → back to the <agent>-N default.
      expect(m.setDerivedName('p1', null, 'claude')).toBe('claude-1')
      // Not a messaging pane (plain terminal) → null.
      expect(m.setDerivedName('ghost', '後端', 'claude')).toBeNull()
    })
  })

  describe('sendMessage validation', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
    })

    it('fails on unknown target', () => {
      const msg = m.sendMessage('claude-1', 'ghost', 'hi')
      expect(msg.status).toBe('failed')
      expect(msg.reason).toContain('unknown target')
    })

    it('fails on self-send', () => {
      const msg = m.sendMessage('claude-1', 'claude-1', 'hi')
      expect(msg.status).toBe('failed')
      expect(msg.reason).toContain('same pane')
    })

    it('rate-limits a sender→target pair independently', () => {
      idlePanes.clear() // keep everything queued
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        expect(m.sendMessage('claude-1', 'codex-1', `n${i}`).status).toBe('queued')
      }
      expect(m.sendMessage('claude-1', 'codex-1', 'over').status).toBe('failed')
      // other pair unaffected
      expect(m.sendMessage('codex-1', 'claude-1', 'x').status).toBe('queued')
    })

    it('rate limit window slides with time', () => {
      idlePanes.clear()
      for (let i = 0; i < RATE_LIMIT_MAX; i++) m.sendMessage('claude-1', 'codex-1', `n${i}`)
      clock += 61_000
      expect(m.sendMessage('claude-1', 'codex-1', 'later').status).toBe('queued')
    })

    it('caps the per-target queue', () => {
      idlePanes.clear()
      m.registerPane('p3', 'grok') // grok-1
      m.registerPane('p4', 'kimi') // kimi-1
      // Fill the target queue from multiple senders (each within its own
      // pair rate limit: QUEUE_CAP = 2 × RATE_LIMIT_MAX).
      for (const sender of ['claude-1', 'grok-1']) {
        for (let i = 0; i < RATE_LIMIT_MAX; i++) {
          expect(m.sendMessage(sender, 'codex-1', `${sender}-${i}`).status).toBe('queued')
        }
      }
      const over = m.sendMessage('kimi-1', 'codex-1', 'over')
      expect(over.status).toBe('failed')
      expect(over.reason).toContain('queue full')
    })
  })

  describe('delivery', () => {
    beforeEach(() => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
    })

    it('delivers the envelope to the target pane when idle', async () => {
      const msg = m.sendMessage('claude-1', 'codex-1', 'hello codex')
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
      expect(delivered).toHaveLength(1)
      expect(delivered[0].paneId).toBe('p2')
      expect(delivered[0].text).toContain(`${MSG_ENVELOPE_PREFIX} claude-1`)
      expect(delivered[0].text).toContain('hello codex')
    })

    it('waits for the target to become idle', async () => {
      idlePanes.delete('p2')
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('queued')
      expect(delivered).toHaveLength(0)
      idlePanes.add('p2')
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
    })

    it('marks failed when injection does not verify', async () => {
      deliverResult = false
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('failed')
      expect(msg.reason).toContain('injection failed')
    })

    it('delivers FIFO per target, one at a time', async () => {
      const a = m.sendMessage('claude-1', 'codex-1', 'first')
      const b = m.sendMessage('claude-1', 'codex-1', 'second')
      m.pump()
      await flush()
      m.pump()
      await flush()
      expect(a.status).toBe('delivered')
      expect(b.status).toBe('delivered')
      expect(delivered.map((d) => d.text.includes('first'))).toEqual([true, false])
    })

    it('pause holds the queue; resume flushes it', async () => {
      m.pauseMessaging()
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('queued')
      m.resumeMessaging()
      await flush()
      expect(msg.status).toBe('delivered')
    })

    it('unregisterPane fails its queued messages', () => {
      idlePanes.clear()
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.unregisterPane('p2')
      expect(msg.status).toBe('failed')
      expect(msg.reason).toContain('closed')
      expect(m.paneIdOf('codex-1')).toBeNull()
    })
  })

  describe('broadcast', () => {
    it('isBroadcastTarget matches all/* case-insensitively, not real names', () => {
      expect(isBroadcastTarget('all')).toBe(true)
      expect(isBroadcastTarget('ALL')).toBe(true)
      expect(isBroadcastTarget(' * ')).toBe(true)
      expect(isBroadcastTarget('codex-1')).toBe(false)
      expect(isBroadcastTarget('')).toBe(false)
    })

    it('sendBroadcast fans out to every pane except the sender', async () => {
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
      m.registerPane('p3', 'grok') // grok-1
      idlePanes.add('p3') // harness seeds only p1/p2 as idle
      const msgs = m.sendBroadcast('claude-1', 'hello all')
      expect(msgs.map((x) => x.to).sort()).toEqual(['codex-1', 'grok-1'])
      expect(msgs.every((x) => x.status === 'queued')).toBe(true)
      m.pump()
      await flush()
      expect(delivered.map((d) => d.paneId).sort()).toEqual(['p2', 'p3'])
      expect(delivered.every((d) => d.text.includes('hello all'))).toBe(true)
    })

    it('sendBroadcast returns empty when the sender is the only pane', () => {
      m.registerPane('p1', 'claude')
      expect(m.sendBroadcast('claude-1', 'anyone?')).toEqual([])
    })

    it('broadcast still honours the per-pair rate limit', () => {
      idlePanes.clear() // keep everything queued
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        expect(m.sendBroadcast('claude-1', `n${i}`)[0].status).toBe('queued')
      }
      expect(m.sendBroadcast('claude-1', 'over')[0].status).toBe('failed')
    })
  })

  describe('uid', () => {
    it('is unique per message and shares one boot prefix', () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      const a = m.sendMessage('claude-1', 'codex-1', 'one')
      const b = m.sendMessage('claude-1', 'codex-1', 'two')
      expect(a.uid).toMatch(/^[0-9a-f]+:\d+$/)
      expect(a.uid).not.toBe(b.uid)
      expect(a.uid.split(':')[0]).toBe(b.uid.split(':')[0])
      expect(a.uid).toBe(`${a.uid.split(':')[0]}:${a.id}`)
    })

    it('stays stable across the whole message lifecycle', async () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      const uid = msg.uid
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
      expect(msg.uid).toBe(uid)
    })
  })

  describe('persistence', () => {
    let appended: PersistedMessageRow[][]
    let updated: PersistedMessageUpdate[][]
    let cleared: string[][]

    function persistingDeps(): MessagingDeps {
      return {
        ...deps,
        persistAppend: (rows) => { appended.push(rows) },
        persistUpdate: (updates) => { updated.push(updates) },
        persistClear: (keep) => { cleared.push(keep) },
      }
    }

    beforeEach(() => {
      appended = []
      updated = []
      cleared = []
      m.configureMessaging(persistingDeps())
      m.registerPane('p1', 'claude') // claude-1
      m.registerPane('p2', 'codex') // codex-1
    })

    it('appends every logged row in the backend shape', () => {
      const msg = m.sendMessage('claude-1', 'codex-1', 'hello')
      expect(appended.flat()).toEqual([
        {
          uid: msg.uid,
          created_at: msg.createdAt,
          status: 'queued',
          sender: 'claude-1',
          recipient: 'codex-1',
          content: 'hello',
          reason: undefined,
          delivered_at: undefined,
          remote: undefined,
          remote_workspace: undefined,
        },
      ])
    })

    it('updates on the delivering → delivered transition', async () => {
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(updated.flat()).toEqual([
        { uid: msg.uid, status: 'delivering' },
        { uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt },
      ])
    })

    it('updates on failure with the reason', () => {
      const msg = m.sendMessage('claude-1', 'ghost', 'hi')
      expect(updated.flat()).toEqual([
        { uid: msg.uid, status: 'failed', reason: msg.reason },
      ])
    })

    it('clearMessageLog forwards the kept statuses', () => {
      m.sendMessage('claude-1', 'ghost', 'hi')
      m.clearMessageLog()
      expect(cleared).toEqual([['queued', 'delivering']])
    })

    it('everything still works with no persist deps configured', async () => {
      m.configureMessaging(deps) // the plain deps, no persistence
      const msg = m.sendMessage('claude-1', 'codex-1', 'hi')
      m.pump()
      await flush()
      expect(msg.status).toBe('delivered')
      m.hydrateLog([
        { uid: 'boot:1', created_at: 1, status: 'queued', sender: 'a', recipient: 'b', content: 'x' },
      ])
      expect(m.messages.value.find((x) => x.uid === 'boot:1')?.status).toBe('failed')
      m.clearMessageLog()
      expect(appended).toEqual([])
      expect(updated).toEqual([])
      expect(cleared).toEqual([])
    })
  })

  describe('hydrateLog', () => {
    const snapshot: PersistedMessageRow[] = [
      {
        uid: 'oldboot:1',
        created_at: 10,
        status: 'delivered',
        sender: 'claude-1',
        recipient: 'codex-1',
        content: 'done',
        delivered_at: 12,
      },
      {
        uid: 'oldboot:2',
        created_at: 20,
        status: 'failed',
        sender: 'claude-1',
        recipient: 'ghost',
        content: 'nope',
        reason: 'unknown target "ghost"',
        remote: 'outbound',
        remote_workspace: '/w/other',
      },
    ]

    it('restores rows into the log, snake_case mapped back', () => {
      m.hydrateLog(snapshot)
      expect(m.messages.value).toHaveLength(2)
      expect(m.messages.value[0]).toMatchObject({
        uid: 'oldboot:1',
        from: 'claude-1',
        to: 'codex-1',
        content: 'done',
        status: 'delivered',
        createdAt: 10,
        deliveredAt: 12,
      })
      expect(m.messages.value[1]).toMatchObject({
        uid: 'oldboot:2',
        status: 'failed',
        reason: 'unknown target "ghost"',
        remote: 'outbound',
        remoteWorkspace: '/w/other',
      })
    })

    it('coerces restored in-flight rows to failed and persists the coercion', async () => {
      const updates: PersistedMessageUpdate[][] = []
      m.configureMessaging({ ...deps, persistUpdate: (u) => { updates.push(u) } })
      m.registerPane('p2', 'codex') // codex-1: a live target for the restored row
      m.hydrateLog([
        { uid: 'oldboot:3', created_at: 30, status: 'queued', sender: 'claude-1', recipient: 'codex-1', content: 'a' },
        { uid: 'oldboot:4', created_at: 40, status: 'delivering', sender: 'claude-1', recipient: 'codex-1', content: 'b' },
      ])
      expect(m.messages.value.map((x) => x.status)).toEqual(['failed', 'failed'])
      expect(m.messages.value[0].reason).toBe('window reloaded before delivery')
      expect(updates.flat()).toEqual([
        { uid: 'oldboot:3', status: 'failed', reason: 'window reloaded before delivery' },
        { uid: 'oldboot:4', status: 'failed', reason: 'window reloaded before delivery' },
      ])
      // Restored rows are history: nothing was enqueued, so nothing delivers.
      m.pump()
      await flush()
      expect(delivered).toEqual([])
      expect(m.messages.value.map((x) => x.status)).toEqual(['failed', 'failed'])
    })

    it('keeps rows this window already logged', () => {
      m.registerPane('p1', 'claude')
      m.registerPane('p2', 'codex')
      const live = m.sendMessage('claude-1', 'codex-1', 'live')
      m.hydrateLog(snapshot)
      expect(m.messages.value.map((x) => x.uid)).toEqual(['oldboot:1', 'oldboot:2', live.uid])
      expect(live.status).toBe('queued')
    })
  })
})
