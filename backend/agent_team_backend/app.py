from __future__ import annotations

import asyncio
import secrets
import base64
import functools
import logging
import mimetypes
import os
import re
import shlex
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError
from uvicorn.protocols.utils import ClientDisconnected

from . import __version__
from . import agent_messaging
from . import hook_drain
from . import push_delivery
from .analyzer import DEFAULT_MODEL as ANALYZER_DEFAULT_MODEL
from .analyzer import (
    classify as _llama_classify,
    health as _llama_health,
    list_models as _llama_list_models,
    auto_answer as _llama_auto_answer,
    benchmark as _llama_benchmark,
    llama_cli_busy as _llama_cli_busy,
)
from .analyzer_ollama import (
    classify as _ollama_classify,
    health as _ollama_health,
    list_models as _ollama_list_models,
    auto_answer as _ollama_auto_answer,
    benchmark as _ollama_benchmark,
    pull_model as _ollama_pull_model,
    delete_model as _ollama_delete_model,
)
from .analyzer_settings import AnalyzerSettingsStore
from .ai_chat_settings import AIChatSettingsStore
from .applog import app_data_dir, backend_log_path, backend_port_file
from .cli_vendors.registry import VENDORS as _CLI_VENDORS
from .cli_vendors.registry import vendor as cli_vendor
from .codex_home import CodexHomeManager
from .ipc import make_error, make_event, make_response
from .log_readers import (
    ActivityEvent,
    LogWatcher,
    TokenSinkResult,
    TokenUsage,
)
from .log_readers.attribution import Attribution
from .log_readers.claude import encode_claude_cwd
from .credential_vault import CredentialVault
from .credential_watcher import CredentialWatcher, reconcile_live_account
from .doc_injector import fetch_stage_docs
from .mcp_manager import MCPManager
from .mcp_settings import (
    MCPServersDocument,
    MCPSettingsConflictError,
    MCPSettingsError,
    MCPSettingsStore,
    redact_mcp_server_secrets,
)
from .plan_index import PlanIndex
from .plan_provisioning import ensure_plan_assets, plan_spec_exists
from .profile_migration import migrate_legacy_claude_homes
from .profiles_store import CliProfilesStore
from .skills_store import SkillsStore
from .projects import ProjectStore
from .spawn_history import SpawnHistoryStore
from .recent_workspaces import RecentWorkspacesStore
from .roles_store import RolesStore
from .stages_store import StagesStore
from .db import DB_FILENAME, Database, WorkspaceDatabases
from .store_migrations import run_startup_migrations, version_change
from .terminals import TerminalService
from .tokens_store import TokensStore
from .ui_settings import UiSettingsStore
from .history_store import HistoryStore
from .agent_message_log import AgentMessageLog
from . import git_service
from . import issue_service
from . import fs_service
from . import pty_registry
from . import search_service
from . import server_link
from . import editor_service
from . import onboarding_deps
from . import plan_history
from .plugins import wiring as plugin_wiring
from .plugins.host import PluginHost
from . import ws_handlers
from .git_watcher import GitWatcher

log = logging.getLogger("agent_team_backend")

STARTED_AT = datetime.now(timezone.utc).isoformat()

app = FastAPI(title="navide-backend", version=__version__)

database = Database(app_data_dir() / DB_FILENAME)
workspace_databases = WorkspaceDatabases()
project_store = ProjectStore(databases=workspace_databases)
spawn_history_store = SpawnHistoryStore(databases=workspace_databases)
recent_workspaces_store = RecentWorkspacesStore(db=database)
roles_store = RolesStore(db=database)
stages_store = StagesStore(db=database)
tokens_store = TokensStore(db=database)
history_store = HistoryStore(databases=workspace_databases)
plan_index = PlanIndex(databases=workspace_databases)
# Cross-workspace by construction, so it lives in the global database.
agent_message_log = AgentMessageLog(db=database)
codex_home_manager = CodexHomeManager()
cli_profiles_store = CliProfilesStore(db=database)
credential_vault = CredentialVault()
mcp_manager = MCPManager()
plugin_host = PluginHost()
mcp_settings_store = MCPSettingsStore()
skills_store = SkillsStore()
analyzer_settings_store = AnalyzerSettingsStore(db=database)
ai_chat_settings_store = AIChatSettingsStore(db=database)
ui_settings_store = UiSettingsStore(db=database)
# Module-level stores share the same database handle.
pty_registry.set_database(database)
onboarding_deps.set_database(database)

# ─── Analyzer backend routing ────────────────────────────────────────────────

def _az_settings() -> dict:
    return analyzer_settings_store.get()

def _az_is_ollama() -> bool:
    return _az_settings().get("backend") == "ollama"

def _az_base_url() -> str:
    return _az_settings().get("ollama_base_url", "http://localhost:11434")

def _az_llama_cli() -> str | None:
    v = _az_settings().get("llama_cli", "").strip()
    return v or None

def _az_gguf_path() -> str | None:
    v = _az_settings().get("gguf_path", "").strip()
    return v or None

_AI_SECRET_KEYS = {
    "anthropic_api_key",
    "openai_api_key",
    "google_api_key",
    "groq_api_key",
    "deepseek_api_key",
    "mistral_api_key",
    "xai_api_key",
    "openai_compatible_api_key",
}


def _settings_paths() -> dict[str, str]:
    return {
        "app_data_dir": str(app_data_dir()),
        "roles": str(roles_store.path),
        "pipelines": str(stages_store.path),
        "mcp": str(mcp_settings_store.path),
        "skills": str(skills_store.root),
        "skills_state": str(skills_store.state_path),
        "analyzer": str(analyzer_settings_store.path),
        "ai_chat": str(ai_chat_settings_store.path),
        "backend_log": str(backend_log_path()),
    }


def _redact_ai_chat_settings(settings: dict[str, Any]) -> dict[str, Any]:
    return {
        key: ("__redacted__" if key in _AI_SECRET_KEYS and value else value)
        for key, value in settings.items()
        if key != "model"
    }


def _settings_bundle() -> dict[str, Any]:
    return {
        "format_version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "paths": _settings_paths(),
        "roles": roles_store.list(),
        "pipelines_document": stages_store.export_document(),
        "mcp_servers": redact_mcp_server_secrets(mcp_settings_store.list_servers()),
        "analyzer": analyzer_settings_store.get(),
        "ai_chat": _redact_ai_chat_settings(ai_chat_settings_store.get()),
        "notes": {
            "secrets": "API keys and tokens are redacted; local values are preserved on import.",
        },
    }


async def analyzer_health() -> dict:
    if _az_is_ollama():
        return await _ollama_health(_az_base_url())
    return await _llama_health(llama_cli_override=_az_llama_cli(), gguf_path_override=_az_gguf_path())

async def analyzer_list_models() -> list:
    if _az_is_ollama():
        return await _ollama_list_models(_az_base_url())
    return await _llama_list_models()

async def analyzer_classify(text: str, model: str) -> dict:
    if _az_is_ollama():
        return await _ollama_classify(text, model=model, base_url=_az_base_url())
    return await _llama_classify(text, model=model,
                                 llama_cli_override=_az_llama_cli(),
                                 gguf_path_override=_az_gguf_path())

async def analyzer_auto_answer(questions: list, task: str, stage_title: str, model: str) -> dict:
    if _az_is_ollama():
        return await _ollama_auto_answer(questions, task, stage_title, model=model, base_url=_az_base_url())
    return await _llama_auto_answer(questions, task, stage_title, model=model,
                                    llama_cli_override=_az_llama_cli(),
                                    gguf_path_override=_az_gguf_path())

async def analyzer_benchmark(progress_cb=None) -> list:
    if _az_is_ollama():
        return await _ollama_benchmark(_az_base_url(), progress_cb=progress_cb)
    return await _llama_benchmark(progress_cb=progress_cb)

# Log readers: one per vendor. Attribution maps log session files to panes.
# One reader per registered vendor — the registry is the single source.
_readers = [
    spec.make_log_reader()
    for spec in _CLI_VENDORS.values()
    if spec.make_log_reader is not None
]
attribution = Attribution(_readers, db=database)
_log_watcher: LogWatcher | None = None
_git_watcher: GitWatcher | None = None
_credential_watcher: CredentialWatcher | None = None


# Module-level registry of all currently-connected WebSocket sessions so that
# state changes (e.g. roles edits) can be broadcast to every window the user
# has open (main + role manager + future windows).
_SESSIONS: set["Session"] = set()


async def broadcast(event: dict[str, Any], *, exclude: "Session | None" = None) -> None:
    """Fire-and-forget send to every connected session (optionally minus one)."""
    for session in list(_SESSIONS):
        if session is exclude:
            continue
        try:
            await session.send_json(event)
        except Exception as err:  # noqa: BLE001
            # send_json already marks dead + discards on send failure; this is
            # a defensive net for anything unexpected it re-raised.
            log.warning("broadcast send failed: %s", err)
            _SESSIONS.discard(session)


async def unicast_any(event: dict[str, Any]) -> bool:
    """Send *event* to one arbitrary connected session.

    For requests any live window can service (e.g. a global UI action with no
    fixed owner), so a broadcast that every window would otherwise have to
    ignore is unnecessary. Returns False when no session is connected.
    """
    for session in list(_SESSIONS):
        if session.dead:
            continue
        try:
            await session.send_json(event)
        except Exception as err:  # noqa: BLE001
            # Same defensive net as broadcast(): try the next session rather
            # than failing the request outright.
            log.warning("unicast send failed: %s", err)
            _SESSIONS.discard(session)
            continue
        return True
    return False


