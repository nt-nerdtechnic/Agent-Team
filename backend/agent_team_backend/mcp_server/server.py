"""Plan MCP server — plan-document tools over streamable HTTP.

Mounted on the backend's FastAPI app in the same process (later phases must
reach in-process singletons like TerminalService, so no stdio subprocess).
The backend has no single "current workspace" — every ws_handler receives
``workspace_path`` per request from the client — so the MCP tools follow the
same convention and take ``workspace_path`` as a call-time argument. A caller
authenticated as a pane may omit it: the tools then use that pane's own
workspace, which is the value Navide's plan window resolves plans against, so
a plan cannot land where the window will not look for it (see
:func:`_caller_workspace`).

Path safety reuses :func:`fs_service._resolve_safe` (the same guard the fs.*
handlers use), plus a plans-subtree containment check on top.

Lifecycle: the SDK's ``StreamableHTTPSessionManager.run()`` is once-only per
instance, so instead of ``FastMCP.streamable_http_app()`` (which caches one
manager forever) this module exposes a thin ASGI endpoint that delegates to
the manager created by the latest :func:`startup` call. ``startup`` /
``shutdown`` are registered as plugin lifecycle hooks (see backend.py) and run
from app.py's startup/shutdown events, which Starlette runs in the same
lifespan task — safe for the anyio task group inside.
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import datetime, timezone
from html import escape as html_escape
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.responses import PlainTextResponse
from starlette.types import Receive, Scope, Send

from agent_team_backend.fs_service import FsError
from agent_team_backend.pending_registry import TIMEOUT, PendingRegistry
# Workspace normalisation, not a plan dependency: preview_* resolves a
# workspace the same way plans do, and both must agree on what one root means.
from agent_team_backend.plan_index import resolve_plan_root
from agent_team_backend.preview_log import MAX_INLINE_CHARS, MAX_ROWS

#: Where this server is mounted. Baked into every pane config file already
#: written to disk and hardcoded in three places that never import it
#: (native_mcp's "is this ours" regex, SettingsModal's external URL,
#: McpHelp's docs), so changing it is a migration, not an edit.
ROUTE_PATH = "/plan-mcp"
ROUTE_METHODS = ["GET", "POST", "DELETE"]

PLANS_REL_DIR = ".agent-team/plans"

server = FastMCP(
    name="navide",
    instructions=(
        "Navide plan documents: HTML files under "
        f"{PLANS_REL_DIR}/ in a workspace, which the user reads and approves "
        "in Navide's Plan view.\n"
        "\n"
        "workspace_path: omit it. Running as a Navide CLI pane, every tool "
        "defaults to the workspace of the pane you are in — the same workspace "
        "Navide's plan view resolves plans against, so an omitted argument can "
        "never send a plan somewhere the user cannot open it. Pass it only to "
        "work on a different project on purpose, as the absolute path of that "
        "project root; a tool then warns when no pane uses it, meaning Navide "
        "is not watching that project and will not show the plan (check "
        "cli_list_targets for the workspaces panes actually use). An external "
        "client, which is not a pane, has no default and must always pass "
        "it.\n"
        "\n"
        "When to use: whenever the user asks for a plan, or a task is large "
        "enough that its steps and progress should be tracked. Create the "
        "plan with plan_create instead of hand-writing a markdown or HTML "
        "file — only documents created this way are visible in Navide, and "
        "the workspace's "
        f"{PLANS_REL_DIR}/_spec.md describes the format they follow.\n"
        "\n"
        "Flow: plan_list to discover plans, plan_read to fetch one, "
        "plan_create to start a new one (it begins at stage \"draft\"). Wait "
        "for the user to approve before writing code: start implementing once "
        "the stage is \"approved\" or later, and use plan_update_stage to move "
        "it through draft, in-review, approved, in-progress, done, abandoned. "
        "Mark each step with plan_update_todo (pending, in-progress, done, "
        "skipped) as you go, and record findings or decisions with "
        "plan_add_note. Always edit through these tools — writing the HTML "
        "yourself corrupts the plan-meta island Navide reads.\n"
        "\n"
        "Talking to other CLI panes: you can send an instruction to another "
        "CLI agent Navide is running — in this workspace or in another "
        "workspace window — with cli_send. Call cli_list_targets first to see "
        "who exists and how to address them (a bare pane name in your own "
        "workspace, `<folder>/<pane>` for another one). Use it when the user "
        "asks you to hand work to, ask something of, or coordinate with "
        "another pane or project; delivery is queued until that pane is idle, "
        "so cli_send returns before the other agent has read anything. It "
        "returns a msg_key — pass it to cli_check_message to find out whether "
        "the message was delivered, refused (with a reason) or still queued. "
        "That table is backend memory, not a log: only the last hour and the "
        "last few hundred sends, gone on restart, so an unknown key means "
        "\"no longer tracked\", not \"never sent\".\n"
        "\n"
        "When you need the answer and not just the send, use cli_send_and_wait "
        "instead: it sends and then waits for that pane to finish the turn, "
        "handling the race a hand-written cli_send + cli_wait_idle loses (the "
        "target is still idle the instant you send, so a plain wait returns "
        "\"already idle\" before it has read you — this one only accepts a "
        "turn newer than the one it saw before sending). Always read the "
        "returned `source`: \"turn_complete\" is the other CLI's own word that "
        "its turn ended, while \"quiet_period\" only means the pane went "
        "silent, so check what it actually said before trusting it.\n"
        "\n"
        "Delegating to a new agent: cli_open_agent opens a fresh CLI pane and "
        "hands it a task. Use it when work is better done in parallel or by a "
        "different CLI than yours; the new pane is asked to report back to you "
        "by message when it finishes, but that report is the child's own "
        "output rather than something Navide guarantees — it waits until you "
        "are between turns, and it never arrives at all if the child does not "
        "write the block, so poll cli_get_status / cli_wait_idle whenever you "
        "need to be sure. There is no hard cap on child "
        "panes, workspace CLI panes, or spawn-chain depth, but going well past "
        "sane advisory thresholds gets logged as a diagnostic warning (readable "
        "via ui_diagnostics) rather than refused.\n"
        "\n"
        "Checking on another pane: cli_read_log reads the tail of a pane's "
        "conversation log, cli_get_status reports whether it is busy and its "
        "last known activity, and cli_wait_idle blocks until it goes idle or a "
        "timeout passes — the reliable way to learn a pane is done, and the "
        "only way for an external caller, which gets no completion message at "
        "all."
    ),
)


# ── workspace resolution ────────────────────────────────────────────────────

_WORKSPACE_REQUIRED = (
    "workspace_path is required for a caller with no pane identity — only a "
    "Navide CLI pane has an own workspace to fall back to. Pass the absolute "
    "path of the project root."
)


def _caller_workspace(caller: _Caller) -> str:
    """The calling pane's own workspace, or "" for a caller that is not a pane.

    Navide's plan window resolves plans against the *pane's* workspace, so
    defaulting to it is the one value that cannot mismatch (a self-reported one
    can, and then the window shows "Failed to load the plan document"). host and
    external callers have no pane identity, hence no default.
    """
    if caller.kind != "pane":
        return ""
    from agent_team_backend import agent_messaging

    pane = agent_messaging.get(caller.pane_id)
    # _resolve_caller has just rejected a stale pane id, so this is set.
    return pane.workspace_path if pane else ""


async def _plan_workspace(caller: _Caller, workspace_path: str) -> str:
    """The plan root a call operates on: the argument, else the caller's pane.

    Both go through :func:`resolve_plan_root`, the same normalisation
    plan_provisioning applies before writing _template.html: a plan and the
    assets it is built from must land under one root or creation fails outright.
    """
    chosen = workspace_path or _caller_workspace(caller)
    if not chosen:
        raise FsError(_WORKSPACE_REQUIRED)
    return await asyncio.to_thread(resolve_plan_root, chosen)


def _norm_workspace(path: str) -> str:
    """Comparable form of a workspace path (symlinks + trailing slash)."""
    try:
        return str(Path(path).resolve())
    except OSError:
        return str(path or "").rstrip("/")


def _live_pane_workspaces() -> list[str]:
    """Workspaces of live CLI panes; empty when the check is unavailable.

    Uses :func:`_terminal_service` lazily (defined below, resolved at call
    time) so a backend without terminals never breaks plan creation.
    """
    try:
        terminals = _terminal_service()
        sessions = list(getattr(terminals, "_sessions", {}).values())  # snapshot
    except Exception:  # noqa: BLE001 — advisory check, never fatal
        return []
    workspaces: list[str] = []
    for session in sessions:
        try:
            if session.closed:
                continue
            metadata = session.metadata if isinstance(session.metadata, dict) else {}
            workspaces.append(str(metadata.get("workspace_path") or session.cwd))
        except AttributeError:
            continue  # defensive: session shape changed mid-iteration
    return workspaces


def _workspace_mismatch_warning(workspace_path: str) -> str | None:
    """Advise when no live pane uses ``workspace_path``.

    Navide's plan window resolves plans against a *pane's* workspace, so a
    plan written to any other root is invisible there ("Failed to load the
    plan document"). None when the workspace matches a pane or no pane
    workspace is known (headless/external MCP clients must not be warned).
    """
    panes = _live_pane_workspaces()
    if not panes:
        return None
    target = _norm_workspace(workspace_path)
    if any(_norm_workspace(pane) == target for pane in panes):
        return None
    known = ", ".join(sorted(set(panes)))
    return (
        f"no live Navide pane uses workspace_path {workspace_path!r}, so this plan "
        "will not be visible in Navide's plan view (it resolves plans against the "
        f"pane's own workspace). Pane workspaces right now: {known}"
    )


# ── terminal access ─────────────────────────────────────────────────────────


def _terminal_service() -> Any:
    """Resolve the app-level TerminalService at call time (never at import —
    app.py imports this module, and the singleton binds to the running loop).
    Maps an unavailable service to a clear tool error.
    """
    from agent_team_backend import app as _app  # local import, resolved at call time

    try:
        service = _app.get_terminals()
    except Exception as err:  # noqa: BLE001
        raise RuntimeError(f"terminal service unavailable: {err}") from err
    if service is None:
        raise RuntimeError("terminal service unavailable (backend not initialized)")
    return service


# ── Inter-CLI messaging (cli_send / cli_list_targets) ───────────────────────
# The `---MSG---` output protocol only reaches agents that were taught it in
# their kickoff, so a hand-opened pane has no way to discover it. These tools do
# — they show up in the agent's tool list on their own. Both route through the
# same backend registry as the protocol, and delivery still runs in the frontend
# (idle gate, rate limit, injection verification), so the two paths behave alike.


class CallerUnknown(Exception):
    """The request carries no usable / accepted credential."""


_UNWIRED = (
    "this MCP endpoint could not identify your pane — reopen the pane so Navide "
    "can wire it, or use the ---MSG-START--- output protocol"
)
_STALE = (
    "this pane's id is stale and names no pane any more — if this pane was just "
    "closed, or its window has been gone long enough to be forgotten, there is "
    "nothing left to act as. Reopen the pane to use these tools, or use the "
    "---MSG-START--- output protocol, which always resolves against the pane's "
    "current identity"
)
_HOST_TOKEN_REJECTED = "host token rejected"
_EXTERNAL_TOKEN_REJECTED = "external token rejected"
_EXTERNAL_DISABLED = (
    "external access to this MCP endpoint is disabled — turn it on in Navide's "
    "Settings before using an external client credential"
)
# Every cli_* tool that addresses another pane requires the sender's own pane
# identity to resolve a bare name against its own workspace (see
# agent_messaging.resolve). A caller with no pane identity (host / external)
# has no "own workspace", so it must always spell out the full address.
_QUALIFIED_TARGET_REQUIRED = (
    'a caller with no pane identity must address a pane as "<folder>/<pane>" '
    "— call cli_list_targets for the qualified address"
)


@dataclass
class _Caller:
    """The credential kind that authenticated a /plan-mcp request.

    kind is "pane" (pane_id set), "host" (this backend's own CLI wiring with
    no pane id known at spawn time), or "external" (a client outside Navide's
    process tree, only accepted while enabled).
    """

    kind: str
    pane_id: str = ""


def _resolve_caller(ctx: Context) -> _Caller:
    """Validate the request's credential (pane / host / external).

    Every pane is spawned pointing at `/plan-mcp?pane=<id>&t=<token>`; backend-
    written CLI config without a known pane id instead carries
    `?client=host&t=<internal token>` (see mcp_wiring.plan_mcp_url); an
    external client carries `?client=external&t=<external token>`, accepted
    only while auth.external_enabled() is True. Raises CallerUnknown
    with a caller-facing message when none of these validate.

    For the pane kind specifically: the id is fixed at spawn time while a
    pane's id is not — re-attaching a live PTY (detach to a window, reload)
    mints a new pane id without re-running spawn wiring, leaving the CLI
    holding one that no longer refers to anything by itself. The window records
    where that id went (agent_messaging.add_aliases), so the caller is resolved
    to the pane its process is actually attached to and the answer carries that
    pane's *current* identity — every downstream check (self-send, the caller's
    own workspace, who "you" is in cli_list_targets) is made against the live
    pane, so following the alias costs no protection.

    What is still refused is an id that resolves to nothing at all: a pane that
    was closed, or one whose window has been gone long enough to be forgotten.
    Acting on that would leave the sender resolving to nobody — every
    same-workspace name becomes "unknown target", the pane fails its own
    self-send check (so it can message itself in a loop), and the recipient is
    shown an unaddressable sender.
    """
    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import auth, wiring as mcp_wiring

    request = getattr(ctx.request_context, "request", None)
    params = getattr(request, "query_params", None)
    if params is None:
        raise CallerUnknown(_UNWIRED)
    token = str(params.get("t") or "")
    client = str(params.get("client") or "")
    if client == "host":
        if not secrets.compare_digest(token, auth.internal_token()):
            raise CallerUnknown(_HOST_TOKEN_REJECTED)
        return _Caller(kind="host")
    if client == "external":
        if not auth.external_enabled():
            raise CallerUnknown(_EXTERNAL_DISABLED)
        if not secrets.compare_digest(token, auth.external_token()):
            raise CallerUnknown(_EXTERNAL_TOKEN_REJECTED)
        return _Caller(kind="external")
    pane_id = str(params.get("pane") or "")
    if not pane_id:
        raise CallerUnknown(_UNWIRED)
    if not secrets.compare_digest(token, mcp_wiring.caller_token()):
        raise CallerUnknown("caller token rejected; reopen the pane to re-wire it")
    entry = agent_messaging.current(pane_id)
    if entry is None:
        raise CallerUnknown(_STALE)
    return _Caller(kind="pane", pane_id=entry.pane_id)


def _target_view(entry: Any, same_workspace: bool) -> dict[str, Any]:
    """One addressable pane, as cli_list_targets reports it."""
    view: dict[str, Any] = {
        "name": entry.name,
        "address": entry.qualified_name,
        # The messaging tools address a pane by `address`; every ui.pane.* action
        # takes this instead. Without it here the roster names panes it cannot
        # tell you how to focus or close, and the id↔name map is only reachable
        # through ui_snapshot, whose shape nothing documents.
        "pane_id": entry.pane_id,
        "workspace_path": entry.workspace_path,
        "same_workspace": same_workspace,
        "busy": entry.busy,
        "offline": entry.offline,
    }
    # Absent, not null, when nothing is queued for the pane: a target with no
    # message in flight has no hold to report, and an explicit null would read
    # as "nothing is holding it", which is a different claim.
    hold_reason = _hold_reason_for(entry.qualified_name)
    if hold_reason:
        view["hold_reason"] = hold_reason
    return view


@server.tool()
async def cli_list_targets(ctx: Context) -> dict[str, Any]:
    """List the CLI panes you can send instructions to with cli_send.

    Returns {you, targets}. Each target: {name, address, pane_id,
    workspace_path, same_workspace, busy, offline}. Address a pane in YOUR
    workspace by its bare name; a pane in another workspace window by the
    `<folder>/<pane>` address given here. A caller with no pane identity (host
    / external credential) has no "own workspace" — every target comes back
    with same_workspace false and "you" set to the credential kind ("host" or
    "external"); always use the qualified address. Read-only.

    This is who exists, not who is related to you — the list carries no
    lineage. The panes you opened with cli_open_agent are yours to keep track
    of; that record lives in your own context, not in this answer. Refer to
    them however reads naturally when talking to the user; the word does not
    matter, remembering who you opened does.

    `pane_id` is that pane's internal id. It is the key every `ui.pane.*` action
    takes (`ui.pane.close`, `ui.pane.focus`, `ui.pane.getStatus` via ui_invoke)
    — those reject a pane NAME — and it is also accepted by cli_send,
    cli_send_and_wait, cli_read_log, cli_get_status and cli_wait_idle in place
    of an address. Prefer `address`: it is stable and readable, and it survives
    the pane being rebuilt. Reach for `pane_id` when an address cannot say
    which pane you mean — two targets below with the SAME address are two panes
    sharing a name, and every one of those tools refuses that address as
    "ambiguous-target" rather than guessing between them. Remote targets have no
    local id and carry none, so they can only be addressed by name.

    `offline` marks a pane whose Navide window has lost its connection: it still
    exists and is expected back, but sending to it fails until it returns.

    `hold_reason` appears on a target that has a cli_send message still waiting
    to go in, and names what is holding it ("typing", "mid-turn", "starting",
    "behind", …). It is the same reason the Messages panel shows, and it is
    what makes `busy` explainable — but it exists only while a message sent
    from here is queued for that pane, so its absence says nothing.

    `remote_targets` appears only when this machine is linked to a Navide-Server
    and that server knows of panes on *other* machines. Those are a separate
    list because they are a separate deal: their `address` is the three-part
    `<device>/<workspace>/<pane>` form, the message travels through the server
    (so it can fail in ways a local one cannot — the far machine may be offline,
    or refuse on policy grounds), and there is no reading their output from
    here. Each carries `device` (the machine's human-readable label, or its id
    when the server knows no name), `host_online` (that whole machine is
    reachable) and `status` (the server's own word for the pane). `offline` is
    true when either half says the message would not land right now. Prefer a
    local target when one would do.
    """
    from agent_team_backend import agent_messaging, remote_roster

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"error": str(err), "targets": []}
    if caller.kind == "pane":
        me_entry = agent_messaging.get(caller.pane_id)
        targets = [
            _target_view(
                entry, bool(me_entry and me_entry.workspace_path == entry.workspace_path)
            )
            for entry in agent_messaging.list_panes()
            if entry.pane_id != caller.pane_id
        ]
        result = {"you": me_entry.qualified_name if me_entry else None, "targets": targets}
    else:
        targets = [_target_view(entry, False) for entry in agent_messaging.list_panes()]
        result = {"you": caller.kind, "targets": targets}
    # Absent, not empty, when there is nothing to say: a machine with no server
    # configured has an empty roster and must see byte-for-byte the answer it
    # saw before cross-device addressing existed.
    remote = [pane.to_dict() for pane in remote_roster.list_panes()]
    if remote:
        result["remote_targets"] = remote
    return result


@server.tool()
async def cli_whoami(ctx: Context) -> dict[str, Any]:
    """Your own entry, in the same shape cli_list_targets gives you for others.

    cli_list_targets deliberately leaves you out of its `targets` and names you
    only as `you`, a single address string. So every field it hands you about
    everyone else — `pane_id` above all — was the one thing you could not learn
    about yourself. That is what this answers. Read-only.

    `pane_id` is why this exists. It is the key every `ui.pane.*` action takes
    (`ui.pane.close`, `ui.pane.focus`, `ui.pane.getStatus` via ui_invoke) and
    those REFUSE a pane name, so without it you could close or focus any pane
    but your own. It also disambiguates you to cli_read_log and cli_get_status
    when another pane in your workspace shares your name — an address both of
    them refuse as "ambiguous-target".

    `spawned_by` names the pane that opened you, when one did, as
    {pane_id, name, address}. This is the only place that fact survives: the
    name of whoever opened you was written into the words of your kickoff task
    and nowhere else, so a compaction of your context loses it permanently —
    along with any idea of who your finished work should go back to. When that
    pane has since closed, only `pane_id` comes back alongside `gone: true`;
    the key is absent entirely when nobody opened you.

    This is a fact about yourself, not the roster's lineage: cli_list_targets
    still says nothing about who is related to whom, and who *you* opened is
    still yours alone to remember.

    A caller with no pane identity (host / external credential) is not a pane
    and has none of these: it gets {ok, caller} only.
    Returns {ok, caller, name, address, pane_id, workspace_path, agent_key,
    busy, offline, hold_reason?, spawned_by?} or {ok: false, error}.
    """
    from agent_team_backend import agent_messaging

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {"ok": True, "caller": caller.kind}
    me = agent_messaging.get(caller.pane_id)
    if me is None:
        return {
            "ok": False,
            "error": "your pane is no longer registered — reopen it to re-wire it",
        }
    # Built through the very function cli_list_targets uses for everybody else:
    # the asymmetry being closed here is that you saw a different shape for
    # yourself than for a peer, and two hand-written dicts would reopen it the
    # first time one of them gained a field.
    result: dict[str, Any] = {"ok": True, "caller": "pane"}
    result.update(_target_view(me, True))
    # Not in _target_view because a peer's is on the roster elsewhere; yours is
    # not reported anywhere at all, and it is what tells you which CLI you are.
    result["agent_key"] = me.agent_key
    if me.spawned_by:
        # Through `current`, not `get`: a parent that was rebuilt around its
        # still-running CLI answers to a new id, and the retired one is exactly
        # what a child mirrored before the rebuild.
        parent = agent_messaging.current(me.spawned_by)
        if parent is None:
            result["spawned_by"] = {"pane_id": me.spawned_by, "gone": True}
        else:
            result["spawned_by"] = {
                "pane_id": parent.pane_id,
                "name": parent.name,
                "address": parent.qualified_name,
            }
    return result


# Spawn verdicts come from the window that owns the requesting pane — only it
# knows the pane counts, chain depth and name collisions the gate needs. The
# tool waits for that verdict instead of reporting "requested", so the agent
# learns whether it actually got a pane and, if not, why.
#
# The verdict lands once the pane exists, not once its CLI has booted: booting
# a cold CLI can take longer than any deadline an agent would tolerate, so that
# part continues after the answer and reports failure by message.
_SPAWN_VERDICT_TIMEOUT_S = 40.0
_pending_spawns: dict[str, asyncio.Future[dict[str, Any]]] = {}


def resolve_spawn(request_id: str, verdict: dict[str, Any]) -> bool:
    """Hand a window's verdict to the waiting cli_open_agent call."""
    future = _pending_spawns.get(request_id)
    if future is None or future.done():
        return False
    future.set_result(verdict)
    return True


def _refuse_unsupported_model(agent_key: str, model: str, effort: str) -> str:
    """Why this CLI cannot be asked for that model or effort, or "" if it can.

    Checked here, before the request is broadcast, so an unsupported ask is
    answered at once instead of waiting out the spawn verdict and then
    reporting a timeout that blames the window. The capability mirrors the
    frontend spec, which owns the flags themselves; the guard test in
    test_cli_vendors_registry.py keeps the two from drifting.
    """
    # Trimmed here rather than trusting the caller, so this helper gives the
    # same answer as the renderer's modelArgsFor for any input. cli_open_agent
    # already strips; a future caller that forgets would otherwise get a
    # backend/renderer disagreement instead of a refusal.
    from agent_team_backend.model_args import refuse_unsafe_shape

    # Trimmed here rather than trusting the caller, so this helper gives the
    # same answer as the renderer's modelArgsFor for any input.
    model = model.strip()
    effort = effort.strip()
    if not model and not effort:
        return ""
    from agent_team_backend.cli_vendors import registry

    # Shape first, and regardless of what this vendor supports: a value that
    # would split into extra arguments is malformed no matter who receives it,
    # and saying "unsupported" here would send the caller off to try another
    # CLI with the same injected string.
    unsafe = refuse_unsafe_shape(model, effort)
    if unsafe:
        return unsafe
    spec = registry.VENDORS.get(agent_key)
    if spec is None:
        return ""  # unknown agent key — the spawn gate reports that itself
    if model and not spec.supports_model:
        return (
            f"{agent_key} cannot be told which model to run at launch, so this "
            f"would have started on its default. Open it without `model`, or "
            f"pick a CLI that takes one."
        )
    if effort and not spec.supports_effort:
        if spec.supports_model:
            return (
                f"{agent_key} has no separate effort setting — it takes effort "
                f"as part of the model id (like `gpt-5.3-codex-high`). Put it "
                f"in `model` instead."
            )
        return f"{agent_key} cannot be told a reasoning effort at launch."
    if effort and spec.known_efforts and effort not in spec.known_efforts:
        accepted = ", ".join(spec.known_efforts)
        return f"{agent_key} does not accept effort {effort!r}. It accepts: {accepted}."
    return ""


@server.tool()
async def cli_open_agent(
    agent: str,
    name: str,
    task: str,
    ctx: Context,
    workspace_path: str = "",
    model: str = "",
    effort: str = "",
) -> dict[str, Any]:
    """Open a new CLI pane and give it a task.

    `agent` is the CLI to run (e.g. "claude", "codex"), `name` is what the pane
    will be called — that name is also its messaging address, so pick something
    role-shaped like "reviewer" — and `task` is what it should do.

    The pane you open is related to you: you opened it, so its result needs to
    come back to you. When you talk to the user about it, use whatever reads
    naturally — partner, junior, the one you sent out, your child agent. No
    word is prescribed and none is more correct than another; what matters is
    not the label but that you remember who you opened.

    Say both of these in `task`: who opened it (your own name, from
    cli_list_targets' `you`), and who to send the result to when it is done.
    Without that line it finishes, writes the answer to its own screen, and
    nobody ever sees it.

    Pane callers open the pane in their own workspace; `workspace_path` is
    ignored for them. A caller with no pane identity (host / external
    credential) has no workspace of its own, so `workspace_path` is required —
    the pane opens there with no parent, so it has no child/depth counts of
    its own; the workspace's CLI-pane count is still tracked for the advisory
    below.

    `ok: true` means the PANE EXISTS — not that the task arrived. The CLI boots
    and is given the task afterwards, and that half can fail on its own. Check
    it with cli_get_status: `ui.kickoff` is "sent" when the task was observed
    landing, "unverified" when the bytes were written but the only echo was a
    booting CLI repainting (read `ui.buffer`; re-send with cli_send if the
    prompt is empty), or "failed". A failure is ALSO reported by message to a
    pane caller — but only to a pane caller, and only when the injection
    reported failure, which is exactly the case "unverified" exists to cover. For a pane caller, the new pane is asked to report its
    result to you by message when it finishes — but that report is the child
    agent's own output, not a guarantee from Navide: it is held until you are
    between turns, and nothing arrives if the child never writes the block.
    Poll cli_get_status / cli_wait_idle whenever you need to be sure. An
    external or host caller gets no such message at all and must poll.

    `model` names the model the new pane runs, and `effort` its reasoning
    level. Both are optional, and asking a CLI that cannot take them is
    REFUSED rather than ignored — otherwise the pane would start on the
    default and look no different from one that got what it asked for.

    That guarantee covers the vendor, not the value: a CLI that accepts
    `--model` may still reject the id itself, and several report that only
    briefly before continuing on their default. So a refusal here means the
    pane did not open, while silence means it opened — not that the model was
    recognised. Which CLIs accept them differs: most take a
    model, only some take a separate effort — the rest encode effort in the
    model id itself (cursor's `gpt-5.3-codex-high`), and two take neither.
    The refusal names what that CLI accepts, so ask for what you want and
    read the error rather than guessing first. Model ids are not checked
    here — an unknown one is the CLI's own error to report — but effort is
    checked against that CLI's vocabulary before the pane opens.

    Use the returned name, not the one you asked for: a concurrent request may
    have taken that name, in which case yours gets a suffix.

    Refused when the name is taken, the agent key is unknown, or the task is
    empty. A high child/workspace/depth count never refuses the spawn — it
    just gets logged as a diagnostic warning and, on success, also returned
    here as `advisories` (a list of human-readable notes; the key is absent
    when there is nothing to report).
    `pane_id` is the new pane's internal id — the key `ui.pane.close`,
    `ui.pane.focus` and `ui.pane.getStatus` take through ui_invoke, all of which
    refuse a pane NAME. Keep it if you may want to close or focus what you
    opened; `address` remains the right thing to send to.
    Returns {ok, name, address, pane_id, advisories?} or {ok: false, error}.
    """
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.ipc import make_event

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    agent_key = (agent or "").strip()
    pane_name = (name or "").strip()
    if not agent_key:
        return {"ok": False, "error": "agent is required (e.g. \"claude\", \"codex\")"}
    if not pane_name:
        return {"ok": False, "error": "name is required — it doubles as the pane's address"}
    if not (task or "").strip():
        return {"ok": False, "error": "task is empty"}
    refusal = _refuse_unsupported_model(agent_key, (model or "").strip(), (effort or "").strip())
    if refusal:
        return {"ok": False, "error": refusal}
    target_workspace = ""
    if caller.kind == "pane":
        me = caller.pane_id
    else:
        me = ""
        target_workspace = (workspace_path or "").strip()
        if not target_workspace:
            return {
                "ok": False,
                "error": "workspace_path is required for a caller with no pane identity",
            }

    request_id = f"{me or caller.kind}:spawn:{secrets.token_hex(8)}"
    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    _pending_spawns[request_id] = future
    try:
        spawn_payload: dict[str, Any] = {
            "request_id": request_id,
            "requester_pane_id": me,
            "agent_key": agent_key,
            "name": pane_name,
            "task": task,
        }
        # Only sent when asked for: a window on an older build ignores keys it
        # does not know, and an empty one would be indistinguishable anyway.
        if (model or "").strip():
            spawn_payload["model"] = model.strip()
        if (effort or "").strip():
            spawn_payload["effort"] = effort.strip()
        if target_workspace:
            # No parent pane owns this request — the owning window is decided
            # by workspace match instead (see App.vue's agent_spawn.request
            # handler).
            spawn_payload["target_workspace"] = target_workspace
        await app.broadcast(make_event("agent_spawn.request", spawn_payload))
        verdict = await asyncio.wait_for(future, timeout=_SPAWN_VERDICT_TIMEOUT_S)
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "error": "no answer from the window that owns your pane — it may have "
            "closed. Check cli_list_targets before retrying: the pane may exist "
            "already, in which case reopening it would duplicate the work",
        }
    finally:
        _pending_spawns.pop(request_id, None)

    if not verdict.get("ok"):
        return {"ok": False, "error": str(verdict.get("error") or "spawn refused")}
    new_pane_id = str(verdict.get("pane_id") or "")
    entry = agent_messaging.get(new_pane_id)
    result: dict[str, Any] = {
        "ok": True,
        "name": str(verdict.get("name") or pane_name),
        "address": entry.qualified_name if entry else str(verdict.get("name") or pane_name),
    }
    # The id of the pane you just opened. Without it you could send to what you
    # opened but never close or focus it: every ui.pane.* action takes an id and
    # refuses a name, and the only other way to that id is finding your own
    # pane again in cli_list_targets. Absent, not empty, when the window
    # answered ok without naming a pane — an id that is the empty string would
    # be handed to ui.pane.close as if it addressed something.
    if new_pane_id:
        result["pane_id"] = new_pane_id
    if verdict.get("advisories"):
        result["advisories"] = verdict["advisories"]
    return result


