// Frontend mirror of the backend's known capability surface. Maps a plugin's
// `(ns, method)` capability call to the backend WebSocket message `type`, and
// declares which server-push events the broker forwards to plugins (and the ns
// that gates each). Pure data + pure functions so it is unit-testable and
// electron-free. Keep this in sync with the backend `ws_handlers.py` @handler
// names as capabilities are added.
//
// CAP_MAP is the exact inverse of the mini-IDE shim's `TYPE_TO_CAP`
// (src/renderer/plugins/mini-ide/capabilityBackend.ts): the shim turns a WS
// `type` into a `(ns, method)` capability address, and this map turns that
// address back into the backend WS `type` the broker dispatches. The two live
// in different builds (electron-main here, Vue renderer there) so they cannot
// share a module — capabilityMap.test.ts cross-checks that they stay inverses.

/** Build `{ "<ns>.<method>": "<ns>.<method>" }` for a namespace whose backend WS
 *  types are exactly `"<ns>.<method>"` (fs / git / search / issues — the uniform
 *  namespaces the shim splits on the dotted method). */
function uniformNs(ns: string, methods: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const method of methods) out[`${ns}.${method}`] = `${ns}.${method}`
  return out
}

// fs capability methods → backend `fs.<method>` one-for-one. `stat_path` backs
// the embedded CLI dock's @-mention existence probe (useTerminal).
const FS_METHODS = [
  'read_file', 'write_file', 'list_dir', 'list_files_flat', 'glob_files',
  'create_file', 'delete', 'mkdir', 'rename', 'convert_office', 'list_archive',
  'read_image', 'stat_path',
] as const

// git capability methods → backend `git.<method>` one-for-one.
const GIT_METHODS = [
  'status', 'log', 'diff_branches', 'rebase', 'restore_from_branch', 'show_commit',
  'worktrees', 'add_worktree', 'remove_worktree', 'prune_worktrees', 'lock_worktree',
  'unlock_worktree', 'move_worktree', 'repair_worktrees', 'config_set', 'config_get',
  'blame', 'tags', 'create_tag', 'delete_tag', 'cherry_pick', 'file_log', 'show_file',
  'resolve_ours', 'resolve_theirs', 'remotes', 'diff_file', 'diff_blame', 'merge',
  'merge_into', 'revert', 'add_remote', 'remove_remote', 'branches', 'stash_list',
  'fetch', 'pull', 'push', 'create_branch', 'switch_branch', 'checkout_remote_branch',
  'checkout_commit', 'commit_file_diff', 'delete_branch', 'stash', 'stash_pop',
  'stash_drop', 'amend', 'undo_commit', 'apply_patch', 'clone', 'check_ignore', 'abort',
  'stash_apply', 'pull_rebase', 'push_force', 'push_upstream', 'credential_submit',
  'credential_cancel', 'discover_repositories', 'compare_branches', 'clean', 'discard',
  'stage', 'unstage', 'stage_all', 'commit', 'sync', 'init', 'generate_message',
  'check_staged', 'connect_to_remote', 'ignore', 'diff_all', 'reset',
  // Three-way conflict surface: read the index's merge stages, enumerate
  // unmerged paths, and stage a hand-merged file as resolved.
  'conflict_stages', 'list_conflicts', 'mark_resolved',
] as const

// search capability methods → backend `search.<method>` one-for-one.
const SEARCH_METHODS = ['find_in_files', 'replace_in_files'] as const

// issues capability methods → backend `issues.<method>` one-for-one. GitPane's
// useIssues drives cloud issues (gh/glab CRUD); the backend handlers already
// exist, so plugin parity is a pure mapping plus a `requires: ["issues"]` grant.
const ISSUES_METHODS = ['provider', 'list', 'get', 'create', 'comment', 'set_state'] as const

// terminal capability methods → backend `terminal.<method>` one-for-one: the
// interactive PTY surface AiCliDock/useTerminal drives from plugin windows
// (spawn/reattach lifecycle, keystroke input, resize/redraw, interrupt/kill).
// `create_cancel` is the one non-uniform member (WS type
// `terminal.create.cancel`) and lives in EXPLICIT_CAP_MAP; `run` (one-shot
// shell.run) stays an EXPLICIT remap as before.
const TERMINAL_METHODS = [
  'create', 'input', 'log_sent', 'resize', 'interrupt', 'kill', 'reattach', 'redraw',
] as const

