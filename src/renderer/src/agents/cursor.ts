/** Cursor CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'cursor',
  label: 'Cursor CLI',
  // Newer installs also ship the executable as `agent`; `cursor-agent` is the
  // less ambiguous name and still works. Users can override the command.
  defaultCommand: 'cursor-agent',
  // --force (official alias --yolo) auto-approves all commands
  skipPermissionFlag: '--force',
  resumeArgs: (id) => `--resume=${id}`,
  needsSessionMarker: true,
  turnEndInferredFromSilence: true,
  // Executable is `cursor-agent` (newer installs also ship `agent`);
  // accept both, `=` and space forms.
  resumeCommandPattern: /^(?:cursor-)?agent\s+--resume(?:=|\s+)\S+/,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
