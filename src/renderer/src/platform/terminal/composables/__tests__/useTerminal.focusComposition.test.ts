// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
  })
})

// Two failure modes that both surface as "typed, nothing appeared for seconds":
//   1. A window-level blur (cmd+tab) fires a textarea blur even though focus
//      never moved inside the document. Treating it as lost focus drops echo
//      into the coalesced path and strands it there when the window returns.
//   2. xterm's CompositionHelper latches on compositionstart and unlatches only
//      on compositionend, which macOS skips when the input method is switched
//      mid-composition. While latched it swallows keyCode 229 outright.

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
  writes: [] as string[],
  textarea: undefined as HTMLTextAreaElement | undefined,
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
  focusCalls: 0,
  compositionEnds: 0,
  helperComposing: false,
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
    // Mirrors the real internals the stale-composition rescue reaches through:
    // only the helper's public surface is touched.
    _core = {
      _compositionHelper: {
        get isComposing(): boolean { return captured.helperComposing },
        compositionend(): void { captured.compositionEnds++; captured.helperComposing = false },
      },
    }
    constructor() {
      captured.textarea = this.textarea
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean): void { captured.keyHandler = h }
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
    write(data: string): void { captured.writes.push(data) }
    writeln(): void {}
    resize(): void {}
    focus(): void { captured.focusCalls++ }
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
import { getContext } from '@navide/plugin-ui/shared'

