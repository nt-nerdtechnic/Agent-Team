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
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from pydantic import ValidationError

from . import (
    agent_messaging,
    confirm_token,
    device_trust,
    executions_service,
    native_mcp,
    native_memory,
    pane_policy,
    remote_roster,
    server_link,
    storage_service,
    trust_store,
)
from .cli_vendors.codex import command_with_resume_id as codex_command_with_resume_id
from .cli_vendors.registry import VENDORS as CLI_VENDORS
from .cli_vendors.registry import vendor as cli_vendor
from .ipc import make_error, make_event, make_response
from .log_readers.claude import ClaudeLogReader, first_user_prompts
from .credential_vault import DEFAULT_SLOT_ID, vault_to_thread
from .host_shell import parse_public_allowlisted_command, run_public_allowlisted_text
from .mcp_settings import (
    MCPSettingsConflictError,
    MCPSettingsError,
    restore_mcp_server_secrets,
)
from .plan_index import resolve_plan_root
from .profiles_store import SUPPORTED_AGENT_KEYS as PROFILE_AGENT_KEYS
from .skills_store import (
    SkillConflictError,
    SkillConsentRequired,
    SkillNotFoundError,
    SkillValidationError,
    SkillsStoreError,
)
from .spawn_history import (
    canonical_workspace_path,
    filter_foreign_entries,
    read_pane_transcript,
    TRANSCRIPT_MAX_BYTES,
    TRANSCRIPT_CHUNK_CHARS,
)

if TYPE_CHECKING:
    from .app import Session
    from .projects import Project

Handler = Callable[["Session", str, str, dict], Awaitable[None]]

_REGISTRY: dict[str, Handler] = {}

# Diagnostics forwarded from the renderer (see the client.diagnostic handler).
# Its own logger so a reader can tell at a glance which half of the app a line
# came from, since the two halves now share one file.
client_log = logging.getLogger("agent_team_backend.client")
#: This module's own log, for decisions it makes rather than for what a
#: client said. Kept separate so a client cannot make its own noise look
#: like the backend's.
log = logging.getLogger(__name__)

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
# Workers: probes are subprocess-bound, not CPU-bound — the thread spends its
# budget waiting on a child process — so this pool is sized by the burst it
# must absorb, not by core count. Fresh spawns are not throttled frontend-side
# (only resumes are), so a fan-out arrives all at once. With an 8s probe budget
# against the frontend's 30s terminal.create timeout, each worker clears ~3
# panes before that deadline, so N workers absorb a ~3N burst. Eight covered
# the old 8-pane-per-workspace cap with room to spare; that cap is gone (see
# agentSpawnGate.ts — spawn quotas are advisory now), so a burst is bounded by
# what the user asks for rather than by a constant. Thirty-two keeps a ~96-pane
# fan-out inside the timeout, which is far past where per-CLI memory
# (~150-440MB each) becomes the real ceiling.
_CLI_PROBE_EXECUTOR = ThreadPoolExecutor(
    max_workers=32, thread_name_prefix="cli-probe"
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
    # Registering a watch resolves the path and schedules a recursive observer —
    # blocking syscalls that stall for minutes on a slow/network mount, so it
    # goes to a worker thread too. Awaited, not fired off: the watch must be in
    # place before the scan below reports the tree it is watching.
    await asyncio.to_thread(app._watch_plans_workspace, ws_path, rel)
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
    await asyncio.to_thread(
        app._watch_plans_workspace, ws_path, payload.get("rel_path", "") or ""
    )
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
    await asyncio.to_thread(
        app._watch_plans_workspace, ws_path, payload.get("rel_path", "") or ""
    )
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


# ── Plan documents (plans.*) ────────────────────────────────────────────────
# One scan of every plan/report directory, carrying the meta the caller parsed
# last time whenever the file has not changed since. Replaces a per-directory
# fs.list_dir fan-out plus one fs.read_file per document on every refresh.
@handler("plans.list_docs")
async def plans_list_docs(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Plans live in the project root (plan_provisioning writes the spec there,
    # and every writer resolves to it), so a workspace opened on a
    # subdirectory must look up to find them — otherwise a plan an agent just
    # created is invisible in the very window that asked for it. `root` goes
    # back with the list because rel_path is relative to it, and fs.read_file
    # refuses to escape the workspace it is given.
    ws_path = await asyncio.to_thread(
        resolve_plan_root, str(payload.get("workspace_path") or "")
    )
    await asyncio.to_thread(app._watch_plans_workspace_now, ws_path)
    result = await asyncio.to_thread(app.plan_index.list_docs, ws_path)
    if isinstance(result, dict) and result.get("ok"):
        result["root"] = ws_path
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("plans.resolve_root")
async def plans_resolve_root(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The project root a workspace's plans live in — see plans.list_docs.

    For a surface that opens one plan without listing first (the plan window
    launched straight at a rel_path), which would otherwise resolve that path
    against a workspace the file is not under.
    """
    ws_path = await asyncio.to_thread(
        resolve_plan_root, str(payload.get("workspace_path") or "")
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "root": ws_path}))


@handler("plans.cache_put")
async def plans_cache_put(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    # Same root as the scan that produced these entries, or the cache keys
    # would never match on the next list.
    ws_path = await asyncio.to_thread(
        resolve_plan_root, str(payload.get("workspace_path") or "")
    )
    result = await asyncio.to_thread(
        app.plan_index.cache_put, ws_path, payload.get("entries")
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
        await asyncio.to_thread(app._git_watcher.watch, ws_path)
    include_ignored = bool(payload.get("include_ignored", False))
    result = await app.git_service.get_status(ws_path, include_ignored=include_ignored)
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("git.discover_repositories")
async def git_discover_repositories(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    max_depth = min(int(payload.get("max_depth", 3)), 8)
    limit = min(int(payload.get("limit", 20)), 100)
    force = bool(payload.get("force", False))
    result = await app.git_service.discover_repositories(
        ws_path, max_depth=max_depth, limit=limit, force=force
    )
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
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
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
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
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
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
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
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
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
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
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
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        credential=app._git_credential(payload),
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
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
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
        on_credential_request=app.build_credential_request_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
        on_credential_settled=app.build_credential_settled_emitter(
            ws_path, str(payload.get("credential_owner_nonce") or "")
        ),
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


def _profile_account_view() -> dict:
    """``{"identities": {agentKey: {slotId: {email, signedIn}}},
    "duplicates": {agentKey: {slotId: {email, slotIds}}}}`` for every account
    row the UI shows. ``__default__`` keys the built-in Default row.

    ``identities`` is what a row displays: the active slot's identity comes
    from the live credential state (slot storage lags live until the next
    capture/harvest).

    ``duplicates`` answers a different question — which rows hold the SAME
    account — and so compares slot snapshots only, the active row included:
    the live state belongs to exactly one account, and reading it for the
    active row would make that row duplicate whichever row actually stores
    the account. Emails match case-insensitively; a snapshot carrying no email
    (kimi, an empty ``__default__``, a claude login with no ``oauthAccount``)
    names no account and takes no part. Every slot of a duplicated account is
    listed, its own included, ``__default__`` among them — that row stores a
    snapshot and can be deleted like any other.

    Blocking reads (files, plus the Keychain for claude secrets) — run in a
    thread."""
    from . import app

    doc = app.cli_profiles_store.list()
    identities: dict[str, dict] = {}
    duplicates: dict[str, dict] = {}
    for agent_key in PROFILE_AGENT_KEYS:
        active = doc["defaults"].get(agent_key) or DEFAULT_SLOT_ID
        slot_ids = [DEFAULT_SLOT_ID] + [
            p["id"] for p in doc["profiles"] if p.get("agentKey") == agent_key
        ]
        rows: dict[str, dict] = {}
        groups: dict[str, list[str]] = {}
        labels: dict[str, str] = {}
        for sid in slot_ids:
            snapshot = app.credential_vault.identity(agent_key, sid)
            rows[sid] = (
                app.credential_vault.identity(agent_key, None)
                if sid == active
                else snapshot
            )
            email = snapshot.get("email")
            if not isinstance(email, str) or not email:
                continue
            key = email.casefold()
            groups.setdefault(key, []).append(sid)
            labels.setdefault(key, email)
        identities[agent_key] = rows
        dupes = {
            sid: {"email": labels[key], "slotIds": ids}
            for key, ids in groups.items()
            if len(ids) > 1
            for sid in ids
        }
        if dupes:
            duplicates[agent_key] = dupes
    return {"identities": identities, "duplicates": duplicates}


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
    view = await asyncio.to_thread(_profile_account_view)
    payload = {
        "profiles": doc["profiles"],
        "defaults": doc["defaults"],
        "identities": view["identities"],
        # Account rows storing the same login as another row of the same agent
        # — the Accounts pane flags them so the user can delete the spare.
        "duplicates": view["duplicates"],
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
    view = await asyncio.to_thread(_profile_account_view)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "profiles": doc["profiles"],
                "defaults": doc["defaults"],
                "identities": view["identities"],
                "duplicates": view["duplicates"],
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


# CLIs that consult their credential source on every request instead of
# caching it in memory for the life of the process. Their live panes pick the
# swapped-in account up on their next turn, so an account switch needs neither
# the quiescence gate nor a pane restart. Verified by decompiling Claude Code
# 2.1.223: the client factory awaits a credential re-read before every request,
# and that re-read happens BEFORE the token-expiry check — see
# .agent-team/plans/cli-claude-hot-swap_abd651.html. codex caches auth in
# memory (AuthManager::auth_cached) and reloads only on 401 recovery; kimi and
# grok are unaudited. Add an agent here only with the same kind of evidence.
HOT_SWAP_AGENTS = frozenset({"claude"})

# Switching accounts is a manual, deliberate action. These bounds exist so it
# stays one: without the quiescence gate a hot-swap agent has no friction left,
# and unbounded programmatic switching would turn multi-account support into
# automatic rotation ("swap when the quota runs low"), which is a different
# thing from using several accounts. Deliberately loose — hands never reach it.
SWITCH_RATE_WINDOW_S = 60.0
SWITCH_RATE_MAX = 3
_switch_history: dict[str, list[float]] = {}


def _switch_rate_retry_after(agent_key: str) -> float:
    """Seconds until this agent may switch again; 0.0 while within quota.
    Prunes the window as a side effect. Callers hold the agent's switch_lock,
    so no extra synchronization is needed."""
    now = time.monotonic()
    recent = [t for t in _switch_history.get(agent_key, []) if now - t < SWITCH_RATE_WINDOW_S]
    _switch_history[agent_key] = recent
    if len(recent) < SWITCH_RATE_MAX:
        return 0.0
    return SWITCH_RATE_WINDOW_S - (now - recent[0])


def _record_switch(agent_key: str) -> None:
    """Count one completed switch against the rate window. Only swaps that
    actually happened are recorded — a no-op or a refused switch does not
    consume quota."""
    _switch_history.setdefault(agent_key, []).append(time.monotonic())


def _running_regular_terminals(agent_key: str) -> list[str]:
    """Terminal ids of every live NON-login pane of the given agent. Every
    regular pane runs on the live credentials in the real home — the very
    credentials an account switch swaps. For agents outside HOT_SWAP_AGENTS
    the CLI holds those credentials in memory for the life of the process, so
    a pane that keeps running after a swap stays on the outgoing account until
    it is restarted."""
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


def _slot_login_reason(agent_key: str, slot_id: str) -> str | None:
    """Why restoring this slot leaves the CLI unable to authenticate, or None
    when it can. The caller starts a sign-in for any reason it returns.

    Two shapes, and the difference is worth telling the user. ``signed-out``:
    the slot holds no secret at all (restore() then CLEARS the live credentials
    — an empty slot signs the user out), or claude's snapshot was wiped in place
    by Claude Code (both tokens emptied after an ``invalid_grant``, so it
    restores as a non-credential). ``expired``: claude's snapshot sat parked
    long enough for its access token to expire. Nothing renews a parked slot —
    the CLI is the only refresher — so the expired token goes live and Claude
    Code renews it from the restored refresh token on its next run; offering a
    sign-in is the fallback for when that refresh token is dead too, which is
    why this case must not be announced as "signed out". A claude login with no
    OAuth block (long-lived token) carries nothing to judge, so it counts as
    usable. Blocking reads (Keychain) — thread it."""
    from . import app
    from .credential_vault import _claude_credential_is_wiped
    from .usage_service import claude_token_expired, parse_claude_credentials

    try:
        creds = app.credential_vault.read_slot(agent_key, slot_id)
    except Exception:  # noqa: BLE001 — a read failure must not invent a logout
        return None
    if creds.secret is None:
        return "signed-out"
    if agent_key != "claude":
        return None
    # A wiped blob parses as "no OAuth block to judge", which the expiry check
    # below would pass as usable — catch it before that.
    if _claude_credential_is_wiped(creds.secret):
        return "signed-out"
    oauth = parse_claude_credentials(creds.secret)
    if oauth is not None and claude_token_expired(oauth):
        return "expired"
    return None


@handler("cli_profiles.set_default")
async def cli_profiles_set_default(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Switch the agent's active account: capture the live credentials into the
    outgoing account's slot, then restore the target slot into the real home.

    Three ways it can be refused. Every switch is rate limited
    (SWITCH_RATE_LIMITED, not bypassable). Agents outside HOT_SWAP_AGENTS are
    additionally gated on quiescence, because their live panes hold the
    outgoing credentials in memory: live non-login panes fail with
    PANES_RUNNING unless the request carries force=true (the frontend then
    restarts the affected panes itself — the backend never kills them).
    A still-running isolated sign-in for the target account blocks it
    (LOGIN_IN_PROGRESS), because the switch harvests its login home into the
    slot before restoring it.

    Hot-swap agents skip the quiescence gate and never get the restart
    broadcast: their CLI re-reads the credential source every request, so live
    panes land on the new account by themselves."""
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

        # Rate limit: keeps account switching a manual action (see the
        # SWITCH_RATE_* constants). Checked before anything is touched, and
        # deliberately NOT bypassable by force — force means "I accept the pane
        # restart", not "let me switch as fast as I like".
        retry_after = _switch_rate_retry_after(agent_key)
        if retry_after > 0:
            await session.send_json(
                make_error(
                    msg_id, msg_type, "SWITCH_RATE_LIMITED",
                    f"too many {agent_key} account switches; retry in "
                    f"{retry_after:.0f}s",
                    {"retryAfter": retry_after},
                )
            )
            return

        # Quiescence gate: outside HOT_SWAP_AGENTS a live regular pane holds
        # the outgoing account's credentials in memory and stays on them until
        # it restarts. Refuse unless the caller forces the switch (it then
        # restarts the affected panes itself; the backend never kills them).
        # Hot-swap agents re-read their credential source every request, so
        # their panes need neither the gate nor a restart.
        if agent_key not in HOT_SWAP_AGENTS and not payload.get("force"):
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
        login_reason = await vault_to_thread(
            _slot_login_reason, agent_key, profile_id or DEFAULT_SLOT_ID
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

        # The credentials moved — count it, whatever happens to the bookkeeping
        # below (a persisted-default failure still leaves the new account live).
        _record_switch(agent_key)

        try:
            defaults = app.cli_profiles_store.set_default(agent_key, profile_id)
        except (KeyError, ValueError) as err:
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", _profile_error(err))
            )
            return
        await session.send_json(
            make_response(msg_id, msg_type, {
                "defaults": defaults,
                "needsLogin": login_reason is not None,
                # Which of the two is on screen decides whether the sign-in
                # pane reads as "you were logged out" or "this needs
                # re-authenticating" — the latter is routine after parking.
                "needsLoginReason": login_reason,
            })
        )
    # `forced` is what makes every window restart its panes of this agent. A
    # hot-swap agent's panes must never be restarted, so the flag stays False
    # for them even when the caller passed force=true.
    await _broadcast_profiles_changed(
        "set_default",
        agent_key=agent_key,
        forced=agent_key not in HOT_SWAP_AGENTS and bool(payload.get("force")),
    )
    # The usage badges read the active account's credentials — force the poller
    # to re-fetch now so the badge reflects the switch immediately.
    from .usage_service import service

    if agent_key == "claude":
        # A Claude read boots a whole CLI, so "immediately" is tens of seconds
        # away. Announce the new active account and mark it as being read, or
        # the badge sits on the outgoing account's numbers with no sign why.
        # An account that has to sign in first gets the pointer but not the
        # promise: "reading its quota" next to a login pane is a contradiction.
        try:
            await service.announce_claude_switch(profile_id, reading=login_reason is None)
        except Exception:  # noqa: BLE001
            # The switch itself already succeeded and was answered. Letting this
            # escape would send a second, contradictory frame for a message the
            # caller has resolved; the worst real cost is a badge that waits for
            # the next poll, which is where it was before this announcement.
            app.log.exception("usage: failed to announce the claude account switch")
    else:
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
    # The servers each CLI already loads on its own. Scanning reads the user's
    # config files and reports its own failures per file, so it never raises;
    # a thread keeps that file I/O off the loop.
    native = await asyncio.to_thread(native_mcp.scan)
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
                "native": [server.as_dict() for server in native],
                "agents": native_mcp.agent_targets(),
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
    kwargs: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    try:
        return await asyncio.to_thread(operation, *args, **(kwargs or {}))
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
    except SkillConsentRequired as err:
        # Not a failure: the UI asks the user, then retries with consent=True.
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "SKILL_CONSENT_REQUIRED",
                str(err),
                {"root": err.root},
            )
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
        kwargs={"consent": payload.get("consent") is True},
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


@handler("skills.set_targets")
async def skills_set_targets(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Restrict one skill to a set of agents; a null ``agents`` means all."""
    from . import app

    name = payload.get("name", "")
    agents = payload.get("agents")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.set_targets,
        name,
        agents,
        name=name,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


def _set_native_targets_op(store: Any, real_path: str, agents: Any) -> dict[str, Any]:
    store.set_native_targets(real_path, agents)
    return {"ok": True}


@handler("skills.set_native_targets")
async def skills_set_native_targets(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Deliver a CLI's own skill to other agents; keyed by real path, opt-in."""
    from . import app

    real_path = payload.get("real_path", "")
    agents = payload.get("agents")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        _set_native_targets_op,
        app.skills_store,
        real_path,
        agents,
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.migrate_native")
async def skills_migrate_native(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Move a CLI's own skill into ~/.agents/skills, leaving a link behind.

    Consent is per item and never remembered: it must arrive on every call."""
    from . import app

    real_path = payload.get("real_path", "")
    result = await _run_skill_operation(
        session,
        msg_id,
        msg_type,
        app.skills_store.migrate_native,
        real_path,
        kwargs={"consent": payload.get("consent") is True},
    )
    if result is not None:
        await session.send_json(make_response(msg_id, msg_type, result))


@handler("skills.restore_native")
async def skills_restore_native(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Undo a migration: the skill goes back where it came from."""
    from . import app

    name = payload.get("name", "")
    result = await _run_skill_operation(
        session, msg_id, msg_type, app.skills_store.restore_native, name, name=name
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


# ── CLI instruction files (memory.*) ────────────────────────────────────────
def _memory_workspace(payload: dict) -> Path | None:
    """The workspace root a memory request is scoped to, or None.

    Project-scoped instruction files belong to the folder the user has open,
    so every memory handler takes the workspace from the caller. An absent or
    non-directory path yields None, which limits the request to user scope
    rather than failing it — a window with no workspace still has a home.
    """
    raw = str(payload.get("workspace_path") or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_dir() else None


@handler("memory.list")
async def memory_list(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    workspace = _memory_workspace(payload)
    # The scan stats every candidate in the home and the workspace; a thread
    # keeps that file I/O off the loop, as the native MCP scan does.
    files = await asyncio.to_thread(native_memory.scan, None, workspace)
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "files": [f.as_dict() for f in files],
                "agents": native_memory.agent_targets(),
                "workspace_path": str(workspace) if workspace else "",
            },
        )
    )


@handler("memory.get")
async def memory_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    workspace = _memory_workspace(payload)
    path = str(payload.get("path") or "")
    try:
        result = await asyncio.to_thread(native_memory.read, path, None, workspace)
    except ValueError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_REJECTED", str(err), {"path": path})
        )
        return
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_READ_FAILED", str(err), {"path": path})
        )
        return
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("memory.save")
async def memory_save(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    workspace = _memory_workspace(payload)
    path = str(payload.get("path") or "")
    text = payload.get("text")
    if not isinstance(text, str):
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_REJECTED", "text is required", {"path": path})
        )
        return
    expected_raw = payload.get("expected_modified")
    expected = float(expected_raw) if isinstance(expected_raw, (int, float)) else None
    try:
        result = await asyncio.to_thread(
            native_memory.save, path, text, None, workspace, expected
        )
    except native_memory.MemoryConflictError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_CONFLICT", str(err), {"path": path})
        )
        return
    except ValueError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_FILE_REJECTED", str(err), {"path": path})
        )
        return
    except OSError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "MEMORY_WRITE_FAILED", str(err), {"path": path})
        )
        return
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


