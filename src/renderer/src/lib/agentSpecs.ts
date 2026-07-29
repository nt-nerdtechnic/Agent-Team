/**
 * agentSpecs.ts
 *
 * Canonical list of CLI agent specs, shared between the main window
 * (App.vue spawn UI) and the plan window (execute-dispatch agent picker).
 * Shape mirrors the `AgentSpec` interface in components/ControlPane.vue
 * (structurally identical so either import site typechecks).
 */

import { aiderChatHistoryFlag, aiderHistoryPath } from './aider-history'

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
  skipPermissionFlag?: string
  /** Argument computed per pane, inserted between the base command and
   *  skipPermissionFlag. Only aider defines one (its private chat-history
   *  file); no other CLI shares state across panes by default. */
  paneArg?: (ctx: PaneArgContext) => string
  hint?: string
}

// skipPermissionFlag: CLI-specific flag that bypasses interactive permission /
// trust prompts so the agent runs unattended. Appended automatically when the
// user enables YOLO mode (default) and hasn't supplied a custom command.
export const AGENT_SPECS: AgentSpec[] = [
  {
    agentKey: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    skipPermissionFlag: '--dangerously-skip-permissions',
    hint: 'planner + reviewer'
  },
  {
    agentKey: 'codex',
    label: 'Codex',
    defaultCommand: 'codex',
    skipPermissionFlag: '--dangerously-bypass-approvals-and-sandbox',
    hint: 'implementer'
  },
  {
    agentKey: 'antigravity',
    label: 'Antigravity CLI',
    defaultCommand: 'agy',
    skipPermissionFlag: '--dangerously-skip-permissions',
    hint: 'generalist'
  },
  {
    agentKey: 'grok',
    label: 'Grok CLI',
    defaultCommand: 'grok',
    // no skipPermissionFlag: grok-cli has no tool-confirmation gate at all
    hint: 'generalist'
  },
  {
    agentKey: 'kimi',
    label: 'Kimi Code',
    defaultCommand: 'kimi',
    skipPermissionFlag: '--yolo',
    hint: 'generalist'
  },
  {
    agentKey: 'opencode',
    label: 'OpenCode',
    defaultCommand: 'opencode',
    // no skipPermissionFlag: the opencode TUI has no permission-bypass flag
    // (only the `opencode run` subcommand does)
    hint: 'generalist'
  },
  {
    agentKey: 'qwen',
    label: 'Qwen Code',
    defaultCommand: 'qwen',
    skipPermissionFlag: '--yolo',
    hint: 'generalist'
  },
  {
    agentKey: 'kilo',
    label: 'Kilo Code',
    defaultCommand: 'kilo',
    // no skipPermissionFlag: the kilo TUI has no permission-bypass flag
    // (only the `kilo run` headless subcommand has `--auto`)
    hint: 'generalist'
  },
  {
    agentKey: 'pi',
    label: 'Pi',
    defaultCommand: 'pi',
    // no skipPermissionFlag: pi has no permission system at all
    // (bash/edit tools execute directly, nothing to bypass)
    hint: 'generalist'
  },
  {
    agentKey: 'copilot',
    label: 'Copilot CLI',
    defaultCommand: 'copilot',
    // --yolo ≡ --allow-all-tools --allow-all-paths --allow-all-urls
    skipPermissionFlag: '--yolo',
    hint: 'generalist'
  },
  {
    agentKey: 'cursor',
    label: 'Cursor CLI',
    // Newer installs also ship the executable as `agent`; `cursor-agent` is the
    // less ambiguous name and still works. Users can override the command.
    defaultCommand: 'cursor-agent',
    // --force (official alias --yolo) auto-approves all commands
    skipPermissionFlag: '--force',
    hint: 'generalist'
  },
  {
    agentKey: 'aider',
    label: 'Aider',
    defaultCommand: 'aider',
    // --yes-always auto-confirms every prompt (edits, shell commands, adds)
    skipPermissionFlag: '--yes-always',
    // Give every pane its own chat history: the default shared
    // `<git-root>/.aider.chat.history.md` merges all panes' token accounting.
    paneArg: (ctx) => aiderChatHistoryFlag(aiderHistoryPath(ctx.historyRoot, ctx.paneId)),
    hint: 'generalist'
  },
  {
    agentKey: 'terminal',
    label: 'Terminal',
    defaultCommand: '',
    hint: 'plain shell'
  }
]

/** Specs that are real CLI agents (excludes the plain-shell terminal entry). */
export const CLI_AGENT_SPECS: AgentSpec[] = AGENT_SPECS.filter((s) => s.agentKey !== 'terminal')
