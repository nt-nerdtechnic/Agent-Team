// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Seeded before useTerminal is imported — the module reads `terminal-last-size`
// at load time, and without a borrowable size a hidden pane parks its spawn.
vi.hoisted(() => {
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

const writes = vi.hoisted(() => [] as string[])
const clears = vi.hoisted(() => ({ count: 0 }))
// The width-settled callback useTerminal hands to the resize controller.
// Captured so a test can fire it the way a settled width change would.
const reflow = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
// Lets a test put the mock terminal into the alternate buffer.
const bufferType = vi.hoisted(() => ({ value: 'normal' }))
// DECSET 1004 — whether the CLI asked to receive focus events.
const focusMode = vi.hoisted(() => ({ value: false }))

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
  createResizeController: (...args: unknown[]) => {
    reflow.fn = args[8] as () => Promise<void>
    return ctrl
  },
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    modes = { get sendFocusMode(): boolean { return focusMode.value } }
    textarea = document.createElement('textarea')
    buffer = {
      active: {
        get type(): string { return bufferType.value },
        viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined,
      },
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
    clear(): void { clears.count++ }
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

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    activate(): void {}
    dispose(): void {}
    serialize(): string { return 'SERIALIZED-BUFFER' }
  },
}))

import { useTerminal } from '../useTerminal'

const SNAP_KEY = 'terminal-scroll:sess-1'
const SNAP_FORMAT = 'nv1\n'
const SNAPSHOT = 'SNAPSHOT-HISTORY'
const TRANSCRIPT = 'line one\nline two\n'
const TRANSCRIPT_AS_WRITTEN = 'line one\r\nline two\r\n'

/** A resume spawn, with the backend able to answer terminal.history. */
function resumePane(transcript: string | null) {
  const mock = createMockBackend()
  mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
  if (transcript === null) {
    mock.setResponse('terminal.history', { text: '', truncated: false })
  } else {
    mock.setResponse('terminal.history', { text: transcript, truncated: false })
  }
  const { result, scope } = withScope(() =>
    useTerminal('pane-1', mock.backend, { workspacePath: '/ws' })
  )
  result.mount(document.createElement('div'))
  return { mock, result, scope }
}

async function doResume(result: ReturnType<typeof resumePane>['result']): Promise<void> {
  await result.spawn({
    command: 'claude',
    cwd: '/ws',
    agentKey: 'claude',
    resumeKey: 'sess-1',
    isResume: true,
    restoreMode: 'memory-resume',
    skipReattach: true,
  })
}

describe('useTerminal — transcript history and width reflow', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    writes.length = 0
    clears.count = 0
    reflow.fn = null
    bufferType.value = 'normal'
    focusMode.value = false
  })

  it('replays the backend transcript, converting bare LF to CRLF', async () => {
    const { result, scope } = resumePane(TRANSCRIPT)
    await doResume(result)
    // Bare \n would leave each line starting where the previous one ended.
    expect(writes).toContain(TRANSCRIPT_AS_WRITTEN)
    scope.stop()
  })

  it('prefers the transcript over the localStorage snapshot', async () => {
    localStorage.setItem(SNAP_KEY, SNAP_FORMAT + SNAPSHOT)
    const { result, scope } = resumePane(TRANSCRIPT)
    await doResume(result)
    // Both exist; only one may be replayed or the history shows up twice.
    expect(writes).toContain(TRANSCRIPT_AS_WRITTEN)
    expect(writes).not.toContain(SNAPSHOT)
    scope.stop()
  })

  it('falls back to the snapshot when the backend has no transcript', async () => {
    localStorage.setItem(SNAP_KEY, SNAP_FORMAT + SNAPSHOT)
    const { result, scope } = resumePane(null)
    await doResume(result)
    expect(writes).toContain(SNAPSHOT)
    scope.stop()
  })

  it('asks the backend for the pane, never for a path', async () => {
    const { mock, result, scope } = resumePane(TRANSCRIPT)
    await doResume(result)
    const req = mock.sent.find((s) => s.type === 'terminal.history')
    expect(req?.payload).toMatchObject({
      workspace_path: '/ws',
      agent_key: 'claude',
      pane_id: 'pane-1',
    })
    // A caller-supplied path would let this read arbitrary files.
    expect(Object.keys(req?.payload ?? {})).not.toContain('log_path')
    scope.stop()
  })

  describe('alternate-screen clear on width change', () => {
    it('blanks the alternate screen so the CLI repaints at the new width', async () => {
      const { mock, result, scope } = resumePane(TRANSCRIPT)
      await doResume(result)
      bufferType.value = 'alternate'
      // A chunk of PTY output marks the CLI as actively drawing, which is the
      // only state where clearing is safe.
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'x' })
      // Output is coalesced before it reaches xterm, and the activity clock is
      // stamped on that flush — not on arrival. Wait for the coalesce window.
      await new Promise((r) => setTimeout(r, 120))
      writes.length = 0

      await reflow.fn?.()

      // ESC[2J ESC[H only: PuTTY rebuilds the alt screen blank at the new width
      // and lets the application draw itself (terminal.c:1927-1940). No history
      // is rewritten, and the scrollback is not touched.
      expect(writes).toEqual(['\x1b[2J\x1b[H'])
      expect(clears.count).toBe(0)
      scope.stop()
    })

    it('leaves an IDLE pane alone rather than blanking it', async () => {
      const { result, scope } = resumePane(TRANSCRIPT)
      await doResume(result)
      bufferType.value = 'alternate'
      writes.length = 0
      // No PTY output has arrived, so the activity clock is far in the past —
      // exactly the state of a Claude pane sitting at its prompt. It ignores
      // SIGWINCH there, so clearing would leave a blank pane nothing refills.
      await reflow.fn?.()

      expect(writes).toEqual([])
      scope.stop()
    })

    it('nudges an idle TUI with focus events when it asked for them', async () => {
      const { mock, result, scope } = resumePane(TRANSCRIPT)
      await doResume(result)
      bufferType.value = 'alternate'
      focusMode.value = true   // the CLI turned DECSET 1004 on
      writes.length = 0

      await reflow.fn?.()

      // Nothing written to the screen — the pane keeps its content.
      expect(writes).toEqual([])
      // Focus-out then focus-in, as ordinary input the CLI asked to receive.
      const sent = mock.sent.filter((s) => s.type === 'terminal.input')
      expect(sent.at(-1)?.payload).toMatchObject({ data: '\x1b[O\x1b[I' })
      scope.stop()
    })

    it('sends nothing to an idle TUI that never enabled focus reporting', async () => {
      const { mock, result, scope } = resumePane(TRANSCRIPT)
      await doResume(result)
      bufferType.value = 'alternate'
      focusMode.value = false
      writes.length = 0

      await reflow.fn?.()

      // Without DECSET 1004 these bytes would land in the prompt as garbage.
      expect(mock.sent.filter((s) => s.type === 'terminal.input')).toEqual([])
      expect(writes).toEqual([])
      scope.stop()
    })

    it('leaves a normal-buffer pane completely alone', async () => {
      const { result, scope } = resumePane(TRANSCRIPT)
      await doResume(result)
      bufferType.value = 'normal'
      writes.length = 0

      await reflow.fn?.()

      // The conversation of a line-mode CLI lives in the normal buffer, which
      // has scrollback behind it — clearing that would destroy history.
      expect(writes).toEqual([])
      expect(clears.count).toBe(0)
      scope.stop()
    })
  })
})
