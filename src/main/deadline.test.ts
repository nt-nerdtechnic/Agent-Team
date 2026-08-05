import { describe, it, expect, vi, afterEach } from 'vitest'
import { withDeadline } from './deadline'

afterEach(() => { vi.useRealTimers() })

describe('withDeadline', () => {
  it('returns as soon as the work finishes, without waiting out the deadline', async () => {
    vi.useFakeTimers()
    const done = vi.fn()
    const promise = withDeadline(Promise.resolve('stopped'), 6000).then(done)
    await vi.advanceTimersByTimeAsync(0)
    await promise
    expect(done).toHaveBeenCalled()
  })

  it('gives up after the deadline when the work never settles', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const promise = withDeadline(new Promise(() => {}), 6000).then(settled)
    await vi.advanceTimersByTimeAsync(5999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await promise
    expect(settled).toHaveBeenCalled()
  })

  it('treats a rejection as a finished step rather than aborting the shutdown', async () => {
    await expect(withDeadline(Promise.reject(new Error('stop failed')), 50)).resolves.toBeUndefined()
  })

  it('clears its timer so a finished wait cannot keep the process alive', async () => {
    vi.useFakeTimers()
    await withDeadline(Promise.resolve(), 6000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives each step its own budget instead of one shared allowance', async () => {
    // The bug this replaced: a single timer shared by both awaits meant a slow
    // spawn ate the budget that stopping the backend needed.
    vi.useFakeTimers()
    const stopped = vi.fn()
    const run = (async () => {
      await withDeadline(new Promise(() => {}), 3000)   // spawn wait times out
      await withDeadline(new Promise(() => {}), 6000)   // stop wait, full budget
      stopped()
    })()

    await vi.advanceTimersByTimeAsync(3000)
    expect(stopped).not.toHaveBeenCalled()
    // A shared 6s deadline would already have elapsed here; an independent one
    // still owes the stop step its full 6s.
    await vi.advanceTimersByTimeAsync(5999)
    expect(stopped).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await run
    expect(stopped).toHaveBeenCalled()
  })
})
