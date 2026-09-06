// When the prewarm runs, and that it runs once.
import { describe, expect, it, vi } from 'vitest'

import { schedulePrewarm, type PrewarmClock } from '../prewarm'

/** A clock a test drives by hand, so "after three seconds" is a statement about
 *  the code rather than about how long the test took. */
function fakeClock(opts: { idle?: boolean; cancellableIdle?: boolean } = {}) {
  const { idle = true, cancellableIdle = true } = opts
  const timers = new Map<number, () => void>()
  const idles = new Map<number, () => void>()
  let next = 1
  const clock: PrewarmClock = {
    setTimeout: (fn) => { const id = next++; timers.set(id, fn); return id },
    clearTimeout: (id) => { timers.delete(id) },
  }
  if (idle) {
    clock.requestIdleCallback = (fn) => { const id = next++; idles.set(id, fn); return id }
    if (cancellableIdle) clock.cancelIdleCallback = (id) => { idles.delete(id) }
  }
  return {
    clock,
    // Firing does not consume: a scheduler that calls back twice is the thing
    // the once-only guard is for, and a fake that cannot do it cannot test it.
    fireTimers: () => { for (const fn of [...timers.values()]) fn() },
    fireIdle: () => { for (const fn of [...idles.values()]) fn() },
    pending: () => timers.size + idles.size,
  }
}

const OPTS = { idleTimeoutMs: 4000, fallbackDelayMs: 2500 }

describe('schedulePrewarm', () => {
  it('does not load while the caller is still setting up', () => {
    // Parsing half a megabyte on the spot is the cost this exists to move.
    const load = vi.fn()
    const c = fakeClock()

    schedulePrewarm(load, { ...OPTS, clock: c.clock })

    expect(load).not.toHaveBeenCalled()
  })

  it('waits for idle rather than for a fixed delay', () => {
    // A fixed delay is worse than no delay for the case that matters: somebody
    // clicking in the first seconds would find the warm still pending, having
    // been postponed by a timer instead of run in a gap.
    const load = vi.fn()
    const c = fakeClock()
    schedulePrewarm(load, { ...OPTS, clock: c.clock })

    c.fireTimers()
    expect(load).not.toHaveBeenCalled()

    c.fireIdle()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('asks for the idle callback with a deadline, so a busy app still gets it', () => {
    // Without a timeout, a window that never goes idle never prewarms — and the
    // window that never goes idle is exactly the one where the stall hurts.
    const c = fakeClock()
    const spy = vi.spyOn(c.clock, 'requestIdleCallback')
    schedulePrewarm(vi.fn(), { ...OPTS, clock: c.clock })

    c.fireTimers()

    expect(spy).toHaveBeenCalledWith(expect.any(Function), { timeout: 4000 })
  })

  it('falls back to a timer where there is no idle scheduler', () => {
    const load = vi.fn()
    const c = fakeClock({ idle: false })
    const spy = vi.spyOn(c.clock, 'setTimeout')
    schedulePrewarm(load, { ...OPTS, clock: c.clock })

    expect(spy).toHaveBeenCalledWith(expect.any(Function), 2500)
    expect(load).not.toHaveBeenCalled()
    c.fireTimers()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('asks the idle scheduler and nothing else when there is one', () => {
    // Both paths firing would load twice, and the guard against that would be
    // hiding a scheduler that runs the work at the wrong moment.
    const c = fakeClock()
    const timer = vi.spyOn(c.clock, 'setTimeout')
    schedulePrewarm(vi.fn(), { ...OPTS, clock: c.clock })

    expect(timer).not.toHaveBeenCalled()
  })

  it('loads once, however the timers land', () => {
    const load = vi.fn()
    const c = fakeClock()
    schedulePrewarm(load, { ...OPTS, clock: c.clock })

    c.fireIdle()
    c.fireIdle()
    c.fireTimers()

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('cancels cleanly when the window closes first', () => {
    // A prewarm firing into an unmounted app is work nobody will use.
    const load = vi.fn()
    const c = fakeClock()
    const cancel = schedulePrewarm(load, { ...OPTS, clock: c.clock })

    expect(c.pending()).toBe(1)
    cancel()

    // Withdrawn from the scheduler, not merely ignored when it fires — checked
    // before firing anything, because firing is what empties the queue.
    expect(c.pending()).toBe(0)
    c.fireTimers()
    c.fireIdle()
    expect(load).not.toHaveBeenCalled()
  })

  it('stays cancelled where the idle callback cannot be withdrawn', () => {
    // `cancelIdleCallback` is optional here, and an engine that offers the
    // request without the cancel would otherwise load into an unmounted window.
    const load = vi.fn()
    const c = fakeClock({ cancellableIdle: false })
    const cancel = schedulePrewarm(load, { ...OPTS, clock: c.clock })

    cancel()
    c.fireIdle()

    expect(load).not.toHaveBeenCalled()
  })

  it('cancelling after it has already run changes nothing', () => {
    const load = vi.fn()
    const c = fakeClock()
    const cancel = schedulePrewarm(load, { ...OPTS, clock: c.clock })

    c.fireTimers()
    c.fireIdle()
    cancel()

    expect(load).toHaveBeenCalledTimes(1)
  })
})
