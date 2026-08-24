import { describe, it, expect, vi } from 'vitest'
import {
  createBackendAutoRestart,
  DEFAULT_RESTART_DELAYS_MS,
  DEFAULT_STABLE_MS,
} from './backend-autorestart'

/** Deterministic timer harness: nothing fires until the test advances it. */
function fakeTimers() {
  let seq = 0
  const scheduled = new Map<number, { fn: () => void; at: number }>()
  let clock = 0
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      scheduled.set(id, { fn, at: clock + ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      scheduled.delete(handle as unknown as number)
    },
    advance(ms: number) {
      clock += ms
      for (const [id, entry] of [...scheduled]) {
        if (entry.at <= clock) {
          scheduled.delete(id)
          entry.fn()
        }
      }
    },
    pendingCount: () => scheduled.size,
  }
}

describe('createBackendAutoRestart', () => {
  it('schedules a restart after the first crash, at the first delay', () => {
    const t = fakeTimers()
    const restart = vi.fn()
    const auto = createBackendAutoRestart({ restart, setTimer: t.setTimer, clearTimer: t.clearTimer })

    expect(auto.onCrash()).toBe(1)
    expect(auto.isRestartPending()).toBe(true)
    expect(restart).not.toHaveBeenCalled()

    t.advance(DEFAULT_RESTART_DELAYS_MS[0])
    expect(restart).toHaveBeenCalledTimes(1)
    expect(auto.isRestartPending()).toBe(false)
  })

  it('backs off across attempts and gives up once the budget is spent', () => {
    const t = fakeTimers()
    const restart = vi.fn()
    const onGiveUp = vi.fn()
    const auto = createBackendAutoRestart({
      restart,
      onGiveUp,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    for (let i = 0; i < DEFAULT_RESTART_DELAYS_MS.length; i++) {
      expect(auto.onCrash()).toBe(i + 1)
      t.advance(DEFAULT_RESTART_DELAYS_MS[i])
    }
    expect(restart).toHaveBeenCalledTimes(DEFAULT_RESTART_DELAYS_MS.length)

    // Budget exhausted: no further attempt, caller told to go terminal.
    expect(auto.onCrash()).toBeNull()
    expect(onGiveUp).toHaveBeenCalledWith(DEFAULT_RESTART_DELAYS_MS.length)
    expect(auto.isRestartPending()).toBe(false)
    expect(restart).toHaveBeenCalledTimes(DEFAULT_RESTART_DELAYS_MS.length)
  })

  it('resets the budget only after the backend stays healthy for the full window', () => {
    const t = fakeTimers()
    const restart = vi.fn()
    const auto = createBackendAutoRestart({ restart, setTimer: t.setTimer, clearTimer: t.clearTimer })

    auto.onCrash()
    t.advance(DEFAULT_RESTART_DELAYS_MS[0])
    auto.onHealthy()

    // Halfway through the window the budget is still spent.
    t.advance(DEFAULT_STABLE_MS / 2)
    expect(auto.attempts()).toBe(1)

    t.advance(DEFAULT_STABLE_MS / 2)
    expect(auto.attempts()).toBe(0)
  })

  it('does not reset the budget for a backend that crashes inside the window', () => {
    const t = fakeTimers()
    const restart = vi.fn()
    const onGiveUp = vi.fn()
    const auto = createBackendAutoRestart({
      restart,
      onGiveUp,
      delaysMs: [10, 20],
      stableMs: 1_000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    // Crash loop: each restart dies before its stability window completes, so
    // the budget must not reset.
    auto.onCrash()
    t.advance(10)
    auto.onHealthy()
    t.advance(100)

    auto.onCrash()
    t.advance(20)
    auto.onHealthy()
    t.advance(100)

    expect(auto.onCrash()).toBeNull()
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledTimes(2)
  })

  it('cancel drops a pending attempt and clears the budget', () => {
    const t = fakeTimers()
    const restart = vi.fn()
    const auto = createBackendAutoRestart({ restart, setTimer: t.setTimer, clearTimer: t.clearTimer })

    auto.onCrash()
    auto.cancel()

    t.advance(60_000)
    expect(restart).not.toHaveBeenCalled()
    expect(auto.attempts()).toBe(0)
    expect(t.pendingCount()).toBe(0)
  })

  it('a crash while an attempt is pending replaces it rather than stacking', () => {
    const t = fakeTimers()
    const restart = vi.fn()
    const auto = createBackendAutoRestart({
      restart,
      delaysMs: [100, 200, 300],
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    })

    auto.onCrash()
    auto.onCrash()
    t.advance(1_000)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('fires onStable once a backend completes the window, first boot included', () => {
    const t = fakeTimers()
    const onStable = vi.fn()
    const auto = createBackendAutoRestart({
      restart: vi.fn(), onStable, setTimer: t.setTimer, clearTimer: t.clearTimer,
    })

    // No crash ever happened: the very first successful start must still count
    // as stable — that is the signal that clears the restore failure ledger.
    auto.onHealthy()
    t.advance(DEFAULT_STABLE_MS - 1)
    expect(onStable).not.toHaveBeenCalled()
    t.advance(1)
    expect(onStable).toHaveBeenCalledTimes(1)
  })

  it('does not fire onStable for a backend that dies inside the window', () => {
    const t = fakeTimers()
    const onStable = vi.fn()
    const auto = createBackendAutoRestart({
      restart: vi.fn(), stableMs: 1_000, setTimer: t.setTimer, clearTimer: t.clearTimer, onStable,
    })

    auto.onHealthy()
    t.advance(500)
    auto.onCrash()
    t.advance(10_000)
    expect(onStable).not.toHaveBeenCalled()
  })

  it('reports the attempt limit for status display', () => {
    const auto = createBackendAutoRestart({ restart: vi.fn(), delaysMs: [1, 2] })
    expect(auto.maxAttempts()).toBe(2)
    auto.cancel()
  })
})