async def _send_to_device(
    address: Any, text: str, *, caller: Any, me: str
) -> dict[str, Any] | None:
    """Relay a `<device>/<workspace>/<pane>` message through the server link.

    The relay itself is shared with the bare-line path (see message_routing);
    what is MCP's own is the msg_key bookkeeping that cli_check_message reads
    back, which exists nowhere else in the backend.

    Returns None when there is no link to relay over, so the caller can answer
    the way it always did for an unknown device.
    """
    from agent_team_backend import message_routing

    origin = me or caller.kind
    msg_key = f"{origin}:mcp:{secrets.token_hex(8)}"
    relayed = await message_routing.relay(
        address, text, from_pane_id=me, msg_key=msg_key
    )
    if relayed is None:
        return None
    if not relayed.ok:
        answer: dict[str, Any] = {
            "ok": False,
            "error": relayed.error,
            "error_code": relayed.code,
        }
        if relayed.code in message_routing.LINK_STATE_CODES:
            answer["link_state"] = relayed.link_state
            answer["last_error"] = relayed.last_error
        return answer
    _record_message_sent(msg_key, address.to_string(), origin, text)
    return {
        "ok": True,
        "target": address.to_string(),
        "cross_workspace": True,
        "msg_key": msg_key,
    }


#: Reserved `to:` value that fans a message out to the sender's own tab group.
#: Deliberately NOT the bare-line protocol's "all"/"*": that one means every
#: pane in the window, and one word meaning two scopes would be very hard to
#: debug. A pane actually named "group" therefore cannot be addressed by name —
#: the same trade-off "all" already carries.
GROUP_TARGET = "group"


