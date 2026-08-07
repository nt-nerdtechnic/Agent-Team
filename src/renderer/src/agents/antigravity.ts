/** Antigravity CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'antigravity',
  label: 'Antigravity CLI',
  defaultCommand: 'agy',
  skipPermissionFlag: '--dangerously-skip-permissions',
  resumeArgs: (id) => `--conversation ${id}`,
  needsSessionMarker: true,
  resumeCommandPattern: /^agy\s+--conversation\s+\S+/,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
