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
  // "Error during compaction: Login expired"). A bare "/login" typed by the
  // user must NOT match — only the "Please run" phrasing or "Login expired".
  claude: { pattern: /Login expired|Please run \/login/i, loginCommand: '/login' },
}

/** True when `tail` contains agentKey's login-expired message. Always false
 *  for CLIs without a spec in the table. */
export function matchLoginExpired(agentKey: string, tail: string): boolean {
  const spec = LOGIN_EXPIRED_SPECS[agentKey]
  return spec !== undefined && spec.pattern.test(tail)
}

/** The login command to send into agentKey's pane, or null when the CLI has
 *  no spec in the table. */
export function loginCommandFor(agentKey: string): string | null {
  return LOGIN_EXPIRED_SPECS[agentKey]?.loginCommand ?? null
}