class Session:
    """Per-WebSocket-connection state."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        # Handlers run as concurrent tasks and the PTY output pump writes too;
        # the websockets protocol forbids concurrent writes on one connection
        # (its drain assertion trips and wedges the socket permanently), so
        # every outbound frame must go through send_json() below.
        self._send_lock = asyncio.Lock()
        # Token attribution now happens via log_readers (background log scan),
        # NOT via PTY output. The TerminalService is app-level (PTYs outlive this
        # connection); output routes back through _active_emit → the attached
        # Session's send_json. See get_terminals().
        self.terminals = get_terminals()
        # Track background tasks so they can be cancelled on disconnect.
        self._review_tasks: set[asyncio.Task] = set()
        # In-flight handle_message tasks; cancelled in ws() finally so handlers
        # never outlive the connection and drain onto a closed socket.
        self._handler_tasks: set[asyncio.Task] = set()
        # terminal.create is transactional until its result is sent.  Gates
        # serialize generations for one pane; tombstones let a concurrent
        # terminal.create.cancel stop work before Popen; transactions hold the
        # post-Popen resources that cancellation must roll back.
        self._terminal_create_gates: dict[str, asyncio.Lock] = {}
        self._terminal_create_tombstones: set[tuple[str, str]] = set()
        self._terminal_create_transactions: dict[tuple[str, str], dict[str, Any]] = {}
        # In-flight find_in_files cancellation handle: a newer search from
        # this session sets the event so the superseded scan stops early.
        self._search_cancel: threading.Event | None = None
        # Set once the peer is gone (send failed or ws() loop exited). All
        # further send_json calls become silent no-ops.
        self.dead = False

    async def send_json(self, data: dict[str, Any]) -> None:
        """Serialized websocket send — sole writer for this connection.

        Never raises on a dead peer: the first send failure marks the session
        dead and removes it from _SESSIONS; subsequent calls are silent no-ops.
        Callers must not crash just because the client went away.
        """
        if self.dead:
            return
        try:
            async with self._send_lock:
                # Re-check under the lock: on disconnect, a swarm of producers
                # (broadcast + PTY output pump) can all pass the pre-lock guard
                # while dead is still False, then serialize here. Without this
                # re-check every one of them sends onto the closed socket, fails,
                # and logs — turning a single disconnect into thousands of
                # identical warnings that saturate the event loop. The first
                # failure sets dead=True; the rest must no-op as documented.
                if self.dead:
                    return
                await self.websocket.send_json(data)
        except (RuntimeError, WebSocketDisconnect, ClientDisconnected) as err:
            # RuntimeError: starlette's 'Cannot call "send" once a close
            # message has been sent'; ClientDisconnected: uvicorn transport
            # torn down mid-send.
            self.dead = True
            _SESSIONS.discard(self)
            # DEBUG, not WARNING: a peer that went away is this method's
            # documented path (window closed, HMR reload, app quit), so it is
            # not actionable — yet at one line per disconnect it was the single
            # most numerous message in the log. Logged with the exception TYPE
            # because these carry no message and rendered as an empty tail that
            # read like a truncated error.
            log.debug("ws peer gone (%s); marking session %#x dead", type(err).__name__, id(self))

    async def _send_event(self, event: dict[str, Any]) -> None:
        try:
            await self.send_json(event)
        except Exception as err:  # noqa: BLE001
            log.warning("send_event failed: %s", err)


async def _broadcast_git_changed(ws_path: str) -> None:
    """GitWatcher sink: a repo's working tree / .git changed on disk."""
    await broadcast(make_event("git.changed", {"workspace_path": ws_path}))


async def _broadcast_plans_changed(ws_path: str) -> None:
    """GitWatcher plans sink: a plan document under `.agent-team/plans/`
    changed on disk (any writer — App write path or an agent CLI editing the
    file directly). Record stage-transition snapshots first so subscribers
    refreshing on the event see up-to-date history, then notify."""
    try:
        await asyncio.to_thread(plan_history.snapshot_plans, ws_path)
    except Exception as err:  # noqa: BLE001
        log.warning("plan snapshot scan failed for %s: %s", ws_path, err)
    await broadcast(make_event("plans.changed", {"workspace_path": ws_path}))


_PLAN_DOC_PREFIXES = (
    ".agent-team/plans",
    ".agent-team/reports",
    ".claude/loop-reports",
    ".claude/plans",
    ".cursor/plans",
    "docs/plans",
    "docs/reports",
)


def _watch_plans_workspace(ws_path: str, rel_path: str) -> None:
    """A plan/report subtree fs access means a plan surface is open — start watching
    that workspace (idempotent) so plan edits push `plans.changed`."""
    if _git_watcher is not None and any(rel_path.startswith(prefix) for prefix in _PLAN_DOC_PREFIXES):
        _git_watcher.watch(ws_path)


def _watch_plans_workspace_now(ws_path: str) -> None:
    """Same, for callers whose request *is* the plans list (no rel_path to match)."""
    if _git_watcher is not None and ws_path:
        _git_watcher.watch(ws_path)


_ASKPASS_PROMPT_URL_RE = re.compile(r"for '([^']+)'")


def _extract_host_from_prompt(prompt: str) -> str:
    """Best-effort remote host extraction from a git askpass prompt, e.g.
    "Username for 'https://gitlab.com': " -> "gitlab.com". Empty string if the
    prompt doesn't match git's usual "<field> for '<url>':" format."""
    match = _ASKPASS_PROMPT_URL_RE.search(prompt)
    if not match:
        return ""
    try:
        return urlparse(match.group(1)).hostname or ""
    except ValueError:
        return ""


def build_credential_request_emitter(
    workspace_path: str,
) -> Callable[[str, str], Awaitable[None]]:
    """Build the `on_request` callback for git_service.create_askpass_context()
    (Phase C). Broadcasts a git.credential_request event to every connected
    session; frontends filter by workspace_path, same convention as
    git.changed. Each call corresponds to exactly one askpass prompt (git asks
    Username and Password as separate invocations), so `request_id` here
    identifies a single field's answer, not a combined credential pair."""

    async def _on_request(request_id: str, prompt: str) -> None:
        await broadcast(
            make_event(
                "git.credential_request",
                {
                    "request_id": request_id,
                    "workspace_path": workspace_path,
                    "host": _extract_host_from_prompt(prompt),
                    "prompt": prompt,
                },
            )
        )

    return _on_request


def build_credential_settled_emitter(
    workspace_path: str,
) -> Callable[[str, str | None], Awaitable[None]]:
    """Build the `on_settled` callback for git_service.create_askpass_context()
    (Phase C). Emits git.credential_cancelled only when a request settles with
    no value (timeout or explicit cancellation), so the frontend can close its
    modal; a successful submission needs no further event."""

    async def _on_settled(request_id: str, value: str | None) -> None:
        if value is None:
            await broadcast(
                make_event(
                    "git.credential_cancelled",
                    {"request_id": request_id, "workspace_path": workspace_path},
                )
            )

    return _on_settled


def _git_credential(payload: dict[str, Any]) -> dict[str, str] | None:
    """Extract a bound-account credential from a git op payload, if the renderer
    attached one (main-process safeStorage store, decrypted just for this op).
    Returns None when absent/malformed so git_service falls back to the normal
    interactive askpass flow."""
    cred = payload.get("credential")
    if isinstance(cred, dict) and cred.get("token"):
        return {"username": str(cred.get("username") or ""), "token": str(cred.get("token"))}
    return None


# ── App-level terminal ownership (true persistence) ──────────────────────────
# PTYs must outlive any single WebSocket: a renderer reload / window close drops
# the ws, but the terminal (agent CLI, bash, build) keeps running in the
# background until it exits, the user explicitly kills the pane, or the whole
# app quits. So a single app-level TerminalService owns every PTY.
# Output is routed per-PTY: each terminal session is owned by whichever WS
# Session created or last reattached to it. A second window never steals PTYs
# it didn't explicitly claim via terminal.create / terminal.reattach.
_TERMINALS: TerminalService | None = None
# terminal_session_id → owning WS Session. Populated on terminal.create and
# updated on terminal.reattach. Entries removed when the owning WS disconnects.
_PTY_OWNERS: "dict[str, Session]" = {}


# An autonomous PTY death (exit/EOF) must release the attribution registration
# — otherwise the pane's session marker leaks in _unbound_markers forever. But
# the release is DELAYED: the CLI's final log flush reaches attribution through
# the watcher's queue drain / 30s rescan AFTER the exit event, and a marker
# session may still bind late (short-lived run). Immediate unregister would
# drop that usage tail and the pane's resume id. terminal.create for the same
# pane cancels the pending cleanup (a renderer-reload respawn keeps its pane id).
_UNREGISTER_GRACE_SEC = 90.0
_PENDING_UNREGISTERS: dict[str, asyncio.TimerHandle] = {}


def _schedule_pane_unregister(pane_id: str) -> None:
    _cancel_pane_unregister(pane_id)

    def _fire() -> None:
        _PENDING_UNREGISTERS.pop(pane_id, None)
        attribution.unregister_pane(pane_id)

    _PENDING_UNREGISTERS[pane_id] = asyncio.get_running_loop().call_later(
        _UNREGISTER_GRACE_SEC, _fire
    )


def _cancel_pane_unregister(pane_id: str) -> None:
    handle = _PENDING_UNREGISTERS.pop(pane_id, None)
    if handle:
        handle.cancel()


