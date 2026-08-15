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
  selectionHandler: undefined as (() => void) | undefined,
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
    hasSelection(): boolean {
      return !!captured.selection
    }
    onSelectionChange(handler: () => void): { dispose(): void } {
      captured.selectionHandler = handler
      return { dispose: (): void => { captured.selectionHandler = undefined } }
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
    captured.selectionHandler = undefined
    vi.useRealTimers()
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
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

  /** A paste carrying only an image, the shape a ⌘⇧4 screenshot arrives in. */
  function pasteImage(mediaType = 'image/png'): boolean {
    const file = new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: mediaType })
    const items = [{ kind: 'file', type: mediaType, getAsFile: () => file }]
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, {
      clipboardData: {
        getData: () => '',
        items: { length: items.length, 0: items[0],
          [Symbol.iterator]: function* () { yield* items } }
      }
    })
    captured.textarea!.dispatchEvent(event)
    return event.defaultPrevented
  }

  function pastedData(mock: ReturnType<typeof createMockBackend>): string {
    return mock.sent
      .filter((s) => s.type === 'terminal.input')
      .map((s) => (s.payload as { data: string }).data)
      .join('')
  }

  /** Lets the chunk sends (and the failure report hanging off them) settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  /** The clipboard diagnostics useTerminal forwards into backend.log. */
  function clipboardDiags(
    mock: ReturnType<typeof createMockBackend>
  ): { message: string, level?: string }[] {
    return mock.sent
      .filter((s) => s.type === 'client.diagnostic')
      .map((s) => s.payload as { category: string, message: string, level?: string })
      .filter((p) => p.category === 'clipboard')
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

  // Every way a paste can come to nothing used to return silently, so they were
  // indistinguishable in a "the paste vanished" report. Each now says which one
  // it was, and the ones that had text say how much of it was lost.
  describe('a paste that reaches the pty with nothing says why', () => {
    it('reports the drop while the pane is still preparing', async () => {
      const { mock, scope, terminal } = await spawnedTerminal('claude')
      terminal.setDisableStdin(true)
      paste('must not reach the pty')
      expect(pastedData(mock)).toBe('') // the guard still drops it, log or no log
      const lines = clipboardDiags(mock)
      expect(lines).toHaveLength(1)
      expect(lines[0].message).toContain('still preparing')
      expect(lines[0].message).toContain('22 chars')
      expect(lines[0].level).toBe('warning')
      scope.stop()
    })

    // The third guard: a pane that never spawned, or whose CLI has since exited.
    it('reports a paste into a pane with no live session', async () => {
      const mock = createMockBackend()
      const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
      result.mount(document.createElement('div'))
      result.pasteFromClipboard('text with nowhere to go')
      expect(pastedData(mock)).toBe('')
      const lines = clipboardDiags(mock)
      expect(lines).toHaveLength(1)
      expect(lines[0].message).toContain('paste dropped')
      expect(lines[0].message).toContain('23 chars')
      expect(lines[0].level).toBe('warning')
      scope.stop()
    })

    // ⌘V on an empty clipboard returns from the image branch, well before the
    // paste path proper, so the guard that reports it has to live there too.
    it('reports a ⌘V that found neither text nor an image', async () => {
      const { mock, scope } = await spawnedTerminal('claude')
      expect(paste('')).toBe(false) // nothing to paste, so the event is not consumed
      expect(pastedData(mock)).toBe('')
      const lines = clipboardDiags(mock)
      expect(lines).toHaveLength(1)
      expect(lines[0].message).toContain('neither text nor an image')
      expect(lines[0].level).toBe('warning')
      scope.stop()
    })

    // The programmatic entry point (a drag-and-drop that resolved no paths).
    it('reports an empty programmatic paste', async () => {
      const { mock, scope, terminal } = await spawnedTerminal('claude')
      terminal.pasteFromClipboard('')
      const lines = clipboardDiags(mock)
      expect(lines).toHaveLength(1)
      expect(lines[0].message).toContain('no text to send')
      scope.stop()
    })

    it('stays quiet when the paste actually lands', async () => {
      const { mock, scope } = await spawnedTerminal('claude')
      paste('real text')
      expect(pastedData(mock)).toBe('real text')
      expect(clipboardDiags(mock)).toEqual([])
      scope.stop()
    })
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

  // The diagnostic log answers a bug report after the fact; it does nothing for
  // the person watching the pane. Every failure is also handed to the pane so
  // it can say so — reported, not shown here, because this composable owns
  // neither i18n nor the toast host.
  describe('reports clipboard failures to the pane', () => {
    async function withFailureReports(): Promise<{
      failures: Array<{ reason: string, chars: number }>
      result: ReturnType<typeof useTerminal>
      scope: { stop: () => void }
      mock: ReturnType<typeof createMockBackend>
    }> {
      const failures: Array<{ reason: string, chars: number }> = []
      const mock = createMockBackend()
      mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
      const { result, scope } = withScope(() =>
        useTerminal('pane-1', mock.backend, {
          onClipboardFailure: (reason, chars) => { failures.push({ reason, chars }) }
        })
      )
      result.mount(document.createElement('div'))
      await result.spawn({ command: 'bash', cwd: '/tmp', agentKey: 'claude' })
      return { failures, result, scope, mock }
    }

    it('reports a gated paste, with how much was discarded', async () => {
      const { failures, result, scope } = await withFailureReports()
      result.setDisableStdin(true)
      paste('must not reach the pty')
      expect(failures).toEqual([{ reason: 'preparing', chars: 22 }])
      scope.stop()
    })

    it('reports a ⌘V that found nothing on the clipboard', async () => {
      const { failures, scope } = await withFailureReports()
      paste('')
      expect(failures).toEqual([{ reason: 'empty', chars: 0 }])
      scope.stop()
    })

    it('reports a paste into a pane with no live session', async () => {
      const failures: Array<{ reason: string, chars: number }> = []
      const mock = createMockBackend()
      const { result, scope } = withScope(() =>
        useTerminal('pane-1', mock.backend, {
          onClipboardFailure: (reason, chars) => { failures.push({ reason, chars }) }
        })
      )
      result.mount(document.createElement('div'))
      result.pasteFromClipboard('text with nowhere to go')
      expect(failures).toEqual([{ reason: 'no-session', chars: 23 }])
      scope.stop()
    })

    it('says nothing when the paste actually lands', async () => {
      const { failures, mock, scope } = await withFailureReports()
      paste('real text')
      await settle()
      expect(pastedData(mock)).toBe('real text')
      expect(failures).toEqual([])
      scope.stop()
    })

    // Chunks were sent and forgotten, so a paste could arrive with a hole in
    // the middle and nothing anywhere would say so. wsClient resolves an
    // `ok: false` reply rather than rejecting it, which is why the send path
    // has to inspect the answer rather than just catch.
    it('reports a paste the backend refused', async () => {
      const { failures, scope, mock } = await withFailureReports()
      mock.setResponse('terminal.input', null, {
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'no such terminal session' }
      })

      paste('some text')
      await settle()

      expect(failures).toEqual([{ reason: 'send-failed', chars: 9 }])
      scope.stop()
    })
  })

  // Edit > Copy used to evaluate that global at ⌘C time, on a 300ms deadline
  // main lost whenever this renderer was busy painting — and its fallback
  // copies nothing at all over a terminal. The pane pushes instead, so the read
  // happens when the selection changes rather than while the user waits.
  describe('pushes the selection to main for Edit > Copy', () => {
    let reported: string[]

    /** Installs the preload bridge and starts recording from a clean slate. */
    function recordPushes(): void {
      reported = []
      ;(window as unknown as { agentTeam: unknown }).agentTeam = {
        reportTerminalSelection: (s: string): void => { reported.push(s) }
      }
    }
    function focusTerminal(focused: boolean): void {
      captured.textarea!.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
    }

    it('publishes what is already highlighted when the pane takes focus', async () => {
      const { scope } = await spawnedTerminal('claude')
      recordPushes()
      captured.selection = 'already highlighted'
      focusTerminal(true)
      expect(reported).toEqual(['already highlighted'])
      scope.stop()
    })

    it('clears the entry when the pane loses focus', async () => {
      const { scope } = await spawnedTerminal('claude')
      captured.selection = 'highlighted'
      focusTerminal(true)
      recordPushes()
      focusTerminal(false)
      expect(reported).toEqual([''])
      scope.stop()
    })

    // Immediate, unlike a growing selection: a stale entry would let Copy
    // return text the user just deselected.
    it('reports a cleared selection at once, without coalescing', async () => {
      const { scope } = await spawnedTerminal('claude')
      captured.selection = 'highlighted'
      focusTerminal(true)
      recordPushes()
      captured.selection = ''
      captured.selectionHandler!()
      expect(reported).toEqual([''])
      scope.stop()
    })

    // getSelection() joins every selected row, so reading it on each change
    // would make a drag across a long scrollback pay for the whole range on
    // every mouse move — the renderer stall this change exists to avoid.
    it('coalesces a growing selection into a single read', async () => {
      const { scope } = await spawnedTerminal('claude')
      captured.selection = 'a'
      focusTerminal(true)
      recordPushes()
      vi.useFakeTimers()

      captured.selection = 'ab'
      captured.selectionHandler!()
      captured.selection = 'abc'
      captured.selectionHandler!()
      expect(reported).toEqual([]) // still coalescing — nothing read yet

      await vi.advanceTimersByTimeAsync(60)
      expect(reported).toEqual(['abc']) // one read, of the settled value

      vi.useRealTimers()
      scope.stop()
    })

    // Panes in a window share one WebContents, so a background pane reporting
    // would answer a Copy aimed at the focused one.
    it('stays silent while this pane does not own focus', async () => {
      const { scope } = await spawnedTerminal('claude')
      recordPushes()
      captured.selection = 'background highlight'
      captured.selectionHandler!()
      expect(reported).toEqual([])
      scope.stop()
    })

    it('clears the entry when a focused pane is disposed', async () => {
      const { scope } = await spawnedTerminal('claude')
      captured.selection = 'highlighted'
      focusTerminal(true)
      recordPushes()
      scope.stop()
      expect(reported).toEqual([''])
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

  // A screenshot is pixels on the clipboard with no text and no file. It is
  // written to disk and its path sent as a REAL paste — Claude Code only runs
  // its image detection on bracketed-paste content, so an unbracketed write
  // would leave the user with a literal path and no attachment.
  it('writes a pasted screenshot to disk and sends its path as a bracketed paste', async () => {
    captured.bracketedPasteMode = true
    const saveClipboardImage = vi
      .fn()
      .mockResolvedValue({ ok: true, path: '/store/Pasted-Image-2026-08-07-20.18.33.png' })
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { saveClipboardImage }

    const { mock, scope } = await spawnedTerminal('claude')
    expect(pasteImage()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(saveClipboardImage).toHaveBeenCalledOnce()
    expect(pastedData(mock)).toBe(
      '\x1b[200~/store/Pasted-Image-2026-08-07-20.18.33.png\x1b[201~'
    )
    scope.stop()
  })

  it('leaves a non-image paste with no text alone', async () => {
    const saveClipboardImage = vi.fn()
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { saveClipboardImage }

    const { mock, scope } = await spawnedTerminal('claude')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, { clipboardData: { getData: () => '', items: { length: 0,
      [Symbol.iterator]: function* () {} } } })
    captured.textarea!.dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(saveClipboardImage).not.toHaveBeenCalled()
    expect(pastedData(mock)).toBe('')
    scope.stop()
  })
})