// Non-uniform `(ns.method)` → backend WS type. These invert the shim's EXPLICIT
// remaps of the shell/editor/ai/ui families onto the terminal/chat/ui namespaces.
const EXPLICIT_CAP_MAP: Readonly<Record<string, string>> = {
  // TerminalCapability
  'terminal.run': 'shell.run',
  // TerminalCapability — PTY create cancellation. The WS type has a second dot
  // (`terminal.create.cancel`), so it cannot ride the uniform split.
  'terminal.create_cancel': 'terminal.create.cancel',
  // TerminalCapability — messaging roster read, feeding the embedded CLI
  // panel's @-mention menu. Rides the terminal namespace (already granted to
  // every plugin that embeds AiCliDock) rather than adding an `agent_msg` one:
  // this is a read of names the panel completes into, not messaging itself.
  'terminal.agent_msg_list': 'agent_msg.list',
  // ChatCapability — editor inline AI
  'chat.editor_rewrite': 'editor.rewrite',
  'chat.editor_complete': 'editor.complete',
  // ChatCapability — ai.chat settings (retired AIChatPane surface trimmed to
  // the settings store ReviewPane still reads for its analyzer credentials)
  'chat.settings_get': 'ai.chat.settings.get',
  'chat.settings_set': 'ai.chat.settings.set',
  // ChatCapability — ai.review / analyzer (Branch-Diff AI code review). The
  // result events (ai.review.result/end/error) are already chat-gated in
  // CAP_EVENTS; these invert the shim's request-side remaps.
  'chat.review_start': 'ai.review.start',
  'chat.review_stop': 'ai.review.stop',
  'chat.analyzer_models': 'analyzer.models',
  // UiCapability — settings persistence
  'ui.settings_set': 'ui.settings.set',
  // UiCapability — settings read (lib/settings.ts reconcile; the Plans plugin
  // needs it for theme sync). Backend handler already exists.
  'ui.settings_get': 'ui.settings.get',
}

/** `(ns, method)` → backend WS message type. The full mini-IDE call surface
 *  (fs / git / search / issues / terminal / chat / ui) the broker dispatches to
 *  the backend. Keep in sync with the shim's `TYPE_TO_CAP`. */
export const CAP_MAP: Readonly<Record<string, string>> = {
  ...uniformNs('fs', FS_METHODS),
  ...uniformNs('git', GIT_METHODS),
  ...uniformNs('search', SEARCH_METHODS),
  ...uniformNs('issues', ISSUES_METHODS),
  ...uniformNs('terminal', TERMINAL_METHODS),
  ...EXPLICIT_CAP_MAP,
}

/** Resolve a capability call to its backend WS type, or `null` when unmapped. */
export function resolveWsType(ns: string, method: string): string | null {
  return CAP_MAP[`${ns}.${method}`] ?? null
}

/**
 * Server-push events the broker forwards to plugins, each mapped to the ns a
 * plugin must `require` to receive it. Every entry is a backend broadcast event
 * (`make_event(...)` + `app.broadcast(...)`) the mini-IDE's bundled components
 * subscribe to via `useBackend().on(...)`.
 *
 * NOTE `git.changed` is gated on the `fs` namespace, not `git`: the backend
 * fires it whenever the working tree changes on disk (including after every
 * `fs.write_file`), so it is the filesystem-change signal an fs-capable plugin
 * needs (Explorer/GitPane auto-sync depends on it). This is independent of
 * `git.*` capability *calls*, which remain gated on the `git` namespace (so an
 * fs-only plugin still gets DENIED calling git.*).
 */
export const CAP_EVENTS: Readonly<Record<string, string>> = {
  // Working-tree-changed signal — see NOTE above. Preserves the fs-write
  // broadcast contract Explorer/GitPane rely on.
  'git.changed': 'fs',
  // Git askpass round-trip (useGit ↔ GitCredentialModal). The backend
  // broadcasts a prompt while a push/pull/fetch/clone waits on credentials and
  // a cancel when the request settles unanswered; gated on `git` like the
  // credential_submit/credential_cancel calls that answer them.
  'git.credential_request': 'git',
  'git.credential_cancelled': 'git',
  // Settings sync (lib/settings.ts). Broadcast with exclude=session, but the
  // broker holds its own WS session so it still receives it.
  'ui.settings_changed': 'ui',
  // AI code-review results (useReview via ReviewPane). Part of the AI feature,
  // so gated on the chat namespace (the set has no dedicated review/ai ns).
  'ai.review.result': 'chat',
  'ai.review.end': 'chat',
  'ai.review.error': 'chat',
  // Plan documents changed on disk (backend broadcast). Gated on the dedicated
  // `plans` namespace — event-only, it maps no request types — so the Plans
  // plugin can live-refresh without being granted broader fs event surface.
  'plans.changed': 'plans',
  // PTY stream + lifecycle (useTerminal inside AiCliDock). These are _active_
  // emits sent to the PTY owner's WS session — the broker's shared transport is
  // the owner for PTYs created through it. terminal.output is additionally
  // micro-batched and routed to the creating plugin only (see
  // frontendPluginManager dispatchEvent); the `terminal` gate here is the
  // fan-out fallback for sessions with no registered owner.
  'terminal.output': 'terminal',
  'terminal.exit': 'terminal',
}

/** The namespace gating a server-push event, or `null` when not forwardable. */
export function eventNamespace(event: string): string | null {
  return CAP_EVENTS[event] ?? null
}
