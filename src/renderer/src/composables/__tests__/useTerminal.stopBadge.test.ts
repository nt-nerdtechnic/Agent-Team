// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// STOP badge re-architecture: STOP is driven by the explicit interrupt action
// (persisted + broadcast by App.vue), NOT by keystroke sniffing. These tests
// pin the composable-side contract:
//   - displayStatus reports 'stopped' when isStopped over a running/idle status,
//     but a real 'exited'/'error' status still wins.
//   - a bare ESC (\x1b) typed into the terminal no longer SETS stopped (that was
//     the fragile, codex-breaking path).
//   - typing (Enter / printable) while stopped CLEARS it and fires onUserResume.
//
// xterm won't boot in happy-dom, so it's mocked; the mock captures the onData
// handler so a test can feed keystrokes directly.

const captured = vi.hoisted(() => ({ dataHandler: undefined as ((d: string) => void) | undefined }))

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

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea = document.createElement('textarea')
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(cb: (d: string) => void): { dispose(): void } {
      captured.dataHandler = cb
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
    proposeDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 } }
  },
}))

import { useTerminal } from '../useTerminal'

describe('useTerminal — STOP badge', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    captured.dataHandler = undefined
  })

  async function spawned(onUserResume?: () => void) {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() =>
      useTerminal('pane-1', mock.backend, onUserResume ? { onUserResume } : undefined)
    )
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { result, mock, scope }
  }

  it("displayStatus is 'stopped' when isStopped over a running/idle status", async () => {
    const { result, scope } = await spawned()
    result.isStopped.value = true
    expect(result.displayStatus.value).toBe('stopped')
    scope.stop()
  })

  it("'exited' still wins over stopped", async () => {
    const { result, scope } = await spawned()
    result.isStopped.value = true
    result.status.value = 'exited'
    expect(result.displayStatus.value).toBe('exited')
    scope.stop()
  })

  it('a bare ESC (\\x1b) typed into the terminal does NOT set stopped', async () => {
    const { result, scope } = await spawned()
    expect(result.isStopped.value).toBe(false)
    captured.dataHandler!('\x1b')
    expect(result.isStopped.value).toBe(false)
    // Ctrl-C likewise no longer sets it.
    captured.dataHandler!('\x03')
    expect(result.isStopped.value).toBe(false)
    scope.stop()
  })

  it('Enter while stopped clears it and calls onUserResume', async () => {
    const onUserResume = vi.fn()
    const { result, scope } = await spawned(onUserResume)
    result.isStopped.value = true
    captured.dataHandler!('\r')
    expect(result.isStopped.value).toBe(false)
    expect(onUserResume).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('printable input while stopped clears it and calls onUserResume', async () => {
    const onUserResume = vi.fn()
    const { result, scope } = await spawned(onUserResume)
    result.isStopped.value = true
    captured.dataHandler!('h')
    expect(result.isStopped.value).toBe(false)
    expect(onUserResume).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('onUserResume does NOT fire when input arrives and it was not stopped', async () => {
    const onUserResume = vi.fn()
    const { result, scope } = await spawned(onUserResume)
    expect(result.isStopped.value).toBe(false)
    captured.dataHandler!('h')
    captured.dataHandler!('\r')
    expect(onUserResume).not.toHaveBeenCalled()
    scope.stop()
  })
})
