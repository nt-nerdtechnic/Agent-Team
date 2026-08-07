/** Antigravity CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: 'antigravity',
  label: 'Antigravity CLI',
  defaultCommand: 'agy',
  skipPermissionFlag: '--dangerously-skip-permissions',
  hint: 'generalist'
}
