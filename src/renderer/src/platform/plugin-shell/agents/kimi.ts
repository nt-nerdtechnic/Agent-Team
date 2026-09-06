/** Kimi Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kimi',
  label: 'Kimi Code',
  defaultCommand: 'kimi',
  // Effort lives in ~/.kimi-code/config.toml ([thinking] effort) and an
  // invalid value is silently clamped there, so it is not exposed here.
  modelArgs: (m) => `--model ${m}`,
  skipPermissionFlag: '--yolo',
  // id is the `session_<uuid>` dir name.
  resumeArgs: (id) => `--session ${id}`,
  // Short flag is uppercase `-S` (verified with `kimi --help`); kimi does not
  // accept a lowercase `-s`, so it is not matched here.
  resumeCommandPattern: /^kimi\s+(?:--session|-S)\s+\S+/,
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
