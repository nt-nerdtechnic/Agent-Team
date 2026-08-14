/** Cursor CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'cursor',
  label: 'Cursor CLI',
  // Official docs and the install script both use `agent`; `cursor-agent` is
  // the legacy symlink the installer still creates. Users can override the
  // command. (Cursor is not installed locally — sourced from
  // https://cursor.com/docs/cli/reference/parameters and https://cursor.com/install.)
  defaultCommand: 'agent',
  // --force (official alias --yolo) auto-approves all commands
  skipPermissionFlag: '--force',
  resumeArgs: (id) => `--resume=${id}`,
  needsSessionMarker: true,
  turnEndInferredFromSilence: true,
  // Executable is `agent` (the installer also creates the legacy
  // `cursor-agent`); accept both, `=` and space forms, so a command saved by
  // an older build still reads as a resume rather than a custom command.
  resumeCommandPattern: /^(?:cursor-)?agent\s+--resume(?:=|\s+)\S+/,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
