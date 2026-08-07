/** Grok CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: 'grok',
  label: 'Grok CLI',
  defaultCommand: 'grok',
  // no skipPermissionFlag: grok-cli has no tool-confirmation gate at all
  hint: 'generalist'
}
