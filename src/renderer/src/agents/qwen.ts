/** Qwen Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'qwen',
  label: 'Qwen Code',
  defaultCommand: 'qwen',
  skipPermissionFlag: '--yolo',
  resumeArgs: (id) => `--resume ${id}`,
  needsSessionMarker: true,
  turnEndInferredFromSilence: true,
  supportsRebuild: true,
  // Measured on a real PTY: the CLI itself emits `ESC[?1049h` during startup
  // (probe read 17768 bytes of startup output) and keeps the conversation there.
  fullScreenTui: true,
  hint: 'generalist'
} as const satisfies AgentSpec
