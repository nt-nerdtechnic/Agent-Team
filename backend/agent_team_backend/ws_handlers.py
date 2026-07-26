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
from typing import TYPE_CHECKING, Awaitable, Callable

from .ipc import make_error, make_event, make_response
from .log_readers.claude import ClaudeLogReader, first_user_prompts
from .credential_vault import DEFAULT_SLOT_ID
from .profiles_store import SUPPORTED_AGENT_KEYS as PROFILE_AGENT_KEYS
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

    _rew_code = payload.get("code", "") or ""
    _rew_instr = payload.get("instruction", "") or ""
    _rew_lang = payload.get("language", "") or ""
    _chat_cfg = app.ai_chat_settings_store.get()
    if _chat_cfg.get("provider", "ollama") == "ollama":
        result = await app.editor_service.rewrite(
            app._az_base_url(),
            payload.get("model") or app.ANALYZER_DEFAULT_MODEL,
            _rew_code,
            _rew_instr,
            _rew_lang,
        )
    else:
        from .ai_chat_service import stream_chat as _stream_chat
        _lang_hint = f" ({_rew_lang})" if _rew_lang else ""
        _msgs = [{"role": "user", "content": (
            f"Rewrite the following code{_lang_hint} per this instruction: {_rew_instr}\n\n"
            f"```\n{_rew_code}\n```\n\nReturn ONLY the rewritten code, no explanation."
        )}]
        _chunks: list[str] = []
        async for _chunk in _stream_chat(_chat_cfg, _msgs, "You are a code rewriting assistant. Output only code.", max_tokens=2048):
            if not _chunk.startswith("\x00"):
                _chunks.append(_chunk)
        _text = "".join(_chunks).strip()
        # Strip markdown fences if model wrapped the code
        _text = re.sub(r'^```[a-zA-Z]*\n?', '', _text).strip()
        _text = re.sub(r'\n?```$', '', _text).strip()
        result = {"ok": True, "text": _text} if _text else {"ok": False, "error": "Empty response"}
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


# ── Diagnostics (debug.log) ─────────────────────────────────────────────────
@handler("debug.log")
async def debug_log(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    # TEMP: append a frontend diagnostic line to a file the dev can read
    # directly (renderer console logs aren't otherwise reachable). Remove
    # with the matching frontend diagnostics once resize is confirmed.
    try:
        import time as _t

        line = str(payload.get("line", ""))

        def _append_debug_line() -> None:
            with open("/tmp/agent-team-resize.log", "a") as _f:
                _f.write(f"{_t.strftime('%H:%M:%S')} {line}\n")

        await asyncio.to_thread(_append_debug_line)
    except Exception:
        pass
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


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
            sid: app.credential_vault.identity(agent_key, None if sid == active else sid)
            for sid in slot_ids
        }
    return out


def _profile_pin_for_spawn(agent_key: str, payload_profile_id: object) -> str:
    """The profile a pane is pinned to, persisted in its restore record so a
    resume re-spawns on the same account (see terminal.create's profile pin).
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
    reason: str, harvested_profile_ids: list[str] | None = None
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

    profile_id = str(payload.get("id") or "")
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
            await asyncio.to_thread(
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
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {"profiles": doc["profiles"], "defaults": doc["defaults"]},
        )
    )
    await _broadcast_profiles_changed("delete")


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


@handler("cli_profiles.set_default")
async def cli_profiles_set_default(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Switch the agent's active account: capture the live credentials into the
    outgoing account's slot, then restore the target slot into the real home.
    Switching only decides which account NEWLY spawned panes use — running panes
    are pinned to the isolated home they were spawned with (see terminal.create's
    profile pin) and keep running on that account, unaffected by the switch, so
    no pane is ever killed. The one guard left is LOGIN_IN_PROGRESS: an isolated
    sign-in for the target account still running must finish first, because the
    switch harvests its login home into the slot before restoring it."""
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

        # A pending isolated login home for the target profile must land in
        # its slot BEFORE restore() — restoring the still-empty slot would
        # sign the live state out and the next capture() would erase the
        # completed login. While the login pane's CLI is still running the
        # home cannot be harvested safely (token rotation, config home
        # deleted under a live CLI), so refuse the switch (LOGIN_IN_PROGRESS).
        if profile_id is not None and await asyncio.to_thread(
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
                await asyncio.to_thread(
                    app.credential_vault.harvest_login_home, agent_key, profile_id
                )
            except Exception as err:  # noqa: BLE001 — credentials untouched, refuse cleanly
                await session.send_json(
                    make_error(msg_id, msg_type, "PROFILE_SWAP_FAILED", _profile_error(err))
                )
                return

        try:
            await asyncio.to_thread(
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
            make_response(msg_id, msg_type, {"defaults": defaults})
        )
    await _broadcast_profiles_changed("set_default")
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

    configured = app.mcp_settings_store.list_servers()
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
            },
        )
    )


