import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PaneActionRelay,
  PANE_ACTION_REQUEST_CHANNEL,
  type PaneActionRelayTarget
} from './pane-action-relay'

function target(): PaneActionRelayTarget & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() }
}

/** Correlation id from the target's recorded request (2nd send arg). */
function requestIdOf(t: ReturnType<typeof target>): string {
  return t.send.mock.calls[0][1] as string
}

describe('PaneActionRelay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves unavailable when there is no window to ask', async () => {
    const relay = new PaneActionRelay()
    await expect(relay.request([], 'pane-1', 'focus')).resolves.toEqual({ error: 'unavailable' })
  })

  it('sends the pane and the action to every target', async () => {
    const relay = new PaneActionRelay()
    const a = target()
    const b = target()
    const promise = relay.request([a, b], 'pane-1', 'reclaim')
    expect(a.send).toHaveBeenCalledWith(
      PANE_ACTION_REQUEST_CHANNEL,
      requestIdOf(a),
      'pane-1',
      'reclaim'
    )
    expect(b.send).toHaveBeenCalledWith(
      PANE_ACTION_REQUEST_CHANNEL,
      requestIdOf(a),
      'pane-1',
      'reclaim'
    )
    relay.handleReply(requestIdOf(a), { ok: true })
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it('resolves not-found only once every window disowned the pane', async () => {
    const relay = new PaneActionRelay()
    const a = target()
    const b = target()
    const promise = relay.request([a, b], 'pane-gone', 'focus')
    const resolved = vi.fn()
    void promise.then(resolved)

    relay.handleReply(requestIdOf(a), { error: 'not-found' })
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled() // the other window may still own it

    relay.handleReply(requestIdOf(a), { error: 'not-found' })
    await expect(promise).resolves.toEqual({ error: 'not-found' })
  })

  // A pane belongs to exactly one window, so its refusal is the answer. Waiting
  // for the rest would turn a legitimate "still busy" into a timeout.
  it('takes a blocked answer immediately rather than waiting out the others', async () => {
    const relay = new PaneActionRelay()
    const a = target()
    const b = target()
    const promise = relay.request([a, b], 'pane-1', 'reclaim')
    relay.handleReply(requestIdOf(a), { error: 'blocked' })
    await expect(promise).resolves.toEqual({ error: 'blocked' })
  })

  it('lets a claim from one window win over a not-found from another', async () => {
    const relay = new PaneActionRelay()
    const a = target()
    const b = target()
    const promise = relay.request([a, b], 'pane-1', 'focus')
    relay.handleReply(requestIdOf(a), { error: 'not-found' })
    relay.handleReply(requestIdOf(a), { ok: true, focused: true })
    await expect(promise).resolves.toEqual({ ok: true, focused: true })
  })

  it('resolves timeout when no reply arrives in time, and ignores a late reply', async () => {
    const relay = new PaneActionRelay()
    const a = target()
    const promise = relay.request([a], 'pane-1', 'focus', 3000)
    vi.advanceTimersByTime(3000)
    await expect(promise).resolves.toEqual({ error: 'timeout' })
    relay.handleReply(requestIdOf(a), { ok: true })
  })

  // A renderer handler that returns nothing must count as a disowning rather
  // than throwing in the main process.
  it('treats a reply with no result object as a disowning', async () => {
    const relay = new PaneActionRelay()
    const a = target()
    const promise = relay.request([a], 'pane-1', 'focus')
    relay.handleReply(requestIdOf(a), undefined)
    await expect(promise).resolves.toEqual({ error: 'not-found' })
  })

  it('ignores replies with an unknown correlation id', () => {
    const relay = new PaneActionRelay()
    relay.handleReply('never-issued', { ok: true })
  })

  it('keeps concurrent requests separate via correlation ids', async () => {
    const relay = new PaneActionRelay()
    const a = target()
    const p1 = relay.request([a], 'pane-1', 'focus')
    const p2 = relay.request([a], 'pane-2', 'reclaim')
    const id1 = a.send.mock.calls[0][1] as string
    const id2 = a.send.mock.calls[1][1] as string
    expect(id1).not.toBe(id2)

    relay.handleReply(id2, { error: 'blocked' })
    relay.handleReply(id1, { ok: true, focused: true })
    await expect(p1).resolves.toEqual({ ok: true, focused: true })
    await expect(p2).resolves.toEqual({ error: 'blocked' })
  })
})