async def _reinstall_claude_hooks() -> None:
    """Re-run claude's hook installer after its push-channel switch moved.

    Claude's channel is not something Navide holds — it is an entry in the
    user's own settings file, written by the installer, which otherwise runs
    only at startup. Without this the entry would appear or disappear a backend
    restart late, and switching the channel back on would promise a waiter that
    has no hook to come from. Same call the startup installer makes; the
    installer itself decides whether the rewake entry belongs, so both
    directions are this one call.

    A pane already running fired up with whatever the file said then, so this
    reaches the next CLI start, not the panes open now. Failure is logged and
    swallowed: the setting was already written, and the old behaviour — the
    hook settling at the next restart — is what a failure falls back to.
    """
    from . import app
    from .applog import backend_port_file

    spec = CLI_VENDORS.get("claude")
    if spec is None or spec.install_hooks is None:
        return
    try:
        result = await asyncio.to_thread(spec.install_hooks, str(backend_port_file()))
        app.log.info("claude hooks reinstalled after a push-channel switch: %s", result)
    except Exception as err:  # noqa: BLE001
        app.log.warning("claude hooks reinstall failed: %s", err)


@handler("ui.settings.set")
async def ui_settings_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    from . import push_delivery

    updates = payload.get("updates")
    touches_channels = (
        isinstance(updates, dict) and push_delivery.DISABLED_SETTING_KEY in updates
    )
    claude_was_off = (
        "claude" in push_delivery.disabled_agents() if touches_channels else False
    )
    delta = app.ui_settings_store.set(updates) if isinstance(updates, dict) else {}
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))
    if push_delivery.DISABLED_SETTING_KEY in delta:
        # A pane already running keeps its port and its watch file; what changes
        # is whether anything is pushed to it. Both directions are announced —
        # a window told to stop offering a channel would otherwise never start
        # again when the switch goes back on.
        for pane_id, kind, ready in push_delivery.apply_switches():
            await app.broadcast(make_event("agent_msg.push_state", {
                "pane_id": pane_id, "kind": kind, "ready": ready,
            }))
        if ("claude" in push_delivery.disabled_agents()) != claude_was_off:
            await _reinstall_claude_hooks()
    if delta:
        # Other windows (EditorWindow, roles/stages) hold their own ws
        # connections — broadcast the merged delta so their caches
        # converge; the sender already applied it locally.
        await app.broadcast(
            make_event("ui.settings_changed", {"settings": delta}),
            exclude=session,
        )


