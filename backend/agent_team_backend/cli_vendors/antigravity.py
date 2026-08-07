"""Antigravity CLI conversation reader (session discovery only).

Files: ~/.gemini/antigravity-cli/conversations/<uuid>.db — SQLite databases
whose payloads are undocumented protobuf blobs. Token usage is therefore NOT
parsed (parse_session_file returns []); this reader exists so that:

  • the watcher's session sink can bind a conversation to its pane via the
    kickoff marker (the .db filename stem is the id `agy --conversation`
    resumes), and
  • cwd_from_file() can map a conversation to its workspace — the
    trajectory_metadata_blob table embeds the workspace as a `file:///…` URI,
    extractable without decoding protobuf.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

import asyncio
import base64
import json
import os
import sys
import time

from .base import Dep, VendorSpec
from ..usage_common import (
    HTTP_TIMEOUT,
    _epoch_to_iso,
    _num,
    _snapshot,
    _window,
    communicate_or_kill as _communicate_or_kill,
    parse_retry_after,
)
from ..log_readers.base import LogReader, TokenUsage

log = logging.getLogger("agent_team_backend.log_readers.antigravity")

# A file URI run inside blob text: stop at control bytes (protobuf field
# boundaries); printable junk that follows the path is trimmed by the
# is_dir()/most-common selection in _extract_cwd.
_FILE_URI_RE = re.compile(r"file://(/[^\x00-\x1f\x7f]+)")


def _extract_cwd(text: str) -> str:
    """Best candidate workspace path from blob text.

    The URI appears several times; occurrences directly followed by protobuf
    tag bytes pick up printable junk suffixes. Prefer candidates that exist on
    disk, then the most frequent, then the shortest (the clean path is a
    prefix of its junk-suffixed variants).
    """
    counts: Counter[str] = Counter()
    for m in _FILE_URI_RE.finditer(text):
        counts[unquote(m.group(1)).rstrip("/")] += 1
    if not counts:
        return ""
    candidates = sorted(
        counts,
        key=lambda p: (not Path(p).is_dir(), -counts[p], len(p)),
    )
    return candidates[0]


class AntigravityLogReader(LogReader):
    vendor: str = "antigravity"

    def __init__(self) -> None:
        self._cwd_cache: dict[str, tuple[float, str]] = {}  # path → (mtime, cwd)

    def project_dirs(self) -> list[Path]:
        root = Path.home() / ".gemini" / "antigravity-cli" / "conversations"
        return [root] if root.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                out.extend(
                    f for f in root.iterdir()
                    if f.is_file() and f.suffix == ".db"  # skip -wal / -shm
                )
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        return [
            p for p in self.session_files()
            if self.cwd_from_file(p) == workspace_path
        ]

    def cwd_from_file(self, path: Path) -> str:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return ""
        cached = self._cwd_cache.get(str(path))
        if cached is not None and cached[0] == mtime:
            return cached[1]
        cwd = _extract_cwd(self._metadata_text(path))
        self._cwd_cache[str(path)] = (mtime, cwd)
        return cwd

    def _metadata_text(self, path: Path) -> str:
        """trajectory_metadata_blob rows decoded as text (errors ignored)."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                rows = con.execute(
                    "SELECT data FROM trajectory_metadata_blob"
                ).fetchall()
            finally:
                con.close()
            parts: list[str] = []
            for (data,) in rows:
                if isinstance(data, bytes):
                    parts.append(data.decode("utf-8", errors="ignore"))
                elif isinstance(data, str):
                    parts.append(data)
            return "".join(parts)
        except (sqlite3.Error, OSError) as err:
            log.debug("sqlite read %s failed (%s), falling back to raw scan", path, err)
        # Live db mid-write / locked: best-effort raw byte scan.
        try:
            return path.read_bytes().decode("utf-8", errors="ignore")
        except OSError:
            return ""

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        # Token counts live in undocumented protobuf blobs — intentionally not
        # parsed. Session binding happens via the watcher session sink instead.
        return []


