# External MCP Control

Navide exposes an MCP (Model Context Protocol) endpoint, `/plan-mcp`, that a
CLI agent running in a Navide pane uses automatically. That same endpoint can
also be opened to a client outside Navide's own process tree — a script, an
AI agent running elsewhere, or any MCP-capable tool — so it can drive a
running Navide window: open panes, invoke UI actions, read another agent's
conversation log, and manage plan documents.

This is off by default. Turning it on means **any process running on your
Mac can control Navide** — see [Security model](#security-model) before
enabling it.

For the two directions every pane already gets automatically (Navide handing
tools to its own CLI agents, and Navide consuming external documentation MCP
servers during a pipeline run), see the "說明" tab under Settings → MCP in
the app ([`McpHelp.vue`](../../src/renderer/src/components/McpHelp.vue)).
This document covers the third, opt-in direction: an external client
controlling Navide.

## Connecting

1. Open **Settings → MCP → External access** and turn on **Allow external
   MCP clients**.
2. Copy the **Connection URL**. It has the form:

   ```text
   http://127.0.0.1:<port>/plan-mcp?client=external&t=<token>
   ```

   `<port>` is the backend's current port (it is chosen dynamically at
   launch, so the URL changes across restarts — re-copy it after restarting
   Navide) and `<token>` is a bearer secret scoped to external callers only.
3. Point your MCP client at that URL over **streamable HTTP**. No further
   handshake or registration is needed — every tool call is authenticated by
   the token in the URL's query string.
4. **Regenerate token** in the same panel invalidates the old token
   immediately and mints a new one; use it if a URL may have leaked.

The endpoint only accepts three kinds of caller credential: a pane's own
credential (minted when Navide spawns a claude/codex pane), this backend's
internal "host" credential (used by its own CLI wiring), and the external
credential described above — gated on the Settings toggle. An external
caller has no pane identity and therefore no workspace of its own: every
tool that addresses a pane (`cli_send`, `cli_read_log`, `cli_get_status`,
`cli_wait_idle`) requires the fully-qualified `<folder>/<pane>` form rather
than a bare pane name, and every tool that addresses UI state
(`ui_invoke`, `ui_snapshot`, `ui_list_actions`) or a plan document
(`plan_*`) requires an explicit `workspace_path` — a caller running as a
pane may omit it and get that pane's own workspace.

