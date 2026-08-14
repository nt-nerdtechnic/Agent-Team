/** Grok CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'grok',
  label: 'Grok CLI',
  defaultCommand: 'grok',
  // no skipPermissionFlag: grok-cli has no tool-confirmation gate at all
  // Short flag; 12-hex session id.
  resumeArgs: (id) => `-s ${id}`,
  needsSessionMarker: true,
  bracketedPaste: true,
  resumeCommandPattern: /^grok\s+-s\s+\S+/,
  supportsRebuild: true,
  // The log has no turn-end record. The reader does emit turn_complete, but
  // only after its own 8s quiet window (_TURN_IDLE_SECONDS in cli_vendors/
  // grok.py) — inference one layer down, which is exactly what this flag
  // means. Matches qwen/pi, whose readers work the same way.
  turnEndInferredFromSilence: true,
  hint: 'generalist'
} as const satisfies AgentSpec
