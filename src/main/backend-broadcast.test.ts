import { describe, it, expect } from 'vitest'
import { BackendBroadcastTracker } from './backend-broadcast'

describe('BackendBroadcastTracker', () => {
  it('sends immediately to a focused window and keeps nothing pending', () => {
    const tracker = new BackendBroadcastTracker<string>()
    expect(tracker.dispatch(1, true, 'ready')).toEqual({ immediate: true })
    expect(tracker.takePending(1)).toBeUndefined()
  })

  it('queues for an unfocused window instead of sending immediately', () => {
    const tracker = new BackendBroadcastTracker<string>()
    expect(tracker.dispatch(1, false, 'ready')).toEqual({ immediate: false })
    expect(tracker.takePending(1)).toBe('ready')
  })

  it('keeps only the latest snapshot when several changes happen while unfocused', () => {
    const tracker = new BackendBroadcastTracker<string>()
    tracker.dispatch(1, false, 'starting')
    tracker.dispatch(1, false, 'ready')
    tracker.dispatch(1, false, 'error')
    expect(tracker.takePending(1)).toBe('error')
  })

  it('takePending clears the entry so a second focus does not re-deliver it', () => {
    const tracker = new BackendBroadcastTracker<string>()
    tracker.dispatch(1, false, 'ready')
    expect(tracker.takePending(1)).toBe('ready')
    expect(tracker.takePending(1)).toBeUndefined()
  })

  it('does not affect other windows tracked independently', () => {
    const tracker = new BackendBroadcastTracker<string>()
    tracker.dispatch(1, false, 'ready')
    tracker.dispatch(2, true, 'ready')
    expect(tracker.takePending(1)).toBe('ready')
    expect(tracker.takePending(2)).toBeUndefined()
  })

  it('clears a stale pending entry once the window becomes focused on a later broadcast', () => {
    const tracker = new BackendBroadcastTracker<string>()
    tracker.dispatch(1, false, 'starting')
    tracker.dispatch(1, true, 'ready')
    expect(tracker.takePending(1)).toBeUndefined()
  })

  // The focus gate exists to keep a transient blip from flashing everywhere at
  // once. A backend that has given up is not transient: an unfocused window
  // that is not told keeps reconnect-looping against a dead port until the user
  // happens to click on it.
  it('sends an urgent payload immediately even to an unfocused window', () => {
    const tracker = new BackendBroadcastTracker<string>()
    expect(tracker.dispatch(1, false, 'error', true)).toEqual({ immediate: true })
    expect(tracker.takePending(1)).toBeUndefined()
  })

  it('an urgent payload also clears a stale pending entry', () => {
    const tracker = new BackendBroadcastTracker<string>()
    tracker.dispatch(1, false, 'starting')
    tracker.dispatch(1, false, 'error', true)
    expect(tracker.takePending(1)).toBeUndefined()
  })

  it('still queues a non-urgent payload for an unfocused window', () => {
    const tracker = new BackendBroadcastTracker<string>()
    expect(tracker.dispatch(1, false, 'starting', false)).toEqual({ immediate: false })
    expect(tracker.takePending(1)).toBe('starting')
  })

  it('forget drops a pending entry (e.g. window closed)', () => {
    const tracker = new BackendBroadcastTracker<string>()
    tracker.dispatch(1, false, 'ready')
    tracker.forget(1)
    expect(tracker.takePending(1)).toBeUndefined()
  })
})
