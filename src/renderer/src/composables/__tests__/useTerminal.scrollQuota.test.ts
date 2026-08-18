// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// localStorage stand-in with an enforceable quota, so the scrollback snapshot's
// overflow path can be driven end-to-end. `quota` starts effectively unlimited
// (spawn writes the PTY id) and the test tightens it right before dispose,
// which is when the snapshot is persisted.
const store = vi.hoisted(() => {
  const values = new Map<string, string>()
  // Seeded before useTerminal is imported: the module reads this once at load
  // time. Without a borrowable size, a resume spawn into a pane with no
  // measurable width parks itself and never reaches the replay path.
  values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
  const state = { quota: Number.MAX_SAFE_INTEGER }
  const usedBytes = (): number => {
    let n = 0
    values.forEach((v, k) => { n += k.length + v.length })
    return n
  }
  vi.stubGlobal('localStorage', {
    get length(): number { return values.size },
    key: (i: number) => Array.from(values.keys())[i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      const existing = values.has(key) ? key.length + values.get(key)!.length : 0
      if (usedBytes() - existing + key.length + String(value).length > state.quota) {
        throw new Error('QuotaExceededError')
      }
      values.set(key, String(value))
    },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
  })
  return { values, state }
})

// Everything written into xterm, so a test can assert what was (and was not)
// replayed on resume.
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

// The snapshot is produced by serializing xterm's buffer, so the payload size
// is driven by the requested scrollback line count — that is the only knob
// saveScrollSnapshot has to shrink a payload that will not fit. Emit a fixed
// 10 characters per line so the tests can reason about sizes exactly.
const CHARS_PER_LINE = 10
vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    activate(): void {}
    dispose(): void {}
    serialize(opts?: { scrollback?: number }): string {
      return 'A'.repeat((opts?.scrollback ?? 0) * CHARS_PER_LINE)
    }
  },
}))

import { useTerminal } from '../useTerminal'

const SELF_KEY = 'terminal-scroll:pane-1'
const OTHER_KEY = 'terminal-scroll:pane-other'

describe('useTerminal — scrollback snapshot under localStorage quota', () => {
  afterEach(() => {
    vi.clearAllMocks()
    store.state.quota = Number.MAX_SAFE_INTEGER
    localStorage.clear()
    writes.length = 0
  })

  // saveScrollSnapshot starts at SCROLL_SNAP_LINES and halves on each retry.
  const FULL_LINES = 2_000
  const FULL_SIZE = FULL_LINES * CHARS_PER_LINE   // 20_000
  // Format marker prefixed to every stored snapshot, so a pre-upgrade raw-bytes
  // snapshot can be told apart and discarded instead of replayed.
  const SNAP_FORMAT = 'nv1\n'

  /** Spawn a pane and run some output through it, then hand back its scope. */
  async function paneWithScrollback() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    // Distinct from the serializer's 'A' so the assertions can tell which path
    // produced the snapshot.
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'P'.repeat(FULL_SIZE) })
    await new Promise((r) => setTimeout(r, 120)) // let the coalesce window flush
    return scope
  }

  it('persists the serialized buffer, not the raw PTY bytes', async () => {
    const scope = await paneWithScrollback()
    scope.stop()

    const saved = localStorage.getItem(SELF_KEY) ?? ''
    expect(saved).toBe(SNAP_FORMAT + 'A'.repeat(FULL_SIZE))  // came from serialize()
    expect(saved).not.toContain('P')                         // not the PTY's bytes
  })

  it('evicts another pane stale snapshot instead of dropping the new one', async () => {
    const scope = await paneWithScrollback()

    // A closed pane's snapshot already fills most of the shared quota.
    store.values.set(OTHER_KEY, 'B'.repeat(30_000))
    store.state.quota = 25_000

    scope.stop() // dispose persists the snapshot

    expect(localStorage.getItem(OTHER_KEY)).toBeNull()
    // full history kept
    expect(localStorage.getItem(SELF_KEY)).toHaveLength(SNAP_FORMAT.length + FULL_SIZE)
  })

  it('evicts an orphaned snapshot before one a live pane still owns', async () => {
    const scope = await paneWithScrollback()
    // A pane that is still open: its snapshot is history the user can scroll
    // back to, so it must outlive the leftovers of panes that are gone.
    const live = withScope(() => useTerminal('pane-other', createMockBackend().backend))
    try {
      store.values.set(OTHER_KEY, 'B'.repeat(30_000))
      store.values.set('terminal-scroll:pane-ghost', 'C'.repeat(10_000))  // closed pane
      store.state.quota = 55_000  // room to store the new snapshot after ONE eviction

      scope.stop()

      expect(localStorage.getItem('terminal-scroll:pane-ghost')).toBeNull()
      expect(localStorage.getItem(OTHER_KEY)).not.toBeNull()
      expect(localStorage.getItem(SELF_KEY)).toHaveLength(SNAP_FORMAT.length + FULL_SIZE)
    } finally {
      live.scope.stop()
    }
  })

  it('serializes fewer lines when there is nothing left to evict', async () => {
    const scope = await paneWithScrollback()

    store.state.quota = 6_000 // fits a halved-twice payload, nothing bigger

    scope.stop()

    const saved = localStorage.getItem(SELF_KEY) ?? ''
    const body = saved.slice(SNAP_FORMAT.length)
    expect(body.length).toBeGreaterThan(0)
    expect(body.length).toBeLessThan(FULL_SIZE)
    // Shrunk by re-serializing fewer lines, never by slicing the string — a
    // slice would cut through an escape sequence and corrupt the replay.
    expect(body.length % CHARS_PER_LINE).toBe(0)
  })

  it('discards a pre-upgrade raw snapshot instead of replaying it', async () => {
    // Written by a build that stored raw PTY bytes: absolute cursor moves whose
    // coordinates only hold at the width they were recorded at. Replaying this
    // is the bug, so it must be dropped — and its quota reclaimed.
    localStorage.setItem(SELF_KEY, '\x1b[5;10HLEGACY-RAW-SNAPSHOT')

    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', resumeKey: 'pane-1', isResume: true })

    expect(writes.join('')).not.toContain('LEGACY-RAW-SNAPSHOT')
    expect(localStorage.getItem(SELF_KEY)).toBeNull()
  })

  it('gives up with a warning rather than looping when nothing fits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scope = await paneWithScrollback()

    store.state.quota = 0 // no write can ever succeed

    scope.stop() // must terminate, not spin

    expect(localStorage.getItem(SELF_KEY)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('localStorage quota exhausted'))
    warn.mockRestore()
  })
})
