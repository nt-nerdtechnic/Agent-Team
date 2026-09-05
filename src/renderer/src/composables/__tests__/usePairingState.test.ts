// What the shared pairing state returns, rather than which strings are in a
// file. The two surfaces that read it — the account window's card and the
// prompt that appears over everything — can only be source-scanned, so the
// decisions they depend on live here where they can be called.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetForTest, POLL_MS, usePairingState } from '../usePairingState'

/** A backend that answers one snapshot. Typed loosely on purpose: the real one
 *  is a composable with a dozen members and this module uses exactly one. */
type FakeBackend = { send: ReturnType<typeof vi.fn> }

function backendReturning(payload: unknown): FakeBackend {
  return { send: vi.fn().mockResolvedValue({ ok: true, payload }) }
}

const asBackend = (fake: FakeBackend) =>
  fake as unknown as Parameters<typeof usePairingState>[0]

const RESPONDER = {
  deviceId: 'dev-asking',
  deviceName: 'M4',
  role: 'responder',
  state: 'awaiting-local',
  code: '482 913',
  fingerprint: '8fe2 1661 6449 c594',
  startedAt: 1_000,
}
const INITIATOR = { ...RESPONDER, deviceId: 'dev-asked', role: 'initiator' }

afterEach(() => {
  _resetForTest()
  vi.useRealTimers()
})

describe('usePairingState', () => {
  it('prompts only for the side that has something to decide', async () => {
    // Interrupting the initiator with a prompt about their own request would be
    // telling somebody what they just did.
    const state = usePairingState(asBackend(backendReturning({ pairings: [RESPONDER, INITIATOR] })))
    await state.refresh()

    expect(state.pairings.value.map((r) => r.deviceId)).toEqual(['dev-asking', 'dev-asked'])
    expect(state.prompts.value.map((r) => r.deviceId)).toEqual(['dev-asking'])
  })

  it('keeps a dismissed request out of the prompt and in the list', async () => {
    // "Later" hides a question; it does not answer it, and the card in the
    // account window is the record that survives.
    const state = usePairingState(asBackend(backendReturning({ pairings: [RESPONDER] })))
    await state.refresh()
    expect(state.prompts.value).toHaveLength(1)

    state.dismiss(RESPONDER)

    expect(state.prompts.value).toHaveLength(0)
    expect(state.pairings.value).toHaveLength(1)
  })

  it('does not re-open a dismissed prompt on the next poll', async () => {
    // The snapshot still carries it — it is still pending — so a naive reader
    // would put it back three seconds later.
    const state = usePairingState(asBackend(backendReturning({ pairings: [RESPONDER] })))
    await state.refresh()
    state.dismiss(RESPONDER)

    await state.refresh()

    expect(state.prompts.value).toHaveLength(0)
  })

  it('asks again when the same device sends a new request', async () => {
    // The one that made "later" behave like "never": a request that expired and
    // was sent again came back on the same deviceId, so a device-keyed dismissal
    // silently swallowed it. Dismissing answers a question, not a machine.
    const backend = backendReturning({ pairings: [RESPONDER] })
    const state = usePairingState(asBackend(backend))
    await state.refresh()
    state.dismiss(RESPONDER)
    expect(state.prompts.value).toHaveLength(0)

    const again = { ...RESPONDER, startedAt: RESPONDER.startedAt + 60 }
    backend.send.mockResolvedValue({ ok: true, payload: { pairings: [again] } })
    await state.refresh()

    expect(state.prompts.value.map((r) => r.startedAt)).toEqual([again.startedAt])
  })

  it('forgets a dismissal once its request is gone', async () => {
    // Otherwise the set only grows, and a machine that asks often eventually
    // carries an answer somebody gave to a different request weeks earlier.
    const backend = backendReturning({ pairings: [RESPONDER] })
    const state = usePairingState(asBackend(backend))
    await state.refresh()
    state.dismiss(RESPONDER)

    backend.send.mockResolvedValue({ ok: true, payload: { pairings: [] } })
    await state.refresh()
    backend.send.mockResolvedValue({ ok: true, payload: { pairings: [RESPONDER] } })
    await state.refresh()

    expect(state.prompts.value).toHaveLength(1)
  })

  it('dismissing one leaves the others asking', async () => {
    const other = { ...RESPONDER, deviceId: 'dev-two', deviceName: 'M5' }
    // Same instant, different machine: the key has to carry both.
    const state = usePairingState(asBackend(backendReturning({ pairings: [RESPONDER, other] })))
    await state.refresh()

    state.dismiss(RESPONDER)

    expect(state.prompts.value.map((r) => r.deviceId)).toEqual(['dev-two'])
  })

  it('polls while somebody is watching and stops when nobody is', () => {
    // The prompt is always mounted, so this is what keeps the one reader that
    // has to notice a request arriving; with nothing mounted it costs nothing.
    vi.useFakeTimers()
    const backend = backendReturning({ pairings: [] })
    const state = usePairingState(asBackend(backend))

    state.subscribe()
    expect(backend.send).toHaveBeenCalledTimes(1) // the immediate read
    vi.advanceTimersByTime(POLL_MS * 2)
    expect(backend.send).toHaveBeenCalledTimes(3)

    state.release()
    vi.advanceTimersByTime(POLL_MS * 3)
    expect(backend.send).toHaveBeenCalledTimes(3)
  })

  it('keeps polling while a second watcher is still there', () => {
    // Both surfaces subscribe; closing the window must not stop the prompt.
    vi.useFakeTimers()
    const backend = backendReturning({ pairings: [] })
    const state = usePairingState(asBackend(backend))

    state.subscribe()
    state.subscribe()
    state.release()
    const after = backend.send.mock.calls.length
    vi.advanceTimersByTime(POLL_MS)

    expect(backend.send.mock.calls.length).toBeGreaterThan(after)
  })

  it('reports no server separately from a failed read', async () => {
    // "Not signed in" and "the read did not come back" look the same on screen
    // if one flag serves both, and only one of them should take the section
    // away. The account window now takes this from here rather than polling the
    // endpoint a second time itself.
    const backend: FakeBackend = {
      send: vi.fn().mockResolvedValue({ ok: false, error: { code: 'P2P_NOT_CONFIGURED' } }),
    }
    const state = usePairingState(asBackend(backend))
    await state.refresh()
    expect(state.unavailable.value).toBe(true)

    backend.send.mockRejectedValue(new Error('offline'))
    await state.refresh()

    expect(state.unavailable.value).toBe(true)
  })

  it('drops the picture when the account signs out', async () => {
    // It described the machines of whoever just left.
    const state = usePairingState(asBackend(backendReturning({ pairings: [RESPONDER] })))
    await state.refresh()

    state.clear()

    expect(state.pairings.value).toHaveLength(0)
  })

  it('keeps the last answer when a poll fails', async () => {
    // A dropped read is not "nothing is pending"; showing that would take a
    // card off the screen while the request is still live.
    const state = usePairingState(asBackend(backendReturning({ pairings: [RESPONDER] })))
    await state.refresh()

    const failing: FakeBackend = { send: vi.fn().mockRejectedValue(new Error('offline')) }
    const same = usePairingState(asBackend(failing))
    await same.refresh()

    expect(state.pairings.value).toHaveLength(1)
  })
})
