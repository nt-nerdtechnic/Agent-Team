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
tool that addresses a pane (`cli_send`, `cli_send_and_wait`, `cli_read_log`,
`cli_get_status`, `cli_wait_idle`) requires the fully-qualified `<folder>/<pane>` form rather
than a bare pane name — or a `pane_id`, which names one exact pane and is
already fully qualified — and every tool that addresses UI state
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
| `cli_list_targets` | — | List addressable CLI panes: `name`, `address`, `pane_id` (the key every `ui.pane.*` action takes, and an alternative to `address` on the pane tools below), `workspace_path`, `same_workspace`, `busy`, `hold_reason?` |
| `cli_send` | `to`, `text`, `wait_for_delivery_s=0` (capped at 120), `pane_id?` | Deliver an instruction to another pane once it's idle (queued if busy); returns `msg_key`, and with a wait, what became of it |
| `cli_check_message` | `msg_key` | What became of one `cli_send`: `{status, target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?, stale?}` |
| `cli_inbox_summary` | — | Your own sends that are stuck or failed: `{count, messages: [{msg_key, target, status, age_seconds, stale?, reason?, hold?, held_for_s?, excerpt}]}` |
| `cli_pending_incoming` | `limit=20` (capped at 200) | **CLI panes only.** What is queued *for you* and has not gone in yet: `{count, messages: [{uid, sender, status, age_seconds, kind?, excerpt}]}` |
| `cli_send_and_wait` | `to`, `text`, `timeout_s=60` (capped at 120), `pane_id?` | `cli_send` plus the wait for that turn to finish; returns `cli_wait_idle`'s result plus `{ok, target, msg_key}` |
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

**Waiting for the message to land.** Polling only closes the loop for an agent
that remembers to poll, and one that sends and moves on never learns anything.
`wait_for_delivery_s` is the in-band answer: `cli_send` waits that long for the
message to actually go in and reports what happened in the same result.

| Outcome | What comes back |
|---|---|
| It went in | `status: "delivered"`, `settled_after_s` |
| The window refused it | `status: "failed"` (or `"rejected"` from another device), `reason` |
| Still waiting when the clock ran out | `status: "queued"`, `waited_s`, plus `hold` and `held_for_s` when the receiving window said why |

`ok` stays **true** for a refusal, for the same reason `cli_send_and_wait`'s
`target_lost` does: the send happened and `msg_key` is real, so answering
`ok: false` would read as "never sent" and invite a resend that dispatches the
work twice. 10–30s is the useful range — the wait costs the caller's own turn,
and a pane that is mid-turn or being typed into can hold a message far longer.
Left at its default of `0`, the answer is byte-for-byte what it always was.

**Why a message is still queued.** `hold` is the same reason the Messages panel
shows — `{key, n?}`, where `key` is `typing`, `mid-turn`, `behind`, `starting`,
`settling`, `not-ready`, `gone`, `paused` or `remote-ack` — and `held_for_s` is
how long it has been that way. It appears on `cli_check_message` and on a
timed-out `cli_send` wait, and it is absent once the message settles or while
no window has reported one. `cli_list_targets` surfaces the same fact per pane
as `hold_reason`, which is what makes `busy` explainable — but only while a
message sent from here is queued for that pane, so its absence says nothing.

**When it has been queued too long.** `stale` appears on a `queued` message once
it has been waiting more than **two minutes**, on `cli_check_message` and on a
timed-out `cli_send` wait alike. It is not a verdict — nothing has failed and
nothing has given up — it is the point at which "it is on its way" stops being a
safe assumption, so read `hold` next to it and decide whether to keep waiting,
address someone else, or say something to the user. It is measured from the send,
not from the current hold: a message flipping between `mid-turn` and `typing`
restarts `held_for_s` every time, and the case this exists for — the one where no
window ever reported a hold at all — has no hold clock to read.

`cli_inbox_summary` is the same fact without a `msg_key` to ask about. It takes
no arguments, answers about the caller and no one else, and returns every send of
yours that is currently stale or failed — with a 60-character `excerpt` so a
message is recognizable without having kept its key. Delivered messages and
freshly queued ones are left out, so an empty list means "nothing of mine is
stuck", never "nothing was sent". It exists for the agent a notice cannot reach:
a delivery-failure notice is typed back into the sending pane once that pane is
idle, so an agent that stays busy for an hour never sees one, and an external
client has no pane to type into at all. Calling it between pieces of your own
work is how you find out that the message you sent twenty minutes ago is still
sitting in a queue.