# ── Cross-device link (p2p.*) ───────────────────────────────────────────────
# The Navide-Server URL lives in ui_settings and its access token in the
# credential vault, so a settings pane that wrote them through the generic
# handlers would need two round trips in the right order — and would still not
# make the link dial, because server_link.start() only runs at boot. These two
# handlers exist so the whole configuration is one write followed by one
# reconnect, and so the token only ever travels toward the vault.
#: Where the pause switch lives. In ui_settings rather than in the link itself:
#: the link is rebuilt on every reconnect and forgets anything it holds, while
#: this has to survive a restart — a switch that quietly turns itself back on is
#: worse than no switch, because the user believes they are disconnected.
LINK_PAUSED_SETTING = "agentTeam.p2p.linkPaused"


def _link_paused() -> bool:
    from . import app

    return bool(app.ui_settings_store.get().get(LINK_PAUSED_SETTING))


@handler("p2p.link.status")
async def p2p_link_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    status = await server_link.status()
    # Reported alongside the link's own state rather than folded into it: paused
    # is a thing the *user* did, and showing it as "unconfigured" or
    # "unreachable" would blame the network for a switch they flipped.
    status["paused"] = _link_paused()
    await session.send_json(make_response(msg_id, msg_type, {"status": status}))


@handler("p2p.link.set_paused")
async def p2p_link_set_paused(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Turn the cross-device link off without forgetting the account.

    Signing out was the only way to stop this machine talking to the server, and
    it throws away the credential — so "I want this off for now" cost the user
    their account on this device. Pausing keeps everything and stops the socket.

    The stop is real: the link is torn down, not merely marked. A switch that
    left the connection open while claiming to be off would be a lie told by the
    one surface whose whole job is telling the truth about the connection.
    """
    from . import app

    paused = bool(payload.get("paused"))
    app.ui_settings_store.set({LINK_PAUSED_SETTING: paused})
    if paused:
        await server_link.stop()
    else:
        await server_link.start()
    status = await server_link.status()
    status["paused"] = paused
    await app.broadcast(make_event("p2p.link.changed", {"status": status}))
    await session.send_json(make_response(msg_id, msg_type, {"status": status}))


@handler("p2p.link.configure")
async def p2p_link_configure(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Store or clear the access token, then reconnect.

    The server address used to be part of this call. It is now built into the
    build (server_link.DEFAULT_SERVER_URL) because there is exactly one service
    to talk to and a typo'd address produced a link that silently never dialled.
    A `serverUrl` sent by an older renderer is accepted and ignored rather than
    rejected, so a stale window cannot fail every save.

    An absent token means "leave it alone" so a caller can reconnect without
    retyping a credential it is never allowed to see; an empty string is not
    absence — it is how the user clears it, which takes the link back to inert.
    """
    from . import app

    token = payload.get("token")
    if token is not None and not isinstance(token, str):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "token must be a string")
        )
        return

    # An install upgrading from the configurable era still carries the address
    # its user typed. Nothing reads it any more, so drop it rather than leave a
    # value that looks like it is in effect.
    delta = app.ui_settings_store.set({server_link.SERVER_URL_SETTING: None})
    if token is not None:
        try:
            await vault_to_thread(server_link.set_access_token, token)
        except Exception as err:  # noqa: BLE001
            await session.send_json(
                make_error(msg_id, msg_type, "P2P_TOKEN_WRITE_FAILED", str(err))
            )
            return

    await server_link.reconfigure()
    await session.send_json(
        make_response(msg_id, msg_type, {"status": await server_link.status()})
    )
    if delta:
        await app.broadcast(make_event("ui.settings_changed", {"settings": delta}))


# Account sign-in. Registering creates an account — a private network of this
# user's own machines; logging in exchanges the password
# for the long-lived device token. Both are the same write as p2p.link.configure
# ends in — url to settings, token to the vault, then reconnect — so the user
# never has to see or handle the token at all.
#
# The password is not stored anywhere and is not echoed back. It exists for the
# duration of one request and is exchanged for a token, which is what a
# previously hand-pasted credential already was.
async def _account_call(
    session: "Session", msg_id: str, msg_type: str, payload: dict, verb: str
) -> None:
    from . import app

    email = payload.get("email")
    password = payload.get("password")
    for name, value in (("email", email), ("password", password)):
        if not isinstance(value, str) or not value.strip():
            await session.send_json(
                make_error(msg_id, msg_type, "BAD_REQUEST", f"{name} is required")
            )
            return
    # The address is the build's, not the caller's — see p2p.link.configure.
    url = await asyncio.to_thread(server_link.server_url)

    request: dict = {"email": email.strip(), "password": password}
    if verb == "auth.register":
        # One optional field, not two: auth.register's signature is
        # (email, password, displayName), so a tenantName sent alongside it was
        # being dropped on the floor by the server rather than doing anything.
        for optional in ("displayName",):
            value = payload.get(optional)
            if isinstance(value, str) and value.strip():
                request[optional] = value.strip()

    try:
        result = await server_link.account_request(url, verb, request)
    except server_link.AccountError as err:
        # Keep the server's own code (EMAIL_TAKEN, AUTH_REJECTED, BAD_REQUEST):
        # the UI tells these apart to decide whether to offer "sign in instead"
        # or just let the user retype the password.
        await session.send_json(make_error(msg_id, msg_type, err.code, err.message))
        return
    except Exception as err:  # noqa: BLE001
        # Anything that stopped the call reaching a server is a link problem,
        # not a credential problem — saying "wrong password" for an unreachable
        # host sends the user to change something that was already right.
        await session.send_json(
            make_error(msg_id, msg_type, "LINK_OFFLINE", str(err) or "server unreachable")
        )
        return

    token = result.get("token")
    if not isinstance(token, str) or not token:
        await session.send_json(
            make_error(msg_id, msg_type, "SERVER_ERROR", "server returned no token")
        )
        return

    delta = app.ui_settings_store.set(
        {
            # Only the signed-in identity is stored; the address is built in and
            # any stale user-entered one is cleared on the way past.
            server_link.SERVER_URL_SETTING: None,
            server_link.ACCOUNT_EMAIL_SETTING: str(result.get("email") or email).strip(),
        }
    )
    try:
        await vault_to_thread(server_link.set_access_token, token)
    except Exception as err:  # noqa: BLE001
        await session.send_json(
            make_error(msg_id, msg_type, "P2P_TOKEN_WRITE_FAILED", str(err))
        )
        return

    await server_link.reconfigure()
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "status": await server_link.status(),
                "account": {
                    "email": result.get("email"),
                    "memberId": result.get("memberId"),
                    "displayName": result.get("displayName"),

                    # Soft gate: a fresh account is unverified and still fully
                    # usable. Carried here as well as in `status` because the
                    # link has only just been told to reconnect — its own
                    # auth.hello answer may not have landed yet, and the modal
                    # has to show the "check your mail" notice now, not in
                    # three seconds.
                    "emailVerified": bool(result.get("emailVerified")),
                    "verificationSent": bool(result.get("verificationSent")),
                },
            },
        )
    )
    if delta:
        await app.broadcast(make_event("ui.settings_changed", {"settings": delta}))


@handler("p2p.account.register")
async def p2p_account_register(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await _account_call(session, msg_id, msg_type, payload, "auth.register")


@handler("p2p.account.login")
async def p2p_account_login(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await _account_call(session, msg_id, msg_type, payload, "auth.login")


@handler("p2p.account.check_verification")
async def p2p_account_check_verification(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """"Clicked the link and nothing happened?" — ask the server right now.

    The link learns whether an address is confirmed at ``auth.hello`` and had no
    second read, so somebody who confirmed in their browser watched "we sent you
    a link" until the next restart. A push and a poll both cover that now; this
    is the same question asked on demand, because the wait is otherwise up to
    half a minute of a person staring at a stale sentence.

    Never an error when the answer is simply "still no": the reply carries what
    this machine now believes, and the caller shows it.
    """
    reply = await server_link.check_verification()
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so there is no account to check",
            )
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_LINK_OFFLINE"),
                str(error.get("message") or "the navide-server link is not available"),
            )
        )
        return
    result = reply.get("payload")
    result = result if isinstance(result, dict) else {}
    await session.send_json(
        make_response(
            msg_id, msg_type, {"emailVerified": bool(result.get("emailVerified"))}
        )
    )


