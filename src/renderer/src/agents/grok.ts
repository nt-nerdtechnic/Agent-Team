/** Grok CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'grok',
  label: 'Grok CLI',
  defaultCommand: 'grok',
  // no skipPermissionFlag: grok-cli has no per-tool confirmation gate, so
  // there is no flag to bypass. It does ask once per workspace whether to run
  // shell commands sandboxed or on the host (answer stored in
  // ~/.grok/workspace-trust.json); `--sandbox` / `--no-sandbox` answer that
  // ahead of time, but they are a sandbox choice, not a permission bypass.
  // Short flag; 12-hex session id.
  resumeArgs: (id) => `-s ${id}`,
  // The log has no turn-end record. The reader does emit turn_complete, but
  // only after its own 8s quiet window (_TURN_IDLE_SECONDS in cli_vendors/
  // grok.py) — inference one layer down, which is exactly what this flag
  // means. Matches qwen/pi, whose readers work the same way.
  turnEndInferredFromSilence: true,
  needsSessionMarker: true,
  bracketedPaste: true,
  resumeCommandPattern: /^grok\s+-s\s+\S+/,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
