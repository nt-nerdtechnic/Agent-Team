// @vitest-environment happy-dom
// The reattach key (`terminal-pty:<resumeKey>`) follows the CLI's session id,
// which rotates on every resume. Without migrating the entry to the new key,
// the next restore can't find the still-running PTY and spawns a second CLI
// beside it (the observed idle `claude --resume` accumulation).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() { return values.size },
  })
})

import { migrateTerminalPtyKey } from '../useTerminal'

describe('migrateTerminalPtyKey', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('moves the PTY id from the old key to the new key', () => {
    localStorage.setItem('terminal-pty:session-a', 'pty-1')
    migrateTerminalPtyKey('session-a', 'session-b')
    expect(localStorage.getItem('terminal-pty:session-b')).toBe('pty-1')
    expect(localStorage.getItem('terminal-pty:session-a')).toBeNull()
  })

  it('is a no-op without a stored entry', () => {
    migrateTerminalPtyKey('session-a', 'session-b')
    expect(localStorage.getItem('terminal-pty:session-b')).toBeNull()
  })

  it('is a no-op for identical or empty keys', () => {
    localStorage.setItem('terminal-pty:session-a', 'pty-1')
    migrateTerminalPtyKey('session-a', 'session-a')
    migrateTerminalPtyKey('', 'session-b')
    migrateTerminalPtyKey('session-a', '')
    expect(localStorage.getItem('terminal-pty:session-a')).toBe('pty-1')
    expect(localStorage.getItem('terminal-pty:session-b')).toBeNull()
  })

  it('moves the scrollback snapshot alongside the PTY id', () => {
    // The snapshot is keyed the same way, so without this it is written under
    // the old session id and read back under the new one: the history is
    // invisible to the pane that owns it and lingers as an orphan that still
    // competes for the shared localStorage quota.
    localStorage.setItem('terminal-pty:session-a', 'pty-1')
    localStorage.setItem('terminal-scroll:session-a', 'nv1\nHISTORY')
    migrateTerminalPtyKey('session-a', 'session-b')
    expect(localStorage.getItem('terminal-scroll:session-b')).toBe('nv1\nHISTORY')
    expect(localStorage.getItem('terminal-scroll:session-a')).toBeNull()
  })

  it('moves a snapshot even when the PTY is already gone', () => {
    // An exited/reaped PTY leaves no `terminal-pty:` entry, but the scrollback
    // is still worth carrying to the rotated key.
    localStorage.setItem('terminal-scroll:session-a', 'nv1\nHISTORY')
    migrateTerminalPtyKey('session-a', 'session-b')
    expect(localStorage.getItem('terminal-scroll:session-b')).toBe('nv1\nHISTORY')
    expect(localStorage.getItem('terminal-scroll:session-a')).toBeNull()
  })

  it('chains across repeated rotations', () => {
    localStorage.setItem('terminal-pty:a', 'pty-1')
    migrateTerminalPtyKey('a', 'b')
    migrateTerminalPtyKey('b', 'c')
    expect(localStorage.getItem('terminal-pty:c')).toBe('pty-1')
    expect(localStorage.getItem('terminal-pty:a')).toBeNull()
    expect(localStorage.getItem('terminal-pty:b')).toBeNull()
  })
})
