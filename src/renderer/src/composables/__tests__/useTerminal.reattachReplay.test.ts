// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Map-backed localStorage, seeded before useTerminal is imported: the module
// reads `terminal-last-size` once at load time, and without a borrowable size a
// pane with no measurable width parks its spawn instead of creating.
const store = vi.hoisted(() => {
  const values = new Map<string, string>()
  values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
  vi.stubGlobal('localStorage', {
    get length(): number { return values.size },
    key: (i: number) => Array.from(values.keys())[i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => {
      values.clear()
      values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
    },
  })
  return values
})

// Everything written into xterm, so a test can assert what was (and was not)
// replayed on reattach, and in which order.
const writes = vi.hoisted(() => [] as string[])

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
    write(data?: string): void { if (typeof data === 'string') writes.push(data) }
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

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    activate(): void {}
    dispose(): void {}
    serialize(): string { return 'SERIALIZED-BUFFER' }
  },
}))

import { useTerminal } from '../useTerminal'

const PTY_KEY = 'terminal-pty:pane-1'
const SNAP_KEY = 'terminal-scroll:pane-1'
const SNAP_FORMAT = 'nv1\n'
const HISTORY = 'PRIOR-CONVERSATION'
// Written by tryReattach right after the replay so no stale xterm mouse state
// forwards events to the live process.
const MOUSE_RESET = '\x1b[?1000l'

/** A pane whose PTY survived, with the backend confirming the id is alive. */
function livePane() {
  const mock = createMockBackend()
  mock.setResponse('terminal.reattach', { alive: ['sess-old'], dead: [] })
  mock.setResponse('terminal.create', { terminal_session_id: 'sess-old', pid: 42 })
  localStorage.setItem(PTY_KEY, 'sess-old')
  const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
  result.mount(document.createElement('div'))
  return { mock, result, scope }
}

describe('useTerminal — scrollback replay on reattach', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    writes.length = 0
  })

  it('replays the stored snapshot into the reattached pane', async () => {
    localStorage.setItem(SNAP_KEY, SNAP_FORMAT + HISTORY)
    const { result, scope } = livePane()

    expect(await result.tryReattach()).toBe(true)

    expect(writes).toContain(HISTORY)
    // Order matters: a serialized buffer ends with the modes it captured
    // (mouse tracking, bracketed paste), so the reset has to come after it.
    expect(writes.indexOf(HISTORY)).toBeLessThan(
      writes.findIndex((w) => w.startsWith(MOUSE_RESET))
    )
    scope.stop()
  })

  it('leaves the pane untouched when there is no snapshot', async () => {
    const { result, scope } = livePane()

    expect(await result.tryReattach()).toBe(true)

    // Only the mouse-mode reset — nothing was replayed.
    expect(writes).toEqual([expect.stringContaining(MOUSE_RESET)])
    scope.stop()
  })

  it('does not replay a snapshot the session exit discarded', async () => {
    localStorage.setItem(SNAP_KEY, SNAP_FORMAT + HISTORY)
    const { mock, result, scope } = livePane()
    await result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    mock.emit('terminal.exit', { terminal_session_id: 'sess-old', exit_code: 0 })
    expect(localStorage.getItem(SNAP_KEY)).toBeNull()
    writes.length = 0

    // The PTY id is cleared by the exit too; a later pane finding a live id
    // under this key must still not resurrect the dead session's scrollback.
    localStorage.setItem(PTY_KEY, 'sess-old')
    expect(await result.tryReattach()).toBe(true)

    expect(writes.join('')).not.toContain(HISTORY)
    scope.stop()
  })

  it('does not replay a pre-upgrade raw snapshot', async () => {
    // Raw PTY bytes from before the serialized format: absolute cursor moves
    // whose coordinates only hold at the width they were recorded at.
    localStorage.setItem(SNAP_KEY, '\x1b[5;10HLEGACY-RAW-SNAPSHOT')
    const { result, scope } = livePane()

    expect(await result.tryReattach()).toBe(true)

    expect(writes.join('')).not.toContain('LEGACY-RAW-SNAPSHOT')
    expect(localStorage.getItem(SNAP_KEY)).toBeNull()  // quota reclaimed
    scope.stop()
  })

  it('replays at most once per terminal', async () => {
    localStorage.setItem(SNAP_KEY, SNAP_FORMAT + HISTORY)
    const { result, scope } = livePane()

    await result.tryReattach()
    await result.tryReattach()

    expect(writes.filter((w) => w === HISTORY)).toHaveLength(1)
    scope.stop()
  })
})
