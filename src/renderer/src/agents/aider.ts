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
  // Aider has no session ids; its resume command is id-less. Resume is always
  // the lossy --restore-chat-history, reading the pane's chat-history file
  // when one is known (empty falls back to aider's default shared file).
  resumeWithoutId: (chatHistoryFile) =>
    [chatHistoryFile ? aiderChatHistoryFlag(chatHistoryFile) : '', '--restore-chat-history']
      .filter(Boolean)
      .join(' '),
  resumeCommandPattern: /^aider\b.*--restore-chat-history\b/,
  needsSessionMarker: true,
  hint: 'generalist'
} as const satisfies AgentSpec