Implementation: [`plan_mcp.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp.py)
(tools), [`plan_mcp_auth.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp_auth.py)
(credential store, `plan_mcp_auth.json` under the app data directory), and
[`plan_mcp_wiring.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp_wiring.py)
(pane/host wiring — not needed for an external client).

## Tool catalog

### Plan documents

| Tool | Parameters | What it does |
|---|---|---|
| `plan_list` | `workspace_path` | List plan documents under `.agent-team/plans/`: `rel_path`, `name`, `stage`, `overview`, `todos` summary, `mtime` |
| `plan_read` | `workspace_path`, `rel_path` | Read one plan's parsed meta and raw HTML |
| `plan_create` | `workspace_path`, `name`, `overview`, `todos` | Create a plan from the template, starting at stage `draft` |
| `plan_update_stage` | `workspace_path`, `rel_path`, `stage` | Set stage: `draft`, `in-review`, `approved`, `in-progress`, `done`, `abandoned` |
| `plan_update_todo` | `workspace_path`, `rel_path`, `todo_id`, `status` | Set one todo's status: `pending`, `in-progress`, `done`, `skipped` |
| `plan_add_note` | `workspace_path`, `rel_path`, `text`, `author?` (`ai`\|`user`, default `ai`) | Append a review note |

`workspace_path` is required here because an external client is not a pane;
a pane caller omits it and the tools use that pane's own workspace, which is
what the plan window resolves plans against.

`plan_create` returns a `warning` field when `workspace_path` doesn't match
any live pane's workspace — the file is written, but Navide's plan window
won't find it.

`plan_list` returns a list, and MCP delivers a list as **one content block
per item** rather than a single JSON array. Concatenating the blocks and
parsing once fails with `Extra data`; parse each block on its own, or read
the call's `structuredContent`. Every other tool here returns a single
object, so this only bites on `plan_list`.

### CLI panes — messaging and spawning

These tools feed the same delivery queue an agent reaches by printing a
bare-line `---MSG-START---` block; [Inter-CLI messaging](inter-cli-messaging.md)
documents the addresses, the idle gate and the guard rails they share.

| Tool | Parameters | What it does |
|---|---|---|
| `cli_list_targets` | — | List addressable CLI panes: `name`, `address`, `workspace_path`, `same_workspace`, `busy` |
| `cli_send` | `to`, `text` | Deliver an instruction to another pane once it's idle (queued if busy); returns `msg_key` |
| `cli_check_message` | `msg_key` | What became of one `cli_send`: `{status, target, age_seconds, reason?, settled_after_s?}` |
| `cli_send_and_wait` | `to`, `text`, `timeout_s=60` (capped at 120) | `cli_send` plus the wait for that turn to finish; returns `cli_wait_idle`'s result plus `{ok, target, msg_key}` |
| `cli_open_agent` | `agent`, `name`, `task`, `workspace_path` (required for a non-pane caller) | Spawn a new CLI pane with a task; returns `{ok, name, address}`, plus `advisories` when the spawn crossed an advisory threshold |

`cli_send` returns once the message is *accepted* for delivery, not once the
other agent read it. `cli_check_message` closes that loop: `status` is
`queued` (broadcast, no window has reported back — a message held for a busy
pane stays here until it is actually injected), `delivered`, or `failed`.
On `failed`, `reason` is the receiving window's verdict: `rate-limit` (too
many messages between the same pair too quickly), `queue-full` (the target's
pending-message queue is at its cap), `inject-failed` (typing it into the
pane did not take), `pane-closed` (the target went away before delivery), or
`no-report` (the attempt never reported an outcome).

A failure is also pushed at the sending pane without being asked for: Navide
writes a `[Navide MSG] delivery failed` notice naming the target and the
reason into that pane once it is idle, through the same queue and injection
path as an ordinary message. It is a heads-up for an agent that never polls —
`cli_check_message` stays the authoritative answer, and the notice is not
addressable, so nothing should reply to it.

That table is backend **memory**, not a log: it holds the last 500 sends for
one hour and is lost on backend restart. An unknown `msg_key` returns
`{ok: false, error}` and means "not tracked any more", not "never sent".

`cli_send_and_wait` handles the race a manual `cli_send` + `cli_wait_idle`
pair loses to — the target is idle at the moment you send, so a plain wait
returns "already idle" before it ever read the message. It records the
target's last activity before sending and only accepts a *newer* turn as the
answer, so `last_activity.text` is what the other agent said in reply. Its
timeout `reason` is `cli_wait_idle`'s, plus `never_started` for a target that
stayed idle and never showed any sign of picking the message up. A send
refused outright returns `cli_send`'s `{ok: false, error}` unchanged.

If the target stops being addressable *during* the wait — its window closed,
its pane was killed — the result is `{ok: true, idle: false, source:
"target_lost", error}`. It stays `ok: true` deliberately: the send already
happened and the `msg_key` is still valid, so reporting a failure there would
read as "never sent" and invite a resend, dispatching the work twice. Read it
as "delivered, but I can no longer confirm it was finished".

Spawning is not capped. A pane may spawn any number of children, a workspace
may hold any number of CLI panes, and a spawn chain may run any depth — past
advisory thresholds (3 children, 8 workspace panes, depth 2) the call still
succeeds and returns `advisories` naming the cost, e.g. that each pane holds
250-500MB. What still fails is a malformed request: an unknown agent key, a
missing or already-taken name, an empty task. Those advisories are also
recorded as diagnostics, readable via `ui_diagnostics`.

### CLI panes — reading back

| Tool | Parameters | What it does |
|---|---|---|
| `cli_read_log` | `target`, `tail_lines=200`, `since?` | Tail of the pane's conversation log (≤512KB and ≤`tail_lines` lines); returns `next_cursor` and `rotated` |
| `cli_get_status` | `target` | `{busy, agent_key, last_activity?, ui?}` — `ui` mirrors `ui.pane.getStatus` when the owning window answers |
| `cli_wait_idle` | `target`, `timeout_s=60` (capped at 120) | Blocks until the pane is idle or the timeout passes; returns `{idle, source, waited_s, last_activity?, ui_status?}`, plus `reason` on timeout |

`cli_read_log`'s `since` reads incrementally: pass back the `next_cursor` from
your previous call to get only what the pane has said since then, instead of
re-reading the same tail. The cursor is a byte offset into an append-only
capture file, so it stops meaning anything if that file is truncated or
replaced — the call then returns a plain tail with `rotated: true`, which is a
fresh start rather than new output.

`cli_wait_idle`'s `last_activity` is what `cli_get_status` reports under the
same key, so a caller that waited out a turn also gets what the turn said
without a second call; `ui_status` is the owning window's own word for the
pane, present only when a probe reached it during the wait. On timeout,
`reason` separates three failures that look alike but aren't: `awaiting` (the
pane is parked on a permission prompt, waiting on a **human** — answer it in
the UI), `busy` (it really is still working; wait longer), and `unreachable`
(the window that owns the pane stopped answering, so nothing in the result is
current).

**Capability boundary — idle/completion detection.** Most CLIs' log readers
emit a `turn_complete` event carrying the finished turn's text: **aider,
antigravity, claude, codex, copilot, cursor, grok, kilo, kimi, muse,
opencode, pi, qwen**. For those, `cli_wait_idle` and `cli_get_status`'s
`last_activity.type` resolve on the precise turn-complete signal — with one
qualification: **grok, kimi, pi, qwen** have no end-of-turn record of their
own and synthesize `turn_complete` from 8 seconds of silence in the log, so
for those four the event is itself an inference, and a long enough pause
mid-turn can end the wait early. For a plain terminal pane there is no such
signal at all —
`cli_wait_idle` falls back to inferring idleness from a 10-second quiet
period with no new activity (`source: "quiet_period"` in the response), and
`cli_get_status`'s `last_activity` may only ever report `"agent_active"`.
Treat a quiet-period-based idle result as a heuristic, not a guarantee the
CLI has actually finished.

This is also why `source` is the field to read on a `cli_send_and_wait`
result: the shape is identical whichever CLI produced it, but the confidence
is not. `turn_complete` from aider/antigravity/claude/codex/copilot/cursor/
kilo/muse/opencode is the CLI's own word that the turn ended; the same value
from grok/kimi/pi/qwen is the 8-second-silence inference above; and
`quiet_period` — the only outcome available for a plain terminal pane —
means nothing reported an end of turn at all, so check the content
rather than trusting the signal. `target_lost` is the fourth value and the
only one that is not a verdict on the turn: it says the pane went away before
the wait could reach one.

### UI action bus

| Tool | Parameters | What it does |
|---|---|---|
| `ui_list_actions` | `workspace_path` | List every command id registered in the Navide window that owns `workspace_path` |
| `ui_invoke` | `workspace_path`, `action`, `args?` | Invoke one registered action, passing `args` through verbatim |
| `ui_snapshot` | `workspace_path` | Structured snapshot of that window's UI state |

All three wait up to 15 seconds for the owning window to reply, and error if
no window currently has `workspace_path` open (compared by exact string —
pass the same path the window was opened with). `ui_invoke`'s `action:
"ui.workspace.open"` is the one exception: since no window may yet own that
workspace, it is routed to any one live Navide window instead of the one
matching `workspace_path`.

`ui_list_actions` returns the *entire* command registry the window uses for
its keybindings, not only the `ui.*` ids below — internal ids (e.g.
`workbench.action.*`) exist for keyboard shortcuts and are not a documented
external contract; only the `ui.*` actions in the table below have stable,
documented argument shapes.

#### `ui.*` action reference

| Action | Args | Effect |
|---|---|---|
| `ui.settings.open` | `{tab?}` (one of `general`, `mcp`, `analyzer`, `updates`, `appearance`, `accounts`, `storage`, `keybindings`) | Open Settings, optionally to a specific tab |
| `ui.settings.close` | — | Close Settings |
| `ui.pane.create` | `{agent, name?, task?}` | Spawn a pane for `agent` in the window's open workspace; `task`, if given, is sent as the kickoff prompt and skips role injection |
| `ui.pane.close` | `{paneId}` | Kill a pane |
| `ui.pane.focus` | `{paneId}` | Reveal and focus a pane (switches tab if needed) |
| `ui.pane.getStatus` | `{paneId}` | Returns `{status, buffer, logPath?}` for that pane |
| `ui.tab.switch` | `{tabId}` | Switch the active stage/run-group tab |
| `ui.window.openPlans` | — | Open the Plan window |
| `ui.window.openGit` | — | Open the Git window for the current workspace |
| `ui.window.openPipeline` | `{pipelineId?}` | Open the Pipeline Manager window |
| `ui.workspace.open` | `{path}` | Open `path` as a workspace (routed to any live window — see above) |
| `ui.layout.setMode` | `{mode}` | Change the pane layout mode |

This list is maintained in code, not here — verify against the
`registerCommand('ui.*', …)` block in
[`App.vue`](../../src/renderer/src/App.vue) before relying on an exact
argument shape.

`ui_snapshot`'s shape is decided by the renderer
(`buildUiActionSnapshot` in `App.vue`): `{workspace, panes: [{id, name?,
agentKey, workspacePath, status?}], activeTab, settingsOpen,
openWorkspaces}`.

## CDP debug (escape hatch)

Settings → MCP → External access also has a **Chrome DevTools Protocol**
toggle ([`src/main/cdp-debug.ts`](../../src/main/cdp-debug.ts), config in
`userData/cdp-debug.json`). Enabling it requires an app restart — Electron
only honors `--remote-debugging-port` when set before the app is ready — and
the debug port binds to `127.0.0.1` only.

This is a fallback, not the primary integration path: use the tool catalog
above for anything it covers. CDP exists for what isn't — taking a
screenshot of the actual rendered window, or driving something with no
registered `ui.*` action. Treat it as a last resort, because of what it can
do (see below).

## Security model

| Enabling this... | ...means |
|---|---|
| **Allow external MCP clients** | Anything running on this machine can control Navide while it's on: spawn and close panes, send instructions to any CLI pane in any open workspace, open plans/Git/Pipeline windows, and read another pane's conversation log. |
| **CDP debug** | Anything running on this machine can execute arbitrary code inside Navide's renderer while it's on — full remote-debugging access, not scoped to any tool contract. |

Practical notes:

- Both toggles bind to `127.0.0.1` only — no LAN or remote exposure — but on
  a shared machine, "this machine" includes every other local user account
  and every other process running as you.
- The external token is a bearer secret: anyone with the Connection URL has
  full external access until you regenerate the token. It is stored in
  plaintext in `plan_mcp_auth.json` under the app data directory.
- Filesystem writes through these tools are still bounded by the same path
  guard the rest of the backend uses (`fs_service._resolve_safe`) — plan
  tools can only write inside a workspace's `.agent-team/plans/`. UI actions
  and CDP have no equivalent sandbox: a UI action does whatever its handler
  in `App.vue` does, and CDP is unrestricted code execution.
- Turn external access and CDP back off when you're done with whatever
  needed them; neither is meant to be left on by default.

See also: [Privacy and data flows](privacy.md) for Navide's general local-first
data posture, and the in-app "說明" tab under Settings → MCP for the two
directions every pane gets automatically.