# ---- attribution/watch hooks ----------------------------------------------

def _marker_scan_text(self, path):
    # Markers live in the metadata blob; recent frames (incl. the just-typed
    # marker) often sit in the -wal journal before being checkpointed into
    # the main db, so search it too. The hook owns its own read budget.
    text = self._metadata_text(path)[:524_288]
    try:
        text += Path(str(path) + "-wal").read_text(
            encoding="utf-8", errors="ignore")[:524_288]
    except OSError:
        pass
    return text


def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # cwd is extracted from trajectory_metadata_blob.
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


AntigravityLogReader.binds_by_marker_file = True
AntigravityLogReader.binds_new_session_single_candidate = True
AntigravityLogReader.emits_session_sink = True
AntigravityLogReader.marker_scan_text = _marker_scan_text
AntigravityLogReader.workspace_match = _workspace_match
AntigravityLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------

# Antigravity (Google). Credentials are READ-ONLY: the refresh token comes
# from the CLI's Keychain entry (stale-file fallback) and the minted access
# token stays in memory — Google's refresh grant returns no new refresh token
# (verified live), so nothing the CLI owns ever rotates. client_id/secret are
# Antigravity's public installed-app OAuth constants (the same values ship in
# its OSS auth plugin); an optional app-data override file can replace them.
ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini"
ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity"
ANTIGRAVITY_KEYRING_PREFIX = "go-keyring-base64:"
ANTIGRAVITY_TOKEN_FILE_REL = (".gemini", "antigravity-cli", "antigravity-oauth-token")
ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token"
ANTIGRAVITY_API_BASE = "https://cloudcode-pa.googleapis.com"
ANTIGRAVITY_LOAD_URL = f"{ANTIGRAVITY_API_BASE}/v1internal:loadCodeAssist"
ANTIGRAVITY_QUOTA_URL = f"{ANTIGRAVITY_API_BASE}/v1internal:retrieveUserQuotaSummary"
ANTIGRAVITY_LOAD_METADATA = {
    "ideType": "ANTIGRAVITY",
    "platform": "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI",
}
# Minting an access token needs Antigravity's own OAuth client credentials.
# This app ships none and stores none: the values come from the environment, so
# enabling this provider is the operator's explicit act, not something a build
# carries. Unset (the default) means the quota read is skipped with a status
# that says why, rather than a mystery error.
ANTIGRAVITY_CLIENT_ID = os.environ.get("NAVIDE_ANTIGRAVITY_CLIENT_ID", "")
ANTIGRAVITY_CLIENT_SECRET = os.environ.get("NAVIDE_ANTIGRAVITY_CLIENT_SECRET", "")
ANTIGRAVITY_NEEDS_OAUTH_CONFIG = (
    "signed in, but reading the quota needs Antigravity's OAuth client "
    "credentials; set NAVIDE_ANTIGRAVITY_CLIENT_ID and "
    "NAVIDE_ANTIGRAVITY_CLIENT_SECRET to enable it"
)


def _antigravity_refresh_token(raw: str) -> str | None:
    """Extract ``token.refresh_token`` from a stored Antigravity credential
    blob. Accepts both the Keychain form (``go-keyring-base64:`` + base64(JSON))
    and the bare JSON token file. The stored access_token is deliberately
    ignored — it is almost always expired and a fresh one is minted in memory
    from the refresh token."""
    raw = raw.strip()
    if raw.startswith(ANTIGRAVITY_KEYRING_PREFIX):
        try:
            raw = base64.b64decode(
                raw[len(ANTIGRAVITY_KEYRING_PREFIX):]).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    token = data.get("token") if isinstance(data, dict) else None
    if isinstance(token, dict):
        rt = token.get("refresh_token")
        if isinstance(rt, str) and rt:
            return rt
    return None


