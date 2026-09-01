// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// A pane whose terminal.create never acks used to strand every OTHER resume
// behind it forever: the shared resume semaphore was an unbounded wait taken
// before send(), so the queued panes never even transmitted a create and sat in
// 'starting' with nothing left to time out. These tests pin the queue timeout,
// the slot accounting around it, and the starting watchdog that reports the
// remaining stall shapes — including the case the watchdog must NOT report.

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  // Uncapped by default: the real capCols is identity until a cap is set.
  setColsCap: vi.fn(),
  capCols: vi.fn((cols: number) => cols),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 0,
  ackedRows: 0,
}))

// Each pane hands the controller a "the container is measurable now" callback
// (the ResizeObserver's unpark hook). Capturing it in creation order lets a
// test show a hidden tab without mounting real DOM.
const measurable = vi.hoisted(() => ({ cbs: [] as Array<() => void> }))

vi.mock('../useTerminalResize', () => ({
  createResizeController: (...args: unknown[]) => {
    measurable.cbs.push(args[8] as () => void)
    return ctrl
  },
}))

// Cap of 1 makes "who is queued behind whom" unambiguous with two panes.
const cap = vi.hoisted(() => ({ value: 1 }))
vi.mock('../../lib/resumeConcurrency', () => ({
  getResumeConcurrency: () => cap.value,
}))

const written = vi.hoisted(() => ({ lines: [] as string[] }))

// onResize is how a real, visible terminal publishes the size later spawns
// borrow while hidden. Capturing the handlers lets a test make that cached
// size appear midway through, which is what releases a parked resume.
const resized = vi.hoisted(() => ({
  cbs: [] as Array<(d: { cols: number; rows: number }) => void>,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(cb: (d: { cols: number; rows: number }) => void): { dispose(): void } {
      resized.cbs.push(cb)
      return { dispose(): void {} }
    }
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
    write(): void {}
    writeln(s: string): void {
      written.lines.push(s)
    }
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
    hasSelection(): boolean { return false }
    onSelectionChange(_handler: () => void): { dispose: () => void } {
      return { dispose: (): void => {} }
    }
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
  },
}))

// The resume semaphore is module-level state, so every test needs its own copy
// of the module (and its own localStorage-seeded cached size).
async function freshUseTerminal(): Promise<typeof import('../useTerminal').useTerminal> {
  vi.resetModules()
  return (await import('../useTerminal')).useTerminal
}

/** Mock backend whose terminal.create hangs until the test releases it — the
 *  wedged-backend condition the whole feature exists for. Other request types
 *  (notably terminal.create.cancel) answer normally. */
function createGatedBackend() {
  const mock = createMockBackend()
  mock.setResponse('terminal.create', { terminal_session_id: 'sess', pid: 7 })
  const inner = mock.backend.send
  const gates: Array<() => void> = []
  ;(mock.backend as unknown as { send: unknown }).send = (
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number
  ) => {
    const answer = inner(type, payload, timeoutMs)
    if (type !== 'terminal.create') return answer
    return new Promise((resolve) => gates.push(() => resolve(answer)))
  }
  return { mock, gates }
}

function creates(sent: { type: string; payload: Record<string, unknown> }[]): string[] {
  return sent.filter((s) => s.type === 'terminal.create').map((s) => String(s.payload.pane_id))
}

