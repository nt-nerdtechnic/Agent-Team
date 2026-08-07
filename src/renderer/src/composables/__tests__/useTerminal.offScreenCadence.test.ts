// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import { createMockBackend, withScope } from './mockBackend'

// Paged-out panes stay mounted so their terminals survive, which meant every
// hidden pane kept paying for display-only upkeep: a per-second status tick
// (whose only consumers are the idle badge and starting age) and a 2s size
// reconcile that reads clientWidth — a synchronous layout — before deciding it
// is hidden. With many panes open that is a steady cost for pixels nobody can
// see. These tests pin the reduced off-screen cadence and the skipped reflow.

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 80,
  ackedRows: 24,
}))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
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

const TICK_ON_SCREEN_MS = 1_000
const TICK_OFF_SCREEN_MS = 10_000

/** Delays passed to every window.setInterval call made during `run`. */
function intervalDelays(run: () => void): number[] {
  const spy = vi.spyOn(window, 'setInterval')
  try {
    run()
    return spy.mock.calls.map((call) => call[1] as number)
  } finally {
    spy.mockRestore()
  }
}

describe('useTerminal — off-screen panes run their upkeep at a reduced cadence', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('ticks once a second while the pane is on screen', () => {
    const mock = createMockBackend()
    const delays = intervalDelays(() => {
      withScope(() => useTerminal('pane-on', mock.backend, { onScreen: () => true }))
    })
    expect(delays).toContain(TICK_ON_SCREEN_MS)
  })

  it('ticks ten times slower while the pane is off screen', () => {
    const mock = createMockBackend()
    const delays = intervalDelays(() => {
      withScope(() => useTerminal('pane-off', mock.backend, { onScreen: () => false }))
    })
    expect(delays).toContain(TICK_OFF_SCREEN_MS)
    expect(delays).not.toContain(TICK_ON_SCREEN_MS)
  })

  it('defaults to the on-screen cadence when the caller says nothing', () => {
    // AiCliTerminal and the tests above construct useTerminal without the
    // option; they must keep the original behaviour.
    const mock = createMockBackend()
    const delays = intervalDelays(() => {
      withScope(() => useTerminal('pane-default', mock.backend))
    })
    expect(delays).toContain(TICK_ON_SCREEN_MS)
  })

  it('restores the fast cadence when a pane comes back on screen', async () => {
    const mock = createMockBackend()
    const onScreen = ref(false)
    withScope(() => useTerminal('pane-toggle', mock.backend, { onScreen: () => onScreen.value }))

    const spy = vi.spyOn(window, 'setInterval')
    onScreen.value = true
    await nextTick()
    const delays = spy.mock.calls.map((call) => call[1] as number)
    spy.mockRestore()

    expect(delays).toContain(TICK_ON_SCREEN_MS)
  })

  it('does not read clientWidth for an off-screen pane', async () => {
    // clientWidth forces a synchronous layout. The reconcile loop used to read
    // it on every tick just to discover the pane was hidden.
    vi.useFakeTimers()
    try {
      const mock = createMockBackend()
      mock.setResponse('terminal.create', { terminal_session_id: 'sess-off', pid: 7 })
      const onScreen = ref(true)
      const { result } = withScope(() =>
        useTerminal('pane-reflow', mock.backend, { onScreen: () => onScreen.value }),
      )

      const el = document.createElement('div')
      const clientWidth = vi.fn(() => 0)
      Object.defineProperty(el, 'clientWidth', { get: clientWidth })
      result.mount(el)
      await result.spawn({ command: 'bash', cwd: '/tmp' })

      // Guard against a false pass: prove the reconcile loop really is running
      // and really does read clientWidth while the pane is on screen. Without
      // this, an early return anywhere upstream would satisfy the assertion
      // below for the wrong reason.
      clientWidth.mockClear()
      await vi.advanceTimersByTimeAsync(6_000)
      expect(clientWidth).toHaveBeenCalled()

      onScreen.value = false
      await nextTick()
      clientWidth.mockClear()

      await vi.advanceTimersByTimeAsync(6_000)  // several reconcile ticks

      expect(clientWidth).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
