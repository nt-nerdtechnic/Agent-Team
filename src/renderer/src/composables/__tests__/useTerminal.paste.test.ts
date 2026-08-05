// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Manual paste (⌘V / right-click Paste) is intercepted before xterm's own
// textarea handler so that multi-line clipboard text survives: xterm brackets
// by ITS view of DEC mode 2004, which a reattached pane resets while the CLI is
// still in bracketed-paste mode — an unbracketed paste then reaches the CLI as
// one Enter per line. xterm won't boot in happy-dom, so the mock stands in and
// the tests dispatch paste events at the textarea it creates.

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
  textarea: undefined as HTMLTextAreaElement | undefined,
  bracketedPasteMode: false,
  scrolledToBottom: 0,
  clearedSelection: 0,
  dataHandler: undefined as ((data: string) => void) | undefined,
  selection: '',
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea: HTMLTextAreaElement | undefined
    scrolledToBottom = 0
    clearedSelection = 0
    getSelection(): string {
      return captured.selection
    }
    get modes(): { mouseTrackingMode: string; bracketedPasteMode: boolean } {
      return { mouseTrackingMode: 'none', bracketedPasteMode: captured.bracketedPasteMode }
    }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(el: HTMLElement): void {
      // Mirrors xterm: the helper textarea lives inside the mounted container,
      // so a paste on it bubbles through the capture listener useTerminal adds.
      this.textarea = document.createElement('textarea')
      el.appendChild(this.textarea)
      captured.textarea = this.textarea
    }
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onData(cb: (data: string) => void): { dispose(): void } {
      captured.dataHandler = cb
      return { dispose(): void {} }
    }
    write(): void {}
    writeln(): void {}
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {
      captured.clearedSelection++
    }
    scrollLines(): void {}
    scrollToBottom(): void {
      captured.scrolledToBottom++
    }
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

describe('useTerminal — manual paste', () => {
  afterEach(() => {
    vi.clearAllMocks()
    captured.textarea = undefined
    captured.bracketedPasteMode = false
    captured.scrolledToBottom = 0
    captured.clearedSelection = 0
    captured.dataHandler = undefined
    captured.selection = ''
    localStorage.clear() // drop the persisted PTY id so the next spawn is fresh
  })

  async function spawnedTerminal(agentKey?: string, opts?: { onClear?: () => void }) {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend, opts))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', agentKey })
    return { mock, scope, terminal: result }
  }

  function paste(text: string): boolean {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, { clipboardData: { getData: () => text } })
    captured.textarea!.dispatchEvent(event)
    return event.defaultPrevented
  }

  function pastedData(mock: ReturnType<typeof createMockBackend>): string {
    return mock.sent
      .filter((s) => s.type === 'terminal.input')
      .map((s) => (s.payload as { data: string }).data)
      .join('')
  }

  it('brackets a multi-line paste for an agent even while xterm thinks mode 2004 is off', async () => {
    const { mock, scope } = await spawnedTerminal('antigravity')
    expect(paste('first\nsecond')).toBe(true)
    expect(pastedData(mock)).toBe('\x1b[200~first\rsecond\x1b[201~')
    scope.stop()
  })

  it('brackets when xterm reports mode 2004 on, whatever the agent is', async () => {
    captured.bracketedPasteMode = true
    const { mock, scope } = await spawnedTerminal(undefined)
    paste('first\r\nsecond')
    expect(pastedData(mock)).toBe('\x1b[200~first\rsecond\x1b[201~')
    scope.stop()
  })

  it('leaves a plain shell paste unbracketed', async () => {
    const { mock, scope } = await spawnedTerminal(undefined)
    paste('echo hi\n')
    expect(pastedData(mock)).toBe('echo hi\r')
    scope.stop()
  })

  // Single-line text cannot be split by stray Enters, so it stays on xterm's
  // own judgement — a sub-shell that never enabled mode 2004 would otherwise
  // receive a literal "[200~".
  it('leaves a single-line agent paste unbracketed while mode 2004 is off', async () => {
    const { mock, scope } = await spawnedTerminal('claude')
    paste('just one line')
    expect(pastedData(mock)).toBe('just one line')
    scope.stop()
  })

  it('scrolls to the bottom and drops the selection, as xterm would', async () => {
    const { scope } = await spawnedTerminal('claude')
    paste('anything')
    expect(captured.scrolledToBottom).toBe(1)
    expect(captured.clearedSelection).toBe(1)
    scope.stop()
  })

  it('honors disableStdin, which the pane sets while it is preparing', async () => {
    const { mock, scope, terminal } = await spawnedTerminal('claude')
    terminal.setDisableStdin(true)
    paste('must not reach the pty')
    expect(pastedData(mock)).toBe('')
    scope.stop()
  })

  // The paste bypasses term.onData, so the /clear detection that lives there
  // has to be fed explicitly or "paste /clear + Enter" silently stops working.
  it('feeds the input buffer so a pasted /clear still triggers onClear', async () => {
    let cleared = 0
    const { scope } = await spawnedTerminal('claude', { onClear: () => { cleared++ } })
    paste('/clear')
    captured.dataHandler!('\r')
    expect(cleared).toBe(1)
    scope.stop()
  })

  // A paste that already ends in a newline has been submitted by the CLI; the
  // text must not linger and fire onClear again on the user's next Enter.
  it('does not re-trigger onClear when the pasted /clear carried its own newline', async () => {
    let cleared = 0
    const { scope } = await spawnedTerminal('claude', { onClear: () => { cleared++ } })
    paste('/clear\n')
    captured.dataHandler!('\r')
    expect(cleared).toBe(0)
    scope.stop()
  })

  // The renderer half of Edit > Copy: main evaluates this global in the focused
  // page (TERMINAL_SELECTION_EXPRESSION in menu.ts). It must answer only while
  // a terminal actually holds focus, so an editor Copy still reaches Chromium.
  describe('Edit > Copy selection global', () => {
    function focusTerminal(focused: boolean): void {
      captured.textarea!.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
    }

    it('reports the focused terminal selection', async () => {
      const { scope } = await spawnedTerminal('claude')
      captured.selection = 'highlighted text'
      focusTerminal(true)
      expect(window.__navideTerminalSelection?.()).toBe('highlighted text')
      scope.stop()
    })

    it('reports nothing once the terminal loses focus, so main falls back', async () => {
      const { scope } = await spawnedTerminal('claude')
      captured.selection = 'highlighted text'
      focusTerminal(true)
      focusTerminal(false)
      expect(window.__navideTerminalSelection?.()).toBe('')
      scope.stop()
    })

    it('reports nothing after the pane is disposed', async () => {
      const { scope } = await spawnedTerminal('claude')
      captured.selection = 'highlighted text'
      focusTerminal(true)
      scope.stop()
      expect(window.__navideTerminalSelection?.()).toBe('')
    })
  })

  it('splits a large paste into 512-char writes', async () => {
    const { mock, scope } = await spawnedTerminal('claude')
    const text = ('x'.repeat(99) + '\n').repeat(15) // 1500 chars over 15 lines
    paste(text)
    const writes = mock.sent
      .filter((s) => s.type === 'terminal.input')
      .map((s) => (s.payload as { data: string }).data)
    expect(writes.length).toBe(3) // 1500 + 12 bytes of bracketing → 3 chunks
    expect(writes.every((w) => w.length <= 512)).toBe(true)
    expect(writes.join('')).toBe(`\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`)
    scope.stop()
  })
})