@handler("p2p.account.resend_verification")
async def p2p_account_resend_verification(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Ask the server for a fresh verification mail for the signed-in account.

    Unlike register and login this one rides the existing authenticated link:
    the server decides *which* account from the connection, so there is nothing
    for the caller to name and no way to ask for someone else's mail.

    The server's own codes come straight through — RATE_LIMITED in particular
    means "you already asked in the last minute", which is a thing to show, not
    a thing to retry.
    """
    reply = await server_link.resend_verification()
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so there is no account to verify",
            )
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_VERIFY_RESEND_FAILED"),
                str(error.get("message") or "the navide-server refused the request"),
            )
        )
        return
    result = reply.get("payload")
    result = result if isinstance(result, dict) else {}
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "emailVerified": bool(result.get("emailVerified")),
                "verificationSent": bool(result.get("verificationSent")),
                "status": await server_link.status(),
            },
        )
    )


@handler("p2p.account.logout")
async def p2p_account_logout(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Forget this machine's credential. The server keeps the account.

    The server URL is deliberately left in place: signing out is "not right
    now", not "I will never use this server again", and making the user retype
    the address every time is the kind of friction that gets a feature abandoned.
    """
    from . import app

    try:
        await vault_to_thread(server_link.set_access_token, None)
    except Exception as err:  # noqa: BLE001
        await session.send_json(
            make_error(msg_id, msg_type, "P2P_TOKEN_WRITE_FAILED", str(err))
        )
        return
    delta = app.ui_settings_store.set({server_link.ACCOUNT_EMAIL_SETTING: None})
    await server_link.reconfigure()
    await session.send_json(
        make_response(msg_id, msg_type, {"status": await server_link.status()})
    )
    if delta:
        await app.broadcast(make_event("ui.settings_changed", {"settings": delta}))


# The receiver-side pane policy: who, on another device, may drive a pane on
# this machine. It lives on the server (only this device or an admin may write
# it) and is cached here, so the two handlers below are a read that always
# answers and a write that only a connected link can carry. Neither touches the
# on-machine path — panes on one machine have never consulted this policy.
@handler("p2p.policy.get")
async def p2p_policy_get(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


@handler("p2p.policy.set")
async def p2p_policy_set(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Replace this device's pane policy with the one the editor composed.

    The whole document is written at once because that is the server's only
    write: it stores the policy verbatim and never merges. The editor therefore
    sends back the rules it was shown plus its edit.
    """
    # No device in this one, so "" is what the confirmation is bound to. It
    # still binds the action, which is what stops a token minted to approve a
    # device being spent to replace the rules.
    if not await _confirmed(session, msg_id, msg_type, payload):
        return
    policy = payload.get("policy")
    problem = pane_policy.validate(policy) or device_trust.validate_blocked(policy)
    if problem:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", problem))
        return

    # A document with no `blocked` key is an editor that never had one to send,
    # not somebody asking for the list to be emptied — and the server stores
    # what it is given verbatim, so the difference decides whether every block
    # survives the write. The rules editor composes from the whole cached
    # document and keeps it; the account view's "sign rules now" composes the
    # default for a machine that has no rules at all, and would have dropped it.
    # Absent means keep; only an explicit list clears one.
    if isinstance(policy, dict) and "blocked" not in policy:
        cached = (await server_link.policy_state()).get("policy")
        carried = cached.get("blocked") if isinstance(cached, dict) else None
        if carried:
            log.warning(
                "a policy write arrived with no blocked list; keeping the %d "
                "existing entries rather than clearing them",
                len(carried),
            )
            policy = {**policy, "blocked": carried}

    reply = await server_link.set_policy(policy)
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so this device has no policy to write",
            )
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_POLICY_WRITE_FAILED"),
                str(error.get("message") or "the navide-server rejected the policy"),
            )
        )
        return
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


@handler("p2p.access_requests.list")
async def p2p_access_requests_list(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Who knocked and was refused. Read-only, and answered from memory."""
    await session.send_json(
        make_response(msg_id, msg_type, {"requests": server_link.access_requests()})
    )


@handler("p2p.access_requests.approve")
async def p2p_access_requests_approve(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Turn one refused knock into an ordinary allow rule.

    Deliberately not a second authorization store: after this there is still
    exactly one answer to "may that sender drive that pane", and it is the rule
    set the policy editor shows. Approving is a shortcut for writing the rule a
    person would otherwise have to compose by hand from four opaque ids.

    The grant is as narrow as the knock was — this member, this device, this
    workspace, this pane. Widening it to a wildcard is an edit the user makes
    in the editor, where they can see what they are widening.
    """
    key = str(payload.get("key") or "")
    request = next((r for r in server_link.access_requests() if r["key"] == key), None)
    if request is None:
        await session.send_json(
            make_error(msg_id, msg_type, "NOT_FOUND", "that request is no longer waiting")
        )
        return

    def add_rule(policy: dict) -> None:
        rule = {
            "from": {"memberId": request["memberId"], "deviceId": request["deviceId"]},
            "to": {"workspace": request["workspace"], "paneName": request["paneName"]},
            "action": "allow",
        }
        if rule not in policy["rules"]:
            policy["rules"].append(rule)

    problem = await _write_policy(session, msg_id, msg_type, add_rule)
    if problem:
        return
    server_link.forget_access_request(key)
    await _announce_requests()
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


@handler("p2p.access_requests.dismiss")
async def p2p_access_requests_dismiss(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Clear a knock without granting anything. The sender is told nothing —
    dismissing is not a decision about them, it is one about this list."""
    forgotten = server_link.forget_access_request(str(payload.get("key") or ""))
    if forgotten:
        await _announce_requests()
    await session.send_json(make_response(msg_id, msg_type, {"forgotten": forgotten}))


@handler("p2p.trust.notices.list")
async def p2p_trust_notices_list(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Devices seen for the first time, and pinned devices whose key changed."""
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "notices": trust_store.notices(),
                "pending": trust_store.unapproved_devices(),
                "locked": trust_store.locked_reason(),
            },
        )
    )


@handler("p2p.trust.notices.dismiss")
async def p2p_trust_notices_dismiss(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Clear one notice — a first sighting only.

    A changed key is not a notification to acknowledge; it is a refusal that is
    currently in force, and a button that made it go away would reduce "somebody
    may be standing in for that machine" to one click. That click is the one an
    attacker who deleted this machine's key material is counting on, because the
    natural next move is to pair again and make everything work. So the answer
    here is a refusal, and the notice stays until the two fingerprints have been
    compared somewhere this program is not.
    """
    dismissed = trust_store.dismiss_notice(str(payload.get("key") or ""))
    if not dismissed:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "FORBIDDEN",
                "a changed device key cannot be dismissed; compare the two "
                "fingerprints with the other machine's owner first",
            )
        )
        return
    await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, {"dismissed": True}))


async def _confirmed(
    session: "Session", msg_id: str, msg_type: str, payload: dict, *, device_id: str = ""
) -> bool:
    """Whether this trust-changing request carries a live confirmation.

    Answers the caller with an error and returns False when it does not, so a
    handler's whole use of this is one guard at the top.

    The action name is the message type, and it is signed along with the device
    the request names: a confirmation minted to approve one machine cannot be
    spent to block another. See ``confirm_token`` for what this is for — it is
    the MCP and plugin paths, not a process running as this user.
    """
    reason = confirm_token.check(payload.get("confirm"), action=msg_type, device_id=device_id)
    if not reason:
        return True
    log.warning("refusing %s: %s", msg_type, reason)
    await session.send_json(make_error(msg_id, msg_type, "CONFIRMATION_REQUIRED", reason))
    return False


@handler("p2p.pair.start")
async def p2p_pair_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Ask another device to pair.

    This is a request, not a grant: nothing changes here or there until a person
    at *each* machine has compared the same six digits. The button it replaces
    did the opposite — it let one side decide, and the other side found out when
    something started running on it.
    """
    device_id = str(payload.get("deviceId") or "").strip()
    if not device_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "deviceId is required")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    reply = await server_link.start_pairing(device_id)
    if reply is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so there is no device to pair with",
            )
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_PAIRING_FAILED"),
                str(error.get("message") or "the pairing request could not be sent"),
            )
        )
        return
    await session.send_json(make_response(msg_id, msg_type, reply.get("payload") or {}))


@handler("p2p.pair.confirm")
async def p2p_pair_confirm(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """"The digits match" — or they do not.

    Both answers are decisions and both need a confirmation token: refusing is
    as much a thing a remote agent must not be able to do on somebody's behalf
    as accepting is. A refusal tells the other side, so their card leaves the
    screen instead of waiting out the five minutes.
    """
    device_id = str(payload.get("deviceId") or "").strip()
    if not device_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "deviceId is required")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    reply = await server_link.confirm_pairing(device_id, accept=bool(payload.get("accept")))
    if reply is None:
        await session.send_json(
            make_error(msg_id, msg_type, "P2P_NOT_CONFIGURED", "no navide-server is configured")
        )
        return
    if not reply.get("ok"):
        error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_PAIRING_FAILED"),
                str(error.get("message") or "that pairing could not be answered"),
            )
        )
        return
    await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, reply.get("payload") or {}))


@handler("p2p.trust.device.defer")
async def p2p_trust_device_defer(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """"Not now": stop showing a pinned device until it knocks again.

    Deliberately weaker than every other button on that card. Approving and
    blocking are decisions and are written where they are enforced; this one
    changes nothing about what that device may reach — it stays pinned,
    unapproved, and held to rules that deny by default. All it does is take an
    already-answered-once question off a panel that would otherwise re-ask it
    every three seconds for as long as the pin exists.

    ``trust_store.note_knock`` clears it on the next verified message, so this
    cannot be used to make a machine quietly go away.
    """
    device_id = str(payload.get("deviceId") or "")
    if not device_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "deviceId is required")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    deferred = await asyncio.to_thread(trust_store.defer_device, device_id)
    if deferred:
        await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, {"deferred": deferred}))


@handler("p2p.trust.device.unpair")
async def p2p_trust_device_unpair(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Forget a device: drop its pin and everything decided alongside it.

    The other half of approve, and the only way back out of a pairing this
    program had. Without it a pin taken on a first sighting was permanent — a
    device id seen once was pinned forever, and the panel could ask about it but
    never finish with it.

    Addressed by device id alone, deliberately. Unpairing grants nothing, so it
    does not need the fingerprint comparison approving does; what it costs is
    that the next message from that device is a first sighting again, which is
    visible and reversible by a person.

    It does not lift a block. A block is policy — a refusal ahead of every rule
    — and pairing is identity; a device that was blocked stays blocked with no
    pin, which is strictly the more careful of the two states.
    """
    device_id = str(payload.get("deviceId") or "").strip()
    if not device_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "deviceId is required")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    # Never this machine. The device list hides the button on its own row, and
    # that was the only thing enforcing it — anything that can reach this socket
    # could hand over this machine's own id. There is no pairing with yourself
    # to undo, so this is not a decision being refused; it is a request that
    # means nothing and takes real state with it.
    local = server_link.local_device_id()
    if local and device_id == local:
        await session.send_json(
            make_error(
                msg_id, msg_type, "FORBIDDEN", "this machine cannot be unpaired from itself"
            )
        )
        return
    removed = await asyncio.to_thread(trust_store.forget_device, device_id)
    # Told, not just forgotten. Two machines disagreeing about whether they are
    # paired is a state where one silently refuses everything the other sends,
    # and the sender's only symptom is silence.
    await server_link.revoke_pairing(device_id)
    if removed.get("found"):
        # The pin and its notices both feed this event, so the panel that was
        # showing the device empties in the same tick it is forgotten.
        await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, {"removed": removed}))


@handler("p2p.trust.rebuild")
async def p2p_trust_rebuild(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Start the trust record over after it has failed closed.

    The one way out of a lock, and deliberately the only one. Everything about
    it is shaped by what a lock means: this machine holds a marker saying it
    once had cross-device trust, and cannot read the record — which is either a
    real attack (somebody removed the state so the machine would re-pin their
    keys) or, far more often, a Keychain item this build can no longer open.
    Nothing here can tell those apart, and neither can the person; what it can
    do is make sure the choice is theirs.

    So it needs a confirmation token, which is minted in the renderer and
    nowhere else: an MCP tool, a plugin, or anything else holding this socket
    cannot perform it, however convincing its argument. And it refuses when the
    store is healthy — a rebuild costs every pairing on this machine, and a
    caller that asks for one against a readable store has misunderstood it.
    """
    if not await _confirmed(session, msg_id, msg_type, payload):
        return
    try:
        result = await asyncio.to_thread(trust_store.rebuild_locked_store)
    except trust_store.TrustStoreNotLocked as err:
        await session.send_json(make_error(msg_id, msg_type, "NOT_LOCKED", str(err)))
        return
    except Exception as err:  # noqa: BLE001 - a vault that will not answer is worth saying
        await session.send_json(
            make_error(msg_id, msg_type, "REBUILD_FAILED", str(err))
        )
        return
    # The panel is showing the lock; this is what empties it.
    await _announce_trust_notices()
    await session.send_json(make_response(msg_id, msg_type, result))


@handler("p2p.trust.block")
async def p2p_trust_block(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Refuse a device outright, ahead of every rule.

    Takes a deviceId, a memberId, or both — see device_trust.is_blocked for why
    they are alternatives rather than a pair. Blocking also clears whatever that
    device had waiting in the knock list: the point of a block is that this
    machine stops being asked about it.
    """
    device_id = str(payload.get("deviceId") or "").strip()
    member_id = str(payload.get("memberId") or "").strip()
    if not device_id and not member_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "block needs a deviceId or a memberId")
        )
        return
    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return
    entry = {
        "deviceId": device_id,
        "memberId": member_id,
        "deviceName": str(payload.get("deviceName") or ""),
        "reason": str(payload.get("reason") or ""),
        "at": datetime.now(timezone.utc).isoformat(),
    }

    def add_block(policy: dict) -> None:
        blocked = policy.setdefault("blocked", [])
        for existing in blocked:
            if isinstance(existing, dict) and (
                (device_id and existing.get("deviceId") == device_id)
                or (member_id and not device_id and existing.get("memberId") == member_id)
            ):
                return
        blocked.append(entry)

    if await _write_policy(session, msg_id, msg_type, add_block):
        return
    # Recorded here as well as in the policy, and only after the policy write
    # succeeded so the two cannot disagree about a block that was never made.
    # The local copy is what still refuses this device when the policy document
    # cannot be verified — see device_trust.is_blocked.
    await asyncio.to_thread(trust_store.note_blocked, device_id, member_id)
    if device_id and server_link.forget_access_requests_for_device(device_id):
        await _announce_requests()
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


