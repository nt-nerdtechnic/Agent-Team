/** Kimi Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kimi',
  label: 'Kimi Code',
  defaultCommand: 'kimi',
  skipPermissionFlag: '--yolo',
  hint: 'generalist'
} as const satisfies AgentSpec
