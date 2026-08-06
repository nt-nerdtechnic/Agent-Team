"""Kilo Code CLI conversation reader.

Kilo Code (@kilocode/cli) is an OpenCode fork with the same SQLite schema:
one shared WAL database at <XDG_DATA_HOME|~/.local/share>/kilo/kilo.db with
session / message / part tables (message.data carries per-message tokens and
time.completed; user input text is preserved verbatim in part.data, so the
`at-pane:` kickoff marker lands there). Everything OpencodeLogReader does —
read-only short-lived connections, rowid-watermark incremental parsing with a
streaming-pending list, marker scanning over top-level sessions, has_session
preflight, cache-into-input / reasoning-into-output folding — applies
unchanged, so this reader only re-points the vendor name and db location.

Dev-channel databases (kilo-<channel>.db) are intentionally ignored — only
the stable kilo.db is read. Resume: `kilo --session <ses_…>` / `-s <id>`.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .base import VendorSpec, command_text
from .opencode import OpencodeLogReader  # vendor→vendor: sanctioned fork inheritance
from ..usage_common import (
    HTTP_TIMEOUT,
    _epoch_to_iso,
    _num,
    _snapshot,
    _window,
    parse_retry_after,
)


class KiloLogReader(OpencodeLogReader):
    vendor: str = "kilo"
    _dir_name: str = "kilo"
    _db_name: str = "kilo.db"


# ---- attribution/watch hooks ----------------------------------------------
# Kilo is an OpenCode fork: same shared-db binding, same cwd semantics —
# the flags/hooks inherit from OpencodeLogReader automatically. Nothing to
# override.


# ---- usage quota -----------------------------------------------------------

# kilo (Kilo CLI, @kilocode/cli). auth.json is a map keyed by provider id; the
# "kilo" entry holds either an api key or a long-lived oauth access token that
# IS the Kilo bearer token (1-year expiry, no refresh rotation needed for
# reads). The Kilo Pass query string is tRPC batch syntax for input {"0":null}.
KILO_DEFAULT_BASE = "https://api.kilo.ai"
KILO_AUTH_FILE_REL = (".local", "share", "kilo", "auth.json")
KILO_LEGACY_CONFIG_REL = (".kilocode", "cli", "config.json")
KILO_BALANCE_PATH = "/api/profile/balance"
KILO_PASS_PATH = "/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D"


def _kilo_entry_credentials(entry: Any) -> dict | None:
    """One auth.json provider entry -> {token, org_id} or None. ``api`` keys
    and ``oauth`` access tokens are both Kilo bearer tokens; oauth carries the
    organization id as ``accountId``. Local expiry is deliberately not checked
    (the token lives ~1 year) — a genuinely expired token maps to
    status=expired via the endpoint's 401."""
    if not isinstance(entry, dict):
        return None
    if entry.get("type") == "api":
        key = entry.get("key")
        return {"token": key, "org_id": None} \
            if isinstance(key, str) and key else None
    if entry.get("type") == "oauth":
        access = entry.get("access")
        if not isinstance(access, str) or not access:
            return None
        org = entry.get("accountId")
        return {"token": access,
                "org_id": org if isinstance(org, str) and org else None}
    return None


