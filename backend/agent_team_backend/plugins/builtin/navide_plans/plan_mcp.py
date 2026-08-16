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

from agent_team_backend.fs_service import FsError, _resolve_safe, write_file
from agent_team_backend.pending_registry import TIMEOUT, PendingRegistry
from agent_team_backend.plan_index import resolve_plan_root
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
        "different CLI than yours; the new pane reports back to you by message "
        "when it finishes, so you do not poll it. There is no hard cap on child "
        "panes, workspace CLI panes, or spawn-chain depth, but going well past "
        "sane advisory thresholds gets logged as a diagnostic warning (readable "
        "via ui_diagnostics) rather than refused.\n"
        "\n"
        "Checking on another pane: cli_read_log reads the tail of a pane's "
        "conversation log, cli_get_status reports whether it is busy and its "
        "last known activity, and cli_wait_idle blocks until it goes idle or a "
        "timeout passes — useful for an external caller, which gets no "
        "cli_open_agent completion message to poll instead."
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


# ── MCP tools ───────────────────────────────────────────────────────────────


@server.tool()
async def plan_list(ctx: Context, workspace_path: str = "") -> list[dict[str, Any]]:
    """List plan documents in the workspace's .agent-team/plans/ directory.

    Skips provisioned assets (basename starting with "_") and files without a
    valid plan-meta island. Each entry has: rel_path (workspace-relative, e.g.
    ".agent-team/plans/foo.html" — pass it to plan_read), name, stage,
    overview, todos ({total, by_status} counts), mtime (epoch seconds).

    workspace_path defaults to your own pane's workspace; pass it only to read
    another project's plans.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await asyncio.to_thread(_list_plans_sync, workspace_path)


@server.tool()
async def plan_read(rel_path: str, ctx: Context, workspace_path: str = "") -> dict[str, Any]:
    """Read one plan document from the workspace's .agent-team/plans/ directory.

    rel_path is the workspace-relative path returned by plan_list (a bare
    filename is also accepted). Returns {rel_path, meta, html}: the parsed
    plan-meta dict (null if the island is missing/invalid) and the raw file
    content.

    workspace_path defaults to your own pane's workspace; pass it only to read
    another project's plan.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await asyncio.to_thread(_read_plan_sync, workspace_path, rel_path)


@server.tool()
async def plan_create(
    name: str,
    overview: str,
    todos: list[str | dict[str, str]],
    ctx: Context,
    workspace_path: str = "",
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

    workspace_path defaults to your own pane's workspace, which is where the
    user can open the plan — pass it only to create a plan in another project.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    result = await asyncio.to_thread(_create_plan_sync, workspace_path, name, overview, todos)
    warning = await asyncio.to_thread(_workspace_mismatch_warning, workspace_path)
    if warning:
        result["warning"] = warning
    return result


@server.tool()
async def plan_update_stage(
    rel_path: str, stage: str, ctx: Context, workspace_path: str = ""
) -> dict[str, Any]:
    """Set a plan's lifecycle stage (island + visible stage pill).

    stage must be one of: draft, in-review, approved, in-progress, done,
    abandoned. Setting "approved" also stamps approvedAt with the current UTC
    time (ISO-8601, Z suffix). Fails with a conflict error if the file changed
    on disk during the update. Returns {stage, approvedAt}.

    workspace_path defaults to your own pane's workspace; pass it only to
    update another project's plan.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await asyncio.to_thread(_update_stage_sync, workspace_path, rel_path, stage)


@server.tool()
async def plan_update_todo(
    rel_path: str, todo_id: str, status: str, ctx: Context, workspace_path: str = ""
) -> dict[str, Any]:
    """Set one todo's status (island + the todo's visible row markup).

    status must be one of: pending, in-progress, done, skipped. An unknown
    todo_id fails with an error listing the plan's valid todo ids. Returns the
    updated todo object.

    workspace_path defaults to your own pane's workspace; pass it only to
    update another project's plan.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
    return await asyncio.to_thread(_update_todo_sync, workspace_path, rel_path, todo_id, status)


