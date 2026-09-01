// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Scroll grace for the RUNNING badge. When the alt-buffer app has mouse
// tracking enabled, wheel events are forwarded to the PTY and the TUI repaints
// a SHIFTED viewport. That repaint is real content (survives noise-stripping)
// and is reassembled/reflowed (defeats isRedrawReplay's contiguous-substring
// check), so a sustained scroll used to latch RUNNING. The fix: a forwarded
// wheel event arms SCROLL_GRACE_MS; output inside the window is excluded from
// burst/latch tracking and the activity clock. These tests pin:
//   1. a scroll-driven repaint stream never latches RUNNING;
//   2. the grace expires — genuine output afterwards still latches;
//   3. an already-latched RUNNING coasts through a scroll (latch untouched);
//   4. a main-buffer wheel (swallowed locally, nothing reaches the PTY) does
//      NOT arm the grace, so concurrent real output still latches;
//   5. a scroll longer than IDLE_CONFIRM_MS still does not drop RUNNING — the
//      frozen activity clock used to age out under displayStatus's silence
//      timeout, so the badge fell to IDLE while the agent was visibly working;
//   6. the guard on (5): scrolling a pane that already went idle must NOT
//      resurrect RUNNING;
//   7. genuine output right after a long scroll keeps RUNNING without having to
//      re-earn the latch through another MIN_BURST_MS.
// xterm won't boot in happy-dom; the mock captures the custom wheel handler
// and the tests drive it directly.

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

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

