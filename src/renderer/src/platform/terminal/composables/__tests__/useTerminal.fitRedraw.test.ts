// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// fitTerminal's redraw opt-in is glue between useTerminal and the resize
// controller, so the controller (and xterm, which won't boot in happy-dom)
// are mocked and only the delegation is asserted. The gate behavior behind
// requestResizeRedraw is covered by useTerminalResize.test.ts.

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

// Mutable so tests can simulate the container settling at a size that differs
// from the one xterm was fitted at (the fresh-spawn wrong-width scenario).
const fitDims = vi.hoisted(() => ({ cols: 80, rows: 24 }))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { ...fitDims }
    }
  },
}))

import { useTerminal } from '../useTerminal'

describe('useTerminal.fitTerminal — redrawAfterSettle option', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  function mountedTerminal() {
    const mock = createMockBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    return { result, scope }
  }

  it('default call fits without arming the redraw (spawn/reconciler paths unchanged)', () => {
    const { result, scope } = mountedTerminal()
    result.fitTerminal()
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    expect(ctrl.requestResizeRedraw).not.toHaveBeenCalled()
    scope.stop()
  })

  it('redrawAfterSettle: true fits then arms the gated redraw', () => {
    const { result, scope } = mountedTerminal()
    result.fitTerminal({ redrawAfterSettle: true })
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('stays a no-op before mount, even with the flag', () => {
    const mock = createMockBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.fitTerminal({ redrawAfterSettle: true })
    expect(ctrl.applyFit).not.toHaveBeenCalled()
    expect(ctrl.requestResizeRedraw).not.toHaveBeenCalled()
    scope.stop()
  })
})

describe('useTerminal — fresh-spawn delayed refit', () => {
  beforeEach(() => {
    // rAF must be faked too: the delayed refit schedules a double-rAF attempt
    // plus a setTimeout retry. Microtasks stay real so awaited send() settles.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    fitDims.cols = 80
    fitDims.rows = 24
    localStorage.clear() // drop the persisted PTY id so the next spawn is fresh
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    // The immediate post-create fit + gated redraw have already run once.
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(1)
    return { result, scope }
  }

  it('re-fits and arms the gated redraw when the settled size differs', async () => {
    const { scope } = await spawnedTerminal()
    // Layout settles at a different size than the pre-create measurement.
    fitDims.cols = 120
    fitDims.rows = 30
    await vi.advanceTimersByTimeAsync(40) // two rAF frames → delayed attempt
    expect(ctrl.applyFit).toHaveBeenCalledTimes(2)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(2)
    // Once converged (fit matches xterm again), the late retry is a no-op.
    fitDims.cols = 80
    fitDims.rows = 24
    await vi.advanceTimersByTimeAsync(400)
    expect(ctrl.applyFit).toHaveBeenCalledTimes(2)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('stays idle when the fitted size already matches xterm', async () => {
    const { scope } = await spawnedTerminal()
    await vi.advanceTimersByTimeAsync(400) // rAF attempt + timer retry both skip
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('does not run after dispose', async () => {
    const { scope } = await spawnedTerminal()
    scope.stop()
    fitDims.cols = 120
    fitDims.rows = 30
    await vi.advanceTimersByTimeAsync(400)
    expect(ctrl.applyFit).toHaveBeenCalledTimes(1)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(1)
  })
})