def _is_group_target(to: str) -> bool:
    return (to or "").strip().lower() == GROUP_TARGET


async def _send_to_group(
    caller: "_Caller", me: str, text: str, reply_to: str = ""
) -> dict[str, Any]:
    """Deliver *text* to every other pane in the sender's own tab group.

    Groups are UI state the backend never learns — ``agent_msg.register``
    carries no group id — so the recipient set is asked of the window that owns
    the sender, and each recipient is then delivered to through the ordinary
    single-message path. That is what keeps a broadcast's per-recipient
    rate-limit budget, idle hold and delivery report identical to a direct send.
    """
    from agent_team_backend import agent_messaging

    sender = agent_messaging.get(me)
    if sender is None:
        return {
            "ok": False,
            "error": "your pane is no longer registered — reopen it to broadcast",
            "error_code": "unknown-target",
        }

    ui = await _ui_request(
        sender.workspace_path,
        "invoke",
        caller=_pane_caller(me),
        action="ui.groupPeers",
        args={"paneId": me},
    )
    if not ui.get("ok"):
        return {
            "ok": False,
            "error": ui.get("error") or "the window owning your pane did not answer",
            "error_code": ui.get("error_code") or "ui_action_timeout",
        }

    result = ui.get("result") or {}
    peers = result.get("peers") or []
    recipients: list[dict[str, Any]] = []
    for peer in peers:
        pane_id = str((peer or {}).get("pane_id") or "")
        name = str((peer or {}).get("name") or "")
        entry = agent_messaging.current(pane_id) if pane_id else None
        if entry is None or entry.offline:
            # The window listed it a moment ago; it went away in between. Say so
            # per recipient rather than failing the whole broadcast.
            recipients.append(
                {"name": name, "pane_id": pane_id, "accepted": False, "reason": "target-offline"}
            )
            continue
        msg_key = await _dispatch_delivery(
            entry, text, caller=caller, me=me, cross_workspace=False, reply_to=reply_to
        )
        recipients.append(
            {"name": entry.name, "pane_id": entry.pane_id, "msg_key": msg_key, "accepted": True}
        )
    return {
        "ok": True,
        "broadcast": GROUP_TARGET,
        "group_id": str(result.get("group_id") or ""),
        "delivered_to": sum(1 for r in recipients if r["accepted"]),
        "recipients": recipients,
    }


async def _dispatch_delivery(
    entry: Any, text: str, *, caller: "_Caller", me: str, cross_workspace: bool,
    reply_to: str = "",
) -> str:
    """Hand one message to the windows and record it; returns its msg_key.

    Shared by the single-target send and the group broadcast, which differ only
    in how they pick recipients — every message is delivered, rate-limited, held
    and reported exactly alike whichever way it was addressed.

    ``reply_to`` is a correlation id the caller is echoing back; it travels in
    the delivery payload under the same key the bare-line path uses
    (``agent_msg.route`` in ws_handlers), so the receiving window links the two
    rows through the one ``acceptRemoteMessage`` path either way. Absent unless
    the caller passed one, which keeps the payload a non-reply produces exactly
    what it always was.
    """
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.ipc import make_event

    sender = agent_messaging.get(me) if me else None
    msg_key = f"{me or caller.kind}:mcp:{secrets.token_hex(8)}"
    await app.broadcast(
        make_event(
            "agent_msg.deliver",
            {
                "msg_key": msg_key,
                "target_pane_id": entry.pane_id,
                "target_workspace_path": entry.workspace_path,
                "target_name": entry.name,
                "target_agent_key": entry.agent_key,
                "from_pane_id": me,
                "from_display": agent_messaging.sender_display(
                    me, "an external client" if caller.kind == "external" else "a host client"
                ),
                "from_workspace_path": sender.workspace_path if sender else "",
                "from_agent_key": sender.agent_key if sender else "",
                "cross_workspace": cross_workspace,
                "content": text,
                # The frontend applies the per-pair rate limit when it sends;
                # a message that entered here never passed through that, so the
                # receiving window has to apply it instead. Without this, two
                # agents replying to each other through cli_send have no loop
                # guard at all.
                "rate_limit": True,
                # Only present for a reply — see the docstring.
                **({"reply_to": reply_to} if reply_to else {}),
            },
        )
    )
    _record_message_sent(msg_key, entry.qualified_name, me or caller.kind, text)
    return msg_key