async def _active_emit(event: dict[str, Any]) -> None:
    """Output sink: route each PTY's output to its owning Session."""
    payload = event.get("payload", {})
    # Runs before the owner check: cleanup applies even when the pane is
    # detached.
    if event.get("type") == "terminal.exit" and isinstance(payload, dict):
        exit_pane_id = payload.get("pane_id")
        if exit_pane_id:
            _schedule_pane_unregister(exit_pane_id)
    session_id = payload.get("terminal_session_id") if isinstance(payload, dict) else None
    if session_id and event.get("type") == "terminal.exit":
        sess = _PTY_OWNERS.pop(session_id, None)
    else:
        sess = _PTY_OWNERS.get(session_id) if session_id else None
    if sess is None:
        return  # detached: drop output, PTY keeps running, TUI redraws on reattach
    try:
        await sess.send_json(event)
    except Exception as err:  # noqa: BLE001
        log.warning("terminal output send failed: %s", err)


def get_terminals() -> TerminalService:
    """The one app-level TerminalService. Lazy (not at import) because
    TerminalService.__init__ binds to the running event loop."""
    global _TERMINALS
    if _TERMINALS is None:
        _TERMINALS = TerminalService(emit=_active_emit)
    return _TERMINALS


def _claim_ptys(session: "Session", terminal_session_ids: list[str]) -> None:
    """Transfer ownership of the given PTY ids to `session`."""
    for tid in terminal_session_ids:
        _PTY_OWNERS[tid] = session


# ── Ownerless-PTY janitor ────────────────────────────────────────────────────
# PTYs deliberately survive a WebSocket disconnect so a reloading renderer can
# reattach. But a renderer that never comes back (window closed for good, or
# a restore that spawned a REPLACEMENT PTY instead of reattaching) leaves the
# old PTY running detached forever — observed as a slow accumulation of idle
# `claude --resume` processes at 200-400MB each. The janitor kills a PTY only
# after it has had no owning WebSocket for a full grace period, which is far
# longer than any transient disconnect/reload.
_OWNERLESS_GRACE_SEC = 60 * 60.0
_OWNERLESS_SWEEP_INTERVAL_SEC = 5 * 60.0
# terminal_session_id → monotonic time it was first seen ownerless.
_OWNERLESS_SINCE: dict[str, float] = {}
_ownerless_sweeper_task: "asyncio.Task[None] | None" = None


async def _sweep_ownerless_ptys_once(now: float | None = None) -> list[str]:
    """One janitor pass: kill live PTYs ownerless longer than the grace.
    Returns the killed terminal ids (for tests/logging)."""
    if _TERMINALS is None:
        return []
    now = time.monotonic() if now is None else now
    live = set(_TERMINALS.list_session_ids())
    # A PTY that died or got (re)claimed is no longer a candidate.
    for tid in list(_OWNERLESS_SINCE):
        if tid not in live or tid in _PTY_OWNERS:
            _OWNERLESS_SINCE.pop(tid, None)
    killed: list[str] = []
    for tid in live:
        if tid in _PTY_OWNERS:
            continue
        first_seen = _OWNERLESS_SINCE.setdefault(tid, now)
        if now - first_seen < _OWNERLESS_GRACE_SEC:
            continue
        _OWNERLESS_SINCE.pop(tid, None)
        log.info(
            "ownerless-pty janitor: killing terminal %s (no owner for %.0fs)",
            tid,
            now - first_seen,
        )
        await _TERMINALS.kill(tid, force=True)
        killed.append(tid)
    return killed


async def _ownerless_pty_janitor() -> None:
    while True:
        await asyncio.sleep(_OWNERLESS_SWEEP_INTERVAL_SEC)
        try:
            await _sweep_ownerless_ptys_once()
        except Exception as err:  # noqa: BLE001 — the janitor must survive
            log.warning("ownerless-pty sweep failed: %s", err)


async def _maybe_announce_session(usage: TokenUsage) -> None:
    """Codex/Antigravity/Grok/OpenCode: when a session file is first matched to its pane,
    tell the frontend so it can persist the id/path for resume-on-restart."""
    bound = await asyncio.to_thread(attribution.maybe_announce_session, usage)
    if not bound:
        return
    await broadcast(make_event("session.detected", {
        "vendor": usage.vendor,
        "pane_id": bound.pane_id,
        "session_id": bound.resume_id,  # the id/path `<cli> resume` actually needs
        "workspace_path": bound.workspace_path or usage.cwd,
        "session_file": bound.session_file,
    }))


async def _on_session_file(vendor: str, path: Path) -> None:
    """Watcher session sink: a Codex/Antigravity/Grok/Kimi/OpenCode session file changed.
    Attempt marker binding directly off the file (decoupled from token parsing,
    so it works for session-file formats the token reader doesn't understand)."""
    reader = next((r for r in _readers if r.vendor == vendor), None)
    session_id = reader.session_id_from_path(path) if reader else path.stem
    if not session_id:
        return  # not a real session file (e.g. Kimi's state.json / logs)
    usage = TokenUsage(
        vendor=vendor, input_tokens=0, output_tokens=0,
        cwd=reader.cwd_from_file(path) if reader else "",
        session_id=session_id, file_path=str(path), dedup_key="",
    )
    await _maybe_announce_session(usage)


# Safety bound on the assistant turn text carried on turn_complete events. It
# only needs to keep a full turn (leading QUESTION block + trailing sentinel)
# intact; the cap is generous and, when exceeded, keeps BOTH ends so neither a
# head QUESTION block nor the last-line sentinel is lost. Long text rides once
# per turn (turn_complete); user-record agent_active events carry only a short
# prompt snippet (<= 500 chars), so this is not a per-line hot-path cost.
_ACTIVITY_TEXT_MAX_CHARS = 200_000


def _cap_activity_text(text: str) -> str:
    if len(text) <= _ACTIVITY_TEXT_MAX_CHARS:
        return text
    half = _ACTIVITY_TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


# Last agent-activity event per pane, for the Plan MCP server's cli_get_status
# / cli_wait_idle tools. Single most-recent entry per pane (not a history);
# text is kept only for turn_complete (agent_active only ever carries a short
# prompt snippet, not meant for replay outside pane naming).
_pane_activity: dict[str, dict[str, Any]] = {}


def pane_activity(pane_id: str) -> dict[str, Any] | None:
    return _pane_activity.get(pane_id)


def _record_pane_activity(pane_id: str, event_type: str, text: str) -> None:
    if not pane_id:
        return
    # Both writers here identify the pane through session attribution, which
    # records the id the PTY was created under — a pane rebuilt around a live
    # PTY (window reload, detach) answers to a newer one. cli_get_status and
    # cli_wait_idle look the pane up by its current id, so file the entry there.
    pane_id = agent_messaging.resolve_alias(pane_id) or pane_id
    _pane_activity[pane_id] = {
        "event_type": event_type,
        # Same cap as the broadcast path — this dict must not become the one
        # place an unbounded turn_complete text is retained.
        "text": _cap_activity_text(text) if event_type == "turn_complete" else "",
        "ts_monotonic": time.monotonic(),
    }


def forget_pane_activity(pane_id: str) -> None:
    """Drop a closed pane's entry so the cache tracks live panes only."""
    _pane_activity.pop(pane_id, None)
    hook_drain.forget_pane(pane_id)
    push_delivery.forget_pane(pane_id)


async def _on_log_activity(event: ActivityEvent) -> None:
    """Sink for agent-activity events (agent_active / turn_complete).

    Broadcasts to all sessions so the frontend watcher can use these signals
    as supplemental "agent still working" / "turn ended" indicators that
    don't depend on TUI buffer scanning.
    """
    try:
        # Attribution was designed for TokenUsage but only reads vendor/cwd/
        # file_path/session_id. Wrap as a placeholder so we get pane mapping.
        fake_usage = TokenUsage(
            vendor=event.vendor, input_tokens=0, output_tokens=0,
            cwd=event.cwd, session_id=event.session_id,
            file_path=event.file_path, dedup_key=event.dedup_key,
            timestamp=event.timestamp,
        )
        attributed = attribution.attribute(fake_usage)
        if attributed.workspace_path is None:
            # External session — skip; no pane to deliver to.
            return
        pane_id = attributed.pane_id or ""
        # A turn a Stop hook blocked is still written to the conversation log,
        # and its reader reports it as a turn end — after the hook already said
        # the agent is working on the message it was handed. Flagged rather than
        # relabelled: everything this event carries (the turn's text, and the
        # MSG blocks, sentinels and pane name derived from it) is real and still
        # wanted. Only "the pane is free now" is wrong, so only that is dropped.
        superseded = event.event_type == "turn_complete" and hook_drain.turn_end_is_superseded(
            pane_id
        )
        _record_pane_activity(
            pane_id, "agent_active" if superseded else event.event_type, event.text
        )
        await broadcast(make_event("agent.activity", {
            "vendor": event.vendor,
            "event_type": event.event_type,
            "superseded": superseded,
            "workspace_path": attributed.workspace_path,
            "pane_id": pane_id,
            "stage_id": attributed.stage_id or "",
            "session_id": event.session_id,
            "cwd": event.cwd,
            "timestamp": event.timestamp,
            "detail": event.detail,
            # Assistant turn text (turn_complete) for sentinel/question
            # judgment, or the user's prompt snippet (<= 500 chars) on
            # user-record agent_active events for pane naming. Bounded but
            # generous — see _ACTIVITY_TEXT_MAX_CHARS.
            "text": _cap_activity_text(event.text),
        }))
    except Exception as err:  # noqa: BLE001
        log.warning("activity sink failed: %s", err)


