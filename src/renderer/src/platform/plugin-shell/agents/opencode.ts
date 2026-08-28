/** OpenCode — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'opencode',
  label: 'OpenCode',
  defaultCommand: 'opencode',
  // No skipPermissionFlag: the opencode TUI has no permission-bypass flag —
  // only the `opencode run` subcommand does, as `--dangerously-skip-permissions`
  // (still listed under `opencode run --help` on 1.15.12).
  //
  // `--auto` was declared here once on the claim that an older build ignores an
  // unknown root flag, "verified" with `opencode --auto --version`. That probe
  // proves nothing: `--version` short-circuits inside yargs before unknown
  // arguments are ever checked. Re-measured on 1.15.12 without it, the root
  // command REJECTS the flag — `opencode --auto models` prints the help banner
  // and exits 1, while bare `opencode models` exits 0 — so a YOLO-mode pane
  // spawned `opencode --auto ...`, never reached the TUI, and died on startup.
  // id is `ses_`-prefixed.
  resumeArgs: (id) => `--session ${id}`,
  needsSessionMarker: true,
  resumeCommandPattern: /^opencode\s+(?:--session|-s)\s+\S+/,
  supportsRebuild: true,
  // Measured on a real PTY: the CLI itself emits `ESC[?1049h` during startup
  // (probe read 8626 bytes of startup output) and keeps the conversation there.
  fullScreenTui: true,
  // The pane is spawned with a port and a message is appended to the composer
  // and submitted over it. `holdsInputBox` because that is literally what
  // `/tui/append-prompt` does — verified on 1.15.12, repeated calls concatenate
  // into the same composer — so a half-written line still has to be protected.
  pushChannel: { kind: 'tui-http', holdsInputBox: true },
  hint: 'generalist'
} as const satisfies AgentSpec
