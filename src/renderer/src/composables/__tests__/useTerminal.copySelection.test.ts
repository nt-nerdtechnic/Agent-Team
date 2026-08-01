// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Regression (issue #12): Cmd+C copied nothing in a terminal pane. xterm's own
// copy handler runs off the DOM `copy` event, which needs a DOM selection —
// but `.xterm` is `user-select: none`, so a terminal selection never becomes
// one. The pane must write xterm's own selection to the clipboard itself.

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
  selection: '',
  clearSelectionCalls: 0,
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
    getSelection(): string {
      return captured.selection
    }
    write(): void {}
    writeln(): void {}
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {
      captured.clearSelectionCalls++
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

const writeText = vi.fn().mockResolvedValue(undefined)

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

describe('useTerminal — Cmd+C copies the terminal selection', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    captured.keyHandler = undefined
    captured.selection = ''
    captured.clearSelectionCalls = 0
    localStorage.clear() // drop the persisted PTY id so the next spawn is fresh
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { mock, result, scope }
  }

  function inputsSent(mock: ReturnType<typeof createMockBackend>) {
    return mock.sent
      .filter((s) => s.type === 'terminal.input')
      .map((s) => (s.payload as { data: string }).data)
  }

  it('writes the selection to the clipboard and swallows the key', async () => {
    const { mock, scope } = await spawnedTerminal()
    captured.selection = 'npm run build'

    const e = keyEvent({ key: 'c', metaKey: true })
    const handled = captured.keyHandler!(e)

    expect(handled).toBe(false)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('npm run build')
    expect(inputsSent(mock)).toEqual([]) // nothing leaks into the PTY
    scope.stop()
  })

  it('keeps the selection on screen after copying', async () => {
    const { scope } = await spawnedTerminal()
    captured.selection = 'npm run build'
    captured.clearSelectionCalls = 0

    captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))

    expect(captured.clearSelectionCalls).toBe(0)
    scope.stop()
  })

  it('leaves Cmd+C alone when nothing is selected', async () => {
    const { scope } = await spawnedTerminal()
    captured.selection = ''

    const e = keyEvent({ key: 'c', metaKey: true })
    const handled = captured.keyHandler!(e)

    expect(handled).toBe(true)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    scope.stop()
  })

  it('never intercepts Ctrl+C — it must keep reaching the PTY as SIGINT', async () => {
    const { scope } = await spawnedTerminal()
    captured.selection = 'still selected'

    const e = keyEvent({ key: 'c', ctrlKey: true })
    const handled = captured.keyHandler!(e)

    expect(handled).toBe(true)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    scope.stop()
  })

  it('leaves modified variants (Cmd+Shift+C, Cmd+Alt+C) to their own handlers', async () => {
    const { scope } = await spawnedTerminal()
    captured.selection = 'still selected'

    for (const overrides of [
      { key: 'c', metaKey: true, shiftKey: true },
      { key: 'c', metaKey: true, altKey: true },
    ]) {
      const e = keyEvent(overrides)
      expect(captured.keyHandler!(e)).toBe(true)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(writeText).not.toHaveBeenCalled()
    scope.stop()
  })

  it('matches an uppercase e.key (Caps Lock on)', async () => {
    const { scope } = await spawnedTerminal()
    captured.selection = 'CAPS'

    const handled = captured.keyHandler!(keyEvent({ key: 'C', metaKey: true }))

    expect(handled).toBe(false)
    expect(writeText).toHaveBeenCalledWith('CAPS')
    scope.stop()
  })

  it('exposes the selection so the pane can hand it to the context menu', async () => {
    const { result, scope } = await spawnedTerminal()
    captured.selection = 'for the menu'

    expect(result.getSelection()).toBe('for the menu')
    scope.stop()
  })
})
