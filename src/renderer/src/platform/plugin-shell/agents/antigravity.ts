/** Antigravity CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'antigravity',
  label: 'Antigravity CLI',
  defaultCommand: 'agy',
  // agy validates both together and exits 1 on a bad value, naming the
  // three it accepts.
  modelArgs: (m) => `--model ${m}`,
  effortArgs: (e) => `--effort ${e}`,
  knownEfforts: ['low', 'medium', 'high'],
  skipPermissionFlag: '--dangerously-skip-permissions',
  resumeArgs: (id) => `--conversation ${id}`,
  needsSessionMarker: true,
  bracketedPaste: true,
  resumeCommandPattern: /^agy\s+--conversation\s+\S+/,
  supportsRebuild: true,
  // Measured on a real PTY (agy 1.1.13): the CLI itself emits `ESC[?1049h`
  // during startup and keeps the conversation there. The probe only read 82
  // bytes before the CLI settled, but the sequence appearing at all is
  // positive evidence — unlike a normal-buffer verdict, which needs enough
  // output to trust the absence.
  fullScreenTui: true,
  hint: 'generalist'
} as const satisfies AgentSpec
