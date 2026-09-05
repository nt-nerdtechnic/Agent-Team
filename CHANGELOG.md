# Changelog

All notable released changes to Navide will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic Versioning where practical during the pre-1.0 period.

## [Unreleased]

### Changed

- Document that Plans legacy recovery is authorized only by the Host-minted
  pre-dispatch `legacy-safe-before-dispatch` disposition; post-dispatch errors,
  stopping, Grant revocation, and policy denial do not retry legacy.

### Added

- Add a dedicated Settings → Execution Policy editor for the Host default,
  global user modes, explicit workspace source selection, untrusted repository
  recommendations, confirmed corrupt-state rebuild, and fail-closed recovery
  guidance. Extensions now shows Manifest Permissions, exact package-version
  Grant state, and the selected agent Execution Policy as separate concepts.
- Add the global agent Execution Policy v1 contract and Host-owned durable
  default/user policy store with strict fail-closed parsing, owner-only atomic
  persistence, lowercase shell-name canonicalization, case-insensitive agent
  executable policy matching, and a durable monotonic revision high-water mark.
  The setting remains separate from Manifest
  permissions and package-version Plugin Grants.
- Enforce Host-owned `user` and MCP-routed `agent` initiators across public
  capabilities and package-local Backend Wire calls, including policy revision
  rechecks before queued dispatch, complete shell-chain executable checks, and
  exact package-version Grant revocation that drains calls, subscriptions,
  events, views, and child backends without rolling back completed effects.
- Add the Host-only repository Execution Policy source service for strict,
  untrusted `.navide/execution-policy.json` recommendations, explicit
  per-repository source selection bound to inspected canonical-content
  fingerprints, durable owner-only selection state, monotonic revision floors,
  bounded recovery, typed fail-closed source results, strict user pins,
  revision-aware snapshot identities, and stale recommendations without source
  merging.
- Add the public Plugin Platform v2 contracts, SDK CLI, unified Vue UI package,
  and an external-workspace frontend package smoke workflow with fail-closed
  capability-denial coverage.
- Use the same Manifest, catalog, grant, instance, and capability lifecycle for
  official and third-party plugins. Until Marketplace acquisition is available,
  the App includes a removable factory Git package whose durable opt-out and
  explicit Extensions restore do not bypass that shared runtime.
- Add the Issue 16 Host-managed durable plugin/workspace storage adapter and
  lifecycle seams with authenticated package/workspace identity,
  version-matched candidate/active/previous snapshot selection, atomic JSON
  persistence, stable quota errors, and Host-derived package-version grants.
- Enforce Manifest v2 coarse `system` namespace and `shell` grants through the
  Host capability catalog, authenticated workspace binding, package-version
  approval, and fail-closed AI CLI/shell request planning.
- Allow the canonical `git` executable through Manifest v2 `shell.run`
  allowlist mode without adding a Git permission or first-party bypass.
- Add the optional official `navide.git` Manifest v2 package
  with isolated left and window custom views from one active package version,
  Host-owned Git contribution/account bridges, workspace storage continuity,
  and a retained legacy rollback path. Git-specific production source now lives
  in the plugin package; remote credentials remain Host-injected and the
  lifecycle selector uses a crash-safe atomic write. Approved v2 activation is
  attempted first; load/mount/readiness failure selects the retained legacy
  renderer for that process, while security and permission denials fail closed.
  Contribution artwork is decoded by the Host and rendered from the shared
  manifest catalog with a generic fallback for missing or invalid icons.
- Configurable lazy CLI restore: resume one CLI, the first Grid page, or the active tab when opening a workspace; preserve manual-tab grouping and recover uniquely attributable missing Claude conversations on realization.
- Add Meta Muse Code as a spawnable CLI agent, including install detection and one-click install. Resume, log reading and credential switching remain unavailable for it until they are verified against a real installation.
- Validate Manifest v2 frontend contributions consistently in the App and marketplace registry, including strict view discovery and package-entry checks.
- Validate, install, list, and remove Manifest v2 backend-only and combined packages from one active package version, and publish the Backend Wire v1 contract corpus.
- Add an internal Electron-main Backend Wire v1 supervisor seam with real
  child-process health/unary conformance coverage, explicit child environment
  isolation, bounded cancellation tombstones, and subscription lifecycle
  conformance; general third-party backend catalog activation remains deferred.
- Add test-only integration evidence for the bounded Issue 21 Plans
  packaged-child round trip: the real `PlanWindowApp` mounted call site, public
  SDK backend client, sender-authenticated Host router, self-contained Python
  fixture child, and `plans.resolve_root` / `plans.changed` call-event path.
  CI and release gates build and run the fixture explicitly; it is not a
  production artifact, and the full third-party backend lifecycle and remaining
  Plans operations stay on their owning migration issues.
