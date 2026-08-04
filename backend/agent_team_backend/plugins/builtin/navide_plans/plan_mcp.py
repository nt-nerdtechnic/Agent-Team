"""Plan MCP server — plan-document tools over streamable HTTP.

Mounted on the backend's FastAPI app in the same process (later phases must
reach in-process singletons like TerminalService, so no stdio subprocess).
The backend has no single "current workspace" — every ws_handler receives
``workspace_path`` per request from the client — so the MCP tools follow the
same convention and take ``workspace_path`` as a call-time argument.

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
import re
import secrets
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from html import escape as html_escape
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.responses import PlainTextResponse
from starlette.types import Receive, Scope, Send

from agent_team_backend.fs_service import FsError, _resolve_safe, write_file
from agent_team_backend.plan_meta import (
    PLAN_STAGES,
    TODO_STATUSES,
    parse_plan_meta,
    write_plan_meta,
)
from agent_team_backend.plan_provisioning import TEMPLATE_FILENAME, ensure_plan_assets

PLANS_REL_DIR = ".agent-team/plans"

server = FastMCP(
    name="navide-plans",
    instructions=(
        "Navide plan documents: HTML files under "
        f"{PLANS_REL_DIR}/ in a workspace, which the user reads and approves "
        "in Navide's Plan view.\n"
        "\n"
        "workspace_path: every tool takes it as its first argument — pass the "
        "absolute path of the project root you are working in (the workspace "
        "the user opened, normally your current working directory or its "
        "repository root). There is no implicit current workspace, and "
        "pointing it at a different project reads that project's plans. If a "
        "tool warns that no pane uses your workspace_path, Navide is not "
        "watching that project and will not show the plan — check "
        "cli_list_targets for the workspaces panes actually use.\n"
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
        "another pane or project; delivery waits for that pane to be idle, so "
        "it is not an instant reply channel.\n"
        "\n"
        "Delegating to a new agent: cli_open_agent opens a fresh CLI pane and "
        "hands it a task. Use it when work is better done in parallel or by a "
        "different CLI than yours; the new pane reports back to you by message "
        "when it finishes, so you do not poll it. Limits apply (3 child panes "
        "per pane, 8 CLI panes per workspace, chain depth 2) and the call tells "
        "you if one was hit."
    ),
)


# ── sync filesystem layer (runs in a worker thread) ─────────────────────────


def _plans_root(workspace_path: str) -> Path:
    """Resolve the plans dir under the workspace (raises FsError on escape)."""
    return _resolve_safe(workspace_path, PLANS_REL_DIR)


def _plan_rel_path(filename: str) -> str:
    """Workspace-relative path of a plan file — the form every tool returns.

    Agents echo returned paths into the terminal, where Navide's cmd+click
    router only recognizes the full ``.agent-team/plans/…`` form.
    """
    return f"{PLANS_REL_DIR}/{filename}"


def _plan_filename(rel_path: str) -> str:
    """Bare filename from either accepted input form (full path or filename)."""
    cleaned = str(rel_path or "").strip().lstrip("/")
    prefix = f"{PLANS_REL_DIR}/"
    return cleaned[len(prefix) :] if cleaned.startswith(prefix) else cleaned


def _todo_summary(meta: dict[str, Any]) -> dict[str, Any]:
    """Summarize the meta's todos as {total, by_status} counts."""
    counts: dict[str, int] = {}
    total = 0
    todos = meta.get("todos")
    if isinstance(todos, list):
        for todo in todos:
            if not isinstance(todo, dict):
                continue
            total += 1
            status = todo.get("status")
            key = status if isinstance(status, str) and status else "unknown"
            counts[key] = counts.get(key, 0) + 1
    return {"total": total, "by_status": counts}


