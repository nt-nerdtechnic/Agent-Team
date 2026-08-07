/** Qwen Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'qwen',
  label: 'Qwen Code',
  defaultCommand: 'qwen',
  skipPermissionFlag: '--yolo',
  hint: 'generalist'
} as const satisfies AgentSpec
