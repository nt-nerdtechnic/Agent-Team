// Keys the central rule table does not own.
//
// Two families never reach KeyResolver, so they cannot be listed — let alone
// rebound — by the generated editor:
//
//   - terminal keys, which useTerminal intercepts and turns into control
//     sequences before the dispatcher ever sees them
//   - the Electron application menu, whose accelerators fire in the main
//     process ahead of the renderer
//
// They still have to be documented somewhere, so the editor renders them as
// read-only reference sections. Moved here verbatim from the old
// KeyboardShortcutsHelp page, which this replaces.

export interface ExternalKeyRow {
  /** Display glyphs, space-separated; '/' and '–' read as separators. */
  keys: string
  /** i18n key under settings.keybindings.reference.desc */
  desc: string
}

export const TERMINAL_KEYS: ExternalKeyRow[] = [
  { keys: '⇧ Enter', desc: 'newlineNoSend' },
  { keys: '⇧ ← / ⇧ →', desc: 'extendSelection' },
  { keys: '⌘ ⇧ ← / ⌘ ⇧ →', desc: 'selectToLineEdge' },
  { keys: '⌘ ← / ⌘ → / ⌘ Backspace', desc: 'lineNavAndClear' },
  { keys: '⌥ Backspace', desc: 'deleteWord' },
  { keys: '⌘', desc: 'cmdClickHover' },
]

// Accelerators owned by the application menu (src/main/menu.ts). Anything listed
// here fires in the main process before the renderer sees the key, so a binding
// for it in the editable table above would look changed but do nothing.
//
// The three app-defined entries are easy to miss when editing the menu — they
// are not Electron roles, so nothing else points at them: Settings… (menu.ts,
// CmdOrCtrl+,), New Window (CmdOrCtrl+N) and Open Workspace (CmdOrCtrl+O).
export const NATIVE_MENU_KEYS: ExternalKeyRow[] = [
  { keys: '⌘ ,', desc: 'menuSettings' },
  { keys: '⌘ N', desc: 'menuNewWindow' },
  { keys: '⌘ O', desc: 'menuOpenWorkspace' },
  { keys: '⌘ R', desc: 'reload' },
  { keys: '⌥ ⌘ I', desc: 'devTools' },
  { keys: '⌃ ⌘ F', desc: 'fullScreen' },
  { keys: '⌘ C / V / X / Z / A', desc: 'clipboard' },
  { keys: '⌘ W / ⌘ Q / ⌘ M', desc: 'windowControls' },
  { keys: '⌘ H / ⌥ ⌘ H', desc: 'hide' },
]

/**
 * Matcher-form specs for the menu accelerators that a rule in `defaults.ts` also
 * claims. Rebinding the *command* works; clearing the *key* does not, because
 * the menu fires first and the renderer never sees it. The editor flags these
 * caps so that promise is not made silently.
 *
 * Only these three overlap today — the rest of the menu (⌘R, ⌥⌘I, ⌘Q …) has no
 * counterpart in the rule table, so there is nothing to mislabel.
 */
export const MENU_OWNED_SPECS = new Set(['cmd+,', 'cmd+n', 'cmd+o'])

const SEPARATORS = new Set(['/', '–'])

export interface KeyToken {
  type: 'key' | 'sep'
  value: string
  /** True when this cap follows another cap and needs a '+' between them. */
  plus?: boolean
}

/** Splits a display string like '⌘ ⇧ ← / ⌘ ⇧ →' into caps and separators. */
export function splitKeyTokens(str: string): KeyToken[] {
  const out: KeyToken[] = []
  for (const tok of str.split(/\s+/).filter(Boolean)) {
    if (SEPARATORS.has(tok)) {
      out.push({ type: 'sep', value: tok })
    } else {
      const prev = out[out.length - 1]
      out.push({ type: 'key', value: tok, plus: prev?.type === 'key' })
    }
  }
  return out
}
