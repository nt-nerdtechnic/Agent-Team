// @vitest-environment happy-dom
// Labels for the Settings editor. Commands carry no metadata at their ~190
// registration sites, so these names are derived from the id — which only works
// while every shipped command id keeps the `<category>.<...>.<verbPhrase>`
// shape. The coverage test at the bottom is what catches an id that drifts out
// of it and would otherwise surface as a nonsense label in the UI.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMAND_IDS, commandI18nKey, describeCommand } from '../commandCatalog'
import { defaults } from '../defaults'

/** Every distinct command the shipped rules bind, described. */
function shippedCommands() {
  return [...new Set(defaults.map((r) => r.command))].map(describeCommand)
}

describe('describeCommand', () => {
  it('splits camelCase into words and drops the "action" noise segment', () => {
    expect(describeCommand('workbench.action.rebuildFocusedPane')).toEqual({
      id: 'workbench.action.rebuildFocusedPane',
      label: 'Rebuild Focused Pane',
      category: 'Workbench',
    })
  })

  it('separates a trailing digit', () => {
    expect(describeCommand('editor.foldLevel3').label).toBe('Fold Level 3')
  })

  it('uppercases known acronyms', () => {
    expect(describeCommand('controlPane.selectCliType1').label).toBe('Select CLI Type 1')
    expect(describeCommand('workbench.action.toggleAIChat').label).toBe('Toggle AI Chat')
    expect(describeCommand('workbench.action.openMiniIDE').label).toBe('Open Mini IDE')
  })

  it('maps known prefixes to a friendly category', () => {
    expect(describeCommand('git.stageAll').category).toBe('Git')
    expect(describeCommand('controlPane.selectCliType1').category).toBe('CLI Panes')
    expect(describeCommand('editor.fold').category).toBe('Editor')
  })

  it('honours an explicit override', () => {
    expect(describeCommand('workbench.action.showCommands').label).toBe('Show Command Palette')
    expect(describeCommand('editor.action.smartSelect.expand').label).toBe('Expand Selection')
  })

  it('falls back to the head segment for a single-segment id', () => {
    expect(describeCommand('reload').label).toBe('Reload')
  })

  it('handles an unknown namespace without throwing', () => {
    const info = describeCommand('plugin.someVendor.doThing')
    expect(info.category).toBe('Plugin')
    expect(info.label).toBe('Some Vendor Do Thing')
  })

  it('describes the empty command as unbound', () => {
    expect(describeCommand('').label).toBe('Unbound')
  })
})

describe('coverage over the shipped defaults', () => {
  it('describes every command the defaults bind', () => {
    const described = shippedCommands()
    expect(described).toHaveLength(new Set(defaults.map((r) => r.command)).size)
    expect(described.every((c) => c.id.length > 0)).toBe(true)
  })

  it('gives every command a non-empty label', () => {
    expect(shippedCommands().every((c) => c.label.trim().length > 0)).toBe(true)
  })

  it('produces labels that read as words, not as raw ids', () => {
    // A label still containing a dot means the id did not follow the shape the
    // humanizer assumes, and the UI would show something like "action.foo".
    expect(shippedCommands().filter((c) => c.label.includes('.'))).toEqual([])
  })

  it('assigns every command to one of the known categories', () => {
    const known = new Set(['Workbench', 'Editor', 'Git', 'CLI Panes', 'External Control'])
    const stray = shippedCommands().filter((c) => !known.has(c.category))
    expect(stray).toEqual([])
  })
})

// ── i18n titles ───────────────────────────────────────────────────────────────
describe('commandI18nKey', () => {
  it('flattens dots, which vue-i18n would read as a path', () => {
    expect(commandI18nKey('editor.action.save')).toBe('settings.keybindings.cmd.editor_action_save')
  })

  it('produces a unique key per command', () => {
    const keys = COMMAND_IDS.map(commandI18nKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('shipped locales cover every command title', () => {
  // Both files must carry a title for every manifest entry; the derived label
  // is only a fallback for a command added between releases.
  const load = (locale: string) =>
    JSON.parse(
      readFileSync(join(process.cwd(), `packages/plugin-ui-vue/src/foundation/i18n/locales/${locale}.json`), 'utf-8'),
    ).settings.keybindings.cmd as Record<string, string>

  for (const locale of ['en-US', 'zh-TW']) {
    it(`${locale} has a title for all ${COMMAND_IDS.length} commands`, () => {
      const cmd = load(locale)
      const missing = COMMAND_IDS.filter((id) => !cmd[id.replace(/\./g, '_')]?.trim())
      expect(missing).toEqual([])
    })

    it(`${locale} has no titles for commands that no longer exist`, () => {
      const known = new Set(COMMAND_IDS.map((id) => id.replace(/\./g, '_')))
      expect(Object.keys(load(locale)).filter((k) => !known.has(k))).toEqual([])
    })
  }

  it('zh-TW is actually translated, not a copy of the English', () => {
    const en = load('en-US')
    const zh = load('zh-TW')
    const identical = Object.keys(en).filter((k) => en[k] === zh[k])
    // A handful legitimately match (Commit, Fetch, Pull, Push…).
    expect(identical.length).toBeLessThan(10)
  })
})