@server.tool()
async def plan_add_note(
    rel_path: str, text: str, ctx: Context, author: str = "ai", workspace_path: str = ""
) -> dict[str, Any]:
    """Append a review note to a plan's plan-meta island.

    author is "ai" (default) or "user". The note gets the next sequential id
    (n1, n2, ...), resolved=false and an empty reply. Per the plan spec's
    update discipline, app-side note writes touch only the plan-meta island —
    visible note markup may lag and is re-synced by the authoring agent on its
    next edit. Returns the created note.

    workspace_path defaults to your own pane's workspace; pass it only to
    annotate another project's plan.
    """
    caller = _resolve_caller(ctx)
    workspace_path = await _plan_workspace(caller, workspace_path)
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
    """The request carries no usable / accepted credential."""


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
    `?client=host&t=<internal token>` (see plan_mcp_wiring.plan_mcp_url); an
    external client carries `?client=external&t=<external token>`, accepted
    only while plan_mcp_auth.external_enabled() is True. Raises CallerUnknown
    with a caller-facing message when none of these validate.

    For the pane kind specifically: the id is fixed at spawn time while a
    pane's id is not — re-attaching a live PTY (detach to a window, reload)
    mints a new pane id without re-running spawn wiring, leaving the CLI
    holding one that no longer refers to anything. Acting on a stale id would
    be worse than refusing — the sender resolves to nobody, which turns every
    same-workspace name into "unknown target", makes the pane fail its own
    self-send check (so it can message itself in a loop), and shows the
    recipient an unaddressable sender. So require the id to still be live.
    """
    from agent_team_backend import agent_messaging
    from agent_team_backend.plugins.builtin.navide_plans import plan_mcp_auth, plan_mcp_wiring

    request = getattr(ctx.request_context, "request", None)
    params = getattr(request, "query_params", None)
    if params is None:
        raise CallerUnknown(_UNWIRED)
    token = str(params.get("t") or "")
    client = str(params.get("client") or "")
    if client == "host":
        if not secrets.compare_digest(token, plan_mcp_auth.internal_token()):
            raise CallerUnknown(_HOST_TOKEN_REJECTED)
        return _Caller(kind="host")
    if client == "external":
        if not plan_mcp_auth.external_enabled():
            raise CallerUnknown(_EXTERNAL_DISABLED)
        if not secrets.compare_digest(token, plan_mcp_auth.external_token()):
            raise CallerUnknown(_EXTERNAL_TOKEN_REJECTED)
        return _Caller(kind="external")
    pane_id = str(params.get("pane") or "")
    if not pane_id:
        raise CallerUnknown(_UNWIRED)
    if not secrets.compare_digest(token, plan_mcp_wiring.caller_token()):
        raise CallerUnknown("caller token rejected; reopen the pane to re-wire it")
    if agent_messaging.get(pane_id) is None:
        raise CallerUnknown(_STALE)
    return _Caller(kind="pane", pane_id=pane_id)


@server.tool()
async def cli_list_targets(ctx: Context) -> dict[str, Any]:
    """List the CLI panes you can send instructions to with cli_send.

    Returns {you, targets}. Each target: {name, address, workspace_path,
    same_workspace, busy, offline}. Address a pane in YOUR workspace by its bare
    name; a pane in another workspace window by the `<folder>/<pane>` address
    given here. A caller with no pane identity (host / external credential) has
    no "own workspace" — every target comes back with same_workspace false and
    "you" set to the credential kind ("host" or "external"); always use the
    qualified address. Read-only.

    `offline` marks a pane whose Navide window has lost its connection: it still
    exists and is expected back, but sending to it fails until it returns.
    """
    from agent_team_backend import agent_messaging

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"error": str(err), "targets": []}
    if caller.kind == "pane":
        me_entry = agent_messaging.get(caller.pane_id)
        targets = [
            {
                "name": entry.name,
                "address": entry.qualified_name,
                "workspace_path": entry.workspace_path,
                "same_workspace": bool(me_entry and me_entry.workspace_path == entry.workspace_path),
                "busy": entry.busy,
                "offline": entry.offline,
            }
            for entry in agent_messaging.list_panes()
            if entry.pane_id != caller.pane_id
        ]
        return {"you": me_entry.qualified_name if me_entry else None, "targets": targets}
    targets = [
        {
            "name": entry.name,
            "address": entry.qualified_name,
            "workspace_path": entry.workspace_path,
            "same_workspace": False,
            "busy": entry.busy,
            "offline": entry.offline,
        }
        for entry in agent_messaging.list_panes()
    ]
    return {"you": caller.kind, "targets": targets}


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
async def cli_open_agent(
    agent: str, name: str, task: str, ctx: Context, workspace_path: str = ""
) -> dict[str, Any]:
    """Open a new CLI pane and give it a task.

    `agent` is the CLI to run (e.g. "claude", "codex"), `name` is what the pane
    will be called — that name is also its messaging address, so pick something
    role-shaped like "reviewer" — and `task` is what it should do.

    Pane callers open the pane in their own workspace; `workspace_path` is
    ignored for them. A caller with no pane identity (host / external
    credential) has no workspace of its own, so `workspace_path` is required —
    the pane opens there with no parent, so it has no child/depth counts of
    its own; the workspace's CLI-pane count is still tracked for the advisory
    below.

    This returns once the pane exists, which takes a few seconds. Its CLI then
    boots and receives the task in the background — if that part fails you are
    told by message. For a pane caller, the new pane also reports its result to
    you by message when it finishes, so you never need to poll it — an external
    or host caller gets no such message and should poll cli_get_status /
    cli_wait_idle instead.

    Use the returned name, not the one you asked for: a concurrent request may
    have taken that name, in which case yours gets a suffix.

    Refused when the name is taken, the agent key is unknown, or the task is
    empty. A high child/workspace/depth count never refuses the spawn — it
    just gets logged as a diagnostic warning and, on success, also returned
    here as `advisories` (a list of human-readable notes; the key is absent
    when there is nothing to report).
    Returns {ok, name, address, advisories?} or {ok: false, error}.
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
    entry = agent_messaging.get(str(verdict.get("pane_id") or ""))
    result: dict[str, Any] = {
        "ok": True,
        "name": str(verdict.get("name") or pane_name),
        "address": entry.qualified_name if entry else str(verdict.get("name") or pane_name),
    }
    if verdict.get("advisories"):
        result["advisories"] = verdict["advisories"]
    return result


