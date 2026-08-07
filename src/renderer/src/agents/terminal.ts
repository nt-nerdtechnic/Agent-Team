/** Terminal — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: 'terminal',
  label: 'Terminal',
  defaultCommand: '',
  hint: 'plain shell'
}
