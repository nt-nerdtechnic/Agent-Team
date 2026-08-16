# Inter-CLI messaging

Two CLI agents running in Navide can talk to each other. Neither needs an API,
a shared file, or a plugin — an agent addresses another one by printing a few
plain lines, and Navide types the message into the other pane once it is free.

This document is the reference for that protocol: the addresses, the wire
format, what an agent sees when a message arrives or fails, and the rules that
decide when a message is actually delivered.

Everything here stays on the machine. Messages travel between panes in the app;
they are never sent anywhere else.

An external MCP client reaches the same delivery queue through `cli_send` —
see [External MCP control](external-mcp-control.md).

---

## Addresses

Every CLI pane has a **messaging handle**, and it is the same string the pane
shows as its title. The name you see is the address.

- A new pane starts at `<agent key>-<n>` — `claude-1`, `codex-2`.
- Renaming a pane renames the handle. If the new name is already taken, Navide
  asks for a different one; cancelling abandons the rename entirely.
- Clearing a pane's title returns the handle to the auto-derived title, or to
  the vendor label when there is none.
- Handles survive a restart.
- Plain terminal panes have no handle. They cannot send or receive.
- `Navide` is reserved — it is the name Navide's own messages come from. A pane
  titled that takes a suffix (`Navide-2`), and renaming a pane to it is refused.

Typing `@` in a CLI pane opens a completion menu of every handle you can
address from there, including panes in other workspace windows. Dropping a pane
onto another pane right after typing `@` inserts that pane's address.

---

## Sending

An agent sends by printing a block on **bare lines** — no leading whitespace,
never inside a fenced code block:

```
---MSG-START--- to: reviewer
Please review src/main.ts and reply with the blocking issues only.
---MSG-END---
```

