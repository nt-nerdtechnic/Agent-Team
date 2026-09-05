/** Kilo Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kilo',
  label: 'Kilo Code',
  defaultCommand: 'kilo',
  // A fork of opencode with the same root-level `-m, --model` and the same
  // `provider/model` shape; taken from its --help rather than its source, so
  // it is the one model claim here not confirmed at the implementation
  // level. `--variant` (its effort equivalent) exists only on `kilo run`.
  modelArgs: (m) => `--model ${m}`,
  // `--auto` ("auto-approve permissions that are not explicitly denied
  // (dangerous!)") is listed on both the root TUI command and `kilo run`
  // (verified on 7.4.21).
  skipPermissionFlag: '--auto',
  // id is `ses_`-prefixed (OpenCode fork).
  resumeArgs: (id) => `--session ${id}`,
  needsSessionMarker: true,
  resumeCommandPattern: /^kilo\s+(?:--session|-s)\s+\S+/,
  supportsRebuild: true,
  // Measured on a real PTY: the CLI itself emits `ESC[?1049h` during startup
  // (probe read 11490 bytes of startup output) and keeps the conversation there.
  fullScreenTui: true,
  // Same `/tui/*` channel as OpenCode (its upstream), password-protected here.
  pushChannel: { kind: 'tui-http', holdsInputBox: true },
  hint: 'generalist'
} as const satisfies AgentSpec
