import { describe, it, expect, vi } from 'vitest'

// Module-level state (the registry and its one-way abandoned latch), so every
// test takes a fresh copy the way updater.test.ts does.
async function load(): Promise<typeof import('./backend-pending')> {
  vi.resetModules()
  return await import('./backend-pending')
}

function child(exitCode: number | null = null) {
  return { exitCode, kill: vi.fn(() => true) }
}

describe('pending backend registry', () => {
  it('kills a backend whose start never finished', async () => {
    // The leak this exists for: the quit path gives up waiting after a few
    // seconds, and nothing else holds a reference to a half-started backend.
    // Electron exiting does not take it down — it is reparented and keeps the
    // port and the shared app-data state.
    const { registerPendingBackend, abandonPendingBackends } = await load()
    const proc = child()
    registerPendingBackend(proc)

    abandonPendingBackends()

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills a backend that spawns after the quit gave up', async () => {
    // On macOS the child does not exist for the first seconds of a start (the
    // login-shell PATH probe has been measured at 13s+), so a quit routinely
    // lands before there is anything to kill. It has to die on arrival.
    const { registerPendingBackend, abandonPendingBackends } = await load()
    abandonPendingBackends()

    const proc = child()
    const kept = registerPendingBackend(proc)

    expect(kept).toBe(false) // caller must stop waiting for it too
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('leaves a finished start alone — its handle owns the process', async () => {
    // Killing here would SIGKILL a live backend behind stop()'s back, skipping
    // the shutdown sweep that keeps its PTY children from being orphaned.
    const { registerPendingBackend, releasePendingBackend, abandonPendingBackends } = await load()
    const proc = child()
    registerPendingBackend(proc)
    releasePendingBackend(proc)

    abandonPendingBackends()

    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('does not signal a child that already exited', async () => {
    const { registerPendingBackend, abandonPendingBackends } = await load()
    const proc = child(1)
    registerPendingBackend(proc)

    abandonPendingBackends()

    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('survives a child that refuses to be killed', async () => {
    // kill() on a process that died between the check and the signal throws;
    // shutdown must carry on to the next one regardless.
    const { registerPendingBackend, abandonPendingBackends } = await load()
    const angry = { exitCode: null, kill: vi.fn(() => { throw new Error('ESRCH') }) }
    const other = child()
    registerPendingBackend(angry)
    registerPendingBackend(other)

    expect(() => abandonPendingBackends()).not.toThrow()
    expect(other.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