@handler("mcp.save_servers")
async def mcp_save_servers(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    servers_raw = payload.get("servers", [])
    servers = app.mcp_settings_store.replace_servers(servers_raw)
    await app.mcp_manager.reload(app.mcp_settings_store.path)
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": True, "servers": servers})
    )


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

    await session.send_json(make_response(msg_id, msg_type, {"bundle": app._settings_bundle()}))


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
        app.mcp_settings_store.replace_servers(bundle["mcp_servers"])
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
    result = app.onboarding_deps.pull_model(model)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("onboarding.complete")
async def onboarding_complete(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    app.onboarding_deps.set_complete(bool(payload.get("complete", True)))
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


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


# ── AI Chat (ai.chat.*, ai.enhance_prompt, ai.web.search, ai.review.*) ───────
@handler("ai.chat.settings.get")
async def ai_chat_settings_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    await session.send_json(make_response(msg_id, msg_type, app.ai_chat_settings_store.get()))


@handler("ai.chat.settings.set")
async def ai_chat_settings_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updated = app.ai_chat_settings_store.set(payload)
    await session.send_json(make_response(msg_id, msg_type, updated))


@handler("ai.chat.threads.get")
async def ai_chat_threads_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    await session.send_json(
        make_response(msg_id, msg_type, {"threads": app.chat_store.get_threads(ws_raw)})
    )


@handler("ai.chat.threads.set")
async def ai_chat_threads_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    threads = payload.get("threads")
    saved = (
        app.chat_store.set_threads(ws_raw, threads)
        if isinstance(threads, list)
        else None
    )
    # ok mirrors persistence — gates the frontend's one-time
    # localStorage migration (legacy copy deleted only after ack).
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": saved is not None})
    )


@handler("ai.chat.notes.get")
async def ai_chat_notes_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    await session.send_json(
        make_response(msg_id, msg_type, app.chat_store.get_notes(ws_raw))
    )


@handler("ai.chat.notes.set")
async def ai_chat_notes_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    notes = payload.get("notes")
    notepads = payload.get("notepads")
    saved = app.chat_store.set_notes(
        ws_raw,
        notes=notes if isinstance(notes, str) else "",
        notepads=notepads if isinstance(notepads, list) else [],
    )
    await session.send_json(
        make_response(msg_id, msg_type, {"ok": saved is not None})
    )


