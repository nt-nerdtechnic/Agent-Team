// @vitest-environment happy-dom
// Removal rules ('-command') at the resolver level.
//
// Removal is deliberately surgical rather than "blank the key": several default
// keys carry more than one command, separated only by their `when` clause, and
// a coarse unbind would take the neighbours down with it. These tests pin the
// narrow behaviour, including the two places it is easy to get wrong — a chord
// prefix that must be released once its last chord is gone, and a removal whose
// own `when` is false and must therefore do nothing.
import { describe, it, expect } from 'vitest'
import { KeyResolver } from '../keyResolver'
import { isRemovalRule, removalTarget, type KeybindingRule } from '../types'

function mkEvent(
  key: string,
  opts: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
}

describe('isRemovalRule / removalTarget', () => {
  it('recognises a removal and reads its target', () => {
    const rule: KeybindingRule = { key: 'cmd+s', command: '-editor.action.save' }
    expect(isRemovalRule(rule)).toBe(true)
    expect(removalTarget(rule)).toBe('editor.action.save')
  })

  it('a bare "-" is not a removal (it would target nothing)', () => {
    expect(isRemovalRule({ key: 'cmd+s', command: '-' })).toBe(false)
  })

  it('an ordinary command is not a removal', () => {
    expect(isRemovalRule({ key: 'cmd+s', command: 'editor.action.save' })).toBe(false)
  })
})

describe('single-key removal', () => {
  it('cancels its target so the key falls through', () => {
    const resolver = new KeyResolver([
      { key: 'cmd+s', command: 'editor.save' },
      { key: 'cmd+s', command: '-editor.save' },
    ])
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), {})).toBeNull()
  })

  it('spares the other command bound to the same key', () => {
    const resolver = new KeyResolver([
      { key: 'cmd+g', command: 'a.first', when: 'ctxA' },
      { key: 'cmd+g', command: 'b.second', when: 'ctxB' },
      { key: 'cmd+g', command: '-a.first', when: 'ctxA' },
    ])
    expect(resolver.resolve(mkEvent('g', { metaKey: true }), { ctxA: true })).toBeNull()
    expect(resolver.resolve(mkEvent('g', { metaKey: true }), { ctxB: true })?.command).toBe('b.second')
  })

  it('is order-independent: a removal declared before its target still applies', () => {
    const resolver = new KeyResolver([
      { key: 'cmd+s', command: '-editor.save' },
      { key: 'cmd+s', command: 'editor.save' },
    ])
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), {})).toBeNull()
  })

  it('only cancels the key it names', () => {
    const resolver = new KeyResolver([
      { key: 'cmd+s', command: 'editor.save' },
      { key: 'cmd+alt+s', command: 'editor.save' },
      { key: 'cmd+s', command: '-editor.save' },
    ])
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), {})).toBeNull()
    expect(resolver.resolve(mkEvent('s', { metaKey: true, altKey: true }), {})?.command).toBe('editor.save')
  })

  it('matches its target through a different modifier spelling', () => {
    const resolver = new KeyResolver([
      { key: 'shift+cmd+p', command: 'workbench.showCommands' },
      { key: 'cmd+shift+p', command: '-workbench.showCommands' },
    ])
    expect(resolver.resolve(mkEvent('P', { metaKey: true, shiftKey: true }), {})).toBeNull()
  })

  it('does nothing while its own when-clause is false', () => {
    const resolver = new KeyResolver([
      { key: 'cmd+s', command: 'editor.save' },
      { key: 'cmd+s', command: '-editor.save', when: 'editorOpen' },
    ])
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), { editorOpen: false })?.command).toBe('editor.save')
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), { editorOpen: true })).toBeNull()
  })

  it('never fires as a command of its own', () => {
    const resolver = new KeyResolver([{ key: 'cmd+s', command: '-editor.save' }])
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), {})).toBeNull()
  })

  it('lets a replacement binding win on the new key', () => {
    const resolver = new KeyResolver([
      { key: 'cmd+s', command: 'editor.save' },
      { key: 'cmd+s', command: '-editor.save' },
      { key: 'cmd+alt+s', command: 'editor.save' },
    ])
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), {})).toBeNull()
    expect(resolver.resolve(mkEvent('s', { metaKey: true, altKey: true }), {})?.command).toBe('editor.save')
  })
})

describe('chord removal', () => {
  const withChords = (extra: KeybindingRule[]): KeyResolver =>
    new KeyResolver([
      { key: 'cmd+k cmd+s', command: 'workbench.openKeyboardShortcuts' },
      { key: 'cmd+k cmd+t', command: 'workbench.selectTheme' },
      ...extra,
    ])

  it('cancels one chord and leaves the other on the same prefix', () => {
    const resolver = withChords([{ key: 'cmd+k cmd+s', command: '-workbench.openKeyboardShortcuts' }])
    expect(resolver.resolve(mkEvent('k', { metaKey: true }), {})).toBeNull() // prefix still live
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), {})).toBeNull()

    expect(resolver.resolve(mkEvent('k', { metaKey: true }), {})).toBeNull()
    expect(resolver.resolve(mkEvent('t', { metaKey: true }), {})?.command).toBe('workbench.selectTheme')
  })

  it('releases the prefix once every chord on it is gone', () => {
    const resolver = withChords([
      { key: 'cmd+k cmd+s', command: '-workbench.openKeyboardShortcuts' },
      { key: 'cmd+k cmd+t', command: '-workbench.selectTheme' },
      { key: 'cmd+k', command: 'workbench.quickChat' },
    ])
    expect(resolver.resolve(mkEvent('k', { metaKey: true }), {})?.command).toBe('workbench.quickChat')
    expect(resolver.hasPendingChord()).toBe(false)
  })

  it('keeps the prefix reserved while any chord survives', () => {
    const resolver = withChords([
      { key: 'cmd+k cmd+s', command: '-workbench.openKeyboardShortcuts' },
      { key: 'cmd+k', command: 'workbench.quickChat' },
    ])
    expect(resolver.resolve(mkEvent('k', { metaKey: true }), {})).toBeNull()
    expect(resolver.hasPendingChord()).toBe(true)
  })

  it('a removal alone never turns its key into a chord prefix', () => {
    const resolver = new KeyResolver([{ key: 'cmd+k cmd+s', command: '-workbench.openKeyboardShortcuts' }])
    expect(resolver.resolve(mkEvent('k', { metaKey: true }), {})).toBeNull()
    expect(resolver.hasPendingChord()).toBe(false)
  })
})
