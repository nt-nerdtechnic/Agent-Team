"""Cursor CLI (`agent`, legacy `cursor-agent`) conversation store reader.

Layout (root = ~/.cursor/chats — Cursor offers no official env override for
its data home, so the root is fixed; tests relocate it via Path.home()).
Sampled 2026-08-16 against a live cursor-agent 2026.08.11-e8db854 session:

  ~/.cursor/chats/<project-hash>/<session-uuid>/store.db    one db per session
  ~/.cursor/chats/<project-hash>/<session-uuid>/meta.json   plain-JSON sidecar

  store.db has exactly two tables:
    meta  (key TEXT PRIMARY KEY, value TEXT) — single row (key '0'), value =
                  hex-encoded JSON (agentId, latestRootBlobId,
                  blobEncryptionKey, createdAt; NO cwd)
    blobs (id TEXT PRIMARY KEY, data BLOB) — content-addressed (SHA256 keys)
                  and MIXED: some rows are plain JSON chat messages
                  ({"role": "system"|"user"|"assistant", "content": …}), the
                  rest are protobuf structure nodes with no public schema.
                  Protobuf rows are NEVER decoded — they fail json.loads and
                  are skipped, and the marker scan only reads their raw bytes
                  (user input is embedded verbatim as UTF-8, which is how the
                  kickoff's `at-pane:<paneId>` marker is found).

  meta.json is the only place the workspace is recorded:
    {"schemaVersion":1,"createdAtMs":…,"hasConversation":true,
     "updatedAtMs":…,"cwd":"/abs/path"}

  <project-hash> is md5(cwd) hexdigest — community-documented (agentgrep) and
  CONFIRMED 2026-08-16 (md5 of the sampled meta.json cwd equals the dir name).
  Cursor is still closed source, so it stays a best-effort workspace filter
  and never gates marker binding (markers are globally unique).

  ~/.cursor/acp-sessions/<id>/store.db (ACP mode) is intentionally ignored,
  as is ~/.cursor/projects/<slug>/agent-transcripts/*.jsonl — that is Cursor
  IDE data, not the CLI's.

Token usage: none is emitted (parse_session_file/parse_incremental return
empty). The JSON blobs carry no usage, and whatever the store keeps lives in
the protobuf nodes, which are out of reach. The headless
`--output-format stream-json` path does report usage per result (sampled:
inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens, with
inputTokens EXCLUDING cacheReadTokens — Anthropic's convention, the opposite
of Meta/OpenAI), but `--print` runs one prompt and exits, so it can never
observe an interactive pane. Left unimplemented on purpose.

Activity: parse_activity watermarks on blobs.rowid (monotonic per INSERT) and
turns each new JSON message row into an event — role=user → agent_active,
role=assistant → turn_complete carrying the reply text. That turn_complete is
what lets a Cursor pane send inter-CLI messages: the frontend only parses the
---MSG-START--- protocol out of a turn_complete that has text.

Everything here is maximally defensive: any missing table, unexpected
schema, undecodable value, or sqlite error is tolerated by silently skipping
that db — never by raising.

resume: `agent --resume=<chatId>` (session id = the <session-uuid> dir name).
"""

from __future__ import annotations

import hashlib
import logging
import re
import sqlite3
from collections.abc import Iterable
from pathlib import Path

import asyncio
import base64
import json
import sys
import time

from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    join_text_blocks,
    user_prompt_text,
)
from .base import Dep, McpServerConfig, McpValue, McpWiring, SkillsWiring, VendorSpec, command_text
from ..usage_common import (
    HTTP_TIMEOUT,
    _KEYCHAIN_COOLDOWN_S,
    _epoch_to_iso,
    _num,
    _snapshot,
    _window,
    communicate_or_kill,
    parse_retry_after,
)

log = logging.getLogger("agent_team_backend.log_readers.cursor")

_DB_NAME = "store.db"
_META_NAME = "meta.json"

