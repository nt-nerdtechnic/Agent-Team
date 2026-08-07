/** Copilot CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'copilot',
  label: 'Copilot CLI',
  defaultCommand: 'copilot',
  // --yolo ≡ --allow-all-tools --allow-all-paths --allow-all-urls
  skipPermissionFlag: '--yolo',
  // NOTE the `=` form; creates a NEW session when the id doesn't exist.
  resumeArgs: (id) => `--resume=${id}`,
  needsSessionMarker: true,
  // The `=` form, which the generic --resume shape would not match.
  resumeCommandPattern: /^copilot\s+--resume(?:=|\s+)\S+/,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
