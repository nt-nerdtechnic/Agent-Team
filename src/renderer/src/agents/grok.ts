/** Grok CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'grok',
  label: 'Grok CLI',
  defaultCommand: 'grok',
  // no skipPermissionFlag: grok-cli has no tool-confirmation gate at all
  // Short flag; 12-hex session id.
  resumeArgs: (id) => `-s ${id}`,
  resumeCommandPattern: /^grok\s+-s\s+\S+/,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