def _list_plans_sync(workspace_path: str) -> list[dict[str, Any]]:
    root = _plans_root(workspace_path)
    if not root.is_dir():
        return []
    entries: list[dict[str, Any]] = []
    for path in sorted(root.glob("*.html")):
        # `_`-prefixed files are provisioned assets (_template.html), not plans.
        if path.name.startswith("_") or not path.is_file():
            continue
        try:
            html = path.read_text(encoding="utf-8", errors="replace")
            mtime = path.stat().st_mtime
        except OSError:
            continue
        meta = parse_plan_meta(html)
        if meta is None:
            # Consistent policy: files without a valid plan-meta island are
            # not plan documents — skip them entirely.
            continue
        entries.append(
            {
                "rel_path": _plan_rel_path(path.name),
                "name": meta.get("name"),
                "stage": meta.get("stage"),
                "overview": meta.get("overview"),
                "todos": _todo_summary(meta),
                "mtime": mtime,
            }
        )
    return entries


def _plan_target(workspace_path: str, rel_path: str) -> Path:
    """Resolve ``rel_path`` inside the plans dir; FsError when it escapes."""
    root = _plans_root(workspace_path)
    target = _resolve_safe(workspace_path, _plan_rel_path(_plan_filename(rel_path)))
    if target == root or not target.is_relative_to(root):
        raise FsError("path escapes the plans directory")
    return target


def _read_plan_sync(workspace_path: str, rel_path: str) -> dict[str, Any]:
    target = _plan_target(workspace_path, rel_path)
    if not target.is_file():
        raise FsError(f"plan not found: {rel_path}")
    html = target.read_text(encoding="utf-8", errors="replace")
    return {
        "rel_path": _plan_rel_path(_plan_filename(rel_path)),
        "meta": parse_plan_meta(html),
        "html": html,
    }


def _require_plan_sync(workspace_path: str, rel_path: str) -> None:
    """Assert the plan exists inside the plans subtree (same guard as reads)."""
    target = _plan_target(workspace_path, rel_path)
    if not target.is_file():
        raise FsError(f"plan not found: {rel_path}")


# ── write layer ─────────────────────────────────────────────────────────────

_TEMPLATE_TODO_LI_RE = re.compile(
    r"<li data-status=\"pending\" data-todo-id=\"phase-a\">[\s\S]*?</li>"
)
_PLACEHOLDER_RE = re.compile(r"\{\{[^{}]*\}\}")
_TODO_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]*")
_NOTE_ID_RE = re.compile(r"n(\d+)")


def _load_plan_for_write(workspace_path: str, rel_path: str) -> tuple[str, dict[str, Any], float]:
    """Read a plan for a mutate-and-save cycle: (html, meta, mtime).

    mtime is taken BEFORE the read so a write racing in between fails the
    ``expected_mtime`` check in :func:`_save_plan` instead of going unnoticed.
    """
    target = _plan_target(workspace_path, rel_path)
    if not target.is_file():
        raise FsError(f"plan not found: {rel_path}")
    mtime = target.stat().st_mtime
    html = target.read_text(encoding="utf-8")
    meta = parse_plan_meta(html)
    if meta is None:
        raise FsError(f"not a plan document (missing/invalid plan-meta): {rel_path}")
    return html, meta, mtime


def _save_plan(
    workspace_path: str, rel_path: str, content: str, expected_mtime: float | None = None
) -> None:
    """Persist plan HTML via fs_service.write_file (atomic tmp+replace).

    ``expected_mtime`` is fs_service's optimistic lock: the write is refused
    when the file changed on disk since :func:`_load_plan_for_write` read it.
    """
    result = write_file(
        workspace_path,
        _plan_rel_path(_plan_filename(rel_path)),
        content,
        expected_mtime=expected_mtime,
    )
    if not result.get("ok"):
        if result.get("conflict"):
            raise FsError(
                f"conflict: {rel_path} changed on disk during the update; re-read and retry"
            )
        raise FsError(str(result.get("error") or "write failed"))


