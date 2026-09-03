// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// A pane gates stdin while its CLI is still booting (App.vue drives this through
// TerminalPane's isPreparing watch). That gate used to be xterm's disableStdin,
// which drops keystrokes on the floor — the user's first characters vanished and
// the pane looked like it had lagged. The gate now buffers and replays instead,
// so typing during startup is late, never lost.

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
  textarea: undefined as HTMLTextAreaElement | undefined,
  dataHandler: undefined as ((data: string) => void) | undefined,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea: HTMLTextAreaElement | undefined
    getSelection(): string { return '' }
    get modes(): { mouseTrackingMode: string; bracketedPasteMode: boolean } {
      return { mouseTrackingMode: 'none', bracketedPasteMode: false }
    }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(el: HTMLElement): void {
      this.textarea = document.createElement('textarea')
      el.appendChild(this.textarea)
      captured.textarea = this.textarea
    }
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(cb: (data: string) => void): { dispose(): void } {
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

describe('useTerminal — spawn-phase input gate', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    captured.textarea = undefined
    captured.dataHandler = undefined
    localStorage.clear()
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', agentKey: 'claude' })
    return { mock, scope, terminal: result }
  }

  function type(text: string): void {
    for (const ch of text) captured.dataHandler!(ch)
  }

  /** Diagnostics the renderer forwarded to backend.log, newest last. */
  function diagnostics(mock: ReturnType<typeof createMockBackend>): string[] {
    return mock.sent
      .filter((s) => s.type === 'client.diagnostic')
      .map((s) => (s.payload as { message: string }).message)
  }

  function sentInput(mock: ReturnType<typeof createMockBackend>): string {
    return mock.sent
      .filter((s) => s.type === 'terminal.input')
      .map((s) => (s.payload as { data: string }).data)
      .join('')
  }

  it('sends keystrokes straight through when the pane is not preparing', async () => {
    const { mock, scope } = await spawnedTerminal()
    type('abc')
    expect(sentInput(mock)).toBe('abc')
    scope.stop()
  })

  it('holds keystrokes while preparing instead of dropping them', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    type('abcd')
    expect(sentInput(mock)).toBe('')
    scope.stop()
  })

  it('replays the held keystrokes in order once the pane is ready', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    type('hello')
    terminal.setDisableStdin(false)
    expect(sentInput(mock)).toBe('hello')
    scope.stop()
  })

  it('keeps typing live after the gate lifts', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    type('ab')
    terminal.setDisableStdin(false)
    type('cd')
    expect(sentInput(mock)).toBe('abcd')
    scope.stop()
  })

  it('replays only once, so a repeated ready does not double-send', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    type('once')
    terminal.setDisableStdin(false)
    terminal.setDisableStdin(false)
    expect(sentInput(mock)).toBe('once')
    scope.stop()
  })

  it('caps the buffer, keeping the most recent input', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    captured.dataHandler!('x'.repeat(4096))
    captured.dataHandler!('TAIL')
    terminal.setDisableStdin(false)
    const sent = sentInput(mock)
    expect(sent).toHaveLength(4096)
    expect(sent.endsWith('TAIL')).toBe(true)
    scope.stop()
  })

  // The renderer's half of the round-trip. The backend logs its own half, and
  // the gap between the two numbers is the WebSocket plus this renderer — the
  // split that no log could show before.
  it('reports a slow keystroke round-trip', async () => {
    const { mock, scope } = await spawnedTerminal()
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(1_000_000)
    captured.dataHandler!('a')
    now.mockReturnValue(1_000_500)
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'a' })

    expect(diagnostics(mock)[0]).toContain('keystroke round-trip 500ms')
    scope.stop()
  })

  it('stays quiet when the echo comes back promptly', async () => {
    const { mock, scope } = await spawnedTerminal()
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(1_000_000)
    captured.dataHandler!('a')
    now.mockReturnValue(1_000_040)
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'a' })

    expect(diagnostics(mock)).toEqual([])
    scope.stop()
  })

  it('does not blame the keystroke for output that arrives much later', async () => {
    const { mock, scope } = await spawnedTerminal()
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(1_000_000)
    captured.dataHandler!('a')
    now.mockReturnValue(1_010_000) // the CLI was thinking, not echoing
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'result' })

    expect(diagnostics(mock)).toEqual([])
    scope.stop()
  })

  it('drops the buffer when the session died while preparing', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    type('into the void')
    mock.emit('terminal.exit', { terminal_session_id: 'sess-1', exit_code: 0, signal: null })
    terminal.setDisableStdin(false)
    expect(sentInput(mock)).toBe('')
    scope.stop()
  })
})