@handler("p2p.trust.unblock")
async def p2p_trust_unblock(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Lift a block. It grants nothing on its own — the device goes back to
    being decided by the rules, which deny by default."""
    device_id = str(payload.get("deviceId") or "").strip()
    member_id = str(payload.get("memberId") or "").strip()
    # The same check block has. Without it an empty request rewrote the policy
    # to say exactly what it already said — a signed write, a revision bump and
    # a success, for a request that named nobody.
    if not device_id and not member_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "unblock needs a deviceId or a memberId")
        )
        return

    if not await _confirmed(session, msg_id, msg_type, payload, device_id=device_id):
        return

    def drop_block(policy: dict) -> None:
        policy["blocked"] = [
            entry
            for entry in policy.get("blocked", [])
            if not (
                isinstance(entry, dict)
                and (
                    (device_id and entry.get("deviceId") == device_id)
                    or (member_id and entry.get("memberId") == member_id)
                )
            )
        ]

    if await _write_policy(session, msg_id, msg_type, drop_block):
        return
    # Lifting has to reach the local copy too, or a device unblocked in the
    # policy stays refused here with nothing on screen to explain it.
    await asyncio.to_thread(trust_store.note_unblocked, device_id, member_id)
    await session.send_json(make_response(msg_id, msg_type, await _policy_payload()))


async def _announce_trust_notices() -> None:
    """Same shape the link broadcasts on its own paths, so a window has one
    event to listen for whether the notice came from a message that was refused
    or from a person clearing one here."""
    from . import app

    await app.broadcast(
        make_event(
            "p2p.trust_notices.changed",
            {
                "notices": trust_store.notices(),
                "pending": trust_store.unapproved_devices(),
                "locked": trust_store.locked_reason(),
            },
        )
    )


async def _announce_requests() -> None:
    from . import app

    await app.broadcast(
        make_event("p2p.access_requests.changed", {"requests": server_link.access_requests()})
    )


async def _write_policy(session: "Session", msg_id: str, msg_type: str, mutate) -> bool:
    """Read the cached policy, apply *mutate*, write the whole document back.

    Read-modify-write because the server's only write is a replace — it stores
    the document verbatim and never merges. It starts from the cache rather
    than a fresh fetch for the same reason authorization does: the decision must
    not depend on the control plane answering at that instant.

    Returns True when it already answered the caller with an error.
    """
    state = await server_link.policy_state()
    if not state.get("editable"):
        # `editable` is the link's own honest answer: the policy lives on the
        # server, so an unconfigured or offline machine can read its cached
        # rules and must not pretend to have saved a change to them.
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED"
                if state.get("state") == server_link.STATE_UNCONFIGURED
                else "P2P_LINK_OFFLINE",
                "this device has no writable policy right now",
            )
        )
        return True
    policy = state.get("policy")
    if not isinstance(policy, dict):
        # No policy yet is the normal state of a device nobody has configured;
        # the base document is the one the server hands out at revision 0.
        policy = {"version": 1, "default": "deny", "rules": []}
    else:
        policy = json.loads(json.dumps(policy))
    policy.setdefault("version", 1)
    policy.setdefault("default", "deny")
    if not isinstance(policy.get("rules"), list):
        policy["rules"] = []
    # The document is stored verbatim by the server and can therefore hold
    # whatever some other client wrote into it. The read side forgives that —
    # device_trust skips a row it cannot parse — but the mutators below append
    # to and filter these lists, and a string or a number here would raise
    # inside a handler rather than deny anything. Normalising once is what
    # keeps every caller from having to.
    if "blocked" in policy and not isinstance(policy.get("blocked"), list):
        from . import app as _app

        _app.log.warning(
            "policy blocked was %s, not a list; replacing it", type(policy["blocked"]).__name__
        )
        policy["blocked"] = []

    mutate(policy)

    problem = pane_policy.validate(policy) or device_trust.validate_blocked(policy)
    if problem:
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", problem))
        return True
    reply = await server_link.set_policy(policy)
    if reply is None or not reply.get("ok"):
        error = (reply or {}).get("error") if isinstance((reply or {}).get("error"), dict) else {}
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                str(error.get("code") or "P2P_POLICY_WRITE_FAILED"),
                str(error.get("message") or "the navide-server rejected the policy"),
            )
        )
        return True
    return False


async def _policy_payload() -> dict:
    """The policy plus the devices a rule could name, in one answer.

    The device list comes from the cached session directory rather than a
    device registry, because that directory is all the server sends — and a
    rule naming a device that has never had a pane grants nothing anyone could
    have used. It is a convenience for the picker, never a constraint: the
    policy is written with ids, so an id typed by hand works the same.
    """
    state = await server_link.policy_state()
    state["devices"] = remote_roster.list_devices()
    return state


# The whole network in one read: which devices are signed in to this team
# space, and which CLI panes are running on each. One call rather than a
# directory read plus a presence read plus a member read, because the account
# modal polls it while it is open and three round trips per tick would be three
# chances to render a half-updated picture.
#
# Answered from server_link's cache, which its own subscriptions keep current
# (sessions.changed for the rows, presence.changed for who is reachable), so a
# poll here costs no traffic to the server at all.
@handler("p2p.network.snapshot")
async def p2p_network_snapshot(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    snapshot = await server_link.network_snapshot()
    if snapshot is None:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "P2P_NOT_CONFIGURED",
                "no navide-server is configured, so this machine has no network",
            )
        )
        return
    # A link that is down still answers, carrying `state` and the last picture
    # the server sent: "the network you had a moment ago, and the link is
    # offline" is the truth, while an error would read as "you have no network".
    await session.send_json(make_response(msg_id, msg_type, snapshot))


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

    workspace_path = payload.get("workspace_path") or None
    # Answer from the cached scan results immediately; anything whose session
    # log changed since is rescanned in the background and lands as a
    # `tokens.changed` broadcast.
    app.refresh_live_scans(workspace_path or "")
    snap = app.tokens_store.snapshot(workspace_path)
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
# - Manifest v2 public calls take the ``host_mode=allowlist`` branch above and
#   use the Host shell broker. The shell-backed branch below is retained for
#   legacy terminal.run compatibility until that later migration removes it.
# - The legacy branch uses create_subprocess_exec('/bin/sh', '-c', cmd) instead
#   of create_subprocess_shell to avoid implicit shell injection.
# - ws_path is resolved and validated to be an existing directory.
# - Frontend shows full command in confirm dialog before invoking.
# - This is a local-only Electron app; the WebSocket server binds to
#   localhost only, reducing (but not eliminating) external attack surface.
@handler("shell.run")
async def shell_run(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    ws_path = payload.get("workspace_path") or ""
    cmd = payload.get("command", "") or ""
    if payload.get("host_mode") == "allowlist":
        if not isinstance(ws_path, str) or not ws_path.strip():
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path is required"}))
            return
        resolved_cwd = app.Path(ws_path).resolve()
        known_roots = [app.Path(w).resolve() for w in app.attribution.known_workspaces()]
        registered_root = next((root for root in known_roots if (
            resolved_cwd == root or resolved_cwd.is_relative_to(root)
        )), None)
        cwd_allowed = registered_root is not None
        if not cwd_allowed:
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "workspace path not registered"}))
            return
        if resolved_cwd and not resolved_cwd.is_dir():
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": "invalid workspace path"}))
            return
        try:
            argv = parse_public_allowlisted_command(
                cmd,
                cwd=str(resolved_cwd),
                workspace_root=str(registered_root),
            )
        except ValueError as exc:
            await session.send_json(make_response(msg_id, msg_type, {"ok": False, "error": str(exc)}))
            return
        rc, stdout, stderr = await run_public_allowlisted_text(
            argv,
            str(resolved_cwd),
            workspace_root=str(registered_root),
            timeout=30.0,
        )
        await session.send_json(make_response(msg_id, msg_type, {
            "ok": True,
            "output": stdout[:8000],
            "stdout": stdout[:8000],
            "stderr": stderr[:8000],
            "exit_code": rc,
        }))
        return
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

    # fresh=True re-probes the login-shell PATH (sent right after an install,
    # whose PATH export the cache cannot have seen yet).
    fresh = bool(payload.get("fresh"))
    loop = asyncio.get_running_loop()
    status = await loop.run_in_executor(
        _ONBOARDING_EXECUTOR, lambda: app.onboarding_deps.get_status(fresh=fresh)
    )
    status["complete"] = app.onboarding_deps.is_complete()
    status["skip"] = app.onboarding_deps.should_skip()
    await session.send_json(make_response(msg_id, msg_type, status))


@handler("onboarding.status_quick")
async def onboarding_status_quick(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """PATH-presence-only pass for the UI's first paint (see quick_status).

    Runs inline: pure filesystem stats, no subprocesses — and it must NOT go
    through _ONBOARDING_EXECUTOR, whose single worker would queue it behind a
    multi-second full get_status and defeat the point."""
    from . import app

    status = app.onboarding_deps.quick_status()
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
        # The push channel was wired before the spawn, so a rolled-back create
        # would otherwise leave a registered channel — and a watch file — for a
        # pane that never came to exist.
        app.push_delivery.forget_pane(transaction["pane_id"])

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
    vendor_spec = cli_vendor(agent_key)
    if vendor_spec is not None:
        for key, value in vendor_spec.spawn_env_defaults:
            if key not in os.environ:
                env.setdefault(key, value)
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
        resume_id = app._resume_id_for_agent("codex", payload.get("command"))
        if resume_id:
            # Repair a pin that names a sub-agent thread. Builds shipped before
            # sub-agent rollouts were recognised could pin one, and codex
            # refuses direct input on such a thread — the pane comes back
            # unusable until the id is pointed at the user thread it came from.
            resolver = getattr(app.codex_home_manager, "resolve_user_thread_id", None)
            if callable(resolver):
                repaired = await asyncio.to_thread(resolver, resume_id)
            else:
                repaired = resume_id
            if repaired != resume_id:
                app.log.info(
                    "codex resume id repaired: sub-agent %s → user thread %s",
                    resume_id, repaired,
                )
                payload["command"] = codex_command_with_resume_id(
                    payload.get("command"), resume_id, repaired
                )
                resume_id = repaired
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
        # Navide's own MCP endpoint first — it is core, not a plugin, and a
        # pane that misses it loses every navide tool. env is mutated in place
        # for the CLIs that take their wiring through a variable.
        from .mcp_server import wiring as mcp_server_wiring

        payload["command"] = await asyncio.to_thread(
            mcp_server_wiring.wire_command,
            agent_key,
            payload["command"],
            mcp_server_wiring.backend_port(),
            str(payload.get("pane_id") or ""),
            env,
            str(payload.get("cwd") or ""),
        )
        payload["command"] = await asyncio.to_thread(
            app.plugin_wiring.apply_spawn_wiring,
            app.plugin_host,
            agent_key,
            payload["command"],
            str(payload.get("pane_id") or ""),
            env,
            str(payload.get("cwd") or ""),
        )
    # Give the pane whatever its push channel needs (a port to serve on, a file
    # to watch) so a message can later reach it without being typed in. Last,
    # so the flags it adds cannot be displaced by MCP or skills wiring; a CLI
    # with no push channel — most of them — is left untouched.
    push_channel = None
    if not login_profile_id:
        payload["command"], push_channel = app.push_delivery.wire_spawn(
            agent_key, payload["command"], str(payload.get("pane_id") or ""), env
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
    # Announced only now the PTY exists. Wiring the channel is a spawn-time
    # decision, but advertising it before the CLI is actually running would tell
    # the window it can push into a pane that may still fail to start — and a
    # spawn that rolls back has already dropped the channel again.
    if push_channel is not None:
        await app.broadcast(make_event("agent_msg.push_state", {
            "pane_id": push_channel.pane_id,
            "kind": push_channel.kind,
            "ready": True,
        }))
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
        if (not explicit_session_id and agent_key != "codex"
                and vendor_spec is not None
                and vendor_spec.resume_id_from_command is not None):
            explicit_session_id = vendor_spec.resume_id_from_command(
                payload.get("command")
            )
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
        # The live "THIS SESSION" tally is read straight from the vendor log.
        # Now that the pane owns this session id, start tracking it and take
        # the first scan. Fire and forget — a multi-MB parse must not delay
        # the create ack below.
        app.track_live_session(
            workspace_path=ws_for_pane,
            pane_id=term.pane_id,
            vendor=agent_key,
            session_id=explicit_session_id,
        )
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


@handler("terminal.memory_usage")
async def terminal_memory_usage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Per-pane memory footprint, measured on demand.

    Answers the one question the memory panel exists for — which panes are
    holding the machine's memory — with the number the kernel charges each
    process, not `ps` RSS (which counts shared pages once per process and so
    over-reports a fleet of identical CLIs).

    On demand, never on a timer: the sweep shells out, and its cost scales with
    the pane count. Off Darwin, or when footprint cannot run, `available` is
    false and the panel says it cannot measure rather than showing a number
    that means something else.
    """
    from . import process_memory

    groups = session.terminals.memory_pid_groups()
    pids = [pid for _, pids in groups.values() for pid in pids]
    measured = await asyncio.to_thread(process_memory.footprints, pids)
    totals = process_memory.sum_by_group(
        {sid: pids for sid, (_, pids) in groups.items()}, measured
    )
    panes = [
        {
            "terminal_session_id": sid,
            "pane_id": pane_id,
            "bytes": totals.get(sid, 0),
        }
        for sid, (pane_id, _) in groups.items()
    ]
    await session.send_json(make_response(msg_id, msg_type, {
        # measured being empty with live panes means the sweep failed, which is
        # not the same as "no panes" — the panel has to tell those apart.
        "available": process_memory.available() and bool(measured or not groups),
        "panes": panes,
        "total_bytes": sum(totals.values()),
    }))


#: One sweep serves every window that asks within this window of time.
#:
#: The panel it feeds is machine-wide, so N open windows all ask for the same
#: numbers on their own timers — and the sweep shells out twice, on the shared
#: executor, at a cost that scales with the pane count. Without this, three
#: windows plus the Resource Manager mean three redundant `footprint` runs
#: contending for the same thread pool (a failure this backend has hit before,
#: from a different caller). The lock serialises them; the TTL means the ones
#: that queued behind it get the reading that just completed instead of
#: starting another.
#:
#: It does not blur anyone's CPU differencing: each caller subtracts against
#: its OWN previous sample, and `sampled_at` travels with the reading, so a
#: shared sample is simply a sample both callers took at the same instant.
_RESOURCE_SWEEP_TTL_S = 1.0
_resource_sweep_lock = asyncio.Lock()
_resource_sweep_cache: dict[str, object] = {"at": 0.0, "payload": None}


@handler("terminal.resource_usage")
async def terminal_resource_usage(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Per-pane CPU and memory in one sweep, for the resource panel.

    Memory is the footprint number `terminal.memory_usage` already returns.
    CPU is the *accumulated* CPU seconds of the pane's process tree, not a
    percentage: a percentage only exists between two readings, and two windows
    sampling at different rates would each need their own interval. Returning
    the raw counter with the clock it was read at lets every caller difference
    against its own previous sample.

    The two sweeps are independent subprocesses, so they run concurrently; the
    whole call costs about as much as the slower one. Concurrent callers share
    one sweep — see _RESOURCE_SWEEP_TTL_S.
    """
    async with _resource_sweep_lock:
        now = time.monotonic()
        cached = _resource_sweep_cache["payload"]
        if cached is not None and now - float(_resource_sweep_cache["at"]) < _RESOURCE_SWEEP_TTL_S:
            await session.send_json(make_response(msg_id, msg_type, cached))
            return
        result = await _collect_resource_usage(session)
        _resource_sweep_cache["at"] = now
        _resource_sweep_cache["payload"] = result
    await session.send_json(make_response(msg_id, msg_type, result))


async def _collect_resource_usage(session: "Session") -> dict:
    """One CPU + memory sweep over every live PTY this backend owns."""
    from . import process_cpu, process_memory

    groups = session.terminals.memory_pid_groups()
    pids = [pid for _, pids in groups.values() for pid in pids]
    by_session = {sid: pids for sid, (_, pids) in groups.items()}
    measured, (cpu_measured, sampled_at) = await asyncio.gather(
        asyncio.to_thread(process_memory.footprints, pids),
        asyncio.to_thread(process_cpu.cpu_times, pids),
    )
    totals = process_memory.sum_by_group(by_session, measured)
    cpu_totals = process_cpu.sum_by_group(by_session, cpu_measured)
    panes = [
        {
            "terminal_session_id": sid,
            "pane_id": pane_id,
            "bytes": totals.get(sid, 0),
            "cpu_seconds": cpu_totals.get(sid, 0.0),
        }
        for sid, (pane_id, _) in groups.items()
    ]
    cpu_count, machine_memory = process_cpu.machine_capacity()
    return {
        # An empty sweep with live panes means it failed, which is not the same
        # as "no panes" — the panel has to tell those apart, per metric.
        "available": process_memory.available() and bool(measured or not groups),
        "cpu_available": process_cpu.available() and bool(cpu_measured or not groups),
        "sampled_at": sampled_at,
        "panes": panes,
        "total_bytes": sum(totals.values()),
        # Denominators for "how much of this machine", which is the question the
        # summary answers; the per-pane column stays relative to one core.
        "cpu_count": cpu_count,
        "machine_memory_bytes": machine_memory,
    }


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


@handler("client.diagnostic")
async def client_diagnostic(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Write a renderer-side diagnostic line into the backend log.

    The renderer has no log file of its own, so the timings only it can see —
    how long a pane sat in each preparation step, an IME composition that
    latched and started swallowing keys — had nowhere to land. An input-latency
    report therefore arrived with evidence for the PTY half and nothing for the
    half the user actually touches. Routing these here puts both halves on one
    timeline, in the file the user already reads.

    Deliberately dumb: the renderer decides what deserves a line (its probes
    are threshold-gated on that side), this only writes it down.
    """
    message = str(payload.get("message") or "")[:1000]
    if message:
        category = str(payload.get("category") or "ui")[:40]
        if payload.get("level") == "warning":
            client_log.warning("%s: %s", category, message)
        else:
            client_log.info("%s: %s", category, message)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("terminal.history")
async def terminal_history(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Return a pane's recorded transcript so a restore can replay its history.

    Exists because xterm keeps no scrollback for the alternate buffer and drops
    lines that scroll off it, so a restored pane could show only what the CLI
    repaints — the conversation above it was simply gone. The transcript on
    disk is ANSI-stripped plain text (terminals.py `_clean_for_log`), which is
    why replaying it is width-safe: there are no cursor coordinates to land in
    the wrong cell. It restores the conversation, not the coloured screen.

    The caller names a pane, never a path: the filename is derived from
    agent_key + pane_id, so this cannot be pointed at an arbitrary file.
    """
    workspace_path = str(payload.get("workspace_path") or "")
    agent_key = str(payload.get("agent_key") or "")
    pane_id = str(payload.get("pane_id") or "")
    if not (workspace_path and agent_key and pane_id):
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "text": ""}))
        return
    max_bytes = int(payload.get("max_bytes") or TRANSCRIPT_MAX_BYTES)
    # Plain file IO, but a long-lived pane's transcript can run to hundreds of
    # KB across several days' files — off the event loop so a restore storm
    # cannot stall it.
    text, truncated = await asyncio.to_thread(
        read_pane_transcript, workspace_path, agent_key, pane_id, max_bytes
    )
    # Answer ONE chunk per request. A whole transcript runs to hundreds of KB,
    # and shipping that as a single frame would hold the session send lock for
    # one serialize+write — long enough to sit in front of a heartbeat pong,
    # which is the shape behind the spurious-disconnect reports. terminal.output
    # slices at this size for the same reason; the caller loops for the rest.
    chunks = [
        text[i : i + TRANSCRIPT_CHUNK_CHARS]
        for i in range(0, len(text), TRANSCRIPT_CHUNK_CHARS)
    ] or [""]
    index = max(0, int(payload.get("chunk") or 0))
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "text": chunks[index] if index < len(chunks) else "",
                "chunk": index,
                "total_chunks": len(chunks),
                "truncated": truncated,
            },
        )
    )


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
    # Where each survivor is actually writing its transcript. A reattaching
    # pane has a fresh pane id, and the path its caller derives from that id
    # names a file no one ever opened — the conversation is in the log the
    # session opened at create time. Absent for a session started without one.
    from .terminals import live_output_log_for

    logs = {tid: live_output_log_for(tid) for tid in alive}
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "alive": alive,
                "dead": dead,
                "logs": {tid: path for tid, path in logs.items() if path},
            },
        )
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


@handler("project.set_pane_minimized")
async def project_set_pane_minimized(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Collapsed-to-sidebar state.

    The renderer has been sending this since the feature shipped, but no
    handler existed — backend.send is fire-and-forget, so nothing surfaced and
    the state silently reset on every restart.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    is_minimized = bool(payload.get("is_minimized", False))
    if ws_raw and pane_id:
        app.project_store.set_pane_minimized(ws_raw, pane_id=pane_id, is_minimized=is_minimized)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("project.set_pane_collapsed")
async def project_set_pane_collapsed(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Whether this pane's lineage subtree is folded in the agent lists."""
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    collapsed = bool(payload.get("collapsed", False))
    if ws_raw and pane_id:
        app.project_store.set_pane_collapsed(ws_raw, pane_id=pane_id, collapsed=collapsed)
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
    """Persist an auto-generated pane title (custom_name always wins).

    *source* is "heuristic" (the renderer's instant string title) or "llm" (the
    model's answer, which may upgrade a heuristic title once); see
    ProjectStore.set_pane_auto_name for the full write ordering. Anything else
    is treated as "heuristic" rather than rejected — an unknown source from an
    older window should still be able to name a pane.

    An accepted write patches both the project.json spawn-history mirror
    (autoName key, via the store) and the full spawn-history store, the same
    way rename_pane does — the mirror only holds the last 100 entries, so
    older ones would otherwise depend entirely on the renderer's debounced
    snapshot. A no-op (empty name, or a write the ordering rejects) touches
    neither store and is not broadcast — the store is the final arbiter of the
    cross-window race, so only the winning write reaches peer windows.
    """
    from . import app

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    auto_name = (payload.get("auto_name", "") or "").strip()
    source = (payload.get("source", "") or "heuristic").strip()
    if source not in ("heuristic", "llm"):
        source = "heuristic"
    if pane_id:
        project, changed = app.project_store.set_pane_auto_name(
            ws_raw, pane_id=pane_id, auto_name=auto_name, source=source
        )
        if project is not None and changed:
            # Patch the full store at the source too: the renderer's debounced
            # snapshot merge also carries the name, but it can be lost on quit
            # and never runs in detached windows.
            await asyncio.to_thread(
                app.spawn_history_store.patch_entry,
                ws_raw,
                pane_id,
                {"autoName": auto_name},
                seed=project.ui_spawn_history,
            )
            # Peers patch their live panes[] state from auto_named_pane so
            # their titles converge on the winning name.
            await app.broadcast(
                make_event(
                    "project.ui_state_changed",
                    {
                        "workspace_path": project.workspace_path,
                        "auto_named_pane": {
                            "pane_id": pane_id,
                            "auto_name": auto_name,
                            "source": source,
                        },
                    },
                ),
                exclude=session,
            )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


@handler("pane.generate_auto_name")
async def pane_generate_auto_name(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Ask the local model for a better pane title than the string heuristic.

    Best-effort by construction: the renderer has already titled the pane
    before it sends this, so a failure here just leaves that title in place.
    The answer is persisted through the same set_pane_auto_name arbiter (with
    source="llm"), which is what stops a slow answer from renaming a pane the
    user has since renamed themselves.
    """
    from . import app
    from . import pane_name_service

    ws_raw = payload.get("workspace_path", "") or ""
    pane_id = payload.get("pane_id", "") or ""
    material = payload.get("material", "") or ""
    model = payload.get("model", "") or app.ANALYZER_DEFAULT_MODEL
    if not pane_id or not material.strip():
        await session.send_json(make_response(msg_id, msg_type, {"ok": False, "name": ""}))
        return

    result = await pane_name_service.generate_pane_name(material, app._az_base_url(), model)
    if not result.get("ok"):
        await session.send_json(make_response(
            msg_id, msg_type, {"ok": False, "name": "", "error": result.get("error", "")}
        ))
        return

    name = result["name"]
    project, changed = app.project_store.set_pane_auto_name(
        ws_raw, pane_id=pane_id, auto_name=name, source="llm"
    )
    if project is not None and changed:
        await asyncio.to_thread(
            app.spawn_history_store.patch_entry,
            ws_raw,
            pane_id,
            {"autoName": name},
            seed=project.ui_spawn_history,
        )
        await app.broadcast(
            make_event(
                "project.ui_state_changed",
                {
                    "workspace_path": project.workspace_path,
                    "auto_named_pane": {
                        "pane_id": pane_id,
                        "auto_name": name,
                        "source": "llm",
                    },
                },
            ),
            exclude=session,
        )
    # 'changed' is reported so the caller can tell an accepted upgrade from one
    # the arbiter refused (the pane was renamed while the model was thinking).
    await session.send_json(make_response(
        msg_id, msg_type, {"ok": True, "name": name, "changed": changed}
    ))


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
def _mirror_pipeline_state(project: "Project") -> None:
    """Copy a pipeline's state onto its recent-workspaces entry.

    The store keeps last_known_state/task purely so Welcome can badge a folder
    with how its last run ended; nothing else writes them, so without this every
    entry falls through to the 'spawn-only' default. Called from the handlers
    that move Project.state (start / resume / complete / abort) — the backend is
    the authority, and mirroring here also survives the window being closed
    right after a run.
    """
    from . import app

    try:
        app.recent_workspaces_store.touch(
            project.workspace_path,
            state=project.state,
            task=project.task_description,
        )
        recent = app.recent_workspaces_store.list()
    except Exception:  # noqa: BLE001 — a badge must not fail a pipeline
        # Callers are the start/complete/abort handlers, which had no dependency
        # on the recent store before this. A store failure here would answer
        # their request with an error for a run that actually succeeded, so it
        # stays local: the badge falls back to whatever it showed before.
        app.log.exception("recent-workspaces: failed to mirror pipeline state")
        return
    asyncio.create_task(
        app.broadcast(
            make_event("workspace.recent_changed", {"recent": recent, "reason": "pipeline"})
        )
    )


@handler("pipeline.resume")
async def pipeline_resume(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    project, resume_index = app.project_store.resume_pipeline(payload["workspace_path"])
    _mirror_pipeline_state(project)
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
    _mirror_pipeline_state(project)
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
    _mirror_pipeline_state(project)
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
    _mirror_pipeline_state(project)
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
        origin=payload.get("origin", ""),
        spawned_by=payload.get("spawned_by", ""),
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
    if project is None:
        # Say so rather than answering ok: the caller acts on this reply by
        # dropping the pane's group id locally, which must not happen when
        # nothing was written.
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "PANE_NOT_FOUND",
                f"no pane record for {payload['pane_id']!r} in this workspace",
            )
        )
        return
    await session.send_json(
        make_response(msg_id, msg_type, app._project_payload(project))
    )


# ── Reconnect lost conversations (workspace/pane.*) ──────────────────────────
def _collect_orphan_sessions(workspace_path: str) -> list[dict]:
    """Enumerate this workspace's Claude transcripts that no live pane holds.

    A transcript is orphaned when its session id is not the current session_id
    of any SPAWNED pane in the workspace's project — those are the ones a
    reconnect can safely adopt. Pending records are stubs whose spawn never
    landed (see record_manual_pane_session): counting them as live would hide
    their transcript from reconnect forever. Each orphan carries a short
    human-prompt preview, size/mtime, its resumable flag, and (best-effort) the
    spawn-history customName last associated with the id. Sorted newest mtime
    first. Blocking file IO — call via asyncio.to_thread.
    """
    from . import app

    files = ClaudeLogReader().session_files_for_workspace(workspace_path)
    project = app.project_store.peek(workspace_path)
    live_ids: set[str] = set()
    history_names: dict[str, str] = {}
    if project is not None:
        for pane in project.panes:
            if pane.spawn_status == "spawned" and pane.session_id:
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

    # Scoped by the account card that asked; absent, the header button's
    # "every CLI" refresh.
    agent_key = payload.get("agentKey")
    slot_id = payload.get("slotId")
    service.request_refresh(
        provider=str(agent_key) if agent_key else None,
        slot_id=str(slot_id) if slot_id else None,
    )
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
        # Absent means realized: every caller that has a live pane omits it, and
        # a window from before this field existed only ever mirrored live panes.
        realized=bool(payload.get("realized", True)),
    )
    # The ids this same CLI process was known by before the window rebuilt its
    # pane around it (reload, detach, group reattach). They stay resolvable, so
    # a CLI still quoting the id baked into its /plan-mcp URL at spawn time is
    # answered as the pane it is actually attached to.
    former_pane_ids = [str(x) for x in (payload.get("former_pane_ids") or [])]
    aliased = agent_messaging.add_aliases(pane_id, former_pane_ids, workspace_path)
    # A register is also how a rename and a post-reconnect re-mirror arrive, so
    # this is the single point where the remote roster learns about all three.
    server_link.roster_changed()
    # ...and the single point where a window that reloaded, or reattached to a
    # PTY it did not spawn, learns the pane still has a push channel. Without
    # this it would keep typing into a pane it could have pushed to, for as long
    # as it lives.
    from . import push_delivery

    # A pane whose window reloaded keeps the channel its CLI was launched with,
    # and that channel is filed under the pane id the launch used. Move it onto
    # the id the pane answers to now, or the pane would be typed into for the
    # rest of its life despite having a working push channel. Only an id nobody
    # live is holding gives it up — see push_delivery.adopt.
    push_delivery.adopt(pane_id, aliased)
    state = push_delivery.get(pane_id)
    if state is not None and push_delivery.is_ready(pane_id):
        await session.send_json(
            make_event(
                "agent_msg.push_state",
                {"pane_id": pane_id, "kind": state.kind, "ready": True},
            )
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
        server_link.roster_changed()
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "removed": removed}))


@handler("agent_msg.set_busy")
async def agent_msg_set_busy(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """The owning window reports what a pane is doing: whether its agent is
    mid-turn (so cli_list_targets can tell a caller the target is working) and
    the word its own sidebar badge is showing (so the network view can call the
    pane the same thing this window does)."""
    pane_id = str(payload.get("pane_id") or "")
    # Absent means "this window does not report a status word", which is what an
    # older build looks like; an empty string would blank the last one we had.
    raw_status = payload.get("status")
    display_status = None if raw_status is None else str(raw_status)
    changed = bool(pane_id) and agent_messaging.set_busy(
        pane_id, bool(payload.get("busy")), display_status
    )
    if changed:
        server_link.roster_changed()
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "changed": changed}))


def _external_access_status() -> dict:
    """{enabled, token, port} for the Settings UI's external-access panel."""
    from .mcp_server import auth as plan_mcp_auth, wiring as plan_mcp_wiring

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
    from .mcp_server import auth as plan_mcp_auth

    plan_mcp_auth.set_external_enabled(bool(payload.get("enabled")))
    await session.send_json(make_response(msg_id, msg_type, _external_access_status()))


@handler("external_access.regenerate")
async def external_access_regenerate(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Settings UI: mint a new external token, invalidating the old one."""
    from .mcp_server import auth as plan_mcp_auth

    plan_mcp_auth.regenerate_external_token()
    await session.send_json(make_response(msg_id, msg_type, _external_access_status()))


@handler("agent_spawn.result")
async def agent_spawn_result(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A window's verdict on an agent_spawn.request, handed to the waiting
    cli_open_agent call."""
    from .mcp_server import server as plan_mcp

    request_id = str(payload.get("request_id") or "")
    if not request_id:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_spawn.result needs request_id")
        )
        return
    verdict: dict[str, Any] = {
        "ok": bool(payload.get("ok", False)),
        "error": str(payload.get("error") or ""),
        "pane_id": str(payload.get("pane_id") or ""),
        "name": str(payload.get("name") or ""),
    }
    if payload.get("advisories"):
        verdict["advisories"] = payload["advisories"]
    delivered = plan_mcp.resolve_spawn(request_id, verdict)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("ui.invoke.result")
async def ui_invoke_result(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A renderer window's reply to a ui.invoke.request, handed to the
    waiting ui_invoke/ui_snapshot/ui_list_actions MCP call."""
    from .mcp_server import server as plan_mcp

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
    from . import app, message_routing

    from_pane_id = str(payload.get("from_pane_id") or "")
    to = str(payload.get("to") or "")
    content = str(payload.get("content") or "")
    msg_key = str(payload.get("msg_key") or "")
    # Correlation id the sender echoed back when this message is a reply. Carried
    # through untouched so the window that handed it out can link the two rows;
    # absent for a message that starts a thread.
    reply_to = str(payload.get("reply_to") or "")
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

    # The same resolver cli_send uses, so one address cannot mean two different
    # things depending on whether an agent printed a block or called the tool.
    # It answered "unknown device … not available yet" here for a target the
    # tool delivered, because cross-device addressing was only ever wired into
    # the tool (see message_routing).
    routed = message_routing.route(from_pane_id, to)
    if routed.remote is not None:
        # `reply_to` does not travel. The relay frame carries to/sender/text/
        # msg_key and nothing else (server_link.send_message), so threading a
        # reply across machines would need a wire field the server and the far
        # side both understand — a protocol change, not a routing one. The
        # receiver still mints a correlation id from this msg_key, so the thread
        # holds on its side; what is lost is the link back to the row on this
        # one. Said here rather than left to be discovered from a missing field.
        relayed = await message_routing.relay(
            routed.remote, content, from_pane_id=from_pane_id, msg_key=msg_key
        )
        if relayed is not None:
            await session.send_json(
                make_response(
                    msg_id,
                    msg_type,
                    {
                        "ok": relayed.ok,
                        "error": relayed.error or None,
                        "code": relayed.code or None,
                        "params": {},
                        # No local pane to report: the window that owns the
                        # target is on another machine and delivers it there.
                        "target_display": routed.remote.to_string(),
                        "target_workspace_path": routed.remote.workspace,
                        "target_agent_key": "",
                        "cross_workspace": True,
                    },
                )
            )
            return
        # No link configured on this machine: fall through to the answer this
        # handler gave before, which `route` carried along with the address.

    if routed.pane is None:
        # `code`/`params` let the sending window show the failure in the user's
        # language instead of parsing the English sentence in `error`.
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {
                    "ok": False,
                    "error": routed.error or "unresolved",
                    "code": routed.code or None,
                    "params": routed.params or {},
                },
            )
        )
        return
    result = agent_messaging.ResolveResult(
        pane=routed.pane, cross_workspace=routed.cross_workspace
    )

    if result.pane.pane_id == from_pane_id:
        await session.send_json(
            make_response(
                msg_id,
                msg_type,
                {
                    "ok": False,
                    "error": "sender and target are the same pane",
                    "code": "self-send",
                    "params": {},
                },
            )
        )
        return

    sender = agent_messaging.get(from_pane_id)
    from_display = agent_messaging.sender_display(
        from_pane_id, str(payload.get("from_name") or "")
    )
    deliver_payload: dict[str, Any] = {
        "msg_key": msg_key,
        "target_pane_id": result.pane.pane_id,
        "target_workspace_path": result.pane.workspace_path,
        "target_name": result.pane.name,
        "target_agent_key": result.pane.agent_key,
        "from_pane_id": from_pane_id,
        "from_display": from_display,
        "from_workspace_path": sender.workspace_path if sender else "",
        "from_agent_key": sender.agent_key if sender else "",
        "cross_workspace": result.cross_workspace,
        "content": content,
    }
    # Only present for a reply, so a sender that never sends one keeps seeing the
    # exact payload it saw before.
    if reply_to:
        deliver_payload["reply_to"] = reply_to
    asyncio.create_task(app.broadcast(make_event("agent_msg.deliver", deliver_payload)))
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": True,
                "target_pane_id": result.pane.pane_id,
                "target_workspace_path": result.pane.workspace_path,
                "target_display": result.pane.qualified_name,
                "target_agent_key": result.pane.agent_key,
                "cross_workspace": result.cross_workspace,
            },
        )
    )


@handler("agent_msg.hook_drain_result")
async def agent_msg_hook_drain_result(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """A window's answer to `agent_msg.hook_drain`, handed to the Stop hook that
    is holding a claude pane open while it waits.

    An empty `envelope` is a valid answer — it means the pane's queue had
    nothing deliverable — and is what lets the hook return promptly instead of
    sitting out its timeout.
    """
    from . import hook_drain

    request_id = str(payload.get("request_id") or "")
    if not request_id:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "agent_msg.hook_drain_result needs request_id"
            )
        )
        return
    delivered = hook_drain.resolve_drain(
        request_id, {"envelope": str(payload.get("envelope") or "")}
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "delivered": delivered}))


@handler("agent_msg.push")
async def agent_msg_push(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """Hand an envelope to a pane's push channel instead of typing it in.

    The window that owns the pane decides whether to push — it holds the queue,
    the rate limit and the idle gate — so this only performs the transport and
    reports whether it landed. A `false` answer is not a failed message: the
    caller retries the same envelope over the PTY, which is what every pane did
    before it had a channel at all.
    """
    from . import app, push_delivery

    pane_id = str(payload.get("pane_id") or "")
    text = str(payload.get("text") or "")
    if not pane_id or not text:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.push needs pane_id and text")
        )
        return
    state = push_delivery.get(pane_id)
    ok, reason = await push_delivery.deliver(pane_id, text)
    if ok:
        # The pane is about to start a turn on this message, and nothing else
        # will say so for a while: a CLI that took the text over HTTP or out of
        # a watched file writes its conversation log at its own pace, and a
        # rewoken agent has no PTY output yet. Without this the window would
        # keep calling the pane idle and start typing the next queued message
        # into a pane already working on this one.
        app._record_pane_activity(pane_id, "agent_active", "")
        await app.broadcast(make_event("agent.activity", {
            "vendor": state.agent_key if state else "",
            "event_type": "agent_active",
            "workspace_path": "",
            "pane_id": pane_id,
            "stage_id": "",
            "session_id": "",
            "cwd": "",
            "timestamp": "",
            "detail": f"push:{state.kind if state else ''}",
            "notification_type": "",
        }))
    kind = state.kind if state else ""
    await session.send_json(
        make_response(
            msg_id,
            msg_type,
            {
                "ok": ok,
                "kind": kind,
                "reason": reason,
                # "the pane may still be holding this text": the window must
                # then re-queue the message rather than typing it in, or the
                # envelope goes in twice, concatenated.
                "unclear": (not ok) and push_delivery.leaves_text_behind(kind, reason),
            },
        )
    )


@handler("agent_msg.hold_update")
async def agent_msg_hold_update(
    session: "Session", msg_id: str, msg_type: str, payload: dict
) -> None:
    """The receiving window reports why a message is still sitting in its queue.

    Delivery lives in the window, so the reason a message has not gone in yet
    exists nowhere else — and an MCP caller, which has no Messages panel to
    look at, could otherwise only see "queued". Sent on a change, never per
    tick.

    `hold` is {key, n?} or null (nothing holding it any more). Keys this server
    never minted are ignored, exactly as agent_msg.delivered ignores them.
    """
    from .mcp_server import server as plan_mcp

    msg_key = str(payload.get("msg_key") or "")
    if not msg_key:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.hold_update needs msg_key")
        )
        return
    hold = payload.get("hold")
    tracked = plan_mcp.record_message_hold(msg_key, hold if isinstance(hold, dict) else None)
    await session.send_json(make_response(msg_id, msg_type, {"ok": True, "tracked": tracked}))


@handler("agent_msg.cancel")
async def agent_msg_cancel(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """A sending window withdraws a message whose queue another window owns.

    Relayed, not decided here: the queue lives in the receiving window, so only
    it knows whether the message is still waiting or already going in. It
    answers over the ordinary `agent_msg.delivered` path — as cancelled if it
    dropped the message, and not at all if it was too late, because the
    delivery that beat this will report its own outcome.

    Not excluding the sender, for the same reason `agent_msg.delivered` does
    not: a workspace-qualified target can resolve to a pane in the SAME window.
    """
    from . import app

    msg_key = str(payload.get("msg_key") or "")
    if not msg_key:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.cancel needs msg_key")
        )
        return
    asyncio.create_task(
        app.broadcast(make_event("agent_msg.cancel", {"msg_key": msg_key}))
    )
    await session.send_json(make_response(msg_id, msg_type, {"ok": True}))


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
    from .mcp_server import server as plan_mcp

    msg_key = str(payload.get("msg_key") or "")
    if not msg_key:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.delivered needs msg_key")
        )
        return
    # A message that came from cli_send has no window of its own to keep the
    # outcome for, so the MCP server records it for cli_check_message. Ignores
    # every key it did not mint.
    plan_mcp.record_delivery_result(
        msg_key, bool(payload.get("ok", False)), str(payload.get("reason") or "")
    )
    # A message relayed in from another device is acked back to the server from
    # here — this is the only place the receiving window's verdict is observed.
    # Ignores every key that did not arrive over the link.
    server_link.note_delivery_result(
        msg_key, bool(payload.get("ok", False)), str(payload.get("reason") or "")
    )
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

    raw_limit = payload.get("limit", 500)
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError, OverflowError):
        # null / "abc" / Infinity — a bad field is BAD_REQUEST, like the
        # neighbouring agent_msg.route and agent_msg.delivered handlers.
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "agent_msg.log_snapshot needs a numeric limit"
            )
        )
        return
    rows = app.agent_message_log.tail(max(1, min(limit, 500)))
    await session.send_json(make_response(msg_id, msg_type, {"rows": rows}))


@handler("agent_msg.log_append")
async def agent_msg_log_append(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    rows = payload.get("rows")
    if not isinstance(rows, list):
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", "agent_msg.log_append needs a rows list")
        )
        return
    written = app.agent_message_log.append(rows)
    await session.send_json(make_response(msg_id, msg_type, {"written": written}))


@handler("agent_msg.log_update")
async def agent_msg_log_update(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    updates = payload.get("updates")
    if not isinstance(updates, list):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "agent_msg.log_update needs an updates list"
            )
        )
        return
    updated = app.agent_message_log.update(updates)
    await session.send_json(make_response(msg_id, msg_type, {"updated": updated}))


@handler("agent_msg.log_clear")
async def agent_msg_log_clear(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    keep = payload.get("keep_statuses")
    if keep is not None and not isinstance(keep, list):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "agent_msg.log_clear keep_statuses must be a list"
            )
        )
        return
    deleted = app.agent_message_log.clear(
        [str(s) for s in keep] if keep is not None else None
    )
    await session.send_json(make_response(msg_id, msg_type, {"deleted": deleted}))


# ── Preview record track (preview.log_*) ────────────────────────────────────
# The preview panel's record track is backend-authored and per-workspace. The
# watcher and the MCP tools write straight into the store; these handlers cover
# the third writer — a user action inside the app — plus the read the panel
# hydrates from. Unlike agent_msg.log_*, a write here IS broadcast: every window
# showing that workspace has the same track on screen.


@handler("preview.log_snapshot")
async def preview_log_snapshot(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path") or "")
    if not workspace_path:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "preview.log_snapshot needs a workspace_path"
            )
        )
        return
    # Same root every writer resolves to (see app._preview_workspace), or a
    # window opened on a subdirectory reads a database nobody writes into.
    # `root` goes back with the entries (as plans.list_docs does) because the
    # broadcast carries this resolved value too: a window that only knew the
    # raw path it was opened on would drop every live `preview.recorded`.
    workspace_path = await asyncio.to_thread(resolve_plan_root, workspace_path)
    raw_limit = payload.get("limit", 50)
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError, OverflowError):
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "preview.log_snapshot needs a numeric limit"
            )
        )
        return
    # tail() clamps the limit to the store's own ceiling.
    entries = app.preview_log.tail(workspace_path, limit)
    await session.send_json(
        make_response(msg_id, msg_type, {"entries": entries, "root": workspace_path})
    )


@handler("preview.log_append")
async def preview_log_append(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path") or "")
    change = str(payload.get("change") or "")
    if not workspace_path or not change:
        await session.send_json(
            make_error(
                msg_id,
                msg_type,
                "BAD_REQUEST",
                "preview.log_append needs a workspace_path and a change",
            )
        )
        return
    # The broadcast below carries this same value, so it has to be the
    # normalised one the snapshot reads back.
    workspace_path = await asyncio.to_thread(resolve_plan_root, workspace_path)
    entry = app.preview_log.append(
        workspace_path,
        change=change,
        kind=str(payload.get("kind") or "file"),
        rel_path=payload.get("rel_path"),
        title=payload.get("title"),
        # A row written through this handler is by definition the user acting
        # inside the app, so the wire does not get to claim agent or watcher.
        source="user",
        pane_id=payload.get("pane_id"),
        note=payload.get("note"),
    )
    # None means the store rejected the row or folded it into one already on the
    # feed — there is nothing new for the other windows to show.
    if entry is not None:
        await app.broadcast(
            make_event(
                "preview.recorded", {"workspace_path": workspace_path, "entry": entry}
            )
        )
    await session.send_json(make_response(msg_id, msg_type, {"entry": entry}))


@handler("preview.log_clear")
async def preview_log_clear(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    from . import app

    workspace_path = str(payload.get("workspace_path") or "")
    if not workspace_path:
        await session.send_json(
            make_error(
                msg_id, msg_type, "BAD_REQUEST", "preview.log_clear needs a workspace_path"
            )
        )
        return
    workspace_path = await asyncio.to_thread(resolve_plan_root, workspace_path)
    raw_before = payload.get("before")
    before: int | None = None
    if raw_before is not None:
        try:
            before = int(raw_before)
        except (TypeError, ValueError, OverflowError):
            await session.send_json(
                make_error(
                    msg_id, msg_type, "BAD_REQUEST", "preview.log_clear before must be a timestamp"
                )
            )
            return
    removed = app.preview_log.clear(workspace_path, before=before)
    if removed:
        await app.broadcast(
            make_event(
                "preview.log_cleared",
                {"workspace_path": workspace_path, "before": before, "removed": removed},
            )
        )
    await session.send_json(make_response(msg_id, msg_type, {"removed": removed}))
