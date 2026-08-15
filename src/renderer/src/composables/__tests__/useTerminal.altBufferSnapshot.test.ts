// @vitest-environment happy-dom
//
// Full-screen TUI vendors draw their conversation in the
// terminal's ALTERNATE screen buffer, so a snapshot serialized with
// `excludeAltBuffer: true` came back empty and neither the periodic save nor
// the reattach replay did anything for those panes. These tests pin the two
// halves of the fix: the flagged vendors capture the alt screen, and everyone
// else keeps the old behaviour byte for byte.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

const store = vi.hoisted(() => {
  const values = new Map<string, string>()
  values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
  vi.stubGlobal('localStorage', {
    get length(): number { return values.size },
    key: (i: number) => Array.from(values.keys())[i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
  })
  return { values }
})

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
      active: { type: 'alternate', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(): { dispose(): void } { return { dispose(): void {} } }
    write(data?: string): void { if (typeof data === 'string') writes.push(data) }
    writeln(): void {}
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
    hasSelection(): boolean { return false }
    onSelectionChange(): { dispose: () => void } { return { dispose: (): void => {} } }
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

// Mirrors what @xterm/addon-serialize actually produces while the terminal is
// in its alternate buffer: the normal buffer first, then a literal
// `ESC[?1049h ESC[H` boundary, then the alt screen, then the captured modes.
const NORMAL = 'NORMAL-HISTORY'
const ALT = 'ALT-CONVERSATION'
const ALT_ENTER = '\x1b[?1049h\x1b[H'
const MODES = '\x1b[?2004h'
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    activate(): void {}
    dispose(): void {}
    serialize(opts?: { excludeAltBuffer?: boolean }): string {
      return opts?.excludeAltBuffer
        ? NORMAL + MODES
        : NORMAL + ALT_ENTER + ALT + MODES
    }
  },
}))

import { useTerminal, stripAltScreenEnter } from '../useTerminal'
import { AGENT_SPECS } from '../../agents'

const SELF_KEY = 'terminal-scroll:pane-1'
const SNAP_FORMAT = 'nv1\n'

/** Spawn a pane under the given agent key and return its saved snapshot body. */
async function snapshotFor(agentKey?: string): Promise<string> {
  const mock = createMockBackend()
  mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
  const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
  result.mount(document.createElement('div'))
  await result.spawn({ command: agentKey ?? 'bash', cwd: '/tmp', agentKey })
  mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'x' })
  await new Promise((r) => setTimeout(r, 120))
  scope.stop()   // dispose persists the snapshot
  return (localStorage.getItem(SELF_KEY) ?? '').slice(SNAP_FORMAT.length)
}

describe('useTerminal — alternate-buffer scrollback snapshot', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    store.values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
    writes.length = 0
  })

  it('captures the alt screen for a full-screen TUI vendor', async () => {
    const body = await snapshotFor('claude')
    expect(body).toContain(ALT)      // the conversation itself
    expect(body).toContain(NORMAL)   // and whatever preceded it
  })

  it('strips the alt-screen enter so the replay stays in the normal buffer', async () => {
    const body = await snapshotFor('claude')
    // A payload carrying `?1049h` parks the terminal it is replayed into in the
    // alternate buffer: unscrollable, and it swallows every later write.
    expect(body).not.toContain('\x1b[?1049h')
    expect(body).not.toContain('\x1b[?1047h')
    expect(body).not.toContain('\x1b[?47h')
  })

  it('keeps the alt screen out of a plain shell pane', async () => {
    // The `terminal` pane is where the user runs vim or a pager — a transient
    // full-screen view that must never be saved as history.
    const body = await snapshotFor('terminal')
    expect(body).toBe(NORMAL + MODES)
    expect(body).not.toContain(ALT)
  })

  it('leaves an unflagged pane on the pre-existing path', async () => {
    const body = await snapshotFor(undefined)
    expect(body).toBe(NORMAL + MODES)
    expect(body).not.toContain(ALT)
  })

  it('flags exactly the vendors verified to own the alt buffer', () => {
    const flagged = AGENT_SPECS.filter((s) => s.fullScreenTui).map((s) => s.agentKey)
    // Each of these was measured on a real PTY (or, for codex, in the shipped
    // binary) emitting `ESC[?1049h` at startup. Vendors probed and found to
    // stay in the NORMAL buffer — grok, kimi, pi, aider — must stay off the
    // list, as must anything unmeasured (muse never tripped the probe;
    // cursor and antigravity are not installed locally).
    expect(flagged.sort()).toEqual(['claude', 'codex', 'copilot', 'kilo', 'opencode', 'qwen'])
  })

  it('never flags a line-mode CLI or the plain shell pane', () => {
    // aider's conversation is already in the normal buffer, and `terminal` is
    // where a TRANSIENT full-screen view (vim, a pager) shows up — saving
    // either one's alt screen as history is the bug excludeAltBuffer prevents.
    const byKey = new Map(AGENT_SPECS.map((s) => [s.agentKey, s]))
    for (const key of ['aider', 'terminal']) {
      const spec = byKey.get(key)
      expect(spec, `${key} spec is missing`).toBeDefined()
      expect(spec?.fullScreenTui).toBeFalsy()
    }
  })

  it('replays the snapshot before the mouse-mode reset', async () => {
    // A serialized buffer ends with the modes it captured, so the reset has to
    // come after it or it is immediately undone.
    localStorage.setItem(SELF_KEY, SNAP_FORMAT + NORMAL + ALT)
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({
      command: 'claude', cwd: '/tmp', agentKey: 'claude',
      resumeKey: 'pane-1', isResume: true,
    })
    const joined = writes.join('')
    expect(joined).toContain(ALT)
    expect(joined.indexOf(ALT)).toBeLessThan(joined.indexOf('\x1b[?1000l'))
  })
})

describe('stripAltScreenEnter', () => {
  it('drops a leading enter sequence outright', () => {
    expect(stripAltScreenEnter(`${ALT_ENTER}screen`)).toBe('screen')
  })

  it('breaks the line when normal-buffer content came first', () => {
    // The serializer puts the boundary AFTER the normal buffer, so a pane that
    // had history before the TUI took over sees it mid-payload. Removing it
    // outright would glue the restored screen onto the last history line.
    expect(stripAltScreenEnter(`history${ALT_ENTER}screen`)).toBe('history\r\nscreen')
  })

  it('handles the enter sequence without its paired cursor home', () => {
    expect(stripAltScreenEnter('\x1b[?1049hscreen')).toBe('screen')
  })

  it('leaves a payload with no alt buffer untouched', () => {
    const plain = `plain text${MODES}`
    expect(stripAltScreenEnter(plain)).toBe(plain)
  })

  it('touches only the first occurrence', () => {
    // There is only ever one boundary; anything later is content, not a marker.
    expect(stripAltScreenEnter(`${ALT_ENTER}a${ALT_ENTER}b`)).toBe(`a${ALT_ENTER}b`)
  })
})
