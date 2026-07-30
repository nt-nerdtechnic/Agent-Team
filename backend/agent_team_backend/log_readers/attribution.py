"""Attribute CLI log-file token events to Agent-Team workspaces + panes.

Design (B — workspace ↔ CLI folder association):

  1. The user registers a workspace by ever telling Agent-Team about its path
     (project.peek / project.upsert / pipeline.start / terminal.create).
     Each workspace records its expected CLI session folders:
       • Claude  → ~/.claude/projects/<encoded-cwd>/ (encode_claude_cwd)
       • Codex   → matched by session_meta.cwd at parse time
  2. When a token-usage event arrives, we look up which registered workspace
     the file belongs to. Events outside any registered workspace are dropped
     by the sink layer (workspace_path=None) so "All time" only tracks usage
     in workspaces the user has actually opened in Agent-Team.
  3. Optional pane attribution: within the current run we still know which
     pane spawned which session (for the "By Pane" panel section). This is
     ephemeral — gone after restart, but the workspace mapping persists.

Side effect of the design:
  - Sessions in a workspace folder that the user opens in Claude Code directly
    (without going through Agent-Team) STILL count toward that workspace.
    This matches what the user wants: usage on the project, by any means.
  - Workspace registration persists to disk so historic sessions count from
    the moment a workspace is first opened, including past .jsonl files.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import Lock
from typing import Iterable

from ..applog import app_data_dir
from ..db import DB_FILENAME, Database
from .aider import aider_history_path, aider_pane_history_path, is_history_name
from .base import LogReader, TokenUsage
from .claude import encode_claude_cwd
from .cursor import cursor_project_hash

log = logging.getLogger("agent_team_backend.log_readers.attribution")

_KV_KEY = "workspace_associations"


@dataclass
class AttributedUsage:
    usage: TokenUsage
    pane_id: str | None       # ephemeral frontend UUID — use for event routing only
    workspace_path: str | None
    stage_id: str | None
    slot_key: str | None = None  # stable "stageId:slotLabel" — use as tokens_store by_pane key


@dataclass
class SessionBinding:
    pane_id: str
    resume_id: str
    workspace_path: str
    stage_id: str | None = None
    session_file: str = ""


@dataclass
class WorkspaceMapping:
    workspace_path: str
    claude_dir: str = ""        # ~/.claude/projects/<encoded>/ (or "" if unknown)
    registered_at: float = field(default_factory=time.time)


@dataclass
class _PaneRegistration:
    pane_id: str              # ephemeral frontend UUID (for event routing)
    vendor: str
    cwd: str
    workspace_path: str
    stage_id: str | None
    slot_key: str = ""        # stable "stageId:slotLabel" (for tokens_store by_pane key)
    registered_at: float = field(default_factory=time.time)
    baseline_files: set[Path] = field(default_factory=set)
    claimed_session_ids: set[str] = field(default_factory=set)
    session_home_id: str = ""
    # Codex/Antigravity only: unique string embedded in this pane's kickoff so the
    # first session file containing it can be bound to this pane (those CLIs
    # can't pin a session id at launch, unlike Claude's --session-id).
    session_marker: str = ""


def _extract_resume_id(vendor: str, text: str) -> str:
    """Pull the id the CLI's resume command needs out of a session file's text.

    Codex:  the session_meta record's payload.id (the filename stem has a
            timestamp prefix and is NOT accepted by `codex resume`).
    Returns "" when the expected shape isn't found (caller falls back).
    """
    if vendor == "codex":
        for line in text.splitlines():
            line = line.strip()
            if not line or '"session_meta"' not in line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("type") == "session_meta":
                payload = rec.get("payload") or {}
                if isinstance(payload, dict) and payload.get("id"):
                    return str(payload["id"])
        return ""
    return ""


class Attribution:
    """Maps log-file events → (workspace_path, pane_id, stage_id).

    Persists workspace registrations across backend restarts; pane registrations
    are ephemeral (only valid during the running uvicorn process).
    """

    def __init__(
        self,
        readers: Iterable[LogReader],
        *,
        workspaces_path: Path | None = None,
        db: Database | None = None,
    ) -> None:
        self._readers: dict[str, LogReader] = {r.vendor: r for r in readers}
        self._workspaces: dict[str, WorkspaceMapping] = {}
        self._workspaces_path = workspaces_path or (app_data_dir() / "workspace-associations.json")
        self._db = db or Database(self._workspaces_path.parent / DB_FILENAME)
        self._panes: dict[str, _PaneRegistration] = {}
        self._session_owner: dict[str, str] = {}  # session_id → pane_id (ephemeral)
        self._unbound_markers: dict[str, str] = {}  # session_marker → pane_id (Codex/Antigravity)
        self._announced_session_keys: set[str] = set()
        self._lock = Lock()
        self._load_workspaces()

    # ───────────────────────── persistence ─────────────────────────────────

    def _import_legacy(self, cur: object, data: object) -> None:
        if isinstance(data, dict):
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))

    def _load_workspaces(self) -> None:
        data = self._db.kv_get(_KV_KEY)
        if data is None:
            self._db.import_json(_KV_KEY, self._workspaces_path, self._import_legacy)
            data = self._db.kv_get(_KV_KEY)
        if isinstance(data, dict):
            for ws_path, body in data.items():
                if not isinstance(body, dict):
                    continue
                self._workspaces[str(ws_path)] = WorkspaceMapping(
                    workspace_path=str(ws_path),
                    claude_dir=str(body.get("claude_dir") or ""),
                    registered_at=float(body.get("registered_at") or time.time()),
                )
        log.info("loaded %d workspace association(s)", len(self._workspaces))

    def _save_workspaces(self) -> None:
        data = {ws: asdict(m) for ws, m in self._workspaces.items()}
        try:
            self._db.kv_set(_KV_KEY, data, now=int(time.time()))
        except sqlite3.Error as err:
            # Same degradation as the old JSON file store: registration keeps
            # working in memory and the persistence failure is only logged.
            log.warning("workspace-associations save failed: %s", err)

    # ───────────────────────── workspace lifecycle ─────────────────────────

    def register_workspace(self, workspace_path: str) -> None:
        """Idempotent. Bind the workspace path to its CLI session folders.

        Once registered, any session file under those folders is attributed
        to this workspace — including files that existed before registration
        (so historic usage retroactively shows up in the workspace tally).
        """
        if not workspace_path:
            return
        with self._lock:
            mapping = self._workspaces.get(workspace_path) or WorkspaceMapping(
                workspace_path=workspace_path
            )

            # Claude: project folder name = encode_claude_cwd(cwd). Recompute
            # on every (re-)registration so a stale claude_dir persisted by an
            # older encoder self-corrects the next time the workspace opens.
            claude_dir = mapping.claude_dir
            if "claude" in self._readers:
                encoded = encode_claude_cwd(workspace_path)
                for root in self._readers["claude"].project_dirs():
                    claude_dir = str(root / encoded)
                    break

            if workspace_path in self._workspaces and claude_dir == mapping.claude_dir:
                return
            mapping.claude_dir = claude_dir
            self._workspaces[workspace_path] = mapping
            self._save_workspaces()
        log.info(
            "registered workspace=%s claude_dir=%s",
            workspace_path,
            mapping.claude_dir or "(none)",
        )

    def unregister_workspace(self, workspace_path: str) -> None:
        with self._lock:
            self._workspaces.pop(workspace_path, None)
            self._save_workspaces()

    def known_workspaces(self) -> list[str]:
        with self._lock:
            return sorted(self._workspaces.keys())

    # ───────────────────────── pane lifecycle ──────────────────────────────

    def register_pane(
        self,
        pane_id: str,
        *,
        vendor: str,
        cwd: str,
        workspace_path: str = "",
        stage_id: str | None = None,
        slot_key: str = "",
        explicit_session_id: str = "",
        session_marker: str = "",
        session_home_id: str = "",
    ) -> None:
        """Bind a current-run pane to its expected log-file vendor + cwd.

        Also implicitly registers the workspace so the pane's sessions count
        toward the workspace tally.

        `explicit_session_id` (Claude `--session-id`): when the pane was launched
        with a pinned session id, we bind session→pane RIGHT NOW. The first event
        for that session then maps to THIS pane directly — no first-come-claim
        guessing, which mis-routed sessions across panes sharing one workspace.

        `session_marker` (Codex/Antigravity): those CLIs can't pin a session id, so
        instead a unique marker is embedded in the kickoff. maybe_bind_by_marker()
        binds the first session file containing it to this pane.
        """
        # Register the workspace too — convenience for callers that only call
        # register_pane and not register_workspace explicitly.
        ws = workspace_path or cwd
        if ws:
            self.register_workspace(ws)

        if vendor not in self._readers:
            log.debug("register_pane: unknown vendor %s, pane attribution skipped", vendor)
            return

        reader = self._readers[vendor]
        try:
            # Scope the baseline to THIS pane's workspace folder when the reader
            # can (Claude/Kimi/Antigravity/Codex map a workspace to one dir). A
            # pane only ever claims sessions under its own cwd, so the whole-tree
            # enumeration was pure waste — on a large ~/.claude it stat'd ~1500
            # files per spawn. Grok (shared DB) / missing ws → None → full tree.
            scoped = reader.session_files_for_workspace(ws) if ws else None
            files = scoped if scoped is not None else reader.session_files()
            baseline = set(files)
        except Exception as err:  # noqa: BLE001
            log.warning("baseline scan failed for vendor=%s: %s", vendor, err)
            baseline = set()

        reg = _PaneRegistration(
            pane_id=pane_id, vendor=vendor, cwd=cwd,
            workspace_path=ws, stage_id=stage_id, slot_key=slot_key,
            baseline_files=baseline, session_marker=session_marker,
            session_home_id=session_home_id,
        )
        with self._lock:
            self._panes[pane_id] = reg
            # Pinned session id → bind to THIS pane immediately (precise, no claim).
            if explicit_session_id:
                self._session_owner[explicit_session_id] = pane_id
                reg.claimed_session_ids.add(explicit_session_id)
            elif session_marker:
                self._unbound_markers[session_marker] = pane_id
        log.debug("registered pane=%s vendor=%s cwd=%s baseline=%d files marker=%s",
                  pane_id, vendor, cwd, len(baseline), session_marker or "(none)")

    def unregister_pane(self, pane_id: str) -> None:
        with self._lock:
            reg = self._panes.pop(pane_id, None)
            if not reg:
                return
            for sid in reg.claimed_session_ids:
                if self._session_owner.get(sid) == pane_id:
                    del self._session_owner[sid]
            if reg.session_marker:
                self._unbound_markers.pop(reg.session_marker, None)

    # ───────────────────────── attribution ─────────────────────────────────

    def attribute(self, usage: TokenUsage) -> AttributedUsage:
        """Map a usage event to (workspace, pane, stage). Workspace is the
        gate — if no registered workspace matches, the sink should drop this
        event (it's an external session not associated with any Agent-Team
        workspace)."""
        with self._lock:
            ws_path = self._lookup_workspace_for(usage)
            if ws_path is None:
                return AttributedUsage(
                    usage=usage, pane_id=None, workspace_path=None, stage_id=None,
                )

            # Pane attribution within the current run (best-effort for "By Pane")
            pane_id, stage_id, slot_key = self._lookup_pane_for(usage)
            return AttributedUsage(
                usage=usage,
                pane_id=pane_id,
                workspace_path=ws_path,
                stage_id=stage_id,
                slot_key=slot_key,
            )

    def maybe_announce_session(self, usage: TokenUsage) -> SessionBinding | None:
        """Return the first pane binding that should be persisted for resume.

        Handles the preferred non-marker identity path first:
          - Codex: per-pane CODEX_HOME path encodes pane_id; resume id is
            session_meta.payload.id.

        Falls back to marker matching for older sessions and during rollout.
        Antigravity has no identity path at launch (`agy --conversation` can't
        create a chosen id), so it relies on marker matching plus the
        single-candidate new-session fallback; its resume id is the
        conversation .db filename stem (= usage.session_id).
        Kimi likewise can't pin an id (`kimi --session` only resumes); its
        marker is typed into the TUI post-launch and is silently lost when the
        injection loses the startup timing race, so the single-candidate
        fallback is its safety net — resume id is the `session_<uuid>` dir
        name (= usage.session_id).
        Grok relies on markers exclusively, but stores every session in
        one shared SQLite db — its binding queries the db via the reader.
        OpenCode works the same way (`opencode --session <id>` can only
        resume, and all sessions live in one shared db), as does Kilo Code
        (an OpenCode fork — `kilo --session <id>`, shared kilo.db).
        Qwen writes one jsonl per session (like Claude) and preserves user
        text verbatim, so the kickoff marker lands in the session file —
        marker matching plus the single-candidate fallback bind it; the
        resume id is the file stem accepted by `qwen --resume <id>`
        (= usage.session_id).
        Pi likewise writes one jsonl per session and preserves user text
        verbatim, so marker matching plus the single-candidate fallback
        bind it — but the file only appears after the FIRST assistant reply
        completes (lazy flush), so its binding lands later than other
        vendors'. The resume id is the header id `pi --session-id <id>`
        accepts (= usage.session_id; the filename stem carries a timestamp
        prefix and is NOT the id).
        Copilot writes one events.jsonl per session dir and preserves user
        text verbatim (user.message data.content), so the kickoff marker
        lands in the session file — marker matching plus the
        single-candidate fallback bind it; the resume id is the session dir
        name accepted by `copilot --resume=<id>` (= usage.session_id).
        Cursor writes one store.db per session, but its content is opaque
        protobuf blobs, so marker resolution belongs to the reader (a raw
        bytes scan via find_sessions_by_marker) — the same reader-driven
        binding path as the shared-db vendors, even though the dbs are
        per-session; the resume id is the session dir name accepted by
        `agent --resume=<id>`.
        Aider appends every session to ONE per-project Markdown history file
        and preserves user text verbatim (`#### ` lines), so the kickoff
        marker lands in the file — but only the file's LAST started-at
        section is the live session, so marker matching scans just that
        section and there is no single-candidate fallback (the shared file
        usually pre-exists in the pane's baseline). Aider has no session id;
        the announced "resume id" is the section's started-at slug, and
        resume itself is the id-less, lossy `aider --restore-chat-history`.
        """
        if usage.vendor in ("grok", "opencode", "kilo", "cursor"):
            return self._bind_shared_db_by_marker(usage)
        if usage.vendor not in ("codex", "antigravity", "kimi", "qwen", "pi", "copilot", "aider"):
            return None

        try:
            text = Path(usage.file_path).read_text(encoding="utf-8", errors="ignore")[:524_288]
        except OSError:
            text = ""

        if usage.vendor == "codex":
            pane_id = self._pane_id_from_codex_home_path(usage.file_path)
            if pane_id:
                # Codex creates the rollout file before session_meta is always
                # readable. The filename stem includes a timestamp prefix and
                # is NOT accepted by `codex resume`, so wait for a later file
                # modification instead of announcing a malformed fallback id.
                resume_id = _extract_resume_id("codex", text)
                if not resume_id:
                    return None
                binding = self._bind_and_announce_path_session(
                    usage=usage,
                    pane_id=pane_id,
                    resume_id=resume_id,
                    session_file=usage.file_path,
                )
                if binding:
                    return binding

        marker_binding = self.maybe_bind_by_marker(usage)
        if marker_binding:
            pane_id, resume_id = marker_binding
        elif usage.vendor in ("antigravity", "kimi", "qwen", "pi", "copilot"):
            return self._bind_new_session_single_candidate(usage)
        else:
            return None
        with self._lock:
            reg = self._panes.get(pane_id)
            if reg is None:
                return None
            return SessionBinding(
                pane_id=pane_id,
                resume_id=resume_id,
                workspace_path=reg.workspace_path,
                stage_id=reg.stage_id,
                session_file=usage.file_path,
            )

    def maybe_bind_by_marker(self, usage: TokenUsage) -> tuple[str, str] | None:
        """Codex/Antigravity: bind a session file to its pane by the marker embedded
        in the kickoff. Returns (pane_id, resume_id) on the binding transition
        (the first time this session is matched), else None.

        `resume_id` is the id the CLI's resume command actually needs, which is
        NOT the same as the reader's `usage.session_id`:
          • Codex:  session_meta `payload.id` (the filename stem includes a
            timestamp prefix, so the stem can't be passed to `codex resume`).
        Falls back to usage.session_id if the file shape is unexpected.

        Reads the session file only while there are still unbound markers for an
        unowned session — once bound, the session_owner short-circuit means no
        further reads. The file read happens outside the lock.
        """
        if usage.vendor not in ("codex", "antigravity", "kimi", "qwen", "pi", "copilot", "aider"):
            return None
        sid = usage.session_id
        with self._lock:
            if not self._unbound_markers or (sid and sid in self._session_owner):
                return None
            markers = dict(self._unbound_markers)  # snapshot for lock-free read

        try:
            # Markers live in the first user turn; cap the read so a long session
            # doesn't cost a full file scan on every event.
            if usage.vendor == "antigravity":
                reader = self._readers.get("antigravity")
                if reader:
                    text = reader._metadata_text(Path(usage.file_path))[:524_288]
                else:
                    text = Path(usage.file_path).read_text(encoding="utf-8", errors="ignore")[:524_288]
            elif usage.vendor == "aider":
                # Only the LAST started-at section is the live session — an
                # earlier section's marker belongs to a historic session and
                # must never bind. Still true for a per-pane file: it too is
                # appended to by every aider run of that pane.
                reader = self._readers.get("aider")
                text = (
                    reader.last_section(Path(usage.file_path))[1][:524_288]
                    if reader is not None else ""
                )
            else:
                text = Path(usage.file_path).read_text(encoding="utf-8", errors="ignore")[:524_288]
        except OSError:
            return None
        if usage.vendor == "antigravity":
            # SQLite conversations: recent frames (incl. the just-typed marker)
            # often sit in the -wal journal before being checkpointed into the
            # main db, so search it too.
            try:
                wal = Path(usage.file_path + "-wal")
                text += wal.read_text(encoding="utf-8", errors="ignore")[:524_288]
            except OSError:
                pass

        matched_pane = next((pid for marker, pid in markers.items() if marker in text), None)
        if matched_pane is None:
            return None

        resume_id = _extract_resume_id(usage.vendor, text)
        if usage.vendor == "codex" and not resume_id:
            # Do not consume the marker or claim the rollout until its real
            # resume id appears in session_meta. Watcher updates will retry.
            return None
        resume_id = resume_id or sid
        with self._lock:
            # Re-check under lock: another event may have bound it meanwhile.
            if sid in self._session_owner:
                return None
            reg = self._panes.get(matched_pane)
            if reg is None:
                return None  # pane was killed between snapshot and now
            self._session_owner[sid] = matched_pane
            reg.claimed_session_ids.add(sid)
            self._unbound_markers.pop(reg.session_marker, None)
        log.info("bound session=%s → pane=%s via marker (resume_id=%s)", sid, matched_pane, resume_id)
        return matched_pane, resume_id

    def _bind_shared_db_by_marker(self, usage: TokenUsage) -> SessionBinding | None:
        """Grok/OpenCode/Kilo keep ALL sessions in one shared SQLite db, so marker
        binding asks the reader to resolve markers → session ids in the db
        instead of scanning a per-session file. Cursor keeps one db PER
        session, but its blobs are opaque protobuf, so it uses the same
        reader-driven resolution (with ws_root always '' — the store records
        no cwd — which intentionally keeps the workspace gate below
        permissive for it). Binds at most one session per
        call; the watcher fires again on every db write, so any remaining
        markers resolve on subsequent events. Resume id is the db's session id
        that `grok -s <id>` / `opencode --session <id>` accepts."""
        vendor = usage.vendor
        reader = self._readers.get(vendor)
        if reader is None:
            return None
        with self._lock:
            markers = [
                marker for marker, pid in self._unbound_markers.items()
                if (reg := self._panes.get(pid)) is not None and reg.vendor == vendor
            ]
        if not markers:
            return None
        # DB read outside the lock (short read-only connection; {} on failure).
        found = reader.find_sessions_by_marker(markers)
        for marker, (session_id, ws_root) in found.items():
            if not session_id:
                continue
            with self._lock:
                pane_id = self._unbound_markers.get(marker)
                if pane_id is None or session_id in self._session_owner:
                    continue  # bound meanwhile / pane killed
                reg = self._panes.get(pane_id)
                if reg is None or reg.vendor != vendor:
                    continue
                # Workspace gate: the reader reports the session's workspace
                # root (grok: workspaces.scope_key, opencode/kilo:
                # session.directory);
                # require it to match the pane so a marker echoed in another
                # project can't cross-bind.
                if ws_root and ws_root not in (reg.cwd, reg.workspace_path):
                    continue
                self._session_owner[session_id] = pane_id
                reg.claimed_session_ids.add(session_id)
                self._unbound_markers.pop(marker, None)
                binding = SessionBinding(
                    pane_id=pane_id,
                    resume_id=session_id,
                    workspace_path=reg.workspace_path,
                    stage_id=reg.stage_id,
                    session_file=usage.file_path,
                )
            log.info(
                "bound %s session=%s → pane=%s via marker", vendor, session_id, pane_id
            )
            return binding
        return None

    def _bind_new_session_single_candidate(self, usage: TokenUsage) -> SessionBinding | None:
        """Fallback Antigravity/Kimi resume capture when the marker is not visible.

        Antigravity writes SQLite conversations and may create the .db before the
        injected marker lands in either the main db or WAL. Kimi creates its
        session dir at launch, but its marker is typed into the TUI after
        startup and is silently dropped whenever that injection loses the
        timing race — without a fallback the session id is never captured and
        resume-on-restart spawns a blank fresh session. If exactly one
        registered pane of this vendor in this cwd has a new, unclaimed session
        file, bind it to that pane. Multiple candidates are intentionally left
        unbound so marker matching can resolve them later without cross-pane
        corruption.
        """
        if usage.vendor not in ("antigravity", "kimi", "qwen", "pi", "copilot") or not usage.session_id:
            return None
        file_path = Path(usage.file_path)
        key = f"{usage.vendor}:{usage.session_id}:{usage.session_id}"
        with self._lock:
            if key in self._announced_session_keys:
                return None
            owner = self._session_owner.get(usage.session_id)
            if owner is not None:
                return None
            candidates = [
                reg for reg in self._panes.values()
                if reg.vendor == usage.vendor
                and self._cwd_matches(reg.cwd, usage, reg.pane_id)
                and file_path not in reg.baseline_files
                and not reg.claimed_session_ids
            ]
            if len(candidates) != 1:
                return None
            reg = candidates[0]
            self._session_owner[usage.session_id] = reg.pane_id
            reg.claimed_session_ids.add(usage.session_id)
            if reg.session_marker:
                self._unbound_markers.pop(reg.session_marker, None)
            self._announced_session_keys.add(key)
            binding = SessionBinding(
                pane_id=reg.pane_id,
                resume_id=usage.session_id,
                workspace_path=reg.workspace_path,
                stage_id=reg.stage_id,
                session_file=usage.file_path,
            )
        log.info(
            "bound %s session=%s → pane=%s via new-session fallback",
            usage.vendor, usage.session_id, binding.pane_id,
        )
        return binding

    def _bind_and_announce_path_session(
        self,
        *,
        usage: TokenUsage,
        pane_id: str,
        resume_id: str,
        session_file: str,
    ) -> SessionBinding | None:
        if not usage.session_id or not resume_id:
            return None
        key = f"{usage.vendor}:{usage.session_id}:{resume_id}"
        with self._lock:
            reg = self._pane_registration_for_codex_home_id(pane_id)
            if reg is None or reg.vendor != usage.vendor:
                return None
            if key in self._announced_session_keys:
                return None
            owner = self._session_owner.get(usage.session_id)
            if owner is not None and owner != reg.pane_id:
                return None
            self._session_owner[usage.session_id] = reg.pane_id
            reg.claimed_session_ids.add(usage.session_id)
            self._announced_session_keys.add(key)
            binding = SessionBinding(
                pane_id=reg.pane_id,
                resume_id=resume_id,
                workspace_path=reg.workspace_path,
                stage_id=reg.stage_id,
                session_file=session_file,
            )
        log.info(
            "bound session=%s → pane=%s via codex home path (resume_id=%s)",
            usage.session_id, pane_id, resume_id,
        )
        return binding

    def pane_for_session(
        self, session_id: str
    ) -> tuple[str | None, str | None, str | None]:
        """Resolve (pane_id, workspace_path, stage_id) from session_id alone.

        For hook payloads (Claude Stop / PreToolUse) that carry session_id + cwd
        but NO file_path, so they cannot pass the file_path-based workspace gate
        in attribute(). This bypasses the gate by reusing the session→pane claim
        the JSONL path already made (_session_owner). Returns (None, None, None)
        if the session isn't claimed yet (race: stop arriving before the JSONL
        path claimed it) — the caller should fall back to an empty pane_id and
        let the JSONL path's matching event supply it shortly."""
        if not session_id:
            return None, None, None
        with self._lock:
            owner = self._session_owner.get(session_id)
            if owner is None:
                return None, None, None
            reg = self._panes.get(owner)
            if reg is None:
                return None, None, None
            return reg.pane_id, reg.workspace_path, reg.stage_id

    def _lookup_workspace_for(self, usage: TokenUsage) -> str | None:
        """Find which registered workspace this log file belongs to."""
        file_path = usage.file_path
        for ws_path, mapping in self._workspaces.items():
            if usage.vendor == "claude":
                # Path-prefix match against claude_dir (default config home).
                # Managed-account panes write via a symlinked profile home whose
                # ``projects`` resolves back into this same default root, so the
                # single prefix check covers every account.
                if mapping.claude_dir and (
                    file_path == mapping.claude_dir
                    or file_path.startswith(mapping.claude_dir + "/")
                    or file_path.startswith(mapping.claude_dir + os.sep)
                ):
                    return ws_path
            elif usage.vendor == "codex":
                # Codex puts cwd in session_meta → usage.cwd
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "antigravity":
                # Antigravity cwd is extracted from trajectory_metadata_blob.
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "grok":
                # Grok reader emits cwd = workspaces.scope_key (git root /
                # canonical cwd of the session's workspace).
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "kimi":
                # Kimi reader emits cwd = the session state.json workDir.
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "opencode":
                # OpenCode reader emits cwd = session.directory (the cwd the
                # session was started in).
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "kilo":
                # Kilo (OpenCode fork) likewise emits cwd = session.directory.
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "qwen":
                # Qwen reader emits cwd = the record's own cwd field (every
                # jsonl line carries the session's exact cwd).
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "pi":
                # Pi reader emits cwd = the session header's cwd field.
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "copilot":
                # Copilot reader emits cwd = the session's workspace.yaml cwd.
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
            elif usage.vendor == "aider":
                # Aider reader emits cwd = the history file's directory (the
                # session's git root). A workspace registered at a
                # subdirectory of that root still maps to the same file.
                if usage.cwd and usage.cwd == ws_path:
                    return ws_path
                if usage.file_path:
                    fp = Path(usage.file_path)
                    if (
                        is_history_name(fp.name)
                        and fp.parent == aider_history_path(ws_path).parent
                    ):
                        return ws_path
            elif usage.vendor == "cursor":
                # Cursor stores NO cwd anywhere. A session already bound to a
                # pane (marker hit) attributes to that pane's workspace, so
                # the gate can never drop a marker-bound session; otherwise
                # fall back to the community-documented md5(cwd) project-hash
                # dir name in the file path (best-effort — unconfirmed hash).
                owner = self._session_owner.get(usage.session_id)
                reg = self._panes.get(owner) if owner else None
                if reg is not None and reg.workspace_path == ws_path:
                    return ws_path
                hash_dir = cursor_project_hash(ws_path)
                if hash_dir and f"/{hash_dir}/" in file_path:
                    return ws_path
        return None

    def _lookup_pane_for(
        self, usage: TokenUsage
    ) -> tuple[str | None, str | None, str | None]:
        """Best-effort current-run pane lookup. Doesn't gate workspace attr.

        Returns (pane_id, stage_id, slot_key).
        pane_id    — ephemeral frontend UUID, used for event routing.
        slot_key   — stable "stageId:slotLabel", used as tokens_store by_pane key.
        """
        owner = self._session_owner.get(usage.session_id)
        if owner is not None:
            reg = self._panes.get(owner)
            if reg:
                return reg.pane_id, reg.stage_id, reg.slot_key or None

        if usage.vendor == "codex":
            pane_id = self._pane_id_from_codex_home_path(usage.file_path)
            reg = self._pane_registration_for_codex_home_id(pane_id) if pane_id else None
            if reg and reg.vendor == usage.vendor:
                self._session_owner[usage.session_id] = reg.pane_id
                reg.claimed_session_ids.add(usage.session_id)
                return reg.pane_id, reg.stage_id, reg.slot_key or None

        # Try to claim with a freshly-spawned pane
        file_path = Path(usage.file_path)
        candidates = [
            reg for reg in self._panes.values()
            if reg.vendor == usage.vendor
            and self._cwd_matches(reg.cwd, usage, reg.pane_id)
            and file_path not in reg.baseline_files
            and not reg.claimed_session_ids
        ]
        if len(candidates) != 1:
            # Zero candidates: nothing to claim. Several candidates: ambiguous
            # provenance — guessing (old behavior: oldest registration wins)
            # could route one pane's session to a sibling, which the frontend
            # may then adopt AND persist, silently replacing that pane's
            # session. Do nothing; only a deterministic path (explicit
            # --session-id, per-pane home dir, kickoff marker) may bind it.
            # Mirrors _bind_new_session_single_candidate's exactly-one rule.
            return None, None, None
        reg = candidates[0]
        self._session_owner[usage.session_id] = reg.pane_id
        reg.claimed_session_ids.add(usage.session_id)
        return reg.pane_id, reg.stage_id, reg.slot_key or None

    def _cwd_matches(self, pane_cwd: str, usage: TokenUsage, pane_id: str = "") -> bool:
        if not pane_cwd:
            return False
        file_path = usage.file_path
        if usage.vendor == "claude":
            expected_dir = encode_claude_cwd(pane_cwd)
            return f"/{expected_dir}/" in file_path
        if usage.vendor == "cursor":
            # No cwd in the store; match the md5(cwd) project-hash dir in the
            # file path instead. Only the claim fallbacks use this — marker
            # binding never depends on it (the hash scheme is unconfirmed).
            hash_dir = cursor_project_hash(pane_cwd)
            return bool(hash_dir) and f"/{hash_dir}/" in file_path
        if usage.vendor == "aider":
            # The pane's OWN `--chat-history-file` is its file — that is what
            # lets two aider panes in ONE repo discriminate at all. The
            # per-project shared file is claimable only by a pane that has no
            # per-pane file (started before per-pane files existed), never by
            # one that does.
            own = aider_pane_history_path(pane_cwd, pane_id)
            if own is not None:
                if usage.file_path == str(own):
                    return True
                try:
                    if own.exists():
                        return False
                except OSError:
                    return False
            return usage.file_path == str(aider_history_path(pane_cwd))
        if usage.vendor in ("codex", "antigravity", "grok", "kimi", "opencode", "qwen", "kilo", "pi", "copilot"):
            return usage.cwd == pane_cwd
        return False

    def _pane_id_from_codex_home_path(self, file_path: str) -> str:
        try:
            path = Path(file_path).resolve()
            panes_root = (Path.home() / ".codex-panes").resolve()
            rel = path.relative_to(panes_root)
        except (OSError, ValueError):
            return ""
        parts = rel.parts
        if len(parts) >= 3 and parts[1] == "sessions":
            return parts[0]
        return ""

    def _pane_registration_for_codex_home_id(self, home_id: str) -> _PaneRegistration | None:
        if not home_id:
            return None
        reg = self._panes.get(home_id)
        if reg and (not reg.session_home_id or reg.session_home_id == home_id):
            return reg
        return next(
            (p for p in self._panes.values() if p.session_home_id == home_id),
            None,
        )
