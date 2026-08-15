/** OpenCode — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'opencode',
  label: 'OpenCode',
  defaultCommand: 'opencode',
  // Current opencode offers `--auto` ("auto-approve permissions that are not
  // explicitly denied") on BOTH the root TUI command and `opencode run`.
  // Older builds only carried it on `run` under the name
  // `--dangerously-skip-permissions` (verified on 1.15.12); that spelling has
  // since been dropped from the docs, so it is not used here. Those older
  // builds silently ignore an unknown root flag — `opencode --auto --version`
  // prints the version and exits 0 on 1.15.12 — so passing `--auto` is a
  // no-op there rather than a breakage.
  skipPermissionFlag: '--auto',
  // id is `ses_`-prefixed.
  resumeArgs: (id) => `--session ${id}`,
  needsSessionMarker: true,
  resumeCommandPattern: /^opencode\s+(?:--session|-s)\s+\S+/,
  supportsRebuild: true,
  // Measured on a real PTY: the CLI itself emits `ESC[?1049h` during startup
  // (probe read 8626 bytes of startup output) and keeps the conversation there.
  fullScreenTui: true,
  hint: 'generalist'
} as const satisfies AgentSpec
