/** Codex — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'codex',
  label: 'Codex',
  defaultCommand: 'codex',
  skipPermissionFlag: '--dangerously-bypass-approvals-and-sandbox',
  // Subcommand, NOT a --flag.
  resumeArgs: (id) => `resume ${id}`,
  needsSessionMarker: true,
  resumeCommandPattern: /^codex\s+resume\s+\S+/,
  supportsRebuild: true,
  verifiedTurnText: true,
  bracketedPaste: true,
  shiftEnterSequence: '\x1b[13;2u',
  // Restore-pin self-heals: per-pane CODEX_HOME announces the new session.
  supportsRestorePin: true,
  // Codex's approval dialog. Detected from the screen rather than a hook on
  // purpose: Codex gates newly-installed hooks behind a trust screen the user
  // must clear on every pane (and again whenever the hook file changes), so
  // installing one would put an unexplained prompt in front of them just to
  // light a badge.
  //
  // Two anchors, either of which is enough: the question line ("Would you like
  // to run the following command? / make the following edits? / grant these
  // permissions?") and the last option of the list, which is the same for all
  // three dialogs. Both belong to the live dialog only — Codex draws in a
  // full-screen alt buffer, so answering repaints them away.
  awaitingInput: {
    pattern: /Would you like to (run|make|grant) |No, and tell Codex what to do differently/,
  },
  hint: 'implementer'
} as const satisfies AgentSpec
