/** Kilo Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kilo',
  label: 'Kilo Code',
  defaultCommand: 'kilo',
  // A fork of opencode, confirmed in its source (Kilo-Org/kilocode, MIT): the
  // root command declares `-m, --model` itself (cli/cmd/tui.ts:148) and the
  // value reaches the TUI (tui.ts:503) which parses and applies it
  // (tui/src/app.tsx:501-510). kilo goes further than upstream — it writes the
  // CLI value into `override`, the highest-priority slot (context/local.tsx
  // :202-206, :285-296), so the flag beats a model pinned in agent config,
  // where opencode's only lands in `fallbackModel`.
  //
  // Values must be `provider/model`; a string without a slash, or a model
  // outside a configured provider, is reported in a three-second toast and
  // then IGNORED — the run continues on the default. So a wrong id here
  // degrades quietly at the vendor's end, which is beyond what refusing an
  // unsupported vendor can protect against.
  //
  // `--variant` (its effort equivalent) exists only on `kilo run`; the root
  // command's option list has no such entry, and even `--mini` hardcodes
  // `variant: undefined` (cli/cmd/run.ts:1225).
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
