/**
 * CONTRIBUTOR TEMPLATE — copy to `<your_key>.ts` and fill in, then register
 * the SPEC in `index.ts` (one line, display order). Files starting with `_`
 * are never registered. Full guide: docs/adding-a-cli-vendor.md.
 */

import type { AgentSpec } from './types'

// `as const satisfies` — NOT `: AgentSpec`. The annotation would widen
// agentKey to `string`, and index.ts derives the AgentKey union from these
// literals: one annotated spec collapses the union for the whole app.
export const SPEC = {
  agentKey: '_template', // must match the filename
  label: 'Human Name',
  defaultCommand: 'mycli',
  // skipPermissionFlag: '--yolo',      // unattended-mode flag, if the CLI has one
  // paneArg: (ctx) => '...',           // per-pane argument, if state must be split
  // ── Session resume (see types.ts for full field docs) ──
  // resumeArgs: (id) => `--resume ${id}`,  // args only; binary = defaultCommand
  // resumeCommandPattern: /^mycli\s+--resume\s+\S+/, // only if non-generic shape
  // resumeWithoutId: (file) => '...',  // id-less vendors only (see aider)
  // supportsRebuild: true,
  // supportsRestorePin: true,
  // needsSessionMarker: true,          // true for every CLI that can't pin an id at launch
  // ── Turn signals ──
  // turnEndInferredFromSilence: true,  // ONLY if the log has no turn-end record
  // verifiedTurnText: true,            // ONLY after validating against real sessions
  // ── Terminal input protocol ──
  // bracketedPaste: true,
  // shiftEnterSequence: '\x1b[13;2u',  // only if bracketed-LF default won't do
  // ── Recovery ──
  // loginExpired: { pattern: /.../i, loginCommand: '/login' },
  hint: 'generalist'
} as const satisfies AgentSpec
