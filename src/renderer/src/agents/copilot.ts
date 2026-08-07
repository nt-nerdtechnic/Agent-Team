/** Copilot CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: 'copilot',
  label: 'Copilot CLI',
  defaultCommand: 'copilot',
  // --yolo ≡ --allow-all-tools --allow-all-paths --allow-all-urls
  skipPermissionFlag: '--yolo',
  hint: 'generalist'
}
