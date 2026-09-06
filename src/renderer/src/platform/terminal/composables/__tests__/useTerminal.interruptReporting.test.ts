// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// useTerminal.interrupt has to report whether the interrupt was ISSUED, not
// merely whether awaiting it resolved. Two of its exits are silent — no
// session, and a transport that is not connected — and both resolve exactly
// like a successful send. STOP pressed by hand does not care; ui.pane.interrupt
// does, because it is the only thing that tells an MCP caller in another window
// that its interrupt went nowhere.
//
// xterm won't boot in happy-dom, so it's mocked the same way as the STOP badge
// tests next door.

const captured = vi.hoisted(() => ({ dataHandler: undefined as ((d: string) => void) | undefined }))

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
    proposeDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 } }
  },
}))

import { useTerminal } from '../useTerminal'

describe('useTerminal — interrupt reports whether it was issued', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    captured.dataHandler = undefined
  })

  async function spawned(mock: ReturnType<typeof createMockBackend>) {
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { result, scope }
  }

  it('sends the interrupt and reports true on a connected transport', async () => {
    const mock = createMockBackend()
    const { result, scope } = await spawned(mock)

    await expect(result.interrupt()).resolves.toBe(true)

    expect(mock.sent.some((s) => s.type === 'terminal.interrupt')).toBe(true)
    expect(result.isStopped.value).toBe(true)
    scope.stop()
  })

  it('reports false, and sends nothing, when the window\'s socket is down', async () => {
    // The case that made a bare `Promise<void>` a lie: a queued SIGINT would
    // land on whatever turn is running after the reconnect, so the request is
    // dropped — and dropping it resolved exactly like sending it.
    const mock = createMockBackend()
    const { result, scope } = await spawned(mock)
    const before = mock.sent.filter((s) => s.type === 'terminal.interrupt').length
    mock.status.value = 'connecting'

    await expect(result.interrupt()).resolves.toBe(false)

    expect(mock.sent.filter((s) => s.type === 'terminal.interrupt').length).toBe(before)
    // And the STOP badge must not advertise an interrupt that never left.
    expect(result.isStopped.value).toBe(false)
    scope.stop()
  })

  it('reports false when the backend refuses the request', async () => {
    // wsClient resolves an ok:false rather than rejecting it, so reading the
    // reply is the only way to notice.
    const mock = createMockBackend()
    const { result, scope } = await spawned(mock)
    mock.setResponse('terminal.interrupt', null, {
      ok: false,
      error: { code: 'no_session', message: 'gone' },
    })

    await expect(result.interrupt()).resolves.toBe(false)
    scope.stop()
  })

  it('reports false when there is no session to interrupt', async () => {
    const mock = createMockBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))

    await expect(result.interrupt()).resolves.toBe(false)

    expect(mock.sent.some((s) => s.type === 'terminal.interrupt')).toBe(false)
    scope.stop()
  })
})
