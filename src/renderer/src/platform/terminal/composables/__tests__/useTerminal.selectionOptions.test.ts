// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Regression guard for GitHub issue #13. xterm disables selection whenever a
// CLI turns on mouse reporting, and the only escape hatch on macOS is
// shouldForceSelection() == `altKey && macOptionClickForcesSelection`. Leaving
// the option at its default `false` makes that permanently false, so under any
// TUI (vim/htop/tmux/less) no modifier restores text selection on macOS —
// other platforms keep Shift+drag via the `shiftKey` branch.

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
  ctorOptions: undefined as Record<string, unknown> | undefined,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    buffer = {
      active: {
        type: 'normal',
        viewportY: 0,
        baseY: 0,
        cursorX: 0,
        cursorY: 0,
        getLine: () => undefined,
      },
    }
    modes = { mouseTrackingMode: 'none' }
    constructor(options: Record<string, unknown>) {
      captured.ctorOptions = options
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

describe('useTerminal — selection options', () => {
  afterEach(() => {
    vi.clearAllMocks()
    captured.ctorOptions = undefined
    localStorage.clear()
  })

  it('enables macOptionClickForcesSelection so Option+drag selects under a TUI', () => {
    const mock = createMockBackend()
    const { scope } = withScope(() => useTerminal('pane-1', mock.backend))
    expect(captured.ctorOptions?.macOptionClickForcesSelection).toBe(true)
    scope.stop()
  })

  it('leaves macOptionIsMeta alone — Option stays a plain keyboard modifier', () => {
    const mock = createMockBackend()
    const { scope } = withScope(() => useTerminal('pane-1', mock.backend))
    expect(captured.ctorOptions).not.toHaveProperty('macOptionIsMeta')
    scope.stop()
  })
})