const captured = vi.hoisted(() => ({
  wheelHandler: undefined as ((e: WheelEvent) => boolean) | undefined,
  bufferType: 'normal' as string,
  mouseTrackingMode: 'none' as string,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea = document.createElement('textarea')
    buffer = {
      active: {
        get type() {
          return captured.bufferType
        },
        viewportY: 0,
        baseY: 0,
        cursorX: 0,
        cursorY: 0,
        getLine: () => undefined,
      },
    }
    get modes() {
      return { mouseTrackingMode: captured.mouseTrackingMode }
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(handler: (e: WheelEvent) => boolean): void {
      captured.wheelHandler = handler
    }
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
    write(): void {}
    writeln(): void {}
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

import { useTerminal } from '../useTerminal'

function wheelEvent(deltaY: number): WheelEvent {
  return { deltaY, deltaMode: WheelEvent.DOM_DELTA_LINE } as WheelEvent
}

describe('useTerminal — scroll grace vs the RUNNING badge', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    captured.wheelHandler = undefined
    captured.bufferType = 'normal'
    captured.mouseTrackingMode = 'none'
    localStorage.clear()
  })

  async function spawnedFake() {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    const spawning = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await vi.advanceTimersByTimeAsync(200)
    await spawning
    return { result, mock, scope }
  }

  // Distinct content per chunk: identical text would be dropped as a redraw
  // replay, which is not the path under test here.
  function emitChunk(mock: ReturnType<typeof createMockBackend>, n: number, tag: string): void {
    mock.emit('terminal.output', {
      terminal_session_id: 'sess-1',
      data: `${tag} line ${n}: some scrolled-in conversation history text\r\n`,
    })
  }

  // Build a genuine burst that latches RUNNING (chunks 1.5s apart, > MIN_BURST_MS).
  async function latchRunning(
    result: Awaited<ReturnType<typeof spawnedFake>>['result'],
    mock: ReturnType<typeof createMockBackend>,
  ): Promise<void> {
    for (let i = 0; i < 5; i++) {
      emitChunk(mock, i, 'work')
      await vi.advanceTimersByTimeAsync(1_500)
    }
    expect(result.displayStatus.value).toBe('running')
  }

  it('a scroll-driven repaint stream never latches RUNNING', async () => {
    const { result, mock, scope } = await spawnedFake()
    captured.bufferType = 'alternate'
    captured.mouseTrackingMode = 'vt200'
    // 6s of sustained scrolling: each notch is forwarded (handler returns true,
    // arming the grace) and the TUI answers with a distinct shifted-viewport
    // frame. Well past MIN_BURST_MS, yet no burst may form.
    for (let i = 0; i < 24; i++) {
      expect(captured.wheelHandler!(wheelEvent(-1))).toBe(true)
      emitChunk(mock, i, 'scroll')
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(result.displayStatus.value).not.toBe('running')
    scope.stop()
  })

  it('genuine output after the grace expires still latches RUNNING', async () => {
    const { result, mock, scope } = await spawnedFake()
    captured.bufferType = 'alternate'
    captured.mouseTrackingMode = 'vt200'
    // One scroll, then silence past SCROLL_GRACE_MS (1s) — the grace must not
    // keep masking real work afterwards.
    expect(captured.wheelHandler!(wheelEvent(-1))).toBe(true)
    await vi.advanceTimersByTimeAsync(1_200)
    await latchRunning(result, mock)
    scope.stop()
  })

  it('an already-latched RUNNING coasts through a scroll', async () => {
    const { result, mock, scope } = await spawnedFake()
    await latchRunning(result, mock)
    captured.bufferType = 'alternate'
    captured.mouseTrackingMode = 'vt200'
    // 3s of scrolling mid-run: repaint chunks are excluded from burst tracking
    // but must not drop the latch either — the badge keeps showing RUNNING on
    // hysteresis (scroll span stays well under IDLE_CONFIRM_MS).
    for (let i = 0; i < 12; i++) {
      expect(captured.wheelHandler!(wheelEvent(-1))).toBe(true)
      emitChunk(mock, i, 'scroll')
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  })

  it('a scroll longer than IDLE_CONFIRM_MS does not drop RUNNING', async () => {
    const { result, mock, scope } = await spawnedFake()
    await latchRunning(result, mock)
    captured.bufferType = 'alternate'
    captured.mouseTrackingMode = 'vt200'
    // 15s of sustained scrolling — past IDLE_CONFIRM_MS (10s). Every repaint
    // chunk lands inside the grace and cannot advance the activity clock, so
    // nothing but the wheel handler keeps it moving. The agent is still working
    // throughout; the badge must not report idle.
    for (let i = 0; i < 60; i++) {
      expect(captured.wheelHandler!(wheelEvent(-1))).toBe(true)
      emitChunk(mock, i, 'scroll')
      await vi.advanceTimersByTimeAsync(250)
      expect(result.displayStatus.value).toBe('running')
    }
    scope.stop()
  })

  it('scrolling a pane that already went idle does not resurrect RUNNING', async () => {
    const { result, mock, scope } = await spawnedFake()
    await latchRunning(result, mock)
    // Silence past IDLE_CONFIRM_MS settles the badge to idle. The latch itself
    // is still set — only appendClean clears it, and no output is arriving —
    // so the wheel handler must consult the same timeout, not the raw latch.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(result.displayStatus.value).toBe('idle')
    captured.bufferType = 'alternate'
    captured.mouseTrackingMode = 'vt200'
    for (let i = 0; i < 12; i++) {
      expect(captured.wheelHandler!(wheelEvent(-1))).toBe(true)
      emitChunk(mock, i, 'scroll')
      await vi.advanceTimersByTimeAsync(250)
    }
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('output right after a long scroll keeps RUNNING without re-earning the latch', async () => {
    const { result, mock, scope } = await spawnedFake()
    await latchRunning(result, mock)
    captured.bufferType = 'alternate'
    captured.mouseTrackingMode = 'vt200'
    for (let i = 0; i < 60; i++) {
      expect(captured.wheelHandler!(wheelEvent(-1))).toBe(true)
      emitChunk(mock, i, 'scroll')
      await vi.advanceTimersByTimeAsync(250)
    }
    // Scrolling stops; the grace lapses and the agent's next chunk arrives.
    // Measured against the carried-forward clock this is a short gap, so the
    // latch survives — the badge stays RUNNING instead of blinking to IDLE for
    // another MIN_BURST_MS while the burst is rebuilt.
    await vi.advanceTimersByTimeAsync(1_200)
    emitChunk(mock, 99, 'work')
    await vi.advanceTimersByTimeAsync(100)
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  })

  it('a main-buffer wheel does not arm the grace', async () => {
    const { result, mock, scope } = await spawnedFake()
    // Normal buffer: the handler scrolls xterm's scrollback locally and
    // swallows the event — nothing reaches the PTY, so concurrent genuine
    // output must still build a burst and latch RUNNING.
    for (let i = 0; i < 5; i++) {
      expect(captured.wheelHandler!(wheelEvent(-1))).toBe(false)
      emitChunk(mock, i, 'work')
      await vi.advanceTimersByTimeAsync(1_500)
    }
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  })
})
