// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Regression: custom key branches that send bytes themselves and return false
// must ALSO call e.preventDefault(). Returning false only stops xterm's own
// handling — the browser default still runs, moving the hidden helper-textarea
// caret away from the end of its value. xterm's CompositionHelper anchors IME
// compositions at value.length, so a displaced caret makes the next IME commit
// send stale text (e.g. Cmd+Left to line start, then typing Chinese inserted
// the tail of previously committed text instead of the new characters).

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
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
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
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
      captured.keyHandler = handler
    }
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

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    type: 'keydown',
    key: '',
    shiftKey: false,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

describe('useTerminal — cursor shortcuts prevent the browser default', () => {
  afterEach(() => {
    vi.clearAllMocks()
    captured.keyHandler = undefined
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

  function inputsSent(mock: ReturnType<typeof createMockBackend>) {
    return mock.sent
      .filter((s) => s.type === 'terminal.input')
      .map((s) => (s.payload as { data: string }).data)
  }

  const macShortcuts: Array<[string, Partial<KeyboardEvent>, string]> = [
    ['Cmd+Left → Ctrl+A', { key: 'ArrowLeft', metaKey: true }, '\x01'],
    ['Cmd+Right → Ctrl+E', { key: 'ArrowRight', metaKey: true }, '\x05'],
    ['Cmd+Backspace → Ctrl+U', { key: 'Backspace', metaKey: true }, '\x15'],
    ['Alt+Backspace → Ctrl+W', { key: 'Backspace', altKey: true }, '\x17'],
  ]

  for (const [name, overrides, bytes] of macShortcuts) {
    it(`${name}: sends bytes, swallows the key, prevents default`, async () => {
      const { mock, scope } = await spawnedTerminal()
      const e = keyEvent(overrides)
      const handled = captured.keyHandler!(e)
      expect(handled).toBe(false)
      expect(e.preventDefault).toHaveBeenCalled()
      expect(inputsSent(mock)).toEqual([bytes])
      scope.stop()
    })
  }

  it('Shift+Arrow selection extension prevents default', async () => {
    const { mock, scope } = await spawnedTerminal()
    const e = keyEvent({ key: 'ArrowRight', shiftKey: true })
    const handled = captured.keyHandler!(e)
    expect(handled).toBe(false)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(inputsSent(mock)).toEqual(['\x1b[C'])
    scope.stop()
  })

  it('Cmd+Shift+Arrow line selection prevents default', async () => {
    const { scope } = await spawnedTerminal()
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      const e = keyEvent({ key, metaKey: true, shiftKey: true })
      const handled = captured.keyHandler!(e)
      expect(handled).toBe(false)
      expect(e.preventDefault).toHaveBeenCalled()
    }
    scope.stop()
  })

  it('Backspace with an active selection prevents default', async () => {
    const { scope } = await spawnedTerminal()
    // Establish a selection anchor first via Shift+Arrow.
    captured.keyHandler!(keyEvent({ key: 'ArrowRight', shiftKey: true }))
    const e = keyEvent({ key: 'Backspace' })
    const handled = captured.keyHandler!(e)
    expect(handled).toBe(false)
    expect(e.preventDefault).toHaveBeenCalled()
    scope.stop()
  })

  it('Ctrl+1..9 are reserved by the app and never leak into the PTY', async () => {
    const { mock, scope } = await spawnedTerminal()
    // Normal path and IME path (e.key is a non-digit) both matched via e.code.
    for (const overrides of [
      { key: '1', code: 'Digit1', ctrlKey: true },
      { key: 'Process', code: 'Digit2', ctrlKey: true },
      { key: 'Unidentified', code: 'Numpad9', ctrlKey: true },
    ]) {
      const e = keyEvent(overrides)
      const handled = captured.keyHandler!(e)
      expect(handled).toBe(false)
      expect(e.preventDefault).toHaveBeenCalled()
    }
    expect(inputsSent(mock)).toEqual([]) // no bytes sent to the terminal
    scope.stop()
  })

  it('plain keys pass through to xterm without preventDefault', async () => {
    const { mock, scope } = await spawnedTerminal()
    for (const overrides of [{ key: 'a' }, { key: 'ArrowLeft' }, { key: 'Backspace' }]) {
      const e = keyEvent(overrides)
      const handled = captured.keyHandler!(e)
      expect(handled).toBe(true)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(inputsSent(mock)).toEqual([])
    scope.stop()
  })
})