- Add the Host-private Plans core-service bridge, package-owned watcher, bounded
  child drain/restart lifecycle, and Python/Go packaged fixture parity. The
  combined production Plans package now consumes those seams with an explicit
  agent method allowlist and a retained legacy fallback.
- Activate the combined `navide.plans` Manifest v2 package with a self-contained
  Backend Wire executable, Host-private filesystem bridge, workspace-bound
  headless agent routing, Host-minted agent Initiators, workspace storage
  preference migration, package-owned change events, and fail-closed legacy
  recovery. Manual operations remain user-initiated and outside agent policy
  filtering; no public `plans` permission is added.
- Require a verified Registry signature from a signer authorized by the
  App-pinned Registry root before a Manifest v2 marketplace package can be
  installed, including packages whose signed listing metadata has been
  modified.
- Stop scanning arbitrary external directories for legacy Python backend
  plugins; validate only the Host-bound Manifest v2 activation projection while
  packaged backend process supervision remains fail-closed.
- Keep Official Registry namespace authority separate from self-hosted root
  verification, fail closed while the independent production Registry root is
  unprovisioned, and reject publisher-key reuse as Registry trust.
- Add an opt-in `AGENT_TEAM_PLUGIN_DEV_PATH` seam for one explicitly selected
  local Manifest v1 or v2 frontend package. Manifest v1 is bounded local
  compatibility only: it remains unsigned, local-only, and cannot claim
  Registry provenance; reserved ids and backend contributions remain
  unavailable in Developer Mode.
- Tell a CLI agent when its inter-CLI message could not be delivered: a `[Navide MSG] delivery failed` notice naming the target and the reason is written back into the sending pane, through the same queue and idle gate as any other message.
- Deliver an inter-CLI message to a Claude pane through its Stop hook when its turn ends with one waiting: the message becomes the agent's next instruction instead of being typed in, so it never occupies the input box or waits behind whatever you are writing. Capped at 5 in a row per pane; anything else — an idle pane, another CLI, hooks not installed — still arrives the usual way, unchanged.

