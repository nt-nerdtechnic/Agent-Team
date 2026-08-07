/** Pi — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: 'pi',
  label: 'Pi',
  defaultCommand: 'pi',
  // no skipPermissionFlag: pi has no permission system at all
  // (bash/edit tools execute directly, nothing to bypass)
  hint: 'generalist'
}
