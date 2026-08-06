export interface ParsedKey {
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string // normalized lowercase, e.g. 's', 'escape', 'arrowup'
}

export interface KeybindingRule {
  key: string     // e.g. "cmd+s" or chord "ctrl+k ctrl+s"
  command: string // e.g. "editor.action.save"
  when?: string   // e.g. "editorTextFocus && !modalOpen"
  args?: unknown
}

// Widened to `unknown` (rather than `void`) so invokeCommand can hand a
// handler's return value back to its caller; existing void/Promise<void>
// handlers remain valid since void is assignable to unknown.
export type CommandHandler = (args?: unknown) => unknown | Promise<unknown>
