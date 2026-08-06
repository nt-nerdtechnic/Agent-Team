"""WebSocket message-handler registry (strangler-fig migration target).

Handlers are registered here and dispatched from ``app.handle_message`` before
the legacy ``if/elif msg_type`` chain. Each handler has the signature
``(session, msg_id, msg_type, payload) -> None`` and is a pure side-effect
coroutine: it responds via ``session.send_json`` and returns nothing.

Module-level imports must not import ``.app`` (that would be circular, since
``app`` imports this module). Handlers that need app-level module globals use a
function-level ``from . import app``.
"""

from __future__ import annotations

import asyncio
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from pydantic import ValidationError

from . import agent_messaging, executions_service, storage_service
from .cli_vendors.registry import VENDORS as CLI_VENDORS
from .cli_vendors.registry import vendor as cli_vendor
from .ipc import make_error, make_event, make_response
from .log_readers.claude import ClaudeLogReader, first_user_prompts
from .credential_vault import DEFAULT_SLOT_ID, vault_to_thread
from .mcp_settings import (
    MCPSettingsConflictError,
    MCPSettingsError,
    restore_mcp_server_secrets,
)
from .profiles_store import SUPPORTED_AGENT_KEYS as PROFILE_AGENT_KEYS
from .skills_store import (
    SkillConflictError,
    SkillNotFoundError,
    SkillValidationError,
    SkillsStoreError,
)
from .spawn_history import canonical_workspace_path, filter_foreign_entries

if TYPE_CHECKING:
    from .app import Session

Handler = Callable[["Session", str, str, dict], Awaitable[None]]

_REGISTRY: dict[str, Handler] = {}

# Dedicated pool for onboarding.status, whose dep probing (version subprocesses
# + config-home scans) can run for seconds. Keeping it off asyncio's shared
# default executor stops it from starving latency-sensitive requests such as
# workspace.list_recent, which fire concurrently on the same connect event.
# A single worker suffices: this pool only provides isolation — the actual
# dep fan-out happens inside get_status's own pool — so concurrent
# onboarding.status calls (multi-window connect) queue here rather than
# racing, which also avoids doubling up first-run state migrations.
_ONBOARDING_EXECUTOR = ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="onboarding"
)

# Dedicated pool for the pre-spawn CLI work of terminal.create: the agent CLI
# probe (a subprocess with an 8s budget) and the login-shell PATH refresh (a
# subprocess with a 3s budget). Opening a dozen panes at once used to fill
# asyncio's shared default executor with these, starving every other
# to_thread in the backend — including the credential I/O that runs while an
# agent's switch_lock is held, so the lock was never released and the very
# spawns that filled the pool then deadlocked waiting for it.
# Eight workers: probes are subprocess-bound, not CPU-bound, so this only has
# to stay clear of the default executor's ~12-16 — it does not have to be
# small. Sizing it smaller would regress the case this pool does NOT protect:
# fresh spawns are not throttled frontend-side (only resumes are), so a
# pipeline fan-out arrives all at once, and at 4 workers a 16-pane burst would
# serialize past the frontend's 30s terminal.create timeout on a cold machine
# where each probe nears its 8s budget.
_CLI_PROBE_EXECUTOR = ThreadPoolExecutor(
    max_workers=8, thread_name_prefix="cli-probe"
)

# Ceiling on acquiring an agent's credential switch lock before a spawn: a
# legitimate account switch completes in well under a second, so this is purely
# a deadlock backstop the normal path never reaches. Kept just UNDER the
# frontend's 30s TERMINAL_CREATE_TIMEOUT_MS (resume-command.ts) on purpose —
# at 30s the client gives up first and reports a generic request timeout, and
# the named reason below (the whole point of the backstop) never arrives.
_SWITCH_LOCK_TIMEOUT_SEC = 25.0


def handler(*msg_types: str) -> Callable[[Handler], Handler]:
    """Register ``fn`` for one or more ``msg_type`` values.

    Duplicate registration for the same ``msg_type`` raises ``ValueError`` so
    that accidental collisions surface at import time rather than silently
    shadowing an earlier handler.
    """

    def decorate(fn: Handler) -> Handler:
        for mt in msg_types:
            if mt in _REGISTRY:
                raise ValueError(f"duplicate handler registration for msg_type {mt!r}")
            _REGISTRY[mt] = fn
        return fn

    return decorate


def lookup(msg_type: str) -> Handler | None:
    return _REGISTRY.get(msg_type)


