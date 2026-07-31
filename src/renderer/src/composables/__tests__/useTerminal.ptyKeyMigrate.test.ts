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

  it('chains across repeated rotations', () => {
    localStorage.setItem('terminal-pty:a', 'pty-1')
    migrateTerminalPtyKey('a', 'b')
    migrateTerminalPtyKey('b', 'c')
    expect(localStorage.getItem('terminal-pty:c')).toBe('pty-1')
    expect(localStorage.getItem('terminal-pty:a')).toBeNull()
    expect(localStorage.getItem('terminal-pty:b')).toBeNull()
  })
})
