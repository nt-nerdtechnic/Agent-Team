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
  hint: 'generalist'
} as const satisfies AgentSpec
