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
}