# ── Editor AI (editor.*) ────────────────────────────────────────────────────
@handler("editor.rewrite")
async def editor_rewrite(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app
    from .ai_chat_cli_engine import run_cli_text

    await app._ensure_fresh_path_for_spawn("claude")
    _rew_code = payload.get("code", "") or ""
    _rew_instr = payload.get("instruction", "") or ""
    _rew_lang = payload.get("language", "") or ""
    _lang_hint = f" ({_rew_lang})" if _rew_lang else ""
    _prompt = (
        f"Rewrite the following code{_lang_hint} per this instruction: {_rew_instr}\n\n"
        f"```\n{_rew_code}\n```\n\nReturn ONLY the rewritten code, no explanation."
    )
    try:
        _text = await run_cli_text(
            _prompt,
            system_prompt="You are a code rewriting assistant. Output only code.",
        )
        # Strip markdown fences if model wrapped the code
        _text = re.sub(r'^```[a-zA-Z]*\n?', '', _text).strip()
        _text = re.sub(r'\n?```$', '', _text).strip()
        result = {"ok": True, "text": _text} if _text else {"ok": False, "error": "Empty response"}
    except Exception as _rew_exc:  # noqa: BLE001
        result = {"ok": False, "error": str(_rew_exc)}
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("editor.complete")
async def editor_complete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await app.editor_service.complete(
        app._az_base_url(),
        payload.get("model") or app.ANALYZER_DEFAULT_MODEL,
        payload.get("prefix", "") or "",
        payload.get("suffix", "") or "",
        payload.get("language", "") or "",
    )
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Explorer filesystem (fs.*) ──────────────────────────────────────────────
# Read-only directory scans run in a worker thread: os.scandir/os.walk
# on a large repo or slow/network disk would otherwise block the event
# loop and stall every other in-flight request on the connection.
@handler("fs.list_dir")
async def fs_list_dir(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    rel = payload.get("rel_path", "") or ""
    app._watch_plans_workspace(ws_path, rel)
    show_hidden = bool(payload.get("show_hidden", False))
    result = await asyncio.to_thread(app.fs_service.list_dir, ws_path, rel, show_hidden=show_hidden)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.list_files_flat")
async def fs_list_files_flat(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    query = payload.get("query", "") or ""
    max_results = int(payload.get("max_results", 100))
    result = await asyncio.to_thread(
        app.fs_service.list_files_flat, ws_path, query=query, max_results=max_results
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.glob_files")
async def fs_glob_files(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    pattern = payload.get("pattern", "") or ""
    result = await asyncio.to_thread(app.fs_service.glob_files, ws_path, pattern=pattern)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.mkdir")
async def fs_mkdir(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(app.fs_service.mkdir, ws_path, payload.get("rel_path", "") or "")
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.create_file")
async def fs_create_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.fs_service.create_file,
        ws_path, payload.get("rel_path", "") or "", payload.get("content", "") or ""
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.rename")
async def fs_rename(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.fs_service.rename,
        ws_path, payload.get("src_path", "") or "", payload.get("dst_path", "") or ""
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.delete")
async def fs_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    # to_thread: moving a large directory to the filesystem Trash may block.
    result = await asyncio.to_thread(app.fs_service.delete, ws_path, payload.get("rel_path", "") or "")
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.write_file")
async def fs_write_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    app._watch_plans_workspace(ws_path, payload.get("rel_path", "") or "")
    expected_mtime = payload.get("expected_mtime")
    result = await asyncio.to_thread(
        app.fs_service.write_file,
        ws_path, payload.get("rel_path", "") or "", payload.get("content", "") or "",
        encoding=payload.get("encoding") or "utf-8",
        expected_mtime=float(expected_mtime) if expected_mtime is not None else None,
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("fs.read_file")
async def fs_read_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    app._watch_plans_workspace(ws_path, payload.get("rel_path", "") or "")
    enc_override = payload.get("encoding_override") or None
    result = await asyncio.to_thread(
        app.fs_service.read_file, ws_path, payload.get("rel_path", "") or "", encoding_override=enc_override
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.stat_path")
async def fs_stat_path(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await asyncio.to_thread(app.fs_service.stat_path, payload.get("path", "") or "")
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.read_image")
async def fs_read_image(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(app.fs_service.read_image, ws_path, payload.get("rel_path", "") or "")
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.list_archive")
async def fs_list_archive(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.fs_service.list_archive, ws_path, payload.get("rel_path", "") or ""
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("fs.convert_office")
async def fs_convert_office(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.fs_service.convert_office, ws_path, payload.get("rel_path", "") or ""
    )
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Search (search.*) ───────────────────────────────────────────────────────
@handler("search.find_in_files")
async def search_find_in_files(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # A new search supersedes any in-flight one from this session:
    # cancel it so stale scans don't stack up server-side. (The
    # frontend's seq guard already discards the stale response.)
    if session._search_cancel is not None:
        session._search_cancel.set()
    cancel_event = threading.Event()
    session._search_cancel = cancel_event
    result = await asyncio.to_thread(
        app.search_service.find_in_files,
        payload.get("workspace_path") or "",
        payload.get("query", "") or "",
        is_regex=bool(payload.get("is_regex")),
        case_sensitive=bool(payload.get("case_sensitive")),
        whole_word=bool(payload.get("whole_word")),
        includes=payload.get("includes", "") or "",
        excludes=payload.get("excludes", "") or "",
        cancel_event=cancel_event,
    )
    if session._search_cancel is cancel_event:
        session._search_cancel = None
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("search.replace_in_files")
async def search_replace_in_files(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await asyncio.to_thread(
        app.search_service.replace_in_files,
        ws_path,
        payload.get("query", "") or "",
        payload.get("replacement", "") or "",
        payload.get("files", []) or [],
        is_regex=bool(payload.get("is_regex")),
        case_sensitive=bool(payload.get("case_sensitive")),
        whole_word=bool(payload.get("whole_word")),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok") and result.get("total"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


# ── Git (git.*) ───────────────────────────────────────────────────────────────
@handler("git.init")
async def git_init(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    create_gi = bool(payload.get("create_gitignore", True))
    result = await app.git_service.init_repo(ws_path, create_gitignore=create_gi)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.status")
async def git_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    # The GitPane is now looking at this workspace — start (idempotently)
    # watching it on disk so external changes refresh near-instantly.
    if app._git_watcher is not None:
        app._git_watcher.watch(ws_path)
    include_ignored = bool(payload.get("include_ignored", False))
    result = await app.git_service.get_status(ws_path, include_ignored=include_ignored)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.discover_repositories")
async def git_discover_repositories(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    max_depth = min(int(payload.get("max_depth", 3)), 8)
    limit = min(int(payload.get("limit", 20)), 100)
    result = await app.git_service.discover_repositories(ws_path, max_depth=max_depth, limit=limit)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.log")
async def git_log(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    n = min(int(payload.get("n", 20)), 500)
    all_branches = bool(payload.get("all", False))
    query = payload.get("query") or None
    order = payload.get("order") or "ancestor"
    result = await app.git_service.get_log(ws_path, n, all_branches, query, order)
    await session.send_json(make_response(msg_id, msg_type, {"commits": result}))


@handler("git.stage")
async def git_stage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    files = payload.get("files") or []
    result = await app.git_service.stage_files(ws_path, files)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.unstage")
async def git_unstage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    files = payload.get("files") or []
    result = await app.git_service.unstage_files(ws_path, files)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.stage_all")
async def git_stage_all(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.stage_all(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.check_staged")
async def git_check_staged(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.check_staged(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.commit")
async def git_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    message = payload.get("message") or ""
    commit_all = bool(payload.get("all"))
    result = await app.git_service.commit(ws_path, message, commit_all)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.sync")
async def git_sync(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.sync(
        ws_path,
        on_credential_request=app.build_credential_request_emitter(ws_path),
        on_credential_settled=app.build_credential_settled_emitter(ws_path),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.generate_message")
async def git_generate_message(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    ollama_url = app._az_base_url()
    attempt_count = int(payload.get("attempt_count") or 0)
    chat_settings = app.ai_chat_settings_store.get()
    model = payload.get("model") or chat_settings.get("model") or app.ANALYZER_DEFAULT_MODEL
    result = await app.git_service.generate_commit_message(ws_path, ollama_url, model, attempt_count, settings=chat_settings)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.discard")
async def git_discard(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    files = payload.get("files") or []
    result = await app.git_service.discard_changes(ws_path, files)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.fetch")
async def git_fetch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.fetch(
        ws_path,
        on_credential_request=app.build_credential_request_emitter(ws_path),
        on_credential_settled=app.build_credential_settled_emitter(ws_path),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.pull")
async def git_pull(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.pull_only(
        ws_path,
        on_credential_request=app.build_credential_request_emitter(ws_path),
        on_credential_settled=app.build_credential_settled_emitter(ws_path),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.push")
async def git_push(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    remote = payload.get("remote") or ""
    branch = payload.get("branch") or ""
    result = await app.git_service.push_only(
        ws_path,
        remote,
        branch,
        on_credential_request=app.build_credential_request_emitter(ws_path),
        on_credential_settled=app.build_credential_settled_emitter(ws_path),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.credential_submit")
async def git_credential_submit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    request_id = str(payload.get("request_id") or "")
    value = payload.get("value")
    ok = app.git_service.resolve_credential(request_id, str(value) if value is not None else None)
    await session.send_json(make_response(msg_id, msg_type, {"ok": ok}))


@handler("git.credential_cancel")
async def git_credential_cancel(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    request_id = str(payload.get("request_id") or "")
    ok = app.git_service.resolve_credential(request_id, None)
    await session.send_json(make_response(msg_id, msg_type, {"ok": ok}))


@handler("git.branches")
async def git_branches(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.list_branches(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.create_branch")
async def git_create_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    switch_to = bool(payload.get("switch_to", True))
    start_point = payload.get("start_point") or ""
    result = await app.git_service.create_branch(
        ws_path, name, switch_to=switch_to, start_point=start_point
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.switch_branch")
async def git_switch_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    result = await app.git_service.switch_branch(ws_path, name)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.checkout_commit")
async def git_checkout_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.checkout_commit(ws_path, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.reset")
async def git_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit") or ""
    mode = payload.get("mode") or ""
    result = await app.git_service.reset_to_commit(ws_path, commit_hash, mode)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.checkout_remote_branch")
async def git_checkout_remote_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    remote_ref = payload.get("remote_ref") or ""
    result = await app.git_service.checkout_remote_branch(ws_path, remote_ref)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.delete_branch")
async def git_delete_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    force = bool(payload.get("force", False))
    result = await app.git_service.delete_branch(ws_path, name, force=force)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.stash_list")
async def git_stash_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    entries = await app.git_service.stash_list(ws_path)
    await session.send_json(make_response(msg_id, msg_type, {"stashes": entries}))


@handler("git.stash")
async def git_stash(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    message = payload.get("message") or ""
    paths = payload.get("paths") or None
    result = await app.git_service.stash_push(ws_path, message, paths)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.stash_pop")
async def git_stash_pop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    index = int(payload.get("index", 0))
    result = await app.git_service.stash_pop(ws_path, index)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.stash_drop")
async def git_stash_drop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    index = int(payload.get("index", 0))
    result = await app.git_service.stash_drop(ws_path, index)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.amend")
async def git_amend(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    message = payload.get("message") or ""
    result = await app.git_service.amend_commit(ws_path, message)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.undo_commit")
async def git_undo_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.undo_last_commit(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.diff_file")
async def git_diff_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    staged = bool(payload.get("staged", False))
    commit = payload.get("commit") or ""
    result = await app.git_service.diff_file(ws_path, filepath, staged=staged, commit=commit)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.diff_blame")
async def git_diff_blame(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    staged = bool(payload.get("staged", False))
    result = await app.git_service.diff_blame(ws_path, filepath, staged=staged)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.commit_file_diff")
async def git_commit_file_diff(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.commit_file_diff(ws_path, commit_hash, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.diff_all")
async def git_diff_all(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    staged = bool(payload.get("staged", False))
    result = await app.git_service.diff_all(ws_path, staged=staged)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.merge")
async def git_merge(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    branch = payload.get("branch") or ""
    result = await app.git_service.merge_branch(ws_path, branch)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.merge_into")
async def git_merge_into(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    target = payload.get("target") or ""
    result = await app.git_service.merge_into(ws_path, target)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.revert")
async def git_revert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.revert_commit(ws_path, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.remotes")
async def git_remotes(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    remotes = await app.git_service.list_remotes(ws_path)
    await session.send_json(make_response(msg_id, msg_type, {"remotes": remotes}))


@handler("git.add_remote")
async def git_add_remote(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    url = payload.get("url") or ""
    result = await app.git_service.add_remote(ws_path, name, url)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.connect_to_remote")
async def git_connect_to_remote(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    url = payload.get("url") or ""
    result = await app.git_service.connect_to_remote(ws_path, url)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.remove_remote")
async def git_remove_remote(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    result = await app.git_service.remove_remote(ws_path, name)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.cherry_pick")
async def git_cherry_pick(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.cherry_pick(ws_path, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.tags")
async def git_tags(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    tags = await app.git_service.list_tags(ws_path)
    await session.send_json(make_response(msg_id, msg_type, {"tags": tags}))


@handler("git.create_tag")
async def git_create_tag(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    message = payload.get("message") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.create_tag(ws_path, name, message, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.delete_tag")
async def git_delete_tag(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    name = payload.get("name") or ""
    result = await app.git_service.delete_tag(ws_path, name)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.file_log")
async def git_file_log(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    n = int(payload.get("n", 15))
    commits = await app.git_service.file_log(ws_path, filepath, n)
    await session.send_json(make_response(msg_id, msg_type, {"commits": commits}))


@handler("git.show_file")
async def git_show_file(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    rev = payload.get("rev") or "HEAD"
    result = await app.git_service.show_file(ws_path, filepath, rev)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.resolve_ours")
async def git_resolve_ours(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.resolve_conflict_ours(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.resolve_theirs")
async def git_resolve_theirs(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.resolve_conflict_theirs(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.conflict_stages")
async def git_conflict_stages(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.conflict_stages(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.list_conflicts")
async def git_list_conflicts(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.list_conflicts(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.mark_resolved")
async def git_mark_resolved(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.mark_resolved(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.clean")
async def git_clean(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    dry_run = bool(payload.get("dry_run", True))
    result = await app.git_service.clean_untracked(ws_path, dry_run=dry_run)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok") and not dry_run:
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.show_commit")
async def git_show_commit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    commit_hash = payload.get("commit_hash") or ""
    result = await app.git_service.show_commit(ws_path, commit_hash)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.worktrees")
async def git_worktrees(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    entries = await app.git_service.list_worktrees(ws_path)
    await session.send_json(make_response(msg_id, msg_type, {"worktrees": entries}))


@handler("git.add_worktree")
async def git_add_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    branch = payload.get("branch") or ""
    new_branch = bool(payload.get("new_branch", False))
    result = await app.git_service.add_worktree(ws_path, wt_path, branch, new_branch=new_branch)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.remove_worktree")
async def git_remove_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    force = bool(payload.get("force", False))
    result = await app.git_service.remove_worktree(ws_path, wt_path, force=force)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.prune_worktrees")
async def git_prune_worktrees(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.prune_worktrees(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.lock_worktree")
async def git_lock_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    reason = payload.get("reason") or ""
    result = await app.git_service.lock_worktree(ws_path, wt_path, reason)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.unlock_worktree")
async def git_unlock_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    result = await app.git_service.unlock_worktree(ws_path, wt_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.move_worktree")
async def git_move_worktree(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    wt_path = payload.get("worktree_path") or ""
    new_path = payload.get("new_path") or ""
    result = await app.git_service.move_worktree(ws_path, wt_path, new_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.repair_worktrees")
async def git_repair_worktrees(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.repair_worktree(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.config_get")
async def git_config_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.get_config(ws_path)
    result["allowed_keys"] = sorted(app.git_service._ALLOWED_CONFIG_KEYS)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.config_set")
async def git_config_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    key = payload.get("key") or ""
    value = payload.get("value") or ""
    result = await app.git_service.set_config(ws_path, key, value)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.blame")
async def git_blame(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.blame_file(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.compare_branches")
async def git_compare_branches(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    base = payload.get("base") or ""
    compare = payload.get("compare") or ""
    result = await app.git_service.compare_branches(ws_path, base, compare)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.diff_branches")
async def git_diff_branches(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    base = payload.get("base") or "main"
    compare = payload.get("compare") or ""
    result = await app.git_service.diff_branches(ws_path, base, compare)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.rebase")
async def git_rebase(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    branch = payload.get("branch") or ""
    result = await app.git_service.rebase_on(ws_path, branch)
    await session.send_json(make_response(msg_id, msg_type, result))
    # Refresh on success or when a rebase was left in progress on conflict,
    # so the UI shows the in-progress operation and conflicted files.
    if result.get("ok") or result.get("conflict_files"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.restore_from_branch")
async def git_restore_from_branch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    branch = payload.get("branch") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.restore_file_from_branch(ws_path, branch, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.push_upstream")
async def git_push_upstream(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    branch = payload.get("branch") or ""
    remote = payload.get("remote") or "origin"
    result = await app.git_service.push_set_upstream(
        ws_path,
        branch,
        remote,
        on_credential_request=app.build_credential_request_emitter(ws_path),
        on_credential_settled=app.build_credential_settled_emitter(ws_path),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.apply_patch")
async def git_apply_patch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    patch = payload.get("patch") or ""
    reverse = bool(payload.get("reverse", False))
    cached = bool(payload.get("cached", True))
    result = await app.git_service.apply_patch(ws_path, patch, reverse=reverse, cached=cached)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.clone")
async def git_clone(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    url = payload.get("url") or ""
    target_dir = payload.get("target_dir") or ""
    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.clone_repo(
        url,
        target_dir,
        on_credential_request=app.build_credential_request_emitter(ws_path),
        on_credential_settled=app.build_credential_settled_emitter(ws_path),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.ignore")
async def git_ignore(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    pattern = payload.get("pattern") or ""
    target = payload.get("target") or "project"
    untrack = bool(payload.get("untrack", True))
    result = await app.git_service.add_to_gitignore(ws_path, pattern, target=target, untrack=untrack)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.check_ignore")
async def git_check_ignore(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    filepath = payload.get("filepath") or ""
    result = await app.git_service.check_ignore(ws_path, filepath)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.abort")
async def git_abort(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    op = payload.get("op") or ""
    result = await app.git_service.abort_operation(ws_path, op)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.stash_apply")
async def git_stash_apply(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    index = int(payload.get("index", 0))
    result = await app.git_service.stash_apply(ws_path, index)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.pull_rebase")
async def git_pull_rebase(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.git_service.pull_rebase(
        ws_path,
        on_credential_request=app.build_credential_request_emitter(ws_path),
        on_credential_settled=app.build_credential_settled_emitter(ws_path),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("git.push_force")
async def git_push_force(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    remote = payload.get("remote") or ""
    branch = payload.get("branch") or ""
    result = await app.git_service.push_force(
        ws_path,
        remote,
        branch,
        on_credential_request=app.build_credential_request_emitter(ws_path),
        on_credential_settled=app.build_credential_settled_emitter(ws_path),
        credential=app._git_credential(payload),
    )
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


# ── Codex home cleanup (codex_home.cleanup) ─────────────────────────────────
@handler("codex_home.cleanup")
async def codex_home_cleanup(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    cleaned = app.codex_home_manager.cleanup(str(payload.get("session_home_id") or ""))
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "cleaned": cleaned})
    )


# ── CLI account profiles (cli_profiles.*) ───────────────────────────────────
def _profile_error(err: Exception) -> str:
    return str(err.args[0]) if err.args else str(err)


def _profile_identities() -> dict:
    """{agentKey: {slotId: {email, signedIn}}} for every account row the UI
    shows. The active slot's identity comes from the live credential state
    (slot storage lags live until the next capture/harvest); ``__default__``
    keys the built-in Default row. Blocking reads (files, plus the Keychain
    for claude secrets) — run in a thread."""
    from . import app

    doc = app.cli_profiles_store.list()
    out: dict[str, dict] = {}
    for agent_key in PROFILE_AGENT_KEYS:
        active = doc["defaults"].get(agent_key) or DEFAULT_SLOT_ID
        slot_ids = [DEFAULT_SLOT_ID] + [
            p["id"] for p in doc["profiles"] if p.get("agentKey") == agent_key
        ]
        out[agent_key] = {
            sid: app.credential_vault.identity(
                agent_key, None if sid == active else sid
            )
            for sid in slot_ids
        }
    return out


def _profile_pin_for_spawn(agent_key: str, payload_profile_id: object) -> str:
    """The profile a pane was created under, persisted in its restore record.
    Bookkeeping only (account attribution / history): spawns get no per-profile
    env, so the pin never affects which credentials a pane runs on — every
    regular pane uses the live (active-account) credentials in the real home.
    A restore carries the pane's recorded pin (``payload_profile_id``); a fresh
    spawn pins to the agent's currently active default. Returns "" for
    non-account agents, "__default__" when the active account is the unmanaged
    Default (real home), else the managed profile id."""
    from . import app

    if agent_key not in PROFILE_AGENT_KEYS:
        return ""
    pin = str(payload_profile_id or "")
    if pin:
        return pin
    active = app.cli_profiles_store.get_default_profile(agent_key)
    return active["id"] if active else DEFAULT_SLOT_ID


async def _broadcast_profiles_changed(
    reason: str,
    harvested_profile_ids: list[str] | None = None,
    agent_key: str | None = None,
    forced: bool | None = None,
) -> None:
    from . import app

    doc = app.cli_profiles_store.list()
    payload = {
        "profiles": doc["profiles"],
        "defaults": doc["defaults"],
        "identities": await asyncio.to_thread(_profile_identities),
        "reason": reason,
    }
    if harvested_profile_ids:
        # login-harvest: which profiles just captured a completed isolated
        # login — the initiating window uses this to close the login pane
        # and toast the signed-in identity.
        payload["harvestedProfileIds"] = harvested_profile_ids
    if agent_key is not None:
        # set_default: which agent switched accounts and whether the request
        # forced past the quiescence gate — every window uses this to restart
        # its own panes of that agent onto the new credentials.
        payload["agent_key"] = agent_key
        payload["forced"] = bool(forced)
    await app.broadcast(make_event("cli_profiles.changed", payload))


@handler("cli_profiles.list")
async def cli_profiles_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    doc = app.cli_profiles_store.list()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "profiles": doc["profiles"],
                "defaults": doc["defaults"],
                "identities": await asyncio.to_thread(_profile_identities),
                "supported_agents": list(PROFILE_AGENT_KEYS),
            },
        )
    )


@handler("cli_profiles.create")
async def cli_profiles_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    try:
        profile = app.cli_profiles_store.create(
            agent_key=str(payload.get("agent_key") or ""),
            name=str(payload.get("name") or ""),
        )
    except ValueError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
        )
        return
    doc = app.cli_profiles_store.list()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"profile": profile, "profiles": doc["profiles"], "defaults": doc["defaults"]},
        )
    )
    await _broadcast_profiles_changed("create")


@handler("cli_profiles.rename")
async def cli_profiles_rename(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    try:
        profile = app.cli_profiles_store.rename(
            str(payload.get("id") or ""), str(payload.get("name") or "")
        )
    except (KeyError, ValueError) as err:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
        )
        return
    doc = app.cli_profiles_store.list()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"profile": profile, "profiles": doc["profiles"], "defaults": doc["defaults"]},
        )
    )
    await _broadcast_profiles_changed("rename")


@handler("cli_profiles.delete")
async def cli_profiles_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    raw_id = payload.get("id")
    profile_id = str(raw_id) if raw_id else ""
    if not profile_id or profile_id == "__default__":
        agent_key = str(payload.get("agent_key") or payload.get("agentKey") or "")
        if not agent_key:
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", "missing agent_key for default clear")
            )
            return
        if _running_login_terminals(agent_key, "__default__"):
            await session.send_json(
                make_error(
                    msg_id, msg_type, "LOGIN_IN_PROGRESS",
                    f"a {agent_key} sign-in for this account is still running; "
                    "finish or close its pane first",
                )
            )
            return
        async with app.credential_vault.switch_lock(agent_key):
            active_id = app.cli_profiles_store.list()["defaults"].get(agent_key)
            if active_id is None:
                clear_fn = getattr(app.credential_vault, "clear_live", None)
                if callable(clear_fn):
                    await vault_to_thread(clear_fn, agent_key)
            else:
                await vault_to_thread(
                    app.credential_vault.delete_slot_secrets, agent_key, "__default__"
                )
        await _broadcast_profiles_changed("delete")
        doc = app.cli_profiles_store.list()
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {"profiles": doc["profiles"], "defaults": doc["defaults"]},
            )
        )
        return

    profile = app.cli_profiles_store.get(profile_id)
    if profile is None:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", f"profile not found: {profile_id}"
            )
        )
        return
    agent_key = str(profile.get("agentKey") or "")
    if _running_login_terminals(agent_key, profile_id):
        # Deleting the login home under a running login CLI breaks it; the
        # user finishes or closes the pane first (no auto-kill).
        await session.send_json(
            make_error(
                msg_id, msg_type, "LOGIN_IN_PROGRESS",
                f"a {agent_key} sign-in for this account is still running; "
                "finish or close its pane first",
            )
        )
        return
    # Serialize with account switches: the active check must see the latest
    # persisted default, and the secret cleanup must not interleave with a
    # credential swap on the same agent.
    async with app.credential_vault.switch_lock(agent_key):
        if app.cli_profiles_store.list()["defaults"].get(agent_key) == profile_id:
            # The active account's credentials ARE the live state; deleting it
            # would orphan them (the next switch would capture into a slot
            # nobody can select any more).
            await session.send_json(
                make_error(
                    msg_id, msg_type, "PROFILE_ACTIVE",
                    f"this {agent_key} account is currently active; "
                    "switch to another account before deleting it",
                )
            )
            return
        # Remove secrets the archived slot dir cannot carry (claude's slot
        # Keychain item + oauth-account.json) and any leftover login home,
        # BEFORE the store renames the slot dir away. Cleanup failures must
        # never block the delete.
        try:
            await vault_to_thread(
                app.credential_vault.delete_slot_secrets, agent_key, profile_id
            )
        except Exception as err:  # noqa: BLE001
            app.log.warning(
                "slot secret cleanup for %s/%s failed: %s", agent_key, profile_id, err
            )
        try:
            doc = app.cli_profiles_store.delete(profile_id)
        except KeyError as err:
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
            )
            return
    await _broadcast_profiles_changed("delete")
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"profiles": doc["profiles"], "defaults": doc["defaults"]},
        )
    )


def _running_login_terminals(agent_key: str, profile_id: str) -> list[tuple[str, "Session"]]:
    """(terminal_id, owner session) for every live isolated LOGIN pane of the
    given profile. While one runs, its login home must not be harvested: the
    CLI could still rotate the token after the snapshot, and deleting the
    config home under a running CLI breaks it."""
    from . import app

    running: list[tuple[str, "Session"]] = []
    for tid, owner in list(app._PTY_OWNERS.items()):
        term = owner.terminals.get(tid)
        if (
            term is not None
            and not term.closed
            and term.agent_key == agent_key
            and term.metadata.get("login_profile_id") == profile_id
        ):
            running.append((tid, owner))
    return running


def _running_regular_terminals(agent_key: str) -> list[str]:
    """Terminal ids of every live NON-login pane of the given agent. Every
    regular pane runs on the live credentials in the real home — the very
    credentials an account switch swaps — so a still-running CLI would keep
    refreshing the outgoing account's token there mid-swap."""
    from . import app

    running: list[str] = []
    for tid, owner in list(app._PTY_OWNERS.items()):
        term = owner.terminals.get(tid)
        if (
            term is not None
            and not term.closed
            and term.agent_key == agent_key
            and not term.metadata.get("login_profile_id")
        ):
            running.append(tid)
    return running


def _slot_needs_login(agent_key: str, slot_id: str) -> bool:
    """True when restoring this slot leaves the CLI unable to authenticate, so
    the caller should start a sign-in right after the switch.

    Three cases: the slot holds no secret at all (restore() then CLEARS the live
    credentials — an empty slot signs the user out), claude's snapshot was wiped
    in place by Claude Code (both tokens emptied after an ``invalid_grant``, so
    it restores as a non-credential), or claude's snapshot sat
    parked long enough for its access token to expire. Nothing renews a parked
    slot — the CLI is the only refresher — so the expired token goes live and
    Claude Code renews it from the restored refresh token on its next run;
    offering a sign-in is the fallback for when that refresh token is dead too.
    A claude login with no OAuth block (long-lived token) carries nothing to
    judge, so it counts as usable. Blocking reads (Keychain) — thread it."""
    from . import app
    from .credential_vault import _claude_credential_is_wiped
    from .usage_service import claude_token_expired, parse_claude_credentials

    try:
        creds = app.credential_vault.read_slot(agent_key, slot_id)
    except Exception:  # noqa: BLE001 — a read failure must not invent a logout
        return False
    if creds.secret is None:
        return True
    if agent_key != "claude":
        return False
    # A wiped blob parses as "no OAuth block to judge", which the expiry check
    # below would pass as usable — catch it before that.
    if _claude_credential_is_wiped(creds.secret):
        return True
    oauth = parse_claude_credentials(creds.secret)
    return oauth is not None and claude_token_expired(oauth)


@handler("cli_profiles.set_default")
async def cli_profiles_set_default(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Switch the agent's active account: capture the live credentials into the
    outgoing account's slot, then restore the target slot into the real home.
    Every regular pane runs on those live credentials, so the switch is gated
    on quiescence: live non-login panes of the agent fail it with PANES_RUNNING
    unless the request carries force=true (the frontend then restarts the
    affected panes itself — the backend never kills them). A still-running
    isolated sign-in for the target account also blocks it (LOGIN_IN_PROGRESS),
    because the switch harvests its login home into the slot before restoring
    it."""
    from . import app

    agent_key = str(payload.get("agent_key") or "")
    raw_profile_id = payload.get("profile_id")
    profile_id = str(raw_profile_id) if raw_profile_id else None

    # Validate before touching any credentials.
    if agent_key not in PROFILE_AGENT_KEYS:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST",
                f"unsupported agent for CLI profiles: {agent_key!r}",
            )
        )
        return
    if profile_id is not None:
        profile = app.cli_profiles_store.get(profile_id)
        if profile is None:
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST",
                    f"profile not found: {profile_id}",
                )
            )
            return
        if profile.get("agentKey") != agent_key:
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST",
                    f"profile {profile_id} does not belong to agent {agent_key!r}",
                )
            )
            return

    # Serialize the whole read-current → swap → persist-default sequence per
    # agent: concurrent switches (multiple windows, or a switch racing the usage
    # poller's harvest) would otherwise both read the same current_id and clobber
    # a slot. Reading current_id inside the lock is essential — a second waiter
    # must see the first switch's persisted result.
    async with app.credential_vault.switch_lock(agent_key):
        current_id = app.cli_profiles_store.list()["defaults"].get(agent_key)
        if current_id == profile_id:
            # Already active — nothing to swap, nothing changed.
            await session.send_json(
                make_response(
                    msg_id, msg_type, {"defaults": app.cli_profiles_store.list()["defaults"]}
                )
            )
            return

        # Quiescence gate: a live regular pane keeps refreshing the outgoing
        # account's token in the very live location the swap rewrites. Refuse
        # unless the caller forces the switch (it then restarts the affected
        # panes itself; the backend never kills them).
        if not payload.get("force"):
            running_count = len(_running_regular_terminals(agent_key))
            if running_count:
                await session.send_json(
                    make_error(
                        msg_id, msg_type, "PANES_RUNNING",
                        f"{running_count} running {agent_key} pane(s) still use "
                        "the current account; close them or force the switch",
                        {"count": running_count},
                    )
                )
                return

        # A pending isolated login home for the target profile must land in
        # its slot BEFORE restore() — restoring the still-empty slot would
        # sign the live state out and the next capture() would erase the
        # completed login. While the login pane's CLI is still running the
        # home cannot be harvested safely (token rotation, config home
        # deleted under a live CLI), so refuse the switch (LOGIN_IN_PROGRESS).
        if profile_id is not None and await vault_to_thread(
            app.credential_vault.login_home_path(agent_key, profile_id).is_dir
        ):
            if _running_login_terminals(agent_key, profile_id):
                await session.send_json(
                    make_error(
                        msg_id, msg_type, "LOGIN_IN_PROGRESS",
                        f"a {agent_key} sign-in for this account is still running; "
                        "finish or close its pane first",
                    )
                )
                return
            try:
                await vault_to_thread(
                    app.credential_vault.harvest_login_home, agent_key, profile_id
                )
            except Exception as err:  # noqa: BLE001 — credentials untouched, refuse cleanly
                await session.send_json(
                    make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
                )
                return

        # Judged BEFORE the swap, while the slot still holds what will become
        # live: an empty or dead-token slot signs the CLI out, and the caller
        # opens a sign-in instead of leaving the user at a "not logged in"
        # prompt they have to resolve by hand.
        needs_login = await vault_to_thread(
            _slot_needs_login, agent_key, profile_id or DEFAULT_SLOT_ID
        )

        try:
            await vault_to_thread(
                app.credential_vault.switch,
                agent_key,
                current_id or DEFAULT_SLOT_ID,
                profile_id or DEFAULT_SLOT_ID,
            )
        except Exception as err:  # noqa: BLE001 — switch() already rolled the live state back
            await session.send_json(
                make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
            )
            return

        try:
            defaults = app.cli_profiles_store.set_default(agent_key, profile_id)
        except (KeyError, ValueError) as err:
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
            )
            return
        await session.send_json(
            make_response(msg_id, msg_type, {"defaults": defaults, "needsLogin": needs_login})
        )
    await _broadcast_profiles_changed(
        "set_default", agent_key=agent_key, forced=bool(payload.get("force"))
    )
    # The usage badges read the active account's credentials — force the poller
    # to re-fetch now so the badge reflects the switch immediately.
    from .usage_service import service

    service.request_refresh()


# ── Agent session / orphans (agent.*) ───────────────────────────────────────
@handler("agent.session_exists")
async def agent_session_exists(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    _agent = str(payload.get("agent", ""))
    _ws = str(payload.get("workspace_path", ""))
    _sid = str(payload.get("session_id", ""))
    exists = app._session_exists(_agent, _ws, _sid)
    checked_path = app._session_lookup_path(_agent, _ws, _sid)
    if not exists and _sid.strip():
        # Diagnostic: a resume that reports "not found" logs exactly
        # where it looked, so a colliding/encoded path is visible.
        app.log.info(
            "resume preflight miss: agent=%s session=%s checked=%s",
            _agent.strip().lower(), _sid.strip(),
            checked_path or "(vendor-managed)",
        )
    await session.send_json(
        make_response(msg_id, msg_type, {"exists": exists, "checked_path": checked_path})
    )


@handler("agent.orphan_scan")
async def agent_orphan_scan(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Read-only leftover count (dead-backend PTY children still alive).
    orphans = await asyncio.to_thread(app.pty_registry.scan_orphans)
    await session.send_json(
        make_response(msg_id, msg_type, {"orphans": orphans, "count": len(orphans)})
    )


@handler("agent.reap_orphans")
async def agent_reap_orphans(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Manual cleanup: kill the leftover process groups reap_stale finds.
    reaped = await asyncio.to_thread(app.pty_registry.reap_stale)
    await session.send_json(
        make_response(msg_id, msg_type, {"reaped": reaped, "count": len(reaped)})
    )


# ── MCP servers (mcp.*) ─────────────────────────────────────────────────────
@handler("mcp.list_servers")
async def mcp_list_servers(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    try:
        configured = app.mcp_settings_store.list_servers()
    except MCPSettingsError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_SETTINGS_INVALID",
                str(err),
                {"path": str(app.mcp_settings_store.path)},
            )
        )
        return
    revision = str(app.mcp_settings_store.revision)
    live = await app.mcp_manager.list_status()
    live_map = {s["name"]: s for s in live}
    merged = []
    for srv in configured:
        info = live_map.get(srv["name"], {})
        if not srv.get("enabled", True):
            live_status = "disabled"
        else:
            live_status = info.get("status", "unknown")
        merged.append({
            **srv,
            "status": live_status,
            "tool_count": info.get("tool_count", 0),
            "tools": info.get("tools", []),
        })
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "servers": merged,
                "path": str(app.mcp_settings_store.path),
                "revision": revision,
            },
        )
    )


@handler("mcp.save_servers")
async def mcp_save_servers(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    servers_raw = payload.get("servers", [])
    expected_raw = payload.get("expected_revision")
    if expected_raw is None:
        expected_revision = None
    elif isinstance(expected_raw, (str, int)) and not isinstance(expected_raw, bool):
        try:
            expected_revision = int(expected_raw)
        except ValueError:
            expected_revision = None
    else:
        expected_revision = None
    if expected_raw is not None and expected_revision is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_VALIDATION_ERROR",
                "expected_revision must be an integer revision string",
                {"field": "expected_revision"},
            )
        )
        return
    try:
        servers = app.mcp_settings_store.replace_servers(
            servers_raw,
            expected_revision=expected_revision,
        )
    except MCPSettingsConflictError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_SETTINGS_CONFLICT",
                str(err),
                {
                    "expected_revision": str(err.expected_revision),
                    "actual_revision": str(err.actual_revision),
                    "path": str(app.mcp_settings_store.path),
                },
            )
        )
        return
    except ValidationError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MCP_VALIDATION_ERROR", str(err))
        )
        return
    except MCPSettingsError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_SETTINGS_INVALID",
                str(err),
                {"path": str(app.mcp_settings_store.path)},
            )
        )
        return
    await app.mcp_manager.reload(app.mcp_settings_store.path)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "servers": servers,
                "revision": str(app.mcp_settings_store.revision),
            },
        )
    )


# ── Managed Skills (skills.*) ────────────────────────────────────────────────
async def _run_skill_operation(
    session: "Session",
    msg_id: str,
    msg_type: str,
    operation: Callable[..., dict[str, Any]],
    *args: Any,
    name: str = "",
    expected_revision: Any = None,
) -> dict[str, Any] | None:
    try:
        return await asyncio.to_thread(operation, *args)
    except SkillNotFoundError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "SKILL_NOT_FOUND",
                str(err),
                {"name": name},
            )
        )
    except SkillConflictError as err:
        from . import app

        details = {"name": name, "expected_revision": expected_revision}
        try:
            current = await asyncio.to_thread(app.skills_store.get_skill, name)
            details["actual_revision"] = current["skill"]["revision"]
        except SkillsStoreError:
            pass
        await session.send_json(
            make_error(msg_id, msg_type, "SKILL_CONFLICT", str(err), details)
        )
    except SkillValidationError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "SKILL_VALIDATION_ERROR",
                str(err),
                {"name": name},
            )
        )
    except SkillsStoreError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "SKILLS_STORE_ERROR",
                str(err),
                {"name": name},
            )
        )
    return None


@handler("skills.list")
async def skills_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await _run_skill_operation(
        session, msg_id, msg_type, app.skills_store.list_skills
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.get")
async def skills_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session, msg_id, msg_type, app.skills_store.get_skill, name, name=name
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.create")
async def skills_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.create_skill,
        name,
        payload.get("description", ""),
        name=name,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.save")
async def skills_save(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "")
    expected_revision = payload.get("expected_revision")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.save_skill,
        name,
        payload.get("fields", {}),
        payload.get("body", ""),
        expected_revision,
        name=name,
        expected_revision=expected_revision,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.set_enabled")
async def skills_set_enabled(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.set_enabled,
        name,
        payload.get("enabled"),
        name=name,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.delete")
async def skills_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session, msg_id, msg_type, app.skills_store.delete_skill, name, name=name
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


# ── Recent workspaces (workspace.*) ─────────────────────────────────────────
@handler("workspace.list_recent")
async def workspace_list_recent(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # list() reads the JSON file and os.path.isdir()s every recent path; a stale
    # or slow path would block the event loop. Offload it like the other fs
    # handlers so it can't stall other requests.
    recent = await asyncio.to_thread(app.recent_workspaces_store.list)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "recent": recent,
                "path": str(app.recent_workspaces_store.path),
            },
        )
    )


@handler("workspace.touch")
async def workspace_touch(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.recent_workspaces_store.touch(
        payload["path"],
        state=payload.get("state", ""),
        task=payload.get("task", ""),
    )
    recent = app.recent_workspaces_store.list()
    await session.send_json(
        make_response(msg_id, msg_type, {"recent": recent})
    )
    await app.broadcast(
        make_event("workspace.recent_changed", {"recent": recent, "reason": "touch"})
    )


@handler("workspace.pin")
async def workspace_pin(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.recent_workspaces_store.pin(payload["path"])
    recent = app.recent_workspaces_store.list()
    await session.send_json(
        make_response(msg_id, msg_type, {"recent": recent})
    )
    await app.broadcast(
        make_event("workspace.recent_changed", {"recent": recent, "reason": "pin"})
    )


@handler("workspace.unpin")
async def workspace_unpin(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.recent_workspaces_store.unpin(payload["path"])
    recent = app.recent_workspaces_store.list()
    await session.send_json(
        make_response(msg_id, msg_type, {"recent": recent})
    )
    await app.broadcast(
        make_event("workspace.recent_changed", {"recent": recent, "reason": "unpin"})
    )


@handler("workspace.remove")
async def workspace_remove(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.recent_workspaces_store.remove(payload["path"])
    recent = app.recent_workspaces_store.list()
    await session.send_json(
        make_response(msg_id, msg_type, {"recent": recent})
    )
    await app.broadcast(
        make_event("workspace.recent_changed", {"recent": recent, "reason": "remove"})
    )


# ── UI settings (generic KV store, localStorage replacement) ────────────────
@handler("ui.settings.get")
async def ui_settings_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(
        make_response(msg_id, msg_type, {"settings": app.ui_settings_store.get()})
    )


@handler("ui.settings.set")
async def ui_settings_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updates = payload.get("updates")
    delta = app.ui_settings_store.set(updates) if isinstance(updates, dict) else {}
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    if delta:
        # Other windows (EditorWindow, roles/stages) hold their own ws
        # connections — broadcast the merged delta so their caches
        # converge; the sender already applied it locally.
        await app.broadcast(
            make_event("ui.settings_changed", {"settings": delta}),
            exclude=session,
        )


# ── Settings bundle / metadata (settings.*) ─────────────────────────────────
@handler("settings.paths")
async def settings_paths(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(make_response(msg_id, msg_type, {"paths": app._settings_paths()}))


@handler("settings.bundle.export")
async def settings_bundle_export(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    try:
        bundle = app._settings_bundle()
    except MCPSettingsError as err:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "MCP_SETTINGS_INVALID",
                str(err),
                {"path": str(app.mcp_settings_store.path)},
            )
        )
        return
    await session.send_json(make_response(msg_id, msg_type, {"bundle": bundle}))


@handler("settings.bundle.import")
async def settings_bundle_import(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    bundle = payload.get("bundle") if isinstance(payload.get("bundle"), dict) else payload
    if not isinstance(bundle, dict):
        await session.send_json(make_error(msg_id, msg_type, "INVALID_BUNDLE", "settings bundle must be an object"))
        return
    applied: list[str] = []
    if isinstance(bundle.get("roles"), list):
        roles = app.roles_store.replace_all(bundle["roles"])
        applied.append("roles")
        await app.broadcast(make_event("roles.changed", {"roles": roles, "reason": "bundle_import"}))
    if isinstance(bundle.get("pipelines_document"), dict):
        app.stages_store.replace_document(bundle["pipelines_document"])
        pipelines = app.stages_store.list_pipelines()
        active_id = app.stages_store.get_active_pipeline_id()
        applied.append("pipelines")
        await app.broadcast(make_event("pipelines.changed", {
            "pipelines": pipelines,
            "active_pipeline_id": active_id,
            "reason": "bundle_import",
        }))
        await app.broadcast(make_event("stages.changed", {
            "stages": app.stages_store.list(active_id),
            "pipeline_id": active_id,
            "reason": "bundle_import",
        }))
    if isinstance(bundle.get("mcp_servers"), list):
        incoming_servers = bundle["mcp_servers"]
        if not all(isinstance(server, dict) for server in incoming_servers):
            await session.send_json(
                make_error(
                    msg_id,
                    msg_type,
                    "MCP_VALIDATION_ERROR",
                    "mcp_servers must contain only server objects",
                )
            )
            return
        try:
            existing_servers = app.mcp_settings_store.list_servers()
            restored_servers = restore_mcp_server_secrets(
                incoming_servers,
                existing_servers,
            )
            app.mcp_settings_store.replace_servers(restored_servers)
        except ValidationError as err:
            await session.send_json(
                make_error(msg_id, msg_type, "MCP_VALIDATION_ERROR", str(err))
            )
            return
        except MCPSettingsError as err:
            await session.send_json(
                make_error(
                    msg_id,
                    msg_type,
                    "MCP_SETTINGS_INVALID",
                    str(err),
                    {"path": str(app.mcp_settings_store.path)},
                )
            )
            return
        await app.mcp_manager.reload(app.mcp_settings_store.path)
        applied.append("mcp")
    if isinstance(bundle.get("analyzer"), dict):
        updated = app.analyzer_settings_store.set(bundle["analyzer"])
        applied.append("analyzer")
        await app.broadcast(make_event("analyzer.settings_changed", updated))
    if isinstance(bundle.get("ai_chat"), dict):
        safe_chat = {
            k: v for k, v in bundle["ai_chat"].items()
            if k not in app._AI_SECRET_KEYS and v != "__redacted__"
        }
        if safe_chat:
            app.ai_chat_settings_store.set(safe_chat)
            applied.append("ai_chat")
    await session.send_json(make_response(msg_id, msg_type, {
        "ok": True,
        "applied": applied,
        "paths": app._settings_paths(),
    }))


# ── Roles registry (roles.*) ────────────────────────────────────────────────
@handler("roles.list")
async def roles_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"roles": app.roles_store.list(), "path": str(app.roles_store.path)},
        )
    )


@handler("roles.upsert")
async def roles_upsert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    role = app.roles_store.upsert(
        key=payload["key"],
        label=payload.get("label", ""),
        one_line=payload.get("one_line", ""),
        system_prompt=payload.get("system_prompt", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, {"role": role, "roles": app.roles_store.list()})
    )
    await app.broadcast(
        make_event("roles.changed", {"roles": app.roles_store.list(), "reason": "upsert"})
    )


@handler("roles.delete")
async def roles_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    roles = app.roles_store.delete(payload["key"])
    await session.send_json(
        make_response(msg_id, msg_type, {"roles": roles})
    )
    await app.broadcast(
        make_event("roles.changed", {"roles": roles, "reason": "delete"})
    )


@handler("roles.reset")
async def roles_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    roles = app.roles_store.reset()
    await session.send_json(
        make_response(msg_id, msg_type, {"roles": roles})
    )
    await app.broadcast(
        make_event("roles.changed", {"roles": roles, "reason": "reset"})
    )


# ── Pipelines registry (pipelines.*) ────────────────────────────────────────
@handler("pipelines.list")
async def pipelines_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipelines = app.stages_store.list_pipelines()
    active_id = app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"pipelines": pipelines, "active_pipeline_id": active_id, "path": str(app.stages_store.path)},
        )
    )


@handler("pipelines.create")
async def pipelines_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    name = payload.get("name", "New Pipeline")
    pipeline = app.stages_store.create_pipeline(name)
    pipelines = app.stages_store.list_pipelines()
    await session.send_json(
        make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": "create",
    }))


@handler("pipelines.rename")
async def pipelines_rename(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id", "")
    name = payload.get("name", "")
    pipeline = app.stages_store.rename_pipeline(pipeline_id, name)
    pipelines = app.stages_store.list_pipelines()
    await session.send_json(
        make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": "rename",
    }))


@handler("pipelines.delete")
async def pipelines_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id", "")
    ws_path = payload.get("workspace_path", "") or ""
    if ws_path:
        proj = app.project_store.peek(ws_path)
        if proj and proj.state == "running":
            await session.send_json(
                make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot delete pipeline while a project is running")
            )
            return
    pipelines = app.stages_store.delete_pipeline(pipeline_id)
    await session.send_json(
        make_response(msg_id, msg_type, {"pipelines": pipelines})
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": "delete",
    }))


@handler("pipelines.set_active")
async def pipelines_set_active(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id", "")
    ws_path = payload.get("workspace_path", "") or ""
    if ws_path:
        proj = app.project_store.peek(ws_path)
        if proj and proj.state == "running":
            await session.send_json(
                make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot switch pipeline while a project is running")
            )
            return
    app.stages_store.set_active_pipeline(pipeline_id)
    pipelines = app.stages_store.list_pipelines()
    await session.send_json(
        make_response(msg_id, msg_type, {
            "active_pipeline_id": pipeline_id,
            "pipelines": pipelines,
        })
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": pipeline_id,
        "reason": "set_active",
    }))


@handler("pipelines.reset_builtin")
async def pipelines_reset_builtin(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id", "")
    pipeline = app.stages_store.reset_builtin(pipeline_id)
    pipelines = app.stages_store.list_pipelines()
    stages = app.stages_store.list(pipeline_id)
    await session.send_json(
        make_response(msg_id, msg_type, {"pipeline": pipeline, "pipelines": pipelines})
    )
    await app.broadcast(make_event("pipelines.changed", {
        "pipelines": pipelines,
        "active_pipeline_id": app.stages_store.get_active_pipeline_id(),
        "reason": "reset_builtin",
    }))
    await app.broadcast(make_event("stages.changed", {
        "stages": stages,
        "pipeline_id": pipeline_id,
        "reason": "reset_builtin",
    }))


# ── Stages registry (stages.*) ──────────────────────────────────────────────
@handler("stages.list")
async def stages_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    stages = app.stages_store.list(pipeline_id)
    active_id = app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"stages": stages, "path": str(app.stages_store.path), "pipeline_id": pipeline_id or active_id},
        )
    )


@handler("stages.upsert")
async def stages_upsert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    ws_path = payload.get("workspace_path", "") or ""
    if ws_path and not pipeline_id:
        # Check running guard for active pipeline
        proj = app.project_store.peek(ws_path)
        if proj and proj.state == "running":
            await session.send_json(
                make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot edit stages while the active pipeline is running")
            )
            return
    stage = app.stages_store.upsert(payload["stage"], pipeline_id)
    effective_pipeline_id = pipeline_id or app.stages_store.get_active_pipeline_id()
    updated_stages = app.stages_store.list(pipeline_id)
    await session.send_json(
        make_response(msg_id, msg_type, {"stage": stage, "stages": updated_stages})
    )
    await app.broadcast(make_event("stages.changed", {
        "stages": updated_stages,
        "pipeline_id": effective_pipeline_id,
        "reason": "upsert",
    }))


@handler("stages.reorder")
async def stages_reorder(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    ws_path = payload.get("workspace_path", "") or ""
    if ws_path and not pipeline_id:
        proj = app.project_store.peek(ws_path)
        if proj and proj.state == "running":
            await session.send_json(
                make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot reorder stages while the active pipeline is running")
            )
            return
    updated_stages = app.stages_store.reorder(payload["ids"], pipeline_id)
    effective_pipeline_id = pipeline_id or app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(msg_id, msg_type, {"stages": updated_stages})
    )
    await app.broadcast(make_event("stages.changed", {
        "stages": updated_stages,
        "pipeline_id": effective_pipeline_id,
        "reason": "reorder",
    }))


@handler("stages.delete")
async def stages_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    ws_path = payload.get("workspace_path", "") or ""
    if ws_path and not pipeline_id:
        proj = app.project_store.peek(ws_path)
        if proj and proj.state == "running":
            await session.send_json(
                make_error(msg_id, msg_type, "PIPELINE_RUNNING", "Cannot delete stages while the active pipeline is running")
            )
            return
    updated_stages = app.stages_store.delete(payload["id"], pipeline_id)
    effective_pipeline_id = pipeline_id or app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(msg_id, msg_type, {"stages": updated_stages})
    )
    await app.broadcast(make_event("stages.changed", {
        "stages": updated_stages,
        "pipeline_id": effective_pipeline_id,
        "reason": "delete",
    }))


@handler("stages.reset")
async def stages_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pipeline_id = payload.get("pipeline_id") or None
    updated_stages = app.stages_store.reset(pipeline_id)
    effective_pipeline_id = pipeline_id or app.stages_store.get_active_pipeline_id()
    await session.send_json(
        make_response(msg_id, msg_type, {"stages": updated_stages})
    )
    await app.broadcast(make_event("stages.changed", {
        "stages": updated_stages,
        "pipeline_id": effective_pipeline_id,
        "reason": "reset",
    }))


# ── Analyzer (local LLM / Ollama) (analyzer.*) ──────────────────────────────
@handler("analyzer.detect_llama_cli")
async def analyzer_detect_llama_cli(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    import shutil as _shutil
    candidates = [
        "llama-completion",
        "llama-cli",
        "/opt/homebrew/bin/llama-completion",
        "/opt/homebrew/bin/llama-cli",
        "/usr/local/bin/llama-completion",
        "/usr/local/bin/llama-cli",
    ]
    found = []
    for c in candidates:
        p = _shutil.which(c) or (c if __import__("os.path", fromlist=["exists"]).exists(c) else None)
        if p and p not in found:
            found.append(p)
    await session.send_json(make_response(msg_id, msg_type, {
        "found": found,
        "recommended": found[0] if found else None,
    }))


@handler("analyzer.settings.get")
async def analyzer_settings_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(
        make_response(msg_id, msg_type, app.analyzer_settings_store.get())
    )


@handler("analyzer.settings.set")
async def analyzer_settings_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updated = app.analyzer_settings_store.set(payload)
    await session.send_json(make_response(msg_id, msg_type, updated))
    await app.broadcast(make_event("analyzer.settings_changed", updated))


@handler("analyzer.health")
async def analyzer_health_h(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    data = await app.analyzer_health()
    data["default_model"] = app.ANALYZER_DEFAULT_MODEL
    data["backend"] = app._az_settings().get("backend", "llama_cpp")
    await session.send_json(make_response(msg_id, msg_type, data))


@handler("analyzer.models")
async def analyzer_models(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    models = await app.analyzer_list_models()
    await session.send_json(
        make_response(msg_id, msg_type, {"models": models, "default": app.ANALYZER_DEFAULT_MODEL})
    )


@handler("analyzer.classify")
async def analyzer_classify_h(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    text = payload.get("text", "") or ""
    model = payload.get("model") or app.ANALYZER_DEFAULT_MODEL
    # llama_cpp calls are serialised via _llama_sem (analyzer.py); if one
    # is already running, this call will queue behind it for up to 60s.
    # Tell the frontend now so it shows "queued" instead of looking hung.
    if not app._az_is_ollama() and app._llama_cli_busy():
        await app.broadcast(make_event("analyzer.queued", {
            "pane_id": payload.get("pane_id") or "",
            "stage_id": payload.get("stage_id") or "",
            "workspace_path": payload.get("workspace_path") or "",
        }))
    result = await app.analyzer_classify(text, model)
    app._record_analyzer_tokens(result, payload)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("analyzer.benchmark")
async def analyzer_benchmark_h(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    async def _benchmark_bg() -> None:
        async def _on_progress(
            model: str, task_id: str, passed: bool, elapsed_s: float, score: int
        ) -> None:
            await app.broadcast(make_event("analyzer.benchmark_progress", {
                "model": model, "task_id": task_id,
                "passed": passed, "elapsed_s": elapsed_s, "score": score,
            }))
        try:
            results = await app.analyzer_benchmark(progress_cb=_on_progress)
            await app.broadcast(make_event("analyzer.benchmark_done", {"results": results}))
        except Exception as _bench_err:  # noqa: BLE001
            app.log.warning("benchmark error: %s", _bench_err)
            await app.broadcast(make_event("analyzer.benchmark_done", {"results": [], "error": str(_bench_err)}))

    asyncio.create_task(_benchmark_bg())
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))


@handler("analyzer.pull")
async def analyzer_pull(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Only valid in Ollama mode.
    model_name = payload.get("name", "")
    if not model_name:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": "name required"})
        )
    elif not app._az_is_ollama():
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": "pull only available in Ollama mode"})
        )
    else:
        async def _pull_bg(name: str = model_name) -> None:
            try:
                async for progress in app._ollama_pull_model(name, app._az_base_url()):
                    await app.broadcast(make_event("analyzer.pull_progress", {"name": name, **progress}))
                await app.broadcast(make_event("analyzer.pull_done", {"name": name, "ok": True}))
            except Exception as _pull_err:
                await app.broadcast(make_event("analyzer.pull_done", {"name": name, "ok": False, "error": str(_pull_err)}))

        asyncio.create_task(_pull_bg())
        await session.send_json(make_response(msg_id, msg_type, {"ok": True, "started": True}))


@handler("analyzer.delete")
async def analyzer_delete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    model_name = payload.get("name", "")
    if not model_name:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": "name required"})
        )
    elif not app._az_is_ollama():
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": "delete only available in Ollama mode"})
        )
    else:
        result = await app._ollama_delete_model(model_name, app._az_base_url())
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("analyzer.ollama_health")
async def analyzer_ollama_health(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    data = await app._ollama_health(app._az_base_url())
    await session.send_json(make_response(msg_id, msg_type, data))


# ── Token stats (tokens.*) ──────────────────────────────────────────────────
@handler("tokens.snapshot")
async def tokens_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    snap = app.tokens_store.snapshot(payload.get("workspace_path") or None)
    await session.send_json(make_response(msg_id, msg_type, snap))


@handler("tokens.reset")
async def tokens_reset(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    scope = payload.get("scope", "run")
    snap = app.tokens_store.reset(scope, payload.get("workspace_path") or None)
    await session.send_json(make_response(msg_id, msg_type, snap))
    await app.broadcast(make_event("tokens.changed", snap))


# ── Pipeline history (timeline) (history.*) ─────────────────────────────────
@handler("history.snapshot")
async def history_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    # Resolve the active run's folder so the timeline scopes to it.
    _proj = app.project_store.peek(ws_path) if ws_path else None
    _log_name = _proj.log_file_name if _proj else ""
    run_dir = _log_name.rsplit("/", 1)[0] if "/" in _log_name else ""
    snap = app.history_store.snapshot(ws_path, run_dir, int(payload.get("limit", 500)))
    await session.send_json(make_response(msg_id, msg_type, snap))


# ── Cloud issues (issues.*) ─────────────────────────────────────────────────
# GitHub via gh / GitLab via glab, host auto-detected from origin remote.
# No git.changed broadcast — issues are remote state, not local repo state.
@handler("issues.provider")
async def issues_provider(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    result = await app.issue_service.detect_provider(ws_path)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.list")
async def issues_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    limit = payload.get("limit") or 30
    result = await app.issue_service.list_issues(ws_path, limit)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.get")
async def issues_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    number = payload.get("number")
    result = await app.issue_service.get_issue(ws_path, number)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.create")
async def issues_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    title = payload.get("title") or ""
    body = payload.get("body") or ""
    result = await app.issue_service.create_issue(ws_path, title, body)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.comment")
async def issues_comment(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    number = payload.get("number")
    body = payload.get("body") or ""
    result = await app.issue_service.comment_issue(ws_path, number, body)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("issues.set_state")
async def issues_set_state(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    number = payload.get("number")
    state = payload.get("state") or ""
    result = await app.issue_service.set_issue_state(ws_path, number, state)
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Shell run (shell.run) ───────────────────────────────────────────────────
# Security notes:
# - Uses create_subprocess_exec('/bin/sh', '-c', cmd) instead of
#   create_subprocess_shell to avoid implicit shell injection.
# - ws_path is resolved and validated to be an existing directory.
# - Frontend shows full command in confirm dialog before invoking.
# - This is a local-only Electron app; the WebSocket server binds to
#   localhost only, reducing (but not eliminating) external attack surface.
@handler("shell.run")
async def shell_run(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    cmd = payload.get("command", "") or ""
    if not cmd:
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "no command"}))
    else:
        resolved_cwd = app.Path(ws_path).resolve() if ws_path else None
        # Validate that cwd is a known registered workspace (or its subdirectory)
        known_roots = [app.Path(w).resolve() for w in app.attribution.known_workspaces()]
        cwd_allowed = resolved_cwd is None or any(
            resolved_cwd == r or resolved_cwd.is_relative_to(r)
            for r in known_roots
        )
        if not cwd_allowed:
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path not registered"}))
        elif resolved_cwd and not resolved_cwd.is_dir():
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "invalid workspace path"}))
        else:
            try:
                proc = await asyncio.create_subprocess_exec(
                    "/bin/sh", "-c", cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=str(resolved_cwd) if resolved_cwd else None,
                )
                try:
                    stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
                    output = stdout.decode("utf-8", errors="replace")
                    await session.send_json(make_response(msg_id, msg_type, {
                        "ok": True, "output": output[:8000], "exit_code": proc.returncode,
                    }))
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.communicate()
                    await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "timeout after 30s"}))
            except Exception as exc:
                await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(exc)}))


# ── Onboarding (onboarding.*) ───────────────────────────────────────────────
@handler("onboarding.status")
async def onboarding_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    loop = asyncio.get_running_loop()
    status = await loop.run_in_executor(
        _ONBOARDING_EXECUTOR, app.onboarding_deps.get_status
    )
    status["complete"] = app.onboarding_deps.is_complete()
    status["skip"] = app.onboarding_deps.should_skip()
    await session.send_json(make_response(msg_id, msg_type, status))


@handler("onboarding.install")
async def onboarding_install(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    dep_id = payload.get("dep_id", "") or ""
    result = await asyncio.to_thread(app.onboarding_deps.install_dep, dep_id)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.pull_model")
async def onboarding_pull_model(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    model = payload.get("model", "") or app.onboarding_deps._SUGGESTED_MODEL
    # Offloaded: the reachability check shells out to `ollama list`.
    result = await asyncio.to_thread(app.onboarding_deps.pull_model, model)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.start_ollama")
async def onboarding_start_ollama(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await asyncio.to_thread(app.onboarding_deps.start_ollama_service)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.complete")
async def onboarding_complete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.onboarding_deps.set_complete(bool(payload.get("complete", True)))
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("onboarding.install_prompt")
async def onboarding_install_prompt(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Silence (or restore) the guided-install prompt for one CLI."""
    from . import app

    result = app.onboarding_deps.set_install_prompt_dismissed(
        str(payload.get("dep_id") or ""),
        bool(payload.get("dismissed", True)),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.cli_health.dismiss")
async def onboarding_cli_health_dismiss(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.onboarding_deps.dismiss_cli_health(str(payload.get("fingerprint") or ""))
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("onboarding.cli_maintenance")
async def onboarding_cli_maintenance(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = app.onboarding_deps.maintenance_command(
        str(payload.get("agent_key") or ""),
        str(payload.get("action") or ""),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.cli_autoupdate")
async def onboarding_cli_autoupdate(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = app.onboarding_deps.set_cli_autoupdate_policy(
        str(payload.get("agent_key") or ""),
        str(payload.get("policy") or ""),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.cli_health.select_binary")
async def onboarding_cli_health_select_binary(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = app.onboarding_deps.select_cli_binary(
        str(payload.get("agent_key") or ""),
        str(payload.get("path") or ""),
        str(payload.get("fingerprint") or ""),
    )
    await session.send_json(make_response(msg_id, msg_type, result))


# ── AI settings + review (ai.chat.settings.*, ai.review.*) ───────────────────
# ai.chat.settings.* outlives the removed AI chat: review and
# git.generate_message still read the shared system prompt from it.
@handler("ai.chat.settings.get")
async def ai_chat_settings_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(make_response(msg_id, msg_type, app.ai_chat_settings_store.get()))


@handler("ai.chat.settings.set")
async def ai_chat_settings_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updated = app.ai_chat_settings_store.set(payload)
    await session.send_json(make_response(msg_id, msg_type, updated))


@handler("ai.review.stop")
async def ai_review_stop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    for t in list(session._review_tasks):
        t.cancel()
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("ai.review.start")
async def ai_review_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Cancel any in-progress review before starting a new one.
    for _t in list(session._review_tasks):
        _t.cancel()
    session._review_tasks.clear()
    ws_path = payload.get("workspace_path") or ""
    review_id = payload.get("review_id") or str(__import__("uuid").uuid4())
    mode = payload.get("mode") or "working"  # "working" | "branch"
    base = payload.get("base") or ""
    compare = payload.get("compare") or ""

    async def _run_review(rid=review_id, m=mode, b=base, c=compare, ws=ws_path):
        import re as _re
        import json as _json
        from .review_service import stream_review
        try:
            await app._ensure_fresh_path_for_spawn("claude")
            if m == "branch":
                _b = b or "main"
                if not c:
                    _rc, _cur, _ = await app.git_service._run(
                        ["git", "rev-parse", "--abbrev-ref", "HEAD"], ws
                    )
                    _c = _cur.strip() if _rc == 0 and _cur.strip() else "HEAD"
                else:
                    _c = c
                diff_result = await app.git_service.diff_branches(ws, _b, _c)
                diff = diff_result.get("diff", "") if diff_result.get("ok") else ""
            else:
                # working mode: staged + unstaged (git diff HEAD)
                diff_result = await app.git_service.diff_branches(ws, "", "")
                diff = diff_result.get("diff", "") if diff_result.get("ok") else ""
            _truncated = diff_result.get("truncated", False) if diff_result.get("ok") else False
            chunks: list[str] = []
            async for chunk in stream_review(diff, truncated=_truncated, workspace_path=ws):
                chunks.append(chunk)
            # Parse and validate structured JSON result from streamed text
            full_text = "".join(chunks)
            try:
                # Use raw_decode so it stops at the matching closing brace,
                # handling both: (a) embedded ```fences``` inside JSON string
                # values (where .*? would truncate) and (b) multiple JSON
                # blocks in the output (where .* would merge them).
                _fence_mo = _re.search(r"```json\s*", full_text)
                raw = None
                if _fence_mo:
                    try:
                        raw, _ = _json.JSONDecoder().raw_decode(
                            full_text[_fence_mo.end():].lstrip()
                        )
                    except _json.JSONDecodeError:
                        raw = None
                if raw:
                    _VALID_VERDICTS = {"approve", "approve_with_comments", "request_changes"}
                    _VALID_SEVS = {"critical", "warning", "suggestion"}
                    validated: dict = {
                        "summary": str(raw.get("summary", "")),
                        "verdict": raw.get("verdict") if raw.get("verdict") in _VALID_VERDICTS else "approve_with_comments",
                        "findings": [],
                    }
                    for _i, _f in enumerate(raw.get("findings") or []):
                        if not isinstance(_f, dict):
                            continue
                        validated["findings"].append({
                            "id": str(_f.get("id") or f"f{_i}"),
                            "file": str(_f.get("file") or ""),
                            "line": _f["line"] if isinstance(_f.get("line"), int) else None,
                            "severity": _f.get("severity") if _f.get("severity") in _VALID_SEVS else "suggestion",
                            "title": str(_f.get("title") or ""),
                            "body": str(_f.get("body") or ""),
                        })
                    await app.broadcast(make_event("ai.review.result", {"review_id": rid, "result": validated}))
                else:
                    app.log.warning("ai.review: no ```json block found in LLM output")
            except Exception:
                app.log.warning("ai.review: failed to parse JSON from streamed output")
            await app.broadcast(make_event("ai.review.end", {"review_id": rid}))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            app.log.exception("ai.review.start failed: %s", exc)
            await app.broadcast(make_event("ai.review.error", {"review_id": rid, "message": str(exc)}))

    task = asyncio.create_task(_run_review())
    session._review_tasks.add(task)
    task.add_done_callback(session._review_tasks.discard)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "review_id": review_id}))


# ── ping ─────────────────────────────────────────────────────────────────────
@handler("ping")
async def ping(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await session.send_json(
        make_response(msg_id, msg_type, {"pong": True, "echo": payload})
    )


# ── Terminals (terminal.*) ───────────────────────────────────────────────────
@handler("terminal.create")
async def terminal_create(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    pane_id = str(payload["pane_id"])
    generation = str(payload.get("create_generation") or msg_id)
    key = (pane_id, generation)
    gate = session._terminal_create_gates.setdefault(pane_id, asyncio.Lock())
    async with gate:
        existing = session._terminal_create_transactions.get(key)
        if existing and existing.get("committed"):
            app._PTY_OWNERS[existing["term_id"]] = session
            await session.send_json(
                make_response(msg_id, msg_type, existing["response_payload"])
            )
            return
        if key in session._terminal_create_tombstones:
            await session.send_json(
                make_error(
                    msg_id,
                    msg_type,
                    "CREATE_CANCELLED",
                    "terminal create was cancelled",
                    {"pane_id": pane_id, "create_generation": generation},
                )
            )
            return

        transaction: dict[str, Any] = {
            "pane_id": pane_id,
            "generation": generation,
            "cancelled": False,
            "committed": False,
            "term_id": "",
            "attribution_future": None,
            "attribution_started": False,
            "cleanup_task": None,
        }
        session._terminal_create_transactions[key] = transaction
        try:
            await _terminal_create_impl(
                session, msg_id, msg_type, payload, transaction, generation
            )
        except asyncio.CancelledError:
            await _rollback_terminal_create(session, transaction)
            raise
        except _TerminalCreateCancelled:
            await _rollback_terminal_create(session, transaction)
            if not session.dead:
                await session.send_json(
                    make_error(
                        msg_id,
                        msg_type,
                        "CREATE_CANCELLED",
                        "terminal create was cancelled",
                        {"pane_id": pane_id, "create_generation": generation},
                    )
                )
        except BaseException:
            await _rollback_terminal_create(session, transaction)
            session._terminal_create_transactions.pop(key, None)
            raise


class _TerminalCreateCancelled(Exception):
    pass


async def _rollback_terminal_create(
    session: "Session", transaction: dict[str, Any]
) -> None:
    async def cleanup() -> None:
        from . import app

        attribution_future = transaction.get("attribution_future")
        if attribution_future is not None:
            try:
                await asyncio.shield(attribution_future)
            except Exception:  # noqa: BLE001
                pass
        if transaction.get("attribution_started"):
            # register_pane runs in an executor and keeps running if its asyncio
            # waiter is cancelled.  Queue unregister behind it and await the
            # shared attribution lock so a late registration cannot revive.
            try:
                await asyncio.to_thread(
                    app.attribution.unregister_pane, transaction["pane_id"]
                )
            except Exception as err:  # noqa: BLE001
                app.log.warning("terminal create attribution rollback failed: %s", err)
        term_id = str(transaction.get("term_id") or "")
        if term_id:
            if app._PTY_OWNERS.get(term_id) is session:
                app._PTY_OWNERS.pop(term_id, None)
            await session.terminals.kill(term_id, force=True)

    cleanup_task = transaction.get("cleanup_task")
    if cleanup_task is None:
        cleanup_task = asyncio.create_task(cleanup())
        transaction["cleanup_task"] = cleanup_task
    await asyncio.shield(cleanup_task)


async def _terminal_create_impl(
    session: "Session",
    msg_id: str,
    msg_type: str,
    payload: dict,
    transaction: dict[str, Any],
    generation: str,
) -> None:
    from . import app

    metadata = payload.get("metadata") or {}
    agent_key = payload.get("agent_key") or ""
    env = dict(payload.get("env") or {})
    await app._ensure_fresh_path_for_spawn(agent_key)
    payload["command"] = app._command_with_persisted_cli_binary(
        agent_key, payload.get("command")
    )
    payload["command"] = app._command_with_installed_cli_alias(
        agent_key, payload.get("command")
    )
    try:
        startup_probe = await asyncio.get_running_loop().run_in_executor(
            _CLI_PROBE_EXECUTOR,
            app._probe_agent_cli_for_spawn, agent_key, payload.get("command"),
        )
    except app.AgentCliProbeError as probe_error:
        # A CLI that simply is not installed is not an error the user can act on
        # from a dead pane full of red text — tell the window so it can open the
        # guided install. The error still propagates and cancels the spawn.
        if probe_error.details.get("reason") == "not_found":
            dep = app.onboarding_deps.DEPS_BY_ID.get(agent_key)
            await session.send_json(make_event("cli.missing", {
                "agent_key": agent_key,
                "label": dep.label if dep else agent_key,
                "pane_id": str(payload.get("pane_id") or ""),
                "reason": "not_found",
            }))
        raise
    if startup_probe:
        metadata["startup_probe"] = startup_probe
    # The vendor's own auto-update switch, only when the user opted out of it.
    env.update(app.onboarding_deps.spawn_env_for(agent_key))
    # CLI accounts share the real home — regular spawns get no profile env
    # isolation (sessions and settings are global; profiles only swap
    # credentials, so the active account's secret already sits in the live
    # location). The one account-driven exception is a LOGIN pane
    # (login_profile_id set): it runs the CLI inside the profile's isolated
    # login home, so completing the login never touches the live credentials
    # or any running pane; the usage poller later harvests the home into the
    # profile's slot (see credential_vault.harvest_login_home).
    env_remove: list[str] | None = None
    login_profile_id = str(payload.get("login_profile_id") or "")
    if login_profile_id:
        profile = app.cli_profiles_store.get(login_profile_id)
        if (
            agent_key not in PROFILE_AGENT_KEYS
            or profile is None
            or profile.get("agentKey") != agent_key
        ):
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST",
                    f"invalid login profile for agent {agent_key!r}: {login_profile_id}",
                )
            )
            return
        login_set, login_remove = await asyncio.to_thread(
            app.credential_vault.login_spawn_env, agent_key, login_profile_id
        )
        env.update(login_set)
        env_remove = login_remove or None
        # Mark the terminal as an isolated LOGIN pane: it cannot touch the
        # live credentials, and the login-home harvest (on account switch)
        # must wait for it to exit (see _running_login_terminals).
        metadata["login_profile_id"] = login_profile_id
        # Run the CLI's direct sign-in trigger (e.g. `claude auth login`) so
        # the browser authorization opens by itself — the user never types a
        # command in the login pane.
        payload["command"] = app._login_spawn_command(agent_key, payload["command"])
    if agent_key == "codex" and not login_profile_id:
        # Compatibility: `codex resume <id>` only works inside the home
        # that recorded the session. Resume in whichever home owns it;
        # only unknown/fresh sessions get a (new) per-pane home.
        resume_id = app._codex_resume_id(payload.get("command"))
        session_home = (
            await asyncio.to_thread(app.codex_home_manager.find_session_home, resume_id)
            if resume_id
            else None
        )
        if session_home is None:
            home_id = str(metadata.get("session_home_id") or payload["pane_id"])
            codex_home = await asyncio.to_thread(
                app.codex_home_manager.prepare,
                home_id,
            )
            env["CODEX_HOME"] = str(codex_home)
            metadata["session_home_id"] = home_id
        elif session_home != app.codex_home_manager.real_home:
            env["CODEX_HOME"] = str(session_home)
            metadata["session_home_id"] = session_home.name
        # else: session lives in the real ~/.codex — resume with the
        # default env so codex can find it.
    if not login_profile_id:
        # Run plugin-registered spawn transformers over the command (e.g. the
        # builtin navide.plans plugin appends Plan-MCP flags for claude/codex);
        # no-op with no plugins, and a failing transformer never breaks a spawn.
        # env is passed last and mutated in place: CLIs with no additive MCP
        # flag take their wiring through a variable instead, and it is settled
        # by this point (CODEX_HOME above is the last writer).
        payload["command"] = await asyncio.to_thread(
            app.plugin_wiring.apply_spawn_wiring,
            app.plugin_host,
            agent_key,
            payload["command"],
            str(payload.get("pane_id") or ""),
            env,
        )
    if transaction["cancelled"]:
        raise _TerminalCreateCancelled
    # The pane's previous PTY, when this create replaces it (restore/rebuild).
    # Resume-id dedup below can't catch it: a CLI rewrites its session id on
    # every resume, so across restores the ids never match and the old PTY
    # would linger ownerless forever. Pane identity is stable — use it, but
    # only kill a PTY that really belongs to this pane (frontend-bug guard).
    replaces_tid = str(payload.get("replaces_terminal_id") or "")
    if replaces_tid:
        create_pane_id = str(payload["pane_id"])
        stale = session.terminals.get(replaces_tid)
        if stale is not None and not stale.closed:
            # Kill only the pane's own predecessor (same pane id — rebuild) or
            # an ownerless leftover (pane ids regenerate across restores, but
            # a predecessor with no owning WebSocket can't be anyone's live
            # pane). A PTY another window still owns is never touched.
            if stale.pane_id == create_pane_id or stale.id not in app._PTY_OWNERS:
                app.log.info(
                    "terminal.create: reaping replaced PTY %s for pane %s",
                    replaces_tid,
                    create_pane_id,
                )
                await session.terminals.kill(replaces_tid, force=True)
            else:
                app.log.warning(
                    "terminal.create: replaces_terminal_id %s is another live "
                    "pane's PTY (pane %s, not %s) — refusing to kill",
                    replaces_tid,
                    stale.pane_id,
                    create_pane_id,
                )
    # One live CLI per resume id: a --resume spawn can race a still-live PTY
    # resuming the same session (cross-window restore, cleared localStorage —
    # tryReattach only sees the spawning window's own PTY id), leaving two
    # CLIs appending to one session file. Reap the survivor first.
    resume_dedup_id = app._resume_id_for_agent(agent_key, payload.get("command"))
    if resume_dedup_id:
        for stale in session.terminals.find_live_by_resume_id(
            agent_key,
            resume_dedup_id,
            lambda cmd: app._resume_id_for_agent(agent_key, cmd),
        ):
            app.log.info(
                "terminal.create: reaping stale PTY %s resuming %s/%s",
                stale.id,
                agent_key,
                resume_dedup_id,
            )
            await session.terminals.kill(stale.id, force=True)
    def _spawn_and_claim() -> Any:
        term = session.terminals.create(
            pane_id=payload["pane_id"],
            agent_key=agent_key,
            command=payload["command"],
            cwd=payload["cwd"],
            cols=int(payload.get("cols", 100)),
            rows=int(payload.get("rows", 30)),
            env=env or None,
            env_remove=env_remove,
            metadata=metadata,
            output_log_file=payload.get("output_log_file") or "",
        )
        transaction["term_id"] = term.id
        # Claim immediately. A CLI can die while attribution registration is
        # still running; its terminal.exit must still reach this renderer.
        app._PTY_OWNERS[term.id] = session
        return term

    if agent_key in PROFILE_AGENT_KEYS and not login_profile_id:
        # A regular pane of a profile agent starts on the live credentials —
        # the very state an account switch swaps. Spawning under the agent's
        # switch lock closes the quiescence gate's TOCTOU window: the pane is
        # either created and claimed in _PTY_OWNERS before the switch handler
        # takes the lock (so its gate counts the pane), or the spawn waits for
        # the swap to finish and picks up the new account's credentials. The
        # locked section is synchronous (no awaits), so the lock is held only
        # for the spawn itself; login panes run in an isolated home and other
        # agents have no profiles, so neither takes the lock.
        # Bounded acquire (_SWITCH_LOCK_TIMEOUT_SEC): if the lock is somehow
        # held forever the spawn must fail visibly instead of hanging with no
        # response and no log.
        switch_lock = app.credential_vault.switch_lock(agent_key)
        try:
            await asyncio.wait_for(
                switch_lock.acquire(), timeout=_SWITCH_LOCK_TIMEOUT_SEC
            )
        except asyncio.TimeoutError:
            app.log.warning(
                "terminal.create for %s timed out after %.0fs waiting for the "
                "credential switch lock", agent_key, _SWITCH_LOCK_TIMEOUT_SEC,
            )
            # Name both plausible causes: a wedged switch/harvest, and a
            # Keychain authorization prompt sitting unanswered (each `security`
            # call has its own 10s budget, so an unattended prompt blows this
            # ceiling). Also say the previous PTY is gone: the reap of
            # replaces_terminal_id above already ran, so a Respawn that lands
            # here has lost its old pane and must be started again by hand.
            raise RuntimeError(
                f"timed out after {_SWITCH_LOCK_TIMEOUT_SEC:.0f}s waiting for the "
                f"{agent_key} credential switch lock; an account switch or "
                "credential harvest appears to be stuck, or a Keychain "
                "authorization prompt is waiting for an answer. If this was a "
                "respawn, the previous session was already closed — start the "
                "pane again"
            ) from None
        try:
            term = _spawn_and_claim()
        finally:
            switch_lock.release()
    else:
        term = _spawn_and_claim()
    # Register the pane with the log-attribution layer so any session
    # file appearing after this point can be attributed back to us.
    # Registry membership == the 12 CLI vendors; the drift test pins the set.
    if agent_key in CLI_VENDORS:
        ws_for_pane = str(metadata.get("workspace_path") or payload["cwd"])
        # Workspace registration via helper triggers a force-rescan
        # if the workspace is newly known — so historic CLI sessions
        # in that workspace's folder appear in the panel right away.
        app._register_workspace_and_backfill(ws_for_pane)
        explicit_session_id = str(metadata.get("explicit_session_id") or "")
        # One-file-per-vendor bridge: a migrated vendor claims its resume id
        # through its spec (the why-claim rationale moves into the vendor
        # file); the elif chain below is the legacy fallback, deleted one
        # vendor at a time. Codex stays out of both paths here — its resume
        # id is claimed via the per-pane CODEX_HOME flow.
        vendor_spec = cli_vendor(agent_key)
        if (not explicit_session_id and agent_key != "codex"
                and vendor_spec is not None
                and vendor_spec.resume_id_from_command is not None):
            explicit_session_id = vendor_spec.resume_id_from_command(
                payload.get("command")
            )
        if agent_key == "claude" and not explicit_session_id:
            # Resumed Claude panes carry no pinned --session-id. Claim the
            # resume id at registration, or the unowned-session fallback
            # can hand this pane's session to a sibling in the same cwd —
            # which then overwrites that sibling's persisted resume id.
            explicit_session_id = app._claude_resume_id(payload.get("command"))
        elif agent_key == "kimi" and not explicit_session_id:
            # Resumed Kimi panes likewise: claiming the resume id up front
            # routes the session's events back to this pane and removes it
            # from the new-session single-candidate fallback's candidate set,
            # so a sibling fresh pane in the same cwd can still fallback-bind.
            explicit_session_id = app._kimi_resume_id(payload.get("command"))
        elif agent_key == "opencode" and not explicit_session_id:
            # Resumed OpenCode panes carry no marker (markers only appear in a
            # fresh kickoff), so claim the resume id from the launch command —
            # otherwise the resumed session's events can't be routed back.
            explicit_session_id = app._opencode_resume_id(payload.get("command"))
        elif agent_key == "kilo" and not explicit_session_id:
            # Resumed Kilo panes (OpenCode fork) likewise: markers only appear
            # in a fresh kickoff, so claim the resume id from the launch
            # command to route the resumed session's events back to this pane.
            explicit_session_id = app._kilo_resume_id(payload.get("command"))
        elif agent_key == "pi" and not explicit_session_id:
            # Pi's `--session-id <id>` names the pane's session whether it
            # resumes an existing id or (id unknown) creates a new one under
            # it — claim it up front like Claude's --session-id so the
            # session's events route back to this pane.
            explicit_session_id = app._pi_resume_id(payload.get("command"))
        # Vendors absent from both paths above deliberately claim no resume
        # id here (e.g. an id-less lossy resume); the rationale lives in each
        # vendor's module. Such panes bind via the kickoff marker instead.
        # A re-created pane (renderer reload respawn keeps its pane id)
        # must not lose its fresh registration to a pending grace-period
        # cleanup from the previous PTY's exit.
        app._cancel_pane_unregister(term.pane_id)
        # register_pane's baseline scan enumerates the vendor's whole
        # session-file tree — run it off-loop (register_pane is
        # thread-safe via attribution._lock) so the create ack below
        # isn't delayed past the frontend's timeout. Awaited so the
        # pane is registered before the ack, as before.
        attribution_future = asyncio.get_running_loop().run_in_executor(
            None,
            app.functools.partial(
                app.attribution.register_pane,
                term.pane_id,
                vendor=agent_key,
                cwd=payload["cwd"],
                workspace_path=ws_for_pane,
                stage_id=metadata.get("stage_id") or metadata.get("stageId"),
                slot_key=app._stable_pane_key(metadata, ""),
                explicit_session_id=explicit_session_id,
                session_marker=str(metadata.get("session_marker") or ""),
                session_home_id=str(metadata.get("session_home_id") or ""),
            ),
        )
        transaction["attribution_future"] = attribution_future
        transaction["attribution_started"] = True
        await asyncio.shield(attribution_future)
    if transaction["cancelled"]:
        raise _TerminalCreateCancelled
    if getattr(term, "closed", False):
        app._PTY_OWNERS.pop(term.id, None)
        details = {
            "agent_key": agent_key,
            "binary_path": (startup_probe or {}).get("binary_path", ""),
            "reason": getattr(term, "close_reason", None),
            "exit_code": getattr(term, "exit_code", None),
            "signal": getattr(term, "exit_signal", None),
            "uptime_ms": getattr(term, "uptime_ms", None),
            "startup_probe": startup_probe,
        }
        cause = getattr(term, "exit_signal", None) or f"exit code {getattr(term, 'exit_code', None)}"
        raise app.AgentCliProbeError(
            f"Process died {getattr(term, 'uptime_ms', None)}ms after spawn ({cause})",
            details,
        )
    if login_profile_id:
        # Fast login feedback: watch the isolated login home and harvest the
        # moment the browser authorization completes — the usage poll alone is
        # too slow for the accounts UI to flip to signed-in.
        from .usage_service import start_login_watch

        start_login_watch(agent_key, login_profile_id)
    response_payload = {
        "terminal_session_id": term.id,
        "pane_id": term.pane_id,
        "pid": term.proc.pid,
        "command": term.command,
        "startup_probe": startup_probe,
        "create_generation": generation,
    }
    await session.send_json(make_response(msg_id, msg_type, response_payload))
    if session.dead or transaction["cancelled"]:
        raise _TerminalCreateCancelled
    transaction["response_payload"] = response_payload
    transaction["committed"] = True


@handler("terminal.create.cancel")
async def terminal_create_cancel(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    pane_id = str(payload["pane_id"])
    generation = str(payload["create_generation"])
    key = (pane_id, generation)
    transaction = session._terminal_create_transactions.get(key)
    cancelled = bool(transaction and not transaction.get("committed"))
    if transaction and not transaction.get("committed"):
        transaction["cancelled"] = True
        session._terminal_create_tombstones.add(key)
        await _rollback_terminal_create(session, transaction)
    elif transaction is None:
        session._terminal_create_tombstones.add(key)
        cancelled = True
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "pane_id": pane_id,
                "create_generation": generation,
                "cancelled": cancelled,
            },
        )
    )


@handler("terminal.input")
async def terminal_input(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    session.terminals.write(payload["terminal_session_id"], payload["data"])
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.log_sent")
async def terminal_log_sent(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    # Fire-and-forget: log injected text to the session's output log file.
    # No response needed — caller does not await this.
    session.terminals.log_sent(
        payload["terminal_session_id"],
        payload.get("label", "sent"),
        payload.get("text", ""),
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.resize")
async def terminal_resize(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    # Drain old-width output BEFORE the ioctl + ack so it reaches the
    # frontend first — otherwise xterm re-wraps stale-width content
    # after narrowing and the CLI's repaints strand corrupt frames in
    # scrollback (visible as residual text). See drain_output().
    await session.terminals.drain_output(payload["terminal_session_id"])
    session.terminals.resize(
        payload["terminal_session_id"],
        int(payload["cols"]),
        int(payload["rows"]),
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.interrupt")
async def terminal_interrupt(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    session.terminals.interrupt(payload["terminal_session_id"])
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.kill")
async def terminal_kill(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # We don't have direct session_id → pane_id mapping at the app layer;
    # the TerminalService does. Look it up before killing so we can
    # release the attribution registration.
    term_session_id = payload["terminal_session_id"]
    force = bool(payload.get("force", False))
    owner = app._PTY_OWNERS.get(term_session_id)
    if owner is not session:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "TERMINAL_NOT_OWNED",
                "terminal session is not owned by this connection; reattach it first",
                {"terminal_session_id": term_session_id},
            )
        )
        return
    pane_id_for_unreg = ""
    for sess in session.terminals._sessions.values():  # noqa: SLF001
        if sess.id == term_session_id:
            pane_id_for_unreg = sess.pane_id
            break
    try:
        await session.terminals.kill(term_session_id, force=force)
        if pane_id_for_unreg:
            app.attribution.unregister_pane(pane_id_for_unreg)
    finally:
        if app._PTY_OWNERS.get(term_session_id) is session:
            app._PTY_OWNERS.pop(term_session_id, None)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.reattach")
async def terminal_reattach(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # A reconnecting renderer rebinds to still-running PTYs. Report which
    # ids survived; the frontend rebinds those and falls back to
    # spawn+resume for the rest. Force a one-shot SIGWINCH on survivors so
    # agent TUIs repaint into the fresh (empty) xterm. This is NOT the
    # forbidden "auto-redraw a running, visible pane" (no existing content
    # to reflow-corrupt) — it's the only way a reattached blank xterm
    # recovers its screen, since there is no server-side output buffer.
    ids = [str(x) for x in (payload.get("terminal_session_ids") or [])]
    cols = int(payload.get("cols", 0))
    rows = int(payload.get("rows", 0))
    live_ids = {
        s.id
        for s in session.terminals._sessions.values()  # noqa: SLF001
        if not s.closed
    }
    alive = [tid for tid in ids if tid in live_ids]
    dead = [tid for tid in ids if tid not in live_ids]
    # Transfer ownership of reattached PTYs to this window.
    app._claim_ptys(session, alive)
    if cols > 0 and rows > 0:
        for tid in alive:
            session.terminals.force_redraw(tid, cols, rows)
    await session.send_json(
        make_response(msg_id, msg_type, {"alive": alive, "dead": dead})
    )


@handler("terminal.redraw")
async def terminal_redraw(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    # One-shot SIGWINCH nudge so a TUI repaints cleanly after a resize
    # settles, clearing the reflow residue xterm leaves when it re-wraps
    # the old frame at the new width. Unlike terminal.reattach this does
    # NOT re-route the active session — it is a pure repaint of an
    # already-attached, visible pane (the frontend gates it on width
    # stable + CLI quiet, see useTerminal scheduleResizeRedraw).
    tid = str(payload.get("terminal_session_id") or "")
    cols = int(payload.get("cols", 0))
    rows = int(payload.get("rows", 0))
    if tid and cols > 0 and rows > 0:
        # Order the repaint SIGWINCH AFTER any pending output, the same
        # barrier terminal.resize uses (drain_output). The frontend can
        # fire this mid-stream when a busy pane hits its bounded-wait
        # deadline; without draining first, the SIGWINCH could interrupt
        # an in-flight frame and strand a corrupt repaint — exactly what
        # the resize drain/grace machinery exists to prevent.
        await session.terminals.drain_output(tid)
        session.terminals.force_redraw(tid, cols, rows)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


# ── Projects (project.*) ─────────────────────────────────────────────────────
@handler("project.upsert")
async def project_upsert(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.load_or_create(
        payload["workspace_path"],
        name=payload.get("name", ""),
        backend_version=app.__version__,
    )
    app._register_workspace_and_backfill(project.workspace_path)
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("project.get")
async def project_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.load_or_create(payload["workspace_path"])
    app._register_workspace_and_backfill(project.workspace_path)
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("project.peek")
async def project_peek(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    project = app.project_store.peek(ws_raw)
    if project:
        app._register_workspace_and_backfill(project.workspace_path)
        peek_payload = app._project_payload(project)
        peek_payload["plan_spec_available"] = app.plan_spec_exists(
            project.workspace_path
        )
        await session.send_json(
            make_response(msg_id, msg_type, peek_payload)
        )
    else:
        # Even when no .agent-team/project.json exists yet, register
        # any valid directory the user "opens" so its historic CLI
        # sessions can show up in cumulative immediately.
        import os as _os
        ws_abs = _os.path.abspath(ws_raw) if ws_raw else ""
        if ws_abs and _os.path.isdir(ws_abs):
            app._register_workspace_and_backfill(ws_abs)
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {
                    "project": None,
                    "paths": None,
                    "plan_spec_available": app.plan_spec_exists(ws_abs),
                },
            )
        )


@handler("project.set_layout_mode")
async def project_set_layout_mode(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    mode = payload.get("layout_mode", "grid")
    if mode not in ("auto", "grid", "spotlight", "fullscreen"):
        mode = "grid"
    project = app.project_store.peek(ws_raw)
    if project:
        project.layout_mode = mode
        app.project_store.save(project)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_order")
async def project_set_pane_order(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_ids = payload.get("pane_ids") or []
    if isinstance(pane_ids, list):
        app.project_store.set_pane_order(
            ws_raw, pane_ids=[p for p in pane_ids if isinstance(p, str)]
        )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_stopped")
async def project_set_pane_stopped(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    stopped = bool(payload.get("stopped", False))
    if ws_raw and pane_id:
        app.project_store.set_pane_stopped(ws_raw, pane_id=pane_id, stopped=stopped)
        asyncio.create_task(
            app.broadcast(make_event("pane.stopped", {
                "workspace_path": ws_raw, "pane_id": pane_id, "stopped": stopped,
            }))
        )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_tab_order")
async def project_set_tab_order(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    tab_order = payload.get("tab_order") or []
    if isinstance(tab_order, list):
        app.project_store.set_tab_order(
            ws_raw, tab_order=[t for t in tab_order if isinstance(t, str)]
        )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_ui_state")
async def project_set_ui_state(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    raw_groups = payload.get("run_groups")
    run_groups = (
        [g for g in raw_groups if isinstance(g, dict)]
        if isinstance(raw_groups, list)
        else None
    )
    raw_tab = payload.get("active_tab")
    active_tab = raw_tab if isinstance(raw_tab, str) else None
    raw_repo = payload.get("git_tab_repo")
    git_tab_repo = raw_repo if isinstance(raw_repo, str) else None
    raw_history = payload.get("spawn_history")
    full_history = (
        [entry for entry in raw_history if isinstance(entry, dict)]
        if isinstance(raw_history, list)
        else None
    )
    raw_cli_order = payload.get("cli_agent_order")
    cli_agent_order = (
        [k for k in raw_cli_order if isinstance(k, str)]
        if isinstance(raw_cli_order, list)
        else None
    )
    raw_cli_disabled = payload.get("cli_agent_disabled")
    cli_agent_disabled = (
        [k for k in raw_cli_disabled if isinstance(k, str)]
        if isinstance(raw_cli_disabled, list)
        else None
    )
    if full_history is not None and ws_raw:
        # Workspace isolation at the write layer: never persist entries that
        # belong to another workspace, in the full store or the mirror.
        # merge() filters again on its own — each layer stands alone.
        full_history = filter_foreign_entries(
            ws_raw, full_history, context="set_ui_state"
        )
    spawn_history = full_history[-100:] if full_history is not None else None

    # Offload the blocking read-modify-write (json.dumps + write_text +
    # os.replace) to a worker thread: during cold-start restore storms the
    # event loop is contended enough that a synchronous save can blow the
    # frontend's 10s RPC deadline and lose UI state. The store's save lock
    # serializes concurrent offloaded calls.
    def _persist():
        # Full-store merge first (upsert-only, never deletes), then the
        # legacy 100-entry mirror in project.json for backward compat. The
        # peek gates the merge so an unknown workspace still creates no
        # files, and seeds the one-time migration from the old mirror.
        if full_history is not None:
            prev = app.project_store.peek(ws_raw)
            if prev is not None:
                app.spawn_history_store.merge(
                    ws_raw, full_history, seed=prev.ui_spawn_history
                )
        return app.project_store.set_ui_state(
            ws_raw,
            run_groups=run_groups,
            active_tab=active_tab,
            git_tab_repo=git_tab_repo,
            spawn_history=spawn_history,
            cli_agent_order=cli_agent_order,
            cli_agent_disabled=cli_agent_disabled,
        )

    project = await asyncio.to_thread(_persist)
    if project is not None:
        # Peer windows on the same workspace adopt the change live
        # (replaces the old cross-window localStorage `storage` event).
        delta: dict = {"workspace_path": project.workspace_path}
        if run_groups is not None:
            delta["run_groups"] = run_groups
        if active_tab is not None:
            delta["active_tab"] = active_tab
        if git_tab_repo is not None:
            delta["git_tab_repo"] = git_tab_repo
        if spawn_history is not None:
            delta["spawn_history"] = spawn_history
        if cli_agent_order is not None:
            delta["cli_agent_order"] = cli_agent_order
        if cli_agent_disabled is not None:
            delta["cli_agent_disabled"] = cli_agent_disabled
        await app.broadcast(
            make_event("project.ui_state_changed", delta), exclude=session
        )
    # ok mirrors persistence so the frontend's one-time localStorage
    # migration only deletes its legacy copy after a real ack.
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": project is not None})
    )


@handler("project.get_spawn_history")
async def project_get_spawn_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Paged read of the full spawn history (spawn-history.json).

    `offset` counts from the newest end (0 = latest); the returned page is
    newest → oldest. Falls back to seeding the full store from the
    project.json mirror for projects created before the store existed.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    raw_offset = payload.get("offset")
    offset = raw_offset if isinstance(raw_offset, int) and raw_offset >= 0 else 0
    raw_limit = payload.get("limit")
    limit = raw_limit if isinstance(raw_limit, int) and 0 < raw_limit <= 1000 else 100

    def _read() -> tuple[list[dict], int]:
        project = app.project_store.peek(ws_raw)
        seed = project.ui_spawn_history if project is not None else None
        return app.spawn_history_store.read_page(
            ws_raw, offset=offset, limit=limit, seed=seed
        )

    entries, total = await asyncio.to_thread(_read)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "entries": entries,
                "total": total,
                "offset": offset,
                # Symlink-resolved identity of the workspace so the renderer
                # can also match entries recorded under the canonical spelling.
                "canonical_workspace_path": (
                    canonical_workspace_path(ws_raw) if ws_raw else ""
                ),
            },
        )
    )


@handler("project.rename_pane")
async def project_rename_pane(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    custom_name = (payload.get("custom_name", "") or "").strip()
    if pane_id:
        project = app.project_store.rename_pane(
            ws_raw, pane_id=pane_id, custom_name=custom_name
        )
        # Patch the full store (spawn-history.json) at the source too: the
        # renderer's debounced snapshot merge also carries the rename, but it
        # can be lost on quit and never runs in detached windows.
        if project is not None:
            await asyncio.to_thread(
                app.spawn_history_store.patch_entry,
                ws_raw,
                pane_id,
                {"customName": custom_name or None},
                seed=project.ui_spawn_history,
            )
        # rename_pane() patches the persisted history mirror; push it to
        # peer windows so their in-memory copies (and later snapshots)
        # don't clobber the rename with stale entries. renamed_pane lets
        # peers also patch their live panes[] state — spawn_history alone
        # leaves their pane titles/lists showing the old name.
        if project is not None:
            delta: dict = {
                "workspace_path": project.workspace_path,
                "renamed_pane": {"pane_id": pane_id, "custom_name": custom_name},
            }
            if project.ui_spawn_history is not None:
                delta["spawn_history"] = project.ui_spawn_history
            await app.broadcast(
                make_event("project.ui_state_changed", delta),
                exclude=session,
            )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_auto_name")
async def project_set_pane_auto_name(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Persist an auto-generated pane title (set-once; custom_name wins).

    An accepted write also patches the project.json spawn-history mirror
    (autoName key) via the store, but never the full spawn-history store,
    and a no-op (empty name, or the pane already named either way) is not
    broadcast — the store is the final arbiter of the cross-window race, so
    only the winning write reaches peer windows.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    auto_name = (payload.get("auto_name", "") or "").strip()
    if pane_id:
        project, changed = app.project_store.set_pane_auto_name(
            ws_raw, pane_id=pane_id, auto_name=auto_name
        )
        if project is not None and changed:
            # Peers patch their live panes[] state from auto_named_pane so
            # their titles converge on the winning name.
            await app.broadcast(
                make_event(
                    "project.ui_state_changed",
                    {
                        "workspace_path": project.workspace_path,
                        "auto_named_pane": {"pane_id": pane_id, "auto_name": auto_name},
                    },
                ),
                exclude=session,
            )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.rename_spawn_history")
async def project_rename_spawn_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Rename a spawn-history entry whose pane no longer exists.

    Unlike project.rename_pane this never creates a pane record: it patches
    the full store (spawn-history.json) plus the project.json mirror, then
    broadcasts the updated mirror so peer windows adopt the new name.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    custom_name = (payload.get("custom_name", "") or "").strip()
    patched = False
    if pane_id:

        def _patch():
            project = app.project_store.peek(ws_raw)
            seed = project.ui_spawn_history if project is not None else None
            ok = app.spawn_history_store.patch_entry(
                ws_raw, pane_id, {"customName": custom_name or None}, seed=seed
            )
            # Entries past the mirror's 100-entry window simply aren't there
            # to patch — rename_history_entry() returns None and no broadcast
            # is needed (peers can't be showing them from the mirror anyway).
            mirror_project = app.project_store.rename_history_entry(
                ws_raw, pane_id=pane_id, custom_name=custom_name
            )
            return ok, mirror_project

        patched, project = await asyncio.to_thread(_patch)
        if project is not None and project.ui_spawn_history is not None:
            await app.broadcast(
                make_event(
                    "project.ui_state_changed",
                    {
                        "workspace_path": project.workspace_path,
                        "spawn_history": project.ui_spawn_history,
                    },
                ),
                exclude=session,
            )
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "patched": patched})
    )


@handler("project.star_spawn_history")
async def project_star_spawn_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Star or unstar a spawn-history entry.

    Same dual-layer patch as project.rename_spawn_history: the full store
    (spawn-history.json) plus the project.json mirror, then a mirror
    broadcast so peer windows adopt the flag. Unstarring removes the key
    (patch_entry deletes on None) instead of storing False. Starred entries
    are skipped by bulk cleanup (see SpawnHistoryStore.delete_entries).
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    starred = bool(payload.get("starred"))
    patched = False
    if pane_id:

        def _patch():
            project = app.project_store.peek(ws_raw)
            seed = project.ui_spawn_history if project is not None else None
            ok = app.spawn_history_store.patch_entry(
                ws_raw, pane_id, {"starred": True if starred else None}, seed=seed
            )
            # Entries past the mirror's 100-entry window aren't there to
            # patch — star_history_entry() returns None and no broadcast is
            # needed (peers can't be showing them from the mirror anyway).
            mirror_project = app.project_store.star_history_entry(
                ws_raw, pane_id=pane_id, starred=starred
            )
            return ok, mirror_project

        patched, project = await asyncio.to_thread(_patch)
        if project is not None and project.ui_spawn_history is not None:
            await app.broadcast(
                make_event(
                    "project.ui_state_changed",
                    {
                        "workspace_path": project.workspace_path,
                        "spawn_history": project.ui_spawn_history,
                    },
                ),
                exclude=session,
            )
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "patched": patched})
    )


@handler("project.delete_spawn_history")
async def project_delete_spawn_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Delete spawn-history entries from the full store and the mirror.

    Modes: "ids" (explicit pane_ids), "removed" (every removed entry),
    "older_than" (removed entries spawned before cutoff_iso). A live pane is
    never killed, but the entry's CLI transcript log is unlinked with it.
    Peers get the updated mirror via project.ui_state_changed.

    ``dry_run: true`` reports what the same request would delete — identical
    response shape, no store rewrite, no unlink, no broadcast — so the
    renderer can confirm the log loss and the reclaimed space first.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    mode = payload.get("mode")
    # Truthy (not strictly `True`) so a sloppy client errs toward previewing
    # rather than toward an unconfirmed destructive delete.
    dry_run = bool(payload.get("dry_run"))
    raw_ids = payload.get("pane_ids")
    pane_ids = (
        [p for p in raw_ids if isinstance(p, str) and p]
        if isinstance(raw_ids, list)
        else []
    )
    raw_cutoff = payload.get("cutoff_iso")
    cutoff_iso = raw_cutoff if isinstance(raw_cutoff, str) and raw_cutoff else None
    if (
        mode not in ("ids", "removed", "older_than")
        or (mode == "ids" and not pane_ids)
        or (mode == "older_than" and cutoff_iso is None)
    ):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "invalid delete_spawn_history request"
            )
        )
        return

    def _delete():
        project = app.project_store.peek(ws_raw)
        seed = project.ui_spawn_history if project is not None else None
        result = app.spawn_history_store.delete_entries(
            ws_raw,
            mode=mode,
            pane_ids=pane_ids,
            cutoff_iso=cutoff_iso,
            seed=seed,
            dry_run=dry_run,
        )
        # Keep the project.json mirror consistent: drop exactly the entries
        # the store deleted (the store is a superset of the mirror after the
        # seed migration above, so filtering by id is complete).
        if not dry_run and result.deleted_ids and project is not None and project.ui_spawn_history:
            gone = set(result.deleted_ids)
            mirror = [
                e
                for e in project.ui_spawn_history
                if not (isinstance(e, dict) and e.get("paneId") in gone)
            ]
            project = app.project_store.set_ui_state(ws_raw, spawn_history=mirror)
        return result, project

    result, project = await asyncio.to_thread(_delete)
    deleted_ids = result.deleted_ids
    if not dry_run and deleted_ids and project is not None:
        await app.broadcast(
            make_event(
                "project.ui_state_changed",
                {
                    "workspace_path": project.workspace_path,
                    "spawn_history": project.ui_spawn_history or [],
                },
            ),
            exclude=session,
        )
    # `deleted`/`total` are what the existing renderer reads; the two log
    # fields are additive so the Storage settings page can show what the
    # delete reclaimed.
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "deleted": len(deleted_ids),
                "total": result.total,
                "freed_bytes": result.freed_bytes,
                "removed_log_files": result.removed_log_files,
            },
        )
    )


@handler("project.set_theme")
async def project_set_theme(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Backup-only persistence: localStorage in the renderer is the source
    # of truth. We just stash the latest theme + custom overrides so they
    # can sync across devices. Unknown workspace → silently no-op.
    ws_raw = payload.get("workspace_path", "") or ""
    project = app.project_store.peek(ws_raw)
    if project:
        theme = payload.get("theme")
        if isinstance(theme, str) and theme:
            project.theme = theme
        custom = payload.get("theme_custom")
        if isinstance(custom, dict):
            project.theme_custom = custom
        app.project_store.save(project)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_language")
async def project_set_language(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Backup-only persistence: localStorage in the renderer is the source
    # of truth. Unknown workspace → silently no-op.
    ws_raw = payload.get("workspace_path", "") or ""
    project = app.project_store.peek(ws_raw)
    if project:
        lang = payload.get("language")
        if isinstance(lang, str) and lang:
            project.language = lang
        app.project_store.save(project)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.log_event")
async def project_log_event(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload["workspace_path"]
    # Route to the run-specific log file (e.g. pipeline-20260528-…log)
    # rather than the generic pipeline.log fallback.
    _proj = app.project_store.peek(ws_path)
    _log_name = _proj.log_file_name if _proj else ""
    app.project_store.record_pane_event(
        ws_path,
        event_type=payload.get("event_type", "note"),
        pane_id=payload.get("pane_id", ""),
        agent=payload.get("agent", ""),
        role=payload.get("role", ""),
        origin=payload.get("origin", "manual"),
        details=payload.get("details"),
        log_file_name=_log_name,
    )
    # Mirror into the structured history timeline. Orchestrator log lines
    # carry their text in details.line; classify those, store others as-is.
    _run_dir = _log_name.rsplit("/", 1)[0] if "/" in _log_name else ""
    _details = payload.get("details") or {}
    _line = _details.get("line") if isinstance(_details, dict) else None
    if payload.get("event_type") == "orchestrator_log" and _line:
        _ev = app.history_store.record_line(
            ws_path,
            _line,
            run_dir=_run_dir,
            pane_id=payload.get("pane_id") or None,
            vendor=payload.get("agent") or None,
        )
    else:
        _ev = app.history_store.record(
            ws_path,
            run_dir=_run_dir,
            type=payload.get("event_type", "note"),
            summary=str(_line or payload.get("event_type", "note")),
            pane_id=payload.get("pane_id") or None,
            vendor=payload.get("agent") or None,
            detail=_details if isinstance(_details, dict) and _details else None,
        )
    asyncio.create_task(
        app.broadcast(make_event("history.appended", {"workspace_path": ws_path, "event": _ev}))
    )
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True})
    )


# ── Pipeline execution (pipeline.*) ──────────────────────────────────────────
@handler("pipeline.resume")
async def pipeline_resume(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project, resume_index = app.project_store.resume_pipeline(payload["workspace_path"])
    resp = app._project_payload(project)
    resp["resume_index"] = resume_index
    await session.send_json(make_response(msg_id, msg_type, resp))


@handler("pipeline.start")
async def pipeline_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.start_pipeline(
        payload["workspace_path"],
        task_description=payload.get("task_description", ""),
        total_stages=int(payload.get("total_stages", 4)),
        stage_blueprint=payload.get("stage_blueprint", []),
        backend_version=app.__version__,
        pipeline_id=payload.get("pipeline_id", "") or app.stages_store.get_active_pipeline_id(),
    )
    app._register_workspace_and_backfill(project.workspace_path)
    # Start a fresh token-stats run for this workspace.
    log_name = project.log_file_name or ""
    run_dir = log_name.rsplit("/", 1)[0] if "/" in log_name else ""
    app.tokens_store.start_run(
        project.workspace_path,
        run_id=run_dir or project.id,
        task=project.task_description,
        run_dir=run_dir,
    )
    asyncio.create_task(
        app.broadcast(make_event("tokens.changed", app.tokens_store.snapshot(project.workspace_path)))
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.stage_spawn")
async def pipeline_stage_spawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_stage_spawn(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        pane_id=payload["pane_id"],
        agent=payload.get("agent", ""),
        role=payload.get("role", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.slot_spawn")
async def pipeline_slot_spawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_slot_spawn(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        slot_label=payload["slot_label"],
        pane_id=payload["pane_id"],
        agent=payload.get("agent", ""),
        role=payload.get("role", ""),
        # Claude passes its pinned --session-id here; Codex/Antigravity pass
        # "" and persist later via pipeline.slot_session once detected.
        session_id=payload.get("session_id", ""),
        session_home_id=payload.get("session_home_id", ""),
        profile_id=_profile_pin_for_spawn(payload.get("agent", ""), payload.get("profile_id")),
        run_group_id=payload.get("run_group_id", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.slot_session")
async def pipeline_slot_session(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_slot_session(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        slot_label=payload["slot_label"],
        session_id=payload.get("session_id", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.slot_unspawn")
async def pipeline_slot_unspawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_slot_unspawn(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        slot_label=payload["slot_label"],
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.slot_kickoff")
async def pipeline_slot_kickoff(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.update_slot_kickoff(
        payload["workspace_path"],
        stage_index=int(payload["stage_index"]),
        slot_label=payload["slot_label"],
        kickoff_status=payload.get("kickoff_status", "sent"),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.complete")
async def pipeline_complete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.complete_pipeline(payload["workspace_path"])
    app.tokens_store.end_run(project.workspace_path)
    asyncio.create_task(
        app.broadcast(make_event("tokens.changed", app.tokens_store.snapshot(project.workspace_path)))
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.abort")
async def pipeline_abort(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.abort_pipeline(
        payload["workspace_path"], reason=payload.get("reason", "user")
    )
    app.tokens_store.end_run(project.workspace_path)
    asyncio.create_task(
        app.broadcast(make_event("tokens.changed", app.tokens_store.snapshot(project.workspace_path)))
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pipeline.fetch_docs")
async def pipeline_fetch_docs(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Fetch framework docs from Context7 via MCP for dynamic kickoff injection.
    # Best-effort: returns { doc_prefix: "" } on any error.
    task = payload.get("task", "")
    doc_query = payload.get("doc_query", "")
    workspace_path = payload.get("workspace_path", "")
    analyzer_model = payload.get("analyzer_model", "") or app.ANALYZER_DEFAULT_MODEL
    try:
        doc_prefix = await app.fetch_stage_docs(
            task=task,
            doc_query=doc_query,
            mcp_manager=app.mcp_manager,
            workspace_path=workspace_path,
            analyzer_model=analyzer_model,
        )
    except Exception as fetch_err:  # noqa: BLE001
        app.log.warning("pipeline.fetch_docs error: %s", fetch_err)
        doc_prefix = ""
    await session.send_json(
        make_response(msg_id, msg_type, {"doc_prefix": doc_prefix})
    )


@handler("pipeline.auto_answer")
async def pipeline_auto_answer(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    result = await app.analyzer_auto_answer(
        questions=payload.get("questions", []),
        task=payload.get("task", ""),
        stage_title=payload.get("stage_title", ""),
        model=payload.get("model") or app.ANALYZER_DEFAULT_MODEL,
    )
    app._record_analyzer_tokens(result, payload)
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Manual panes (manual_pane.*) + pane grouping (pane.*) ────────────────────
@handler("manual_pane.spawn")
async def manual_pane_spawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_manual_pane_spawn(
        payload["workspace_path"],
        pane_id=payload["pane_id"],
        previous_pane_id=payload.get("previous_pane_id", ""),
        agent=payload.get("agent", ""),
        role=payload.get("role", ""),
        command=payload.get("command", ""),
        session_id=payload.get("session_id", ""),
        session_home_id=payload.get("session_home_id", ""),
        profile_id=_profile_pin_for_spawn(payload.get("agent", ""), payload.get("profile_id")),
        run_group_id=payload.get("run_group_id", ""),
        output_log_file=payload.get("output_log_file", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("manual_pane.unspawn")
async def manual_pane_unspawn(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_manual_pane_unspawn(
        payload["workspace_path"],
        pane_id=payload["pane_id"],
        session_id=payload.get("session_id", "") or "",
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("manual_pane.session")
async def manual_pane_session(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.record_manual_pane_session(
        payload["workspace_path"],
        pane_id=payload["pane_id"],
        session_id=payload.get("session_id", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


@handler("pane.set_run_group")
async def pane_set_run_group(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project = app.project_store.set_pane_run_group(
        payload["workspace_path"],
        pane_id=payload["pane_id"],
        run_group_id=payload.get("run_group_id", ""),
    )
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


# ── Reconnect lost conversations (workspace/pane.*) ──────────────────────────
def _collect_orphan_sessions(workspace_path: str) -> list[dict]:
    """Enumerate this workspace's Claude transcripts that no live pane holds.

    A transcript is orphaned when its session id is not the current session_id
    of any non-removed pane in the workspace's project — those are the ones a
    reconnect can safely adopt. Each orphan carries a short human-prompt
    preview, size/mtime, its resumable flag, and (best-effort) the spawn-history
    customName last associated with the id. Sorted newest mtime first. Blocking
    file IO — call via asyncio.to_thread.
    """
    from . import app

    files = ClaudeLogReader().session_files_for_workspace(workspace_path)
    project = app.project_store.peek(workspace_path)
    live_ids: set[str] = set()
    history_names: dict[str, str] = {}
    if project is not None:
        for pane in project.panes:
            if pane.spawn_status != "removed" and pane.session_id:
                live_ids.add(pane.session_id)
        # Oldest→newest order: overwriting keeps the name last associated.
        for entry in project.ui_spawn_history or []:
            if not isinstance(entry, dict):
                continue
            sid = entry.get("sessionId")
            name = entry.get("customName")
            if isinstance(sid, str) and sid and isinstance(name, str) and name:
                history_names[sid] = name

    orphans: list[dict] = []
    for f in files:
        sid = f.stem
        if sid in live_ids:
            continue
        try:
            st = f.stat()
        except OSError:
            continue
        orphans.append({
            "session_id": sid,
            "preview": first_user_prompts(f, limit=2),
            "size_bytes": st.st_size,
            "mtime": st.st_mtime,
            "resumable": app._session_exists("claude", workspace_path, sid),
            "custom_name": history_names.get(sid, ""),
        })
    orphans.sort(key=lambda o: o["mtime"], reverse=True)
    return orphans


@handler("workspace.list_orphan_sessions")
async def workspace_list_orphan_sessions(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    workspace_path = str(payload.get("workspace_path", ""))
    orphans = await asyncio.to_thread(_collect_orphan_sessions, workspace_path)
    await session.send_json(make_response(msg_id, msg_type, {"orphans": orphans}))


@handler("pane.reconnect_session")
async def pane_reconnect_session(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path", ""))
    pane_id = str(payload.get("pane_id", ""))
    session_id = str(payload.get("session_id", ""))
    if not app._session_exists("claude", workspace_path, session_id):
        await session.send_json(make_error(
            msg_id, msg_type, "NO_TRANSCRIPT",
            f"no Claude transcript for session {session_id!r} in this workspace",
        ))
        return
    try:
        project = app.project_store.reconnect_pane_session(
            workspace_path, pane_id=pane_id, session_id=session_id,
        )
    except KeyError as err:
        await session.send_json(make_error(msg_id, msg_type, "PANE_NOT_FOUND", str(err)))
        return
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


# ── CLI usage/quota badges (usage.*) ────────────────────────────────────────
@handler("usage.get")
async def usage_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .usage_service import service

    await session.send_json(make_response(msg_id, msg_type, service.payload()))


@handler("usage.refresh")
async def usage_refresh(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .usage_service import service

    service.request_refresh()
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("usage.configure")
async def usage_configure(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .usage_service import service

    service.configure(
        enabled=bool(payload.get("enabled", True)),
        interval_sec=payload.get("intervalSec"),
    )
    await session.send_json(make_response(msg_id, msg_type, service.payload()))


# ── Storage usage & cleanup (storage.*) ─────────────────────────────────────
def _storage_request_args(payload: dict) -> tuple[list[str], int]:
    raw_paths = payload.get("workspacePaths")
    paths = (
        [p for p in raw_paths if isinstance(p, str) and p]
        if isinstance(raw_paths, list)
        else []
    )
    return paths, storage_service.coerce_stale_days(payload.get("staleDays"))


@handler("storage.usage")
async def storage_usage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Disk-usage report for the Storage settings page.

    Walks several large trees (app data, CLI profile homes, codex pane homes,
    every open workspace), so it always runs on a worker thread.
    """
    workspace_paths, stale_days = _storage_request_args(payload)
    try:
        report = await asyncio.to_thread(
            storage_service.collect_usage, workspace_paths, stale_days
        )
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "SCAN_FAILED", f"storage scan failed: {err}")
        )
        return
    await session.send_json(make_response(msg_id, msg_type, report))


@handler("storage.cleanup")
async def storage_cleanup(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Delete the storage buckets named by ``itemIds``.

    Unknown, info-only and Electron-owned ids come back as ``ok: false`` rows
    instead of failing the whole request.
    """
    raw_ids = payload.get("itemIds")
    item_ids = (
        [i for i in raw_ids if isinstance(i, str) and i]
        if isinstance(raw_ids, list)
        else []
    )
    workspace_paths, stale_days = _storage_request_args(payload)
    try:
        result = await asyncio.to_thread(
            storage_service.cleanup, item_ids, workspace_paths, stale_days
        )
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "CLEANUP_FAILED", f"cleanup failed: {err}")
        )
        return
    await session.send_json(make_response(msg_id, msg_type, result))


# ── Background executions (executions.*) ────────────────────────────────────
_EXECUTION_KINDS = ("crontab", "launchagent")


def _executions_target(payload: dict) -> tuple[str, str] | None:
    """Validate ``kind``/``target``; None when the request is malformed."""
    kind = payload.get("kind")
    target = payload.get("target")
    if kind not in _EXECUTION_KINDS or not isinstance(target, str) or not target.strip():
        return None
    return kind, target


async def _broadcast_executions_changed(session: "Session") -> None:
    """Tell the *other* windows to rescan.

    The acting window refreshes off its own response, so including it here
    would make every mutation cost two full scans.
    """
    from . import app

    await app.broadcast(make_event("executions.changed", {}), exclude=session)


@handler("executions.list")
async def executions_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Scan the machine's crontab entries and macOS LaunchAgents."""
    await session.send_json(
        make_response(msg_id, msg_type, await executions_service.list_executions())
    )


@handler("executions.set_enabled")
async def executions_set_enabled(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Enable or disable one crontab entry or LaunchAgent.

    Operational failures come back as ``ok: false`` with the real stderr so the
    UI can show it in place; only malformed requests are protocol errors.
    """
    parsed = _executions_target(payload)
    enabled = payload.get("enabled")
    if parsed is None or not isinstance(enabled, bool):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST",
                "executions.set_enabled needs kind ('crontab'|'launchagent'), target and enabled",
            )
        )
        return
    kind, target = parsed
    try:
        if kind == "crontab":
            await executions_service.set_crontab_enabled(target, enabled)
        else:
            await executions_service.set_launch_agent_enabled(target, enabled)
    except executions_service.ExecutionsError as err:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": str(err)})
        )
        return
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    await _broadcast_executions_changed(session)


@handler("executions.remove")
async def executions_remove(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Delete one crontab entry, or unload and delete one LaunchAgent plist."""
    parsed = _executions_target(payload)
    if parsed is None:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST",
                "executions.remove needs kind ('crontab'|'launchagent') and target",
            )
        )
        return
    kind, target = parsed
    try:
        if kind == "crontab":
            await executions_service.remove_crontab_entry(target)
        else:
            await executions_service.remove_launch_agent(target)
    except executions_service.ExecutionsError as err:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": str(err)})
        )
        return
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    await _broadcast_executions_changed(session)


# ── Cross-workspace inter-CLI messaging (agent_msg.*) ───────────────────────
# Each renderer window mirrors its own pane handles here so the backend — the
# only process that sees every workspace — can resolve `to: <folder>/<pane>`
# targets. Delivery stays in the frontend: a resolved cross-workspace message is
# broadcast back out as an `agent_msg.deliver` event, and the window that owns
# the target pane runs it through the existing injection queue.


@handler("agent_msg.register")
async def agent_msg_register(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    pane_id = str(payload.get("pane_id") or "")
    name = str(payload.get("name") or "")
    workspace_path = str(payload.get("workspace_path") or "")
    if not pane_id or not name or not workspace_path:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "BAD_REQUEST",
                "agent_msg.register needs pane_id, name and workspace_path",
            )
        )
        return
    entry = agent_messaging.register(
        pane_id,
        name,
        workspace_path,
        agent_key=str(payload.get("agent_key") or ""),
        owner=session,
    )
    await session.send_json(make_response(msg_id, msg_type, entry.to_dict()))


@handler("agent_msg.unregister")
async def agent_msg_unregister(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    pane_id = str(payload.get("pane_id") or "")
    removed = bool(pane_id) and agent_messaging.unregister(pane_id, owner=session)
    if removed:
        # The pane is gone for good (a detach keeps the entry, see unregister),
        # so drop its cached activity instead of leaking one entry per pane.
        from . import app
        app.forget_pane_activity(pane_id)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "removed": removed}))


@handler("agent_msg.set_busy")
async def agent_msg_set_busy(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The owning window reports whether a pane's agent is mid-turn, so
    cli_list_targets can tell a caller that a target is working."""
    pane_id = str(payload.get("pane_id") or "")
    changed = bool(pane_id) and agent_messaging.set_busy(pane_id, bool(payload.get("busy")))
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "changed": changed}))


def _external_access_status() -> dict:
    """{enabled, token, port} for the Settings UI's external-access panel."""
    from .plugins.builtin.navide_plans import plan_mcp_auth, plan_mcp_wiring

    return {
        "enabled": plan_mcp_auth.external_enabled(),
        "token": plan_mcp_auth.external_token(),
        "port": plan_mcp_wiring.backend_port() or 0,
    }


@handler("external_access.get")
async def external_access_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Settings UI: current /plan-mcp external-access config."""
    await session.send_json(make_response(msg_id, msg_type, _external_access_status()))


@handler("external_access.set")
async def external_access_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Settings UI: turn external access to /plan-mcp on or off."""
    from .plugins.builtin.navide_plans import plan_mcp_auth

    plan_mcp_auth.set_external_enabled(bool(payload.get("enabled")))
    await session.send_json(make_response(msg_id, msg_type, _external_access_status()))


@handler("external_access.regenerate")
async def external_access_regenerate(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Settings UI: mint a new external token, invalidating the old one."""
    from .plugins.builtin.navide_plans import plan_mcp_auth

    plan_mcp_auth.regenerate_external_token()
    await session.send_json(make_response(msg_id, msg_type, _external_access_status()))


@handler("agent_spawn.result")
async def agent_spawn_result(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A window's verdict on an agent_spawn.request, handed to the waiting
    cli_open_agent call."""
    from .plugins.builtin.navide_plans import plan_mcp

    request_id = str(payload.get("request_id") or "")
    if not request_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_spawn.result needs request_id")
        )
        return
    delivered = plan_mcp.resolve_spawn(
        request_id,
        {
            "ok": bool(payload.get("ok", False)),
            "error": str(payload.get("error") or ""),
            "pane_id": str(payload.get("pane_id") or ""),
            "name": str(payload.get("name") or ""),
        },
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("ui.invoke.result")
async def ui_invoke_result(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A renderer window's reply to a ui.invoke.request, handed to the
    waiting ui_invoke/ui_snapshot/ui_list_actions MCP call."""
    from .plugins.builtin.navide_plans import plan_mcp

    request_id = str(payload.get("request_id") or "")
    if not request_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "ui.invoke.result needs request_id")
        )
        return
    result: dict[str, Any] = {
        "ok": bool(payload.get("ok", False)),
        "result": payload.get("result"),
        "error": str(payload["error"]) if payload.get("error") is not None else None,
    }
    if payload.get("warnings"):
        result["warnings"] = payload["warnings"]
    delivered = plan_mcp.resolve_ui_invoke(request_id, result)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("agent_msg.list")
async def agent_msg_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    raw_ws = payload.get("workspace_path")
    workspace_path = str(raw_ws) if isinstance(raw_ws, str) and raw_ws else None
    entries = [e.to_dict() for e in agent_messaging.list_panes(workspace_path)]
    await session.send_json(make_response(msg_id, msg_type, {"panes": entries}))


@handler("agent_msg.route")
async def agent_msg_route(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    from_pane_id = str(payload.get("from_pane_id") or "")
    to = str(payload.get("to") or "")
    content = str(payload.get("content") or "")
    msg_key = str(payload.get("msg_key") or "")
    if not from_pane_id or not to or not msg_key:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "BAD_REQUEST",
                "agent_msg.route needs from_pane_id, to and msg_key",
            )
        )
        return

    result = agent_messaging.resolve(from_pane_id, to)
    if result.pane is None:
        await session.send_json(
            make_response(msg_id, msg_type, {"ok": False, "error": result.error or "unresolved"})
        )
        return

    if result.pane.pane_id == from_pane_id:
        await session.send_json(
            make_response(
                msg_id, msg_type, {"ok": False, "error": "sender and target are the same pane"}
            )
        )
        return

    sender = agent_messaging.get(from_pane_id)
    from_display = agent_messaging.sender_display(
        from_pane_id, str(payload.get("from_name") or "")
    )
    asyncio.create_task(
        app.broadcast(
            make_event(
                "agent_msg.deliver",
                {
                    "msg_key": msg_key,
                    "target_pane_id": result.pane.pane_id,
                    "target_workspace_path": result.pane.workspace_path,
                    "target_name": result.pane.name,
                    "from_pane_id": from_pane_id,
                    "from_display": from_display,
                    "from_workspace_path": sender.workspace_path if sender else "",
                    "cross_workspace": result.cross_workspace,
                    "content": content,
                },
            )
        )
    )
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "target_pane_id": result.pane.pane_id,
                "target_workspace_path": result.pane.workspace_path,
                "target_display": result.pane.qualified_name,
                "cross_workspace": result.cross_workspace,
            },
        )
    )


@handler("agent_msg.delivered")
async def agent_msg_delivered(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The receiving window reports the outcome so the sending window's message
    log can leave the `queued` state.

    Not excluding the reporter: a workspace-qualified target may resolve to a
    pane in the SAME window, and then sender and receiver are one connection —
    excluding it would strand that message in `queued` forever. Windows with no
    matching msg_key ignore the event.
    """
    from . import app

    msg_key = str(payload.get("msg_key") or "")
    if not msg_key:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.delivered needs msg_key")
        )
        return
    asyncio.create_task(
        app.broadcast(
            make_event(
                "agent_msg.delivery_result",
                {
                    "msg_key": msg_key,
                    "ok": bool(payload.get("ok", False)),
                    "reason": str(payload.get("reason") or ""),
                },
            )
        )
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


# ── Message-log persistence (agent_msg.log_*) ───────────────────────────────
# The renderer's message log is in-memory and dies with the window; these
# mirror it into the global database. Per-window queries — never broadcast.


@handler("agent_msg.log_snapshot")
async def agent_msg_log_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    limit = max(1, min(int(payload.get("limit", 500)), 500))
    rows = app.agent_message_log.tail(limit)
    await session.send_json(make_response(msg_id, msg_type, {"rows": rows}))


@handler("agent_msg.log_append")
async def agent_msg_log_append(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    rows = payload.get("rows")
    written = app.agent_message_log.append(rows if isinstance(rows, list) else [])
    await session.send_json(make_response(msg_id, msg_type, {"written": written}))


@handler("agent_msg.log_update")
async def agent_msg_log_update(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updates = payload.get("updates")
    updated = app.agent_message_log.update(updates if isinstance(updates, list) else [])
    await session.send_json(make_response(msg_id, msg_type, {"updated": updated}))


@handler("agent_msg.log_clear")
async def agent_msg_log_clear(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    keep = payload.get("keep_statuses")
    deleted = app.agent_message_log.clear(
        [str(s) for s in keep] if isinstance(keep, list) else None
    )
    await session.send_json(make_response(msg_id, msg_type, {"deleted": deleted}))
