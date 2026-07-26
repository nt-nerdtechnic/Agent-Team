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
``shutdown`` are invoked from app.py's startup/shutdown events, which Starlette
runs in the same lifespan task — safe for the anyio task group inside.
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

from mcp.server.fastmcp import FastMCP
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.responses import PlainTextResponse
from starlette.types import Receive, Scope, Send

from .fs_service import FsError, _resolve_safe, write_file
from .plan_meta import PLAN_STAGES, TODO_STATUSES, parse_plan_meta, write_plan_meta
from .plan_provisioning import TEMPLATE_FILENAME, ensure_plan_assets

PLANS_REL_DIR = ".agent-team/plans"

server = FastMCP(
    name="navide-plans",
    instructions=(
        "Access to Navide plan documents stored under "
        f"{PLANS_REL_DIR}/ in a workspace. Call plan_list first to discover "
        "plans, then plan_read to fetch one. Write tools: plan_create, "
        "plan_update_stage, plan_update_todo, plan_add_note. Dispatch tools: "
        "list_dispatch_targets, plan_dispatch."
    ),
)


# ── sync filesystem layer (runs in a worker thread) ─────────────────────────


def _plans_root(workspace_path: str) -> Path:
    """Resolve the plans dir under the workspace (raises FsError on escape)."""
    return _resolve_safe(workspace_path, PLANS_REL_DIR)


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
                "rel_path": path.name,
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
    target = _resolve_safe(workspace_path, f"{PLANS_REL_DIR}/{rel_path}")
    if target == root or not target.is_relative_to(root):
        raise FsError("path escapes the plans directory")
    return target


def _read_plan_sync(workspace_path: str, rel_path: str) -> dict[str, Any]:
    target = _plan_target(workspace_path, rel_path)
    if not target.is_file():
        raise FsError(f"plan not found: {rel_path}")
    html = target.read_text(encoding="utf-8", errors="replace")
    return {"rel_path": rel_path, "meta": parse_plan_meta(html), "html": html}


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
        f"{PLANS_REL_DIR}/{rel_path}",
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
        rel_path = f"{slug}_{secrets.token_hex(3)}.html"
        if not (root / rel_path).exists():
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
    _save_plan(workspace_path, rel_path, content)
    return {"rel_path": rel_path, "name": name, "stage": "draft"}


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


# ── MCP tools ───────────────────────────────────────────────────────────────


@server.tool()
async def plan_list(workspace_path: str) -> list[dict[str, Any]]:
    """List plan documents in the workspace's .agent-team/plans/ directory.

    Skips provisioned assets (basename starting with "_") and files without a
    valid plan-meta island. Each entry has: rel_path (relative to the plans
    directory — pass it to plan_read), name, stage, overview, todos
    ({total, by_status} counts), mtime (epoch seconds).
    """
    return await asyncio.to_thread(_list_plans_sync, workspace_path)


@server.tool()
async def plan_read(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Read one plan document from the workspace's .agent-team/plans/ directory.

    rel_path is relative to the plans directory (as returned by plan_list).
    Returns {rel_path, meta, html}: the parsed plan-meta dict (null if the
    island is missing/invalid) and the raw file content.
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
    Returns {rel_path, name, stage}.
    """
    return await asyncio.to_thread(_create_plan_sync, workspace_path, name, overview, todos)


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


# ── dispatch (plan → CLI terminal session) ──────────────────────────────────


def _plan_execution_prompt(plan_workspace_rel_path: str) -> str:
    """Python mirror of the frontend's planExecutionPrompt template
    (src/renderer/src/lib/planExecutePrompt.ts) — keep the wording in sync so
    MCP dispatch behaves exactly like the plan window's dispatch button.
    """
    return (
        f"Execute the approved plan document at {plan_workspace_rel_path} "
        "(workspace-relative path). "
        "Read the plan first, then implement it by its todos phase by phase. "
        "Update the plan-meta todo status (and the matching visible markup) "
        "as you complete each phase. "
        'Set the plan-meta stage to "done" when all todos are complete.'
    )


def _terminal_service() -> Any:
    """Resolve the app-level TerminalService at call time (never at import —
    app.py imports this module, and the singleton binds to the running loop).
    Maps an unavailable service to a clear tool error.
    """
    from . import app as _app  # local import: app.py imports plan_mcp

    try:
        service = _app.get_terminals()
    except Exception as err:  # noqa: BLE001
        raise RuntimeError(f"terminal service unavailable: {err}") from err
    if service is None:
        raise RuntimeError("terminal service unavailable (backend not initialized)")
    return service


@server.tool()
async def plan_dispatch(
    workspace_path: str, plan_rel_path: str, session_id: str, submit: bool = True
) -> dict[str, Any]:
    """Send an "execute this plan" prompt into a CLI terminal session.

    plan_rel_path is relative to the plans directory (as returned by
    plan_list). The prompt is the same template the plan window's dispatch
    button injects. With submit=true (default) a carriage return follows the
    prompt so the CLI agent starts immediately; submit=false only types the
    prompt. Dispatch guarantees delivery to the session's PTY, not that the
    agent acted on it. Use list_dispatch_targets to find session ids.
    Returns {plan_rel_path, session_id, submitted, prompt}.
    """
    await asyncio.to_thread(_require_plan_sync, workspace_path, plan_rel_path)
    terminals = _terminal_service()
    prompt = _plan_execution_prompt(f"{PLANS_REL_DIR}/{plan_rel_path}")
    terminals.write(session_id, prompt)
    if submit:
        # Brief pause so the CLI's input handling ingests the text before
        # Enter arrives (the frontend's injectText does the same, with
        # bracketed paste + a delayed Enter).
        await asyncio.sleep(0.05)
        terminals.write(session_id, "\r")
    return {
        "plan_rel_path": plan_rel_path,
        "session_id": session_id,
        "submitted": submit,
        "prompt": prompt,
    }


@server.tool()
async def list_dispatch_targets(
    agent_key: str | None = None, workspace: str | None = None
) -> list[dict[str, Any]]:
    """List CLI terminal sessions plan_dispatch can target.

    Each entry: {session_id, pane_id, agent_key, cwd, workspace_path, alive}.
    workspace_path falls back to cwd when the session carries no explicit
    workspace metadata (same rule the backend's pane bookkeeping uses).
    Optional filters: agent_key (exact match) and workspace (exact match
    against workspace_path). Read-only.
    """
    terminals = _terminal_service()
    sessions = list(getattr(terminals, "_sessions", {}).values())  # snapshot
    targets: list[dict[str, Any]] = []
    for session in sessions:
        try:
            metadata = session.metadata if isinstance(session.metadata, dict) else {}
            entry = {
                "session_id": session.id,
                "pane_id": session.pane_id,
                "agent_key": session.agent_key,
                "cwd": session.cwd,
                "workspace_path": str(metadata.get("workspace_path") or session.cwd),
                "alive": not session.closed,
            }
        except AttributeError:
            continue  # defensive: session shape changed mid-iteration
        if agent_key is not None and entry["agent_key"] != agent_key:
            continue
        if workspace is not None and entry["workspace_path"] != workspace:
            continue
        targets.append(entry)
    return targets


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