# Read-only busy wait: long enough to ride out an agent write transaction,
# short enough not to stall the watcher's drain thread (same as Grok).
_BUSY_TIMEOUT_MS = 250

# Marker-scan bounds. The kickoff marker lands in an early, small user-input
# blob, so scanning the head of each blob is enough; the caps keep a huge or
# blob-heavy session db from turning every scan into a performance disaster.
_MAX_BLOB_BYTES = 262_144   # bytes searched per blob (truncated in SQL)
_MAX_BLOBS_PER_DB = 512     # blobs examined per store.db

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Sentinel prefix persisted inside the watcher-owned per-file seen_keys set
# (same trick as Kimi's turn state): the last observed mtime/size, so
# parse_activity emits agent_active only when the db actually changed.
_STAT_PREFIX = "cursor_stat::"

# Second sentinel in the same set: the last scanned blobs.rowid. Kept apart
# from _STAT_PREFIX so the two signals never overwrite each other's state (and
# their dedup keys, "stat:…" vs "blob:…", can never collide either).
_ACTIVITY_PREFIX = "cursor_blob::"

# rowid is monotonic per INSERT; a content-addressed row re-inserted under an
# existing id lands on a NEW, higher rowid, so the watermark only moves
# forward. Sampled turns write ~10 blobs each and first sight anchors at the
# newest row, so one page per pass is never the limiting factor in practice.
_ACTIVITY_SQL = (
    "SELECT rowid, id, data FROM blobs WHERE rowid > ? ORDER BY rowid LIMIT ?"
)
_MAX_BLOBS_PER_PASS = 512

# Cap on the reply text a turn_complete carries (matches the other readers'
# intent: enough for the messaging protocol, not a transcript dump).
_MAX_TURN_TEXT = 8000


def _read_meta_json(session_dir: Path) -> dict:
    """The plain-JSON sidecar next to store.db ({} when absent/unreadable).

    Unlike the db's own `meta` table this one is not hex-encoded and does
    carry `cwd`, which makes it the only workspace record Cursor writes.
    """
    try:
        raw = (session_dir / _META_NAME).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _json_message(data) -> dict | None:
    """A blobs row decoded as a chat message, or None when it is one of the
    protobuf structure nodes — those are skipped, never decoded."""
    if isinstance(data, memoryview):
        data = bytes(data)
    if not isinstance(data, (bytes, bytearray, str)):
        return None
    try:
        message = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        return None
    return message if isinstance(message, dict) else None


def cursor_chats_root() -> Path:
    """Cursor CLI's per-session chat-store root (fixed, no env override)."""
    return Path.home() / ".cursor" / "chats"


def cursor_project_hash(cwd: str) -> str:
    """Community-documented <project-hash> for a workspace: md5(cwd) hexdigest.

    UNCONFIRMED upstream — callers must treat a non-match as "unknown", never
    as proof a session belongs elsewhere.
    """
    if not cwd:
        return ""
    return hashlib.md5(cwd.encode("utf-8")).hexdigest()


