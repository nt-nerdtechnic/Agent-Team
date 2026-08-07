/** Kimi Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kimi',
  label: 'Kimi Code',
  defaultCommand: 'kimi',
  skipPermissionFlag: '--yolo',
  // id is the `session_<uuid>` dir name.
  resumeArgs: (id) => `--session ${id}`,
  resumeCommandPattern: /^kimi\s+(?:--session|-s)\s+\S+/,
  needsSessionMarker: true,
  bracketedPaste: true,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
