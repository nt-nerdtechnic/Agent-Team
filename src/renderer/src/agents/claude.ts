/** Claude Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'claude',
  label: 'Claude Code',
  defaultCommand: 'claude',
  skipPermissionFlag: '--dangerously-skip-permissions',
  resumeArgs: (id) => `--resume ${id}`,
  supportsRebuild: true,
  verifiedTurnText: true,
  bracketedPaste: true,
  // Measured on a real PTY: Claude Code emits `ESC[?1049h` within the first
  // dozen bytes of startup and keeps the conversation there.
  fullScreenTui: true,
  // Claude Code prints "Login expired · Please run /login" (also seen as
  // "Error during compaction: Login expired · Please run /login"). Require
  // BOTH "Login expired" and the nearby "Please run /login" instruction so
  // ordinary output that merely mentions the phrase (e.g. this very CLI's
  // assistant text discussing /login) can't spuriously match — the real error
  // always carries both, separated only by " · ". Tolerant of any whitespace
  // run between words (a narrow pane hard-wraps mid-phrase); a trailing
  // boundary after /login keeps "/login-helper" / "/login2" below the
  // threshold.
  loginExpired: {
    pattern: /login\s+expired.{0,40}?please run\s+\/login(?:\s|$)/i,
    loginCommand: '/login',
  },
  // Restore-pin self-heals: the turn event's attributed id is adopted directly.
  supportsRestorePin: true,
  // A fresh pane can name its own session instead of waiting for the log
  // reader to attribute one. `handwritten` recognizes an id the USER typed
  // into a custom command — Claude only accepts a UUID here, so a strict match
  // is the deterministic parse and anything else yields no pin.
  pinsSessionIdAtLaunch: {
    flag: '--session-id',
    handwritten:
      /--session-id[=\s]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9a-fA-F-])/,
  },
  // Sessions are attributed by encoded cwd, so a pane whose saved id left no
  // transcript can be repointed at a real session from the same workspace.
  supportsGhostReconnect: true,
  hint: 'planner + reviewer'
} as const satisfies AgentSpec
