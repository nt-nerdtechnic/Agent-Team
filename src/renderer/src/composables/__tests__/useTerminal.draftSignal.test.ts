// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { createMockBackend, withScope } from './mockBackend'

// A pane publishes two signals about the person at the keyboard: whether the
// composer holds an unsent line (hasDraft) and when a real keystroke last
// arrived (lastUserKeyAt). App.vue's messaging idle gate holds delivery on
// them, because an injection is a paste plus Enter — it would submit whatever
// half-written line the composer happens to be holding.

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

describe('useTerminal — draft and keystroke signals', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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

  it('starts with no draft and no keystroke on record', async () => {
    const { scope, terminal } = await spawnedTerminal()
    expect(terminal.hasDraft.value).toBe(false)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    scope.stop()
  })

  it('reports a draft while the typed line is unsent', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('review this')
    expect(terminal.hasDraft.value).toBe(true)
    scope.stop()
  })

  it('clears the draft on Enter', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('review this')
    captured.dataHandler!('\r')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('clears the draft when backspace empties the line', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('ab')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!('\x7f')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!('\x7f')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it.each([
    ['Ctrl+C', '\x03'],
    ['Ctrl+U', '\x15'],
    ['Escape', '\x1b'],
  ])('clears the draft when %s empties the composer', async (_name, key) => {
    // The CLI drops the line on these; without a branch for them the buffer
    // would keep it and the pane would stay "being typed at" until the next
    // Enter — the everyday way this gate latches.
    const { scope, terminal } = await spawnedTerminal()
    type('half a thought')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!(key)
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('drops one word on Ctrl+W rather than calling the line finished', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('review the diff')
    captured.dataHandler!('\x17')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!('\x17')
    captured.dataHandler!('\x17')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('leaves no residue for either mouse encoding', async () => {
    // X10 puts the button and coordinates in three PRINTABLE bytes after
    // `ESC[M`, so stripping escape sequences alone is not enough for it.
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!('\x1b[M !!')
    captured.dataHandler!('\x1b[<0;10;5M')
    expect(terminal.hasDraft.value).toBe(false)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    scope.stop()
  })

  it('treats a whitespace-only line as no draft', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('   ')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('does not let a cursor key latch a draft that never clears', async () => {
    // The control-character sweep alone leaves "[A" in the buffer, which would
    // read as an unsent line for as long as the pane lives.
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!('\x1b[A')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('does not let a mouse report latch a draft, or count as typing', async () => {
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!('\x1b[<0;10;5M')
    expect(terminal.hasDraft.value).toBe(false)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    scope.stop()
  })

  it.each([
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
  ])('does not count a %s report as typing', async (_name, report) => {
    // A CLI with focus tracking on sends these when the pane is clicked into or
    // away from. Clicking somewhere is not typing, and treating it as a
    // keystroke parks delivery for the whole hold window on a glance.
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!(report)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('records a keystroke time for real typing, including Enter', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('a')
    const typed = terminal.lastUserKeyAt.value
    expect(typed).toBeGreaterThan(0)
    captured.dataHandler!('\r')
    expect(terminal.lastUserKeyAt.value).toBeGreaterThanOrEqual(typed)
    scope.stop()
  })

  it('counts a keystroke held back by the spawn-phase gate', async () => {
    // Held input is still the user typing — refusing to send it does not make
    // the person at the keyboard go away.
    const { scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    type('a')
    expect(terminal.lastUserKeyAt.value).toBeGreaterThan(0)
    scope.stop()
  })

  it('counts a clipboard paste as an unsent draft', async () => {
    const { scope, terminal } = await spawnedTerminal()
    terminal.pasteFromClipboard('pasted but not sent')
    expect(terminal.hasDraft.value).toBe(true)
    expect(terminal.lastUserKeyAt.value).toBeGreaterThan(0)
    scope.stop()
  })

  it('leaves no draft when the paste ends in a newline', async () => {
    const { scope, terminal } = await spawnedTerminal()
    terminal.pasteFromClipboard('run it\n')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  // ── Keys the CLI consumes without an Enter ────────────────────────────────
  // A permission prompt or an AskUserQuestion box is answered with a bare
  // `1`/`2`/`y`. No key that empties the buffer ever follows, so without the
  // two rules below the pane reports a draft for the rest of its life: every
  // message to it stops at "someone is typing", and syncPaneBusy keeps telling
  // the backend it is busy.

  /** Feed one chunk of PTY output and wait out the background coalescing timer,
   *  which is what turns it into recorded activity. */
  async function output(mock: ReturnType<typeof createMockBackend>, data: string): Promise<void> {
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data })
    await new Promise((r) => setTimeout(r, 150))
  }

  async function parkedThenAnswered() {
    const { mock, scope, terminal } = await spawnedTerminal()
    // A byte first: a pane that has emitted nothing is still booting, and
    // displayStatus reports 'starting' whatever else is set.
    await output(mock, 'Do you want to proceed?')
    terminal.markNeedsInput()
    await nextTick()
    expect(terminal.displayStatus.value).toBe('awaiting')
    return { scope, terminal }
  }

  it('reports the draft while the pane is still parked on the prompt', async () => {
    const { scope, terminal } = await parkedThenAnswered()
    type('1')
    expect(terminal.hasDraft.value).toBe(true)
    scope.stop()
  })

  it.each([['1'], ['2'], ['y'], ['n']])(
    'clears a %s answer once the pane leaves the prompt',
    async (answer) => {
      const { scope, terminal } = await parkedThenAnswered()
      type(answer)

      // The CLI took the answer and started working.
      terminal.markTurnComplete()
      await nextTick()

      expect(terminal.displayStatus.value).not.toBe('awaiting')
      expect(terminal.hasDraft.value).toBe(false)
      scope.stop()
    },
  )

  it('keeps a real half-written line when the prompt ends on its own', async () => {
    // `idle_prompt` and the other resolved Notification types end AWAITING with
    // no answer from anyone (see cliAwaitingInput's RESOLVED_NOTIFICATION_TYPES),
    // so leaving the prompt is not proof the line was consumed. Clearing it
    // unconditionally would let the next injection submit what was left of it.
    const { scope, terminal } = await parkedThenAnswered()
    type('請幫我看一下')

    terminal.clearNeedsInput()
    await nextTick()

    expect(terminal.displayStatus.value).not.toBe('awaiting')
    expect(terminal.hasDraft.value).toBe(true)
    scope.stop()
  })

  it('clears a question answered the same way', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    await output(mock, 'Which one?')
    terminal.markQuestion()
    await nextTick()
    expect(terminal.displayStatus.value).toBe('question')
    type('2')
    expect(terminal.hasDraft.value).toBe(true)

    terminal.clearQuestion()
    await nextTick()

    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('keeps a line typed at a pane that was never parked', async () => {
    // The narrowness is the point: a turn ending while someone writes their
    // next prompt must not drop what they have written.
    const { scope, terminal } = await spawnedTerminal()
    type('review the diff')

    terminal.markTurnComplete()
    await nextTick()

    expect(terminal.hasDraft.value).toBe(true)
    scope.stop()
  })

  it('stops calling a minute-old line a draft', async () => {
    // Backstop for every latch the transition above does not see. The buffer
    // itself is kept — `/clear` still has to be recognisable.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { scope, terminal } = await spawnedTerminal()
      type('half a thought')
      expect(terminal.hasDraft.value).toBe(true)

      await vi.advanceTimersByTimeAsync(61_000)

      expect(terminal.hasDraft.value).toBe(false)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('brings the draft back when the same line is typed at again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { scope, terminal } = await spawnedTerminal()
      type('half a thought')
      await vi.advanceTimersByTimeAsync(61_000)
      expect(terminal.hasDraft.value).toBe(false)

      type('!')

      expect(terminal.hasDraft.value).toBe(true)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