- Route an inter-CLI message through a CLI's own push channel where it has one, instead of typing it into the pane. Which channel a CLI offers is declared per vendor; a message that goes out this way is marked with the channel it used in the Messages panel, and anything that does not land there falls back to the ordinary typed delivery with no message lost and none delivered twice.
- Deliver a message to an OpenCode or Kilo pane over the HTTP interface that CLI already serves for its own terminal UI, instead of writing it to the terminal. The pane is launched with a loopback-only port of its own (Kilo's also with a per-pane password); an OpenCode port carries none, because that CLI cannot authenticate against its own server — see [Privacy and Data Flows](docs/en-US/privacy.md). A pane whose command already names a port is left alone.
- Deliver a message to a Qwen Code pane by appending one record to a per-pane file the CLI watches, instead of typing it in. The message joins the CLI's own queue rather than its composer, so a Qwen pane accepts one while you are half-way through writing a prompt in it.
- Switch any CLI's push channel off in Settings → CLI Agents → Push channels, with what each one costs stated next to it. All are on; switching one off sends messages to those panes the ordinary typed way, takes effect on panes already running without restarting them, and needs no restart itself: Claude's switch rewrites `~/.claude/settings.json` at once, so its hook appears or disappears with the switch. Switching one back on is immediate as well, except for a Claude pane, which regains its channel at its next turn end — and a Claude pane already open reads that settings file only when it starts, so the switch reaches it at its next start.
- Reach an **idle** Claude pane without typing into it either: a background hook waits on Navide and wakes the agent with the message when one arrives, covering the gap the Stop hook cannot — that one only fires as a turn ends. The message arrives as a system reminder and says so; anything Claude Code will not carry that way, including an envelope past its 10,000-character hook limit, still goes in the usual way.

- Answer an agent that asks `cli_send` to wait: `wait_for_delivery_s` holds the call until the message actually goes into the other pane and reports what happened — delivered, refused with its reason, or still queued with what is holding it and for how long. Left at its default of 0 the answer is unchanged, and a refusal still reports the send as the success it was, so nothing invites a resend that would dispatch the work twice.
- Take an inter-CLI message back before it is delivered: **Withdraw** on a queued row in the Messages panel drops it from the target's queue, so nothing is ever typed into that pane. It is offered only while the row is still queued — once delivery has started the text is being written and there is nothing to recall — and a withdrawn row can be resent like a failed one. A message queued in another workspace's window is withdrawn by asking that window, which owns the queue and answers with what actually happened.
- Report why an inter-CLI message has not gone out yet to the agent that sent it, not only to the Messages panel: `cli_check_message` now carries `hold` and `held_for_s`, and `cli_list_targets` names the same reason per pane as `hold_reason`, which is what makes its `busy` flag explainable. The reason is sent only when it changes, and only for a message the backend already tracks.
- Tell a CLI agent when its message is still queued, not only when it failed: after two minutes a `[Navide MSG] still held` notice naming the target, the reason and how long it has been waiting is written back into the sending pane. It is not a failure — the message is still on its way — and each message produces exactly one, however long it stays queued.
- Answer the same question for an MCP caller: `cli_check_message` and a timed-out `cli_send` wait now carry `stale` once a message has been queued more than two minutes, and the new `cli_inbox_summary` tool lists every send of your own that is currently stale or failed, with an excerpt of each. It takes no arguments and answers about the caller only — the pull half of delivery feedback, for an agent that stays too busy to be told.
- Say once, in the announcements feed, that a CLI pane or external MCP client left over from the previous version is holding that version's MCP tool list and needs reopening. Shown only when the backend actually started at a different version than the run before it.

- Ask what is waiting for you: the new `cli_pending_incoming` MCP tool lists the messages queued *for* the calling pane — sender, age, excerpt, and whether Navide wrote it. Every existing feedback path is typed into a pane, so it reaches an agent only between turns, which means an agent deep in a long piece of work was exactly the one that could not be told it had mail and had no way to ask either: `cli_inbox_summary` only ever answered "did what I sent get through?". It reads the persisted message log, so unlike `cli_inbox_summary` it survives a backend restart. Only a CLI pane has an inbox — a host or external caller has no messaging name and gets an error rather than a misleading empty list.
- Forward a spawned pane's turn to its parent when it ends without writing a report. `cli_open_agent` promises the caller a report back, but that report is the child agent's own output: a missed marker used to make it vanish with no queue row, no failure and nothing for either side to see. The first turn a spawned pane ends now settles that debt either way — its own report if it addressed the parent, otherwise that turn's output forwarded under a `fallback report` label so it can never be mistaken for the real thing. Once per pane, ever; nothing is sent if the parent closed or the turn carried no text.
- Report a message block Navide could not read. A turn that prints `---MSG-START---` and produces no block was the one failure nothing could describe — no message existed, so there was no queue entry, no log row and no notice. The pane that wrote it is now told, which is the only party that knows what it meant to send.
- Show at a glance whether a tab's agents are working: each run-group tab in the tab bar now carries a small dot — green while any CLI in that tab is running or starting, amber once every one of them has stopped, grey for a tab with no panes. A pane waiting on you counts as stopped: the dot answers one question only, and the pane badge still says which kind of stop it is. It reuses the colours the pane badges already use, says the same thing on hover and to a screen reader, and never animates.

### Changed

- Explicitly declare and document the supported Node.js runtime as Node.js 22.12+ within the 22.x release line (with pnpm 10).
- Accept a `---MSG-START---` marker standing on its own line with `to:` on the line below it. Both forms now open a message block. The injected hint still teaches the same-line form and that is still the one to write, but "the marker must be a whole line" reads just as easily as "the marker gets a line to itself" — and until now a block written that way was discarded as ordinary prose, so a reply an agent believed it had sent left no trace anywhere. The cost is booked explicitly: an unfenced bare marker quoted inside a message body now truncates the message it sits in, the same hazard the same-line form has always had.
- Deliver a message into a `claude` pane while its turn is still running. The two turn-boundary holds exist to wait for a boundary, and Claude Code supplies that boundary itself — text written to its PTY mid-turn lands in its own queue, the same path a person typing mid-turn uses. Waiting for the pane to fall idle is what made a reply from a busy pane take 78s where the other direction took 2s. Declared per vendor and measured, not assumed: `claude` alone today, and `qwen` deliberately stays held because it merges several queued messages into one submission. The typing hold still applies, the pane still reports itself busy to `cli_wait_idle` / `cli_list_targets`, and push channels are unaffected.
- Say plainly that a reply's `to:` belongs on the `---MSG-START---` line itself. The instruction Navide injects with every message and every spawned task said the marker "must be on its own line", which reads as an invitation to put `to:` on the next one — and a block written that way opens nothing: it is read as ordinary prose, so no message is queued, no delivery fails, and neither side sees a trace of it. The parser is unchanged; the wording, the in-app protocol reference and the three-language docs now state the rule and no longer imply the opposite.
- Stop promising that a spawned pane's result arrives on its own. `cli_open_agent` told callers they "never need to poll it", but that report is the child agent's own output rather than anything Navide guarantees: it waits until the parent is between turns, and it never comes at all if the child does not write the block. The tool description, the MCP server instructions, the spawn protocol text and the docs now say so and point at `cli_get_status` / `cli_wait_idle` for when you need to be sure.
- Rename the built-in MCP server from `navide-plans` to `navide`: tools now appear as `mcp__navide__*`, and a per-tool "always allow" saved for the old prefix will be asked once more. Stale `navide-plans` entries Navide itself wrote (Cursor project config, per-pane shim configs) are replaced in place; anything you added yourself is left alone.
- Wait for an inter-CLI message to be delivered before waiting for the turn it should produce: `cli_send_and_wait` spends at most half its timeout getting the message in, and answers `not_delivered` — with the hold or the refusal reason — when it never arrives. It previously reported the target as idle in that case, which reads as "it finished your work" when the work was never handed over.
- Hold an inter-CLI message while someone is typing into the target pane: a pane with an unsent input line, or one that took a keystroke in the last few seconds, is reported as `typing` in the Messages panel until the line is sent or cleared, so a delivery can no longer submit a half-written prompt along with itself.
- Write every injection into a CLI pane as a bracketed paste for the vendors whose TUI keeps the mode on, instead of only multi-line ones, and send the paste guards as whole writes so a chunk boundary can never cut one in half.

### Fixed

- Restore the retained Plans toolbar and Review Notes inside the packaged
  Plans contribution, including overflow clicks, note editing focus,
  application confirmation, anchored comments, and plan-switch isolation.
  Opt-in development provenance and emitted-frontend integration checks now
  distinguish the selected installed package from the current worktree build.
- Prevent unintended editor opens from Plans navigation: standalone initial
  `rel_path` document loading and plan row clicks now only inspect and render
  the plan in the standalone view without invoking `ui.openInEditor`. Left-sidebar
  plan row selection invokes `ui.openPlansWindow` and never overwrites the
  active editor, leaving `ui.openInEditor` strictly for explicit "Open in editor"
  user actions.
- Fill the complete Host slot with the isolated Git v2 left contribution,
  without exposing the browser's default white canvas or outer page margin.

- Make Git account sign-in safer by limiting saved credentials to the selected
  Git host, protecting clone destinations chosen in the folder picker, and
  keeping Git preferences and selected repositories when moving to Plugin
  Storage. A documented legacy Git recovery launch option remains available if
  a release needs to return temporarily to the previous Git interface.

- Restore Git contribution parity across the embedded and dedicated views,
  including AI CLI file/external opens, semantic resize/redraw/force controls,
  change badges, and Escape-to-close behavior without affecting sibling
  instances. GitHub/GitLab Issue calls remain Host-owned through the shared
  `git`/`gh`/`glab` executable allowlist. Embedded left-view failures now fail
  closed with a manual Retry state and ignore stale geometry completions.

- Harden staged plugin event and PTY ownership: stable capability-context
  refreshes no longer detach routes, in-flight creates are cancelled on view
  teardown and late committed creates receive one operation-scoped cleanup kill,
  stale reattach senders fail closed, and Manifest v2 raw PTY recovery remains
  explicitly deferred to a persistent Host ownership contract.
- Route public workspace events to the exact Host-selected package id, apply
  Manifest v2 PTY rules even when a descriptor is opened through the legacy
  adapter, and make instance subscription cleanup exactly-once for both active
  unsubscribe and view teardown.

- Keep Codex panes resumable after spawning sub-agents by excluding read-only thread-spawn child rollouts from the pane's persisted root session id.
- Keep Kimi Code's arrow-key navigation reliable in the embedded terminal by allowing 100 ms to reassemble split escape sequences while preserving an explicit `PI_TUI_ESC_TIMEOUT` override.
- Keep repository discovery responsive on slow filesystems by moving scans off the
  backend event loop and returning partial results after a bounded scan period.
- Keep a CLI agent's Navide tools working after its pane is rebuilt around it. Reloading a window, detaching a run group or taking one back gives the pane a new id while the CLI keeps quoting the one it was launched with, which used to fail every MCP tool for that pane — plan documents included — with "this pane's id is stale". The old id now resolves to the pane the process is actually attached to, and so do the pane's Claude Stop-hook delivery and what `cli_get_status` reports. Its push channel follows a window reload and a run group returning from a detached window, but not a detach itself — the window handing the pane over releases the channel before the receiving window claims the pane, so a detached pane is typed into until its CLI is restarted (a Claude pane re-arms its own hook at the next turn end and is unaffected). An id that names no pane at all is still refused.

## [0.1.62] — 2026-07-26 — signed release

### Added

- Navigate Agent History log-search matches with Arrow Up/Down and clearer active-match highlighting.
- Add an in-process Plan MCP with plan CRUD, optimistic updates, dispatch, and Claude/Codex wiring; ship it as a built-in plugin.
- Finalize the built-in plugin system with a sandboxed mini-IDE, verified marketplace precedence, completed plugin capabilities, and an OS-editor fallback when the mini-IDE is unavailable.

### Changed

- Re-check updater state after a release has been downloaded.
- Align Active Agents rows and replace the remove action with minimize.
- Move Explorer deletions to the OS Trash so files and non-empty folders remain recoverable; preserve the original and report an error if Trash is unavailable.

### Fixed

- Scope CLI Agents ordering and disabled preferences per workspace, and close workspace-switch race and silent-loss gaps.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.61] — 2026-07-25 — signed release

