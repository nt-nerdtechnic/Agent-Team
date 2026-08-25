/** Terminal — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'terminal',
  label: 'Terminal',
  defaultCommand: '',
  hint: 'plain shell'
} as const satisfies AgentSpec
