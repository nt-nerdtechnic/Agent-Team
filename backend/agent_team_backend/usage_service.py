"""Per-CLI quota/usage monitor (CodexBar-style).

Reads the credentials each CLI already stores locally and calls that
provider's own usage surface — no login flow, no credential writes:

- claude: no request from here at all — the CLI's own ``/usage`` panel is
  read instead, so Claude Code asks under its own identity
  (see :mod:`claude_cli_usage`). ``api/oauth/usage`` is still reached for the
  Anthropic OAuth grants that opencode and pi keep in their own auth files,
  where there is no vendor CLI to delegate to.
- codex:  ``$CODEX_HOME/auth.json`` -> ``GET <base>/wham/usage``
  (base from ``config.toml`` ``chatgpt_base_url``, default chatgpt.com)
- kimi:   ``~/.kimi-code/credentials/kimi-code.json`` ->
  ``GET https://api.kimi.com/coding/v1/usages``
- grok:   ``~/.grok/auth.json`` + ``grok agent stdio`` JSON-RPC
  method ``x.ai/billing``
- antigravity: refresh token from macOS Keychain ``gemini``/``antigravity``
  (stale-file fallback ``~/.gemini/antigravity-cli/antigravity-oauth-token``)
  -> in-memory Google OAuth refresh ->
  ``POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary``.
  Minting the token needs Antigravity's OAuth client credentials, which this
  app neither ships nor stores: set NAVIDE_ANTIGRAVITY_CLIENT_ID/_SECRET to
  enable the quota read. Unset, the account still reports as signed in.
- opencode: ``~/.local/share/opencode/auth.json`` is an aggregator (a map of
  providerID -> credential); each supported entry is mapped to that
  provider's own usage endpoint: ``minimax-coding-plan`` ->
  ``GET https://api.minimax.io/v1/token_plan/remains``; ``anthropic`` oauth
  reuses the Claude flow. opencode Zen and plain BYOK API keys expose no
  usage surface -> unavailable.
- qwen: Alibaba ModelStudio Coding Plan API key (``sk-sp-...``) from the
  process env (``BAILIAN_CODING_PLAN_API_KEY`` + CodexBar's aliases),
  ``~/.qwen/.env`` or the ``env`` block of ``~/.qwen/settings.json`` ->
  ``POST <console gateway>/data/api.json queryCodingPlanInstanceInfoV2``
  (international region first, China-mainland retry). The key is what the
  gateway authenticates; the browser User-Agent this once sent is gone, while
  Origin/Referer stay because the gateway refuses cross-site posts without
  them. The legacy Qwen OAuth file has no usage API (free tier discontinued).
- kilo: ``~/.local/share/kilo/auth.json`` (the ``kilo`` entry: api key, or the
  long-lived oauth access token + accountId org; legacy fallback
  ``~/.kilocode/cli/config.json``) ->
  ``GET https://api.kilo.ai/api/profile/balance`` (prepaid credit balance) +
  best-effort ``GET /api/trpc/kiloPass.getState`` (Kilo Pass period usage).
- pi: ``~/.pi/agent/auth.json`` (root overridable via ``PI_CODING_AGENT_DIR``)
  is an aggregator (a map of provider id -> credential); pi has no server of
  its own, so each supported entry is mapped to that provider's own usage
  endpoint: ``anthropic`` oauth reuses the Claude flow (pi's OAuth uses Claude
  Code's client id, so the token is interchangeable), ``openai-codex`` oauth
  -> ChatGPT ``wham/usage``, ``openrouter`` ->
  ``GET https://openrouter.ai/api/v1/key`` (credit usage). Plain BYOK API
  keys and github-copilot/xai/radius expose no usage surface -> unavailable.
- copilot: ``~/.copilot/config.json`` (JSONC) names the signed-in GitHub
  account; the CLI's own OAuth token lives in the macOS Keychain (not probed),
  so the token is read via ``gh auth token -u <login>`` (fallbacks: the
  VS Code-style ``~/.config/github-copilot/{apps,hosts}.json`` oauth_token,
  then ``GH_TOKEN``/``GITHUB_TOKEN`` env)
  -> ``GET https://api.<host>/copilot_internal/user``, identified as Navide
  (the VS Code extension headers it once sent turned out not to be required).
- cursor: session JWT from the macOS Keychain generic password
  ``cursor-access-token`` (cursor-agent CLI; fallback: the Cursor IDE's
  ``~/Library/Application Support/Cursor/User/globalStorage/state.vscdb``
  sqlite row ``cursorAuth/accessToken``) ->
  ``GET https://cursor.com/api/usage-summary``. The only provider here that
  still needs a browser-shaped credential: the endpoint authenticates a
  signed-in cursor.com session, so the JWT is presented as that site's own
  ``WorkosCursorSessionToken`` cookie (Bearer returns 401).

Every credential file is read-only here; token refresh is left to the CLI
that owns the file (refreshing ourselves would rotate the CLI's tokens).
antigravity is the one exception: Google's refresh grant returns no new
refresh token (verified), so a fresh access token is minted in memory
without rotating anything the CLI owns.
Snapshots are normalized to one shape so the frontend never sees provider
quirks (epoch seconds, used/limit ratios, cent amounts are converted here):

    { provider, status: ok|no-credentials|expired|rate-limited|unavailable|error,
      planType, windows: [{ kind, label, usedPercent, resetsAt }], fetchedAt,
      error }

A single background poller serves every window (broadcast via
``usage.changed``); per-provider 429 cooldowns respect ``Retry-After`` and a
reset-boundary refresh re-polls shortly after a window's ``resetsAt`` passes.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import json
import logging
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .applog import app_data_dir
from .cli_vendors.registry import vendor as _cli_vendor
from .credential_vault import vault_to_thread

log = logging.getLogger(__name__)

PROVIDERS = ("claude", "codex", "kimi", "grok", "antigravity", "opencode", "qwen",
             "kilo", "pi", "copilot", "cursor")

# How long a `/usage` panel reading stands before the CLI is asked again. The
# read costs a full Claude Code start, so it deliberately does not follow the
# poll interval; the badge's refresh button clears it via `request_refresh`.
CLAUDE_CLI_READ_INTERVAL = 900.0
CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"
# Claude OAuth tokens are never minted here. Anthropic rotates refresh tokens,
# so every exchange invalidates the previous one: whenever this app refreshed a
# credential the CLI also owns, one of the two ended up holding a dead token and
# the account had to be signed in again. The CLI is the only refresher — a
# parked slot's access token is simply allowed to expire, and Claude Code
# renews it from the restored refresh token the first time it runs.
KIMI_DEFAULT_BASE = "https://api.kimi.com"
# cursor (Cursor / cursor-agent CLI). The session JWT the CLI stores in the
# macOS Keychain (fallback: the Cursor IDE's state.vscdb sqlite row) is still
# read to detect sign-in and local expiry, and to authenticate usage-summary by
# rebuilding cursor.com's own WorkosCursorSessionToken cookie. Unofficial but
# stable, and the only form that answers: the legacy Bearer endpoint returns
# null limits on dollar-based plans, and Bearer against usage-summary itself
# returns 401 (measured 2026-08-05).
CURSOR_KEYCHAIN_SERVICE = "cursor-access-token"
CURSOR_IDE_STATE_DB_REL = ("Library", "Application Support", "Cursor",
                           "User", "globalStorage", "state.vscdb")
CURSOR_IDE_TOKEN_KEY = "cursorAuth/accessToken"
CURSOR_USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary"
RESET_BOUNDARY_GRACE = 30.0
DEFAULT_INTERVAL = 300.0
MIN_INTERVAL = 60.0
USAGE_CACHE_FILE = "usage-cache.json"
USAGE_CACHE_SCHEMA_VERSION = 1


# Snapshot plumbing lives in usage_common (importable by vendor modules);
# re-exported here so this module's namespace is unchanged for callers/tests.
from .usage_common import (  # noqa: E402,F401
    HTTP_TIMEOUT,
    RATE_LIMIT_COOLDOWN,
    _clamp_pct,
    _epoch_to_iso,
    _now_iso,
    _num,
    _snapshot,
    _window,
    parse_retry_after,
)

# R2: qwen's usage stack moved to its vendor module; re-exported so this
# module's namespace (and its tests) keep working until the cleanup round.
from .cli_vendors.grok import (  # noqa: E402,F401
    GROK_BILLING_TIMEOUT,
    GROK_INIT_TIMEOUT,
    fetch_grok,
    grok_billing_rpc,
    normalize_grok,
    read_grok_credentials,
)
from .cli_vendors.pi import (  # noqa: E402,F401
    PI_AGENT_DIR_ENV,
    PI_OPENROUTER_KEY_URL,
    fetch_pi,
    normalize_pi_openrouter,
    pi_anthropic_oauth,
    pi_codex_oauth,
    pi_oauth_expired,
    pi_openrouter_key,
    read_pi_credentials,
)
from .cli_vendors.kilo import (  # noqa: E402,F401
    KILO_AUTH_FILE_REL,
    KILO_BALANCE_PATH,
    KILO_DEFAULT_BASE,
    KILO_LEGACY_CONFIG_REL,
    KILO_PASS_PATH,
    fetch_kilo,
    kilo_base_url,
    kilo_pass_subscription,
    normalize_kilo_balance,
    normalize_kilo_pass,
    read_kilo_credentials,
)
from .cli_vendors.opencode import (  # noqa: E402,F401
    OPENCODE_AUTH_FILE_REL,
    OPENCODE_MINIMAX_USAGE_URL,
    fetch_opencode,
    normalize_opencode_minimax,
    opencode_anthropic_oauth,
    opencode_minimax_key,
    read_opencode_credentials,
)
from .cli_vendors._protocols import (  # noqa: E402,F401
    CODEX_DEFAULT_BASE,
    _codex_credits,
    _codex_extra_windows,
    codex_usage_url,
    normalize_codex,
    CLAUDE_BETA_HEADER,
    CLAUDE_USAGE_URL,
    claude_token_expired,
    fetch_claude_oauth,
    normalize_claude,
)
from .cli_vendors.antigravity import (  # noqa: E402,F401
    _antigravity_refresh_token,
    ANTIGRAVITY_CLIENT_ID,
    ANTIGRAVITY_CLIENT_SECRET,
    ANTIGRAVITY_KEYCHAIN_ACCOUNT,
    ANTIGRAVITY_KEYCHAIN_SERVICE,
    ANTIGRAVITY_LOAD_URL,
    ANTIGRAVITY_QUOTA_URL,
    ANTIGRAVITY_TOKEN_FILE_REL,
    ANTIGRAVITY_TOKEN_URL,
    antigravity_plan,
    antigravity_project,
    fetch_antigravity,
    normalize_antigravity,
    read_antigravity_credentials,
    read_antigravity_credentials_file,
    refresh_antigravity_token,
)
from .cli_vendors.copilot import (  # noqa: E402,F401
    COPILOT_CONFIG_FILE_REL,
    COPILOT_DEFAULT_HOST,
    COPILOT_ENV_KEYS,
    COPILOT_HOSTS_FILES_REL,
    copilot_env_token,
    copilot_usage_url,
    fetch_copilot,
    normalize_copilot,
    read_copilot_config,
    read_copilot_hosts_token,
)
from .cli_vendors.cursor import (  # noqa: E402,F401
    CURSOR_IDE_STATE_DB_REL,
    CURSOR_IDE_TOKEN_KEY,
    CURSOR_KEYCHAIN_SERVICE,
    CURSOR_USAGE_SUMMARY_URL,
    cursor_token_expired,
    cursor_user_id,
    fetch_cursor,
    normalize_cursor,
    read_cursor_credentials,
    read_cursor_ide_token,
)
from .cli_vendors.qwen import (  # noqa: E402,F401
    QWEN_CN_USAGE_URL,
    QWEN_ENV_KEYS,
    QWEN_INTL_USAGE_URL,
    QWEN_REGIONS,
    fetch_qwen,
    normalize_qwen,
    qwen_legacy_oauth_present,
    read_qwen_credentials,
)


# ── Credential readers (pure; ``home`` injectable for tests) ────────────────

def read_claude_credentials_file(home: Path) -> dict | None:
    """Parse ``~/.claude/.credentials.json``. Returns the claudeAiOauth dict
    or None when absent/unusable (an mcpOAuth-only payload counts as absent)."""
    path = home / ".claude" / ".credentials.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        return None
    return oauth


def parse_claude_credentials(raw: str | None) -> dict | None:
    """Extract Claude OAuth data from a vault credential payload."""
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        return None
    return oauth




# A failed Keychain read (denied prompt, timeout) is remembered so we don't
# re-prompt every poll — but only for a cooldown window, so a transient failure
# (e.g. a slow security call during an account switch) self-heals without an app
# restart. monotonic timestamp; None means no active cooldown.
_KEYCHAIN_COOLDOWN_S = 300.0
_keychain_failed_at: float | None = None


from .usage_common import (  # noqa: E402,F401
    _KEYCHAIN_COOLDOWN_S as _SHARED_KEYCHAIN_COOLDOWN_S,
    communicate_or_kill as _communicate_or_kill,
)


async def read_claude_credentials(home: Path) -> dict | None:
    """File first; on macOS fall back to the Keychain generic password the
    Claude Code CLI writes. A failed Keychain read is remembered for
    ``_KEYCHAIN_COOLDOWN_S`` (the prompt/denial would otherwise re-fire every
    poll), then retried so a transient failure self-heals."""
    global _keychain_failed_at
    oauth = read_claude_credentials_file(home)
    if oauth is not None:
        return oauth
    if sys.platform != "darwin":
        return None
    now = time.monotonic()
    if _keychain_failed_at is not None and now - _keychain_failed_at < _KEYCHAIN_COOLDOWN_S:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/security", "find-generic-password",
            "-s", CLAUDE_KEYCHAIN_SERVICE, "-w",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out = await _communicate_or_kill(proc, timeout=2.0)
        if proc.returncode != 0:
            _keychain_failed_at = now
            return None
        _keychain_failed_at = None
        data = json.loads(out.decode("utf-8", "replace").strip())
        oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
        if not isinstance(oauth, dict) or not oauth.get("accessToken"):
            return None
        return oauth
    except (OSError, ValueError, asyncio.TimeoutError):
        _keychain_failed_at = now
        return None


def read_codex_credentials(codex_home: Path) -> dict | None:
    """Parse ``auth.json``: tokens object (snake_case or camelCase) or the
    bare ``{"OPENAI_API_KEY": ...}`` form."""
    try:
        data = json.loads((codex_home / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    tokens = data.get("tokens")
    if isinstance(tokens, dict):
        access = tokens.get("access_token") or tokens.get("accessToken")
        if access:
            return {
                "access_token": access,
                "account_id": tokens.get("account_id") or tokens.get("accountId"),
            }
    api_key = data.get("OPENAI_API_KEY")
    if isinstance(api_key, str) and api_key:
        return {"access_token": api_key, "account_id": None}
    return None


def codex_base_url(codex_home: Path) -> str:
    """``chatgpt_base_url`` from config.toml (simple line parse, matching
    CodexBar), normalized: strip trailing slash; chatgpt.com/chat.openai.com
    bases get ``/backend-api`` appended when missing."""
    base = ""
    try:
        for line in (codex_home / "config.toml").read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "chatgpt_base_url":
                base = value.strip().strip("'\"")
                break
    except OSError:
        pass
    if not base:
        return CODEX_DEFAULT_BASE
    base = base.rstrip("/")
    if (base.startswith("https://chatgpt.com") or base.startswith("https://chat.openai.com")) \
            and "/backend-api" not in base:
        base += "/backend-api"
    return base


def read_kimi_credentials(home: Path, env: dict | None = None,
                          now: float | None = None) -> str | None:
    """``KIMI_CODE_API_KEY`` env wins; otherwise the CLI OAuth file, used only
    while ``expires_at`` is more than 60 s away (matching CodexBar)."""
    env = env or {}
    api_key = env.get("KIMI_CODE_API_KEY")
    if api_key:
        return api_key
    kimi_home = Path(env["KIMI_CODE_HOME"]) if env.get("KIMI_CODE_HOME") else home / ".kimi-code"
    try:
        data = json.loads((kimi_home / "credentials" / "kimi-code.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    token = data.get("access_token")
    expires = _num(data.get("expires_at"))
    if not token or expires is None:
        return None
    now = time.time() if now is None else now
    return token if expires > now + 60 else None


def _kimi_used(detail: dict, limit):
    used = _num(detail.get("used"))
    if used is None:
        rem = _num(detail.get("remaining"))
        if rem is not None and limit is not None:
            used = max(0.0, limit - rem)
    return used


def _kimi_resets(detail: dict):
    r = (detail.get("resetTime") or detail.get("resetAt")
         or detail.get("reset_time") or detail.get("reset_at"))
    return r if isinstance(r, str) else None


def normalize_kimi(data: dict) -> tuple[list[dict], str | None]:
    windows: list[dict] = []
    usage = data.get("usage")
    if isinstance(usage, dict):
        limit = _num(usage.get("limit"))
        used = _kimi_used(usage, limit)
        if limit and used is not None:
            windows.append(_window("weekly", "Weekly", used / limit * 100,
                                   _kimi_resets(usage)))
    # CodexBar's Code-API model nests the 5h rate-limit under
    # ``limits[0].detail`` (KimiRateLimit { window, detail }), not at top level.
    limits = data.get("limits")
    if isinstance(limits, list) and limits and isinstance(limits[0], dict):
        detail = limits[0].get("detail")
        if isinstance(detail, dict):
            limit = _num(detail.get("limit"))
            used = _kimi_used(detail, limit)
            if limit and used is not None:
                windows.append(_window("session", "Rate limit (5h)",
                                       used / limit * 100, _kimi_resets(detail)))
    return windows, None


async def fetch_claude(home: Path) -> dict:
    """Claude quota, read from the CLI's own ``/usage`` panel.

    Claude Code asks Anthropic under its own identity and prints the answer;
    this reads what it printed. It replaced a direct HTTP call this app made
    while presenting itself as ``claude-code/<version>``. ``home`` locates the
    live credential for the logged-out precheck; the CLI itself still reads
    whichever credential is live."""
    from .claude_cli_usage import fetch_claude_usage_via_cli

    return await fetch_claude_usage_via_cli(home) or _snapshot("claude", "unavailable")


async def fetch_codex(codex_home: Path) -> dict:
    creds = read_codex_credentials(codex_home)
    if creds is None:
        # Fresh-install rescue: an OAuth login completed inside a manual pane
        # sits stranded in ~/.codex-panes/<pane>/auth.json (no real auth.json
        # existed to symlink at spawn). Adopt it so the credential is shared
        # and the badge lights without waiting for a new pane spawn.
        from .codex_home import CodexHomeManager

        if await asyncio.to_thread(
            CodexHomeManager(real_home=codex_home).promote_stranded_auth
        ):
            creds = read_codex_credentials(codex_home)
    if creds is None:
        return _snapshot("codex", "no-credentials")
    import httpx

    headers = {
        "Authorization": f"Bearer {creds['access_token']}",
        "User-Agent": "Navide",
        "Accept": "application/json",
    }
    if creds.get("account_id"):
        headers["ChatGPT-Account-Id"] = creds["account_id"]
    url = codex_usage_url(codex_base_url(codex_home))
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("codex", "expired")
    if resp.status_code == 429:
        snap = _snapshot("codex", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("codex", "error", error=f"HTTP {resp.status_code}")
    payload = resp.json()
    windows, plan = normalize_codex(payload)
    snap = _snapshot("codex", "ok", windows=windows, plan_type=plan)
    credits = _codex_credits(payload)
    if credits is not None:
        snap["credits"] = credits
    extra = _codex_extra_windows(payload)
    if extra:
        snap["extraWindows"] = extra
    return snap


async def fetch_kimi(home: Path, env: dict | None = None) -> dict:
    import os

    env = env if env is not None else dict(os.environ)
    token = read_kimi_credentials(home, env)
    if token is None:
        return _snapshot("kimi", "no-credentials")
    import httpx

    base = (env.get("KIMI_CODE_BASE_URL") or KIMI_DEFAULT_BASE).rstrip("/")
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "Navide",
        "X-Msh-Platform": "kimi_code_cli",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(f"{base}/coding/v1/usages", headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("kimi", "expired")
    if resp.status_code == 429:
        snap = _snapshot("kimi", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("kimi", "error", error=f"HTTP {resp.status_code}")
    windows, plan = normalize_kimi(resp.json())
    return _snapshot("kimi", "ok", windows=windows, plan_type=plan)


# ── Poller service ──────────────────────────────────────────────────────────

def _get_profiles_store():
    """The app-wide CLI profiles store, or ``None`` when unavailable (unit
    tests, early startup). Isolated behind a function so tests can stub profile
    resolution without importing the whole app."""
    try:
        from . import app
        return app.cli_profiles_store
    except Exception:  # noqa: BLE001
        return None


def _get_credential_vault():
    """The app-wide credential vault, or ``None`` when unavailable (unit
    tests, early startup)."""
    try:
        from . import app
        return app.credential_vault
    except Exception:  # noqa: BLE001
        return None


# ── Login watch ─────────────────────────────────────────────────────────────
# A login pane just spawned into a profile's isolated login home. Poll that
# home on a short interval so the account row flips to signed-in the moment
# the browser authorization completes, instead of waiting for the next usage
# poll. Reuses the poller's switch lock + harvest; an abandoned login (pane
# closed, never authorized) simply times out and leaves the login home in
# place for the next attempt.

LOGIN_WATCH_INTERVAL_SEC = 2.0
LOGIN_WATCH_TIMEOUT_SEC = 600.0

_login_watches: dict[tuple[str, str], asyncio.Task] = {}


def _login_pane_running(agent_key: str, profile_id: str) -> bool:
    """True while the profile's isolated login pane still runs its CLI.
    Harvesting under a running login CLI is unsafe: the CLI can rotate its
    OAuth token after the snapshot (invalidating the harvested refresh token)
    and loses its config home mid-run. False when the ws layer is unavailable
    (unit tests, early startup)."""
    try:
        from .ws_handlers import _running_login_terminals

        return bool(_running_login_terminals(agent_key, profile_id))
    except Exception:  # noqa: BLE001
        return False


def _active_profile_id(agent_key: str) -> str | None:
    store = _get_profiles_store()
    if store is None:
        return None
    try:
        return store.list()["defaults"].get(agent_key)
    except Exception:  # noqa: BLE001
        return None


async def _harvest_login_home_locked(vault, agent_key: str, profile_id: str) -> bool:
    """Harvest the profile's pending login home under the agent's switch lock.
    Skipped (False) while the profile's login pane CLI is still running. When
    the harvested profile is the ACTIVE account, the slot is immediately
    restored to live — the active row's identity is read from the live state,
    and the next capture() mirrors live into the slot, which would otherwise
    erase the fresh login. Returns True when something was harvested."""
    if _login_pane_running(agent_key, profile_id):
        return False
    async with vault.switch_lock(agent_key):
        harvested = await vault_to_thread(
            vault.harvest_login_home, agent_key, profile_id
        )
        if harvested and _active_profile_id(agent_key) == profile_id:
            await vault_to_thread(vault.restore, agent_key, profile_id)
        return harvested


async def _harvest_pending_login_homes(store, vault) -> list[str]:
    """Harvest every profile's pending isolated login home (skipping profiles
    whose login pane CLI still runs). Best effort — per-profile failures are
    silent. Returns the profile ids that were harvested."""
    try:
        profiles = store.list()["profiles"]
    except Exception:  # noqa: BLE001
        return []
    harvested_ids: list[str] = []
    for profile in profiles:
        agent_key = str(profile.get("agentKey") or "")
        profile_id = str(profile.get("id") or "")
        if not agent_key or not profile_id:
            continue
        try:
            # Cheap pre-check outside the lock: most profiles have no
            # pending login home.
            if not vault.login_home_path(agent_key, profile_id).is_dir():
                continue
            if await _harvest_login_home_locked(vault, agent_key, profile_id):
                harvested_ids.append(profile_id)
        except Exception:  # noqa: BLE001
            pass
    return harvested_ids


async def sweep_pending_login_homes() -> None:
    """One-shot sweep of leftover isolated login homes, independent of the
    usage poller (which also harvests, but only while usage polling is
    enabled). A login that completed right before a backend restart would
    otherwise stay unharvested forever with usage disabled. Called from the
    app startup hook as a background task."""
    store = _get_profiles_store()
    vault = _get_credential_vault()
    if store is None or vault is None:
        return
    harvested_ids = await _harvest_pending_login_homes(store, vault)
    if harvested_ids:
        try:
            from .ws_handlers import _broadcast_profiles_changed

            await _broadcast_profiles_changed(
                "login-harvest", harvested_profile_ids=harvested_ids
            )
        except Exception:  # noqa: BLE001
            pass


def start_login_watch(agent_key: str, profile_id: str) -> None:
    """Begin the harvest watch for one profile's login home (idempotent while
    a watch for the same profile is still running)."""
    key = (agent_key, profile_id)
    task = _login_watches.get(key)
    if task is not None and not task.done():
        return
    task = asyncio.create_task(_login_watch(agent_key, profile_id))
    _login_watches[key] = task
    task.add_done_callback(
        lambda t, key=key: _login_watches.pop(key, None)
        if _login_watches.get(key) is t
        else None
    )


async def _kill_completed_login_panes(agent_key: str, profile_id: str) -> None:
    """Kill the profile's still-running login pane once its sign-in secret
    exists. claude/codex/kimi sign-in commands exit on completion, but grok's
    TUI keeps running after auth and would defer the harvest until the user
    closes the pane. The pane is disposable — kill it through the standard
    terminals kill path; the harvest then proceeds on a later check."""
    try:
        from .ws_handlers import _running_login_terminals

        panes = _running_login_terminals(agent_key, profile_id)
    except Exception:  # noqa: BLE001
        return
    for tid, owner in panes:
        try:
            await owner.terminals.kill(tid, force=True)
        except Exception:  # noqa: BLE001
            pass


async def _login_watch(agent_key: str, profile_id: str) -> None:
    deadline = time.monotonic() + LOGIN_WATCH_TIMEOUT_SEC
    while time.monotonic() < deadline:
        await asyncio.sleep(LOGIN_WATCH_INTERVAL_SEC)
        vault = _get_credential_vault()
        if vault is None:
            continue
        try:
            if not vault.login_home_path(agent_key, profile_id).is_dir():
                return  # harvested elsewhere (usage poll) or profile deleted
            if vault.login_secret_present(agent_key, profile_id):
                await _kill_completed_login_panes(agent_key, profile_id)
            harvested = await _harvest_login_home_locked(vault, agent_key, profile_id)
        except Exception:  # noqa: BLE001 — retry on the next tick
            continue
        if harvested:
            try:
                from .ws_handlers import _broadcast_profiles_changed

                await _broadcast_profiles_changed(
                    "login-harvest", harvested_profile_ids=[profile_id]
                )
            except Exception:  # noqa: BLE001
                pass
            return


class UsageService:
    """Single app-wide poller. ``configure`` is idempotent and multi-window
    safe (last write wins); results are cached and broadcast on change."""

    def __init__(
        self,
        cache_path: Path | None = None,
        active_claude_slot_reader: Callable[[], str | None] | None = None,
    ) -> None:
        self.enabled = False
        self.interval = DEFAULT_INTERVAL
        self.snapshots: dict[str, dict] = {}
        self.account_snapshots: dict[str, dict[str, dict]] = {}
        self._last_good: dict[str, dict[str, dict]] = {}
        self._active_claude_slot = "__default__"
        self._cache_path = cache_path
        self._active_claude_slot_reader = active_claude_slot_reader
        self._blocked_until: dict[object, float] = {}
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._load_cache()
        if self._active_claude_slot_reader is not None:
            try:
                self._active_claude_slot = self._active_claude_slot_reader() or "__default__"
            except Exception:  # noqa: BLE001 — cached data remains usable with the default
                pass

    def payload(self) -> dict:
        for accounts in self.account_snapshots.values():
            for snap in accounts.values():
                if snap.get("stale"):
                    self._refresh_stale_expiry(snap)
        providers = dict(self.snapshots)
        active = self.account_snapshots.get("claude", {}).get(self._active_claude_slot)
        if active is not None:
            providers["claude"] = active
        return {
            "providers": providers,
            "accounts": self.account_snapshots,
            "enabled": self.enabled,
            "intervalSec": self.interval,
        }

    def _load_cache(self) -> None:
        if self._cache_path is None:
            return
        try:
            raw = json.loads(self._cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(raw, dict) or raw.get("schemaVersion") != USAGE_CACHE_SCHEMA_VERSION:
            return
        accounts = raw.get("accounts")
        claude = accounts.get("claude") if isinstance(accounts, dict) else None
        if not isinstance(claude, dict):
            return
        valid: dict[str, dict] = {}
        for slot_id, snap in claude.items():
            if (
                isinstance(slot_id, str)
                and isinstance(snap, dict)
                and snap.get("provider") == "claude"
                and snap.get("status") == "ok"
                and isinstance(snap.get("windows"), list)
                and all(isinstance(window, dict) for window in snap["windows"])
                and isinstance(snap.get("fetchedAt"), str)
            ):
                valid[slot_id] = self._cache_safe_snapshot(snap)
        if valid:
            self._last_good["claude"] = valid
            self.account_snapshots["claude"] = {
                slot_id: self._merge_cached(snap, "not-refreshed", None)
                for slot_id, snap in valid.items()
            }

    @staticmethod
    def _cache_safe_snapshot(snap: dict) -> dict:
        windows = []
        for window in snap.get("windows", []):
            kind = window.get("kind")
            label = window.get("label")
            used = window.get("usedPercent")
            resets = window.get("resetsAt")
            minutes = window.get("windowMinutes")
            if (
                not isinstance(kind, str)
                or not isinstance(label, str)
                or isinstance(used, bool)
                or not isinstance(used, (int, float))
                or (resets is not None and not isinstance(resets, str))
                or (minutes is not None and (
                    isinstance(minutes, bool) or not isinstance(minutes, (int, float))
                ))
            ):
                continue
            safe_window = {
                "kind": kind,
                "label": label,
                "usedPercent": used,
                "resetsAt": resets,
            }
            if "windowMinutes" in window:
                safe_window["windowMinutes"] = minutes
            windows.append(safe_window)
        plan_type = snap.get("planType")
        return {
            "provider": "claude",
            "status": "ok",
            "planType": plan_type if isinstance(plan_type, str) else None,
            "windows": windows,
            "fetchedAt": str(snap.get("fetchedAt") or _now_iso()),
            "error": None,
        }

    def _save_cache(self) -> None:
        if self._cache_path is None:
            return
        doc = {
            "schemaVersion": USAGE_CACHE_SCHEMA_VERSION,
            "accounts": self._last_good,
        }
        path = self._cache_path
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.unlink(missing_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fp:
                    json.dump(doc, fp, indent=2, ensure_ascii=False)
                os.chmod(tmp, 0o600)
                os.replace(tmp, path)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
        except Exception as err:  # noqa: BLE001 — cache failure must not sink polling
            log.warning("usage cache write failed: %s", err)

    @staticmethod
    def _reset_datetime(raw: object) -> datetime | None:
        if not raw:
            return None
        try:
            reset = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            return None
        if reset.tzinfo is None:
            reset = reset.replace(tzinfo=timezone.utc)
        return reset

    @classmethod
    def _window_reset_passed(cls, window: dict) -> bool:
        reset = cls._reset_datetime(window.get("resetsAt"))
        return reset is not None and reset <= datetime.now(timezone.utc)

    def _refresh_stale_expiry(self, snap: dict) -> None:
        expired = False
        for window in snap.get("windows", []):
            window_expired = self._window_reset_passed(window)
            if window_expired:
                window["expired"] = True
                expired = True
            else:
                window.pop("expired", None)
        snap["staleExpired"] = expired

    def _merge_cached(
        self, cached: dict, refresh_status: str, attempted_at: str | None,
        error: str | None = None,
    ) -> dict:
        merged = copy.deepcopy(cached)
        merged.update({
            "stale": True,
            "lastSuccessAt": cached.get("fetchedAt"),
            "refreshStatus": refresh_status,
            "refreshAttemptedAt": attempted_at,
            "error": error,
        })
        self._refresh_stale_expiry(merged)
        return merged

    def _record_parked_claude_slot(self, slot_id: str) -> None:
        """A parked account cannot be measured right now.

        Only the CLI can report a figure and it speaks only for whoever is
        signed in, so a parked slot gets no fresh read. What it last measured
        *for itself* is kept and surfaced as stale rather than discarded:
        dropping it blanked both cards on every account switch — the outgoing
        one here, the incoming one because the same had happened to it while it
        was parked — and a card reading "no data" is indistinguishable from a
        broken one. The figure is the account's own past reading, labelled with
        its age, never presented as current. The cache itself is untouched."""
        cached = self._last_good.get("claude", {}).get(slot_id)
        self.account_snapshots.setdefault("claude", {})[slot_id] = (
            self._merge_cached(cached, "not-measured", None)
            if cached is not None
            else _snapshot("claude", "not-measured")
        )

    def _record_claude_snapshot(self, slot_id: str, fresh: dict) -> bool:
        account = self.account_snapshots.setdefault("claude", {})
        if fresh.get("status") == "ok":
            good = self._cache_safe_snapshot(fresh)
            self._last_good.setdefault("claude", {})[slot_id] = good
            account[slot_id] = {**copy.deepcopy(good), "stale": False,
                                "lastSuccessAt": good["fetchedAt"]}
            return True
        cached = self._last_good.get("claude", {}).get(slot_id)
        if cached is None:
            account[slot_id] = fresh
        else:
            account[slot_id] = self._merge_cached(
                cached,
                str(fresh.get("status") or "error"),
                fresh.get("fetchedAt"),
                fresh.get("error"),
            )
        return False

    async def _claude_credentials_by_slot(self) -> tuple[str, dict[str, dict | None]] | None:
        store = _get_profiles_store()
        vault = _get_credential_vault()
        resolver = getattr(vault, "resolve_claude_credentials", None) if vault else None
        if store is None or not callable(resolver):
            return None
        doc = await asyncio.to_thread(store.list)
        active = str(doc["defaults"].get("claude") or "__default__")
        slot_ids = ["__default__"] + [
            str(profile["id"])
            for profile in doc["profiles"]
            if profile.get("agentKey") == "claude" and profile.get("id")
        ]

        def _read_all() -> dict[str, dict | None]:
            return {
                slot_id: parse_claude_credentials(
                    resolver(slot_id, active=slot_id == active).secret
                )
                for slot_id in slot_ids
            }

        credentials = await asyncio.to_thread(_read_all)
        credentials = await self._delegate_active_claude_refresh(
            vault, active, credentials, _read_all
        )
        allowed = set(slot_ids)
        removed = False
        for mapping in (
            self._last_good.get("claude", {}),
            self.account_snapshots.get("claude", {}),
        ):
            for slot_id in set(mapping) - allowed:
                mapping.pop(slot_id, None)
                removed = True
        if removed:
            await asyncio.to_thread(self._save_cache)
        return active, credentials

    async def _delegate_active_claude_refresh(
        self, vault, active: str, credentials: dict[str, dict | None], read_all
    ) -> dict[str, dict | None]:
        """When the ACTIVE account's token has expired, ask the CLI to renew it
        and re-read. Nothing is minted here — see ``claude_delegated_refresh``.

        Only the active account can be renewed this way: the CLI probe touches
        whatever credential is live. A parked slot stays expired until a switch
        brings it live, where the CLI takes over. Best effort — a poll on an
        expired token still reports the account as expired, which is the
        behaviour without this step."""
        oauth = credentials.get(active)
        if oauth is None or not claude_token_expired(oauth):
            return credentials
        if not hasattr(vault, "read_live"):
            return credentials
        from .claude_delegated_refresh import OUTCOME_REFRESHED, attempt

        try:
            outcome = await attempt(vault)
        except Exception as err:  # noqa: BLE001 — must not sink the poll
            log.warning("claude delegated refresh errored: %s", err)
            return credentials
        if outcome != OUTCOME_REFRESHED:
            return credentials
        return await asyncio.to_thread(read_all)

    def configure(self, enabled: bool, interval_sec: float | None) -> None:
        self.enabled = bool(enabled)
        if interval_sec is not None:
            try:
                self.interval = max(MIN_INTERVAL, float(interval_sec))
            except (TypeError, ValueError):
                pass
        if self.enabled and (self._task is None or self._task.done()):
            self._task = asyncio.create_task(self._run())
        self._wake.set()

    def request_refresh(self) -> None:
        self._blocked_until.clear()
        self._wake.set()

    async def _harvest_active_slots(self) -> None:
        """Opportunistic harvest: (a) when an agent's ACTIVE account slot is
        still empty but live credentials exist (the user just logged in inside
        a pane), copy them into the slot so a later switch can bring the
        account back; (b) when a profile has a pending isolated login home (a
        login pane completed its sign-in there), capture it into the profile's
        slot and clear the home. Best effort — failures are silent."""
        store = _get_profiles_store()
        vault = _get_credential_vault()
        if store is None or vault is None:
            return
        try:
            defaults = store.list()["defaults"]
        except Exception:  # noqa: BLE001
            return
        harvested = False
        for agent_key, profile_id in defaults.items():
            if not profile_id:
                continue
            try:
                # Same lock as the switch handler: a harvest must not interleave
                # with a live credential swap for this agent.
                async with vault.switch_lock(agent_key):
                    harvested = await vault_to_thread(vault.harvest, agent_key, profile_id) or harvested
            except Exception:  # noqa: BLE001
                pass
        login_harvested_ids = await _harvest_pending_login_homes(store, vault)
        if harvested or login_harvested_ids:
            # A pane login just landed in a slot — let the accounts UI pick up
            # the new identity.
            try:
                from .ws_handlers import _broadcast_profiles_changed

                await _broadcast_profiles_changed(
                    "login-harvest" if login_harvested_ids else "harvest",
                    harvested_profile_ids=login_harvested_ids or None,
                )
            except Exception:  # noqa: BLE001
                pass

    async def poll_once(self, home: Path | None = None) -> dict:
        home = home or Path.home()
        codex_home = Path(os.environ["CODEX_HOME"]) if os.environ.get("CODEX_HOME") \
            else home / ".codex"
        # Non-Claude providers retain their real-home reads. Claude resolves
        # every account independently without switching the active profile.
        await self._harvest_active_slots()
        now = time.monotonic()
        claude_accounts = await self._claude_credentials_by_slot()
        cache_changed = False
        # Claude quota comes from the CLI's own `/usage` panel — Claude Code
        # asks under its own identity and this reads what it printed. Only the
        # signed-in account can be reported that way, so a parked account shows
        # its own last reading marked stale, never a figure passed off as live.
        parked_slots: list[str] = []
        if claude_accounts is None:
            claude_active = "__default__"
        else:
            claude_active, credentials = claude_accounts
            parked_slots = [s for s in credentials if s != claude_active]
        claude_coros = {claude_active: lambda: fetch_claude(home)}
        for slot_id in parked_slots:
            self._record_parked_claude_slot(slot_id)
        self._active_claude_slot = claude_active
        claude_tasks: dict[str, asyncio.Task] = {}
        for slot_id, coro in claude_coros.items():
            key = ("claude", slot_id)
            if self._blocked_until.get(key, 0) <= now:
                claude_tasks[slot_id] = asyncio.create_task(coro())

        # One-file-per-vendor bridge: a migrated vendor's fetch lives in its
        # spec and its legacy lambda below is deleted in that vendor's round.
        # Iteration runs over PROVIDERS (not the legacy table) so deleting a
        # lambda cannot silently drop the vendor from the poll.
        legacy_fetchers: dict[str, Any] = {
            "codex": lambda: fetch_codex(codex_home),
            "kimi": lambda: fetch_kimi(home),
                                                                }
        tasks: dict[str, Any] = {}
        for provider in PROVIDERS:
            if provider == "claude":  # claude polls per-slot above
                continue
            if self._blocked_until.get(provider, 0) > now:
                continue
            spec = _cli_vendor(provider)
            if spec is not None and spec.fetch_usage is not None:
                fetch = spec.fetch_usage
                tasks[provider] = asyncio.create_task(fetch(home))
            elif provider in legacy_fetchers:
                tasks[provider] = asyncio.create_task(legacy_fetchers[provider]())
        for slot_id, task in claude_tasks.items():
            try:
                snap = await task
            except Exception as err:  # noqa: BLE001 — one account must not sink the rest
                log.warning("usage poll failed for claude account %s: %s", slot_id, err)
                snap = _snapshot("claude", "error", error=str(err))
            retry_after = snap.pop("retryAfterSec", None)
            costly = snap.pop("costlyRead", False)
            cooldown = retry_after if snap["status"] == "rate-limited" else \
                (RATE_LIMIT_COOLDOWN if snap["status"] == "unavailable" else None)
            if snap["status"] == "ok" or costly:
                # Reading the panel starts a whole Claude Code (seconds, plus
                # the user's MCP servers), so it must not ride the poll
                # interval — and a read that spawned but produced nothing cost
                # the same as one that succeeded, so it waits the same.
                # `request_refresh` clears this, which is what makes the
                # badge's own refresh button feel immediate.
                cooldown = CLAUDE_CLI_READ_INTERVAL
            if cooldown:
                self._blocked_until[("claude", slot_id)] = time.monotonic() + cooldown
            cache_changed = self._record_claude_snapshot(slot_id, snap) or cache_changed
        for provider, task in tasks.items():
            try:
                snap = await task
            except Exception as err:  # noqa: BLE001 — one provider must not sink the rest
                log.warning("usage poll failed for %s: %s", provider, err)
                snap = _snapshot(provider, "error", error=str(err))
            retry_after = snap.pop("retryAfterSec", None)
            cooldown = retry_after if snap["status"] == "rate-limited" else \
                (RATE_LIMIT_COOLDOWN if snap["status"] == "unavailable" else None)
            if cooldown:
                self._blocked_until[provider] = time.monotonic() + cooldown
            self.snapshots[provider] = snap
        if cache_changed:
            await asyncio.to_thread(self._save_cache)
        return self.payload()

    def _next_sleep(self) -> float:
        """Regular interval, shortened to land just after the nearest window
        reset (CodexBar's reset-boundary refresh)."""
        sleep = self.interval
        now = datetime.now(timezone.utc)
        snapshots = list(self.snapshots.values()) + [
            snap
            for accounts in self.account_snapshots.values()
            for snap in accounts.values()
        ]
        for snap in snapshots:
            for win in snap.get("windows", []):
                resets = self._reset_datetime(win.get("resetsAt"))
                if resets is None:
                    continue
                delta = (resets - now).total_seconds() + RESET_BOUNDARY_GRACE
                if 5.0 < delta < sleep:
                    sleep = delta
        return max(5.0, sleep)

    async def _run(self) -> None:
        from . import app
        from .ipc import make_event

        while self.enabled:
            # Consume the wake that led to this poll. A refresh requested while
            # the poll is running remains set and triggers the next iteration.
            self._wake.clear()
            try:
                payload = await self.poll_once()
                await app.broadcast(make_event("usage.changed", payload))
            except Exception as err:  # noqa: BLE001 — poller must survive anything
                log.warning("usage poll cycle failed: %s", err)
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self._next_sleep())
            except asyncio.TimeoutError:
                pass


service = UsageService(
    cache_path=app_data_dir() / USAGE_CACHE_FILE,
    active_claude_slot_reader=lambda: _active_profile_id("claude"),
)
