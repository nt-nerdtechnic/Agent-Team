/** Kilo Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kilo',
  label: 'Kilo Code',
  defaultCommand: 'kilo',
  // no skipPermissionFlag: the kilo TUI has no permission-bypass flag
  // (only the `kilo run` headless subcommand has `--auto`)
  hint: 'generalist'
} as const satisfies AgentSpec