### Added

- Aggregate plan and report documents across seven supported workspace directories.
- Harden Cmd+click links for CJK and emoji output, bare domains, wrapped paths, and workspace HTML reports.

### Changed

- Improve update-notification window restore and focus handling, show the available version in the update badge, and make minimized-agent state clearer.

### Fixed

- Harden CLI-account profile deletion and login-home credential harvesting and cleanup.
- Store Git account data with owner-only (`0600`) permissions.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.60] — 2026-07-25 — signed release

### Added

- Sign in to a CLI account from within Navide: a dedicated isolated login pane captures the new account's credentials and identity without disturbing the currently active account, and each account's signed-in identity is shown in the UI.
- Cmd+click a URL or file path in any CLI pane to open it — URLs open in your default browser, file paths open in the editor; bare domains are now linkified too.
- Open an HTML plan in your default browser from the plan review.

### Changed

- CLI account switching now swaps each account's credentials in place instead of isolating separate config homes, making switches faster and more reliable; swaps are hardened against concurrent switches and terminate the old process before handing over.
- Clearer wording on the app-update restart button.

### Fixed

- Cmd+click path hit-testing now handles CJK/wide-character paths and folder names that contain spaces or parentheses.
- Ignore IME composition keystrokes in the global shortcut dispatcher, so composing Chinese/Japanese/Korean text no longer fires shortcuts.
- Stop-pane messaging handles no longer accumulate `-2` suffixes across restarts.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.59] — 2026-07-24 — signed release

