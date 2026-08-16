# Changelog

All notable released changes to Navide will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic Versioning where practical during the pre-1.0 period.

## [Unreleased]

### Added

- Enforce Manifest v2 coarse `system` namespace and `shell` grants through the
  Host capability catalog, authenticated workspace binding, package-version
  approval, and fail-closed AI CLI/shell request planning.
- Allow the canonical `git` executable through Manifest v2 `shell.run`
  allowlist mode without adding a Git permission or first-party bypass.
- Configurable lazy CLI restore: resume one CLI, the first Grid page, or the active tab when opening a workspace; preserve manual-tab grouping and recover uniquely attributable missing Claude conversations on realization.
- Add Meta Muse Code as a spawnable CLI agent, including install detection and one-click install. Resume, log reading and credential switching remain unavailable for it until they are verified against a real installation.
- Validate Manifest v2 frontend contributions consistently in the App and marketplace registry, including strict view discovery and package-entry checks.
- Validate, install, list, and remove Manifest v2 backend-only and combined packages from one active package version, and publish the Backend Wire v1 contract corpus.

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