# A startup rescan of historical CLI logs emits thousands of token events in a
# burst; broadcasting a full workspace snapshot per event saturated the event
# loop and starved concurrent requests past the frontend's 10s timeout (real
# case: terminal.create timeouts during session restore, 2026-07-14). Coalesce
# to at most one broadcast per workspace per window; the trailing snapshot
# includes every record accumulated during the wait.
_TOKENS_BROADCAST_DEBOUNCE_SEC = 0.3
_pending_tokens_broadcast: set[str] = set()


def _schedule_tokens_broadcast(workspace_path: str) -> None:
    if workspace_path in _pending_tokens_broadcast:
        return
    _pending_tokens_broadcast.add(workspace_path)

    async def _fire() -> None:
        try:
            await asyncio.sleep(_TOKENS_BROADCAST_DEBOUNCE_SEC)
        finally:
            _pending_tokens_broadcast.discard(workspace_path)
        await broadcast(
            make_event("tokens.changed", tokens_store.snapshot(workspace_path))
        )

    asyncio.create_task(_fire())


# Historic-log backfill can enqueue hundreds of files; coalesce the per-file
# progress into at most one broadcast per workspace per window (same lesson as
# the token burst above) so the indicator updates smoothly without flooding.
_BACKFILL_BROADCAST_DEBOUNCE_SEC = 0.3
_pending_backfill_broadcast: set[str] = set()
_backfill_remaining: dict[str, int] = {}


def _on_backfill_progress(workspace_path: str, remaining: int) -> None:
    """LogWatcher progress_sink (runs on the loop): remember the latest count and
    debounce-broadcast `backfill.changed` so the UI can show a small status."""
    _backfill_remaining[workspace_path] = remaining
    if workspace_path in _pending_backfill_broadcast:
        return
    _pending_backfill_broadcast.add(workspace_path)

    async def _fire() -> None:
        try:
            await asyncio.sleep(_BACKFILL_BROADCAST_DEBOUNCE_SEC)
        finally:
            _pending_backfill_broadcast.discard(workspace_path)
        count = _backfill_remaining.get(workspace_path, 0)
        await broadcast(make_event("backfill.changed", {
            "workspace_path": workspace_path,
            "active": count > 0,
            "count": count,
        }))

    asyncio.create_task(_fire())


async def _on_log_token_usage(usage: TokenUsage) -> TokenSinkResult:
    """Sink for token events from CLI log files.

    Drops events not associated with any registered Agent-Team workspace so
    the All-time tally only counts usage in workspaces the user has actually
    opened in Agent-Team. Passes the event's dedup_key to tokens_store so
    re-rescans after workspace registration don't double-count.
    """
    try:
        attributed = attribution.attribute(usage)
        if usage.replay_workspace:
            if attributed.workspace_path != usage.replay_workspace:
                # Shared sources (notably Grok's single SQLite DB) contain rows
                # for many workspaces. This row is safely consumed for the
                # target workspace, but must not be attributed or retried.
                return TokenSinkResult(True)
            workspace_path = usage.replay_workspace
        else:
            workspace_path = attributed.workspace_path
        if workspace_path is None:
            # External session — outside any registered workspace. Skip silently.
            return TokenSinkResult(False)
        # Namespace the dedup key by vendor + file_path so collisions across
        # vendors (unlikely but possible) can't masquerade as the same event.
        composite_key = f"{usage.vendor}::{usage.file_path}::{usage.dedup_key}"
        handled = tokens_store.record(
            workspace_path,
            source="cli",
            vendor=usage.vendor,
            agent_key=usage.vendor,
            # Prefer stable slot_key as the by_pane bucket so data survives
            # frontend restarts; fall back to ephemeral pane_id for manual panes.
            pane_id=attributed.slot_key or attributed.pane_id,
            stage_id=attributed.stage_id,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            dedup_key=composite_key,
            ingestion_file=usage.file_path,
            ingestion_checkpoint=usage.checkpoint,
            replay_workspace=usage.replay_workspace,
            legacy_dedup_key=usage.dedup_key,
        )
        _schedule_tokens_broadcast(workspace_path)
        return TokenSinkResult(handled, workspace_path)
    except Exception as err:  # noqa: BLE001
        log.warning("log token sink failed: %s", err)
        return TokenSinkResult(False)


def _stable_pane_key(metadata: dict, fallback: str) -> str:
    """Return a key for tokens_store.by_pane that survives frontend restarts.

    Pipeline panes use "<stage_id>:<slot_label>" (e.g. "01:architect") so the
    key is deterministic across sessions. Manual panes (no stage/slot) fall
    back to the ephemeral pane UUID — they don't persist across restarts anyway.
    """
    stage = str(metadata.get("stage_id") or metadata.get("stageId") or "").strip()
    slot  = str(metadata.get("slot_label") or "").strip()
    if stage and slot:
        return f"{stage}:{slot}"
    if stage:
        return stage
    return fallback


def _register_workspace_and_backfill(workspace_path: str) -> None:
    """Idempotent: associate the workspace with its CLI folders AND trigger a
    one-shot LogWatcher re-rescan so historic sessions in those folders get
    retroactively counted into the workspace's cumulative."""
    if not workspace_path:
        return
    is_new = workspace_path not in attribution.known_workspaces()
    attribution.register_workspace(workspace_path)
    # Provision plan-document infrastructure (_spec.md + _template.html) into
    # <workspace>/.agent-team/plans/. Idempotent, never overwrites, never
    # raises — see plan_provisioning.
    ensure_plan_assets(workspace_path)
    if is_new and _log_watcher is not None:
        # New association → parse from this workspace's independent checkpoint
        # so cumulative populates without double-counting Global. Scope to THIS
        # workspace so we don't
        # re-parse the entire (multi-GB) Claude history and stall the loop.
        #
        # force_rescan still enumerates session files synchronously (Codex
        # readers fall back to ALL their files), which blocks the event
        # loop and stalls every terminal.create queued behind it. Run it
        # off-loop so spawns return immediately; the rescan only backfills
        # stats, so its timing isn't on the critical path.
        watcher = _log_watcher
        try:
            asyncio.get_running_loop().run_in_executor(
                None, watcher.force_rescan, workspace_path
            )
        except RuntimeError:
            # No running loop (non-async caller) — fall back to inline.
            watcher.force_rescan(workspace_path)


_INHERITED_CLI_HOME_VARS = (
    "GROK_HOME",
    # Not home relocators, but the same inheritance hazard with a worse
    # failure mode: runtime markers a CLI stamps on its own subprocesses.
    # Claude Code's child-session marker makes an inheriting pane skip
    # transcript saving (observed: `pnpm dev` launched from a claude pane —
    # the pane works all day and restores as a blank after restart). Grok's
    # child markers are the same shape, stripped preemptively; they are
    # process-lifecycle flags no user config legitimately sets.
)


def _inherited_cli_home_vars() -> tuple[str, ...]:
    """Legacy table plus every migrated vendor's declared home vars. A var a
    vendor's round moves into its spec is deleted from the tuple above; until
    every round lands, the union covers both."""
    from .cli_vendors.registry import VENDORS

    merged = dict.fromkeys(_INHERITED_CLI_HOME_VARS)
    for spec in VENDORS.values():
        merged.update(dict.fromkeys(spec.home_env_vars))
    return tuple(merged)


def _sanitize_inherited_cli_env() -> None:
    """Drop CLI home-relocating vars inherited from whatever launched us.

    The account design assumes every CLI reads its real home; an inherited
    relocation (e.g. `pnpm dev` run from a pane that still carried
    CLAUDE_CONFIG_DIR) would silently poison every spawned pane and
    log-reader scan with a home nobody's sessions live in.
    """
    for key in _inherited_cli_home_vars():
        if os.environ.pop(key, None) is not None:
            log.info("dropped inherited %s from backend environment", key)


