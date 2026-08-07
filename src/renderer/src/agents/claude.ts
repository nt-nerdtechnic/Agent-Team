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
  hint: 'planner + reviewer'
} as const satisfies AgentSpec
