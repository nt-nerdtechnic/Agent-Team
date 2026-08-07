/**
 * Shared types for the per-vendor agent specs (one file per vendor in this
 * directory; `index.ts` assembles them). Kept separate from index.ts so a
 * vendor file never imports the assembler (no cycles).
 */

/** Inputs a spec's `paneArg` is computed from. */
export interface PaneArgContext {
  /** Pane UUID — the identity the per-pane file is named after. */
  paneId: string
  /** Directory the pane's per-pane files live in: its git root, else its cwd. */
  historyRoot: string
}

export interface AgentSpec {
  agentKey: string
  label: string
  defaultCommand: string
  /** CLI-specific flag that bypasses interactive permission / trust prompts
   *  so the agent runs unattended. Appended automatically when the user
   *  enables YOLO mode (default) and hasn't supplied a custom command. */
  skipPermissionFlag?: string
  /** Argument computed per pane, inserted between the base command and
   *  skipPermissionFlag. Only aider defines one (its private chat-history
   *  file); no other CLI shares state across panes by default. */
  paneArg?: (ctx: PaneArgContext) => string
  hint?: string
  /** Vendor resume arguments WITHOUT the binary (the binary comes from
   *  `defaultCommand`, or the caller's custom command override) — e.g.
   *  `resume <id>` (codex subcommand) or `--resume=<id>`. Undefined = the
   *  vendor cannot resume by id (aider's lossy restore is special-cased in
   *  buildResumeCommand). */
  resumeArgs?: (sessionId: string) => string
  /** This CLI's logs carry no end-of-turn record at all, so the end of a turn
   *  can only be inferred from silence. Everything else reports turn ends
   *  explicitly and MUST be trusted instead: activity is logged per output
   *  line, not as a heartbeat, so a CLI waiting on a long tool call — or on a
   *  permission prompt — looks exactly like a CLI that has finished. Inferring
   *  from silence there would inject text and a newline into a pane that is
   *  mid-task, and into a y/n prompt would answer it. */
  turnEndInferredFromSilence?: boolean
  /** Detection of this CLI's expired-login message in a pane's clean PTY
   *  output, plus the command typed into the CLI to recover. Undefined = the
   *  CLI's expired-login message has not been identified yet (only claude's
   *  has). Matching runs on a whitespace-collapsed buffer tail — see
   *  lib/cliLoginExpired.ts. */
  loginExpired?: {
    /** Matches the CLI's login-expired error in a buffer tail slice. */
    pattern: RegExp
    /** Command typed into the CLI to start a re-login. */
    loginCommand: string
  }
  /** This vendor's TUI keeps bracketed paste on. Enables chunked clipboard
   *  paste wrapping AND serves as the default Shift+Enter encoding (bracketed
   *  LF inserts a literal newline without submitting). */
  bracketedPaste?: boolean
  /** Explicit Shift+Enter byte sequence when the vendor prefers something
   *  other than the bracketed-paste LF default (codex: CSI-u modified Enter).
   *  There is no vendor-neutral byte sequence for a modified Enter key in a
   *  traditional PTY — see encodeShiftEnter(). */
  shiftEnterSequence?: string
  /** Fresh (non-resume, non-login) panes embed an `at-pane:<paneId>` marker
   *  in this vendor's kickoff so the backend can match the resulting CLI
   *  session file back to the pane (these CLIs can't pin a session id at
   *  launch). Claude needs no marker: its sessions are attributed by encoded
   *  cwd instead. */
  needsSessionMarker?: boolean
  /** This vendor's log reader carries turn text that has been validated
   *  against real sessions, so turn-text judging (sentinel detection etc.) is
   *  authoritative and the loose in-buffer scan is skipped. Deliberately
   *  conservative: copilot, aider, kimi, qwen, pi and grok carry turn text too
   *  — enough for inter-CLI messaging, which only needs the text — but their
   *  readers have not been validated against real sessions, and for qwen/pi/
   *  grok the turn boundary is inferred from silence rather than read from a
   *  record. They stay unflagged and keep the buffer scan until that
   *  verification happens. */
  verifiedTurnText?: boolean
  /** Recognizes a saved command as this vendor's resume invocation (so a
   *  restore doesn't replay it as a user-custom base command). Undefined =
   *  the generic `<agentKey> --resume <id>` shape. */
  resumeCommandPattern?: RegExp
  /** Builds this vendor's ID-LESS resume arguments (aider: the lossy
   *  `--restore-chat-history`, optionally pointed at the pane's own
   *  chat-history file). Mutually exclusive with resumeArgs;
   *  buildResumeCommand ignores the session id when this is set. */
  resumeWithoutId?: (chatHistoryFile: string) => string
  /** Panes can be re-spawned via the vendor's resume command. */
  supportsRebuild?: boolean
  /** A restore may keep the SAVED session id pinned so Rebuild stays enabled
   *  (only vendors whose stale pin reliably self-heals — see resume-command). */
  supportsRestorePin?: boolean
}