@app.on_event("startup")
async def _start_log_watcher() -> None:
    _sanitize_inherited_cli_env()

    # Push channels read the user's per-vendor switches through this rather
    # than importing the settings store, which imports back into here.
    push_delivery.set_disabled_reader(
        lambda: set(
            ui_settings_store.get().get(push_delivery.DISABLED_SETTING_KEY) or []
        )
    )
    # Per-pane watch files hold message text in the clear and belong to panes
    # that died with the previous process. Only a startup sweep ever removes
    # the ones a killed backend left behind.
    try:
        await asyncio.to_thread(push_delivery.sweep_runtime_files)
    except Exception as err:  # noqa: BLE001
        log.warning("push watch-file sweep failed: %s", err)

    # One-time data protection on a version upgrade: back up the persisted JSON
    # stores and forward-migrate their schema. Idempotent and best-effort —
    # run_startup_migrations never raises, so it can't block startup. File I/O
    # runs off the event loop.
    try:
        await asyncio.to_thread(run_startup_migrations)
    except Exception as err:  # noqa: BLE001
        log.warning("store backup/migration failed: %s", err)

    # One-time: fold legacy isolated claude profile homes back into the real
    # home (session logs + credential harvest). Idempotent — migrated homes
    # are archived, so a restart finds nothing to do. Runs before the log
    # watcher starts so the merged sessions are in its very first scan.
    try:
        await asyncio.to_thread(
            migrate_legacy_claude_homes, cli_profiles_store, credential_vault
        )
    except Exception as err:  # noqa: BLE001
        log.warning("legacy CLI profile home migration failed: %s", err)

    # One-time promotion of credentials still living in legacy per-profile
    # isolated homes into their slots (+ the live location for the active
    # account). Idempotent; background task — credential I/O must never block
    # startup.
    asyncio.create_task(
        credential_vault.promote_profile_home_secrets(cli_profiles_store)
    )

    # Sweep leftover isolated login homes into their slots, independently of
    # the usage poller (which only harvests while usage polling is enabled).
    # Background task — credential I/O must never block startup.
    from .usage_service import sweep_pending_login_homes

    asyncio.create_task(sweep_pending_login_homes())

    # Reap PTY children left behind by a previous run that died without its
    # shutdown sweep (SIGKILL, crash). Blocking ps/sleep — off the loop.
    try:
        await asyncio.to_thread(pty_registry.reap_stale)
    except Exception as err:  # noqa: BLE001
        log.warning("pty orphan reap failed: %s", err)

    # Kill PTYs whose owning WebSocket never came back (see janitor above).
    global _ownerless_sweeper_task
    _ownerless_sweeper_task = asyncio.create_task(_ownerless_pty_janitor())

    global _log_watcher
    _log_watcher = LogWatcher(
        sink=_on_log_token_usage,
        activity_sink=_on_log_activity,
        session_sink=_on_session_file,
        # Scope periodic/startup backfill to opened workspaces so the drain task
        # never re-stats the entire multi-GB CLI history (which stalled the loop).
        workspace_provider=attribution.known_workspaces,
        checkpoint_provider=tokens_store.get_ingestion_checkpoint,
        checkpoint_sink=tokens_store.advance_ingestion_checkpoint,
        progress_sink=_on_backfill_progress,
    )
    for r in _readers:
        _log_watcher.add_reader(r)
    _log_watcher.start()

    # Git filesystem watcher: fires `git.changed` near-instantly when the
    # working tree or `.git` state changes on disk (external edits, another
    # terminal running git). Workspaces are registered lazily on first
    # git.status — see the WebSocket handler.
    global _git_watcher
    _git_watcher = GitWatcher(_broadcast_git_changed, on_plans_change=_broadcast_plans_changed)
    _git_watcher.start()

    # CLI credential watcher: a sign-in outside Navide (a plain `claude /login`)
    # rewrites the live credentials without touching the profile ledger. This
    # notices the new identity and re-points `defaults[agentKey]` at the account
    # that is actually live — no credential is ever moved.
    global _credential_watcher
    _credential_watcher = CredentialWatcher(reconcile_live_account)
    _credential_watcher.start()

    # Navide-Server control-plane link: dials out to the configured server and
    # publishes this machine's pane roster so agents on other devices can
    # address it. Does nothing at all when no server URL / access token is
    # configured, which is every single-machine install.
    await server_link.start()

    # Start MCP servers in the background so they're ready for the first pipeline run.
    asyncio.create_task(mcp_manager.startup())

    # Best-effort install of every vendor's CLI hooks, pointing them at this
    # backend for reliable "agent active / turn complete / parked on a prompt"
    # signals that buffer scanning cannot give. Each installer no-ops when its
    # CLI's config root is absent, and failure is non-fatal — the orchestrator
    # falls back to log-tail + sentinel detection.
    for _key, _spec in _CLI_VENDORS.items():
        if _spec.install_hooks is None:
            continue
        try:
            result = _spec.install_hooks(str(backend_port_file()))
            log.info("%s hooks install: %s", _key, result)
        except Exception as err:  # noqa: BLE001
            log.warning("%s hooks install failed: %s", _key, err)

    # Backend plugin host: discover, load and activate onStartup plugins from
    # the bundled builtin dir plus AGENT_TEAM_PLUGINS_DIR, then apply what
    # they registered (HTTP routes, startup hooks). Guarded — plugins must
    # never block startup; per-plugin/per-hook failures are isolated inside
    # the wiring layer.
    try:
        activated = await asyncio.to_thread(plugin_wiring.startup, plugin_host)
        if activated:
            log.info("backend plugins activated: %s", activated)
        plugin_wiring.apply_routes(plugin_host, app.router)
        await plugin_wiring.run_startup_hooks(plugin_host)
    except Exception as err:  # noqa: BLE001
        log.warning("plugin host startup failed: %s", err)


@app.on_event("shutdown")
async def _stop_log_watcher() -> None:
    global _log_watcher, _git_watcher, _credential_watcher
    if _ownerless_sweeper_task is not None:
        _ownerless_sweeper_task.cancel()
    # PTY children are detached process groups (start_new_session=True); they
    # must be killed here or they outlive the app as CPU-spinning orphans.
    # Guarded so a sweep failure never skips the watcher/MCP teardown below.
    if _TERMINALS is not None:
        try:
            await _TERMINALS.kill_all()
        except Exception as err:  # noqa: BLE001
            log.warning("pty shutdown sweep failed: %s", err)
    if _log_watcher is not None:
        _log_watcher.stop()
    try:
        tokens_store.flush()
    except Exception as err:  # noqa: BLE001
        log.warning("token store shutdown flush failed: %s", err)
    if _git_watcher is not None:
        _git_watcher.stop()
    if _credential_watcher is not None:
        _credential_watcher.stop()
    await server_link.stop()
    await mcp_manager.shutdown()
    try:
        await plugin_wiring.run_shutdown_hooks(plugin_host)
    except Exception as err:  # noqa: BLE001
        log.warning("plugin shutdown hooks failed: %s", err)
    try:
        plugin_wiring.shutdown(plugin_host)
    except Exception as err:  # noqa: BLE001
        log.warning("plugin host shutdown failed: %s", err)
    # Last: nothing may touch the databases after this point.
    try:
        workspace_databases.close_all()
    except Exception as err:  # noqa: BLE001
        log.warning("workspace database close failed: %s", err)
    try:
        database.close()
    except Exception as err:  # noqa: BLE001
        log.warning("database close failed: %s", err)
    _log_watcher = None
    _git_watcher = None
    _credential_watcher = None


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "started_at": STARTED_AT,
        "backend_log": str(backend_log_path()),
    }


# Font mimes served inline (specimen @font-face fetch, /fs/page subresources).
_FONT_MIMES = ("font/ttf", "font/otf", "font/woff", "font/woff2")


def _serve_workspace_file(workspace: str, rel: str, *, allow_css: bool = False) -> FileResponse:
    """Serve a workspace file over HTTP (Range/206 handled by FileResponse).

    Shared policy for /fs/raw and /fs/page. Same trust boundary as the ws
    fs.* handlers: the workspace argument is not checked against a
    known-workspace set (fs.list_dir does not do that either) — any existing
    directory is accepted, and path safety (escape + .agent-team guard) is
    enforced by fs_service._resolve_safe.

    Media, fonts, PDF, and (X)HTML are served inline (plus text/css when
    ``allow_css`` — /fs/page relative subresources); HTML is confined by
    `Content-Security-Policy: sandbox` (opaque origin, no scripts/forms/
    plugins) for the sandboxed iframe preview. Every other type is downgraded
    to an application/octet-stream attachment.
    """
    try:
        target = fs_service._resolve_safe(workspace, rel)
    except fs_service.FsError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if target.is_dir():
        raise HTTPException(status_code=400, detail="path is a directory")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    # XSS hardening: only types the preview pane embeds are served inline.
    # HTML is inline for the sandboxed iframe preview but neutralized by
    # `Content-Security-Policy: sandbox` — the document runs in an opaque
    # origin with scripts/forms/plugins blocked. Every other non-media type
    # is downgraded to an opaque attachment. PDF is exempt from the CSP
    # sandbox because it would disable Chromium's embedded viewer.
    inline = (
        media_type in ("application/pdf", "text/html", "application/xhtml+xml")
        or media_type in _FONT_MIMES
        or (allow_css and media_type == "text/css")
        or media_type.startswith(("image/", "video/", "audio/"))
    )
    headers = {"X-Content-Type-Options": "nosniff"}
    if media_type != "application/pdf":
        headers["Content-Security-Policy"] = "sandbox"
    if not inline:
        return FileResponse(
            target,
            media_type="application/octet-stream",
            filename=target.name,
            content_disposition_type="attachment",
            headers=headers,
        )
    return FileResponse(target, media_type=media_type, headers=headers)


@app.get("/fs/raw")
async def fs_raw(workspace: str, rel: str) -> FileResponse:
    """Serve a raw workspace file (query-addressed). See _serve_workspace_file."""
    return _serve_workspace_file(workspace, rel)


@app.get("/fs/page/{ws_b64}/{rel:path}")
async def fs_page(ws_b64: str, rel: str) -> FileResponse:
    """Serve a workspace file path-addressed so relative subresources resolve.

    ``ws_b64`` is the URL-safe base64 of the absolute workspace path (padding
    optional). Same policy as /fs/raw, plus text/css inline — an HTML preview
    loaded from this route can fetch its ./style.css, images, and fonts via
    relative URLs.
    """
    try:
        padded = ws_b64 + "=" * (-len(ws_b64) % 4)
        workspace = base64.urlsafe_b64decode(padded).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="invalid workspace encoding") from exc
    return _serve_workspace_file(workspace, rel, allow_css=True)


@app.get("/mcp/servers")
async def list_mcp_servers() -> dict[str, Any]:
    try:
        servers = await asyncio.to_thread(mcp_settings_store.list_servers)
    except MCPSettingsError as err:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "MCP_SETTINGS_INVALID",
                "message": str(err),
                "details": {"path": str(mcp_settings_store.path)},
            },
        ) from err
    return {
        "servers": servers,
        "path": str(mcp_settings_store.path),
        "revision": str(mcp_settings_store.revision),
    }


