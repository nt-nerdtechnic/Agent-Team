// Default-editor preference: which editor a file/folder open goes to.
//
// The decision itself lives in the main process (src/main/editors.ts) because
// that is where every open funnels through; this module owns the settings keys
// and the shapes the UI needs. The id list is duplicated across the two
// deliberately — each process validates what it reads rather than trusting the
// other to have written something sane.

export const DEFAULT_EDITOR_SETTING_KEY = 'agentTeam.defaultEditor'
export const DEFAULT_EDITOR_COMMAND_KEY = 'agentTeam.defaultEditor.customCommand'

export const DEFAULT_EDITOR_ID = 'mini-ide'

/** Editors the host implements directly — always selectable. */
export const HOST_EDITOR_IDS = ['mini-ide', 'system'] as const

/** Detected editors, in the order Settings lists them. */
export const DETECTABLE_EDITOR_IDS = ['vscode', 'cursor'] as const

export const KNOWN_EDITOR_IDS = [
  ...HOST_EDITOR_IDS,
  ...DETECTABLE_EDITOR_IDS,
  'custom'
] as const

export type EditorId = (typeof KNOWN_EDITOR_IDS)[number]

/** One row of the editor list main reports back. */
export interface DetectedEditor {
  id: string
  command: string
  available: boolean
}

/** Coerce a stored preference to a known id. Unknown/blank falls back to the
 *  mini-IDE, and `custom` needs a command before it means anything. */
export function normalizeDefaultEditor(raw: unknown, customCommand: readonly string[] = []): string {
  if (typeof raw !== 'string') return DEFAULT_EDITOR_ID
  const id = raw.trim()
  if (id === 'custom') return customCommand.length > 0 ? id : DEFAULT_EDITOR_ID
  return (KNOWN_EDITOR_IDS as readonly string[]).includes(id) ? id : DEFAULT_EDITOR_ID
}

/** Ready-made templates offered under the custom option. */
export const CUSTOM_COMMAND_PRESETS: { id: string; command: string[] }[] = [
  { id: 'vscode', command: ['code', '-g', '{file}:{line}'] },
  { id: 'cursor', command: ['cursor', '-g', '{file}:{line}'] },
  { id: 'sublime', command: ['subl', '{file}:{line}'] }
]

/**
 * Split a command line the user typed into argv.
 *
 * Whitespace separates arguments; double quotes group one. This is not a shell
 * — the argv is spawned directly, so quoting is only about where argument
 * boundaries are, never about escaping for a shell that never runs.
 */
export function parseCustomCommand(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) out.push(current)
  return out
}

/** Render argv back into an editable single line, re-quoting parts that
 *  contain whitespace so a round trip through parseCustomCommand is stable. */
export function formatCustomCommand(argv: readonly string[]): string {
  return argv.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')
}