That table is backend **memory**, not a log: it holds the last 500 sends for
one hour and is lost on backend restart. An unknown `msg_key` returns
`{ok: false, error}` and means "not tracked any more", not "never sent".

`cli_pending_incoming` is its mirror — what is queued *for you*, oldest first,
with `status` either `queued` or `delivering` and a `kind` of `notice` or
`fallback` on the messages Navide wrote rather than an agent. **It is the one
tool in this section an external client cannot use.** Everything else here acts
*on* a pane; this one asks about the caller's own inbox, and only a CLI pane has
one: a host or external caller has no messaging name for anything to be
addressed to, so the call comes back `{ok: false, error}` rather than an empty
list. Nothing can be addressed to you, so nothing can be waiting for you. An
external client that wants the same picture from the outside reads a pane's
`hold_reason` in `cli_list_targets`, or follows its own sends with
`cli_check_message` / `cli_inbox_summary`.

Unlike the send table above, this one reads the persisted message log, so it
survives a backend restart. Two limits apply: the log is written by the
receiving window a moment after a message is queued, so something sent in the
last second may not be listed yet, and messages are matched by the pane's
**current** messaging name, so anything queued for a name it has since been
renamed away from is not returned.

`cli_send_and_wait` handles the race a manual `cli_send` + `cli_wait_idle`
pair loses to — the target is idle at the moment you send, so a plain wait
returns "already idle" before it ever read the message. It waits for the
message to **go in** first, then records the target's last activity before
sending and only accepts a *newer* turn as the answer, so `last_activity.text`
is what the other agent said in reply. Its timeout `reason` is
`cli_wait_idle`'s, plus `never_started` for a target that stayed idle and never
showed any sign of picking the message up. A send refused outright returns
`cli_send`'s `{ok: false, error}` unchanged.

`timeout_s` covers both halves: **at most half of it** goes to getting the
message in, and whatever is left waits for the turn. Time spent on delivery is
not lost — the message lands when the pane frees up, which is most of what the
idle wait would have sat through anyway — but a message still held at the
halfway mark is unlikely to be answered in what remains, and its hold reason is
a far more useful answer than "timeout, busy". When it never arrives the result
is `source: "not_delivered"` with `delivery_status` (`queued` with `hold` /
`held_for_s`, or `failed` / `rejected` with `reason`). That is the fix for a
message being held while its target sat idle: the old order answered `idle`
from the state it was sent into, which reads as "it finished your work" when
the work was never handed over. Like `target_lost`, it stays `ok: true` — do
not resend on it.

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
| `cli_read_log` | `target`, `tail_lines=200`, `since?`, `pane_id?` | Tail of the pane's conversation log (≤512KB and ≤`tail_lines` lines); returns `next_cursor` and `rotated` |
| `cli_get_status` | `target`, `pane_id?` | `{busy, agent_key, last_activity?, ui?}` — `ui` mirrors `ui.pane.getStatus` when the owning window answers |
| `cli_wait_idle` | `target`, `timeout_s=60` (capped at 120), `pane_id?` | Blocks until the pane is idle or the timeout passes; returns `{idle, source, waited_s, last_activity?, ui_status?}`, plus `reason` on timeout |

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
antigravity, claude, codex, copilot, cursor, droid, grok, kilo, kimi, muse,
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
is not. `turn_complete` from aider/antigravity/claude/codex/copilot/cursor/droid/
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

The path match applies to a caller with no pane identity — an external client
or the host wiring. A call from a Navide CLI pane is delivered straight to the
window hosting that pane, whether or not it is focused and whatever project it
currently has open, so a pane can always drive its own window; `workspace_path`
is still passed through to the action, it just no longer decides who answers.

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
| `ui.preview.show` | `{kind, …}` | Show a file, diff or inline snippet in the right rail's preview panel |
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

### Preview records

Every workspace keeps one feed of what was changed or shown in it, persisted
in that workspace's `.agent-team/navide.db` so it survives a Navide restart.
These three tools are an agent's end of that feed: report your own writes,
read back what other writers reported, and push something in front of the
user.

