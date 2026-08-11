/** Pi — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'pi',
  label: 'Pi',
  defaultCommand: 'pi',
  // no skipPermissionFlag: pi has no permission system at all
  // (bash/edit tools execute directly, nothing to bypass)
  // Creates a NEW session when the id doesn't exist, resumes when it does.
  resumeArgs: (id) => `--session-id ${id}`,
  needsSessionMarker: true,
  turnEndInferredFromSilence: true,
  resumeCommandPattern: /^pi\s+--session-id\s+\S+/,
  supportsRebuild: true,
  // Restore-pin self-heals: `pi --session-id <id>` is documented as "Use exact
  // project session ID, creating it if missing", so a pin that never gets
  // replaced still resumes/claims a real session instead of dead-ending.
  supportsRestorePin: true,
  hint: 'generalist'
} as const satisfies AgentSpec