def _mcp_expected_revision(payload: dict[str, Any]) -> int:
    raw = payload.get("expected_revision")
    if raw is None:
        raise HTTPException(
            status_code=428,
            detail={
                "code": "MCP_REVISION_REQUIRED",
                "message": "expected_revision is required",
                "details": {"field": "expected_revision"},
            },
        )
    if isinstance(raw, bool) or not isinstance(raw, (str, int)):
        revision = None
    else:
        try:
            revision = int(raw)
        except ValueError:
            revision = None
    if revision is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "MCP_VALIDATION_ERROR",
                "message": "expected_revision must be an integer revision string",
                "details": {"field": "expected_revision"},
            },
        )
    return revision


def _raise_mcp_http_store_error(err: MCPSettingsError) -> None:
    if isinstance(err, MCPSettingsConflictError):
        detail = {
            "code": "MCP_SETTINGS_CONFLICT",
            "message": str(err),
            "details": {
                "expected_revision": str(err.expected_revision),
                "actual_revision": str(err.actual_revision),
                "path": str(mcp_settings_store.path),
            },
        }
    else:
        detail = {
            "code": "MCP_SETTINGS_INVALID",
            "message": str(err),
            "details": {"path": str(mcp_settings_store.path)},
        }
    raise HTTPException(status_code=409, detail=detail) from err


@app.put("/mcp/servers")
async def replace_mcp_servers(payload: dict[str, Any]) -> dict[str, Any]:
    expected_revision = _mcp_expected_revision(payload)
    try:
        document = MCPServersDocument.model_validate(payload)
    except ValidationError as err:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "MCP_VALIDATION_ERROR",
                "message": "invalid MCP server settings",
                "details": {"errors": err.errors()},
            },
        ) from err
    try:
        servers = await asyncio.to_thread(
            mcp_settings_store.replace_servers,
            [server.model_dump() for server in document.servers],
            expected_revision,
        )
    except MCPSettingsError as err:
        _raise_mcp_http_store_error(err)
    await mcp_manager.reload(mcp_settings_store.path)
    return {
        "ok": True,
        "servers": servers,
        "revision": str(mcp_settings_store.revision),
    }


