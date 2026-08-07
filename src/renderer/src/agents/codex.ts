/** Codex — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'codex',
  label: 'Codex',
  defaultCommand: 'codex',
  skipPermissionFlag: '--dangerously-bypass-approvals-and-sandbox',
  hint: 'implementer'
} as const satisfies AgentSpec
