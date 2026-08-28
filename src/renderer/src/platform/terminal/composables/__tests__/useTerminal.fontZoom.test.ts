// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Font zoom is app-wide: ⌘+ grows, ⌘- shrinks, ⌘0 resets, and EVERY terminal
// pane changes together. It is bound at the window level (useTerminalFontSize),
// not on xterm's custom key handler — that one only fires while a terminal's
// helper textarea has focus, and could only ever resize that one pane.
// xterm won't boot in happy-dom, so the mock exposes each instance's options.

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
  instances: [] as Array<{ fontSize: number }>,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts }
      captured.instances.push(this.options as { fontSize: number })
    }
    cols = 80
    rows = 24
    options: Record<string, unknown>
    unicode = { activeVersion: '6' }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
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
import {
  DEFAULT_FONT_SIZE,
  installTerminalZoomShortcuts,
  terminalFontSize,
  zoomReset,
} from '../useTerminalFontSize'
import { nextTick } from 'vue'

/** Dispatch a real window keydown, as the browser would. */
async function press(key: string, mods: Partial<KeyboardEventInit> = {}): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true, ...mods })
  window.dispatchEvent(e)
  await nextTick() // let the watchers in useTerminal run
  return e
}

/** Mount a terminal pane and return its live xterm options. */
async function spawnPane(paneId: string): Promise<{ opts: { fontSize: number }; scope: { stop(): void } }> {
  const mock = createMockBackend()
  mock.setResponse('terminal.create', { terminal_session_id: `sess-${paneId}`, pid: 42 })
  const { result, scope } = withScope(() => useTerminal(paneId, mock.backend))
  result.mount(document.createElement('div'))
  await result.spawn({ command: 'bash', cwd: '/tmp' })
  return { opts: captured.instances.at(-1)!, scope }
}

describe('terminal font zoom — app-wide', () => {
  afterEach(() => {
    zoomReset()
    vi.clearAllMocks()
    captured.instances.length = 0
    localStorage.clear()
  })

  it('⌘- shrinks every open pane at once', async () => {
    const a = await spawnPane('pane-a')
    const b = await spawnPane('pane-b')

    const e = await press('-')

    expect(terminalFontSize.value).toBe(11)
    expect(a.opts.fontSize).toBe(11)
    expect(b.opts.fontSize).toBe(11) // both panes, not just a focused one
    expect(e.defaultPrevented).toBe(true)

    a.scope.stop()
    b.scope.stop()
  })

  it('refits every pane so the content keeps filling it', async () => {
    const a = await spawnPane('pane-a')
    const b = await spawnPane('pane-b')
    ctrl.applyFit.mockClear() // mount/spawn already refit; count only zoom-driven calls

    await press('-')

    expect(ctrl.applyFit).toHaveBeenCalledTimes(2) // one refit per pane

    a.scope.stop()
    b.scope.stop()
  })

  it('arms redraw for each pane', async () => {
    const a = await spawnPane('pane-a')
    const b = await spawnPane('pane-b')
    ctrl.requestResizeRedraw.mockClear()

    await press('-')

    expect(ctrl.requestResizeRedraw).toHaveBeenCalledTimes(2)
    expect(ctrl.requestResizeRedraw).toHaveBeenCalledWith()
    a.scope.stop()
    b.scope.stop()
  })

  it('⌘+ grows beyond the former maximum', async () => {
    const a = await spawnPane('pane-a')

    for (let i = 0; i < 30; i++) await press('+', { shiftKey: true, code: 'Equal' })

    expect(a.opts.fontSize).toBe(42)
    a.scope.stop()
  })

  it('⌘- shrinks below the former minimum', async () => {
    const a = await spawnPane('pane-a')

    for (let i = 0; i < 10; i++) await press('-')
    expect(a.opts.fontSize).toBe(2)

    a.scope.stop()
  })

  it('⌘+ grows when + and = share the Equal key', async () => {
    const a = await spawnPane('pane-a')

    await press('=', { shiftKey: true, code: 'Equal' })
    expect(a.opts.fontSize).toBe(13)

    a.scope.stop()
  })

  it('⌘= grows without Shift', async () => {
    const a = await spawnPane('pane-a')

    await press('=', { code: 'Equal' })
    expect(a.opts.fontSize).toBe(13)

    a.scope.stop()
  })

  it('⌘0 resets to the default size', async () => {
    const a = await spawnPane('pane-a')

    for (let i = 0; i < 5; i++) await press('+', { shiftKey: true, code: 'Equal' })
    expect(a.opts.fontSize).toBe(17)

    await press('0', { code: 'Digit0' })
    expect(a.opts.fontSize).toBe(DEFAULT_FONT_SIZE)

    a.scope.stop()
  })

  it('a pane opened after a zoom starts at the current size', async () => {
    const a = await spawnPane('pane-a')
    await press('+', { shiftKey: true, code: 'Equal' })
    await press('+', { shiftKey: true, code: 'Equal' })
    expect(a.opts.fontSize).toBe(14)

    const b = await spawnPane('pane-b') // spawned while zoomed
    expect(b.opts.fontSize).toBe(14)

    a.scope.stop()
    b.scope.stop()
  })

  it('persists the size so it survives a restart', async () => {
    const a = await spawnPane('pane-a')
    await press('+', { shiftKey: true, code: 'Equal' })

    expect(localStorage.getItem('terminal.fontSize')).toBe('13')
    a.scope.stop()
  })

  it('ignores plain and wrongly-modified keys', async () => {
    const a = await spawnPane('pane-a')
    ctrl.applyFit.mockClear()

    await press('-', { metaKey: false })
    await press('=', { metaKey: false })
    await press('-', { altKey: true })
    await press('-', { ctrlKey: true })

    expect(a.opts.fontSize).toBe(DEFAULT_FONT_SIZE)
    expect(ctrl.applyFit).not.toHaveBeenCalled()
    a.scope.stop()
  })
})

