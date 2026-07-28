// Per-CLI detection of expired-login messages in a pane's clean PTY output,
// plus the login command to send into the CLI to recover. Extend the table as
// other CLIs' expired-login messages are identified — only `claude` for now.

interface LoginExpiredSpec {
  /** Matches the CLI's login-expired error in a buffer tail slice. */
  pattern: RegExp
  /** Command typed into the CLI to start a re-login. */
  loginCommand: string
}

const LOGIN_EXPIRED_SPECS: Record<string, LoginExpiredSpec> = {
  // Claude Code prints "Login expired · Please run /login" (also seen as
  // "Error during compaction: Login expired · Please run /login"). Key on the
  // "Please run /login" instruction phrase — tolerant of any whitespace run
  // between the words (a narrow pane hard-wraps mid-phrase) — so a bare
  // "Login expired" in ordinary output / catted logs and a user-typed bare
  // "/login" both stay below the match threshold.
  claude: { pattern: /please run\s+\/login/i, loginCommand: '/login' },
}

/** True when `tail` contains agentKey's login-expired message. Always false
 *  for CLIs without a spec in the table. */
export function matchLoginExpired(agentKey: string, tail: string): boolean {
  const spec = LOGIN_EXPIRED_SPECS[agentKey]
  // Collapse whitespace runs to a single space before matching (mirrors
  // matchSessionLimit): cleanBuffer keeps the TUI hard-wrap `\n` a narrow pane
  // inserts mid-phrase, so an unnormalized "Please run\n/login" never matches.
  return spec !== undefined && spec.pattern.test(tail.replace(/\s+/g, ' '))
}

/** The login command to send into agentKey's pane, or null when the CLI has
 *  no spec in the table. */
export function loginCommandFor(agentKey: string): string | null {
  return LOGIN_EXPIRED_SPECS[agentKey]?.loginCommand ?? null
}
