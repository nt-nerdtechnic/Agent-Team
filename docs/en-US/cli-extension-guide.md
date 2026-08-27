# CLI Extension Guide

Integration records for Navide's built-in CLI agents: the research behind
each one and the traps found while wiring it.

**To add a new CLI, follow [Adding a CLI vendor](../adding-a-cli-vendor.md)**
rather than this file. That guide tracks the current architecture and the
checks CI enforces; the records in Part 2 here predate it and name files that
have since moved.

Current built-in agent keys are `claude`, `codex`, `antigravity`, `grok`,
`kimi`, `opencode`, `qwen`, `kilo`, `pi`, `copilot`, `cursor`, `aider`,
`muse`, and `droid`. One key identifies a vendor on both sides — `agentKey`
in the frontend, `agent_key` in the backend.

---

## Part 1 — Where the code lives

Since the one-file-per-vendor refactor (July 2026) an integration is two
vendor files plus one registration line on each side. No shared module
carries per-vendor branches, and CI rejects a vendor module that imports
another vendor or any app module.

| Layer | File |
|-------|------|
| Backend spec — credentials, usage, resume, session paths, spawn env, log reader, install entry | `backend/agent_team_backend/cli_vendors/<key>.py` |
| Backend registration | `backend/agent_team_backend/cli_vendors/registry.py` |
| Frontend spec — label, command, resume syntax, capability flags | `src/renderer/src/platform/plugin-shell/agents/<key>.ts` |
| Frontend registration + display order | `src/renderer/src/platform/plugin-shell/agents/index.ts` |

Everything the old layer-by-layer checklist enumerated now derives from those
four:

- `AgentKey` is re-exported from `agents/index.ts`; `data/stages.ts` holds no
  hand-written union to drift.
- The install wizard's `DEPS` aggregates each spec's `install_dep`
  (`onboarding_deps.py`), and a vendor absent from `_AGENT_CLI_ORDER` simply
  appends in registry order.
- Log readers are collected from the registry at startup (`app.py`), one per
  spec that defines `make_log_reader`.
- Session marking, resume syntax, paste protocol and login recovery are spec
  fields, not conditionals in `App.vue` or `resume-command.ts`.

A capability left unset means "unsupported for this vendor": the app degrades
around it instead of falling back to another vendor's behaviour. Filling a
field in from a guess is worse than leaving it empty — it hands the resume
preflight, the credential vault or the log watcher paths that do not exist.

`docs/adding-a-cli-vendor.md` carries the full step list, the structural
tests that act as the checklist, and the import rules.

---

## Part 2 — Integration records

Written against the pre-refactor layout: paths such as `lib/agentSpecs.ts`,
`log_readers/<cli>.py` and the `ws_handlers.py` agent whitelist no longer
exist as described, and the per-layer instructions are superseded by Part 1.
What remains valid — and is recorded nowhere else — is the per-vendor
research: install routes, resume syntax, session storage formats, token
accounting, and the trap each CLI hides.

### Antigravity CLI (`agy`) — added 2026-07-05

- Full integration: agentSpecs, resume via `agy --conversation <id>`,
  Stage editor support, TokenStats reader, session detection.
- Hard-won lesson: no way to pin a session id at launch → marker-based binding
  with **three-tier detection** (SQLite polling / websocket) in
  `antigravity.py`. If the marker is never detected the pane sticks on the
  "detecting session" overlay — this remains the known weak spot.

### Gemini CLI — removed 2026-07-05 (obsolete)

- Product discontinued; support fully removed (specs, reader, resume branch).
- Do not re-add. Historical implementation retrievable from git history if a
  similar JSONL-based CLI ever needs a reference.

### Grok CLI (`grok`) — added 2026-07-10

- Full integration: agent specification, onboarding detection, marker-based
  session binding, `grok -s <id>` resume, SQLite usage reader, token display,
  and workspace attribution.
- No Navide YOLO flag is added because the integrated CLI has no general
  tool-execution confirmation gate.
- The integration reads the shared `~/.grok/grok.db` in a WAL-aware manner.

The following notes preserve the research that informed the integration.

Source: https://grokcli.io/ → https://github.com/superagent-ai/grok-cli
(open-source coding agent for the Grok API by superagent-ai).

