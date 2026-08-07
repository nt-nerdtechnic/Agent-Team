/**
 * CONTRIBUTOR TEMPLATE — copy to `<your_key>.ts` and fill in, then register
 * the SPEC in `index.ts` (one line, display order). Files starting with `_`
 * are never registered. Full guide: docs/adding-a-cli-vendor.md.
 */

import type { AgentSpec } from './types'

export const SPEC: AgentSpec = {
  agentKey: '_template', // must match the filename
  label: 'Human Name',
  defaultCommand: 'mycli',
  // skipPermissionFlag: '--yolo',      // unattended-mode flag, if the CLI has one
  // paneArg: (ctx) => '...',           // per-pane argument, if state must be split
  hint: 'generalist'
}