@app.post("/mcp/servers/reset")
async def reset_mcp_servers(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    expected_revision = _mcp_expected_revision(payload or {})
    try:
        servers = await asyncio.to_thread(
            mcp_settings_store.reset,
            expected_revision,
        )
    except MCPSettingsError as err:
        _raise_mcp_http_store_error(err)
    await mcp_manager.reload(mcp_settings_store.path)
    return {
        "ok": True,
        "servers": servers,
        "revision": str(mcp_settings_store.revision),
    }


# Derived, not listed: a vendor that installs hooks is exactly the one allowed
# to post them back. Keeping these in step by construction means a new vendor
# cannot end up installing hooks the endpoint then rejects.
_HOOK_VENDORS = frozenset(
    key for key, spec in _CLI_VENDORS.items() if spec.install_hooks is not None
)


@app.post("/hooks/{vendor}")
async def cli_hook(vendor: str, request: Request) -> Any:
    """Receive a CLI hook payload.

    Hook commands installed by `claude_hooks` / `qwen_hooks` / `copilot_hooks`
    POST here with:
      - Header X-Agent-Team-Event: pre_tool_use | stop | notification
      - Body: the JSON payload the CLI pipes to the hook on stdin

    The three vendors disagree on where hooks are configured but agree on what
    a notification says — same `notification_type` vocabulary — so one handler
    serves all of them and `vendor` only labels the broadcast. The path is
    parameterized rather than per-vendor so hooks written by an older build,
    which point at /hooks/claude, keep resolving here unchanged.

    We map these to `agent.activity` broadcasts so the frontend watcher gets
    100% reliable signals without buffer-scanning. We do NOT pane-attribute
    here (the hook payload has cwd + session_id; we let the frontend match
    by current-stage panes based on those).
    """
    if vendor not in _HOOK_VENDORS:
        return {"ok": False, "reason": f"unknown hook vendor: {vendor!r}"}
    event_kind = request.headers.get("X-Agent-Team-Event", "").strip()
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    # Map the CLI's lifecycle to our two event_type buckets.
    if event_kind == "stop":
        event_type = "turn_complete"
    elif event_kind in ("pre_tool_use", "notification"):
        event_type = "agent_active"
    else:
        return {"ok": False, "reason": f"unknown event kind: {event_kind!r}"}

    session_id = str(payload.get("session_id") or payload.get("sessionId") or "")
    cwd = str(payload.get("cwd") or "")
    # Notification fires for eight different situations and only some mean "the
    # user has to act" — permission_prompt blocks the turn, idle_prompt fires
    # every time Claude finishes and waits for the next instruction. Forwarded
    # raw; the frontend owns which ones raise its AWAITING badge. Empty on
    # every other event kind, and on Claude versions that predate the field.
    # Both vendors use the same vocabulary here (qwen fires permission_prompt /
    # idle_prompt / auth_success from the same field).
    notification_type = str(payload.get("notification_type") or "")
    # Resolve pane_id from session_id (claimed by the JSONL path). Hook payloads
    # have no file_path so they can't pass attribute()'s workspace gate; this
    # lookup bypasses it. Race (stop before JSONL claimed the session) → empty
    # pane_id, and the JSONL path's matching event supplies it shortly.
    pane_id, ws_path, stage_id = attribution.pane_for_session(session_id)
    # Stop-hook delivery: a claude pane with a message waiting is told to keep
    # going and act on it, instead of stopping and being typed at afterwards.
    # Only claude, because only its Stop hook can block — and only its hook
    # command forwards this response body to the CLI's stdin-reading parser.
    blocked_envelope = ""
    if vendor == "claude" and event_kind == "stop":
        blocked_envelope = await hook_drain.drain_for_stop_hook(
            pane_id or "", stop_hook_active=bool(payload.get("stop_hook_active"))
        )
        if blocked_envelope:
            # The turn did not end: Claude picks the message up as its next
            # instruction. Reporting turn_complete here would make the frontend
            # call the pane idle and start injecting the NEXT queued message
            # over stdin, into a pane that is already working.
            event_type = "agent_active"
    if pane_id:
        # The log-reader sink is not the only writer of _pane_activity any
        # more: for the hook vendors the Stop hook is the earliest and most
        # reliable end-of-turn signal there is, and cli_wait_idle could not see
        # it — it had to sit out the 10s quiet threshold instead. Hook payloads
        # carry no assistant text, so keep the text the sink already recorded
        # for this same turn rather than blanking it.
        prior = _pane_activity.get(pane_id)
        prior_text = prior["text"] if prior and event_type == "turn_complete" else ""
        _record_pane_activity(pane_id, event_type, prior_text)
    await broadcast(make_event("agent.activity", {
        "vendor": vendor,
        "event_type": event_type,
        "workspace_path": ws_path or cwd,
        "pane_id": pane_id or "",
        "stage_id": stage_id or "",
        "session_id": session_id,
        "cwd": cwd,
        "timestamp": "",
        "detail": "hook:stop-blocked" if blocked_envelope else f"hook:{event_kind}",
        "notification_type": notification_type,
    }))
    if vendor == "claude" and event_kind == "stop":
        # This body is read by Claude Code as the Stop hook's own output, so it
        # is either a valid decision object or nothing at all: an unrecognized
        # object on a hook's stdout is reported to the user as a hook error.
        if blocked_envelope:
            return JSONResponse({"decision": "block", "reason": blocked_envelope})
        return Response(status_code=200)
    return {"ok": True}


#: How long a rewake waiter waits for its session to be attributed to a pane
#: before giving up. SessionStart fires before the conversation log exists, so a
#: fresh pane has nothing to match on for a moment; a pane that never resolves
#: (an external `claude` the user started themselves) simply gets no channel,
#: and the Stop hook re-arms one later if it ever does.
_REWAKE_ATTRIBUTION_WAIT_S = 30.0

#: How often a parked waiter checks that the hook is still on the other end.
#: The hook is a curl the CLI backgrounded, and it dies with the CLI: a user
#: running `/exit` inside a pane that stays open takes it with them, and nothing
#: about that reaches the future the request is awaiting.
_REWAKE_DISCONNECT_POLL_S = 1.0


async def _hook_still_connected(request: Request) -> None:
    """Return once the hook's HTTP connection is gone.

    Polled rather than awaited on an event, because that is all the ASGI
    contract offers. Cheap: one call a second per parked pane, and the pane
    count is the number of claude panes open.
    """
    while True:
        if await request.is_disconnected():
            return
        await asyncio.sleep(_REWAKE_DISCONNECT_POLL_S)


async def _rewake_pane_id(session_id: str) -> str:
    """The pane this session belongs to, waiting a little for it to be known."""
    deadline = time.monotonic() + _REWAKE_ATTRIBUTION_WAIT_S
    while True:
        pane_id, _, _ = attribution.pane_for_session(session_id)
        if pane_id or time.monotonic() >= deadline:
            return pane_id or ""
        await asyncio.sleep(0.5)


async def _announce_push_state(pane_id: str, kind: str, ready: bool) -> None:
    await broadcast(
        make_event("agent_msg.push_state", {
            "pane_id": pane_id, "kind": kind, "ready": ready,
        })
    )


@app.post("/hooks/claude/rewake")
async def claude_rewake_hook(request: Request) -> Response:
    """Park a claude pane's background hook until there is a message for it.

    This is the idle half of Stop-hook delivery. The Stop hook covers a message
    that lands while the agent is working; a pane sitting idle runs no hook at
    all, so instead one is left waiting here. Answering it with an envelope
    makes Claude Code wake the agent and show that text as a system reminder,
    without anything being typed into the pane.

    The response body IS the protocol: non-empty means "wake, and say this",
    empty means "nothing to report" and the hook exits without a decision. The
    wait is bounded well inside the hook's own deadline, so this side is always
    the one that gives up first — the reverse would resolve a message into a
    hook that had already gone.

    The waiter is also given up the moment the connection drops. A message
    handed to a hook that is no longer there would be marked delivered with no
    agent anywhere near it, and that is exactly what a user running `/exit`
    inside a pane they leave open produces.
    """
    if not secrets.compare_digest(
        request.query_params.get("t", ""), push_delivery.rewake_token()
    ):
        # A request from a previous backend run, or from something that never
        # went through the installer. Empty body: a hook reading a 403 must
        # still exit without a decision rather than showing the user an error.
        return Response(status_code=403)
    if push_delivery.channel_for("claude") is None:
        # Answered before the attribution wait below rather than after it: a
        # switched-off channel, or a `claude` the user started outside Navide,
        # would otherwise leave a background curl parked here for 30 seconds on
        # every single Stop, for a pane that is never going to get a waiter.
        return Response(status_code=200)
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        payload = {}
    session_id = str((payload or {}).get("session_id") or "") if isinstance(payload, dict) else ""
    pane_id = await _rewake_pane_id(session_id) if session_id else ""
    # Session attribution answers with the id the PTY was created under; the
    # window pushes to the id the pane answers to now. Park the waiter on the
    # latter or a reattached pane would never be woken.
    pane_id = agent_messaging.resolve_alias(pane_id) or pane_id
    if not pane_id:
        return Response(status_code=200)
    if push_delivery.register_hook_pane(pane_id, "claude") is None:
        return Response(status_code=200)
    armed = push_delivery.arm_hook(pane_id)
    if armed is None:
        return Response(status_code=200)
    request_id, future = armed
    await _announce_push_state(pane_id, push_delivery.KIND_HOOK, True)
    envelope = ""
    try:
        waiting = asyncio.ensure_future(
            push_delivery.wait_for_hook(pane_id, request_id, future)
        )
        watching = asyncio.ensure_future(_hook_still_connected(request))
        done, _ = await asyncio.wait(
            {waiting, watching}, return_when=asyncio.FIRST_COMPLETED
        )
        if waiting in done:
            watching.cancel()
            envelope = waiting.result() or ""
        else:
            # The hook is gone. Drop the waiter BEFORE awaiting anything else,
            # so a push arriving in between cannot resolve into it.
            push_delivery.discard_waiter(pane_id, request_id)
            waiting.cancel()
    finally:
        if not push_delivery.is_ready(pane_id):
            await _announce_push_state(pane_id, push_delivery.KIND_HOOK, False)
    if not envelope:
        return Response(status_code=200)
    return Response(content=envelope, media_type="text/plain; charset=utf-8")


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    log.info("ws client connected")
    session = Session(websocket)
    _SESSIONS.add(session)
    # An MCP client reads this backend's tool list once, when it connects, so a
    # CLI that was already talking to the previous backend keeps the tools it
    # saw then. Told to the window rather than logged: only the window can put
    # it in front of the person who has to reopen the pane. Sent on every
    # connect because a window may open at any point after startup; the feed
    # dedupes it by id.
    changed = version_change()
    if changed is not None:
        await session.send_json(
            make_event("app.version_changed", {"from": changed[0], "to": changed[1]})
        )
    try:
        while True:
            if session.dead:
                # A send already failed on this connection; stop receiving.
                log.info("ws session marked dead; closing receive loop")
                break
            try:
                msg = await websocket.receive_json()
            except (ValueError, KeyError) as parse_err:
                # Malformed JSON frame — log and continue; don't crash the session.
                log.warning("ws malformed message (ignored): %s", parse_err)
                continue
            # Dispatch each message as a concurrent task so long-running handlers
            # (e.g. analyzer.classify that takes 10-60s for LLM inference) never
            # block the receive loop.  Without this, a classify in flight would
            # cause terminal.create messages to queue in the OS buffer and time
            # out on the frontend's 10-second deadline.
            task = asyncio.create_task(handle_message(session, msg))
            session._handler_tasks.add(task)
            task.add_done_callback(session._handler_tasks.discard)
    except WebSocketDisconnect:
        log.info("ws client disconnected")
    finally:
        # Peer is gone: silence any in-flight sends before cancelling tasks.
        session.dead = True
        _SESSIONS.discard(session)
        # Release PTY ownership so their output is dropped until reattached.
        orphaned = [tid for tid, owner in _PTY_OWNERS.items() if owner is session]
        for tid in orphaned:
            del _PTY_OWNERS[tid]
        # Flag the messaging handles this window mirrored as offline. They are
        # kept for a grace period rather than dropped: the window is usually
        # just reconnecting, and a deleted entry told callers the pane did not
        # exist. See agent_messaging.drop_owner.
        agent_messaging.drop_owner(session)
        server_link.roster_changed()
        # PTYs survive this disconnect so the frontend can reattach after a
        # transient network outage. They are killed only when the user explicitly
        # closes a pane (terminal.kill) or the whole app process exits.
        for t in session._review_tasks:
            t.cancel()
        for t in session._handler_tasks:
            t.cancel()


def _project_payload(project) -> dict[str, Any]:
    """Serialize a Project plus paths to its on-disk files."""
    log_file_name: str = getattr(project, "log_file_name", "") or ""
    # run_dir is the relative path from .agent-team/ to the run folder, e.g.
    # "runs/20260528-020041-task". Empty string for projects with no active run.
    run_dir = log_file_name.rsplit("/", 1)[0] if "/" in log_file_name else ""
    project_dict = asdict(project)
    return {
        "project": project_dict,
        "paths": {
            "dir": str(project_store.project_dir(project.workspace_path)),
            "project_file": str(project_store.project_file(project.workspace_path)),
            "pipeline_log": str(project_store.log_file(project.workspace_path, log_file_name)),
            "backend_log": str(backend_log_path()),
            "run_dir": run_dir,
        },
    }



# Shared with vendor modules — the canonical definition moved to
# cli_vendors.base so specs can parse commands without importing app.
from .cli_vendors.base import command_text as _command_text  # noqa: E402





def _resume_id_for_agent(agent_key: str, command: Any) -> str:
    """Resume/session id a launch command targets for this agent ('' when the
    agent has no id-carrying resume flag or the command doesn't resume).
    Fully registry-driven since R12 — vendors own their parsers."""
    spec = cli_vendor(agent_key)
    if spec is not None and spec.resume_id_from_command is not None:
        return spec.resume_id_from_command(command)
    return ""


def _session_lookup_path(agent: str, workspace_path: str, session_id: str) -> str:
    """The filesystem path the resume preflight checks for this session — logged
    and returned so a failed resume is diagnosable (e.g. a cwd whose non-ASCII
    chars encode to a colliding claude projects dir). '' when the vendor owns
    the location and there is no single stable path (codex/grok/opencode/kilo,
    pi — whose filename carries a timestamp prefix the id alone can't
    reconstruct — and cursor, whose path has a project-hash segment the id
    alone can't name)."""
    agent = agent.strip().lower()
    session_id = session_id.strip()
    if not session_id:
        return ""
    spec = cli_vendor(agent)
    if spec is not None and spec.session_path is not None:
        path = spec.session_path(workspace_path, session_id)
        return str(path) if path is not None else ""
    return ""


def _session_exists(agent: str, workspace_path: str, session_id: str) -> bool:
    agent = agent.strip().lower()
    session_id = session_id.strip()
    if not session_id:
        return False
    spec = cli_vendor(agent)
    if spec is not None and spec.session_exists is not None:
        return spec.session_exists(workspace_path, session_id)
    path = _session_lookup_path(agent, workspace_path, session_id)
    if path:
        return Path(path).is_file()
    return True  # unknown agent: assume resumable (unchanged behaviour)


def _record_analyzer_tokens(result: dict[str, Any], payload: dict[str, Any]) -> None:
    """Push an analyzer call's real token count into the store + broadcast.

    Fire-and-forget broadcast so a slow client doesn't delay the response.
    """
    ev = int(result.get("eval_count", 0) or 0)
    pev = int(result.get("prompt_eval_count", 0) or 0)
    if ev == 0 and pev == 0:
        return
    workspace_path = payload.get("workspace_path") or None
    stage_id = payload.get("stage_id") or None
    pane_id = payload.get("pane_id") or None
    tokens_store.record(
        workspace_path,
        source="analyzer",
        vendor="analyzer",
        pane_id=pane_id,
        stage_id=stage_id,
        input_tokens=pev,
        output_tokens=ev,
    )
    asyncio.create_task(
        broadcast(make_event("tokens.changed", tokens_store.snapshot(workspace_path)))
    )


# Agent-CLI spawns inherit the backend's PATH (terminals.py copies os.environ),
# but the backend was launched with the GUI's restricted PATH. Refresh from the
# user's shell — throttled, it shells out — before spawning, so a CLI the user
# just installed is found without first passing through an onboarding.status
# call (real case: install grok → click Respawn → still exit 127).
_PATH_REFRESH_INTERVAL_SEC = 30.0
_last_path_refresh = 0.0


async def _ensure_fresh_path_for_spawn(agent_key: str) -> None:
    global _last_path_refresh
    if agent_key in ("", "terminal"):
        return
    now = time.monotonic()
    if now - _last_path_refresh < _PATH_REFRESH_INTERVAL_SEC:
        return
    _last_path_refresh = now
    # Same dedicated pool as the spawn probe: a login-shell subprocess is the
    # same kind of heavy pre-spawn work and must stay off the shared default
    # executor (see ws_handlers._CLI_PROBE_EXECUTOR).
    await asyncio.get_running_loop().run_in_executor(
        ws_handlers._CLI_PROBE_EXECUTOR,
        onboarding_deps._refresh_path_from_login_shell,
    )


class AgentCliProbeError(RuntimeError):
    def __init__(self, message: str, details: dict[str, Any]) -> None:
        super().__init__(message)
        self.details = details


def _with_replaced_executable(command: Any, text: str, executable: str) -> Any:
    """Swap the command's first token, preserving flags and the list wrapper."""
    first_token = re.match(r"^\s*(?:'[^']*'|\"[^\"]*\"|\S+)", text)
    if first_token is None:
        return command
    replaced = f"{text[:first_token.start()]}{shlex.quote(executable)}{text[first_token.end():]}"
    if isinstance(command, list):
        updated = list(command)
        if updated:
            updated[-1] = replaced
        return updated
    return replaced


def _command_with_persisted_cli_binary(agent_key: str, command: Any) -> Any:
    """Replace the CLI executable while preserving shell flags and list wrappers."""
    selected = onboarding_deps.cli_binary_override(agent_key)
    dep = onboarding_deps.DEPS_BY_ID.get(agent_key)
    if not selected or dep is None:
        return command
    text = _command_text(command)
    try:
        parts = shlex.split(text)
    except ValueError:
        return command
    if not parts or Path(parts[0]).name != dep.check_cmd[0]:
        return command
    return _with_replaced_executable(command, text, selected)


def _command_with_installed_cli_alias(agent_key: str, command: Any) -> Any:
    """Point the command at the executable name this machine actually has.

    agentSpecs pins ONE name per CLI, but a vendor rename leaves the other one
    installed (cursor ships `agent`; older installs only have `cursor-agent`).
    Spawning the pinned name then dies with exit 127 while detection reports
    the CLI as present — so resolve the alias here instead.
    """
    dep = onboarding_deps.DEPS_BY_ID.get(agent_key)
    if dep is None or not dep.alt_commands:
        return command
    text = _command_text(command)
    try:
        parts = shlex.split(text)
    except ValueError:
        return command
    if not parts or Path(parts[0]).name not in (dep.check_cmd[0], *dep.alt_commands):
        return command
    if shutil.which(parts[0]):
        return command  # the requested name resolves — nothing to fix
    installed = onboarding_deps.resolve_executable(dep)
    if not installed:
        return command
    return _with_replaced_executable(command, text, installed)


def _login_spawn_command(agent_key: str, command: Any) -> Any:
    """Rewrite a login pane's command to the CLI's direct sign-in trigger.

    A login pane must jump straight into the vendor's browser/device sign-in
    flow instead of sitting at a bare REPL. The trigger itself is per-vendor
    knowledge and lives in each vendor's `login_command_args`.

    Keeps the first token (the resolved binary, possibly an override path from
    _command_with_persisted_cli_binary) and drops every other flag — YOLO
    flags like --dangerously-skip-permissions don't apply to auth subcommands.
    Preserves the frontend's [shell, -lc, cmd] wrapper.
    """
    spec = cli_vendor(agent_key)
    args = spec.login_command_args if spec is not None else None
    if args is None:
        return command
    text = _command_text(command)
    first_token = re.match(r"^\s*(?:'[^']*'|\"[^\"]*\"|\S+)", text)
    if first_token is None:
        return command
    replaced = first_token.group(0).strip()
    if args:
        replaced = f"{replaced} {args}"
    if isinstance(command, list):
        updated = list(command)
        if updated:
            updated[-1] = replaced
        return updated
    return replaced


# Aligned with onboarding_deps' detection probe (was 3s here — too tight, so a
# momentarily overloaded machine timed out and made EVERY CLI unlaunchable).
_SPAWN_PROBE_TIMEOUT_S = 8


def _probe_agent_cli_for_spawn(agent_key: str, requested_command: Any = None) -> dict[str, Any] | None:
    """Resolve and smoke-test an agent CLI before allocating its PTY.

    Environmental/transient failures (timeout, exec error) DEGRADE to a warning
    dict and let the spawn proceed — the binary is almost certainly fine (a
    `--version` probe is near-instant when the box is idle) and a genuinely
    broken one still fails visibly at spawn. Only definitive failures
    (not_found / nonzero exit / fatal signal) still raise to block the spawn.
    """
    dep = onboarding_deps.DEPS_BY_ID.get(agent_key)
    if dep is None or dep.group != "agent_cli":
        return None
    executable = None
    try:
        command_parts = shlex.split(_command_text(requested_command))
    except ValueError:
        command_parts = []
    requested_executable = command_parts[0] if command_parts else ""
    known_names = (dep.check_cmd[0], *dep.alt_commands)
    if requested_executable and Path(requested_executable).name in known_names:
        executable = shutil.which(requested_executable)
    executable = executable or onboarding_deps.resolve_executable(dep)
    if not executable:
        raise AgentCliProbeError(
            f"{dep.label} startup probe failed: executable not found ({dep.check_cmd[0]})",
            {
                "agent_key": agent_key,
                "binary_path": "",
                "probe_command": dep.check_cmd,
                "reason": "not_found",
            },
        )
    resolved = os.path.realpath(executable)
    executable_display = (
        f"{executable} → {resolved}" if resolved != executable else executable
    )
    command = [executable, *dep.check_cmd[1:]]
    started = time.monotonic()
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=_SPAWN_PROBE_TIMEOUT_S,
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired:
        # Transient: the box is momentarily overloaded (fork queued behind a
        # swap storm), not a broken binary. Degrade to a warning and let the
        # spawn proceed instead of blocking every CLI.
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        log.warning(
            "%s startup probe timed out after %dms (%s) — spawning anyway",
            dep.label, duration_ms, executable_display,
        )
        return {
            "agent_key": agent_key,
            "binary_path": executable,
            "resolved_path": resolved,
            "probe_command": command,
            "duration_ms": duration_ms,
            "reason": "timeout",
            "degraded": True,
            "version": None,
        }
    except OSError as err:
        # Transient: the probe's own fork/exec failed (e.g. EAGAIN under load).
        # Degrade rather than block — a truly unrunnable binary fails at spawn.
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        log.warning(
            "%s startup probe could not execute %s: %s — spawning anyway",
            dep.label, executable_display, err,
        )
        return {
            "agent_key": agent_key,
            "binary_path": executable,
            "resolved_path": resolved,
            "probe_command": command,
            "duration_ms": duration_ms,
            "reason": "exec_error",
            "degraded": True,
            "version": None,
        }

    duration_ms = max(0, round((time.monotonic() - started) * 1000))
    output = ((proc.stdout or "") + (proc.stderr or "")).strip()
    version = onboarding_deps._parse_version(output, dep.version_regex)
    signal_name: str | None = None
    if proc.returncode < 0:
        try:
            signal_name = signal.Signals(-proc.returncode).name
        except ValueError:
            signal_name = f"SIG{-proc.returncode}"
    details = {
        "agent_key": agent_key,
        "binary_path": executable,
        "resolved_path": resolved,
        "probe_command": command,
        "duration_ms": duration_ms,
        "exit_code": proc.returncode,
        "signal": signal_name,
        "version": version,
    }
    if proc.returncode != 0:
        cause = f"was terminated by {signal_name}" if signal_name else f"exited with code {proc.returncode}"
        message = f"{dep.label} startup probe {cause} after {duration_ms}ms ({executable_display})"
        error_details = {**details, "reason": "signal" if signal_name else "nonzero_exit"}
        if signal_name == "SIGKILL" and duration_ms < 500:
            hint = (
                "the binary may be quarantined or corrupt (e.g. a broken auto-update); "
                f"try running '{executable} --version' in a terminal"
            )
            message += f" — {hint}"
            error_details["hint"] = hint
        raise AgentCliProbeError(message, error_details)
    return details


async def handle_message(session: Session, msg: dict[str, Any]) -> None:
    msg_id: str = msg.get("id", "")
    msg_type: str = msg.get("type", "")
    payload: dict[str, Any] = msg.get("payload") or {}

    try:
        # -------- strangler-fig registry dispatch --------
        _h = ws_handlers.lookup(msg_type)
        if _h is not None:
            await _h(session, msg_id, msg_type, payload)
            return
        await session.send_json(
            make_error(msg_id, msg_type, "UNKNOWN_TYPE", f"Unsupported message type: {msg_type!r}")
        )
    except AgentCliProbeError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "CLI_PROBE_FAILED", str(err), err.details)
        )
    except FileNotFoundError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "SETUP_ERROR", str(err))
        )
    except KeyError as err:
        await session.send_json(
            make_error(msg_id, msg_type, "BAD_REQUEST", f"missing field: {err}")
        )
    except Exception as err:  # noqa: BLE001
        log.exception("handle_message failed for type=%s", msg_type)
        if not session.dead:
            await session.send_json(
                make_error(msg_id, msg_type, "INTERNAL_ERROR", str(err))
            )