/** Flush the promise chains spawn() awaits, plus Vue's pre-flush watchers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(1)
}

const RESUME_SPAWN = { command: 'claude', cwd: '/tmp', isResume: true, skipReattach: true }

describe('useTerminal — stalled startup is reported, not silent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    written.lines.length = 0
    measurable.cbs.length = 0
    resized.cbs.length = 0
    cap.value = 1
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    localStorage.clear()
  })

  // A cached size lets a hidden resume proceed all the way to the semaphore
  // instead of parking on "no width to borrow".
  function seedCachedSize(): void {
    localStorage.setItem('terminal-last-size', JSON.stringify({ cols: 120, rows: 30 }))
  }

  it('errors a resume queued behind a wedged create instead of waiting forever', async () => {
    seedCachedSize()
    const useTerminal = await freshUseTerminal()
    const { mock } = createGatedBackend()
    const a = withScope(() => useTerminal('pane-a', mock.backend))
    const b = withScope(() => useTerminal('pane-b', mock.backend))

    void a.result.spawn({ ...RESUME_SPAWN })
    await settle()
    void b.result.spawn({ ...RESUME_SPAWN })
    await settle()

    // b is behind the semaphore: its create was never even transmitted.
    expect(creates(mock.sent)).toEqual(['pane-a'])
    expect(b.result.status.value).toBe('starting')

    await vi.advanceTimersByTimeAsync(45_000)

    expect(b.result.status.value).toBe('error')
    expect(b.result.error.value).toContain('resume spawn queue timed out')
    expect(b.result.stallReason.value).toBe('resume-queue-timeout')
    // Still never sent — the timeout must not race a create out the door.
    expect(creates(mock.sent)).toEqual(['pane-a'])

    a.scope.stop()
    b.scope.stop()
  })

  it('returns the slot to the pool when a queued waiter times out', async () => {
    seedCachedSize()
    const useTerminal = await freshUseTerminal()
    const { mock, gates } = createGatedBackend()
    const a = withScope(() => useTerminal('pane-a', mock.backend))
    const b = withScope(() => useTerminal('pane-b', mock.backend))
    const c = withScope(() => useTerminal('pane-c', mock.backend))

    void a.result.spawn({ ...RESUME_SPAWN })
    await settle()
    void b.result.spawn({ ...RESUME_SPAWN })
    await settle()
    await vi.advanceTimersByTimeAsync(45_000)
    expect(b.result.status.value).toBe('error')

    // a finally acks and releases. Had the release handed its slot to the
    // timed-out waiter b, the slot would vanish and c would queue forever.
    gates[0]()
    await settle()
    expect(a.result.status.value).toBe('running')

    void c.result.spawn({ ...RESUME_SPAWN })
    await settle()
    expect(creates(mock.sent)).toEqual(['pane-a', 'pane-c'])

    a.scope.stop()
    b.scope.stop()
    c.scope.stop()
  })

  it('does not flag a parked resume — waiting for a hidden tab is by design', async () => {
    // No cached size, hidden pane: the resume parks and is SUPPOSED to wait
    // indefinitely until its tab is shown. The watchdog must stay silent.
    const useTerminal = await freshUseTerminal()
    const { mock } = createGatedBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))

    await result.spawn({ ...RESUME_SPAWN })
    await settle()
    expect(result.status.value).toBe('starting')
    expect(result.stallReason.value).toBe('hidden-resume-no-cached-size')

    await vi.advanceTimersByTimeAsync(180_000)

    expect(result.status.value).toBe('starting')
    expect(result.error.value).toBe('')
    expect(creates(mock.sent)).toEqual([])
    scope.stop()
  })

  it('stands down while terminal.create is in flight (that RPC owns its deadline)', async () => {
    seedCachedSize()
    const useTerminal = await freshUseTerminal()
    const { mock } = createGatedBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))

    void result.spawn({ command: 'bash', cwd: '/tmp' })
    await settle()
    expect(creates(mock.sent)).toEqual(['pane-1'])

    await vi.advanceTimersByTimeAsync(180_000)

    expect(result.status.value).toBe('starting')
    scope.stop()
  })

  it('errors a pane left in starting with nothing pending, naming the exit taken', async () => {
    const useTerminal = await freshUseTerminal()
    const { mock } = createGatedBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))

    await result.spawn({ ...RESUME_SPAWN })
    await settle()
    expect(result.stallReason.value).toBe('hidden-resume-no-cached-size')
    // Drops the parked spawn while leaving the pane in 'starting' — the shape
    // of every stall the watchdog is meant to catch (nothing pending, nothing
    // in flight, nothing left to report it).
    await result.cancelPendingCreate()
    await settle()
    expect(result.status.value).toBe('starting')

    await vi.advanceTimersByTimeAsync(65_000)

    expect(result.status.value).toBe('error')
    expect(result.error.value).toContain('hidden-resume-no-cached-size')
    expect(written.lines.some((l) => l.includes('hidden-resume-no-cached-size'))).toBe(true)
    scope.stop()
  })

  it('does not flag an unparked resume still waiting in the spawn queue', async () => {
    // No cached size at import time, so this resume parks while hidden.
    const useTerminal = await freshUseTerminal()
    const { mock } = createGatedBackend()
    const a = withScope(() => useTerminal('pane-a', mock.backend))
    const b = withScope(() => useTerminal('pane-b', mock.backend))

    void b.result.spawn({ ...RESUME_SPAWN })
    await settle()
    expect(b.result.stallReason.value).toBe('hidden-resume-no-cached-size')

    // Parked far past the watchdog threshold — legitimately so, per the
    // parked-resume test above. Its 'starting' age is now stale.
    await vi.advanceTimersByTimeAsync(70_000)
    expect(b.result.status.value).toBe('starting')

    // A visible terminal publishes a size, so the parked resume finally has one
    // to borrow. pane-a grabs the single slot first and never acks.
    resized.cbs[0]!({ cols: 120, rows: 30 })
    void a.result.spawn({ ...RESUME_SPAWN })
    await settle()
    expect(creates(mock.sent)).toEqual(['pane-a'])

    // b's tab is shown: the observer unparks it, _doCreate clears pendingSpawn
    // and blocks in the resume semaphore. pendingSpawn is null, createInFlight
    // is false, _creating is true — the window only the _creating guard covers.
    measurable.cbs[1]!()
    await settle()
    expect(creates(mock.sent)).toEqual(['pane-a'])
    expect(b.result.status.value).toBe('starting')

    // The watchdog ticks all through the queue wait with the age already past
    // 60s. Without the guard it errored here, quoting the PREVIOUS park's
    // reason, at a pane that would have gone on to spawn fine.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(b.result.status.value).toBe('starting')
    expect(b.result.error.value).toBe('')
    expect(written.lines.some((l) => l.includes('startup stalled'))).toBe(false)

    // Not a blind spot: the queue timeout still reports for itself.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(b.result.status.value).toBe('error')
    expect(b.result.stallReason.value).toBe('resume-queue-timeout')
    expect(b.result.error.value).toContain('resume spawn queue timed out')

    a.scope.stop()
    b.scope.stop()
  })

  it('clears the stall reason once the create is actually transmitted', async () => {
    seedCachedSize()
    const useTerminal = await freshUseTerminal()
    const { mock, gates } = createGatedBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))

    void result.spawn({ ...RESUME_SPAWN })
    await settle()
    gates[0]()
    await settle()

    expect(result.status.value).toBe('running')
    expect(result.stallReason.value).toBeNull()
    scope.stop()
  })
})