def read_antigravity_credentials_file(home: Path) -> str | None:
    """Stale-file fallback: ``~/.gemini/antigravity-cli/antigravity-oauth-token``.
    Returns the refresh_token or None."""
    path = home.joinpath(*ANTIGRAVITY_TOKEN_FILE_REL)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return _antigravity_refresh_token(raw)


_agy_keychain_failed_at: float | None = None


async def read_antigravity_credentials(home: Path) -> str | None:
    """Keychain first (macOS ``security find-generic-password``, read-only),
    then the stale token file. Returns the refresh_token or None. A failed
    Keychain read is remembered for ``_KEYCHAIN_COOLDOWN_S`` so a denial does
    not re-prompt every poll (mirrors ``read_claude_credentials``)."""
    global _agy_keychain_failed_at
    now = time.monotonic()
    if sys.platform == "darwin" and (
        _agy_keychain_failed_at is None
        or now - _agy_keychain_failed_at >= _KEYCHAIN_COOLDOWN_S
    ):
        try:
            proc = await asyncio.create_subprocess_exec(
                "/usr/bin/security", "find-generic-password",
                "-s", ANTIGRAVITY_KEYCHAIN_SERVICE,
                "-a", ANTIGRAVITY_KEYCHAIN_ACCOUNT, "-w",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out = await _communicate_or_kill(proc, timeout=2.0)
            if proc.returncode == 0:
                _agy_keychain_failed_at = None
                rt = _antigravity_refresh_token(out.decode("utf-8", "replace"))
                if rt is not None:
                    return rt
            else:
                _agy_keychain_failed_at = now
        except (OSError, asyncio.TimeoutError):
            _agy_keychain_failed_at = now
    return read_antigravity_credentials_file(home)




_ANTIGRAVITY_WINDOW_KINDS = {"5h": "session", "weekly": "weekly"}


def normalize_antigravity(data: dict) -> tuple[list[dict], str | None]:
    """``groups[].buckets[]`` from retrieveUserQuotaSummary. remainingFraction
    is a 0..1 remaining ratio (omitted when a full quota is implied -> 0 used);
    ``window`` is "5h"/"weekly". The tightest (lowest remaining) bucket sorts
    first so a windows[0]-only consumer surfaces the most-constrained quota."""
    ranked: list[tuple[float, dict]] = []
    for group in data.get("groups") or []:
        if not isinstance(group, dict):
            continue
        group_name = group.get("displayName")
        for bucket in group.get("buckets") or []:
            if not isinstance(bucket, dict):
                continue
            frac = _num(bucket.get("remainingFraction"))
            if frac is None:
                frac = 1.0  # omitted when the quota is untouched
            window = bucket.get("window")
            kind = _ANTIGRAVITY_WINDOW_KINDS.get(window) or (
                window if isinstance(window, str) and window else "other")
            names = [n for n in (group_name, bucket.get("displayName"))
                     if isinstance(n, str) and n]
            label = " — ".join(names) or str(bucket.get("bucketId") or "Quota")
            reset = bucket.get("resetTime")
            ranked.append((frac, _window(
                kind, label, 100.0 * (1.0 - frac),
                reset if isinstance(reset, str) else None)))
    ranked.sort(key=lambda item: item[0])
    return [w for _, w in ranked], None


def antigravity_plan(data: dict) -> str | None:
    """loadCodeAssist ``currentTier`` -> plan label (name, falling back to id),
    surfaced as-is."""
    tier = data.get("currentTier")
    if not isinstance(tier, dict):
        return None
    for key in ("name", "id"):
        value = tier.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def antigravity_project(data: dict) -> str | None:
    """loadCodeAssist ``cloudaicompanionProject`` is a plain string or ``{id}``."""
    project = data.get("cloudaicompanionProject")
    if isinstance(project, str) and project:
        return project
    if isinstance(project, dict):
        pid = project.get("id")
        if isinstance(pid, str) and pid:
            return pid
    return None




async def refresh_antigravity_token(refresh_token: str) -> str | None:
    """Exchange the refresh_token for an access_token, held in memory only.

    Never written back to the Keychain or ``~/.gemini``; Google's grant returns
    no new refresh token, so nothing the CLI owns rotates. None on 400/401
    (invalid_grant -> expired); other failures raise for the caller to map."""
    import httpx

    body = {
        "grant_type": "refresh_token",
        "client_id": ANTIGRAVITY_CLIENT_ID,
        "client_secret": ANTIGRAVITY_CLIENT_SECRET,
        "refresh_token": refresh_token,
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.post(ANTIGRAVITY_TOKEN_URL, data=body)
    if resp.status_code in (400, 401):
        return None
    resp.raise_for_status()
    token = resp.json().get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("token response had no access_token")
    return token


async def fetch_antigravity(home: Path) -> dict:
    """Quota via Google's Code Assist API, using the CLI's stored refresh token.

    The heaviest read of the set, and the only one whose enablement is a
    deliberate act: it needs Antigravity's OAuth client credentials, which this
    app neither ships nor stores (see ANTIGRAVITY_CLIENT_ID). Without them the
    account still reports as signed in — that part is a local file lookup — and
    the quota is reported as unavailable with the reason."""
    refresh_token = await read_antigravity_credentials(home)
    if refresh_token is None:
        return _snapshot("antigravity", "no-credentials")
    if not (ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET):
        return _snapshot("antigravity", "unavailable",
                         error=ANTIGRAVITY_NEEDS_OAUTH_CONFIG)
    import httpx

    try:
        access_token = await refresh_antigravity_token(refresh_token)
    except (httpx.HTTPError, ValueError) as err:
        return _snapshot("antigravity", "error", error=f"token refresh: {err}")
    if access_token is None:
        return _snapshot("antigravity", "expired")

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    plan: str | None = None
    project: str | None = None
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            # loadCodeAssist supplies the project id + tier. Best effort — a
            # failure must not block the quota read ({} still works there).
            try:
                load = await client.post(
                    ANTIGRAVITY_LOAD_URL, headers=headers,
                    json={"metadata": ANTIGRAVITY_LOAD_METADATA})
                if load.status_code == 200:
                    payload = load.json()
                    if isinstance(payload, dict):
                        project = antigravity_project(payload)
                        plan = antigravity_plan(payload)
            except (httpx.HTTPError, ValueError):
                pass
            resp = await client.post(
                ANTIGRAVITY_QUOTA_URL, headers=headers,
                json={"project": project} if project else {})
    except httpx.HTTPError as err:
        return _snapshot("antigravity", "error", error=str(err))
    if resp.status_code == 401:
        return _snapshot("antigravity", "expired")
    if resp.status_code == 429:
        snap = _snapshot("antigravity", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("antigravity", "error", error=f"HTTP {resp.status_code}")
    windows, _ = normalize_antigravity(resp.json())
    return _snapshot("antigravity", "ok", windows=windows, plan_type=plan)




# ---- session ---------------------------------------------------------------

def _session_path(workspace_path: str, session_id: str) -> Path:
    # Each conversation is a SQLite db; the id is the filename stem accepted
    # by `agy --conversation <id>`. (`agy --conversation` parsing itself
    # lives frontend-side today — the backend deliberately claims nothing.)
    return (Path.home() / ".gemini" / "antigravity-cli" / "conversations"
            / f"{session_id}.db")


# ---- vendor spec -----------------------------------------------------------

SPEC = VendorSpec(
    key="antigravity",
    label="Antigravity",
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_antigravity(home),
    session_path=_session_path,
    make_log_reader=AntigravityLogReader,
    install_dep=Dep("antigravity", "Antigravity", "Google Antigravity CLI", "agent_cli",
        ["agy", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="curl -fsSL https://antigravity.google/cli/install.sh | bash",
        needs_terminal=True, requires_binaries=("curl",), optional=True,
        docs_url="https://antigravity.google/docs/cli-getting-started",
        update_cmd="agy update"),
)
