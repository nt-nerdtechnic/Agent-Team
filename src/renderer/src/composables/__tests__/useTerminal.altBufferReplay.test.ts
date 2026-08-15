// @vitest-environment happy-dom
//
// End-to-end shape check against the REAL xterm + serialize addon: a snapshot
// taken while the terminal is in its alternate buffer must replay into a fresh
// terminal as ordinary normal-buffer content. Everything else in the snapshot
// path is mocked elsewhere; this is the one place the actual escape-sequence
// behaviour is pinned.
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { stripAltScreenEnter } from '../useTerminal'

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function screenText(term: Terminal): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
  return out.join('\n')
}

describe('alt-buffer snapshot replay (real xterm)', () => {
  it('restores the alt screen as normal-buffer content', async () => {
    const source = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    const serializer = new SerializeAddon()
    source.loadAddon(serializer)
    await write(source, 'history line\r\n')
    await write(source, '\x1b[?1049h')           // the TUI takes over
    await write(source, 'conversation line\r\n')
    expect(source.buffer.active.type).toBe('alternate')

    // What the pane persists for a fullScreenTui vendor.
    const payload = stripAltScreenEnter(
      serializer.serialize({ scrollback: 2000, excludeAltBuffer: false }),
    )
    expect(payload).toContain('conversation line')
    expect(payload).not.toContain('\x1b[?1049h')

    const restored = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    await write(restored, payload)
    // Parked in the alternate buffer the user could not scroll back, and every
    // later write would land on a screen that gets discarded.
    expect(restored.buffer.active.type).toBe('normal')
    expect(screenText(restored)).toContain('conversation line')
    expect(screenText(restored)).toContain('history line')

    source.dispose()
    restored.dispose()
  })

  it('excludeAltBuffer:true really does lose the conversation', async () => {
    // The bug this change fixes, stated as a test so it cannot silently return.
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    const serializer = new SerializeAddon()
    term.loadAddon(serializer)
    await write(term, '\x1b[?1049h')
    await write(term, 'conversation line\r\n')
    expect(serializer.serialize({ scrollback: 2000, excludeAltBuffer: true }))
      .not.toContain('conversation line')
    term.dispose()
  })
})