@server.tool()
async def cli_send(to: str, text: str, ctx: Context) -> dict[str, Any]:
    """Send an instruction to another CLI pane, in this or another workspace.

    `to` is a pane name for a pane in your own workspace, or `<folder>/<pane>`
    for one in another workspace window — cli_list_targets shows both forms. A
    caller with no pane identity (host / external credential) has no "own
    workspace" and must always use the qualified `<folder>/<pane>` form. The
    text is delivered verbatim and submitted for the receiving agent to act on,
    once that pane is idle; it is queued if the pane is mid-turn. An unknown or
    ambiguous target is refused rather than guessed.

    Delivery is asynchronous: this returns once the message is accepted for
    delivery, not once the other agent has read it. Returns
    {ok, target, cross_workspace, msg_key} or {ok: false, error, error_code}.
    Pass `msg_key` to cli_check_message to learn whether the receiving window
    actually delivered it.

    `error_code` "target-offline" is not "unknown-target": the pane exists but
    its Navide window is disconnected. Wait for it to come back and retry —
    re-sending elsewhere or reopening the pane would duplicate the work.
    """
    from agent_team_backend import agent_messaging, app
    from agent_team_backend.ipc import make_event

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if not (text or "").strip():
        return {"ok": False, "error": "text is empty"}
    me = caller.pane_id if caller.kind == "pane" else ""
    if caller.kind != "pane" and "/" not in (to or ""):
        return {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}

    result = agent_messaging.resolve(me, to)
    if result.pane is None:
        return {
            "ok": False,
            "error": result.error or f'unknown target "{to}"',
            "error_code": result.code or "unknown-target",
        }
    if me and result.pane.pane_id == me:
        return {"ok": False, "error": "that is your own pane"}

    sender = agent_messaging.get(me) if me else None
    msg_key = f"{me or caller.kind}:mcp:{secrets.token_hex(8)}"
    await app.broadcast(
        make_event(
            "agent_msg.deliver",
            {
                "msg_key": msg_key,
                "target_pane_id": result.pane.pane_id,
                "target_workspace_path": result.pane.workspace_path,
                "target_name": result.pane.name,
                "target_agent_key": result.pane.agent_key,
                "from_pane_id": me,
                "from_display": agent_messaging.sender_display(
                    me, "an external client" if caller.kind == "external" else "a host client"
                ),
                "from_workspace_path": sender.workspace_path if sender else "",
                "from_agent_key": sender.agent_key if sender else "",
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
    _record_message_sent(msg_key, result.pane.qualified_name)
    return {
        "ok": True,
        "target": result.pane.qualified_name,
        "cross_workspace": result.cross_workspace,
        "msg_key": msg_key,
    }


# ── Delivery outcome of a cli_send (cli_check_message) ─────────────────────
# msg_key is minted per cli_send call and exists nowhere else in the backend:
# the SQLite message log is keyed by a separate uid the renderer owns, and the
# sending window's own map of msg_key lives in renderer memory. So the outcome
# is tracked here, in memory, bounded by both a count and a TTL — a restart
# loses it, which is fine for a key nothing outlives the process anyway.
_MESSAGE_STATUS_MAX = 500
_MESSAGE_STATUS_TTL_S = 3600.0
_mcp_message_status: dict[str, dict[str, Any]] = {}


def _prune_message_status(now: float) -> None:
    for key, entry in list(_mcp_message_status.items()):
        if now - entry["created_at"] >= _MESSAGE_STATUS_TTL_S:
            del _mcp_message_status[key]
    # Insertion-ordered, so the front of the dict is the oldest send.
    while len(_mcp_message_status) >= _MESSAGE_STATUS_MAX:
        _mcp_message_status.pop(next(iter(_mcp_message_status)))


def _record_message_sent(msg_key: str, target: str) -> None:
    now = time.monotonic()
    _prune_message_status(now)
    _mcp_message_status[msg_key] = {
        "status": "queued",
        "target": target,
        "reason": None,
        "delivered_at": None,
        "created_at": now,
    }


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
    entry["status"] = "delivered" if ok else "failed"
    entry["reason"] = _decode_reason(reason) if reason else None
    entry["delivered_at"] = time.monotonic()
    return True


@server.tool()
async def cli_check_message(msg_key: str, ctx: Context) -> dict[str, Any]:
    """Look up what became of a message you sent with cli_send.

    `msg_key` is the value cli_send returned. Returns {ok, msg_key, status,
    target, age_seconds, reason?, settled_after_s?}. `status` is one of:

      - "queued"    — broadcast for delivery; no window has reported back yet.
                      A message held for a busy pane stays here until it is
                      actually injected.
      - "delivered" — the receiving window injected and submitted it.
      - "failed"    — the receiving window refused or lost it; see `reason`.

    `reason` values come from the receiving window: "rate-limit" (too many
    messages between the same pair too quickly), "queue-full" (the target's
    pending-message queue is at its cap), "inject-failed" (typing it into the
    pane did not take), "pane-closed" (the target went away before delivery),
    "no-report" (the delivery attempt never reported an outcome).

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
    status: dict[str, Any] = {
        "ok": True,
        "msg_key": key,
        "status": entry["status"],
        "target": entry["target"],
        "age_seconds": round(time.monotonic() - entry["created_at"], 1),
    }
    if entry["reason"]:
        status["reason"] = entry["reason"]
    if entry["delivered_at"] is not None:
        status["settled_after_s"] = round(entry["delivered_at"] - entry["created_at"], 1)
    return status


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


@server.tool()
async def cli_read_log(
    target: str, ctx: Context, tail_lines: int = 200, since: int | None = None
) -> dict[str, Any]:
    """Read a CLI pane's conversation log file.

    `target` uses the same addressing as cli_send (cli_list_targets shows the
    forms); a caller with no pane identity must use the qualified
    `<folder>/<pane>` form. Returns
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
    from agent_team_backend import agent_messaging, app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    if caller.kind != "pane" and "/" not in (target or ""):
        return {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}

    result = agent_messaging.resolve(me, target)
    if result.pane is None:
        return {
            "ok": False,
            "error": result.error or f'unknown target "{target}"',
            "error_code": result.code or "unknown-target",
        }

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
async def cli_get_status(target: str, ctx: Context) -> dict[str, Any]:
    """Report whether a CLI pane is busy and its most recent activity.

    `target` uses the same addressing as cli_send. Returns {ok, name,
    agent_key, busy, last_activity?, ui?}. `last_activity`, when known, is
    {type: "agent_active"|"turn_complete", text? (turn_complete only),
    age_seconds}. `ui`, when the owning Navide window answers in time, is
    {status, buffer, logPath?} straight from the renderer; it is omitted
    (not a failure) when the window does not reply.
    """
    from agent_team_backend import agent_messaging

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    if caller.kind != "pane" and "/" not in (target or ""):
        return {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}

    result = agent_messaging.resolve(me, target)
    if result.pane is None:
        return {
            "ok": False,
            "error": result.error or f'unknown target "{target}"',
            "error_code": result.code or "unknown-target",
        }
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
        pane.workspace_path, "invoke", action="ui.pane.getStatus", args={"paneId": pane.pane_id}
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
#
# "question" is included, and for the opposite reason: it renames panes the
# renderer already reported as "idle" here (a turn that ended on a question),
# so leaving it out would make cli_wait_idle newly block until timeout on
# exchanges it has always returned from. It mirrors the messaging gate in
# App.vue, which passes "question" for the same reason.
_UI_IDLE_STATUSES = frozenset({"idle", "exited", "stopped", "error", "question"})


@server.tool()
async def cli_wait_idle(target: str, ctx: Context, timeout_s: float = 60.0) -> dict[str, Any]:
    """Block until a CLI pane goes idle, or a timeout passes.

    `target` uses the same addressing as cli_send. `timeout_s` is capped at
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
    if caller.kind != "pane" and "/" not in (target or ""):
        return {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}

    result = agent_messaging.resolve(me, target)
    if result.pane is None:
        return {
            "ok": False,
            "error": result.error or f'unknown target "{target}"',
            "error_code": result.code or "unknown-target",
        }
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
                workspace_path, "invoke", action="ui.pane.getStatus", args={"paneId": pane_id}
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
                if ui_status in _UI_IDLE_STATUSES:
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


@server.tool()
async def cli_send_and_wait(
    to: str, text: str, ctx: Context, timeout_s: float = 60.0
) -> dict[str, Any]:
    """Send an instruction to another CLI pane and wait for it to finish it.

    cli_send followed by cli_wait_idle, with the race between them handled:
    the target is idle at the moment you send, so a plain wait would return
    "already idle" before it ever read your message. This one remembers the
    target's last activity before sending and only accepts a turn NEWER than
    that as your answer.

    `to`, `text` and addressing are cli_send's. `timeout_s` (capped at 120s)
    covers the whole thing, not just the wait.

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

    On timeout returns {ok: true, idle: false, source: "timeout", reason,
    ...}: `reason` is cli_wait_idle's ("awaiting" / "busy" / "unreachable"),
    or "never_started" when the target stayed idle and never showed any sign
    of having read the message. `reason` is only meaningful for "timeout" and
    is absent from every other source. A send that is refused outright returns
    cli_send's {ok: false, error} unchanged.
    """
    from agent_team_backend import agent_messaging, app

    try:
        caller = _resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    me = caller.pane_id if caller.kind == "pane" else ""
    # Same gate as cli_send, applied before the resolve below so an unqualified
    # address gets the same answer here as it would there.
    if caller.kind != "pane" and "/" not in (to or ""):
        return {"ok": False, "error": _QUALIFIED_TARGET_REQUIRED}
    resolved = agent_messaging.resolve(me, to)
    if resolved.pane is None:
        return {
            "ok": False,
            "error": resolved.error or f'unknown target "{to}"',
            "error_code": resolved.code or "unknown-target",
        }
    pane_id = resolved.pane.pane_id

    baseline = app.pane_activity(pane_id)
    baseline_ts = baseline["ts_monotonic"] if baseline else None

    def has_new_activity() -> bool:
        current = app.pane_activity(pane_id)
        if current is None:
            return False
        return baseline_ts is None or current["ts_monotonic"] > baseline_ts

    started = time.monotonic()
    timeout = min(max(float(timeout_s), 0.0), _WAIT_IDLE_MAX_TIMEOUT_S)
    sent = await cli_send(to, text, ctx)
    if not sent.get("ok"):
        return sent

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
        waited = await cli_wait_idle(to, ctx, timeout_s=left)
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


def _ui_timeout_error(workspace_path: str, timeout: float) -> dict[str, Any]:
    """Explain an unanswered ui.invoke.request as one of two failures.

    A request is broadcast and every window decides for itself whether it owns
    workspace_path, so a silent deadline could mean "nobody there" or "someone
    there is stuck" — opposite fixes (check the path vs. retry/inspect that
    window), which one blended sentence left the caller guessing.

    Windows mirror their CLI panes into agent_messaging, so a workspace with a
    connected pane provably has a live window: that case is a real action
    timeout. The reverse is a strong hint but not proof — a window with no CLI
    pane open owns its workspace and answers ui.invoke while leaving no trace in
    the registry — so that branch names the failure it can prove (no window
    *known*), hands over the workspaces the backend can see, and says so. Both
    read the registry the backend already holds; neither adds a round trip.
    """
    from agent_team_backend import agent_messaging

    connected = [e for e in agent_messaging.list_panes(workspace_path) if not e.offline]
    if connected:
        return {
            "ok": False,
            "result": None,
            "error": (
                f"a Navide window is connected for workspace_path {workspace_path!r} "
                f"but did not answer within {timeout:.0f}s — the action may still be "
                "running there. Retry, or check that window; the workspace_path is "
                "not the problem"
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
    action: str | None = None,
    args: dict[str, Any] | None = None,
    is_global: bool = False,
) -> dict[str, Any]:
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    request_id = secrets.token_hex(16)
    fut = _ui_invoke_pending.register(request_id)
    event = make_event(
        "ui.invoke.request",
        {
            "request_id": request_id,
            "workspace_path": workspace_path,
            "op": op,
            "action": action,
            "args": args,
            "global": is_global,
        },
    )
    if is_global:
        sent = await app.unicast_any(event)
        if not sent:
            _ui_invoke_pending.discard(request_id)
            return {
                "ok": False,
                "result": None,
                "error": "no Navide window is open to handle this request",
                "error_code": "ui_no_window",
            }
    else:
        await app.broadcast(event)

    timeout = _UI_INVOKE_SLOW_TIMEOUT_S if action in _UI_INVOKE_SLOW_ACTIONS else _UI_INVOKE_TIMEOUT_S
    result = await _ui_invoke_pending.wait(request_id, fut, timeout=timeout)
    if result is TIMEOUT:
        return _ui_timeout_error(workspace_path, timeout)
    return result


@server.tool()
async def ui_list_actions(workspace_path: str, ctx: Context) -> dict[str, Any]:
    """List the UI actions registered by the Navide window for workspace_path.

    Returns the list of registered action ids (plain strings), so a caller
    can discover what ui_invoke accepts before calling it. Errors if no
    window owns workspace_path within 15s.
    """
    _resolve_caller(ctx)
    return await _ui_request(workspace_path, "list_actions")


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
    """
    _resolve_caller(ctx)
    return await _ui_request(
        workspace_path, "invoke", action=action, args=args, is_global=action == "ui.workspace.open"
    )


@server.tool()
async def ui_snapshot(workspace_path: str, ctx: Context) -> dict[str, Any]:
    """Return a structured snapshot of UI state for the Navide window at workspace_path.

    Shape is decided by the renderer (panes, tabs, focus, etc.). Errors if no
    window owns workspace_path within 15s.
    """
    _resolve_caller(ctx)
    return await _ui_request(workspace_path, "snapshot")


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
    """
    _resolve_caller(ctx)
    return await _ui_request(
        workspace_path,
        "invoke",
        action="ui.diagnostics.read",
        args={"sinceSeq": since_seq, "paneId": pane_id, "limit": limit},
    )


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
