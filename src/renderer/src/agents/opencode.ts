/** OpenCode — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'opencode',
  label: 'OpenCode',
  defaultCommand: 'opencode',
  // no skipPermissionFlag: the opencode TUI has no permission-bypass flag
  // (only the `opencode run` subcommand does)
  hint: 'generalist'
} as const satisfies AgentSpec