@server.tool()
async def cli_send(
    to: str,
    text: str,
    ctx: Context,
    wait_for_delivery_s: float = 0.0,
    pane_id: str = "",
    reply_to: str = "",
) -> dict[str, Any]:
    """Send an instruction to another CLI pane, in this or another workspace.

    `to` is a pane name for a pane in your own workspace, or `<folder>/<pane>`
    for one in another workspace window — cli_list_targets shows both forms. A
    caller with no pane identity (host / external credential) has no "own
    workspace" and must always use the qualified `<folder>/<pane>` form. The
    text is delivered verbatim and submitted for the receiving agent to act on,
    once that pane is idle; it is queued if the pane is mid-turn. An unknown or
    ambiguous target is refused rather than guessed.

    `to: "group"` broadcasts instead: every other pane in YOUR OWN tab group,
    in your own workspace. Deliberately narrower than the bare-line protocol's
    `all`, which means every pane in the window regardless of group. Panes in no
    group share one implicit group, so they reach each other rather than nobody.
    A caller with no pane identity has no group and is refused ("no-group").
    The answer is a different shape — {ok, broadcast, group_id, delivered_to,
    recipients: [{name, pane_id, msg_key, accepted, reason?}]} — with ONE
    msg_key per recipient, because each is an ordinary independent message:
    its own rate-limit budget, its own idle hold, its own delivery report. Pass
    each key to cli_check_message separately; `wait_for_delivery_s` does not
    apply to a broadcast and is ignored. An empty `recipients` means your group
    has nobody else in it — not a failure.

    `pane_id` addresses one exact pane and makes `to` unnecessary — copy it from
    cli_list_targets. Reach for it when a name cannot say which pane you mean:
    two panes in one workspace may share a name, and that is refused as
    "ambiguous-target" however the name is spelled. It also survives a rename.
    It names a pane on this machine only, so a cross-device target must still be
    addressed by name. An id follows its pane through a window reload or a
    detach, but a pane restarted around a fresh CLI gets a new one — treat
    "unknown-pane-id" as "read a fresh id from cli_list_targets", not as "that
    pane is gone".

    `reply_to` threads this message onto one you were sent, instead of starting
    a new conversation. Pass back the `correlation_id` of the message you are
    answering — cli_read_incoming reports it, and so does the `re:` field of an
    envelope typed into your pane. The recipient's Messages panel then shows
    this as the answer to that message rather than as an unrelated one, and its
    own cli_read_incoming reports it under `in_reply_to`. An id the receiving
    window never handed out is ignored, exactly as an unrecognised `re:` is:
    the message still goes, it simply arrives unthreaded. Omit it for a message
    that starts a thread — the send is then exactly what it always was.

    One limit, and it is the bare-line protocol's too: `reply_to` does NOT
    travel to another device. The relay frame carries to/sender/text/msg_key
    and nothing else, so threading across machines needs a wire field both ends
    understand — a protocol change, not a routing one (`agent_msg.route` in
    ws_handlers says the same at the same seam). The far side still mints a
    correlation id from the msg_key, so the thread holds over there; what is
    lost is the link back to the row on this machine.

    Delivery is asynchronous: this returns once the message is accepted for
    delivery, not once the other agent has read it. Returns
    {ok, target, cross_workspace, msg_key} or {ok: false, error, error_code}.
    Pass `msg_key` to cli_check_message to learn whether the receiving window
    actually delivered it.

    `wait_for_delivery_s` (0 by default, capped at 120) is the alternative to
    remembering to poll: wait that long for the message to actually go in, and
    answer with what happened. 10-30s is the useful range — the wait costs your
    own turn, and a pane that is mid-turn or being typed in can hold a message
    far longer than that. With it set, the answer also carries:

      - `status: "delivered"` and `settled_after_s` — it went in.
      - `status: "failed"` (or "rejected" for another device) and `reason` —
        the receiving window refused it. `ok` stays TRUE: the send itself
        happened and `msg_key` is real, so re-sending on this would dispatch
        the work twice. Read the reason and decide.
      - `status: "queued"` with `waited_s`, plus `hold` and `held_for_s` when
        the receiving window said why — the message is still waiting. `hold.key`
        is "typing" (someone is at that keyboard), "mid-turn" (the agent is
        working), "behind" (other messages first), "starting", "settling",
        "not-ready" or "gone". Nothing was lost; it goes in when the pane frees
        up, and cli_check_message picks the story up later.

    `error_code` "target-offline" is not "unknown-target": the pane exists but
    its Navide window is disconnected. Wait for it to come back and retry —
    re-sending elsewhere or reopening the pane would duplicate the work.

    A `<device>/<workspace>/<pane>` target names a pane on another machine and
    is relayed through the configured Navide-Server. Copy the address from
    cli_list_targets' `remote_targets` rather than assembling it: `device` may
    be either the machine's id or its name, and only the id is guaranteed not
    to collide with one of this machine's own workspace paths. "device-offline"
    means that machine has no connection at all, so waiting is the only option;
    the receiving device may also refuse on policy grounds, which shows up in
    cli_check_message as status "rejected".

    Three error codes tell apart the ways cross-device sending can fail before
    the message even leaves here, and only the first is about the address:
    "unknown-device" (no server is configured on this machine, so no device but
    this one can be named), "link-offline" (a server is configured but this
    machine is not connected to it — the address may be perfectly good) and
    "link-unauthorized" (this machine's server credential was rejected or
    revoked; retrying cannot help until it is signed in again).

    The two link errors also carry ``link_state`` and ``last_error``, and the
    message says what to do: "connecting" is the only one worth retrying,
    "unreachable" means the address is not answering from here, and
    "unauthorized" means somebody has to sign in again. Telling all three to
    retry shortly — which is what this used to do — is advice that works for
    one of them.
    """
    from agent_team_backend import agent_messaging, app, message_routing
    from agent_team_backend.ipc import make_event

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if not (text or "").strip():
        return {"ok": False, "error": "text is empty"}
    me = caller.pane_id if caller.kind == "pane" else ""
    target_id = (pane_id or "").strip()
    if not target_id and _is_group_target(to):
        if caller.kind != "pane":
            return {
                "ok": False,
                "error": 'a caller with no pane identity has no group to broadcast to — '
                'address panes individually, or by pane_id',
                "error_code": "no-group",
            }
        return await _send_to_group(caller, me, text, reply_to)
    # An id is already as qualified as an address gets, so the rule that a
    # caller with no workspace of its own must name one does not apply to it.
    if not target_id and caller.kind != "pane" and "/" not in (to or ""):
        return {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}
    wait_s = min(max(float(wait_for_delivery_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)

    if target_id:
        # An id skips address resolution entirely — including the cross-device
        # path, which an id cannot reach anyway.
        result = agent_messaging.resolve_pane_id(me, target_id)
        if result.pane is None:
            return {
                "ok": False,
                "error": result.error,
                "error_code": result.code or "unknown-pane-id",
            }
    else:
        # The resolution order lives in message_routing, shared with the
        # bare-line path so the two cannot answer the same address differently.
        routed = message_routing.route(me, to)
        if routed.remote is not None:
            relayed = await _send_to_device(routed.remote, text, caller=caller, me=me)
            # None means no server was ever configured on this machine; falling
            # through leaves the answer exactly what it was before cross-device
            # addressing existed. A configured-but-unreachable server does not come
            # back as None — it answers "link-offline" above.
            if relayed is not None:
                return await _with_delivery_wait(relayed, wait_s)
        if routed.pane is None:
            return {
                "ok": False,
                "error": routed.error or f'unknown target "{to}"',
                "error_code": routed.code or "unknown-target",
            }
        result = agent_messaging.ResolveResult(
            pane=routed.pane, cross_workspace=routed.cross_workspace
        )
    if me and result.pane.pane_id == me:
        return {"ok": False, "error": "that is your own pane"}

    msg_key = await _dispatch_delivery(
        result.pane,
        text,
        caller=caller,
        me=me,
        cross_workspace=result.cross_workspace,
        reply_to=reply_to,
    )
    return await _with_delivery_wait(
        {
            "ok": True,
            "target": result.pane.qualified_name,
            "cross_workspace": result.cross_workspace,
            "msg_key": msg_key,
        },
        wait_s,
    )


# ── Delivery outcome of a cli_send (cli_check_message) ─────────────────────
# msg_key is minted per cli_send call and exists nowhere else in the backend:
# the SQLite message log is keyed by a separate uid the renderer owns, and the
# sending window's own map of msg_key lives in renderer memory. So the outcome
# is tracked here, in memory, bounded by both a count and a TTL — a restart
# loses it, which is fine for a key nothing outlives the process anyway.
_MESSAGE_STATUS_MAX = 500
_MESSAGE_STATUS_TTL_S = 3600.0
# How long a message may sit in "queued" before it stops reading as "on its way"
# and starts reading as "stuck". Deliberately far below the receiving window's
# 30-minute no-report backstop: this is the point where a sender should look,
# not the point where the message is given up on.
_STALE_HOLD_S = 120.0
# How much of a message cli_inbox_summary quotes back, counted in code points so
# the cut cannot split a surrogate pair.
_INBOX_EXCERPT_CHARS = 60
_mcp_message_status: dict[str, dict[str, Any]] = {}
# Calls parked in cli_send(wait_for_delivery_s=…), by the key they are waiting
# on. One event per waiting call rather than one per key: two agents may wait on
# the same message, and neither may swallow the other's wake-up.
_status_waiters: dict[str, list[asyncio.Event]] = {}


def _prune_message_status(now: float) -> None:
    for key, entry in list(_mcp_message_status.items()):
        if now - entry["created_at"] >= _MESSAGE_STATUS_TTL_S:
            del _mcp_message_status[key]
    # Insertion-ordered, so the front of the dict is the oldest send.
    while len(_mcp_message_status) >= _MESSAGE_STATUS_MAX:
        _mcp_message_status.pop(next(iter(_mcp_message_status)))


def _record_message_sent(msg_key: str, target: str, origin: str, text: str) -> None:
    now = time.monotonic()
    _prune_message_status(now)
    _mcp_message_status[msg_key] = {
        "status": "queued",
        "target": target,
        "reason": None,
        "delivered_at": None,
        "created_at": now,
        # Filled in by the window that owns the target, which is the only place
        # the delivery gate exists. Stays None for a message that goes out
        # before any hold was ever reported.
        "hold": None,
        "hold_since": None,
        # Who sent it, as cli_inbox_summary identifies its own caller: a pane id
        # for a pane, otherwise the caller kind. The msg_key already starts with
        # this, but a pane id may contain anything, so it is kept as its own
        # field rather than parsed back out of the key.
        "origin": origin,
        "excerpt": "".join(list(" ".join(text.split()))[:_INBOX_EXCERPT_CHARS]),
    }


def record_message_hold(msg_key: str, hold: dict[str, Any] | None) -> bool:
    """Record why the receiving window has not injected a cli_send message yet.

    The window reports a change, never a heartbeat (see setHold in
    useAgentMessaging), so this is called once per hold rather than once per
    pump tick.

    A settled entry is left alone: a hold report that lost a race with the
    delivery it was overtaken by must not put a delivered message back on
    "waiting for the pane".

    Returns False for a msg_key this server never sent or has already settled —
    every window reports for every tracked message it holds, so that is the
    ordinary case, not an error.
    """
    entry = _mcp_message_status.get(msg_key)
    if entry is None or entry["status"] != "queued":
        return False
    key = str((hold or {}).get("key") or "")
    if not key:
        entry["hold"] = None
        entry["hold_since"] = None
        return True
    view: dict[str, Any] = {"key": key}
    n = (hold or {}).get("n")
    if isinstance(n, (int, float)) and not isinstance(n, bool):
        view["n"] = int(n)
    entry["hold"] = view
    # Timed by this process's own clock rather than the window's: held_for_s is
    # read next to age_seconds and settled_after_s, and a renderer's wall clock
    # is neither of those. The report is sent the moment the hold changes, so
    # the two agree to within one round trip.
    entry["hold_since"] = time.monotonic()
    return True


def _hold_view(entry: dict[str, Any], now: float) -> dict[str, Any]:
    """The hold half of a status answer, for a message that is still waiting.

    Empty once the message has settled: what was holding it stopped being true
    the moment it went in.
    """
    hold = entry.get("hold")
    if entry["status"] != "queued" or not hold:
        return {}
    view: dict[str, Any] = {"hold": hold}
    if entry.get("hold_since") is not None:
        view["held_for_s"] = round(now - entry["hold_since"], 1)
    return view


def _is_stale(entry: dict[str, Any], now: float) -> bool:
    """True once a queued message has waited long enough to be worth looking at.

    Read from the send's own age rather than from `hold_since`: a hold that
    flips between "mid-turn" and "typing" restarts that clock every time, and a
    message no window ever reported a hold for — the case this exists for —
    has no hold clock at all.

    Computed on read rather than stamped by a timer. Nothing on the backend
    needs to act at the moment the threshold is crossed: the renderer owns the
    queue and pushes the still-held notice itself (STALE_HOLD_MS in
    useAgentMessaging), and everything here answers a question that was asked.
    """
    return entry["status"] == "queued" and now - entry["created_at"] >= _STALE_HOLD_S


def _hold_reason_for(target: str) -> str | None:
    """The hold key of the oldest still-queued cli_send message for `target`.

    Only messages sent from here are tracked, so a pane whose queue holds
    nothing of ours simply has no reason to give. Matched on the qualified name
    the send recorded, which is the address cli_list_targets reports — a pane
    renamed since then stops matching, and reports nothing rather than a stale
    reason.
    """
    for entry in _mcp_message_status.values():
        if entry["target"] != target or entry["status"] != "queued":
            continue
        hold = entry.get("hold")
        if hold:
            return str(hold["key"])
    return None


def _settle_status_waiters(msg_key: str) -> None:
    """Wake every cli_send parked on this key. Waiters remove themselves."""
    for event in _status_waiters.get(msg_key, ()):
        event.set()


def _decode_reason(reason: str) -> str:
    """The renderer encodes its structured reason as JSON; keep the key only."""
    try:
        parsed = json.loads(reason)
    except (ValueError, TypeError):
        return reason
    if isinstance(parsed, dict) and isinstance(parsed.get("key"), str):
        return parsed["key"]
    return reason


def record_delivery_result(msg_key: str, ok: bool, reason: str) -> bool:
    """Record a receiving window's agent_msg.delivered verdict for cli_check_message.

    Returns False for a msg_key this server never sent (every message the UI
    sends goes through the same event), which is not an error.
    """
    entry = _mcp_message_status.get(msg_key)
    if entry is None:
        return False
    decoded = _decode_reason(reason) if reason else None
    # A withdrawal comes back down the delivered path with ok=False, but it is
    # not a failure: nothing went wrong and nothing should be resent. Collapsing
    # it into "failed" would invite exactly the resend the withdrawal was meant
    # to prevent — the same reason "read" is reported as delivered.
    if not ok and decoded == "cancelled":
        entry["status"] = "cancelled"
    else:
        entry["status"] = "delivered" if ok else "failed"
    entry["reason"] = decoded
    entry["delivered_at"] = time.monotonic()
    _clear_hold(entry)
    _settle_status_waiters(msg_key)
    return True


def _clear_hold(entry: dict[str, Any]) -> None:
    """A settled message is not being held by anything any more."""
    entry["hold"] = None
    entry["hold_since"] = None


# A remote ack keeps its three-way state instead of collapsing to ok/not-ok:
# "rejected" means the receiving device's pane policy refused, and re-sending
# will refuse again. An agent that cannot tell that apart from a transient
# failure retries a permission problem until someone notices.
_REMOTE_ACK_STATES = ("delivered", "failed", "rejected")


def record_remote_ack(msg_key: str, state: str, reason: str) -> bool:
    """Record another device's messages.ack for a message sent from here.

    Returns False for a msg_key this server never sent, which is not an error.
    """
    entry = _mcp_message_status.get(msg_key)
    if entry is None:
        return False
    entry["status"] = state if state in _REMOTE_ACK_STATES else "failed"
    entry["reason"] = reason or None
    entry["delivered_at"] = time.monotonic()
    _clear_hold(entry)
    _settle_status_waiters(msg_key)
    return True


async def _await_delivery(msg_key: str, timeout: float) -> None:
    """Wait until a message leaves "queued", or the timeout passes.

    Nothing here blocks the event loop: the waiting call is parked on its own
    event while every other request — including the receiving window's report,
    which is what wakes it — carries on.
    """
    entry = _mcp_message_status.get(msg_key)
    if entry is None or entry["status"] != "queued":
        return
    event = asyncio.Event()
    _status_waiters.setdefault(msg_key, []).append(event)
    try:
        await asyncio.wait_for(event.wait(), timeout)
    except (asyncio.TimeoutError, TimeoutError):
        pass
    finally:
        waiters = _status_waiters.get(msg_key)
        if waiters is not None:
            if event in waiters:
                waiters.remove(event)
            if not waiters:
                del _status_waiters[msg_key]


def _delivery_outcome(msg_key: str, waited: float) -> dict[str, Any]:
    """What waiting for delivery adds to an accepted send's answer."""
    entry = _mcp_message_status.get(msg_key)
    if entry is None:
        # Evicted from the bounded table while we waited. The send itself still
        # happened, and "queued" is the last thing that was true of it.
        return {"status": "queued", "waited_s": round(waited, 1)}
    now = time.monotonic()
    outcome: dict[str, Any] = {"status": entry["status"]}
    if entry["status"] == "queued":
        outcome["waited_s"] = round(waited, 1)
        outcome.update(_hold_view(entry, now))
        if _is_stale(entry, now):
            outcome["stale"] = True
        return outcome
    if entry["reason"]:
        outcome["reason"] = entry["reason"]
    if entry["delivered_at"] is not None:
        outcome["settled_after_s"] = round(entry["delivered_at"] - entry["created_at"], 1)
    return outcome


async def _with_delivery_wait(sent: dict[str, Any], wait_s: float) -> dict[str, Any]:
    """Extend an accepted send with the outcome of waiting for it to land.

    Adds nothing at all when the caller did not ask to wait, so the default
    answer stays exactly the one every existing caller already parses.
    """
    if wait_s <= 0 or not sent.get("ok"):
        return sent
    msg_key = str(sent.get("msg_key") or "")
    if not msg_key:
        return sent
    started = time.monotonic()
    await _await_delivery(msg_key, wait_s)
    return {**sent, **_delivery_outcome(msg_key, time.monotonic() - started)}


@server.tool()
async def cli_check_message(msg_key: str, ctx: Context) -> dict[str, Any]:
    """Look up what became of a message you sent with cli_send.

    `msg_key` is the value cli_send returned. Returns {ok, msg_key, status,
    target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?,
    stale?}. `status` is one of:

      - "queued"    — broadcast for delivery; no window has reported back yet.
                      A message held for a busy pane stays here until it is
                      actually injected.
      - "delivered" — the receiving window injected and submitted it.
      - "failed"    — the receiving window refused or lost it; see `reason`.
      - "rejected"  — only for a message sent to another device: that device's
                      pane policy refuses this sender. Re-sending refuses
                      again; this is a permission question for a human, not
                      something to retry.
      - "cancelled" — withdrawn before it went in, by cli_cancel_message or by
                      someone using the Messages panel. Nothing went wrong and
                      nothing is waiting; resend only if you still mean it.

    `reason` values come from the receiving window: "rate-limit" (too many
    messages between the same pair too quickly), "queue-full" (the target's
    pending-message queue is at its cap), "inject-failed" (typing it into the
    pane did not take), "pane-closed" (the target went away before delivery),
    "no-report" (the delivery attempt never reported an outcome). Two reasons
    do NOT mean something went wrong: "read" pairs with "delivered" and means
    the recipient took the message with cli_read_incoming instead of having it
    typed in, and "cancelled" pairs with the status of the same name.

    On a "queued" message, `hold` is why it has not gone in yet — {key, n?},
    the same reason the Messages panel shows — and `held_for_s` is how long it
    has been that way. `hold.key` is "typing" (someone is typing in that pane),
    "mid-turn" (its agent is working), "behind" (`n` messages ahead of it),
    "starting", "settling", "not-ready", "gone", "paused" or "remote-ack". Both
    keys are absent once the message settles, and while no window has reported
    a hold at all — a message queued with no hold is simply on its way in.

    `stale` is true once a queued message has been waiting more than two
    minutes. It is not a failure and nothing has given up on it — it is the
    point at which waiting longer is probably not the answer, so read `hold`
    and decide whether to wait, address someone else, or tell the user.

    Bounds: this is in-memory backend state, not a log. It is lost on backend
    restart, keeps only the last hour, and only the most recent few hundred
    sends — an unknown `msg_key` means "not tracked any more", not "never
    sent". Returns {ok: false, error} for an unknown key.
    """
    try:
        _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    key = (msg_key or "").strip()
    entry = _mcp_message_status.get(key)
    if entry is None:
        return {
            "ok": False,
            "error": f"unknown msg_key {key!r} — it was never sent from here, or it "
            "aged out of the in-memory table (last hour only)",
        }
    now = time.monotonic()
    status: dict[str, Any] = {
        "ok": True,
        "msg_key": key,
        "status": entry["status"],
        "target": entry["target"],
        "age_seconds": round(now - entry["created_at"], 1),
    }
    if entry["reason"]:
        status["reason"] = entry["reason"]
    if entry["delivered_at"] is not None:
        status["settled_after_s"] = round(entry["delivered_at"] - entry["created_at"], 1)
    status.update(_hold_view(entry, now))
    if _is_stale(entry, now):
        status["stale"] = True
    return status


@server.tool()
async def cli_inbox_summary(ctx: Context) -> dict[str, Any]:
    """List the messages you sent that are stuck or that never got through.

    Takes no arguments and asks about no one but you: it returns the sends made
    from this caller — this pane, or this external client — that are currently
    stale (queued more than two minutes) or failed. Everything that was
    delivered, and everything still on its way in, is left out.

    This is the pull half of delivery feedback, and it exists for the agent the
    push half cannot reach. A failure notice is typed back into the sending
    pane once that pane is idle, so an agent that stays busy for an hour never
    sees one, and an external client has no pane to type into at all. Calling
    this between pieces of your own work is how you find out that the message
    you sent twenty minutes ago is still sitting in a queue.

    Returns {ok, count, messages: [{msg_key, target, status, age_seconds,
    stale?, reason?, hold?, held_for_s?, excerpt}]}, newest send last. `excerpt`
    is the first 60 characters of what you sent, so a message is recognizable
    without keeping every msg_key. The same in-memory bounds as
    cli_check_message apply: the last hour, the last few hundred sends, gone on
    backend restart. An empty list means nothing of yours is stuck — it never
    means nothing was sent.
    """
    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    origin = (caller.pane_id if caller.kind == "pane" else "") or caller.kind
    now = time.monotonic()
    messages: list[dict[str, Any]] = []
    for key, entry in _mcp_message_status.items():
        if entry.get("origin") != origin:
            continue
        stale = _is_stale(entry, now)
        if not stale and entry["status"] not in ("failed", "rejected"):
            continue
        row: dict[str, Any] = {
            "msg_key": key,
            "target": entry["target"],
            "status": entry["status"],
            "age_seconds": round(now - entry["created_at"], 1),
            "excerpt": entry.get("excerpt", ""),
        }
        if stale:
            row["stale"] = True
        if entry["reason"]:
            row["reason"] = entry["reason"]
        row.update(_hold_view(entry, now))
        messages.append(row)
    return {"ok": True, "count": len(messages), "messages": messages}


def _hold_for_correlation(correlation_id: str) -> dict[str, Any]:
    """The recorded hold for a message, looked up by the id both ends share.

    ``_mcp_message_status`` is the SENDER's bookkeeping: the receiving window
    reports a hold change against the msg_key its delivery arrived with, and
    cli_check_message reads it back. The recipient's copy of that same message
    carries the same string as its ``correlation_id``, so the recipient can ask
    the identical question — which is the point: sender and receiver see one
    hold, not two accounts of it.

    Empty for a message this backend never routed (two panes of one window
    mint no key at all), for one from another device, and for one already
    evicted from the bounded table. Absence therefore means "nothing recorded
    here", never "nothing is holding it".
    """
    entry = _mcp_message_status.get(correlation_id) if correlation_id else None
    if entry is None:
        return {}
    now = time.monotonic()
    view = dict(_hold_view(entry, now))
    if _is_stale(entry, now):
        view["stale"] = True
    return view


def _incoming_hold(row: Any, correlation_id: str) -> dict[str, Any]:
    """Why an incoming message has not been typed into your pane yet.

    Two sources for one fact. The window that owns the queue knows the live
    ``{key, n}`` and puts it on a cli_read_incoming row; the backend has only
    what that window reported for a message IT dispatched, but it is the only
    side holding a clock, so ``held_for_s`` and ``stale`` come from there
    whichever side supplied the hold.

    The owning window wins when it answered at all: it is the authority on its
    own queue, and a backend record left behind by a race must not contradict
    a window that just said nothing is holding this message.
    """
    view = _hold_for_correlation(correlation_id)
    if isinstance(row, dict) and "hold" in row:
        live = row.get("hold")
        if isinstance(live, dict) and live.get("key"):
            hold: dict[str, Any] = {"key": str(live["key"])}
            n = live.get("n")
            if isinstance(n, (int, float)) and not isinstance(n, bool):
                hold["n"] = int(n)
            view["hold"] = hold
        else:
            view.pop("hold", None)
            view.pop("held_for_s", None)
    return view


def _threading_of(row: Any) -> tuple[str, str]:
    """``(correlation_id, in_reply_to)`` from a row, whichever side wrote it.

    A cli_read_incoming row comes from the renderer in camelCase; every other
    read here comes from the sqlite log in its column names. Both spellings
    carry the same two values, so they are read here rather than at two call
    sites that could drift apart.
    """
    if not isinstance(row, dict):
        return "", ""
    correlation = str(row.get("correlationId") or row.get("correlation_id") or "")
    in_reply_to = str(row.get("inReplyTo") or row.get("reply_to") or "")
    return correlation, in_reply_to


# How much of an incoming message cli_pending_incoming quotes back. Larger than
# the outgoing excerpt: you wrote the ones cli_inbox_summary lists and only need
# to recognize them, while these you have never seen, and the whole point is to
# judge whether to break off what you are doing.
_INCOMING_EXCERPT_CHARS = 200


@server.tool()
async def cli_pending_incoming(ctx: Context, limit: int = 20) -> dict[str, Any]:
    """List the messages waiting to be delivered *to you*.

    The mirror of cli_inbox_summary, which asks only about what you sent. This
    asks what is queued for you and has not gone in yet — which, while you are
    working, is everything anyone has sent you: a message is typed into a pane
    only between turns, so an agent that stays busy is precisely the one that
    cannot be told. Until this existed there was no way to find out; the queue
    lives in the receiving window, and nothing offered the recipient's view of
    it.

    Call it between pieces of your own work when something may be waiting on
    you — after dispatching a task with cli_open_agent, or during a long run
    someone might need to interrupt. A non-empty answer is grounds to wrap up
    the turn you are in, which is what lets the message land.

    `excerpt` is 200 characters with the whitespace flattened: enough to tell
    what a message is about, not enough to act on. cli_read_incoming returns
    what was actually written, and can take a message off the queue so it is
    not typed in afterwards.

    Returns {ok, count, messages: [{uid, sender, status, age_seconds, kind?,
    excerpt, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}]},
    oldest first. `status` is "queued" (waiting for you to be between turns) or
    "delivering" (going in right now). `kind` marks a message Navide wrote
    rather than an agent: "notice" is delivery feedback about your own send,
    "fallback" is a spawned pane's turn forwarded because it ended without
    writing a report.

    `correlation_id` is the one string you and the sender both know this
    message by — the sender's `msg_key`. Pass it to cli_send's `reply_to` to
    answer this message rather than start a new thread. `in_reply_to` is the
    `uid` of the message THIS one answers, when it is itself a reply. Both are
    absent for a message between two panes of a single window: that message is
    never routed, so no such id is ever minted, and the two of you already
    share this `uid`.

    `hold` says why your queue is not moving — {key, n?}, the same reason the
    sender reads from cli_check_message, with `held_for_s` and `stale` (waiting
    over two minutes) beside it. "mid-turn" is you: the message goes in when
    you finish this turn. "typing" is a human at that keyboard, "paused" is
    delivery switched off in that window, and "behind" means `n` messages are
    ahead of this one. It is absent unless this backend dispatched the message
    and the owning window has reported a hold for it — so absence means
    "nothing recorded", not "nothing is holding it". For the live queue state
    of a message this cannot explain, read it with cli_read_incoming
    (`peek: true` leaves delivery alone), which asks the window that owns the
    queue instead of this log.

    Read from the persisted message log, so unlike cli_inbox_summary this
    survives a backend restart. Two limits are worth knowing: the log is
    written by the receiving window a moment after a message is queued, so
    something sent in the last second may not be listed yet; and messages are
    matched by your current messaging name, so anything queued for a name you
    have since been renamed away from is not yours to see. An empty list means
    nothing is waiting — it never means nothing was sent.
    """
    from agent_team_backend import agent_messaging, app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {
            "ok": False,
            "error": (
                "only a Navide CLI pane has an inbox — a host or external caller "
                "has no messaging name for anything to be addressed to."
            ),
        }
    # _resolve_caller has just rejected a stale pane id, so this is set; the
    # guard is here for the type, not for a reachable state.
    me = agent_messaging.get(caller.pane_id)
    if me is None:
        return {"ok": False, "error": "this pane is no longer registered for messaging"}
    rows = await asyncio.to_thread(
        app.agent_message_log.pending_incoming, me.name, max(1, min(int(limit), 200))
    )
    now_ms = time.time() * 1000.0
    messages: list[dict[str, Any]] = []
    for row in rows:
        excerpt = "".join(list(" ".join(str(row.get("content") or "").split()))[
            :_INCOMING_EXCERPT_CHARS
        ])
        message: dict[str, Any] = {
            "uid": row.get("uid", ""),
            "sender": row.get("sender", ""),
            "status": row.get("status", ""),
            "age_seconds": round(max(0.0, now_ms - float(row.get("created_at") or now_ms)) / 1000.0, 1),
            "excerpt": excerpt,
        }
        if row.get("kind"):
            message["kind"] = row["kind"]
        correlation, in_reply_to = _threading_of(row)
        if correlation:
            message["correlation_id"] = correlation
        if in_reply_to:
            message["in_reply_to"] = in_reply_to
        message.update(_incoming_hold(row, correlation))
        messages.append(message)
    return {"ok": True, "count": len(messages), "messages": messages}


# The full text of one incoming message, bounded by what the log itself stores
# (agent_message_log clamps content at 64K chars on the way in, so anything
# longer was already truncated before this tool could see it).
_INCOMING_FULL_MAX_CHARS = 64 * 1024

# How many messages one read may take at once. Small on purpose: each one is up
# to 64K of the caller's context, and taking more than a handful in a single
# call is a sign of an agent draining a backlog it should be answering.
_INCOMING_READ_MAX = 20


@server.tool()
async def cli_read_incoming(
    ctx: Context,
    uid: str = "",
    limit: int = 5,
    include_delivered: bool = False,
    peek: bool = False,
) -> dict[str, Any]:
    """Read the full text of messages sent TO you.

    cli_pending_incoming tells you a message exists and shows 200 characters
    of it with the whitespace flattened. This returns what was actually
    written. Until it existed you could read another pane's entire log but not
    one message addressed to yourself.

    BY DEFAULT READING CONSUMES. A message you read here is not typed into
    your input box afterwards — you have it, so delivering it again would
    repeat it. Pass `peek: true` to read without consuming, which leaves
    delivery exactly as it was.

    `uid` reads one message (the uid comes from cli_pending_incoming);
    omitting it reads the oldest `limit` waiting for you. `include_delivered`
    also returns messages already typed into your pane, for looking back at
    what someone said — those are never consumed, because they already were.

    Consuming is two steps, and the failure mode is deliberate: the message is
    reserved, handed to you, and only then released. If the release is lost
    the reservation expires and the message goes BACK to the queue, so it may
    reach you a second time. That is the safe direction — a duplicate is
    visible and a loss is not. Treat a message you have already handled as
    something to recognise, not something that cannot arrive twice.

    Returns {ok, count, messages: [{uid, sender, status, kind?, content,
    age_seconds, consumed, correlation_id?, in_reply_to?, hold?, held_for_s?,
    stale?}]}. `consumed` is per message and is false when the read was a peek,
    when the message was already delivered, or when the window could not be
    reached to release the reservation — in that last case you have the text
    but delivery was left alone, so expect it in your pane.

    `correlation_id` is the one string you and the sender both know this
    message by. Pass it to cli_send's `reply_to` and your answer lands ON this
    message instead of starting a new thread — the same thing an envelope typed
    into your pane asks for with its `re:` field, which until now was the only
    way to reply to a specific message. `in_reply_to` is the `uid` of the
    message THIS one answers, when it is itself a reply. Both are absent for a
    message between two panes of a single window: nothing routes it, so no such
    id exists, and you and the sender already share this `uid`.

    `hold` is why the message had not been typed in yet — {key, n?}: "mid-turn"
    (you are working; it goes in when this turn ends), "typing" (a human at
    that keyboard), "behind" (`n` messages ahead of it), "paused" (delivery
    switched off in that window), "starting", "settling", "not-ready", "gone"
    or "remote-ack". `held_for_s` and `stale` (waiting over two minutes) come
    with it when this backend dispatched the message. Absent means nothing is
    holding it, not that nothing is known — and note that a read of your own
    reserves what it returns, so a hold you read here is the state BEFORE that.

    Only a Navide CLI pane has an inbox. Messages are matched by your current
    messaging name, so anything queued for a name you have been renamed away
    from is not yours to see.
    """
    from agent_team_backend import agent_messaging

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if caller.kind != "pane":
        return {
            "ok": False,
            "error": (
                "only a Navide CLI pane has an inbox — a host or external caller "
                "has no messaging name for anything to be addressed to."
            ),
        }
    me = agent_messaging.get(caller.pane_id)
    if me is None:
        return {"ok": False, "error": "this pane is no longer registered for messaging"}

    wanted = [uid.strip()] if uid.strip() else []
    count = max(1, min(int(limit), _INCOMING_READ_MAX))
    args: dict[str, Any] = {
        "paneId": caller.pane_id,
        "uids": wanted,
        "limit": count,
        "includeDelivered": bool(include_delivered),
        "reserve": not peek,
        "maxChars": _INCOMING_FULL_MAX_CHARS,
    }
    reply = await _ui_request(
        me.workspace_path,
        "invoke",
        caller=_pane_caller(caller.pane_id),
        action="ui.messaging.readIncoming",
        args=args,
    )
    degraded = ""
    paused = False
    if reply.get("ok"):
        result = reply.get("result") or {}
        rows = result.get("messages") or []
        reserved = [str(u) for u in (result.get("reserved") or [])]
        paused = bool(result.get("paused"))
    else:
        # The window did not answer. Read from the log instead of failing: the
        # text is what was asked for and the log has it. Nothing is reserved,
        # so delivery is untouched and the message still reaches the pane —
        # answering with the text and saying so beats refusing outright.
        from agent_team_backend import app

        rows = await asyncio.to_thread(
            app.agent_message_log.incoming, me.name, bool(include_delivered), count
        )
        if wanted:
            rows = [r for r in rows if str(r.get("uid") or "") in set(wanted)]
        reserved = []
        degraded = str(reply.get("error") or "the window owning this pane did not answer")

    # Second step. Nothing is consumed until the window is told the text
    # reached us; if this call fails the reservation expires on its own and the
    # message returns to the queue, which is why `consumed` is reported per
    # message rather than assumed.
    released: set[str] = set()
    if reserved:
        settle = await _ui_request(
            me.workspace_path,
            "invoke",
            caller=_pane_caller(caller.pane_id),
            action="ui.messaging.settleRead",
            args={"paneId": caller.pane_id, "uids": reserved, "ok": True},
        )
        if settle.get("ok"):
            released = {str(u) for u in ((settle.get("result") or {}).get("settled") or [])}

    now_ms = time.time() * 1000.0
    messages: list[dict[str, Any]] = []
    for row in rows:
        row_uid = str(row.get("uid") or "")
        created = float(row.get("createdAt") or row.get("created_at") or now_ms)
        message: dict[str, Any] = {
            "uid": row_uid,
            "sender": str(row.get("sender") or ""),
            "status": str(row.get("status") or ""),
            "content": str(row.get("content") or "")[:_INCOMING_FULL_MAX_CHARS],
            "age_seconds": round(max(0.0, now_ms - created) / 1000.0, 1),
            "consumed": row_uid in released,
        }
        if row.get("kind"):
            message["kind"] = row["kind"]
        correlation, in_reply_to = _threading_of(row)
        if correlation:
            message["correlation_id"] = correlation
        if in_reply_to:
            message["in_reply_to"] = in_reply_to
        message.update(_incoming_hold(row, correlation))
        messages.append(message)

    answer: dict[str, Any] = {"ok": True, "count": len(messages), "messages": messages}
    if degraded:
        answer["note"] = (
            f"read from the message log because the window did not answer ({degraded}); "
            "nothing was consumed, so these still reach your pane."
        )
        return answer
    if paused and not reserved:
        # Delivery being paused is why a read can come back with nothing while
        # messages are in fact waiting. An empty answer would read as "you have
        # no mail", which is the one thing this tool must never imply.
        answer["note"] = (
            "delivery is paused in this window, so nothing could be taken. Any "
            "messages listed were read only; more may be waiting behind the pause."
        )
        return answer
    stranded = [u for u in reserved if u not in released]
    if stranded:
        # Say it plainly rather than leaving the agent to compare two lists.
        answer["note"] = (
            f"{len(stranded)} message(s) were read but not consumed — the window "
            "could not confirm. They stay queued and will reach your pane."
        )
    return answer


# How long to wait for the owning window to say whether a withdrawal landed.
# Short: the answer comes from a window that already has the queue in memory,
# so it is a round trip rather than a piece of work — and a caller that has
# just changed its mind should not be parked for long.
_CANCEL_VERDICT_TIMEOUT_S = 5.0


@server.tool()
async def cli_cancel_message(msg_key: str, ctx: Context) -> dict[str, Any]:
    """Withdraw a message you sent, if it has not gone in yet.

    A message sits in the recipient's queue until that pane is between turns,
    which is often a long time. Until now a sender that changed its mind — the
    wrong target, a premise that stopped being true, a task already done by
    someone else — could only watch it go in and then send a correction, which
    costs the recipient a whole turn to work out that the first message no
    longer applies.

    `msg_key` is what cli_send returned. Withdrawal is decided by the window
    that owns the queue, because only it knows whether the message is still
    waiting: if it is, the message is dropped and the status becomes
    "cancelled"; if delivery already started, the withdrawal is ignored and the
    delivery reports its own outcome as usual. Either way you get the settled
    status back, so a "delivered" answer here means you were too late rather
    than that something failed.

    Withdrawing is not failing. The status is "cancelled" and no failure notice
    is written back to you — there is nothing to explain to the pane that just
    changed its mind. Resend with cli_send if you still mean it.

    Only messages this server sent can be withdrawn, and only for about an
    hour, which is how long their keys are tracked. An unknown key means "not
    tracked any more", not "never sent" — the same caveat cli_check_message
    carries.

    Returns {ok, msg_key, status, reason?} or {ok: false, error}.
    """
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    try:
        _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    key = (msg_key or "").strip()
    if not key:
        return {"ok": False, "error": "msg_key is required — it is what cli_send returned"}

    entry = _mcp_message_status.get(key)
    if entry is None:
        return {
            "ok": False,
            "error": (
                f"unknown msg_key {key!r} — it was never sent from here, or it is older "
                "than the hour these are tracked for. An untracked key says nothing "
                "about whether the message arrived; ask cli_check_message."
            ),
        }
    if entry["status"] != "queued":
        # Already settled. Say what it settled as rather than refusing flatly:
        # "delivered" is the answer to "can I still take it back", not an error.
        answer: dict[str, Any] = {
            "ok": False,
            "msg_key": key,
            "status": entry["status"],
            "error": f"too late — this message is already {entry['status']}",
        }
        if entry.get("reason"):
            answer["reason"] = entry["reason"]
        return answer

    await app.broadcast(make_event("agent_msg.cancel", {"msg_key": key}))
    # The owning window answers over the ordinary delivered path, so waiting for
    # a settled status is the same wait a send with wait_for_delivery_s does.
    await _await_delivery(key, _CANCEL_VERDICT_TIMEOUT_S)

    settled = _mcp_message_status.get(key)
    status = settled["status"] if settled else "unknown"
    result: dict[str, Any] = {"ok": status == "cancelled", "msg_key": key, "status": status}
    if settled and settled.get("reason"):
        result["reason"] = settled["reason"]
    if status == "queued":
        # No window claimed it within the timeout. The message is still on its
        # way, so say that rather than implying the withdrawal took.
        result["error"] = (
            "no window answered in time; the message is still queued and may yet "
            "be delivered. Check cli_check_message before assuming it was withdrawn."
        )
    elif status != "cancelled":
        result["error"] = f"too late — the message was already {status}"
    return result


# ── Reading another pane (cli_read_log / cli_get_status / cli_wait_idle) ────

# Bounds one read of an arbitrarily large conversation log. The cost here is
# the caller's context window, not backend memory — a string this size is
# nothing to the process — and the tool also returns log_path so a caller that
# needs the whole file can read it directly. Sized to let an agent review a
# genuinely long exchange in one call rather than paging through it.
_LOG_TAIL_MAX_BYTES = 512 * 1024


def _read_log_window(path: Path, since: int | None, tail_lines: int) -> tuple[str, bool, bool, int]:
    """A window of a log file, bounded by both a byte budget and a line count.

    With `since` None this is the tail: at most _LOG_TAIL_MAX_BYTES from the
    end of the file (bounds memory for an arbitrarily large log). With `since`
    set it is everything appended after that byte offset, still capped by the
    same byte budget. Either way only the last `tail_lines` lines survive.

    Returns (text, truncated, rotated, next_cursor). `truncated` is True
    whenever content before the returned text was dropped — the byte budget
    clipped the window, or more lines existed in it than `tail_lines` kept.
    `rotated` is True when `since` pointed past the end of the file, meaning
    the log was truncated or replaced and the cursor no longer refers to
    anything; the read then falls back to a plain tail. `next_cursor` is the
    offset to pass as `since` next time.
    """
    size = path.stat().st_size
    rotated = since is not None and since > size
    base = 0 if (since is None or rotated) else max(0, since)
    start = max(base, size - _LOG_TAIL_MAX_BYTES)
    with path.open("rb") as f:
        if start:
            f.seek(start)
        data = f.read()
    text = data.decode("utf-8", errors="replace")
    byte_truncated = start > base
    lines = text.splitlines()
    line_truncated = len(lines) > tail_lines
    if line_truncated:
        lines = lines[-tail_lines:]
    return "\n".join(lines), byte_truncated or line_truncated, rotated, size


# ── Resolving a pane for the read-only cli_* tools ─────────────────────────
def _resolve_pane_target(
    caller: "_Caller", me: str, target: str, pane_id: str
) -> tuple[Any, dict[str, Any] | None]:
    """Resolve `pane_id` when one was given, `target` otherwise.

    Shared by the tools that only read a pane, so an id means the same thing in
    all of them as it does in cli_send. Returns (result, failure): `failure` is
    the error dict to hand straight back, or None when `result.pane` is set.
    """
    from agent_team_backend import agent_messaging

    ident = (pane_id or "").strip()
    if ident:
        result = agent_messaging.resolve_pane_id(me, ident)
        if result.pane is None:
            return result, {
                "ok": False,
                "error": result.error,
                "error_code": result.code or "unknown-pane-id",
            }
        return result, None
    if caller.kind != "pane" and "/" not in (target or ""):
        return None, {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}
    result = agent_messaging.resolve(me, target)
    if result.pane is None:
        return result, {
            "ok": False,
            "error": result.error or f'unknown target "{target}"',
            "error_code": result.code or "unknown-target",
        }
    return result, None


@server.tool()
async def cli_read_log(
    target: str,
    ctx: Context,
    tail_lines: int = 200,
    since: int | None = None,
    pane_id: str = "",
) -> dict[str, Any]:
    """Read a CLI pane's conversation log file.

    `target` uses the same addressing as cli_send (cli_list_targets shows the
    forms); a caller with no pane identity must use the qualified
    `<folder>/<pane>` form. `pane_id` names one exact pane and makes `target`
    unnecessary — cli_send documents when to reach for it. Returns
    {ok, target, log_path, text, truncated, next_cursor, rotated} — `text` is
    at most 512KB and `tail_lines` lines, whichever is smaller; `truncated` is
    true when older content was dropped to fit. Fails when the target is
    unknown or its log file was never recorded / no longer exists.

    `since` reads incrementally: pass the `next_cursor` from your previous
    call to get only what the pane has said since then, instead of re-reading
    the same tail. The cursor is a byte offset into an append-only capture
    file. If the file was truncated or replaced under you the cursor no longer
    means anything — the call then returns a plain tail with `rotated: true`,
    so treat that read as a fresh start rather than as new output.
    """
    from agent_team_backend import app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        return failure

    def _find_log_path() -> str:
        project = app.project_store.peek(result.pane.workspace_path)
        if project is None:
            return ""
        record = next((p for p in project.panes if p.pane_id == result.pane.pane_id), None)
        return record.output_log_file if record else ""

    log_path_str = await asyncio.to_thread(_find_log_path)
    if not log_path_str:
        return {
            "ok": False,
            "error": f"no log file recorded for pane {result.pane.qualified_name!r}",
        }
    log_path = Path(log_path_str)
    if not log_path.is_file():
        return {"ok": False, "error": f"log file no longer exists: {log_path}"}

    text, truncated, rotated, next_cursor = await asyncio.to_thread(
        _read_log_window,
        log_path,
        None if since is None else max(0, int(since)),
        max(1, int(tail_lines)),
    )
    return {
        "ok": True,
        "target": result.pane.qualified_name,
        "log_path": str(log_path),
        "text": text,
        "truncated": truncated,
        "rotated": rotated,
        "next_cursor": next_cursor,
    }


def _activity_summary(pane_id: str) -> dict[str, Any] | None:
    """The pane's last recorded activity, shaped for a tool result.

    Only turn_complete carries text; agent_active never does.
    """
    from agent_team_backend import app

    activity = app.pane_activity(pane_id)
    if activity is None:
        return None
    last: dict[str, Any] = {
        "type": activity["event_type"],
        "age_seconds": round(time.monotonic() - activity["ts_monotonic"], 1),
    }
    if activity["text"]:
        last["text"] = activity["text"]
    return last


@server.tool()
async def cli_get_status(target: str, ctx: Context, pane_id: str = "") -> dict[str, Any]:
    """Report whether a CLI pane is busy and its most recent activity.

    `target` uses the same addressing as cli_send, and `pane_id` names one
    exact pane instead. Returns {ok, name,
    agent_key, busy, last_activity?, ui?}. `last_activity`, when known, is
    {type: "agent_active"|"turn_complete", text? (turn_complete only),
    age_seconds}. `ui`, when the owning Navide window answers in time, is
    {status, buffer, logPath?, awaitingKind?, kickoff?} straight from the
    renderer; it is omitted (not a failure) when the window does not reply.

    `ui.kickoff` is how this pane's spawn-time task injection ended, and it is
    the authoritative answer to "did cli_open_agent's task actually arrive":

      - "sent" — our own text was observed landing in the composer.
      - "unverified" — the bytes were written and the echo check passed, but
        only on buffer growth, which a CLI painting its first screen does
        whatever happened to our text. Treat it as "probably not delivered":
        read `buffer`, and re-send with cli_send if the prompt is empty.
      - "failed" — the injection did not go in. 
      - "pending" — still running.

    Absent when the pane was not spawned with a task.
    """

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        return failure
    pane = result.pane

    status: dict[str, Any] = {
        "ok": True,
        "name": pane.name,
        "agent_key": pane.agent_key,
        "busy": pane.busy,
    }
    last = _activity_summary(pane.pane_id)
    if last is not None:
        status["last_activity"] = last

    ui_result = await _ui_request(
        pane.workspace_path,
        "invoke",
        caller=_pane_caller(pane.pane_id),
        action="ui.pane.getStatus",
        args={"paneId": pane.pane_id},
    )
    if ui_result.get("ok") and isinstance(ui_result.get("result"), dict):
        status["ui"] = ui_result["result"]
    return status


_WAIT_IDLE_POLL_S = 1.0
_WAIT_IDLE_QUIET_S = 10.0
_WAIT_IDLE_MAX_TIMEOUT_S = 120.0
# Poll the owning window this often (in poll ticks) for its own view of the
# pane. The registry's busy flag is reported by the frontend and can stay
# stale, and log-reader activity only exists for the CLIs whose reader emits
# it — the renderer's status is the one signal that is always current.
_WAIT_IDLE_UI_PROBE_EVERY = 5
# A window that misses one probe is not necessarily gone — it may just be busy
# enough to miss the deadline — but with no window listening at all every probe
# burns the full _ui_request timeout. So back off (the interval doubles per
# consecutive failure) instead of retrying at the normal rate, and only give up
# for good after this many failures in a row.
_WAIT_IDLE_UI_MAX_FAILURES = 3
# Deliberately excludes "awaiting": a pane parked on a permission prompt is
# quiet, but it is waiting on the USER, and sending it work would answer the
# prompt instead of starting a turn. Waiting it out until the timeout is the
# safe failure here.
_UI_IDLE_STATUSES = frozenset({"idle", "exited", "stopped", "error"})

# ...with one exception inside "awaiting". The renderer merged its two parked
# states into one badge, so "awaiting" now covers both a permission prompt and
# the agent asking a question, and only `awaitingKind` separates them. A
# question renames panes the renderer already reported as "idle" here (a turn
# that ended on one), so treating it as busy would make cli_wait_idle newly
# block until timeout on exchanges it has always returned from. It mirrors the
# messaging gate in App.vue, which passes a question for the same reason.
#
# A reply with no awaitingKind is treated as the permission case: this crosses
# a language boundary that no type checker guards, so an older window that
# does not send the field must fail toward the safe side.
_UI_IDLE_AWAITING_KINDS = frozenset({"question"})


def _ui_status_is_idle(payload: dict[str, Any]) -> bool:
    """Whether a `ui.pane.getStatus` reply means the pane can take work."""
    status = str(payload.get("status") or "")
    if status in _UI_IDLE_STATUSES:
        return True
    if status != "awaiting":
        return False
    return str(payload.get("awaitingKind") or "") in _UI_IDLE_AWAITING_KINDS


@server.tool()
async def cli_wait_idle(
    target: str, ctx: Context, timeout_s: float = 60.0, pane_id: str = ""
) -> dict[str, Any]:
    """Block until a CLI pane goes idle, or a timeout passes.

    `target` uses the same addressing as cli_send, and `pane_id` names one
    exact pane instead. `timeout_s` is capped at
    120s. Three signals settle it, in the order they become available: the
    pane's last activity was a turn_complete (aider/antigravity/claude/codex/
    copilot/cursor/kilo/muse/opencode report one directly, so detection is
    precise for them; grok/kimi/pi/qwen synthesize one from 8s of silence, so
    theirs is already an inference); at least 10s of silence
    passed since its last activity; or, while the registry still reports busy,
    the owning window reports the pane itself as idle/exited/stopped/error.
    That last one matters because the busy flag is frontend-reported and can
    stay stale. Returns {idle, source, waited_s, last_activity?, ui_status?}
    where source is "turn_complete", "quiet_period", "ui_status",
    "never_started", or "timeout"; or {ok: false, error} if `target` cannot be
    resolved.

    `last_activity` is what cli_get_status reports under the same key — {type,
    text? (turn_complete only), age_seconds} — so a caller that waited for a
    turn to end also gets what the turn said, without a second call. It is
    absent for a pane whose CLI records no activity at all. `ui_status` is the
    owning window's own word for the pane, present only when a probe reached
    it during the wait.

    "never_started" is idle in the sense that nothing is running, but the pane
    has shown no activity at all — a CLI that finished booting and is sitting
    at its prompt. If you just gave it a task, that task has not begun yet;
    keep waiting rather than treating it as done.

    On timeout the result also carries `reason`, which separates three very
    different failures: "awaiting" (the pane is parked on a permission prompt
    and is waiting on a HUMAN, not on work — answer it in the UI), "busy" (it
    really is still working; wait longer), and "unreachable" (the window that
    owns the pane stopped answering, so nothing here is current).
    """
    from agent_team_backend import agent_messaging, app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    result, failure = _resolve_pane_target(caller, me, target, pane_id)
    if failure is not None:
        return failure
    pane_id = result.pane.pane_id

    workspace_path = result.pane.workspace_path
    timeout = min(max(float(timeout_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)
    started = time.monotonic()

    ui_reachable = True
    ui_failures = 0
    next_ui_probe_tick = 0
    ui_status: str | None = None

    def done(source: str) -> dict[str, Any]:
        out: dict[str, Any] = {
            "idle": True,
            "source": source,
            "waited_s": round(time.monotonic() - started, 1),
        }
        last = _activity_summary(pane_id)
        if last is not None:
            out["last_activity"] = last
        if ui_status is not None:
            out["ui_status"] = ui_status
        return out

    def timed_out(waited: float) -> dict[str, Any]:
        # Three failures a caller has to tell apart, and only one of them is
        # "wait longer": parked on a human, genuinely working, or nobody left
        # to ask.
        if ui_status == "awaiting":
            reason = "awaiting"
        elif not ui_reachable or (ui_failures and ui_status is None):
            reason = "unreachable"
        else:
            reason = "busy"
        out: dict[str, Any] = {
            "idle": False,
            "source": "timeout",
            "reason": reason,
            "waited_s": round(waited, 1),
        }
        last = _activity_summary(pane_id)
        if last is not None:
            out["last_activity"] = last
        if ui_status is not None:
            out["ui_status"] = ui_status
        return out

    tick = 0
    while True:
        entry = agent_messaging.get(pane_id)
        busy = bool(entry.busy) if entry else False
        if not busy:
            activity = app.pane_activity(pane_id)
            if activity is None:
                return done("quiet_period")
            if activity["event_type"] == "turn_complete":
                return done("turn_complete")
            if time.monotonic() - activity["ts_monotonic"] >= _WAIT_IDLE_QUIET_S:
                return done("quiet_period")
        elif ui_reachable and tick >= next_ui_probe_tick:
            # busy says otherwise, so ask the window that can actually see the
            # pane.
            ui = await _ui_request(
                workspace_path,
                "invoke",
                caller=_pane_caller(pane_id),
                action="ui.pane.getStatus",
                args={"paneId": pane_id},
            )
            payload = ui.get("result") if ui.get("ok") else None
            if not isinstance(payload, dict):
                ui_failures += 1
                if ui_failures >= _WAIT_IDLE_UI_MAX_FAILURES:
                    ui_reachable = False
                else:
                    next_ui_probe_tick = tick + _WAIT_IDLE_UI_PROBE_EVERY * (2**ui_failures)
            else:
                ui_failures = 0
                next_ui_probe_tick = tick + _WAIT_IDLE_UI_PROBE_EVERY
                ui_status = str(payload.get("status") or "")
                if _ui_status_is_idle(payload):
                    # A window reporting idle only means "not working right
                    # now". For a pane that has never shown any activity that
                    # means "has not started yet", not "finished" — a caller
                    # that just handed it a task must be able to tell those
                    # apart.
                    if app.pane_activity(pane_id) is None:
                        return done("never_started")
                    return done("ui_status")
        tick += 1
        waited = time.monotonic() - started
        if waited >= timeout:
            return timed_out(waited)
        await asyncio.sleep(_WAIT_IDLE_POLL_S)


# How long to keep watching for the target to pick the message up before
# falling through to the idle wait. Delivery is queued behind whatever the
# pane is doing and the injected text only shows up as activity once its CLI
# records the prompt, so "nothing yet" right after the send is normal.
_SEND_AND_WAIT_START_GRACE_S = 10.0


def _never_arrived(sent: dict[str, Any], started: float) -> dict[str, Any]:
    """The message never reached the pane, so there is no turn to wait for.

    The bug this closes: a target that is idle when you send, with the message
    then held (someone typing in it, a queue ahead of it), used to answer
    "idle" from the state it was sent into — read as "it finished your work"
    when the work had not even been handed over.

    `ok` stays true for the same reason target_lost does: the send happened and
    `msg_key` is real, so answering false would read as "never sent" and invite
    a resend.
    """
    result: dict[str, Any] = {
        "ok": True,
        "target": sent["target"],
        "msg_key": sent["msg_key"],
        "idle": False,
        "source": "not_delivered",
        "delivery_status": sent.get("status", "queued"),
        "waited_s": round(time.monotonic() - started, 1),
    }
    for key in ("reason", "hold", "held_for_s", "stale"):
        if key in sent:
            result[key] = sent[key]
    return result


@server.tool()
async def cli_send_and_wait(
    to: str, text: str, ctx: Context, timeout_s: float = 60.0, pane_id: str = ""
) -> dict[str, Any]:
    """Send an instruction to another CLI pane and wait for it to finish it.

    cli_send followed by cli_wait_idle, with the race between them handled:
    the target is idle at the moment you send, so a plain wait would return
    "already idle" before it ever read your message. This one waits for the
    message to actually GO IN first, then remembers the target's last activity
    before sending and only accepts a turn NEWER than that as your answer.

    `to`, `text`, `pane_id` and addressing are cli_send's — an id given here
    addresses both halves, the send and the wait. `timeout_s` (capped at 120s)
    covers the whole thing, not just the wait: at most half of it is spent
    getting the message in, and whatever is left waits for the turn.

    On success returns cli_wait_idle's result — {idle: true, source, waited_s,
    last_activity?, ui_status?} — plus {ok: true, target, msg_key}.
    `last_activity.text` is what the other agent said, when its CLI records
    that. ALWAYS read `source`, because it says how much the "finished" is
    worth:

      - "turn_complete" — the CLI reported the turn ended. Trustworthy.
        aider/antigravity/claude/codex/copilot/cursor/kilo/muse/opencode report
        it directly; grok/kimi/pi/qwen infer it from 8s of silence, so it is a
        heuristic for them and a long pause mid-turn can end the wait early.
      - "quiet_period" — no end-of-turn signal ever arrived, the pane just
        went quiet. This is the only outcome available for a plain terminal
        pane, and the fallback whenever a turn ends without its reader
        recording one. Treat it as a guess and check the content.
      - "ui_status" — the owning window reports the pane idle.
      - "target_lost" — the target stopped being addressable during the wait
        (its window closed, the pane was killed), so the wait could not
        finish. The send still happened and `msg_key` is still valid; this is
        "delivered, but I can no longer confirm it was finished", NOT a failed
        send — do not resend on it. `error` carries the resolve failure.
      - "not_delivered" — the message never got into the pane, so there was no
        turn to wait for. `delivery_status` is "queued" (still waiting, with
        `hold` and `held_for_s` saying what for — typically someone typing in
        that pane, or a queue ahead of it), or "failed"/"rejected" with
        `reason`. A queued message is not lost: it goes in when the pane frees
        up, and cli_check_message picks the story up. Do NOT resend on this.

    On timeout returns {ok: true, idle: false, source: "timeout", reason,
    ...}: `reason` is cli_wait_idle's ("awaiting" / "busy" / "unreachable"),
    or "never_started" when the target stayed idle and never showed any sign
    of having read the message. `reason` is only meaningful for "timeout" and
    is absent from every other source. A send that is refused outright returns
    cli_send's {ok: false, error} unchanged.
    """
    from agent_team_backend import app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    if not (pane_id or "").strip() and _is_group_target(to):
        # Without this the group keyword would be resolved as a pane name and
        # come back "unknown target", which reads like a typo rather than like
        # the real answer: waiting is per-turn, and a broadcast has no single
        # turn to wait for.
        return {
            "ok": False,
            "error": 'cli_send_and_wait cannot broadcast — "group" reaches several '
            "panes and there is no one turn to wait for. Use cli_send with "
            'to="group", then cli_wait_idle on the recipients you care about',
            "error_code": "broadcast-unsupported",
        }
    # Same gate as cli_send, applied before the resolve below so an unqualified
    # address gets the same answer here as it would there.
    resolved, failure = _resolve_pane_target(caller, me, to, pane_id)
    if failure is not None:
        return failure
    target_pane_id = resolved.pane.pane_id

    baseline = app.pane_activity(target_pane_id)
    baseline_ts = baseline["ts_monotonic"] if baseline else None

    def has_new_activity() -> bool:
        current = app.pane_activity(target_pane_id)
        if current is None:
            return False
        return baseline_ts is None or current["ts_monotonic"] > baseline_ts

    started = time.monotonic()
    timeout = min(max(float(timeout_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)
    # Half the budget buys the delivery, the other half the turn it should
    # produce. Time spent waiting to get in is not lost — the message lands when
    # the pane frees up, which is most of what the idle wait was going to sit
    # through anyway — but a message still held at the halfway mark is unlikely
    # to be answered in what is left, and its hold reason is a far more useful
    # answer than "timeout, busy".
    delivery_budget = timeout / 2
    sent = await cli_send(
        to, text, ctx, wait_for_delivery_s=delivery_budget, pane_id=pane_id
    )
    if not sent.get("ok"):
        return sent
    if delivery_budget > 0 and sent.get("status") != "delivered":
        return _never_arrived(sent, started)

    def remaining() -> float:
        return timeout - (time.monotonic() - started)

    def wrap(result: dict[str, Any]) -> dict[str, Any]:
        return {**result, "ok": True, "target": sent["target"], "msg_key": sent["msg_key"]}

    def target_lost(result: dict[str, Any]) -> dict[str, Any]:
        """Translate cli_wait_idle's {ok: false, error} into a wait outcome.

        It refuses that way when the target stops being addressable partway
        through — its window closed, the pane was killed — and passing that
        shape to wrap() would bury an `ok: false` under wrap's `ok: true` and
        return a result that contradicts itself. The send itself succeeded and
        `msg_key` is real, so answering `ok: false` would tell the caller the
        message never went out and invite a resend — duplicate dispatch, which
        is far worse than an unconfirmed wait. Report the send as the success
        it was, and let `source` say that the finish can no longer be
        confirmed. No `reason`: that key only means anything for "timeout".
        """
        return wrap(
            {
                "idle": False,
                "source": "target_lost",
                "error": result.get("error") or "the target is no longer addressable",
                "waited_s": round(time.monotonic() - started, 1),
            }
        )

    # Give the target a moment to pick the message up, so the wait below is
    # about its turn rather than about the state it was already in.
    grace_deadline = started + min(timeout, _SEND_AND_WAIT_START_GRACE_S)
    while True:
        if has_new_activity() or time.monotonic() >= grace_deadline:
            break
        await asyncio.sleep(_WAIT_IDLE_POLL_S)

    while True:
        left = remaining()
        if left <= 0:
            break
        waited = await cli_wait_idle(to, ctx, timeout_s=left, pane_id=pane_id)
        if waited.get("ok") is False:
            return target_lost(waited)
        if not waited.get("idle"):
            return wrap(waited)
        if has_new_activity():
            return wrap(waited)
        # Idle, but nothing has happened since the send — it has not started
        # the work yet, so this idleness is the state we sent into.
        if remaining() <= 0:
            break
        await asyncio.sleep(_WAIT_IDLE_POLL_S)

    # No last_activity here on purpose: the only thing on record is the state
    # the pane was in BEFORE the send, and handing that back is exactly the
    # mistake this tool exists to avoid.
    return wrap(
        {
            "idle": False,
            "source": "timeout",
            "reason": "never_started",
            "waited_s": round(time.monotonic() - started, 1),
        }
    )


# ── UI control (ui_invoke / ui_snapshot / ui_list_actions) ─────────────────
# Routes a request to the renderer window that owns `workspace_path` over WS
# (`ui.invoke.request`), and waits for its `ui.invoke.result` reply. Most
# requests broadcast, and every renderer decides for itself whether it owns
# the workspace; `global=True` requests (currently only ui.workspace.open, to
# open a workspace no window has yet) unicast to one arbitrary session instead,
# since any live window can perform them and broadcasting would just make every
# other window ignore it.

_UI_INVOKE_TIMEOUT_S = 15.0
# Spawning a pane has to wait out the CLI's own startup before it can hand it
# the task, which on its own reaches the default timeout — measured at 15s for
# claude. Giving these actions the same budget as an unanswered request means
# reporting failure for work that in fact succeeded, so they get their own.
_UI_INVOKE_SLOW_TIMEOUT_S = 60.0
_UI_INVOKE_SLOW_ACTIONS = frozenset({"ui.pane.create"})
_ui_invoke_pending: PendingRegistry[dict[str, Any]] = PendingRegistry()


def resolve_ui_invoke(request_id: str, result: dict[str, Any]) -> bool:
    """Hand a renderer window's ui.invoke.result to the waiting MCP call."""
    return _ui_invoke_pending.resolve(request_id, result)


def _pane_caller(pane_id: str) -> _Caller:
    """Address a UI request at the window hosting *pane_id* itself.

    For requests that are ABOUT one pane (ui.pane.getStatus) rather than about
    the caller: only the window that has that pane can answer them, and it is
    not necessarily the caller's own — a pane may ask about a pane in another
    window, and a host/external caller has no window at all. Handing
    :func:`_caller_window` the subject pane's identity resolves the right one;
    without it these fell back to broadcast, where a window that has since
    switched project answers nothing and each probe burns a full timeout.
    """
    return _Caller(kind="pane", pane_id=pane_id)


def _caller_window(caller: "_Caller | None", workspace_path: str) -> Any | None:
    """The WS connection of the window that mirrors the calling pane.

    A pane asking about its own workspace can only mean "in my own window", and
    that window is known: agent_messaging records which connection mirrors each
    pane. Addressing it directly is what lets a pane drive its own UI while its
    window sits in the background, or after that window switched to another
    project — neither of which the broadcast path survives, because there each
    window self-selects by comparing workspace_path against the workspace it
    *currently* has open, and a window that no longer matches simply says
    nothing (indistinguishable from a hang, at the cost of a full timeout).

    A workspace_path naming a *different* project is a deliberate call on
    someone else's window ("what does that window have registered?"), so it
    keeps the broadcast path rather than being quietly redirected home.

    Returns None for a host or external caller (no pane, so no window to
    address) and for a pane whose window is gone — both fall back to broadcast.
    """
    if caller is None or caller.kind != "pane":
        return None
    from agent_team_backend import agent_messaging

    # caller.pane_id is already the live id: _resolve_caller followed any alias
    # a re-attach left behind before handing it over.
    pane = agent_messaging.get(caller.pane_id)
    if pane is None:
        return None
    if workspace_path and _norm_workspace(workspace_path) != _norm_workspace(pane.workspace_path):
        return None
    session = agent_messaging.owner(caller.pane_id)
    return None if session is None or getattr(session, "dead", False) else session


def _ui_timeout_error(workspace_path: str, timeout: float, *, addressed: bool) -> dict[str, Any]:
    """Explain an unanswered ui.invoke.request as one of three failures.

    The fixes are opposite — inspect a stuck window vs. check the path — so a
    silent deadline must not blend them into one sentence.

    An *addressed* request went to one known window (the caller's own, see
    :func:`_caller_window`), so reaching the deadline can only mean that window
    is busy or wedged; workspace_path never entered into it.

    A broadcast one is ambiguous. Windows mirror their CLI panes into
    agent_messaging, so a workspace with a connected pane has a live window
    *somewhere* — but the pane registry records the workspace a pane was
    spawned under, which is not the workspace its window has open now, so this
    cannot promise the path is right either; it says what it can prove and
    names the check. The reverse is a weaker hint still — a window with no CLI
    pane open answers ui.invoke while leaving no trace in the registry — so
    that branch names the failure it can prove (no window *known*) and hands
    over the workspaces the backend can see. All three read state the backend
    already holds; none adds a round trip.
    """
    from agent_team_backend import agent_messaging

    if addressed:
        return {
            "ok": False,
            "result": None,
            "error": (
                f"your own Navide window was asked directly and did not answer within "
                f"{timeout:.0f}s — the action may still be running there, or that window "
                "is blocked (a native dialog freezes it). Retry, or check the window; "
                "workspace_path is not involved in this failure"
            ),
            "error_code": "ui_action_timeout",
        }
    connected = [e for e in agent_messaging.list_panes(workspace_path) if not e.offline]
    if connected:
        return {
            "ok": False,
            "result": None,
            "error": (
                f"no window answered for workspace_path {workspace_path!r} within "
                f"{timeout:.0f}s. A pane is registered under that path, so a window "
                "exists — but a broadcast request is answered only by the window whose "
                "*currently open* workspace matches, and a window that has since "
                "switched project no longer matches. Check what that window has open, "
                "or call from a CLI pane inside it (a pane's own window is addressed "
                "directly and needs no path match)"
            ),
            "error_code": "ui_action_timeout",
        }
    known = sorted({e.workspace_path for e in agent_messaging.list_panes() if not e.offline})
    return {
        "ok": False,
        "result": None,
        "error": (
            f"no reply for workspace_path {workspace_path!r} within {timeout:.0f}s, and "
            f"the backend sees no connected window for it. Workspaces it can see a "
            f"window for: {known}. Check workspace_path against that list first — but a "
            "window with no CLI pane open leaves no trace there, so if the path is "
            "right, treat this as a timeout and retry"
        ),
        "error_code": "ui_no_window_known",
    }


async def _ui_request(
    workspace_path: str,
    op: str,
    *,
    caller: "_Caller | None" = None,
    action: str | None = None,
    args: dict[str, Any] | None = None,
    is_global: bool = False,
) -> dict[str, Any]:
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    request_id = secrets.token_hex(16)
    # Three ways out, narrowest first: a global action has no fixed owner and
    # goes to any one window; a pane caller's own window is known and is asked
    # directly ("addressed", so it answers without checking workspace_path);
    # anything else is broadcast for the windows to filter, as before.
    owner = None if is_global else _caller_window(caller, workspace_path)
    fut = _ui_invoke_pending.register(request_id)
    payload: dict[str, Any] = {
        "request_id": request_id,
        "workspace_path": workspace_path,
        "op": op,
        "action": action,
        "args": args,
        "global": is_global,
        "addressed": owner is not None,
    }
    # The event is built inside each branch, after `addressed` has settled:
    # make_event stores the payload by reference today, so mutating it after
    # the fact happened to reach the wire — but a make_event that copied or
    # serialized would have shipped addressed:true on the broadcast fallback,
    # and every window answers an addressed request without checking
    # workspace_path, racing N replies for one request id.
    if is_global:
        sent = await app.unicast_any(make_event("ui.invoke.request", payload))
        if not sent:
            _ui_invoke_pending.discard(request_id)
            return {
                "ok": False,
                "result": None,
                "error": "no Navide window is open to handle this request",
                "error_code": "ui_no_window",
            }
    elif owner is not None and await app.unicast_to(owner, make_event("ui.invoke.request", payload)):
        pass
    else:
        # The owner dropped between lookup and send: broadcast rather than fail,
        # and stop claiming the request was addressed — the timeout message
        # tells the two apart.
        payload["addressed"] = False
        await app.broadcast(make_event("ui.invoke.request", payload))

    timeout = _UI_INVOKE_SLOW_TIMEOUT_S if action in _UI_INVOKE_SLOW_ACTIONS else _UI_INVOKE_TIMEOUT_S
    result = await _ui_invoke_pending.wait(request_id, fut, timeout=timeout)
    if result is TIMEOUT:
        return _ui_timeout_error(workspace_path, timeout, addressed=bool(payload["addressed"]))
    return result


@server.tool()
async def ui_list_actions(workspace_path: str, ctx: Context) -> dict[str, Any]:
    """List the UI actions registered by the Navide window for workspace_path.

    Returns the list of registered action ids (plain strings), so a caller
    can discover what ui_invoke accepts before calling it. Errors if no
    window owns workspace_path within 15s.

    Called from a CLI pane, this goes to that pane's own window when
    workspace_path names that pane's own workspace (or is empty) — see
    ui_invoke.
    """
    caller = _resolve_caller(ctx)
    return await _ui_request(workspace_path, "list_actions", caller=caller)


@server.tool()
async def ui_invoke(
    workspace_path: str, action: str, ctx: Context, args: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Invoke a registered UI action in the Navide window for workspace_path.

    `action` must be one returned by ui_list_actions; `args` is passed through
    to it verbatim. `action` "ui.workspace.open" is routed differently: it has
    no fixed owner (the workspace may not have a window yet), so it is sent to
    any one live Navide window instead of broadcast to all. Errors if no
    window owns workspace_path (or, for ui.workspace.open, no window is open
    at all) within 15s.

    Called from a CLI pane, the request is delivered straight to the window
    that hosts that pane — whether or not it is focused, and whatever project
    that window currently has open — as long as workspace_path names that
    pane's own workspace (or is empty). Naming a DIFFERENT project is a
    deliberate call on someone else's window and keeps the broadcast path,
    where only a window with that project open answers; a caller with no pane
    identity (host / external) always depends on that match.

    Being delivered is not the same as being run against workspace_path. The
    actions that act on "the project this window is showing" — ui.pane.create,
    ui.preview.show, ui.window.openGit — are refused with an error when the
    hosting window has switched to another project, rather than silently
    running against the wrong one. Switch that window back, or spawn the pane
    from a window that has the project open.
    """
    caller = _resolve_caller(ctx)
    return await _ui_request(
        workspace_path,
        "invoke",
        caller=caller,
        action=action,
        args=args,
        is_global=action == "ui.workspace.open",
    )


@server.tool()
async def ui_snapshot(workspace_path: str, ctx: Context) -> dict[str, Any]:
    """Return a structured snapshot of UI state for the Navide window at workspace_path.

    Shape is decided by the renderer (panes, tabs, focus, etc.). Errors if no
    window owns workspace_path within 15s.

    Called from a CLI pane, this snapshots that pane's own window when
    workspace_path names that pane's own workspace (or is empty) — see
    ui_invoke. The snapshot then describes the project that window has open
    right now, which is not necessarily workspace_path.
    """
    caller = _resolve_caller(ctx)
    return await _ui_request(workspace_path, "snapshot", caller=caller)


@server.tool()
async def ui_diagnostics(
    workspace_path: str, ctx: Context, since_seq: int = 0, pane_id: str = "", limit: int = 50
) -> dict[str, Any]:
    """Read renderer-side diagnostics recorded by the Navide window at workspace_path.

    These are warnings the renderer logged about its own UI actions — e.g.
    injectText resending content because its echo check timed out, or giving
    up entirely — that a `ui_invoke` caller cannot see from `ok: true` alone
    (they only ever appeared in that window's devtools console before this).
    Use this to diagnose cases where a tool reported success but the actual
    in-window behavior looked wrong (duplicated input, a stuck send, etc.).

    `since_seq` returns only entries recorded after that sequence number —
    pass the `nextSeq` from a previous call to poll incrementally without
    re-reading old entries. `pane_id` filters to one pane; `limit` caps how
    many entries come back. Errors if no window owns workspace_path within 15s.

    Called from a CLI pane, this reads that pane's own window when
    workspace_path names that pane's own workspace (or is empty) — see
    ui_invoke.
    """
    caller = _resolve_caller(ctx)
    return await _ui_request(
        workspace_path,
        "invoke",
        caller=caller,
        action="ui.diagnostics.read",
        args={"sinceSeq": since_seq, "paneId": pane_id, "limit": limit},
    )


# ── Preview record (preview_record / preview_list / preview_show) ───────────
# One feed per workspace of what was changed or shown there, persisted by
# preview_log in the workspace database. These tools are the agent's end of it:
# a session reports its own writes, reads back what other writers reported, and
# pushes something in front of the user. The vocabulary mirrors preview_log's,
# minus what an agent must not claim by hand — "shown" is written by
# preview_show itself, only after the window confirms it took the push.

_RECORDABLE_CHANGES = ("created", "modified", "deleted")
_LISTABLE_CHANGES = (*_RECORDABLE_CHANGES, "shown")
_PREVIEW_KINDS = ("file", "diff", "snippet", "html", "markdown")
_INLINE_KINDS = ("snippet", "html", "markdown")


def _preview_log() -> Any:
    """The app-level PreviewLog, resolved at call time (app.py imports this
    module, so the singleton cannot be reached at import time)."""
    from agent_team_backend import app as _app

    return _app.preview_log


def _preview_pane(caller: _Caller) -> Any:
    """The calling pane's registry entry, or None for a non-pane caller.

    Attribution is taken from the credential, never from an argument: a caller
    cannot claim to be a pane it is not, and host/external callers simply
    record without attribution.
    """
    if caller.kind != "pane":
        return None
    from agent_team_backend import agent_messaging

    return agent_messaging.get(caller.pane_id)


async def _broadcast_preview_row(workspace_path: str, row: dict[str, Any] | None) -> None:
    """Put a freshly recorded row on every window showing that workspace.

    A None row is the store saying nothing new is on the feed (rejected, or
    folded into a record already there), so there is nothing to announce.
    """
    if row is None:
        return
    from agent_team_backend import app as _app
    from agent_team_backend.ipc import make_event

    await _app.broadcast(
        make_event("preview.recorded", {"workspace_path": workspace_path, "entry": row})
    )


def _preview_content(kind: str, rel_path: str, content: str) -> str:
    """Validate the kind/rel_path/content combination; returns the payload.

    File-backed kinds are addressed by path and carry no payload; inline kinds
    are the payload and have no path. Getting this wrong is the one failure the
    renderer reports as a flat "invalid preview target", so it is caught here.
    """
    if kind not in _PREVIEW_KINDS:
        raise FsError(f"invalid kind: {kind!r} (valid: {', '.join(_PREVIEW_KINDS)})")
    if kind not in _INLINE_KINDS:
        if not rel_path:
            raise FsError(f"kind {kind!r} previews a file — pass rel_path")
        return ""
    if not content:
        raise FsError(f"kind {kind!r} previews inline content — pass content")
    if len(content) > MAX_INLINE_CHARS:
        raise FsError(
            f"content is {len(content)} characters, over the {MAX_INLINE_CHARS} "
            "limit — write it to a file and preview that instead"
        )
    return content


@server.tool()
async def preview_record(
    ctx: Context,
    rel_path: str = "",
    change: str = "modified",
    note: str = "",
    kind: str = "file",
    content: str = "",
    title: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Report a file you just created, modified or deleted in this workspace.

    Call it once per write, right after the write lands: the user then sees
    what you touched in Navide's Preview panel, and other sessions read it back
    with preview_list. The record is persisted in the workspace and survives
    restarts. Attribution (which pane, which agent) comes from your own
    credential — there is nothing to pass for it.

    change is one of created, modified, deleted; a preview push is recorded by
    preview_show instead, so "shown" is not accepted here. kind defaults to
    "file": pass rel_path (workspace-relative) for kind "file" or "diff", or
    content for an inline "snippet" / "html" / "markdown" record. note is a
    short reason ("added the retry guard"); title labels an inline record.

    Returns {uid, created_at, rel_path, change, merged}. merged is true when
    the event folded into a record already on the feed — same path, same
    change, a couple of seconds apart, e.g. the file watcher got there first —
    in which case nothing new was added and uid is "" with created_at 0. A
    "warning" field means no live Navide pane uses workspace_path, so the user
    cannot see this record where it landed.

    workspace_path defaults to your own pane's workspace; pass it only to
    record against another project.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    change = str(change or "").strip()
    if change not in _RECORDABLE_CHANGES:
        raise FsError(
            f"invalid change: {change!r} (valid: {', '.join(_RECORDABLE_CHANGES)})"
        )
    kind = str(kind or "").strip()
    rel_path = str(rel_path or "").strip()
    payload = _preview_content(kind, rel_path, content)
    pane = _preview_pane(caller)
    row = await asyncio.to_thread(
        _preview_log().append,
        workspace_path,
        change=change,
        kind=kind,
        rel_path=rel_path or None,
        title=title or None,
        source="agent",
        pane_id=pane.pane_id if pane else None,
        agent=(pane.agent_key or None) if pane else None,
        note=note or None,
        payload=payload or None,
    )
    await _broadcast_preview_row(workspace_path, row)
    result: dict[str, Any] = {
        "uid": row["uid"] if row else "",
        "created_at": row["created_at"] if row else 0,
        "rel_path": rel_path,
        "change": change,
        "merged": row is None,
    }
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


@server.tool()
async def preview_list(
    ctx: Context,
    limit: int = 50,
    since: int = 0,
    change: str = "",
    agent: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Read back what has been created, modified, deleted or shown here.

    Use it to catch up on a workspace before editing in it: the feed carries
    what other sessions, the user, and the file watcher did, newest first, and
    survives restarts.

    limit caps how many come back (300 at most). since takes a created_at from
    an earlier call and returns only what happened after it, so you can poll
    without re-reading. change filters to one of created / modified / deleted /
    shown; agent filters to one vendor key (e.g. "claude").

    Returns {workspace_path, entries, truncated}; truncated is true when the
    limit cut the answer off, so raise it or page with since. Each entry has
    uid, created_at (epoch milliseconds), change, rel_path, kind, title, source
    (user / agent / watcher), pane_id, agent, tool, note, payload.

    workspace_path defaults to your own pane's workspace; pass it only to read
    another project's feed.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    change = str(change or "").strip()
    if change and change not in _LISTABLE_CHANGES:
        raise FsError(
            f"invalid change: {change!r} (valid: {', '.join(_LISTABLE_CHANGES)})"
        )
    limit = max(1, min(int(limit), MAX_ROWS))
    entries = await asyncio.to_thread(
        _preview_log().tail,
        workspace_path,
        limit,
        since=int(since) or None,
        change=change or None,
        agent=str(agent or "").strip() or None,
    )
    result: dict[str, Any] = {
        "workspace_path": workspace_path,
        "entries": entries,
        "truncated": len(entries) >= limit,
    }
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


@server.tool()
async def preview_show(
    ctx: Context,
    rel_path: str = "",
    kind: str = "file",
    content: str = "",
    title: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """Show a file, a diff, or inline content in Navide's Preview panel.

    This is how you put something in front of the user without them going
    looking for it: the file you just rewrote, the diff you want reviewed, a
    rendered report. The push reaches the Navide window that owns the
    workspace, and only lands on the record feed once that window confirms it
    took it — so a push nobody saw is never recorded as shown.

    kind "file" or "diff" needs rel_path (workspace-relative); "snippet",
    "html" and "markdown" need content (512 KB at most) and take an optional
    title.

    Returns the window's own reply — {ok, result, error} — plus recorded
    (whether a "shown" record was landed), uid, and merged (true when the push
    folded into an identical one already on the feed). ok false means no window
    took it: nothing was recorded, and the error says whether workspace_path is
    wrong or the window did not answer in time.

    workspace_path defaults to your own pane's workspace, which is the window
    the user is looking at; pass it only to show something in another project's
    window.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    kind = str(kind or "").strip()
    rel_path = str(rel_path or "").strip()
    payload = _preview_content(kind, rel_path, content)
    pane = _preview_pane(caller)
    args: dict[str, Any] = {"kind": kind, "source": "agent"}
    if pane is not None:
        args["origin"] = pane.name
    if kind in _INLINE_KINDS:
        args["content"] = payload
        if title:
            args["title"] = title
    else:
        args["workspacePath"] = workspace_path
        args["relPath"] = rel_path
    reply = await _ui_request(
        workspace_path, "invoke", caller=caller, action="ui.preview.show", args=args
    )
    result: dict[str, Any] = dict(reply)
    if result.get("ok") is not True:
        # The window never took it, so recording it as shown would log
        # something the user did not see.
        result["recorded"] = False
        return result
    row = await asyncio.to_thread(
        _preview_log().append,
        workspace_path,
        change="shown",
        kind=kind,
        rel_path=rel_path or None,
        title=title or None,
        source="agent",
        pane_id=pane.pane_id if pane else None,
        agent=(pane.agent_key or None) if pane else None,
        payload=payload or None,
    )
    await _broadcast_preview_row(workspace_path, row)
    result["recorded"] = True
    result["uid"] = row["uid"] if row else ""
    result["merged"] = row is None
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


# ── ASGI mount + lifecycle ──────────────────────────────────────────────────

_session_manager: StreamableHTTPSessionManager | None = None
_lifecycle = AsyncExitStack()


class _PlanMcpASGI:
    """ASGI endpoint (class instance so Starlette's Route treats it as raw
    ASGI, not a request-response function); 503 until startup() has run."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        manager = _session_manager
        if manager is None:
            response = PlainTextResponse("plan MCP server not started", status_code=503)
            await response(scope, receive, send)
            return
        await manager.handle_request(scope, receive, send)


asgi_app = _PlanMcpASGI()


async def startup() -> None:
    """Start a fresh streamable-HTTP session manager for the mounted endpoint.

    Stateless + JSON responses: every tool call is an independent POST, no
    server-side session table. A fresh manager per startup keeps app lifespan
    cycles (tests) restartable — the SDK's run() is once-only per instance.
    """
    global _session_manager
    manager = StreamableHTTPSessionManager(
        # Same low-level-server access the SDK's own in-memory test helper
        # (mcp.shared.memory) uses; FastMCP has no public accessor.
        app=server._mcp_server,  # noqa: SLF001
        json_response=True,
        stateless=True,
    )
    await _lifecycle.enter_async_context(manager.run())
    _session_manager = manager


async def shutdown() -> None:
    """Stop the session manager started by startup(). Idempotent."""
    global _session_manager
    _session_manager = None
    await _lifecycle.aclose()
