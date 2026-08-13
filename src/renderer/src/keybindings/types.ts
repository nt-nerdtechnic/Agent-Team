export interface ParsedKey {
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string // normalized lowercase, e.g. 's', 'escape', 'arrowup'
}

export interface KeybindingRule {
  key: string     // e.g. "cmd+s" or chord "ctrl+k ctrl+s"
  // e.g. "editor.action.save". A leading '-' makes the rule a REMOVAL: it
  // cancels the rule that binds that same key to that same command, instead of
  // adding a binding. Removals are surgical on purpose — blanking a key
  // wholesale would also kill the other commands that share it under a
  // different `when` (cmd+shift+g is both focusSourceControl and openGitWindow).
  command: string
  when?: string   // e.g. "editorTextFocus && !modalOpen"
  args?: unknown
}

export function isRemovalRule(rule: KeybindingRule): boolean {
  return rule.command.startsWith('-') && rule.command.length > 1
}

export function removalTarget(rule: KeybindingRule): string {
  return rule.command.slice(1)
}

// Widened to `unknown` (rather than `void`) so invokeCommand can hand a
// handler's return value back to its caller; existing void/Promise<void>
// handlers remain valid since void is assignable to unknown.
export type CommandHandler = (args?: unknown) => unknown | Promise<unknown>