Disambiguation: this is NOT xAI's official "Grok Build" CLI
(`curl https://x.ai/cli/install.sh`, subscription-gated) — both install a
`grok` command, so confirm which one is on the user's PATH before integrating.

| Question | Initial research finding (superseded by the resolved notes below) |
|---|---|
| Install | `curl -fsSL https://raw.githubusercontent.com/superagent-ai/grok-cli/main/install.sh \| bash` or `bun add -g grok-dev` → binary **`grok`** |
| Launch | `grok` (interactive TUI), `grok -d <dir>`; headless `grok --prompt "..."` with `--format json` |
| Auth | `GROK_API_KEY` env var / `.env` / `grok -k <key>` / `~/.grok/user-settings.json` `"apiKey"` |
| YOLO flag | **Not documented** — no auto-approve/force flag found in README; sandbox/hooks settings live in `~/.grok/user-settings.json` (open question 1) |
| Resume | `grok --session latest` or `grok -s <session-id>` — flag-based, fits the default `resume-command.ts` shape |
| Pin id at launch | Not documented → assume marker-based binding (layer 3) needed |
| Session storage | Project-level `.grok/` + user-level `~/.grok/` — exact session file path/format not documented (open question 2) |
| Config | Project `.grok/settings.json` (model), user `~/.grok/user-settings.json`; instructions via `AGENTS.md` / `AGENTS.override.md` |
| Model | `grok models` to list; `GROK_MODEL` env or settings; defaults like `grok-4.3` |
| MCP | Supported — user-level `~/.grok/user-settings.json` under `mcp.servers` (a **list**; each entry needs `id`, `label`, `transport`, `url`). The README's project-level `.grok/settings.json` `mcpServers` is not read by v1.1.7. |

Spec entry (verified — no permission flag needed):

```ts
{
  agentKey: 'grok',
  label: 'Grok CLI',
  defaultCommand: 'grok',
  // no skipPermissionFlag: grok-cli has no tool-confirmation gate at all
  hint: 'generalist'
}
```

Open questions — ALL RESOLVED 2026-07-10 by reading the source
(github.com/superagent-ai/grok-cli, v1.1.7):

1. **YOLO/auto-approve**: no tool-execution confirmation gate exists — bash /
   file / edit tools run automatically in TUI and headless modes. The only
   approval flow is for x402 *payments* (`autoApprove` in user-settings is
   payment-only). → omit `skipPermissionFlag`.
2. **Session storage**: single shared SQLite DB `~/.grok/grok.db` (WAL,
   busy_timeout 5s), NOT per-project files. Tables: `workspaces` (id =
   sha1(git root), 16-hex), `sessions` (id = 12-hex uuid slice), `messages`
   (`message_json` = full ModelMessage JSON, seq-ordered), `usage_events`,
   `tool_calls/results`. Written synchronously per turn — live reads work.
3. **Token usage**: `usage_events` rows carry `input_tokens`, `output_tokens`,
   `total_tokens`, `cost_micros`, `model`, `session_id` per turn.
4. **Marker persistence**: user message text is stored verbatim in
   `messages.message_json` → `at-pane:<id>` marker binding works; reader
   queries the messages table (open the DB read-only; WAL-aware).
5. **Session listing**: no `grok sessions` command; `--session latest` =
   most-recently-updated session in the current workspace. Reader can
   enumerate ids straight from the `sessions` table.
6. **Concurrency**: safe for distinct sessions (WAL + transactions); no
   per-pane home isolation needed. Sessions are keyed by workspace hash, so
   the log reader filters by `workspaces.root_path` matching the pane's cwd.

Env vars: `GROK_API_KEY` (auth), `GROK_BASE_URL`, `GROK_MODEL`,
`GROK_MAX_TOKENS`, `GROK_TRUST_WORKSPACE` (skips sandbox trust prompt —
useful for spawn env). Runtime note: built on Bun (`bun:sqlite`); the
official install.sh handles runtime setup.

### OpenCode (`opencode`) — added 2026-07-27

Source: https://opencode.ai/docs/cli/ (sst/opencode). Research verified
against installed v1.15.12.

- Core integration: agent spec, marker-based session binding,
  `opencode --session <id>` resume, SQLite log reader, token stats,
  onboarding registry entry, plan-MCP wiring (via `OPENCODE_CONFIG_CONTENT`).
