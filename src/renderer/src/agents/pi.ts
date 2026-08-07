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
  resumeCommandPattern: /^pi\s+--session-id\s+\S+/,
  supportsRebuild: true,
  hint: 'generalist'
} as const satisfies AgentSpec