// Each window runs its own copy of the module, so a zoom in one window only
// reaches the others through localStorage + the `storage` event (which never
// fires in the writing window itself — no self-loop to guard against).
describe('terminal font size — cross-window storage sync', () => {
  afterEach(() => {
    zoomReset()
    localStorage.clear()
  })

  /** Simulate another window's write: the store already holds the new value
   *  by the time the storage event reaches this window. */
  function otherWindowWrites(key: string, value: string): void {
    if (key === 'terminal.fontSize') localStorage.setItem(key, value)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
  }

  it('adopts a size written by another window', () => {
    installTerminalZoomShortcuts()

    otherWindowWrites('terminal.fontSize', '16')

    expect(terminalFontSize.value).toBe(16)
  })

  it('ignores storage events for other keys', () => {
    installTerminalZoomShortcuts()
    otherWindowWrites('terminal.fontSize', '16')

    // The stored size changes, but the event announces an unrelated key —
    // a handler without the key filter would re-read and pick up 20.
    localStorage.setItem('terminal.fontSize', '20')
    window.dispatchEvent(new StorageEvent('storage', { key: 'some.other.key', newValue: 'x' }))

    expect(terminalFontSize.value).toBe(16)
  })

  it.each(['NaN', '0', '-3', 'garbage'])(
    'falls back to the default instead of adopting garbage (%s)',
    (bad) => {
      installTerminalZoomShortcuts()
      otherWindowWrites('terminal.fontSize', '16')
      expect(terminalFontSize.value).toBe(16)

      otherWindowWrites('terminal.fontSize', bad)

      expect(terminalFontSize.value).toBe(DEFAULT_FONT_SIZE)
    }
  )
})

// loadPersisted guards the module-init read of localStorage. It is not
// exported, so exercise it through a fresh module instance per case.
describe('terminal font size — loadPersisted guards module init', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it.each(['NaN', 'abc', '0', '-5', ''])(
    'garbage persisted value (%j) yields the default',
    async (bad) => {
      localStorage.setItem('terminal.fontSize', bad)
      vi.resetModules()
      const mod = await import('../useTerminalFontSize')
      expect(mod.terminalFontSize.value).toBe(DEFAULT_FONT_SIZE)
    }
  )

  it('a missing key yields the default', async () => {
    vi.resetModules()
    const mod = await import('../useTerminalFontSize')
    expect(mod.terminalFontSize.value).toBe(DEFAULT_FONT_SIZE)
  })

  it('a valid persisted value is loaded and rounded', async () => {
    localStorage.setItem('terminal.fontSize', '15.6')
    vi.resetModules()
    const mod = await import('../useTerminalFontSize')
    expect(mod.terminalFontSize.value).toBe(16)
  })
})