class CursorLogReader(LogReader):
    vendor: str = "cursor"

    def _chats_root(self) -> Path:
        return cursor_chats_root()

    def project_dirs(self) -> list[Path]:
        """The single chats root (empty list when it doesn't exist)."""
        root = self._chats_root()
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for f in root.glob(f"*/*/{_DB_NAME}"):
                    if _UUID_RE.match(f.parent.name) and f.is_file():
                        out.append(f)
            except OSError as err:
                log.debug("glob %s failed: %s", root, err)
        return out

    def session_id_from_path(self, path: Path) -> str:
        """Id is the session dir name (the chatId `agent --resume=<id>`
        accepts), NOT the stem — every session file is store.db. Sibling
        files (store.db-wal, -shm, anything unexpected) are not session
        files → '' so the resume sink skips them instead of coining bogus
        ids."""
        if path.name != _DB_NAME or not _UUID_RE.match(path.parent.name):
            return ""
        return path.parent.name

    def cwd_from_file(self, path: Path) -> str:
        """The workspace recorded in the sibling meta.json ('' when absent).

        store.db itself cannot answer this: its meta JSON has no cwd and the
        <project-hash> dir name is a one-way digest. meta.json is written by
        the CLI next to the db and holds the absolute path verbatim.
        """
        return str(_read_meta_json(path.parent).get("cwd") or "")

    def has_session(self, session_id: str) -> bool:
        """True when <root>/<any-project-hash>/<id>/store.db exists. The
        project-hash segment is not reliably derivable from the workspace
        (md5(cwd) is unconfirmed), so glob across every project dir."""
        session_id = session_id.strip()
        if not _UUID_RE.match(session_id):
            return False
        for root in self.project_dirs():
            try:
                if any(root.glob(f"*/{session_id}/{_DB_NAME}")):
                    return True
            except OSError:
                continue
        return False

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        """Best-effort md5(cwd) scoping: when the community-documented hash
        dir exists, return only its sessions; otherwise None → the caller
        falls back to session_files(), so a wrong hash assumption can only
        widen the scan, never hide sessions."""
        hash_dir = cursor_project_hash(workspace_path)
        if not hash_dir:
            return None
        base = self._chats_root() / hash_dir
        try:
            if not base.is_dir():
                return None
            return [
                f for f in base.glob(f"*/{_DB_NAME}")
                if _UUID_RE.match(f.parent.name) and f.is_file()
            ]
        except OSError:
            return None

    def _query(
        self, path: Path, sql: str, params: tuple = ()
    ) -> list[tuple] | None:
        """Short-lived read-only query. None = db unreadable this cycle
        (missing / busy / locked / missing table / mid-write) — callers
        treat it as no data."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
                return con.execute(sql, params).fetchall()
            finally:
                con.close()
        except (sqlite3.Error, OSError) as err:
            log.debug("sqlite read %s failed: %s", path, err)
            return None

    # ── token interface: Cursor stores no usage locally ────────────────────

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        """Cursor CLI keeps no token usage on disk → never any events."""
        return []

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """No token events, ever (usage is not stored locally). The
        checkpoint passes through unchanged; change detection for activity
        lives in parse_activity."""
        return IncrementalParseResult([], dict(checkpoint))

    # ── activity: db-write heartbeat + per-message blob scan ────────────────

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Turn events from the JSON message blobs, plus a write heartbeat.

        Two signals, because they cover different halves of a turn:

        * the blob scan (_blob_activity) only fires at turn boundaries — a
          user message and, at the end, an assistant message. Everything in
          between (tool calls, streamed chunks) is written as protobuf
          structure nodes, which carry no decodable role;
        * the mtime/size heartbeat (_stat_activity) is therefore kept: it is
          the only proof the agent is still working mid-turn. Its dedup keys
          ("stat:…") and watermark are disjoint from the blob scan's.

        The heartbeat is emitted first so that a pass which observes both
        reads as "working, then done" rather than the reverse.
        """
        session_id = self.session_id_from_path(path)
        if not session_id:
            return []
        cwd = self.cwd_from_file(path)
        out = self._stat_activity(path, session_id, cwd, seen_keys)
        out.extend(self._blob_activity(path, session_id, cwd, seen_keys))
        return out

    def _store_timestamp(self, path: Path) -> str:
        """ISO-8601 stamp for this pass's events.

        blobs has no time column at all, so there is no per-message timestamp
        to read; the closest real one is meta.json's `updatedAtMs`, which the
        CLI rewrites as part of each turn's commit (so consecutive turns get
        distinct values). The db's mtime is the fallback and the scan clock
        the last resort: the field must never be empty or unparseable —
        the frontend dedups messaging turns by timestamp and treats an
        unparseable one as always-fresh, which resends a delivered turn.
        """
        updated = _num(_read_meta_json(path.parent).get("updatedAtMs"))
        if updated:
            iso = _epoch_to_iso(updated / 1000)
            if iso:
                return iso
        try:
            iso = _epoch_to_iso(path.stat().st_mtime)
        except OSError:
            iso = None
        return iso or _epoch_to_iso(time.time()) or ""

    def _stat_activity(
        self, path: Path, session_id: str, cwd: str, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """One `agent_active` per observed db mtime/size change."""
        try:
            stat = path.stat()
        except OSError:
            return []
        token = f"{stat.st_mtime_ns}:{stat.st_size}"
        prev = next(
            (k[len(_STAT_PREFIX):] for k in seen_keys if k.startswith(_STAT_PREFIX)),
            None,
        )
        if prev == token:
            return []
        seen_keys.difference_update(
            {k for k in seen_keys if k.startswith(_STAT_PREFIX)}
        )
        seen_keys.add(_STAT_PREFIX + token)
        return [
            ActivityEvent(
                vendor="cursor",
                event_type="agent_active",
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=f"stat:{token}",
                timestamp=self._store_timestamp(path),
                detail="db-write",
            )
        ]

    def _blob_activity(
        self, path: Path, session_id: str, cwd: str, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """One event per new JSON message blob, watermarked on blobs.rowid."""
        prev = next(
            (
                k[len(_ACTIVITY_PREFIX):]
                for k in seen_keys
                if k.startswith(_ACTIVITY_PREFIX)
            ),
            None,
        )

        def remember(row_id: int) -> None:
            seen_keys.difference_update(
                {k for k in seen_keys if k.startswith(_ACTIVITY_PREFIX)}
            )
            seen_keys.add(_ACTIVITY_PREFIX + str(row_id))

        newest = self._query(path, "SELECT COALESCE(MAX(rowid), 0) FROM blobs")
        if newest is None:
            return []  # unreadable this cycle: no data, no state change
        top = int(newest[0][0] or 0)
        if prev is None:
            # First sight: what is already stored is history, not activity
            # happening now. A backend restart re-sees every session db, and
            # replaying those turns would resend their messages.
            remember(top)
            return []
        watermark = int(prev)
        if top < watermark:
            # The store shrank (session db recreated, vacuumed, replaced):
            # re-anchor rather than rescan, so old turns are never replayed.
            remember(top)
            return []
        rows = self._query(path, _ACTIVITY_SQL, (watermark, _MAX_BLOBS_PER_PASS))
        if not rows:
            return []
        remember(int(rows[-1][0]))

        timestamp = self._store_timestamp(path)
        out: list[ActivityEvent] = []
        for _row_id, blob_id, data in rows:
            message = _json_message(data)
            if message is None:
                continue  # protobuf structure node — never decoded
            role = str(message.get("role") or "")
            content = message.get("content")
            # Dedup on the content-addressed id, not the rowid: a row
            # re-inserted under the same id is the same message.
            key = f"blob:{blob_id}"
            if role == "assistant":
                # A new assistant message IS the end of a turn. Only the
                # "text" parts are the reply — "reasoning" parts are the
                # model's thinking and must never be sent to another CLI.
                out.append(ActivityEvent(
                    vendor="cursor", event_type="turn_complete", cwd=cwd,
                    session_id=session_id, file_path=str(path), dedup_key=key,
                    timestamp=timestamp, detail="assistant",
                    text=join_text_blocks(content, "text")[:_MAX_TURN_TEXT],
                ))
            elif role == "user":
                # "user" is the cross-end contract detail panes are named
                # from. Cursor wraps every prompt (<user_info>…, <timestamp>…
                # <user_query>), and user_prompt_text drops '<'-prefixed
                # injected wrappers, so in practice this text is '' — the
                # shared filter's deliberate behaviour, not a gap here.
                out.append(ActivityEvent(
                    vendor="cursor", event_type="agent_active", cwd=cwd,
                    session_id=session_id, file_path=str(path), dedup_key=key,
                    timestamp=timestamp, detail="user",
                    text=user_prompt_text(join_text_blocks(content, "text")),
                ))
            # role=system (the prompt preamble) is not activity.
        return out

    # ── marker binding ──────────────────────────────────────────────────────

    def find_sessions_by_marker(
        self, markers: Iterable[str]
    ) -> dict[str, tuple[str, str]]:
        """marker → (session_id, workspace_root) resolved by a raw UTF-8
        bytes substring scan over each session db's blobs (protobuf is never
        decoded). workspace_root is reported as '' even though meta.json now
        supplies one, which keeps Attribution's shared-db workspace gate
        permissive — a marker is globally unique, so it needs no corroboration.
        Unreadable dbs / missing tables / non-bytes values are skipped."""
        wanted = {m: m.encode("utf-8") for m in markers if m}
        if not wanted:
            return {}
        found: dict[str, tuple[str, str]] = {}
        sql = (
            f"SELECT substr(data, 1, {_MAX_BLOB_BYTES}) FROM blobs "
            f"LIMIT {_MAX_BLOBS_PER_DB}"
        )
        for db in self.session_files():
            if len(found) == len(wanted):
                break
            rows = self._query(db, sql)
            if rows is None:
                continue
            session_id = self.session_id_from_path(db)
            for (value,) in rows:
                if isinstance(value, memoryview):
                    value = bytes(value)
                elif isinstance(value, str):
                    value = value.encode("utf-8", errors="ignore")
                if not isinstance(value, bytes):
                    continue
                for marker, needle in wanted.items():
                    if marker not in found and needle in value:
                        found[marker] = (session_id, "")
        return found


# ---- attribution/watch hooks (appended at module level: the reader class
# gains them via assignment below, keeping the copied class body untouched) --

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # store.db carries no cwd (only the meta.json sidecar does, and it is not
    # on the TokenUsage path). A session already bound to a pane (marker hit)
    # attributes to that pane's workspace, so the gate can never drop a
    # marker-bound session; otherwise fall back to the md5(cwd) project-hash
    # dir name in the file path, which the 2026-08-16 sample confirmed.
    if owner_workspace is not None and owner_workspace == ws_path:
        return True
    hash_dir = cursor_project_hash(ws_path)
    if hash_dir and f"/{hash_dir}/" in usage.file_path:
        return True
    return False


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    # No cwd inside store.db; match the md5(cwd) project-hash dir in the file
    # path instead. Only the claim fallbacks use this — marker binding never
    # depends on it.
    hash_dir = cursor_project_hash(pane_cwd)
    return bool(hash_dir) and f"/{hash_dir}/" in usage.file_path


CursorLogReader.binds_shared_db_by_marker = True
CursorLogReader.emits_session_sink = True
CursorLogReader.workspace_match = _workspace_match
CursorLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------

CURSOR_KEYCHAIN_SERVICE = "cursor-access-token"
CURSOR_IDE_STATE_DB_REL = ("Library", "Application Support", "Cursor",
                           "User", "globalStorage", "state.vscdb")
CURSOR_IDE_TOKEN_KEY = "cursorAuth/accessToken"
CURSOR_USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary"


def _cursor_jwt_claims(token: str) -> dict | None:
    """Decode a JWT's payload (no signature check — the claims are only used
    to build the session cookie and pre-check expiry)."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    try:
        raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def cursor_user_id(token: str) -> str | None:
    """The WorkosCursorSessionToken user id: the JWT ``sub`` after the last
    ``|`` (e.g. ``google-oauth2|user_xxx`` -> ``user_xxx``)."""
    claims = _cursor_jwt_claims(token)
    sub = claims.get("sub") if claims else None
    if not isinstance(sub, str) or not sub:
        return None
    return sub.split("|")[-1] or None


def cursor_token_expired(token: str, now: float | None = None) -> bool:
    """True when the JWT ``exp`` (epoch seconds) has passed. Tokens are never
    refreshed here — the CLI/IDE rotate their own; missing/unreadable claims
    assume valid and let the endpoint's 401 decide."""
    claims = _cursor_jwt_claims(token)
    exp = _num(claims.get("exp")) if claims else None
    if exp is None:
        return False
    now = time.time() if now is None else now
    return now >= exp


def read_cursor_ide_token(home: Path) -> str | None:
    """The Cursor IDE fallback: the ``cursorAuth/accessToken`` ItemTable row of
    ``state.vscdb`` (sqlite, opened read-only) holds the raw session JWT."""
    path = home.joinpath(*CURSOR_IDE_STATE_DB_REL)
    if not path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        row = conn.execute("SELECT value FROM ItemTable WHERE key = ?",
                           (CURSOR_IDE_TOKEN_KEY,)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    if not row:
        return None
    value = row[0]
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith('"'):  # some rows store JSON-encoded strings
        try:
            value = json.loads(value)
        except ValueError:
            return None
    return value if isinstance(value, str) and value else None


_cursor_keychain_failed_at: float | None = None


async def read_cursor_credentials(home: Path) -> str | None:
    """cursor-agent CLI Keychain first (macOS ``security
    find-generic-password``, read-only), then the Cursor IDE state db. Returns
    the raw session JWT or None. A failed Keychain read is remembered for
    ``_KEYCHAIN_COOLDOWN_S`` (mirrors ``read_claude_credentials``). The CLI's
    Keychain slot is per-user, so per-pane isolated homes do not isolate
    cursor-agent credentials."""
    global _cursor_keychain_failed_at
    now = time.monotonic()
    if sys.platform == "darwin" and (
        _cursor_keychain_failed_at is None
        or now - _cursor_keychain_failed_at >= _KEYCHAIN_COOLDOWN_S
    ):
        try:
            proc = await asyncio.create_subprocess_exec(
                "/usr/bin/security", "find-generic-password",
                "-s", CURSOR_KEYCHAIN_SERVICE, "-w",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out = await communicate_or_kill(proc, timeout=2.0)
            if proc.returncode == 0:
                _cursor_keychain_failed_at = None
                token = out.decode("utf-8", "replace").strip()
                if token:
                    return token
            else:
                _cursor_keychain_failed_at = now
        except (OSError, asyncio.TimeoutError):
            _cursor_keychain_failed_at = now
    return read_cursor_ide_token(home)


def normalize_cursor(data: dict) -> tuple[list[dict], str | None]:
    """``usage-summary``: ``individualUsage.plan`` (cent amounts;
    ``totalPercentUsed`` is already in percent units, used/limit is the
    fallback) -> one billing-cycle window resetting at ``billingCycleEnd``;
    an enabled, limited ``individualUsage.onDemand`` adds an on-demand
    window; ``membershipType`` -> planType."""
    plan = data.get("membershipType")
    plan = plan if isinstance(plan, str) and plan else None
    resets = data.get("billingCycleEnd")
    resets = resets if isinstance(resets, str) and resets else None
    individual = data.get("individualUsage")
    individual = individual if isinstance(individual, dict) else {}
    windows: list[dict] = []
    plan_usage = individual.get("plan")
    if isinstance(plan_usage, dict):
        pct = _num(plan_usage.get("totalPercentUsed"))
        if pct is None:
            limit = _num(plan_usage.get("limit"))
            used = _num(plan_usage.get("used"))
            if limit and used is not None:
                pct = used / limit * 100
        if pct is not None:
            windows.append(_window("cycle", "Plan usage", pct, resets))
    on_demand = individual.get("onDemand")
    if isinstance(on_demand, dict) and on_demand.get("enabled"):
        limit = _num(on_demand.get("limit"))
        used = _num(on_demand.get("used"))
        if limit and used is not None:
            windows.append(_window("on-demand", "On-demand",
                                   used / limit * 100, resets))
    return windows, plan


async def fetch_cursor(home: Path) -> dict:
    token = await read_cursor_credentials(home)
    if token is None:
        return _snapshot("cursor", "no-credentials")
    if cursor_token_expired(token):
        return _snapshot("cursor", "expired")
    user_id = cursor_user_id(token)
    if user_id is None:
        return _snapshot("cursor", "error",
                         error="session token has no usable sub claim")
    import httpx

    # The one provider here that still needs a browser-shaped credential. The
    # User-Agent is honest, but ``usage-summary`` authenticates a signed-in
    # cursor.com session and nothing else: measured 2026-08-05, the same token
    # as ``Authorization: Bearer`` returns 401 while the session cookie returns
    # 200. The token is the user's own, read from their own machine — but this
    # is a dashboard session rebuilt from it, not an API credential, and that
    # distinction is the reason this one is worth revisiting if Cursor ever
    # publishes a real endpoint.
    headers = {
        "Cookie": f"WorkosCursorSessionToken={user_id}%3A%3A{token}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(CURSOR_USAGE_SUMMARY_URL, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("cursor", "expired")
    if resp.status_code == 429:
        snap = _snapshot("cursor", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("cursor", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("cursor", "error", error="non-JSON response")
    windows, plan = normalize_cursor(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("cursor", "error",
                         error="response had no usable quota fields")
    return _snapshot("cursor", "ok", windows=windows, plan_type=plan)


# ---- resume / session ------------------------------------------------------

# Cursor CLI's binary is `agent` (legacy installs: `cursor-agent`); both take
# --resume=<id> / --resume <id>.
_RESUME_RE = re.compile(
    r"^(?:agent|cursor-agent)\s+(?:\S+\s+)*--resume(?:=(\S+)|\s+([^-\s]\S*))"
)


def _resume_id_from_command(command) -> str:
    """Session id from an `agent ... --resume=<id>` /
    `cursor-agent ... --resume <id>` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return (m.group(1) or m.group(2)) if m else ""


def _session_path(workspace_path: str, session_id: str) -> Path | None:
    # The session path has a project-hash segment the id alone can't name —
    # no single stable path for the preflight to report.
    return None


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Ask the reader so a stale persisted id fails preflight instead of
    # launching a doomed `agent --resume`.
    return CursorLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

SPEC = VendorSpec(
    key="cursor",
    # Verified 2026-08-15 (docs): .cursor/skills and .agents/skills in the
    # project, ~/.cursor/skills globally, and no relocation variable at all —
    # the same corner its MCP wiring is in, so the workspace file is again the
    # only surface. Its CLI is also documented not to load ~/.agents/skills.
    skills_supported=True,
    skills_wiring=SkillsWiring(project_rel=(".cursor", "skills")),
    label="Cursor CLI",
    # The one CLI with no spawn-time surface — no MCP flag, no config
    # variable — so its per-project config file is the only way in. A bare
    # "url" is read as a remote server (stdio is the shape that names its
    # transport), and cursor interpolates ${env:...} inside it, which is what
    # lets one shared file serve panes with different per-pane URLs.
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcpServers",),
            entry=(("url", McpValue.URL),),
        ),
        project_config=(".cursor", "mcp.json"),
        url_env_template="${env:%s}",
    ),
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_cursor(home),
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    session_exists=_session_exists,
    make_log_reader=CursorLogReader,
    # Cursor CLI (closed source; binary `agent`, legacy installs `cursor-agent`)
    # ships `agent update` but no doctor subcommand. Autoupdate is on by default
    # with no confirmed opt-out env, and its data home is fixed at ~/.cursor
    # (no config-home env) — both stay empty. `cursor-agent` is declared as an
    # alternate so a machine still carrying the legacy binary is detected and
    # spawnable instead of being reported as not installed.
    install_dep=Dep("cursor", "Cursor CLI", "Cursor terminal coding agent CLI", "agent_cli",
        ["agent", "--version"], r"(\d+\.\d+\.\d+)",
        alt_commands=("cursor-agent",),
        install_cmd="curl https://cursor.com/install -fsS | bash",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://cursor.com/docs/cli",
        update_cmd="agent update"),
)
