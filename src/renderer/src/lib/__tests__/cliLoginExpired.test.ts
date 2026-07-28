import { describe, it, expect } from 'vitest'
import { matchLoginExpired, loginCommandFor } from '../cliLoginExpired'

// matchLoginExpired detects a CLI's expired-login error in a pane's buffer
// tail so App.vue can light the re-login badge. Only `claude` has a spec for
// now; unknown agentKeys must never match.

describe('lib/cliLoginExpired matchLoginExpired', () => {
  it('matches the real compaction-time expired-login message', () => {
    expect(
      matchLoginExpired('claude', 'Error during compaction: Login expired · Please run /login')
    ).toBe(true)
  })

  it('matches when the instruction phrase is hard-wrapped across a line', () => {
    // A narrow pane hard-wraps mid-phrase; cleanBuffer keeps that `\n`. The
    // matcher normalizes whitespace, so "Please run\n/login" still matches —
    // this is the regression the whitespace-normalize fix targets.
    expect(
      matchLoginExpired('claude', 'Login expired · Please run\n/login now')
    ).toBe(true)
  })

  it('does not match a bare "Login expired" with no "Please run /login"', () => {
    // Design tightened: keying on the instruction phrase avoids spuriously
    // matching the bare "Login expired" string in ordinary output / catted logs.
    expect(matchLoginExpired('claude', 'Login expired')).toBe(false)
  })

  it('does not match ordinary output', () => {
    expect(matchLoginExpired('claude', 'All tests passed, 42 files checked')).toBe(false)
  })

  it('does not match a user-typed bare "/login" (no "Please run" prefix)', () => {
    expect(matchLoginExpired('claude', '> /login')).toBe(false)
  })

  it('never matches for an agentKey without a spec', () => {
    expect(matchLoginExpired('codex', 'Login expired · Please run /login')).toBe(false)
    expect(matchLoginExpired('unknown-cli', 'Login expired')).toBe(false)
  })
})

describe('lib/cliLoginExpired loginCommandFor', () => {
  it('returns /login for claude', () => {
    expect(loginCommandFor('claude')).toBe('/login')
  })

  it('returns null for agentKeys without a spec', () => {
    expect(loginCommandFor('codex')).toBeNull()
    expect(loginCommandFor('unknown-cli')).toBeNull()
  })
})
