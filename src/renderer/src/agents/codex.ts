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
  hint: 'implementer'
} as const satisfies AgentSpec
