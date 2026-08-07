/** Claude Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'claude',
  label: 'Claude Code',
  defaultCommand: 'claude',
  skipPermissionFlag: '--dangerously-skip-permissions',
  resumeArgs: (id) => `--resume ${id}`,
  supportsRebuild: true,
  verifiedTurnText: true,
  bracketedPaste: true,
  // Restore-pin self-heals: the turn event's attributed id is adopted directly.
  supportsRestorePin: true,
  hint: 'planner + reviewer'
} as const satisfies AgentSpec
