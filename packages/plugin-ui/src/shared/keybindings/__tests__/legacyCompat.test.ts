// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { parseUserRules } from '../customization'
import { KeyResolver } from '../keyResolver'
import { defaults } from '../defaults'

const mk = (key: string, o: Record<string, unknown> = {}) =>
  new KeyboardEvent('keydown', { key, ...o })

// Files written before this change contained only plain additions. They must
// keep working untouched — an upgrade that silently drops a user's overrides
// would be the worst possible regression.
describe('backward compatibility with pre-existing keybindings.json', () => {
  it('loads a legacy plain-addition file', () => {
    const { rules, dropped } = parseUserRules(
      '[{"key":"cmd+alt+s","command":"editor.action.save","when":"editorOpen"}]',
    )
    expect(dropped).toBe(0)
    const r = new KeyResolver([...defaults, ...rules])
    expect(r.resolve(mk('s', { metaKey: true, altKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.save')
  })

  it('a legacy override still beats the shipped default', () => {
    const { rules } = parseUserRules('[{"key":"cmd+p","command":"custom.thing"}]')
    const r = new KeyResolver([...defaults, ...rules])
    expect(r.resolve(mk('p', { metaKey: true }), {})?.command).toBe('custom.thing')
  })

  it('an empty legacy file is a no-op', () => {
    expect(parseUserRules('[]')).toEqual({ rules: [], dropped: 0 })
  })

  it('every shipped default still resolves with an empty user file', () => {
    const r = new KeyResolver([...defaults])
    expect(r.resolve(mk('P', { metaKey: true, shiftKey: true }), {})?.command)
      .toBe('workbench.action.showCommands')
    expect(r.resolve(mk('s', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.save')
  })
})
