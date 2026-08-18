// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Shift/Ctrl/Cmd+Enter are one user-facing shortcut with CLI-specific wire
// encodings: Codex understands CSI-u, while Claude Code's xterm.js terminal
// setup uses ESC+CR. xterm won't boot in happy-dom, so the mock captures the
// custom key event handler and the tests drive it directly.

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

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown',
    key: '',
    shiftKey: false,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  } as unknown as KeyboardEvent
}

describe('useTerminal — newline chord key handling', () => {
  afterEach(() => {
    vi.clearAllMocks()
    captured.keyHandler = undefined
    localStorage.clear() // drop the persisted PTY id so the next spawn is fresh
  })

  async function spawnedTerminal(agentKey?: string) {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', agentKey })
    return { mock, scope }
  }

  function inputsSent(mock: ReturnType<typeof createMockBackend>) {
    return mock.sent.filter((s) => s.type === 'terminal.input')
  }

  it('sends CSI-u to Codex and swallows the key', async () => {
    const { mock, scope } = await spawnedTerminal('codex')
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter', shiftKey: true }))
    expect(handled).toBe(false)
    expect(inputsSent(mock)).toEqual([
      { type: 'terminal.input', payload: { terminal_session_id: 'sess-1', data: '\x1b[13;2u' } },
    ])
    scope.stop()
  })

  it('sends bracketed paste LF to claude and swallows the key', async () => {
    const { mock, scope } = await spawnedTerminal('claude')
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter', shiftKey: true }))
    expect(handled).toBe(false)
    expect(inputsSent(mock)).toEqual([
      { type: 'terminal.input', payload: { terminal_session_id: 'sess-1', data: '\x1b[200~\n\x1b[201~' } },
    ])
    scope.stop()
  })

  it('sends Ctrl+V Ctrl+J to undefined (plain shell) and swallows the key', async () => {
    const { mock, scope } = await spawnedTerminal(undefined)
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter', shiftKey: true }))
    expect(handled).toBe(false)
    expect(inputsSent(mock)).toEqual([
      { type: 'terminal.input', payload: { terminal_session_id: 'sess-1', data: '\x16\x0a' } },
    ])
    scope.stop()
  })

  // Ctrl+Enter and Cmd+Enter are indistinguishable from (or never reach) a
  // plain Enter at the PTY, so both are free to carry the same newline UX.
  it('encodes Ctrl+Enter like Shift+Enter', async () => {
    const { mock, scope } = await spawnedTerminal('claude')
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter', ctrlKey: true }))
    expect(handled).toBe(false)
    expect(inputsSent(mock)).toEqual([
      { type: 'terminal.input', payload: { terminal_session_id: 'sess-1', data: '\x1b[200~\n\x1b[201~' } },
    ])
    scope.stop()
  })

  // A plain shell receives Ctrl+Enter as a bare Enter and runs the command, so
  // claiming it there would change what a plain terminal pane does.
  it('leaves Ctrl+Enter alone in a non-agent pane', async () => {
    const { mock, scope } = await spawnedTerminal(undefined)
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter', ctrlKey: true }))
    expect(handled).toBe(true)
    expect(inputsSent(mock)).toEqual([])
    scope.stop()
  })

  it('leaves Ctrl+Enter alone in an explicit terminal pane', async () => {
    const { mock, scope } = await spawnedTerminal('terminal')
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter', ctrlKey: true }))
    expect(handled).toBe(true)
    expect(inputsSent(mock)).toEqual([])
    scope.stop()
  })

  it('encodes Cmd+Enter like Shift+Enter', async () => {
    const { mock, scope } = await spawnedTerminal('codex')
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter', metaKey: true }))
    expect(handled).toBe(false)
    expect(inputsSent(mock)).toEqual([
      { type: 'terminal.input', payload: { terminal_session_id: 'sess-1', data: '\x1b[13;2u' } },
    ])
    scope.stop()
  })

  it('leaves plain Enter to xterm default handling', async () => {
    const { mock, scope } = await spawnedTerminal()
    const handled = captured.keyHandler!(keyEvent({ key: 'Enter' }))
    expect(handled).toBe(true)
    expect(inputsSent(mock)).toEqual([])
    scope.stop()
  })

  it('ignores Enter combined with other modifiers', async () => {
    const { mock, scope } = await spawnedTerminal()
    for (const mod of [{ metaKey: true }, { altKey: true }, { ctrlKey: true }]) {
      const handled = captured.keyHandler!(keyEvent({ key: 'Enter', shiftKey: true, ...mod }))
      expect(handled).toBe(true)
    }
    expect(inputsSent(mock)).toEqual([])
    scope.stop()
  })
})