- Deliberately skipped layers: CLI profiles / credential vault (account
  isolation not yet researched), usage/quota provider (no vendor quota API),
  per-pane home isolation (WAL DB is concurrency-safe).

| Question | Finding (v1.15.12) |
|---|---|
| Install | `curl -fsSL https://opencode.ai/install \| bash`; npm package `opencode-ai`; binary **`opencode`** |
| Launch | `opencode` (interactive TUI), `opencode [project]`; headless `opencode run [message..]` |
| YOLO flag | **None for the TUI** — `--dangerously-skip-permissions` exists only on the `run` subcommand; the default TUI command rejects it (verified empirically). Permissions are config-driven (`OPENCODE_PERMISSION` env / permission config) → omit `skipPermissionFlag`. |
| Resume | `opencode --session <id>` / `-s <id>`; also `-c/--continue` (last session) and `--fork` |
| Pin id at launch | Not supported (`--session` only continues existing sessions) → marker-based binding |
| Session storage | Single shared SQLite DB `~/.local/share/opencode/opencode.db` (WAL). Legacy `storage/` JSON dirs are stale except `session_diff/`. Tables: `session` (id `ses_…`, `directory` = cwd, per-session token totals), `message` (`data` JSON with role/tokens/modelID), `part` (`data` JSON; user text verbatim → `at-pane:` marker works), `project` (worktree path). |
| Token usage | Per assistant message in `message.data.tokens` (input/output/reasoning/cache.read/cache.write) and aggregated on the `session` row |
| Workspace filter | `session.directory` equals the pane cwd directly (no hash lookup needed) |
| Concurrency | WAL + per-directory sessions → safe, no home isolation |
| Update / doctor | `opencode upgrade`; no doctor subcommand |
| Env vars | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` (both scrubbed from inherited spawn env), `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_PERMISSION` |

### Batch of six — added 2026-07-28

Six CLIs were integrated in one pass (easy → hard), each via a parallel
frontend + backend agent pair with full test-suite gates between rounds.
MiniMax CLI (`mmx`, a media-generation CLI, not a coding agent) and Z.ai
(no first-party CLI; GLM Coding Plan is a model subscription that plugs
into third-party CLIs) were researched and rejected as agent types — if
supported later, they belong as provider/env profiles on existing CLIs.

| Key | Resume | YOLO | Session storage / reader notes |
|---|---|---|---|
| `qwen` (Qwen Code, npm `@qwen-code/qwen-code`) | `qwen --resume <uuid>` | `--yolo` | Near-clone of Claude Code's JSONL: `~/.qwen/projects/<sanitized-cwd>/chats/<uuid>.jsonl` (+`archive/`); root via `QWEN_RUNTIME_DIR`. Assistant records carry `usageMetadata` (input = `promptTokenCount`, which already includes cached; output = candidates + thoughts). Filter user subtypes `mid_turn_user_message`/`cron`/`notification`. NOT the old Gemini format — the removed gemini reader's assumptions are all stale. |
| `kilo` (Kilo Code, npm `@kilocode/cli`) | `kilo --session <ses_…>` | none for the TUI (`--auto` is `kilo run`-only) | OpenCode fork with an identical schema — `KiloLogReader` subclasses `OpencodeLogReader`, pointing at `~/.local/share/kilo/kilo.db`. `message`/`part` are V1 compatibility projections; re-verify on major Kilo upgrades. |
| `pi` (Pi, npm `@earendil-works/pi-coding-agent`) | `pi --session-id <id>` (also pins new ids at launch) | none — Pi has no permission system at all | JSONL at `~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<id>.jsonl`; header line holds id + cwd. Two traps handled: lazy flush (file only appears after the first assistant reply) and in-place whole-file rewrites (never assume append-only). Tokens per assistant `usage`. |
| `copilot` (Copilot CLI, brew cask `copilot-cli` / npm `@github/copilot`) | `copilot --resume=<uuid>` (unknown id ⇒ starts a new session with that UUID) | `--yolo` | `~/.copilot/session-state/<uuid>/events.jsonl` + `workspace.yaml` (cwd); root via `COPILOT_HOME`. Format captured live from v1.0.75: tokens ONLY on `session.shutdown` `modelMetrics` (input already includes cache, output already includes reasoning) — handled codex-style as cumulative deltas. `assistant.turn_end` is an explicit turn_complete signal. |
| `cursor` (Cursor CLI, closed-source; binary `agent`, older `cursor-agent`) | `cursor-agent --resume=<uuid>` | `--force` (alias `--yolo`) | Hardest reader, entirely defensive: per-session `~/.cursor/chats/<hash>/<uuid>/store.db` with undocumented protobuf `blobs` — marker binding is a raw UTF-8 bytes scan (capped), workspace filter treats md5(cwd) as best-effort only, and **no token data exists locally** (empty stats are expected). Community-reverse-engineered layout, NOT yet validated against a live install; the IDE's `~/.cursor/projects/*/agent-transcripts/*.jsonl` is a different store — do not read it. |
| `aider` (Aider, pip `aider-chat`) | `aider --restore-chat-history` (no session id — lossy, may be LLM-summarized) | `--yes-always` | Only Markdown reader: per-project `<git root>/.aider.chat.history.md`, sections split on `# aider chat started at …` (session id = started-at slug), user lines `#### ` (markers bind against the LAST section only), tokens from `> Tokens: X sent, Y received` lines. Watcher routes via the `LogReader.claims_path()` hook added for this; events are rescan-driven (~30s latency). No Rebuild button and no detecting-session overlay on the frontend — both depend on real session ids. |

### Droid (`droid`, Factory) — added 2026-08-27

Homebrew cask (`brew install --cask droid`), verified against 0.204.0. The
integration is a close structural twin of Claude Code — per-cwd session
directories, hook events of the same names — which is exactly what made it
dangerous: three properties that *look* like Claude's are not, and each one
fails silently rather than loudly.

| Aspect | What holds for droid |
|---|---|
| Resume | `droid --resume <uuid>` (`-r` is the same option). `--session-id` exists only on `droid exec`, so an interactive pane cannot pin an id at launch — hence `needsSessionMarker: true` plus the single-candidate cwd fallback. |
| YOLO | `--auto high`. `--skip-permissions-unsafe` is documented only under `droid exec`; the interactive binary **silently ignores unknown flags** (confirmed with a deliberately bogus one), so a probe that "didn't error" proves nothing — the same trap that shipped a crashing `--auto` for opencode. |
| Session storage | `~/.factory/sessions/<encoded-cwd>/<uuid>.jsonl`, **not** the `projects/` path the docs describe. Also falls back to a flat `sessions/` and `sessions/btw/` for forks — `session_exists` checks all three, or a forked pane is reported missing and replaced. |
| cwd encoding | Replaces **only path separators** (`realpath` → strip trailing seps → strip leading `/` → each `/` run → `-`, then one leading `-`). `encode_claude_cwd` flattens every non-alphanumeric character and therefore **cannot** be reused: it would miss the directory for any path holding a dot, underscore or hyphen. |
| Turn end | A separate `agent_turn_outcome` record (`{turnId, reason, resultKind}`) with 17 `reason` values. There is no `stop_reason` field in the JSONL at all — that name appears in the binary only inside the bundled Anthropic SDK and in OTel attributes. Every outcome emits `turn_complete` whatever the reason: a cancelled turn has still stopped, and withholding the event parks the pane mid-turn forever. |
| Tokens | Absent per message (only an opaque `tokens` integer). The breakdown lives in the sidecar `<uuid>.settings.json` as a **running total**, so the reader differences it and keeps one replace-in-place marker rather than a key per line (GitHub #23). `thinkingTokens` is deliberately not added to output pending a real session. |
| Env | `DROID_PARENT_SESSION_ID` is droid's `CLAUDE_CODE_CHILD_SESSION`: inherited, a spawned pane becomes a child of the parent's session and silently writes no transcript of its own. Stripped via `home_env_vars`, along with `FACTORY_HOME_OVERRIDE` and `FACTORY_RUNTIME_SETTINGS_PATH`. |
| Terminal | Emits `ESC[?2004h` during startup (`bracketedPaste: true`) and never `ESC[?1049h` — it repaints the normal buffer, so `fullScreenTui` stays unset. |

Record shapes came from droid's own zod schemas and read loops inside the
250MB bundle, cross-checked against a real session file. `verifiedTurnText`
stays unset: no authenticated session has exercised the assistant/outcome path
yet.