@handler("ai.chat.provider.test")
async def ai_chat_provider_test(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    provider = str(payload.get("provider") or "")
    overrides = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
    result = await app._test_ai_provider(provider, overrides)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("ai.chat.start")
async def ai_chat_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    session_id = payload.get("session_id", "") or str(__import__("uuid").uuid4())
    messages = payload.get("messages", []) or []
    workspace_path = payload.get("workspace_path", "") or ""
    system_suffix = payload.get("system_suffix", "") or ""
    system_prefix = payload.get("system_prefix", "") or ""
    settings = {**app.ai_chat_settings_store.get()}

    # Auto-inject workspace rules when frontend didn't already provide a prefix
    if not system_prefix and workspace_path:
        _cursor_rules_dir = app.Path(workspace_path) / ".cursor" / "rules"
        if _cursor_rules_dir.is_dir():
            _mdc_parts: list[str] = []
            for _mdc in sorted(_cursor_rules_dir.glob("*.mdc")):
                try:
                    _raw = _mdc.read_text(encoding="utf-8", errors="replace")
                    if _raw.startswith("---") and "alwaysApply: true" in _raw:
                        _end = _raw.index("---", 3) if _raw.count("---") >= 2 else len(_raw)
                        _body = _raw[_end + 3:].strip()
                        if _body:
                            _mdc_parts.append(_body[:4_000])
                except OSError:
                    pass
            if _mdc_parts:
                system_prefix = "--- Project Rules ---\n" + "\n\n---\n\n".join(_mdc_parts) + "\n---\n\n"
        if not system_prefix:
            for _rf in [".cursor/rules.md", ".cursorrules", "AGENTS.md", ".ai/rules.md",
                        ".ai/instructions.md", ".github/copilot-instructions.md"]:
                _rp = app.Path(workspace_path) / _rf
                if _rp.is_file():
                    try:
                        if _rp.stat().st_size <= 512_000:
                            _rules = _rp.read_text(encoding="utf-8", errors="replace")[:8_000].strip()
                            if _rules:
                                system_prefix = f"--- Project Rules ---\n{_rules}\n---\n\n"
                    except OSError:
                        pass
                    break

    base_sys = settings.get("system_prompt", "You are a helpful AI coding assistant.")
    if system_prefix or system_suffix:
        sep = "" if (not system_prefix or system_prefix.endswith("\n")) else "\n"
        settings["system_prompt"] = (
            f"{system_prefix}{sep}{base_sys}" + (f"\n\n{system_suffix}" if system_suffix else "")
        )

    async def _run_chat(sid=session_id, msgs=messages, ws_path=workspace_path, s=settings):
        from .ai_chat_tools import run_agent_loop
        async def _emit(event_type, data):
            await app.broadcast(make_event(event_type, data))
        try:
            await run_agent_loop(s, msgs, ws_path, sid, _emit)
        except Exception as e:
            await app.broadcast(make_event("ai.chat.error", {"session_id": sid, "message": str(e)}))

    task = asyncio.create_task(_run_chat())
    session._chat_tasks.add(task)
    task.add_done_callback(session._chat_tasks.discard)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "session_id": session_id}))