### Added

- Multi-select CLI panes (Cmd/Ctrl/Shift-click a pane header) for batch context-menu actions: interrupt, rebuild, minimize, restore, or remove the whole selection at once.
- @-mention autocomplete menu that lists other panes' messaging names on `@`, plus broadcast a message to every pane with `to: all`.
- Drag a plan row onto a CLI pane to inject the plan's goal into that pane.
- Switch a CLI account per pane from the usage badge, with colored per-account avatars and a shortcut to manage accounts in Settings.

### Changed

- Usage badges: Codex quota reflects its rate-limit windows and credits; per-model promotional rows are shown as real data (marked accordingly); usage is polled from the active CLI profile's isolated credentials.

### Fixed

- Offload blocking work off the event loop so `workspace.list_recent` no longer times out.
- Skip rebuild-via-resume when a CLI is busy, preserving in-flight work.
- De-duplicate redraw content instead of relying on a timing-window grace.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.58] — 2026-07-24 — signed release

### Added

- Codex quota badges now reflect its rate-limit windows and credits.
- Drive update download and restart-install directly from the status-bar update badge (one click, no detour through Settings).
- Renaming a pane to a messaging name another CLI already holds opens a collision-resolution prompt instead of failing.

### Changed

- CLI accounts: replace per-pane account binding with a single global active account per vendor, switchable from the titlebar. (Removes the per-pane profile picker and per-account token attribution introduced in 0.1.56.)
- The pane's messaging handle is now derived from its own name and stays in sync on rename/auto-title; the separate inline messaging-name editor is gone.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.57] — 2026-07-24 — signed release

### Added

- Per-CLI quota badges in pane headers.
- View a commit's per-file diff in the editor as a read-only tab.
- Status-bar indicator for background historic-log backfill.
- "@"-mention pane drop: dropping a pane when the cursor already sits after a bare `@` inserts that pane's messaging name instead of its full scrollback context.

### Changed

- Inter-CLI messaging: drop the manual compose UI; panes exchange messages through the `---MSG---` protocol.

### Fixed