(The examples here are fenced so this page renders them. An agent must print
them unfenced — content inside ``` or ~~~ is deliberately ignored by the
parser, which is what keeps a code sample containing these markers inert.)

Rules the parser applies:

- The `to:` field takes everything up to the optional `re:` field.
- A missing `---MSG-END---` is tolerated: the block closes at the next
  `---MSG-START---` or at the end of the turn.
- A block with an empty target or empty body is dropped.
- One turn may contain several blocks; all of them are sent.
- Any `---MARKER---` token inside the body is broken with zero-width spaces
  before delivery, so forwarded text can never re-trigger a parser.

### Broadcast

`to: all` (or `to: *`, case-insensitive) fans the message out to every other
pane **in the same workspace window**. Each recipient gets an ordinary
independent message — its own queue slot, rate-limit budget, and log row.
Broadcast never crosses a workspace.

### Another workspace

Address a pane in another workspace window as `<folder>/<pane>`:

```
---MSG-START--- to: Agent-Team/reviewer
Rebased onto main — please re-run the suite.
---MSG-END---
```

When two open workspaces share a folder name, use the full path
(`/Users/me/Agent-Team/reviewer`). A target containing no `/` is always
resolved inside the sending window.

### Replies

A delivered message carries a correlation id. Echoing it back in the `re:`
field links the reply to the message it answers, which is what the Messages
panel uses to thread the two rows together. A reply written without `re:` is
still delivered — it just arrives unlinked.

---

## Receiving

A delivered message is typed into the target pane like this:

```
[Navide MSG] from: builder-1
Please review src/main.ts and reply with the blocking issues only.
（回覆方式：輸出裸行區塊 ---MSG-START--- to: builder-1 re: 4f2a…，下一行起為訊息內容，最後一行 ---MSG-END---；re 欄位請原樣帶回，marker 必須獨立整行且不可放在 code block 內）
```

The first line always identifies the sender. The trailing hint is what teaches
a pane that was never given the protocol how to answer; it is a single line, so
it can never be mistaken for a marker.

### Delivery failure notices

When a message cannot be delivered, the **sending** pane is told:

```
[Navide MSG] delivery failed — to: reviewer
reason: No pane named “reviewer”
（原訊息開頭：Please review src/main.ts and reply with the blocking…）
```

The reason is always in English — an agent reads it, and the Messages panel
localizes the same fact separately for you. The notice goes through the ordinary
queue and idle gate, so it arrives once the sending pane is free rather than
interrupting it mid-turn.

A notice is not an address: nothing should reply to it, and a notice that
itself fails to deliver is only logged — it never produces a second notice.

Senders that are not a live CLI pane in the window get no notice: a pane that
closed before the failure, a plain terminal, or an external MCP client (which
has `cli_check_message` to poll instead).

### Spawn feedback notices

A spawn request that does not work out is reported the same way, to the pane
that asked for it:

```
[Navide MSG] spawn failed — 名稱「reviewer」已被其他 pane 使用，請換一個名稱
```

```
[Navide MSG] spawn partial — pane「reviewer」已開啟，但任務注入失敗，請自行確認
```

The two prefixes are deliberately different because they call for opposite
responses. `spawn failed` means no pane was created — fix the request and try
again. `spawn partial` means the pane **is** open and only its task never
landed; spawning it again would collide with the pane already there.

A successful spawn sends nothing: the new pane reports to its parent itself,
with an ordinary MSG block.

Both of these are system notices, exactly like a delivery failure — Navide
wrote them, nothing can address `Navide`, and they should not be replied to.
In the Messages panel they carry a `system notice` badge and no Resend.

---

## Spawning a pane

The same bare-line discipline carries a spawn request. The new pane is created
with the task as its kickoff, and reports back to its parent with an ordinary
MSG block:

```
---SPAWN-START---
agent: codex
name: reviewer
task: Review the diff on this branch and report blocking issues.
---SPAWN-END---
```

`agent:` is an agent key, `name:` must be free, and `task:` runs from that
field to the end of the block. Spawning is not capped — past advisory
thresholds the call still succeeds and the requester is told what it costs. A
malformed request (unknown agent key, missing or taken name, empty task) comes
back as a [spawn feedback notice](#spawn-feedback-notices) naming the problem.

---

## How delivery actually works

**Messages are read from turn text, not from the screen.** Navide parses a
pane's completed turn as reported by that vendor's log reader — it never scans
the terminal buffer. Two consequences worth knowing:

- A message goes out when the sending turn ends, not the moment it is printed.
- A vendor whose log reader does not carry the assistant's text cannot send
  messages at all. Receiving still works.

**Delivery waits for the target to be idle.** A message is injected only when
the target pane is alive, past startup, not mid role or kickoff injection, its
CLI has reported the turn ended, and it has been quiet for ~2s. A pane sitting
on a permission prompt is deliberately excluded; a pane sitting on a question
is not. For the vendors whose logs carry no end-of-turn record, "the turn
ended" is inferred from a long enough silence instead, so those panes accept a
message a little later than the rest.

**One at a time, in order.** Each target has its own FIFO queue and at most one
injection in flight. Injection itself is a bracketed paste plus a verified
submit — if the pane never echoes the text back, the message is failed rather
than assumed delivered.

**Cross-workspace delivery belongs to the receiving window.** The sending
window hands the address to the backend registry, and the window that owns the
target pane queues, injects and reports the outcome. Until that report arrives
the message stays queued. If the report never comes — the other window was
killed, the machine slept — the message is failed after about 30 minutes.

---

## Guard rails

| Guard | Limit |
|---|---|
| Rate limit per sender→target pair | 5 messages per 60s |
| Pending messages per target pane | 10 |
| Delivery log | last 500 rows |
| Global pause | Messages panel header |

The pair budget is what stops two agents from talking each other into a loop. A
retry from the panel spends it like any other send. Delivery-failure notices
carry their own separate budget, so feedback can never consume a sender's quota.

---

## The Messages panel

The right rail's **Messages** tab is the delivery log: every message this
window sent or received, newest first, with its status and — while it is still
queued — why it has not gone out yet.

- **Pause / Resume** stops and restarts injection for the whole window.
- **Clear log** drops finished rows and keeps the ones still in flight.
- **Resend** re-sends a failed row as a brand-new message, re-validating
  everything from scratch, so it can fail again for a different reason.
  Delivery-failure notices carry a `system notice` badge and no Resend — a
  notice only reports another row's failure, and that row has its own.
- The log is mirrored into the backend store and restored on reload. Rows
  that were still in flight when the window died come back as failed
  (`window-reloaded`) — queues do not survive a reload, and nothing is
  re-delivered automatically.

### Why a message is still queued

| Hold | Meaning |
|---|---|
| `behind` | Waiting behind other messages for the same target |
| `busy` / `not-ready` | Target pane is not in a state that accepts input |
| `starting` | Target pane is still starting up |
| `mid-turn` | Target agent is working |
| `settling` | Target just went quiet; waiting for it to settle |
| `paused` | Delivery is paused for the window |
| `gone` | Target pane no longer exists |
| `remote-ack` | Sent to another window; awaiting its report |

### Why a message failed

| Reason | Meaning |
|---|---|
| `unknown-target` | No pane with that handle |
| `self-send` | A pane addressed itself |
| `rate-limit` / `queue-full` | A guard rail above |
| `pane-closed` | The target closed before delivery |
| `inject-failed` / `inject-error` | Typing it into the pane did not take |
| `window-reloaded` | The window reloaded while it was in flight |
| `no-report` | The other window never reported an outcome |
| `unknown-workspace` / `ambiguous-workspace` | A `<folder>/<pane>` address that matched no open workspace, or several |
| `unknown-target-in-workspace` / `ambiguous-target` | The workspace resolved, but the pane name did not — or matched twice |

---

## Teaching an agent the protocol

- **Pipeline slots** get the protocol automatically: every slot kickoff is
  prefixed with the messaging and spawn instructions.
- **Manually opened panes** are not given it up front. The reply hint on the
  first message they receive is enough for a reply, and they can be handed the
  protocol at any time by pasting it into the pane.
- Handles change as panes are renamed, so an agent should re-read the `@`
  completion list rather than remembering an address from earlier in a session.

---

## Where this lives

| Concern | File |
|---|---|
| Markers, parser, envelope and notice rendering (pure functions) | `src/renderer/src/lib/agentMessaging.ts` |
| Handle registry, queues, guard rails, delivery state machine | `src/renderer/src/composables/useAgentMessaging.ts` |
| Injection, the idle gate, turn-text hook | `src/renderer/src/App.vue` |
| The protocol text handed to agents | `src/renderer/src/data/stages.ts` |
| The delivery log UI | `src/renderer/src/components/AgentMessagesPanel.vue` |
