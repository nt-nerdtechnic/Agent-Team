// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockBackend, withScope, type SentRecord } from './mockBackend'

// A pane spawned while hidden (workspace restore, pipeline stage in a background
// tab) has no measurable width, so its PTY used to start at xterm's 80x24
// default and the CLI drew its banner/footer that narrow — permanently, since
// already-printed output never re-wraps wider. These tests pin the borrowed-size
// behavior that prevents it.

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 0,
  ackedRows: 0,
}))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

// Every constructed stub lands here so a test can drive the instance the
// composable holds privately (useTerminal does not expose `term`).
const terms = vi.hoisted(() => ({ list: [] as { resize(c: number, r: number): void }[] }))

// Unlike the other suites' stub, this Terminal's resize() actually mutates
// cols/rows and notifies onResize — the borrowed size is applied through it.
vi.mock('@xterm/xterm', () => {
  class Terminal {
    constructor() {
      terms.list.push(this as unknown as { resize(c: number, r: number): void })
    }

    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    private resizeHandlers: ((d: { cols: number; rows: number }) => void)[] = []
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(cb: (d: { cols: number; rows: number }) => void): { dispose(): void } {
      this.resizeHandlers.push(cb)
      return { dispose: (): void => {} }
    }
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
    write(): void {}
    writeln(): void {}
    resize(cols: number, rows: number): void {
      if (cols === this.cols && rows === this.rows) return
      this.cols = cols
      this.rows = rows
      this.resizeHandlers.forEach((cb) => cb({ cols, rows }))
    }
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
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

// Module-level cached dimensions are seeded at import time, so each test
// re-imports with the localStorage it wants in place.
async function freshUseTerminal(): Promise<typeof import('../useTerminal').useTerminal> {
  vi.resetModules()
  return (await import('../useTerminal')).useTerminal
}

function createPayload(sent: SentRecord[]): Record<string, unknown> {
  const rec = sent.find((s) => s.type === 'terminal.create')
  expect(rec, 'terminal.create was never sent').toBeTruthy()
  return rec!.payload
}

describe('useTerminal — hidden spawn borrows the cached size', () => {
  beforeEach(() => {
    localStorage.clear()
    terms.list.length = 0
  })

  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  // A detached element reports clientWidth 0, i.e. exactly the hidden case.
  async function spawnHidden(opts: Record<string, unknown> = {}) {
    const useTerminal = await freshUseTerminal()
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', ...opts })
    return { mock, scope }
  }

  it('falls back to 80x24 when nothing has ever been measured', async () => {
    const { mock, scope } = await spawnHidden()
    const payload = createPayload(mock.sent)
    expect(payload.cols).toBe(80)
    expect(payload.rows).toBe(24)
    scope.stop()
  })

  it('starts a fresh hidden spawn at the persisted size instead of 80x24', async () => {
    localStorage.setItem('terminal-last-size', JSON.stringify({ cols: 203, rows: 51 }))
    const { mock, scope } = await spawnHidden()
    const payload = createPayload(mock.sent)
    expect(payload.cols).toBe(203)
    expect(payload.rows).toBe(51)
    scope.stop()
  })

  it('starts a hidden resume at the persisted size rather than deferring it', async () => {
    localStorage.setItem('terminal-last-size', JSON.stringify({ cols: 160, rows: 40 }))
    const { mock, scope } = await spawnHidden({ isResume: true, skipReattach: true })
    const payload = createPayload(mock.sent)
    expect(payload.cols).toBe(160)
    expect(payload.rows).toBe(40)
    scope.stop()
  })

  it('still defers a hidden resume when there is no size to borrow', async () => {
    const { mock, scope } = await spawnHidden({ isResume: true, skipReattach: true })
    expect(mock.sent.some((s) => s.type === 'terminal.create')).toBe(false)
    scope.stop()
  })

  it('ignores a malformed persisted size', async () => {
    localStorage.setItem('terminal-last-size', '{"cols":"wide","rows":0}')
    const { mock, scope } = await spawnHidden()
    const payload = createPayload(mock.sent)
    expect(payload.cols).toBe(80)
    expect(payload.rows).toBe(24)
    scope.stop()
  })

  it('persists the measured size so the next run can borrow it', async () => {
    const useTerminal = await freshUseTerminal()
    const mock = createMockBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    // Stand in for the fit that happens once the pane is visible.
    terms.list.at(-1)!.resize(212, 55)
    expect(JSON.parse(localStorage.getItem('terminal-last-size') ?? '{}')).toEqual({
      cols: 212,
      rows: 55,
    })
    scope.stop()
  })
})