- Reap detached grandchildren (e.g. MCP servers a CLI spawned) that are orphaned when a CLI or the backend dies, via persisted per-session descendant snapshots.
- Scope the pane attribution baseline scan to the pane's workspace folder instead of stat'ing the whole `~/.claude` tree on every spawn.
- Clear the backfill status pill when the workspace changes so it can't stick on.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.56] — 2026-07-24 — signed release

### Added

- CLI account profiles: run a CLI under an isolated account "profile" (its own home directory), switch the account per pane or when spawning, and manage accounts in a dedicated Settings tab. Token usage is tracked per account (`by_profile`, with a forward-migration that folds historical usage into the default account). No credentials are ever stored — only isolated home directories are registered.
- Move the update indicator into the bottom status bar.

### Fixed

- Cross-window pane drop now relies on Chromium's native same-app cross-window delivery, routing through the main process only as a fallback when no in-window target consumes the drop.
- Keep a cancelled loop from dropping a stray prompt into the pane or breaking the next loop start (per-pane generation guard).
- Stop a manual_pane.session retry flood that could time out terminal.create.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.55] — 2026-07-23 — signed release

### Added

- Inter-CLI messaging: panes address each other by name and exchange `---MSG---` protocol messages through an idle-gated, rate-limited queue, with a log/compose panel.
- Auto-derived pane names: an unnamed pane gets a heuristic title from its kickoff / first-turn text (a custom name always wins), persisted and broadcast to peer windows.
- Cross-window pane drop: drag a pane onto a terminal in another window to inject its context into that pane; drops route to the most-recently-focused overlapping window.
- Compact, click-to-expand Active Agents list with a status dot, a type·role sub-label, and a one-open-at-a-time accordion.
- Mini-IDE VS Code parity: filename-aware editor language detection, Toggle Word Wrap (Alt+Z), explorer drag-to-move, and tab rebinding that survives file renames/moves.
- Plans pane: search, stage filter, sort, and in-body to-do editing.
- Rebuild resumable CLI panes across all tabs from the sidebar.
- Configurable resume-spawn concurrency limit.

### Changed

- Focusing a pane that lives in another tab now switches to that tab.
- On macOS, Alt+letter keybindings match by physical key (so Option+letter shortcuts fire despite the special character the OS emits).

### Fixed

- Repaint alternate-buffer TUIs on drag-resize so the footer no longer stays garbled until the next output.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.54] — 2026-07-23 — signed release

### Added

- Star / favorite Agent History entries: a "starred only" filter, and starred entries are protected from bulk cleanup (an explicit single delete still removes them).
- Search Agent History by log content, not just metadata: a chunked, ANSI-stripped log searcher over IPC with a debounced query.
- Native application menu: Help, New Window, Open Recent, and About entries.

### Changed

- Capture Kimi resume session ids via a single-candidate fallback so a freshly spawned sibling pane stays bindable.
- Show the agent-type label alongside the optional role in pane headers.
- Settings: horizontally scrollable tab bar, scroll containers on several tab bodies, Roles-tab polish, and a dedicated Updates tab label.
- Throttle and extend the timeout for terminal creation.

### Fixed

- Harden log-content search across chunk boundaries: withhold incomplete ANSI escapes, flush the UTF-8 decoder at EOF (truncated multi-byte/CJK queries still match), and bound concurrent file opens to avoid EMFILE.
- Emit the Kimi turn-complete event once per turn and harden the notify path.
- Re-check the dead flag inside the WebSocket send lock to stop a disconnect flood.
- Ignore IME composition events during keydown in the rename flows.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.53] — 2026-07-23 — signed release

### Added

- Reconnect lost ("ghost") conversations: a restored pane whose saved session id has no transcript auto-reconnects to a unique provenance match, or surfaces a status-bar banner and a manual picker to reconnect to a previous conversation.
- Resume-on-open preference (always / never / ask) controlling whether opening a workspace resumes its previously spawned CLI panes, starts fresh, or asks each time.
- Loop auto-stop: the loop appends a done-instruction so the CLI prints a `<<LOOP_DONE>>` marker on its own line once the whole task is complete, and the app stops resending the resume prompt.

### Changed

- Assistant turn text is now carried only on turn completion (shared text-join helper and a larger both-ends activity-text cap), making turn-text judging more reliable.
- PlansPane: extract hard-coded strings to i18n, load legacy markdown plans in parallel, drop the background-refresh flicker, exclude archived plans from "delete all", and support keyboard activation on section headers.

### Fixed

- Attribution no longer guesses an ambiguous same-cwd session→pane claim; a hand-written `--session-id` is honored as an explicit, deterministic pin.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.52] — 2026-07-23 — signed release