def _normalize_todos(todos: list[str | dict[str, str]]) -> list[dict[str, str]]:
    """Validate the plan_create todos param into [{id, content, status}]."""
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(todos):
        if isinstance(item, str):
            todo_id, content = "", item
        elif isinstance(item, dict):
            todo_id = str(item.get("id") or "")
            content = str(item.get("content") or "")
        else:
            raise FsError("each todo must be a string or a {id?, content} object")
        content = content.strip()
        if not content:
            raise FsError(f"todo #{index + 1} has empty content")
        todo_id = todo_id.strip() or f"t{index + 1}"
        if _TODO_ID_RE.fullmatch(todo_id) is None:
            raise FsError(f"invalid todo id {todo_id!r} (use kebab-case: [a-z0-9-])")
        if todo_id in seen:
            raise FsError(f"duplicate todo id: {todo_id}")
        seen.add(todo_id)
        normalized.append({"id": todo_id, "content": content, "status": "pending"})
    return normalized


def _todos_markup(todos: list[dict[str, str]]) -> str:
    """Render todo <li> rows in the template's shape (ids pre-validated)."""
    return "\n        ".join(
        f'<li data-status="pending" data-todo-id="{todo["id"]}">\n'
        f'          <span class="st">pending</span>\n'
        f"          <span>{html_escape(todo['content'])}</span>\n"
        f"        </li>"
        for todo in todos
    )


def _create_plan_sync(
    workspace_path: str, name: str, overview: str, todos: list[str | dict[str, str]]
) -> dict[str, Any]:
    name = name.strip()
    if not name:
        raise FsError("plan name must be non-empty")
    overview = overview.strip()
    normalized = _normalize_todos(todos)
    root = _plans_root(workspace_path)
    template = root / TEMPLATE_FILENAME
    if not template.is_file():
        # Same idempotent helper the workspace-open funnel uses; it fills in
        # missing bundled assets without touching existing files.
        ensure_plan_assets(workspace_path)
    if not template.is_file():
        raise FsError(
            f"plan template missing: {PLANS_REL_DIR}/{TEMPLATE_FILENAME} (provisioning failed)"
        )
    content = template.read_text(encoding="utf-8")

    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60].rstrip("-") or "plan"
    for _ in range(16):
        filename = f"{slug}_{secrets.token_hex(3)}.html"
        if not (root / filename).exists():
            break
    else:
        raise FsError("could not allocate a unique plan filename")

    content = content.replace("{{PLAN_NAME}}", html_escape(name))
    content = content.replace("{{ONE_SENTENCE_OVERVIEW}}", html_escape(overview))
    content = content.replace("{{PHASE_A_TITLE}}", "Todos")
    content = _TEMPLATE_TODO_LI_RE.sub(lambda _m: _todos_markup(normalized), content, count=1)
    # Sweep every remaining {{…}} placeholder (Goals/Risks/etc. prose the
    # caller does not supply) so no template scaffolding leaks into the plan.
    content = _PLACEHOLDER_RE.sub("TBD", content)
    meta = {
        "schemaVersion": 1,
        "name": name,
        "overview": overview,
        "stage": "draft",
        "approvedAt": None,
        "todos": normalized,
        "reviewNotes": [],
    }
    content = write_plan_meta(content, meta)
    _save_plan(workspace_path, filename, content)
    return {"rel_path": _plan_rel_path(filename), "name": name, "stage": "draft"}


