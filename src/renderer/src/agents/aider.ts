/** Aider — per-vendor agent spec (see types.ts; assembled by index.ts). */

import { aiderChatHistoryFlag, aiderHistoryPath } from '../lib/aider-history'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'aider',
  label: 'Aider',
  defaultCommand: 'aider',
  // --yes-always auto-confirms every prompt (edits, shell commands, adds)
  skipPermissionFlag: '--yes-always',
  // Give every pane its own chat history: the default shared
  // `<git-root>/.aider.chat.history.md` merges all panes' token accounting.
  paneArg: (ctx) => aiderChatHistoryFlag(aiderHistoryPath(ctx.historyRoot, ctx.paneId)),
  hint: 'generalist'
} as const satisfies AgentSpec