### Changed

- Move the update controls (version, check for updates, auto-check/auto-download, release channel, and release notes) into their own **Updates** tab in Settings.
- The status-bar "close all" now acts on a single click with a confirmation dialog, replacing the double-click-to-arm gesture and its hint.

### Distribution note

- Signed with a Developer ID and notarized by Apple; published as a stable release eligible for the in-app updater.

## [0.1.51] — 2026-07-22 — signed release

### Added

- In-app update experience: full updater lifecycle and UX (check, download, restart, and release channel selection).
- Agent History: search filter plus history filtering and grouping.
- Spawn history tracking for panes.
- Plans: archive without deleting, approve directly from a draft, per-plan file path in the sidebar list, and section collapse in the editor.
- Store backup and forward-migration when the app version changes.
- Log-reader parsing, terminal cursor shortcuts, and keybinding/completion improvements.
- Dynamic latest-release badges in the READMEs.

### Fixed

- Keep the selected layout mode when only a single pane is visible.
- Propagate pane renames to peer windows and autofocus the rename input.
- Reap a killed child process on timeout; serialize git fetch per repository.

## [0.1.50] — 2026-07-21 — signed release

### Changed

- First **signed and notarized** stable release. Same feature set as the v0.1.49 preview, now built with a Developer ID certificate and Apple notarization and eligible for the in-app updater. Establishes the signed release pipeline.

## [0.1.49] — 2026-07-21 — unsigned preview

### Added

- Mini-IDE plugin system: a plugin architecture with an install / update / remove lifecycle, an Extensions view in Settings, and per-plugin verification and packaging. The whole surface is gated behind an opt-in flag (`AGENT_TEAM_MINI_IDE_PLUGIN`) and stays hidden until the main process confirms it is enabled.
- Plugin marketplace: a registry service, a publishing flow with a signing and trust model, and a discovery website to browse, search, and view plugin details.
- Kimi Code CLI integration: conversation-log reader and resume support.
- Git History window as a standalone view.
- Unified plan documents: a shared model for HTML and Markdown plans with in-place todo editing, stage snapshots with live refresh, a shared review toolbar, and Plans surfaced as a left-sidebar tab.
- Keybindings: Ctrl+1–5 to quick-select a CLI type, and Cmd+Shift+<n> to switch stage tabs.

### Changed

- Plans move to a left-sidebar tab with drill-down, replacing the pop-out window.
- Grid layout accepts custom column×row presets.
- Refreshed status-badge colors across components.

### Fixed

- Prevent stored XSS in the marketplace by serving plugin assets same-origin.
- Derive the Kimi resume session id from the directory name instead of the file stem, and validate the session exists during resume preflight.
- Stop focus/refit repaints from falsely showing a RUNNING pane badge.
- Plan QA hardening: preserve skipped/unknown todo fields, close panels on ESC, and fix blank todo-only plans.
- Externalize optional `ws` native dependencies (bufferutil, utf-8-validate) so the build does not break.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.48] — 2026-07-20 — unsigned preview

### Added

- Interactive plan documents: agent-authored HTML plans with a todo sidebar, live stage and status updates, comment anchors, and one-click task dispatch from the plan into CLI panes.
- Manual pane sessions for capturing terminal work outside a spawned agent.
- Status bar indicator for lingering CLI processes, with scan and reap actions.

### Changed

- Reduce keystroke echo latency in terminals with an adaptive output-flush fast path and focus-priority scheduling.
- Resolve CLI commands through an interactive login shell so PATH entries written by installers (for example `~/.local/bin` or Homebrew) are visible when the app is launched from Finder or the Dock.
- Refresh PATH from the login shell before spawning so newly installed CLIs are found without restarting the app.
- Improve npm-based dependency install detection during onboarding.

### Fixed

- CLI agents failing to launch in packaged builds because the backend inherited the GUI's restricted PATH.
- Spawn probe now degrades to a warning on timeout or transient errors instead of blocking the launch.
- Reap breakaway PTY processes that escaped group termination, preventing lingering CLI processes from accumulating.
- Agent history log preview reading the wrong path; the real log path is now stored and older entries are matched by filename across day folders.
- De-duplicate pane restore to avoid concurrent restore races.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.47] — 2026-07-17 — unsigned preview

### Added

- Serve XHTML files through the file preview backend.
- Loop auto-continue: loop status indicators (∞) in panes and the agent list, a configurable loop prompt in Settings, and automatic resume when a CLI session hits its usage limit.
- "General" tab and settings group in the Settings modal.

### Changed

