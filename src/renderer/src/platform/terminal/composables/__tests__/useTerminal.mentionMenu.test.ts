// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'
import type { MentionCandidate } from '../../lib/cliContext'

// The @-mention menu is an imperative DOM overlay that owns the keyboard while
// it is open, and every key it swallows is a key the CLI never sees. That makes
// the contract two-sided: what the menu draws, and what still reaches the PTY.
// These tests hold both halves, because a regression in either one is invisible
// until someone is mid-sentence in a real pane — the menu eating a character,
// or the handover to the CLI's own completion arriving with a byte missing.

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

// What the cursor row already holds. The trigger reads it to tell a mention
// from the "@" in "user@host", so a test that cares about the difference sets
// it before typing.
const screenRow = vi.hoisted(() => ({ text: '' }))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea: HTMLTextAreaElement | undefined
    // openMentionMenu refuses to draw without a measured cell box and a
    // `.xterm-screen` to anchor against — both are how it positions the card at
    // the cursor, so a mock missing either would silently test nothing.
    _core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 17 } } } } }
    getSelection(): string { return '' }
    get modes(): { mouseTrackingMode: string; bracketedPasteMode: boolean } {
      return { mouseTrackingMode: 'none', bracketedPasteMode: false }
    }
    buffer = {
      active: {
        type: 'normal',
        viewportY: 0,
        baseY: 0,
        get cursorX(): number { return screenRow.text.length },
        cursorY: 0,
        getLine: (i: number) =>
          i === 0 ? { translateToString: (): string => screenRow.text } : undefined,
      },
    }
    loadAddon(): void {}
    open(el: HTMLElement): void {
      this.textarea = document.createElement('textarea')
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      el.append(this.textarea, screen)
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

const LOCAL: MentionCandidate[] = [
  { address: 'all', group: 'Broadcast' },
  { address: 'claude-1', group: 'This window', status: 'running', statusLabel: 'Running' },
  { address: 'codex-1', group: 'This window', status: 'idle', statusLabel: 'Idle' },
]

describe('useTerminal — @-mention menu', () => {
  const scopes: Array<{ stop: () => void }> = []

  afterEach(() => {
    // Escape tears the overlay down through the same cleanup the menu uses, so
    // a stray card can never carry its document-level key listener into the
    // next test and answer keys meant for a different menu.
    press('Escape')
    scopes.splice(0).forEach((s) => s.stop())
    document.body.replaceChildren()
    vi.restoreAllMocks()
    captured.dataHandler = undefined
    screenRow.text = ''
    localStorage.clear()
  })

  /** Spawn a pane, type '@', and let the deferred open run. */
  async function openMenu(
    candidates: MentionCandidate[] = LOCAL,
    onMentionPick?: (addresses: string[]) => void,
  ) {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() =>
      useTerminal('pane-1', mock.backend, { mentionCandidates: () => candidates, onMentionPick }),
    )
    scopes.push(scope)
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', agentKey: 'claude' })
    captured.dataHandler!('@')
    // The open is deferred a tick so the '@' echoes and the cursor advances.
    await new Promise((r) => setTimeout(r, 0))
    return { mock, terminal: result }
  }

  function press(key: string, init: KeyboardEventInit = {}): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  }

  function type(text: string): void {
    for (const ch of text) press(ch)
  }

  function card(): HTMLElement | null {
    return document.querySelector('.term-mention-card')
  }

  function rows(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.term-mention-row'))
  }

  function addresses(): string[] {
    return rows().map((r) => r.dataset.address!)
  }

  function selectedAddress(): string | undefined {
    return document.querySelector<HTMLElement>('.term-mention-row.is-selected')?.dataset.address
  }

  function checkedAddresses(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.term-mention-row.is-checked')).map(
      (r) => r.dataset.address!,
    )
  }

  /** Payloads written to the PTY, in order. */
  function ptyWrites(mock: ReturnType<typeof createMockBackend>): string[] {
    return mock.sent.filter((s) => s.type === 'terminal.input').map((s) => s.payload.data as string)
  }

  it('opens on @ and offers every candidate', async () => {
    const { mock } = await openMenu()
    expect(card()).not.toBeNull()
    expect(addresses()).toEqual(['all', 'claude-1', 'codex-1'])
    expect(selectedAddress()).toBe('all')
    // The '@' itself still went to the prompt — the menu decorates typing, it
    // does not replace it.
    expect(ptyWrites(mock)).toEqual(['@'])
  })

  it('narrows the list as characters are typed, and still sends them', async () => {
    const { mock } = await openMenu()
    type('c')
    expect(addresses()).toEqual(['claude-1', 'codex-1'])
    expect(ptyWrites(mock)).toEqual(['@', 'c'])
  })

  it('tints the matched run so a filtered row shows why it survived', async () => {
    await openMenu()
    type('cod')
    const hits = Array.from(document.querySelectorAll('.term-mention-hit')).map((e) => e.textContent)
    expect(hits).toEqual(['cod'])
  })

  it('closes on an empty filter, leaving every character on the prompt', async () => {
    // The handover contract: when nothing matches, the CLI's own "@" completion
    // takes over with the word already typed. The character that emptied the
    // list must still reach the PTY — swallowing it would leave the prompt
    // reading "@" for a user who typed "@z", with nothing to re-send.
    // (Keys after the close go to xterm's own handler, not this one.)
    const { mock } = await openMenu()
    type('z')
    expect(card()).toBeNull()
    expect(ptyWrites(mock)).toEqual(['@', 'z'])
  })

  it('closes on Escape without writing anything to the PTY', async () => {
    // Escape cancels the menu, not the typing: the '@' is already on the prompt
    // and taking it back would undo a keystroke the user meant.
    const { mock } = await openMenu()
    const before = ptyWrites(mock).length
    press('Escape')
    expect(card()).toBeNull()
    expect(ptyWrites(mock)).toHaveLength(before)
  })

  it('lets a chord through by closing rather than typing it', async () => {
    const { mock } = await openMenu()
    press('a', { metaKey: true })
    expect(card()).toBeNull()
    expect(ptyWrites(mock)).toEqual(['@'])
  })

  it('backspaces one character of the query and keeps the menu', async () => {
    const { mock } = await openMenu()
    type('c')
    press('Backspace')
    expect(card()).not.toBeNull()
    expect(addresses()).toEqual(['all', 'claude-1', 'codex-1'])
    expect(ptyWrites(mock)).toEqual(['@', 'c', '\x7f'])
  })

  it('closes when Backspace eats the @ itself', async () => {
    const { mock } = await openMenu()
    press('Backspace')
    expect(card()).toBeNull()
    expect(ptyWrites(mock)).toEqual(['@', '\x7f'])
  })

  it('completes with one write that erases the query and inserts the address', async () => {
    // One frame, not two: a separate erase would let the CLI redraw its prompt
    // between the halves, which is exactly when the flicker shows.
    const { mock } = await openMenu()
    type('cod')
    const before = ptyWrites(mock).length
    press('Enter')
    expect(ptyWrites(mock).slice(before)).toEqual(['\x7f\x7f\x7f' + 'codex-1 '])
    expect(card()).toBeNull()
  })

  it('completes on Tab the same way as Enter', async () => {
    const { mock } = await openMenu()
    press('Tab')
    expect(ptyWrites(mock).at(-1)).toBe('all ')
  })

  it('inserts the highlighted row when nothing is ticked', async () => {
    // The single-pick behaviour has to survive multi-select: most users never
    // discover Space.
    const { mock } = await openMenu()
    press('ArrowDown')
    press('Enter')
    expect(ptyWrites(mock).at(-1)).toBe('claude-1 ')
  })

  it('inserts every ticked address, space separated, in tick order', async () => {
    const { mock } = await openMenu()
    press('ArrowDown')
    press(' ')            // claude-1
    press('ArrowDown')
    press(' ')            // codex-1
    expect(checkedAddresses()).toEqual(['claude-1', 'codex-1'])
    press('Enter')
    expect(ptyWrites(mock).at(-1)).toBe('claude-1 codex-1 ')
  })

  it('unticks a row ticked twice', async () => {
    await openMenu()
    press('ArrowDown')
    press(' ')
    expect(checkedAddresses()).toEqual(['claude-1'])
    press(' ')
    expect(checkedAddresses()).toEqual([])
  })

  it('drops the named ticks when broadcast is ticked', async () => {
    // "everyone" plus two names would deliver to those two twice.
    await openMenu()
    press('ArrowDown')
    press(' ')            // claude-1
    press('ArrowUp')
    press(' ')            // all
    expect(checkedAddresses()).toEqual(['all'])
  })

  it('drops broadcast when a name is ticked after it', async () => {
    const { mock } = await openMenu()
    press(' ')            // all
    press('ArrowDown')
    press(' ')            // claude-1
    expect(checkedAddresses()).toEqual(['claude-1'])
    press('Enter')
    expect(ptyWrites(mock).at(-1)).toBe('claude-1 ')
  })

  it('reports the picked addresses to the host', async () => {
    // The host records them as recent, which is what orders the next menu.
    const onMentionPick = vi.fn()
    await openMenu(LOCAL, onMentionPick)
    press('ArrowDown')
    press(' ')
    press('ArrowDown')
    press(' ')
    press('Enter')
    expect(onMentionPick).toHaveBeenCalledWith(['claude-1', 'codex-1'])
  })

  it('moves the selection without wrapping at either end', async () => {
    await openMenu()
    press('ArrowUp')
    expect(selectedAddress()).toBe('all')      // already at the top
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown')
    expect(selectedAddress()).toBe('codex-1')  // already at the bottom
  })

  it('shows a status dot only for a status this window can read', async () => {
    // `all` and panes in another workspace window have no local status to ask
    // for; the menu draws a hollow dot rather than inventing one.
    await openMenu()
    const dots = Array.from(document.querySelectorAll<HTMLElement>('.term-mention-dot'))
    expect(dots.map((d) => d.dataset.status)).toEqual([undefined, 'running', 'idle'])
    const labels = Array.from(document.querySelectorAll('.term-mention-status')).map((e) => e.textContent)
    expect(labels).toEqual(['Running', 'Idle'])
  })

  it('opens for a roster of nothing but cold-restore placeholders', async () => {
    // The situation after any restart: every other pane in the window is a
    // placeholder, so none of them can report a status. Until they were given
    // messaging handles this list was empty and the menu never opened at all —
    // typing '@' looked like a dead key. Now it opens, and the hollow-dot path
    // this file already describes finally runs against real candidates.
    const placeholders: MentionCandidate[] = [
      { address: 'Anroute-Geo', group: 'This window' },
      { address: 'Anroute-Real', group: 'This window' },
      { address: 'Anroute-QA', group: 'This window' },
    ]
    await openMenu(placeholders)

    expect(document.querySelector('.term-mention-menu-root')).not.toBeNull()
    const rows = Array.from(document.querySelectorAll('.term-mention-row')).map((e) => e.textContent)
    expect(rows.length).toBe(3)
    // Every dot is hollow and no row claims a status, rather than the menu
    // guessing one for a pane it cannot ask.
    const dots = Array.from(document.querySelectorAll<HTMLElement>('.term-mention-dot'))
    expect(dots.map((d) => d.dataset.status)).toEqual([undefined, undefined, undefined])
    expect(document.querySelectorAll('.term-mention-status').length).toBe(0)
  })

  it('draws group headers only when they separate something', async () => {
    await openMenu()
    expect(
      Array.from(document.querySelectorAll('.term-mention-group')).map((e) => e.textContent),
    ).toEqual(['Broadcast', 'This window'])
  })

  it('draws no header when every visible row is in one group', async () => {
    // A lone header above every row is noise, and a filtered list is usually
    // one group.
    await openMenu()
    type('c')
    expect(addresses()).toEqual(['claude-1', 'codex-1'])
    expect(document.querySelectorAll('.term-mention-group')).toHaveLength(0)
  })

  it('hides the query line until there is something to report', async () => {
    await openMenu()
    const queryEl = document.querySelector<HTMLElement>('.term-mention-query')!
    expect(queryEl.style.display).toBe('none')
    type('c')
    expect(queryEl.style.display).toBe('flex')
    expect(queryEl.textContent).toContain('@c')
  })

  it('ignores keys that are really IME pre-edit, by either signal', async () => {
    // While a composition is live, e.key is a raw pre-edit keystroke, not
    // committed text: acting on it both mangles the input and steals the Enter
    // the IME needed to pick its own candidate.
    const { mock } = await openMenu()
    const before = ptyWrites(mock).length

    press('Enter', { isComposing: true })
    expect(card()).not.toBeNull()

    press('Enter', { keyCode: 229 })
    expect(card()).not.toBeNull()

    press('j', { isComposing: true })
    expect(addresses()).toEqual(['all', 'claude-1', 'codex-1'])
    expect(ptyWrites(mock)).toHaveLength(before)
  })

  // The draft buffer decides whether App.vue's messaging gate treats this pane
  // as "being typed at" — an injection is a paste plus Enter, so getting it
  // wrong submits somebody's half-written line. The menu writes to the PTY
  // through backend.send, which term.onData (the buffer's only other keeper)
  // never sees, so these are the cases where the buffer can silently drift.
  it('leaves the draft buffer holding exactly what the prompt holds', async () => {
    const { terminal } = await openMenu()
    type('cod')
    press('Enter')   // the prompt now reads "@codex-1 " — nine characters
    // Walk eight of them back through the ordinary input path and the "@" must
    // still be there. This is the shape of the bug it pins: the query went to
    // the PTY through a path that never touched this buffer, so pick() sliced
    // three characters off the REAL prompt instead of off the query, and the
    // buffer ended up one short of the line the CLI is actually holding.
    for (let i = 0; i < 8; i++) captured.dataHandler!('\x7f')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!('\x7f')
    expect(terminal.hasDraft.value).toBe(false)
  })

  it('empties the draft buffer when Backspace eats the whole prompt', async () => {
    const { terminal } = await openMenu()
    type('c')
    press('Backspace')   // removes 'c', menu stays
    press('Backspace')   // removes '@', menu closes
    expect(terminal.hasDraft.value).toBe(false)
  })

  it('stays shut when the pane has no one to mention', async () => {
    const { mock } = await openMenu([])
    expect(card()).toBeNull()
    expect(ptyWrites(mock)).toEqual(['@'])
  })

  it('stays shut when the @ continues a word', async () => {
    // "user@host" is an address, not a mention.
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() =>
      useTerminal('pane-1', mock.backend, { mentionCandidates: () => LOCAL }),
    )
    scopes.push(scope)
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', agentKey: 'claude' })
    screenRow.text = 'user'
    captured.dataHandler!('@')
    await new Promise((r) => setTimeout(r, 0))
    expect(card()).toBeNull()
  })
})
