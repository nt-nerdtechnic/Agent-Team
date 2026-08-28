// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// In the alternate buffer, wheel events must only reach the PTY when the app
// enabled mouse tracking. Otherwise xterm's alternateScroll fallback turns
// each wheel notch into an ↑/↓ arrow escape sequence, which agent CLIs
// (Claude Code, Codex, ...) interpret as readline history recall — scrolling
// up pulled the previous submitted prompt into the input line.
// xterm won't boot in happy-dom, so the mock captures the custom wheel event
// handler and the test drives it directly.

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

const captured = vi.hoisted(() => ({
  wheelHandler: undefined as ((e: WheelEvent) => boolean) | undefined,
  bufferType: 'normal' as string,
  mouseTrackingMode: 'none' as string,
  scrollLines: vi.fn(),
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
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
    scrollLines(lines: number): void {
      captured.scrollLines(lines)
    }
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

describe('useTerminal — wheel handling in alternate buffer', () => {
  afterEach(() => {
    vi.clearAllMocks()
    captured.wheelHandler = undefined
    captured.bufferType = 'normal'
    captured.mouseTrackingMode = 'none'
    localStorage.clear() // drop the persisted PTY id so the next spawn is fresh
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { mock, scope }
  }

  it('swallows wheel events when the alt-buffer app has no mouse tracking', async () => {
    const { scope } = await spawnedTerminal()
    captured.bufferType = 'alternate'
    captured.mouseTrackingMode = 'none'
    const handled = captured.wheelHandler!(wheelEvent(-1))
    expect(handled).toBe(false)
    expect(captured.scrollLines).not.toHaveBeenCalled()
    scope.stop()
  })

  it('forwards wheel events when the alt-buffer app enabled mouse tracking', async () => {
    const { scope } = await spawnedTerminal()
    captured.bufferType = 'alternate'
    for (const mode of ['x10', 'vt200', 'drag', 'any']) {
      captured.mouseTrackingMode = mode
      expect(captured.wheelHandler!(wheelEvent(-1))).toBe(true)
    }
    expect(captured.scrollLines).not.toHaveBeenCalled()
    scope.stop()
  })

  it('scrolls the scrollback itself in the normal buffer', async () => {
    const { scope } = await spawnedTerminal()
    const handled = captured.wheelHandler!(wheelEvent(-2))
    expect(handled).toBe(false)
    expect(captured.scrollLines).toHaveBeenCalledWith(-2)
    scope.stop()
  })
})