describe('useTerminal — focus transitions and stale IME composition', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    captured.writes = []
    captured.textarea = undefined
    captured.keyHandler = undefined
    captured.focusCalls = 0
    captured.compositionEnds = 0
    captured.helperComposing = false
    localStorage.clear()
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend, {}))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    captured.writes = []
    captured.focusCalls = 0
    return { mock, scope }
  }

  function emitOutput(mock: ReturnType<typeof createMockBackend>, data: string) {
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data })
  }

  /** Diagnostics the renderer forwarded to backend.log, newest last. */
  function diagnostics(mock: ReturnType<typeof createMockBackend>, category?: string): string[] {
    return mock.sent
      .filter((s) => s.type === 'client.diagnostic')
      .filter((s) => !category || (s.payload as { category: string }).category === category)
      .map((s) => (s.payload as { message: string }).message)
  }

  function keydown(over: Partial<KeyboardEvent> & { keyCode: number, isComposing: boolean }) {
    return captured.keyHandler!({
      type: 'keydown',
      key: '',
      shiftKey: false, metaKey: false, altKey: false, ctrlKey: false,
      preventDefault() {}, stopPropagation() {},
      ...over,
    } as unknown as KeyboardEvent)
  }

  describe('window-level blur', () => {
    it('keeps echo on the immediate path when the whole window loses focus', async () => {
      const { mock, scope } = await spawnedTerminal()
      captured.textarea!.dispatchEvent(new Event('focus'))
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)

      captured.textarea!.dispatchEvent(new Event('blur'))
      emitOutput(mock, 'x')

      expect(captured.writes).toEqual(['x']) // not deferred to the 100ms window
      scope.stop()
    })

    it('still coalesces when focus moves to another element in the document', async () => {
      const { mock, scope } = await spawnedTerminal()
      captured.textarea!.dispatchEvent(new Event('focus'))
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)

      captured.textarea!.dispatchEvent(new Event('blur'))
      emitOutput(mock, 'x')

      expect(captured.writes).toEqual([])
      await new Promise((r) => setTimeout(r, 120))
      expect(captured.writes).toEqual(['x'])
      scope.stop()
    })

    it('takes focus back when the window returns and nothing else claimed it', async () => {
      const { scope } = await spawnedTerminal()
      captured.textarea!.dispatchEvent(new Event('focus'))
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      captured.textarea!.dispatchEvent(new Event('blur'))

      captured.focusCalls = 0
      window.dispatchEvent(new Event('focus'))

      expect(captured.focusCalls).toBe(1)
      scope.stop()
    })

    it('does not fight for focus when the pane never held it', async () => {
      const { scope } = await spawnedTerminal()

      window.dispatchEvent(new Event('focus'))

      expect(captured.focusCalls).toBe(0)
      scope.stop()
    })

    // `terminalFocus` is a renderer-wide singleton: leaving it stuck on disables
    // every `!terminalFocus` binding (Escape, cmd+f, cmd+s) for the whole window.
    it('clears the focus context when disposed while the window is away', async () => {
      const { scope } = await spawnedTerminal()
      captured.textarea!.dispatchEvent(new Event('focus'))
      expect(getContext().terminalFocus).toBe(true)

      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      captured.textarea!.dispatchEvent(new Event('blur')) // window-level: latched
      scope.stop() // pane torn down before the window ever came back

      expect(getContext().terminalFocus).toBe(false)
    })

    // The mock's focus() deliberately does not move activeElement, standing in
    // for a pane that stopped being rendered while the window was away — where
    // HTMLElement.focus() is a no-op.
    it('clears the focus context when it cannot take focus back', async () => {
      const { scope } = await spawnedTerminal()
      captured.textarea!.dispatchEvent(new Event('focus'))
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      captured.textarea!.dispatchEvent(new Event('blur'))

      window.dispatchEvent(new Event('focus'))

      expect(captured.focusCalls).toBe(1) // it tried
      expect(getContext().terminalFocus).toBe(false) // but did not assert focus it lacks
      scope.stop()
    })
  })

  describe('stale composition rescue', () => {
    it('unlatches xterm when an IME key arrives with no live browser composition', async () => {
      const { scope } = await spawnedTerminal()
      captured.helperComposing = true // compositionend never arrived

      keydown({ keyCode: 229, isComposing: false })

      expect(captured.compositionEnds).toBe(1)
      scope.stop()
    })

    it('leaves a genuine first IME keystroke alone', async () => {
      const { scope } = await spawnedTerminal()
      captured.helperComposing = false // compositionstart has not fired yet

      keydown({ keyCode: 229, isComposing: false })

      expect(captured.compositionEnds).toBe(0)
      scope.stop()
    })

    it('leaves a composition that is live on both sides alone', async () => {
      const { scope } = await spawnedTerminal()
      captured.helperComposing = true

      keydown({ keyCode: 229, isComposing: true })

      expect(captured.compositionEnds).toBe(0)
      scope.stop()
    })

    it('ignores non-IME keys even while latched', async () => {
      const { scope } = await spawnedTerminal()
      captured.helperComposing = true

      keydown({ keyCode: 65, key: 'a', isComposing: false })

      // xterm's own keydown() already finalizes on a non-swallowed key.
      expect(captured.compositionEnds).toBe(0)
      scope.stop()
    })
  })

  // The latch was derived from xterm's source and never observed happening on a
  // real machine, so it reports itself. An input-method switch that still feels
  // slow with no 'stale composition' line in the log rules this cause out
  // instead of leaving it as a standing suspicion.
  describe('diagnostics forwarded to the backend log', () => {
    it('reports the stale composition it just rescued', async () => {
      const { mock, scope } = await spawnedTerminal()
      captured.helperComposing = true

      keydown({ keyCode: 229, isComposing: false })

      const lines = diagnostics(mock, 'ime')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('stale composition unlatched')
      scope.stop()
    })

    it('stays quiet when there was no latch to rescue', async () => {
      const { mock, scope } = await spawnedTerminal()
      captured.helperComposing = false

      keydown({ keyCode: 229, isComposing: false })

      expect(diagnostics(mock, 'ime')).toEqual([])
      scope.stop()
    })

    it('reports a composition that stayed open far longer than a candidate pick', async () => {
      const { mock, scope } = await spawnedTerminal()
      const now = vi.spyOn(Date, 'now')

      now.mockReturnValue(1_000_000)
      captured.textarea!.dispatchEvent(new Event('compositionstart'))
      now.mockReturnValue(1_002_000)
      captured.textarea!.dispatchEvent(new Event('compositionend'))

      expect(diagnostics(mock, 'ime')[0]).toContain('composition open 2000ms')
      scope.stop()
    })

    it('says nothing about an ordinary composition', async () => {
      const { mock, scope } = await spawnedTerminal()
      const now = vi.spyOn(Date, 'now')

      now.mockReturnValue(1_000_000)
      captured.textarea!.dispatchEvent(new Event('compositionstart'))
      now.mockReturnValue(1_000_400)
      captured.textarea!.dispatchEvent(new Event('compositionend'))

      expect(diagnostics(mock, 'ime')).toEqual([])
      scope.stop()
    })

    // Typing then goes nowhere visible until the user clicks the pane, which is
    // indistinguishable from lag unless the log names it.
    it('reports a window return that could not retake focus', async () => {
      const { mock, scope } = await spawnedTerminal()
      captured.textarea!.dispatchEvent(new Event('focus'))
      vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      captured.textarea!.dispatchEvent(new Event('blur'))

      window.dispatchEvent(new Event('focus'))

      expect(diagnostics(mock, 'focus')[0]).toContain('could not retake focus')
      scope.stop()
    })
  })
})