def _kilo_legacy_credentials(home: Path) -> dict | None:
    """Legacy ``~/.kilocode/cli/config.json``: providers[] entries with
    provider == "kilocode" carry kilocodeToken (+ kilocodeOrganizationId)."""
    try:
        data = json.loads(
            home.joinpath(*KILO_LEGACY_CONFIG_REL).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    providers = data.get("providers") if isinstance(data, dict) else None
    if not isinstance(providers, list):
        return None
    for entry in providers:
        if not isinstance(entry, dict) or entry.get("provider") != "kilocode":
            continue
        token = entry.get("kilocodeToken")
        if isinstance(token, str) and token:
            org = entry.get("kilocodeOrganizationId")
            return {"token": token,
                    "org_id": org if isinstance(org, str) and org else None}
    return None


def read_kilo_credentials(home: Path, env: dict | None = None) -> dict | None:
    """The Kilo bearer token + optional organization id, resolved the way the
    Kilo CLI does (read-only): ``KILO_AUTH_CONTENT`` env injects the whole
    auth.json content, otherwise ``~/.local/share/kilo/auth.json`` is read;
    the legacy ``~/.kilocode/cli/config.json`` is the last fallback. Returns
    ``{token, org_id}`` or None."""
    env = env or {}
    raw = env.get("KILO_AUTH_CONTENT")
    if raw:
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            data = None
    else:
        try:
            data = json.loads(
                home.joinpath(*KILO_AUTH_FILE_REL).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
    creds = _kilo_entry_credentials(data.get("kilo")) \
        if isinstance(data, dict) else None
    if creds is not None:
        return creds
    return _kilo_legacy_credentials(home)


def kilo_base_url(token: str, env: dict | None = None) -> str:
    """``KILO_API_URL`` env wins; a token prefixed ``https://host:`` re-points
    the base itself (the CLI's getKiloUrlFromToken — the token is still sent
    unmodified); default api.kilo.ai."""
    env = env or {}
    override = env.get("KILO_API_URL")
    if override:
        return override.rstrip("/")
    if token.startswith("https://"):
        base = token.rsplit(":", 1)[0]
        if base != "https":  # a ":" existed beyond the scheme
            return base.rstrip("/")
    return KILO_DEFAULT_BASE




def normalize_kilo_balance(data: dict) -> list[dict]:
    """``/api/profile/balance``: {"balance": USD remaining} — a prepaid credit
    pool with no reset window and no used/limit ratio, so the raw balance is
    surfaced as-is on a "credits" window (usedPercent is pinned to 0 because
    the window shape requires one; the balance field is the real datum)."""
    balance = _num(data.get("balance"))
    if balance is None:
        return []
    window = _window("credits", "Credits", 0.0, None)
    window["balance"] = balance
    return [window]


def kilo_pass_subscription(data: Any) -> dict | None:
    """The ``subscription`` object from a kiloPass.getState response. The tRPC
    envelope varies (batched array, result/data/json nesting), so wrappers are
    unwrapped level by level; a null subscription means no Kilo Pass."""
    node = data[0] if isinstance(data, list) and data else data
    for _ in range(4):
        if not isinstance(node, dict):
            return None
        sub = node.get("subscription")
        if isinstance(sub, dict):
            return sub
        for key in ("result", "data", "json"):
            if isinstance(node.get(key), dict):
                node = node[key]
                break
        else:
            return None
    return None


def normalize_kilo_pass(data: Any) -> list[dict]:
    """Kilo Pass subscription: currentPeriodUsageUsd against base + bonus
    period credits -> one "period" window resetting at nextBillingAt."""
    sub = kilo_pass_subscription(data)
    if sub is None:
        return []
    base = _num(sub.get("currentPeriodBaseCreditsUsd")) or 0.0
    bonus = _num(sub.get("currentPeriodBonusCreditsUsd")) or 0.0
    used = _num(sub.get("currentPeriodUsageUsd"))
    total = base + bonus
    if not total or used is None:
        return []
    resets = sub.get("nextBillingAt")
    return [_window("period", "Kilo Pass period", used / total * 100,
                    resets if isinstance(resets, str) else None)]




async def fetch_kilo(home: Path, env: dict | None = None) -> dict:
    env = env if env is not None else dict(os.environ)
    creds = read_kilo_credentials(home, env)
    if creds is None:
        return _snapshot("kilo", "no-credentials")
    import httpx

    base = kilo_base_url(creds["token"], env)
    headers = {
        "Authorization": f"Bearer {creds['token']}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    if creds.get("org_id"):
        # Switches the balance to the team's when the auth carries an org.
        headers["X-KILOCODE-ORGANIZATIONID"] = creds["org_id"]
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(f"{base}{KILO_BALANCE_PATH}", headers=headers)
        if resp.status_code in (401, 403):
            return _snapshot("kilo", "expired")
        if resp.status_code == 429:
            snap = _snapshot("kilo", "rate-limited")
            snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
            return snap
        if resp.status_code != 200:
            return _snapshot("kilo", "error", error=f"HTTP {resp.status_code}")
        try:
            payload = resp.json()
        except ValueError:
            return _snapshot("kilo", "error", error="non-JSON response")
        windows = normalize_kilo_balance(payload if isinstance(payload, dict) else {})
        # Kilo Pass period usage is best effort — a Pass endpoint failure must
        # not block the credit balance (the CLI treats non-OK as no Pass too).
        try:
            pass_resp = await client.get(f"{base}{KILO_PASS_PATH}", headers=headers)
            if pass_resp.status_code == 200:
                windows += normalize_kilo_pass(pass_resp.json())
        except (httpx.HTTPError, ValueError):
            pass
    if not windows:
        return _snapshot("kilo", "error", error="response had no usable fields")
    return _snapshot("kilo", "ok", windows=windows)




# ---- resume / session ------------------------------------------------------

# Kilo Code keeps OpenCode's resume flags — same optional-id guard so the
# capture never swallows a following flag.
_RESUME_RE = re.compile(r"^kilo\s+(?:\S+\s+)*(?:--session|-s)\s+([^-\s]\S*)")


def _resume_id_from_command(command) -> str:
    """Session id from a `kilo ... --session <id>` / `-s <id>` command
    ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # One shared SQLite db, same as OpenCode; ask the reader so a stale
    # persisted id fails preflight instead of launching a doomed
    # `kilo --session <id>`.
    return KiloLogReader().has_session(session_id)


# ---- vendor spec -----------------------------------------------------------

SPEC = VendorSpec(
    key="kilo",
    label="Kilo Code",
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_kilo(home),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    home_env_vars=("KILO_CONFIG_DIR", "KILO_CONFIG", "KILO_DB"),
    make_log_reader=KiloLogReader,
)