| Tool | Parameters | What it does |
|---|---|---|
| `preview_record` | `rel_path`, `change="modified"`, `note`, `kind="file"`, `content`, `title`, `workspace_path` | Report a file you just created, modified or deleted; returns `{uid, created_at, rel_path, change, merged}`, plus `warning?` |
| `preview_list` | `limit=50` (capped at 300), `since=0`, `change`, `agent`, `workspace_path` | Read the feed back, newest first; returns `{workspace_path, entries, truncated}`, plus `warning?` |
| `preview_show` | `rel_path`, `kind="file"`, `content`, `title`, `workspace_path` | Push a file, diff or inline content into the right rail's preview panel; returns the window's own `{ok, result, error}` plus `recorded`, and on `ok` also `uid`, `merged` and `warning?` |

`workspace_path` behaves exactly as it does for the `plan_*` tools: a pane
caller may omit it and gets that pane's own workspace; a host or external
caller has no pane identity and must pass it, or the call errors.

Each element of `preview_list`'s `entries` has `uid`, `created_at` (epoch
milliseconds), `change`, `rel_path`, `kind`, `title`, `source`, `pane_id`,
`agent`, `tool`, `note` and `payload`.

| Field | Values |
|---|---|
| `change` | `created`, `modified`, `deleted`, `shown` |
| `source` | `user` (done in the app), `agent` (an MCP call or a CLI hook), `watcher` (the filesystem catch-all, **unattributed**) |
| `kind` | `file`, `diff`, `snippet`, `html`, `markdown` |

`preview_record` accepts only `created`, `modified` and `deleted`. `shown` is
written by `preview_show` alone, and only once the owning window confirms it
took the push — a preview nobody saw is never recorded as shown. `preview_list`'s
`change` filter accepts all four.

`kind` decides which of `rel_path` and `content` is required: `file` and `diff`
address a file and need `rel_path` (workspace-relative); `snippet`, `html` and
`markdown` *are* the payload and need `content`, capped at 512 K characters —
over that the call is rejected outright rather than truncated. `note` is
capped at 500 characters and is truncated rather than rejected.

**Attribution is read off the caller's credential**, never off an argument:
the recorded `pane_id` and `agent` are the calling pane's own, and there is no
parameter that lets a caller claim to be a different pane. A host or external
caller records without attribution.

`merged: true` means the event folded into a record already on the feed — same
path, same change, within 2 seconds, typically because the filesystem watcher
got there first — so nothing new was added, and `uid` is `""` with `created_at`
0. The feed keeps the newest 300 rows per workspace and drops the oldest past
that.

`warning` means the same thing it does on `plan_create`: no live Navide pane
uses `workspace_path`, so the record landed where the user is not looking.

**The feed has writers other than these tools.** When a CLI agent edits a file
through `Write`, `Edit`, `MultiEdit` or `NotebookEdit`, Navide records it
automatically and with full attribution — but only for the vendors that have a
hook mechanism, currently **claude, qwen and copilot**. Every other file change
is caught by the filesystem watcher and recorded with `source: "watcher"` and
no attribution. `preview_list` is therefore a fuller picture than the sum of
the `preview_record` calls made against a workspace, and an entry without a
`pane_id` means nobody claimed the change — not that nothing made it.

## A pane's id outlives its pane

A CLI pane's connection URL is written once, when the pane spawns, and the CLI
process keeps it for as long as it runs. The `pane=<id>` in it is that pane's id
at that moment — and a pane id belongs to the pane, not to the process inside
it. Reloading a window, detaching a run group, or taking one back from a
detached window rebuilds the pane around the same running CLI and gives it a new
id, leaving the URL naming the old one.

That old id still works. The window records where it went, so a call carrying it
is answered as the pane the process is actually attached to: the same workspace
the `plan_*` tools default to, the same `you` in `cli_list_targets`, the same
identity `cli_send` checks a bare name and a self-send against. Reloading twice
does not break the chain — each hop is flattened onto the current pane — and an
id is never allowed to follow a pane into another workspace.

