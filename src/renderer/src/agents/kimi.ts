/** Kimi Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kimi',
  label: 'Kimi Code',
  defaultCommand: 'kimi',
  skipPermissionFlag: '--yolo',
  // id is the `session_<uuid>` dir name.
  resumeArgs: (id) => `--session ${id}`,
  resumeCommandPattern: /^kimi\s+(?:--session|-s)\s+\S+/,
  // wire.jsonl carries no turn-end record: a turn is closed by the NEXT
  // turn.prompt, and the latest one only after an 8s quiet window
  // (_TURN_IDLE_MS in cli_vendors/kimi.py). The newest turn — the one the
  // messaging gate asks about — is therefore always silence-inferred.
  turnEndInferredFromSilence: true,
  needsSessionMarker: true,
  bracketedPaste: true,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
