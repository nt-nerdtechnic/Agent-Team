/** Claude Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: 'claude',
  label: 'Claude Code',
  defaultCommand: 'claude',
  skipPermissionFlag: '--dangerously-skip-permissions',
  hint: 'planner + reviewer'
}
