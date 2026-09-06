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
  it('prompts both ends, because both of them have something to decide', async () => {
    // It served the responder alone, back when the initiator did not confirm at
    // all. Both confirm now — the six digits are the only part of the exchange
    // a relay cannot produce, so somebody compares them at each end — and the
    // reason the responder needed a popup applies unchanged to the initiator:
    // the account window may be closed while the one button that finishes the
    // exchange waits inside it.
    const state = usePairingState(asBackend(backendReturning({ pairings: [RESPONDER, INITIATOR] })))
    await state.refresh()

    expect(state.pairings.value.map((r) => r.deviceId)).toEqual(['dev-asking', 'dev-asked'])
    expect(state.prompts.value.map((r) => r.deviceId)).toEqual(['dev-asking', 'dev-asked'])
  })

  it('acknowledges a press before anything has been sent', async () => {
    // "Pair" produced nothing until the far machine answered — seconds of a
    // button that has visibly done nothing. The snapshot is polled, so even the
    // local record of "we asked" is up to a poll away.
    const state = usePairingState(asBackend(backendReturning({ pairings: [] })))

    state.noteAsked('dev-new', 'M5')

    expect(state.asked.value).toEqual([{ deviceId: 'dev-new', deviceName: 'M5', error: '' }])
  })

  it('hands the request over to the snapshot the moment it is real', async () => {
    // Two cards for one exchange would be the snapshot and the optimistic note
    // disagreeing about the same thing.
    const state = usePairingState(
      asBackend(backendReturning({ pairings: [{ ...RESPONDER, deviceId: 'dev-new' }] })),
    )
    state.noteAsked('dev-new', 'M5')
    await state.refresh()

    expect(state.asked.value).toEqual([])
    expect(state.prompts.value.map((r) => r.deviceId)).toEqual(['dev-new'])
  })

  it('says a failed send failed, rather than going quiet', async () => {
    const state = usePairingState(asBackend(backendReturning({ pairings: [] })))
    state.noteAsked('dev-new', 'M5')

    state.noteAskFailed('dev-new', 'that device is offline')

    expect(state.asked.value[0].error).toBe('that device is offline')
    // And it stays on screen: clearing it would return to the silence this
    // replaced, with the failure only in a panel nobody has open.
    expect(state.asked.value).toHaveLength(1)
  })

  it('forgets a press that was given up on', async () => {
    const state = usePairingState(asBackend(backendReturning({ pairings: [] })))
    state.noteAsked('dev-new', 'M5')

    state.forgetAsked('dev-new')

    expect(state.asked.value).toEqual([])
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

describe('a read that did not come back', () => {
  // Kept apart from anything about the link on purpose: they are different
  // facts, and the account window used to report one as the other.
  it('keeps the last picture, and says it is not current', async () => {
    const fake = backendReturning({ pairings: [RESPONDER] })
    const state = usePairingState(asBackend(fake))
    await state.refresh()
    expect(state.readFailed.value).toBe(false)

    fake.send.mockRejectedValueOnce(new Error('ws not open'))
    await state.refresh()

    expect(state.readFailed.value).toBe(true)
    // Still there. An emptied list would assert those machines had gone.
    expect(state.pairings.value.map((r) => r.deviceId)).toEqual(['dev-asking'])
  })

  it('counts a refusal, not only a thrown request', async () => {
    // A handler that answers `ok: false` is the case that produced this: the
    // read failed while the socket was fine.
    const fake = { send: vi.fn().mockResolvedValue({ ok: false, error: { code: 'INTERNAL' } }) }
    const state = usePairingState(asBackend(fake))

    await state.refresh()

    expect(state.readFailed.value).toBe(true)
  })

  it('does not count a machine with no server configured', async () => {
    // Nothing failed there — there is nothing to read, and the window says so
    // in its own words.
    const fake = {
      send: vi.fn().mockResolvedValue({ ok: false, error: { code: 'P2P_NOT_CONFIGURED' } }),
    }
    const state = usePairingState(asBackend(fake))

    await state.refresh()

    expect(state.readFailed.value).toBe(false)
    expect(state.unavailable.value).toBe(true)
  })

  it('clears with the picture on sign-out', async () => {
    const fake = backendReturning({ pairings: [RESPONDER] })
    const state = usePairingState(asBackend(fake))
    fake.send.mockRejectedValueOnce(new Error('ws not open'))
    await state.refresh()
    expect(state.readFailed.value).toBe(true)

    state.clear()

    // Nothing is on screen to be out of date.
    expect(state.readFailed.value).toBe(false)
  })
})