@handler("ai.chat.accept_edit")
async def ai_chat_accept_edit(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path", "") or ""
    file_path = payload.get("file_path", "") or ""
    new_content = payload.get("new_content", "") or ""
    result = await asyncio.to_thread(app.fs_service.write_file, ws_path, file_path, new_content)
    await session.send_json(make_response(msg_id, msg_type, result))
    if result.get("ok"):
        asyncio.create_task(app.broadcast(make_event("git.changed", {"workspace_path": ws_path})))


@handler("ai.chat.approve_command")
async def ai_chat_approve_command(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .ai_chat_tools import approve_command
    approve_command(
        str(payload.get("session_id", "")),
        str(payload.get("tool_id", "")),
        approved=True,
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("ai.chat.reject_command")
async def ai_chat_reject_command(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from .ai_chat_tools import approve_command
    approve_command(
        str(payload.get("session_id", "")),
        str(payload.get("tool_id", "")),
        approved=False,
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("ai.chat.stop")
async def ai_chat_stop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    for t in list(session._chat_tasks):
        t.cancel()
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("ai.enhance_prompt")
async def ai_enhance_prompt(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    _ep_system = (payload.get("system") or "").strip()
    _ep_prompt = (payload.get("prompt") or "").strip()[:4000]
    _ep_model = (payload.get("model") or "").strip()
    _ep_provider = (payload.get("provider") or "").strip()
    if not _ep_prompt:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "prompt is required"))
    else:
        try:
            from .ai_chat_service import stream_chat
            # Use a shallow copy of AI chat settings, overriding model if specified.
            # (Session has no .settings attribute — reading it raised AttributeError
            # on every call, so enhance_prompt always returned ok=False.)
            _ep_settings = dict(app.ai_chat_settings_store.get())
            if _ep_provider:
                _ep_settings["provider"] = _ep_provider
            if _ep_model:
                _ep_settings["model"] = _ep_model
            _ep_content = ""
            async with asyncio.timeout(30):
                async for _ep_chunk in stream_chat(
                    settings=_ep_settings,
                    messages=[{"role": "user", "content": _ep_prompt}],
                    system=_ep_system,
                    max_tokens=1024,
                ):
                    if _ep_chunk.startswith("\x00"):
                        break  # DONE or TOOL sentinel
                    _ep_content += _ep_chunk
            await session.send_json(make_response(msg_id, msg_type, {"ok": True, "content": _ep_content.strip()}))
        except Exception as _ep_exc:
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(_ep_exc)}))


@handler("ai.web.search")
async def ai_web_search(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    query = (payload.get("query") or "").strip()[:200]
    if not query:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", "query is required"))
    else:
        try:
            import httpx as _httpx
            from html.parser import HTMLParser as _HTMLParser

            class _DDGLiteParser(_HTMLParser):
                """Parse DuckDuckGo Lite HTML to extract search results."""
                def __init__(self) -> None:
                    super().__init__()
                    self.results: list[dict] = []
                    self._in_result = False
                    self._cur: dict = {}
                    self._capture: str | None = None

                def handle_starttag(self, tag: str, attrs: list) -> None:
                    amap = dict(attrs)
                    # Result links in DDG Lite are <a class="result-link">
                    if tag == "a" and "result-link" in (amap.get("class") or ""):
                        self._cur = {"url": amap.get("href", ""), "title": "", "snippet": ""}
                        self._in_result = True
                        self._capture = "title"
                    elif tag == "td" and self._in_result and "result-snippet" in (amap.get("class") or ""):
                        self._capture = "snippet"

                def handle_endtag(self, tag: str) -> None:
                    if tag == "a" and self._capture == "title":
                        self._capture = None
                    elif tag == "td" and self._capture == "snippet":
                        self._capture = None
                        if self._cur.get("url"):
                            # Strip accumulated whitespace now that the field is complete
                            self._cur["title"] = self._cur.get("title", "").strip()
                            self._cur["snippet"] = self._cur.get("snippet", "").strip()
                            self.results.append(self._cur)
                        self._in_result = False
                        self._cur = {}

                def handle_data(self, data: str) -> None:
                    if self._capture and self._cur:
                        # Accumulate without stripping — strip only when finalising
                        self._cur[self._capture] = self._cur.get(self._capture, "") + data

            results: list[dict] = []
            headers = {
                "User-Agent": "Mozilla/5.0 (compatible; AgentTeamIDE/1.0)",
                "Accept-Language": "en-US,en;q=0.9",
            }
            async with _httpx.AsyncClient(timeout=10.0, follow_redirects=True) as _hc:
                # Primary: DDG Lite HTML (proper search results, no API key)
                try:
                    lite_resp = await _hc.get(
                        "https://lite.duckduckgo.com/lite/",
                        params={"q": query, "kl": "us-en"},
                        headers=headers,
                    )
                    lite_resp.raise_for_status()
                    parser = _DDGLiteParser()
                    parser.feed(lite_resp.text)
                    results = parser.results[:7]
                except Exception:
                    pass
                # Fallback: DDG Instant Answers API
                if not results:
                    ia_resp = await _hc.get(
                        "https://api.duckduckgo.com/",
                        params={"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"},
                        headers=headers,
                    )
                    ia_resp.raise_for_status()
                    data = ia_resp.json()
                    if data.get("AbstractText"):
                        results.append({"title": data.get("Heading", query), "snippet": data["AbstractText"], "url": data.get("AbstractURL", "")})
                    for item in (data.get("RelatedTopics") or [])[:6]:
                        if isinstance(item, dict) and item.get("Text"):
                            results.append({"title": item.get("Text", "")[:80], "snippet": item.get("Text", ""), "url": item.get("FirstURL", "")})

            await session.send_json(make_response(msg_id, msg_type, {"query": query, "results": results[:7]}))
        except Exception as _e:
            await session.send_json(make_error(msg_id, msg_type, "SEARCH_ERROR", str(_e)))


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
    settings = {**app.ai_chat_settings_store.get()}

    async def _run_review(rid=review_id, m=mode, b=base, c=compare, s=settings, ws=ws_path):
        import re as _re
        import json as _json
        from .review_service import stream_review
        try:
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
            async for chunk in stream_review(s, diff, truncated=_truncated):
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

    metadata = payload.get("metadata") or {}
    agent_key = payload.get("agent_key") or ""
    env = dict(payload.get("env") or {})
    await app._ensure_fresh_path_for_spawn(agent_key)
    payload["command"] = app._command_with_persisted_cli_binary(
        agent_key, payload.get("command")
    )
    startup_probe = await asyncio.to_thread(
        app._probe_agent_cli_for_spawn, agent_key, payload.get("command")
    )
    if startup_probe:
        metadata["startup_probe"] = startup_probe
    # The vendor's own auto-update switch, only when the user opted out of it.
    env.update(app.onboarding_deps.spawn_env_for(agent_key))
    # CLI accounts share the real home — regular spawns get no profile env
    # isolation (sessions and settings are global; profiles only swap
    # credentials). Two account-driven exceptions:
    #   - a LOGIN pane (login_profile_id set) runs the CLI inside the profile's
    #     isolated login home, so completing the login never touches the live
    #     credentials or any running pane; the usage poller later harvests the
    #     home into the profile's slot (see credential_vault.harvest_login_home)
    #   - while a managed claude account is active, inherited Anthropic API
    #     overrides are dropped so they can't shadow its OAuth login
    env_remove: list[str] | None = None
    profile_plan = None
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
    elif agent_key in PROFILE_AGENT_KEYS:
        # A regular pane on a managed account (a non-null default profile) runs
        # its CLI config home relocated into that account's persistent isolated
        # home, seeded from the profile's credential slot. This keeps the
        # account's sessions/settings apart from the real home and from other
        # accounts. The log readers, attribution and resume preflight all
        # enumerate these homes (profile_config_homes), so the pane's sessions
        # stay read, attributed and resumable — the crash-loop guard of
        # pitfalls.md. Default (null profile) leaves the spawn on the real home.
        #
        # Profile pin: a restore carries the pane's recorded profile_id in
        # metadata, so the pane re-spawns in the SAME account it was created on
        # regardless of the current active default — a later account switch must
        # not migrate a running/resumed pane's home out from under its session
        # (the cross-profile resume crash-loop). A fresh spawn has no pin and
        # binds to the active default; "__default__" pins to the unmanaged real
        # home; an unknown pin (deleted account) falls back to the real home.
        pinned_profile_id = str(metadata.get("profile_id") or "")
        if pinned_profile_id == DEFAULT_SLOT_ID:
            profile = None
        elif pinned_profile_id:
            profile = app.cli_profiles_store.get(pinned_profile_id)
        else:
            profile = app.cli_profiles_store.get_default_profile(agent_key)
        if profile is not None:
            profile_plan = await asyncio.to_thread(
                app.credential_vault.prepare_profile_home, agent_key, profile["id"]
            )
            env.update(profile_plan.env_set)
            if profile_plan.env_remove:
                env_remove = list(profile_plan.env_remove)
            # Watch the new home right away (rescan would catch it eventually).
            app._watch_profile_home(agent_key, profile["id"])
    if agent_key == "codex" and not login_profile_id:
        # Compatibility: `codex resume <id>` only works inside the home
        # that recorded the session. Resume in whichever home owns it;
        # only unknown/fresh sessions get a (new) per-pane home.
        resume_id = app._codex_resume_id(payload.get("command"))
        session_home = (
            app.codex_home_manager.find_session_home(resume_id) if resume_id else None
        )
        if session_home is None:
            home_id = str(metadata.get("session_home_id") or payload["pane_id"])
            if profile_plan is not None and profile_plan.codex_source_home is not None:
                codex_home = app.codex_home_manager.prepare(
                    home_id, source_home=profile_plan.codex_source_home
                )
            else:
                codex_home = app.codex_home_manager.prepare(home_id)
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
        payload["command"] = app.plugin_wiring.apply_spawn_wiring(
            app.plugin_host, agent_key, payload["command"]
        )
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
    # Claim immediately. A CLI can die while attribution registration is
    # still running; its terminal.exit must still reach this renderer.
    app._PTY_OWNERS[term.id] = session
    # Register the pane with the log-attribution layer so any session
    # file appearing after this point can be attributed back to us.
    if agent_key in ("claude", "codex", "antigravity", "grok", "kimi"):
        ws_for_pane = str(metadata.get("workspace_path") or payload["cwd"])
        # Workspace registration via helper triggers a force-rescan
        # if the workspace is newly known — so historic CLI sessions
        # in that workspace's folder appear in the panel right away.
        app._register_workspace_and_backfill(ws_for_pane)
        explicit_session_id = str(metadata.get("explicit_session_id") or "")
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
        # A re-created pane (renderer reload respawn keeps its pane id)
        # must not lose its fresh registration to a pending grace-period
        # cleanup from the previous PTY's exit.
        app._cancel_pane_unregister(term.pane_id)
        # register_pane's baseline scan enumerates the vendor's whole
        # session-file tree — run it off-loop (register_pane is
        # thread-safe via attribution._lock) so the create ack below
        # isn't delayed past the frontend's timeout. Awaited so the
        # pane is registered before the ack, as before.
        await asyncio.get_running_loop().run_in_executor(
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
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "terminal_session_id": term.id,
                "pane_id": term.pane_id,
                "pid": term.proc.pid,
                "command": term.command,
                "startup_probe": startup_probe,
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
    pane_id_for_unreg = ""
    for sess in session.terminals._sessions.values():  # noqa: SLF001
        if sess.id == term_session_id:
            pane_id_for_unreg = sess.pane_id
            break
    await session.terminals.kill(term_session_id, force=force)
    if pane_id_for_unreg:
        app.attribution.unregister_pane(pane_id_for_unreg)
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

    Unlike project.rename_pane this never touches the spawn-history layers,
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
    "older_than" (removed entries spawned before cutoff_iso). Record-only —
    a live pane is never killed, only its history entry disappears. Peers
    get the updated mirror via project.ui_state_changed.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    mode = payload.get("mode")
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
        deleted_ids, total = app.spawn_history_store.delete_entries(
            ws_raw, mode=mode, pane_ids=pane_ids, cutoff_iso=cutoff_iso, seed=seed
        )
        # Keep the project.json mirror consistent: drop exactly the entries
        # the store deleted (the store is a superset of the mirror after the
        # seed migration above, so filtering by id is complete).
        if deleted_ids and project is not None and project.ui_spawn_history:
            gone = set(deleted_ids)
            mirror = [
                e
                for e in project.ui_spawn_history
                if not (isinstance(e, dict) and e.get("paneId") in gone)
            ]
            project = app.project_store.set_ui_state(ws_raw, spawn_history=mirror)
        return deleted_ids, total, project

    deleted_ids, total, project = await asyncio.to_thread(_delete)
    if deleted_ids and project is not None:
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
    await session.send_json(
        make_response(msg_id, msg_type, {"deleted": len(deleted_ids), "total": total})
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


# ── AI Chat connection test (ai.chat.test_connection) ────────────────────────
@handler("ai.chat.test_connection")
async def ai_chat_test_connection(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    _tc_provider = (payload.get("provider") or "").strip()
    _tc_key = (payload.get("api_key") or "").strip()
    _tc_base_url = (payload.get("base_url") or "").strip().rstrip("/")
    _tc_ollama_url = (payload.get("ollama_base_url") or "http://localhost:11434").strip().rstrip("/")
    _tc_ok = False
    _tc_err = ""
    try:
        import httpx as _httpx
        if _tc_provider == "anthropic":
            import anthropic as _ant
            _ant_client = _ant.AsyncAnthropic(api_key=_tc_key or None)
            async with asyncio.timeout(10):
                await _ant_client.models.list(limit=1)
            _tc_ok = True
        elif _tc_provider == "ollama":
            async with _httpx.AsyncClient(timeout=8.0) as _hc:
                _r = await _hc.get(f"{_tc_ollama_url}/api/tags")
                _r.raise_for_status()
            _tc_ok = True
        else:
            from .ai_chat_service import _OPENAI_COMPAT_CONFIGS
            _cfg = _OPENAI_COMPAT_CONFIGS.get(_tc_provider, {})
            if "base_url_field" in _cfg:
                _url = _tc_base_url
            else:
                _url = _cfg.get("base_url", "")
            if not _url:
                raise ValueError(f"No base URL for provider '{_tc_provider}'")
            _headers: dict = {}
            if _tc_key:
                _headers["Authorization"] = f"Bearer {_tc_key}"
            async with _httpx.AsyncClient(timeout=8.0) as _hc:
                _r = await _hc.get(f"{_url}/models", headers=_headers)
                _r.raise_for_status()
            _tc_ok = True
    except Exception as _e:
        _tc_err = str(_e)
    await session.send_json(make_response(msg_id, msg_type, {"ok": _tc_ok, "error": _tc_err}))


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
