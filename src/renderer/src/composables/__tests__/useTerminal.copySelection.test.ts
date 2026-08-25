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
  term: undefined as { modes: { mouseTrackingMode: string } } | undefined,
  selection: '',
  clearSelectionCalls: 0,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    modes = { mouseTrackingMode: 'none' as string }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
      captured.keyHandler = handler
      captured.term = this
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
    hasSelection(): boolean {
      return !!captured.selection
    }
    onSelectionChange(_handler: () => void): { dispose(): void } {
      return { dispose(): void {} }
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

import { useTerminal, type ClipboardFailureReason } from '../useTerminal'
import { settingsSet } from '../../lib/settings'

const writeText = vi.fn().mockResolvedValue(undefined)

// reportEmptyCopy() collapses two reports of the same ⌘C inside 300ms, and that
// window is module state that outlives a single case. Jump the clock forward
// between them so one test's report can never suppress the next test's.
const realDateNow = Date.now.bind(Date)
let clockOffset = 0
vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + clockOffset)

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
    clockOffset += 10_000
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    captured.keyHandler = undefined
    captured.term = undefined
    captured.selection = ''
    captured.clearSelectionCalls = 0
    localStorage.clear() // drop the persisted PTY id so the next spawn is fresh
  })

  async function spawnedTerminal(opts?: Parameters<typeof useTerminal>[2]) {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend, opts))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { mock, result, scope }
  }

  function inputsSent(mock: ReturnType<typeof createMockBackend>) {
    return mock.sent
      .filter((s) => s.type === 'terminal.input')
      .map((s) => (s.payload as { data: string }).data)
  }

  /** The clipboard diagnostics useTerminal forwards into backend.log. */
  function clipboardDiags(
    mock: ReturnType<typeof createMockBackend>
  ): { message: string, level?: string }[] {
    return mock.sent
      .filter((s) => s.type === 'client.diagnostic')
      .map((s) => s.payload as { category: string, message: string, level?: string })
      .filter((p) => p.category === 'clipboard')
  }

  /** Lets the writeText promise (and the diagnostic hanging off it) settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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

  // Two copy paths bind ⌘C — this one and Edit > Copy's CmdOrCtrl+C accelerator
  // in menu.ts, which fires first on macOS. When a copy goes missing, the log
  // line is what says which of them actually ran.
  it('names the renderer path on a successful copy', async () => {
    const { mock, scope } = await spawnedTerminal()
    captured.selection = 'npm run build'

    captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
    await settle()

    const lines = clipboardDiags(mock)
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toContain('renderer path')
    expect(lines[0].message).toContain('13 chars')
    scope.stop()
  })

  // Holding ⌘C auto-repeats keydown at the OS rate. The copy itself repeats as
  // it always did; the diagnostic must not become one WS message per repeat.
  it('logs a held ⌘C once, without changing what it copies', async () => {
    const { mock, scope } = await spawnedTerminal()
    captured.selection = 'npm run build'

    captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
    captured.keyHandler!(keyEvent({ key: 'c', metaKey: true, repeat: true }))
    captured.keyHandler!(keyEvent({ key: 'c', metaKey: true, repeat: true }))
    await settle()

    expect(writeText).toHaveBeenCalledTimes(3)
    expect(clipboardDiags(mock)).toHaveLength(1)
    scope.stop()
  })

  // Chromium rejects writeText when the document is not focused, and the key is
  // already swallowed by then — so this used to be a copy the user believed had
  // happened, with nothing anywhere to say otherwise.
  it('reports a clipboard write the browser rejected', async () => {
    const { mock, scope } = await spawnedTerminal()
    captured.selection = 'npm run build'
    writeText.mockRejectedValueOnce(new Error('Document is not focused'))

    captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
    await settle()

    const lines = clipboardDiags(mock)
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe('warning')
    expect(lines[0].message).toContain('rejected')
    expect(lines[0].message).toContain('Document is not focused')
    scope.stop()
  })

  // Issue #20: a ⌘C that copies nothing used to be completely silent — the user
  // only found out on the next ⌘V, which pasted whatever was on the clipboard
  // before. It has to report itself, and where a plain drag cannot select at
  // all it has to say what to do instead.
  describe('an empty ⌘C reports itself (issue #20)', () => {
    function failureRecorder(): { reasons: ClipboardFailureReason[] } & Parameters<typeof useTerminal>[2] {
      const reasons: ClipboardFailureReason[] = []
      return { reasons, onClipboardFailure: (reason) => { reasons.push(reason) } }
    }

    // The hint is gated behind a write-once setting, so after the first six
    // seconds of the pane's life it could never be seen again — which is the
    // regression this case pins: an empty ⌘C must re-show it regardless.
    it('names the mouse capture and re-shows the ⌥ hint even once it has been seen', async () => {
      settingsSet('agentTeam.terminal.optionSelectHintSeen', true)
      const opts = failureRecorder()
      const { mock, result, scope } = await spawnedTerminal(opts)
      captured.term!.modes.mouseTrackingMode = 'any'
      captured.selection = ''

      captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
      await settle()

      expect(opts.reasons).toEqual(['copy-mouse-captured'])
      expect(result.optionSelectHint.value).toBe(true)
      expect(clipboardDiags(mock)[0].message).toContain('captures the mouse')
      scope.stop()
    })

    // Without mouse capture a plain drag selects fine, so the hint would be
    // noise — the pane only has to say that nothing was selected.
    it('names the empty selection and leaves the hint down when the mouse is free', async () => {
      const opts = failureRecorder()
      const { mock, result, scope } = await spawnedTerminal(opts)
      captured.term!.modes.mouseTrackingMode = 'none'
      captured.selection = ''

      captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
      await settle()

      expect(opts.reasons).toEqual(['copy-no-selection'])
      expect(result.optionSelectHint.value).toBe(false)
      expect(clipboardDiags(mock)[0].message).toContain('no selection')
      scope.stop()
    })

    // Regression guard: the copy that works must stay exactly as it was.
    it('stays silent — and still copies — when there IS a selection', async () => {
      const opts = failureRecorder()
      const { result, scope } = await spawnedTerminal(opts)
      captured.selection = 'npm run build'

      captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
      await settle()

      expect(writeText).toHaveBeenCalledWith('npm run build')
      expect(opts.reasons).toEqual([])
      expect(result.optionSelectHint.value).toBe(false)
      scope.stop()
    })

    // One ⌘C can reach both the menu accelerator and this handler; the user
    // must be told once, not twice.
    it('collapses two empty presses inside the dedupe window into one report', async () => {
      const opts = failureRecorder()
      const { mock, scope } = await spawnedTerminal(opts)
      captured.selection = ''

      captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
      captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
      await settle()

      expect(opts.reasons).toEqual(['copy-no-selection'])
      expect(clipboardDiags(mock)).toHaveLength(1)
      scope.stop()
    })

    // A renderer too busy to answer main's 300ms selection read sends main down
    // its "nothing selected" branch even though this page copied the text fine.
    // Reporting then would call a copy the user watched succeed a failure. The
    // second press here stands in for that late notification, which reaches the
    // same reportEmptyCopy() the key handler does.
    it('stays silent when a copy just succeeded on this page', async () => {
      const opts = failureRecorder()
      const { scope } = await spawnedTerminal(opts)
      captured.selection = 'npm run build'
      captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
      await settle()

      captured.selection = ''
      captured.keyHandler!(keyEvent({ key: 'c', metaKey: true }))
      await settle()

      expect(writeText).toHaveBeenCalledWith('npm run build')
      expect(opts.reasons).toEqual([])
      scope.stop()
    })
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