An id is an address as well as an identity. `cli_send`, `cli_send_and_wait`,
`cli_read_log`, `cli_get_status` and `cli_wait_idle` each take a `pane_id` that
is used in place of their address argument, and it is the only way to reach one
of two panes in a workspace that share a name — a name matching both is refused
as `ambiguous-target` rather than guessed at. It resolves through the same
table, so an id that outlived a reload or a detach addresses the pane it
followed. What it does not outlive is a pane rebuilt around a *fresh* CLI: that
path declares no former ids, and those tools answer `unknown-pane-id`, which
means "read a fresh id from `cli_list_targets`", not "that pane is gone". A
remote pane's id was minted by another machine's registry and is not one of
these, so a cross-device target is still addressed by name.

A pane's [push channel](inter-cli-messaging.md#push-channels) mostly follows the
same way, with one exception. A window reload keeps it, and so does a run group
coming back from a detached window. A **detach** does not: the window handing
the pane over releases it — and its channel with it — before the receiving
window claims the pane, so a detached pane is typed into as it was before
channels existed, until its CLI is restarted. A Claude pane is unaffected: its
hook re-arms itself at the next turn end.

Which id superseded which is something a Navide window declares, and it is taken
at its word — during a detach the id being claimed is still live and owned by
the window letting go of it, so a claim over a live pane cannot be told apart
from a legitimate hand-over and is logged rather than refused. The one
irreversible consequence is refused separately: a pane a connected window still
mirrors never gives up its push channel, whoever asks.

One case is known to log that warning without a hand-over behind it: a main
window reloading while one of its run groups is detached restores that group's
panes before it learns the group is somewhere else, and briefly claims the child
window's ids. It corrects itself the moment the window is told, and the child's
push channel is never taken.

What is still refused is an id that names nothing at all: the pane was closed,
or the window that owned it has been gone long enough to be forgotten. There is
no identity left to act as, so every tool on the endpoint answers `this pane's
id is stale`, and reopening the pane is the remedy. (That is a different word
from the `stale` flag on a queued message above, which only says a message has
been waiting more than two minutes.)

This is not the same problem as the tool *list* below. The list is a snapshot
the client took when it connected and Navide has no way to refresh it; the id is
resolved by Navide on every call.

## The tool list is read once

An MCP client asks for a server's tool list when it connects, and Navide's
`/plan-mcp` never changes it afterwards. So **whatever a client saw at that
moment is what it keeps**:

- A **CLI pane** snapshots the list when its CLI process starts. A pane that was
  already running when Navide was updated is talking to a backend that no longer
  exists; reopen the pane to pick up tools or parameters a newer Navide added.
- An **external client** keeps its list until you reconnect it. The connection
  URL changes across restarts anyway (the port is picked at launch), so this
  usually resolves itself.

After an upgrade Navide says so once, in the announcements feed in the status
bar: a "MCP tools may have changed" entry naming the version it replaced. It
appears only when this backend actually started at a different version than the
previous one — never on a first install, and never on an ordinary restart.

### Why Navide does not just tell the clients

The protocol has an answer for this — a server declares the `tools.listChanged`
capability and then sends `notifications/tools/list_changed` when its tool set
changes, and a client that handles it re-reads the list mid-session. Navide
cannot use it, for two independent reasons.

**The transport has nowhere to push.** `/plan-mcp` runs streamable HTTP in
stateless mode with JSON responses: a transport is built and torn down per
request, and no stream is held open. A server-initiated notification has no
route to a client in that configuration — the MCP SDK addresses it to a
long-lived stream, finds none, and drops it. Making it deliverable would mean
running the session-oriented mode instead, which is the state this endpoint is
deliberately built without. (The 2026-07-28 revision of the spec removed
protocol-level sessions and moved these notifications onto a client-opened
`subscriptions/listen` stream — a held-open stream either way.)

**Half the CLIs would ignore it.** Verified against each client's own source or
documentation, 2026-08-17:

| CLI | Re-reads the tool list on `list_changed`? |
|---|---|
| Claude Code | Yes, since 2.1.0 |
| GitHub Copilot CLI | Yes |
| OpenCode | Yes |
| Grok | Yes |
| Codex CLI | No — logs the notification and does nothing |
| Cursor (`cursor-agent`) | No — refresh is manual, via `/mcp` |
| Qwen Code | No — the fork dropped the handler upstream Gemini CLI has |
| Kimi CLI | No — no notification handling at all |

And there is nothing to notify about in any case: every `/plan-mcp` tool is
registered at import, and the set never changes while the backend runs. Reopening
the pane is the whole remedy, which is why it is documented rather than
engineered around.

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