def _update_stage_sync(workspace_path: str, rel_path: str, stage: str) -> dict[str, Any]:
    if stage not in PLAN_STAGES:
        raise FsError(f"invalid stage: {stage!r} (valid: {', '.join(sorted(PLAN_STAGES))})")
    html, meta, mtime = _load_plan_for_write(workspace_path, rel_path)
    meta["stage"] = stage
    if stage == "approved":
        meta["approvedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _save_plan(workspace_path, rel_path, write_plan_meta(html, meta), expected_mtime=mtime)
    return {"stage": stage, "approvedAt": meta.get("approvedAt")}


def _update_todo_sync(
    workspace_path: str, rel_path: str, todo_id: str, status: str
) -> dict[str, Any]:
    if status not in TODO_STATUSES:
        raise FsError(f"invalid status: {status!r} (valid: {', '.join(sorted(TODO_STATUSES))})")
    html, meta, mtime = _load_plan_for_write(workspace_path, rel_path)
    todos = meta.get("todos")
    todos = todos if isinstance(todos, list) else []
    target = next(
        (t for t in todos if isinstance(t, dict) and t.get("id") == todo_id), None
    )
    if target is None:
        valid = [t["id"] for t in todos if isinstance(t, dict) and isinstance(t.get("id"), str)]
        raise FsError(f"unknown todo id: {todo_id!r} (valid ids: {', '.join(valid) or 'none'})")
    target["status"] = status
    _save_plan(workspace_path, rel_path, write_plan_meta(html, meta), expected_mtime=mtime)
    return dict(target)


def _add_note_sync(
    workspace_path: str, rel_path: str, text: str, author: str
) -> dict[str, Any]:
    if author not in ("user", "ai"):
        raise FsError(f"invalid author: {author!r} (valid: user, ai)")
    text = text.strip()
    if not text:
        raise FsError("note text must be non-empty")
    html, meta, mtime = _load_plan_for_write(workspace_path, rel_path)
    notes = meta.get("reviewNotes")
    if not isinstance(notes, list):
        notes = []
        meta["reviewNotes"] = notes
    max_num = 0
    for existing in notes:
        if isinstance(existing, dict):
            match = _NOTE_ID_RE.fullmatch(str(existing.get("id") or ""))
            if match:
                max_num = max(max_num, int(match.group(1)))
    note = {"id": f"n{max_num + 1}", "author": author, "text": text, "resolved": False, "reply": ""}
    notes.append(note)
    _save_plan(workspace_path, rel_path, write_plan_meta(html, meta), expected_mtime=mtime)
    return dict(note)


# ── workspace sanity check ──────────────────────────────────────────────────


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


# ── MCP tools ───────────────────────────────────────────────────────────────


@server.tool()
async def plan_list(workspace_path: str) -> list[dict[str, Any]]:
    """List plan documents in the workspace's .agent-team/plans/ directory.

    Skips provisioned assets (basename starting with "_") and files without a
    valid plan-meta island. Each entry has: rel_path (workspace-relative, e.g.
    ".agent-team/plans/foo.html" — pass it to plan_read), name, stage,
    overview, todos ({total, by_status} counts), mtime (epoch seconds).
    """
    return await asyncio.to_thread(_list_plans_sync, workspace_path)


@server.tool()
async def plan_read(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Read one plan document from the workspace's .agent-team/plans/ directory.

    rel_path is the workspace-relative path returned by plan_list (a bare
    filename is also accepted). Returns {rel_path, meta, html}: the parsed
    plan-meta dict (null if the island is missing/invalid) and the raw file
    content.
    """
    return await asyncio.to_thread(_read_plan_sync, workspace_path, rel_path)


@server.tool()
async def plan_create(
    workspace_path: str,
    name: str,
    overview: str,
    todos: list[str | dict[str, str]],
) -> dict[str, Any]:
    """Create a new plan document in the workspace's .agent-team/plans/ directory.

    The file is copied from the provisioned _template.html (auto-provisioned
    if missing), named <kebab-slug>_<6-hex>.html per the plan spec, and starts
    at stage "draft". Each todos item is either a plain string (the todo
    content; id auto-assigned as t1, t2, ...) or a {"id": "<kebab-case>",
    "content": "..."} object; every todo starts as "pending". name/overview/
    todos are written to both the plan-meta island and the visible markup.
    Returns {rel_path, name, stage}, plus "warning" when workspace_path does
    not match any pane's workspace — the plan is on disk but Navide's plan
    view will not find it; re-create it under the warned-about workspace.
    """
    result = await asyncio.to_thread(_create_plan_sync, workspace_path, name, overview, todos)
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


@server.tool()
async def plan_update_stage(workspace_path: str, rel_path: str, stage: str) -> dict[str, Any]:
    """Set a plan's lifecycle stage (island + visible stage pill).

    stage must be one of: draft, in-review, approved, in-progress, done,
    abandoned. Setting "approved" also stamps approvedAt with the current UTC
    time (ISO-8601, Z suffix). Fails with a conflict error if the file changed
    on disk during the update. Returns {stage, approvedAt}.
    """
    return await asyncio.to_thread(_update_stage_sync, workspace_path, rel_path, stage)


@server.tool()
async def plan_update_todo(
    workspace_path: str, rel_path: str, todo_id: str, status: str
) -> dict[str, Any]:
    """Set one todo's status (island + the todo's visible row markup).

    status must be one of: pending, in-progress, done, skipped. An unknown
    todo_id fails with an error listing the plan's valid todo ids. Returns the
    updated todo object.
    """
    return await asyncio.to_thread(_update_todo_sync, workspace_path, rel_path, todo_id, status)


@server.tool()
async def plan_add_note(
    workspace_path: str, rel_path: str, text: str, author: str = "ai"
) -> dict[str, Any]:
    """Append a review note to a plan's plan-meta island.

    author is "ai" (default) or "user". The note gets the next sequential id
    (n1, n2, ...), resolved=false and an empty reply. Per the plan spec's
    update discipline, app-side note writes touch only the plan-meta island —
    visible note markup may lag and is re-synced by the authoring agent on its
    next edit. Returns the created note.
    """
    return await asyncio.to_thread(_add_note_sync, workspace_path, rel_path, text, author)


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
    """The request carries no usable pane identity."""


_UNWIRED = (
    "this MCP endpoint could not identify your pane — reopen the pane so Navide "
    "can wire it, or use the ---MSG-START--- output protocol"
)
_STALE = (
    "this pane's id is stale (it was re-attached to a new pane since the CLI "
    "started, e.g. by a detach or a window reload) — reopen the pane to send "
    "messages through these tools, or use the ---MSG-START--- output protocol, "
    "which always resolves against the pane's current identity"
)


def _caller_pane_id(ctx: Context) -> str:
    """The pane whose CLI is calling, from the pane-specific endpoint URL.

    Every pane is spawned pointing at `/plan-mcp?pane=<id>&t=<token>`.

    The id is fixed at spawn time while a pane's id is not: re-attaching a live
    PTY (detach to a window, reload) mints a new pane id without re-running
    spawn wiring, leaving the CLI holding one that no longer refers to anything.
    Acting on a stale id would be worse than refusing — the sender resolves to
    nobody, which turns every same-workspace name into "unknown target", makes
    the pane fail its own self-send check (so it can message itself in a loop),
    and shows the recipient an unaddressable sender. So require the id to still
    be live and say plainly what to do about it.
    """
    from agent_team_backend import agent_messaging
    from agent_team_backend.plugins.builtin.navide_plans import plan_mcp_wiring

    request = getattr(ctx.request_context, "request", None)
    params = getattr(request, "query_params", None)
    if params is None:
        raise CallerUnknown(_UNWIRED)
    pane_id = str(params.get("pane") or "")
    token = str(params.get("t") or "")
    if not pane_id:
        raise CallerUnknown(_UNWIRED)
    if not secrets.compare_digest(token, plan_mcp_wiring.caller_token()):
        raise CallerUnknown("caller token rejected; reopen the pane to re-wire it")
    if agent_messaging.get(pane_id) is None:
        raise CallerUnknown(_STALE)
    return pane_id


@server.tool()
async def cli_list_targets(ctx: Context) -> dict[str, Any]:
    """List the CLI panes you can send instructions to with cli_send.

    Returns {you, targets}. Each target: {name, address, workspace_path,
    same_workspace}. Address a pane in YOUR workspace by its bare name; a pane
    in another workspace window by the `<folder>/<pane>` address given here.
    Read-only.
    """
    from agent_team_backend import agent_messaging

    try:
        me = _caller_pane_id(ctx)
    except CallerUnknown as err:
        return {"error": str(err), "targets": []}
    caller = agent_messaging.get(me)
    targets = [
        {
            "name": entry.name,
            "address": entry.qualified_name,
            "workspace_path": entry.workspace_path,
            "same_workspace": bool(caller and caller.workspace_path == entry.workspace_path),
            "busy": entry.busy,
        }
        for entry in agent_messaging.list_panes()
        if entry.pane_id != me
    ]
    return {
        "you": caller.qualified_name if caller else None,
        "targets": targets,
    }


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


@server.tool()
async def cli_open_agent(agent: str, name: str, task: str, ctx: Context) -> dict[str, Any]:
    """Open a new CLI pane in your workspace and give it a task.

    `agent` is the CLI to run (e.g. "claude", "codex"), `name` is what the pane
    will be called — that name is also its messaging address, so pick something
    role-shaped like "reviewer" — and `task` is what it should do.

    This returns once the pane exists, which takes a few seconds. Its CLI then
    boots and receives the task in the background — if that part fails you are
    told by message. The pane also reports its result to you by message when it
    finishes, so you never need to poll it.

    Use the returned name, not the one you asked for: a concurrent request may
    have taken that name, in which case yours gets a suffix.

    Refused when the name is taken, the agent key is unknown, or a limit is hit:
    3 child panes per pane, 8 CLI panes per workspace, spawn chain depth 2.
    Returns {ok, name, address} or {ok: false, error}.
    """
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.ipc import make_event

    try:
        me = _caller_pane_id(ctx)
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

    request_id = f"{me}:spawn:{secrets.token_hex(8)}"
    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    _pending_spawns[request_id] = future
    try:
        await app.broadcast(
            make_event(
                "agent_spawn.request",
                {
                    "request_id": request_id,
                    "requester_pane_id": me,
                    "agent_key": agent_key,
                    "name": pane_name,
                    "task": task,
                },
            )
        )
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
    entry = agent_messaging.get(str(verdict.get("pane_id") or ""))
    return {
        "ok": True,
        "name": str(verdict.get("name") or pane_name),
        "address": entry.qualified_name if entry else str(verdict.get("name") or pane_name),
    }


@server.tool()
async def cli_send(to: str, text: str, ctx: Context) -> dict[str, Any]:
    """Send an instruction to another CLI pane, in this or another workspace.

    `to` is a pane name for a pane in your own workspace, or `<folder>/<pane>`
    for one in another workspace window — cli_list_targets shows both forms. The
    text is delivered verbatim and submitted for the receiving agent to act on,
    once that pane is idle; it is queued if the pane is mid-turn. An unknown or
    ambiguous target is refused rather than guessed.

    Delivery is asynchronous: this returns once the message is accepted for
    delivery, not once the other agent has read it. Returns
    {ok, target, cross_workspace} or {ok: false, error}.
    """
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.ipc import make_event

    try:
        me = _caller_pane_id(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if not (text or "").strip():
        return {"ok": False, "error": "text is empty"}

    result = agent_messaging.resolve(me, to)
    if result.pane is None:
        return {"ok": False, "error": result.error or f'unknown target "{to}"'}
    if result.pane.pane_id == me:
        return {"ok": False, "error": "that is your own pane"}

    sender = agent_messaging.get(me)
    msg_key = f"{me}:mcp:{secrets.token_hex(8)}"
    await app.broadcast(
        make_event(
            "agent_msg.deliver",
            {
                "msg_key": msg_key,
                "target_pane_id": result.pane.pane_id,
                "target_workspace_path": result.pane.workspace_path,
                "target_name": result.pane.name,
                "from_pane_id": me,
                "from_display": agent_messaging.sender_display(me, "another pane"),
                "from_workspace_path": sender.workspace_path if sender else "",
                "cross_workspace": result.cross_workspace,
                "content": text,
                # The frontend applies the per-pair rate limit when it sends;
                # a message that entered here never passed through that, so the
                # receiving window has to apply it instead. Without this, two
                # agents replying to each other through cli_send have no loop
                # guard at all.
                "rate_limit": True,
            },
        )
    )
    return {
        "ok": True,
        "target": result.pane.qualified_name,
        "cross_workspace": result.cross_workspace,
    }


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