- Handle dead WebSocket sessions gracefully in the backend.
- Handle subprocess timeouts in the terminal service.
- Prevent default browser behavior for terminal cursor shortcuts.
- Improve pane restore with rename stub handling.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.46] — 2026-07-16 — unsigned preview

### Changed

- Update rebuild logic to specifically target active tab CLI panes.
- Ensure focus continuity when marking items as seen in the UI.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.45] — 2026-07-16 — unsigned preview

### Changed

- Add `restoreMode` and `replacePaneId` to `spawnPane` to enable atomic pane replacement with focus continuity.
- Update pane rebuild logic to support `keepInList` during `onKill`.
- Refine terminal refit logic with `skipReattach` option for smoother layout transitions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.44] — 2026-07-15 — unsigned preview

### Added

- Add log preview modal and improve terminal session handling.
- Add force option to kill terminal sessions.
- Add test scripts to simulate terminal input (`test_bp.exp`, `test_bp.js`, `test_pt.py`).

### Changed

- Improve PTY output handling with backpressure.
- Remove session check in `_drain` method for terminal sessions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.43] — 2026-07-15 — unsigned preview

### Added

- Add inline pane renaming functionality to the UI.

### Changed

- Update test mocks to include `onResize` method for terminal tests.
- Fix CI build OOM issues by adjusting `NODE_OPTIONS`.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.42] — 2026-07-15 — unsigned preview

### Changed

- Refactor terminal UI: update terminal methods, fit logic, and temporarily disable auto-rebuild on resize to prevent unexpected CLI resumes.
- Update `spawnHistory` custom name logic to support session home normalization.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.41] — 2026-07-15 — unsigned preview

### Added

- Add a complete Japanese path for the public product and core user documentation.
- Add focused backend coverage for Claude hook installation and stop-hook payload forwarding.

### Changed

- Preserve Agent History custom titles when session-home paths require normalization.
- Support Command–Equal as an additional terminal zoom-in shortcut.
- Organize English, Traditional Chinese, and Japanese documentation under symmetric locale navigation.
- Update all supported-language download guidance to the v0.1.41 preview.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.40] — 2026-07-15 — unsigned preview

### Added

- Publish the first directly downloadable macOS arm64 preview through GitHub Releases.
- Add a complete Traditional Chinese path for the public product and core user documentation.
- Add regression coverage for token checkpoint rotation, persistence batching, shutdown ordering, and workspace replay.

### Changed

- Batch token metric persistence and serialize journal recovery so shutdown and lifecycle saves cannot be overwritten by older snapshots.
- Reset Codex and Grok ingestion checkpoints when their underlying log generation changes.
- Include recent rendered terminal context alongside durable CLI transcript references during handoff.
- Refine terminal zoom shortcuts and pane drag affordances.
- Update English and Traditional Chinese installation guidance with direct downloads and safe Gatekeeper instructions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

### Documentation

- Reposition Navide as the engineering instrument for the Agent era: an AI-native environment for one engineer directing an AI engineering force.
- Add the Navide Manifesto and Product Vision.
- Define Genesis, Evolution, and Intervention as the three engineering loops.
- Define management by exception as the human-agent operating philosophy.
- Define `.agent-team/` as the local, per-user, Git-excluded Project Intelligence Layer.
- Replace the control-plane-only roadmap with a path toward complete professional IDE replacement through an Agent-era interaction model.
- Align supported agents with the current registry: Claude Code, Codex, Antigravity CLI, and Grok CLI.
- Replace fixed-stage claims with the configurable pipeline model and included workflow.
- Add and align the documentation index, getting-started guide, user guide, architecture, privacy and data flows, troubleshooting, and phased long-term roadmap.
- Correct repository clone commands, contribution checks, privacy claims, credential-storage statements, and release expectations.

## Development version history

The source tree reached package version `0.1.39` before the public release history was established. GitHub currently has no published Navide release, so versions in that range must not be represented as downloadable releases retroactively.

Future release entries should be added when a signed GitHub Release is published. Do not invent missing release notes from package-version bumps alone; reconstruct notable changes from commits and verification evidence as part of the first release preparation.

## [0.1.8] — 2026-06-01 — historical development snapshot

### Added

- Configurable SDLC pipeline with parallel agent slots
- Manager coordination protocol
- Local LLM analyzer and optional automatic answers
- Token usage tracking from supported CLI logs
- Context7 document injection
- Pipeline resume and workspace-scoped state
- Recent-workspace entry screen
- History timeline
- Role and stage management
- Claude Code lifecycle hooks
- Initial MIT-licensed open-source repository

`0.1.8` records a development milestone and was not a published GitHub Release.
