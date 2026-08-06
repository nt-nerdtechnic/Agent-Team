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
from .credential_vault import vault_to_thread

log = logging.getLogger(__name__)

PROVIDERS = ("claude", "codex", "kimi", "grok", "antigravity", "opencode", "qwen",
             "kilo", "pi", "copilot", "cursor")

CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
# How long a `/usage` panel reading stands before the CLI is asked again. The
# read costs a full Claude Code start, so it deliberately does not follow the
# poll interval; the badge's refresh button clears it via `request_refresh`.
CLAUDE_CLI_READ_INTERVAL = 900.0
CLAUDE_BETA_HEADER = "oauth-2025-04-20"
CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"
# Claude OAuth tokens are never minted here. Anthropic rotates refresh tokens,
# so every exchange invalidates the previous one: whenever this app refreshed a
# credential the CLI also owns, one of the two ended up holding a dead token and
# the account had to be signed in again. The CLI is the only refresher — a
# parked slot's access token is simply allowed to expire, and Claude Code
# renews it from the restored refresh token the first time it runs.
CODEX_DEFAULT_BASE = "https://chatgpt.com/backend-api"
KIMI_DEFAULT_BASE = "https://api.kimi.com"
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
OPENCODE_AUTH_FILE_REL = (".local", "share", "opencode", "auth.json")
OPENCODE_MINIMAX_USAGE_URL = "https://api.minimax.io/v1/token_plan/remains"
# qwen (Alibaba ModelStudio Coding Plan). The quota endpoint is the console
# gateway API — undocumented, and previously requested behind a full browser
# User-Agent. The costume is gone: the request now says ``Navide`` and carries
# the API key the user configured, which is what the gateway actually
# authenticates. Origin/Referer stay because the gateway rejects cross-site
# posts without them; they name the console the API belongs to, not a client we
# are pretending to be. The alternate region is retried on failure.
_QWEN_USAGE_QUERY = (
    "?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2"
    "&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2"
)
QWEN_INTL_USAGE_URL = (
    "https://modelstudio.console.alibabacloud.com/data/api.json"
    + _QWEN_USAGE_QUERY + "&currentRegionId=ap-southeast-1"
)
QWEN_CN_USAGE_URL = (
    "https://bailian.console.aliyun.com/data/api.json"
    + _QWEN_USAGE_QUERY + "&currentRegionId=cn-beijing"
)
# (url, commodityCode, Origin, Referer) per region, tried in order.
QWEN_REGIONS = (
    (QWEN_INTL_USAGE_URL, "sfm_codingplan_public_intl",
     "https://modelstudio.console.alibabacloud.com",
     "https://modelstudio.console.alibabacloud.com/ap-southeast-1/"
     "?tab=coding-plan#/efm/coding_plan"),
    (QWEN_CN_USAGE_URL, "sfm_codingplan_public_cn",
     "https://bailian.console.aliyun.com",
     "https://bailian.console.aliyun.com/"),
)
# The env key qwen-code itself resolves, then CodexBar's accepted aliases.
QWEN_ENV_KEYS = (
    "BAILIAN_CODING_PLAN_API_KEY",
    "ALIBABA_CODING_PLAN_API_KEY",
    "ALIBABA_QWEN_API_KEY",
    "DASHSCOPE_API_KEY",
)
# kilo (Kilo CLI, @kilocode/cli). auth.json is a map keyed by provider id; the
# "kilo" entry holds either an api key or a long-lived oauth access token that
# IS the Kilo bearer token (1-year expiry, no refresh rotation needed for
# reads). The Kilo Pass query string is tRPC batch syntax for input {"0":null}.
KILO_DEFAULT_BASE = "https://api.kilo.ai"
KILO_AUTH_FILE_REL = (".local", "share", "kilo", "auth.json")
KILO_LEGACY_CONFIG_REL = (".kilocode", "cli", "config.json")
KILO_BALANCE_PATH = "/api/profile/balance"
KILO_PASS_PATH = "/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D"
# pi (Pi coding agent, @mariozechner/pi-coding-agent). auth.json is keyed by
# provider id; oauth entries are {type: "oauth", access, refresh, expires
# (epoch ms)}, BYOK keys are {type: "api_key", key}. Credentials are read-only
# here and never refreshed (pi rotates its own refresh tokens): an expired
# oauth entry maps to status=expired.
PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR"
PI_OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"
# copilot (GitHub Copilot CLI). ``~/.copilot/config.json`` is metadata only —
# the CLI keeps its OAuth token in the macOS Keychain (never probed here), so
# the token is resolved read-only via ``gh auth token -u <login>`` (gh shares
# the same gho_ GitHub OAuth scope; verified to print without rotating
# anything), then the VS Code/JetBrains-style ~/.config/github-copilot files,
# then GH_TOKEN/GITHUB_TOKEN env. ``copilot_internal/user`` is the surface
# CodexBar and the JetBrains quota monitor use; the Copilot-client headers
# are required for it to answer.
COPILOT_CONFIG_FILE_REL = (".copilot", "config.json")
COPILOT_HOSTS_FILES_REL = (
    (".config", "github-copilot", "apps.json"),
    (".config", "github-copilot", "hosts.json"),
)
COPILOT_DEFAULT_HOST = "github.com"
COPILOT_ENV_KEYS = ("GH_TOKEN", "GITHUB_TOKEN")
# The Editor-Version/User-Agent set this once sent identified the app as the
# VS Code Copilot Chat extension. Measured 2026-08-05: the endpoint answers the
# same without any of it, so the read stays and the costume does not.
COPILOT_GH_TOKEN_TIMEOUT = 5.0
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
GROK_INIT_TIMEOUT = 4.0
GROK_BILLING_TIMEOUT = 3.0
HTTP_TIMEOUT = 30.0
RATE_LIMIT_COOLDOWN = 300.0
RESET_BOUNDARY_GRACE = 30.0
DEFAULT_INTERVAL = 300.0
MIN_INTERVAL = 60.0
USAGE_CACHE_FILE = "usage-cache.json"
USAGE_CACHE_SCHEMA_VERSION = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _epoch_to_iso(sec: Any) -> str | None:
    try:
        return datetime.fromtimestamp(float(sec), timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _num(v: Any) -> float | None:
    """Kimi returns numbers as int, float or string interchangeably."""
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _clamp_pct(v: float) -> float:
    return max(0.0, min(100.0, v))


_UNSET = object()


def _window(kind: str, label: str, used_percent: float, resets_at: str | None,
            window_minutes: Any = _UNSET) -> dict:
    w = {
        "kind": kind,
        "label": label,
        "usedPercent": round(_clamp_pct(used_percent), 1),
        "resetsAt": resets_at,
    }
    if window_minutes is not _UNSET:
        w["windowMinutes"] = window_minutes
    return w


def _snapshot(provider: str, status: str, *, windows: list[dict] | None = None,
              plan_type: str | None = None, error: str | None = None) -> dict:
    return {
        "provider": provider,
        "status": status,
        "planType": plan_type,
        "windows": windows or [],
        "fetchedAt": _now_iso(),
        "error": error,
    }


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


def claude_token_expired(oauth: dict, now_ms: float | None = None) -> bool:
    expires = _num(oauth.get("expiresAt"))
    if expires is None:
        return False
    now = time.time() * 1000 if now_ms is None else now_ms
    return now >= expires


# A failed Keychain read (denied prompt, timeout) is remembered so we don't
# re-prompt every poll — but only for a cooldown window, so a transient failure
# (e.g. a slow security call during an account switch) self-heals without an app
# restart. monotonic timestamp; None means no active cooldown.
_KEYCHAIN_COOLDOWN_S = 300.0
_keychain_failed_at: float | None = None


async def _communicate_or_kill(proc: Any, timeout: float) -> bytes:
    """``proc.communicate()`` under a deadline; on timeout the child is killed
    and reaped before the TimeoutError propagates. A bare ``wait_for`` leaves
    a hung ``security``/``gh``/CLI child running (and unreaped) forever."""
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass
        try:
            await proc.wait()
        except (ProcessLookupError, OSError):
            pass
        raise
    return out


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


def codex_usage_url(base: str) -> str:
    path = "/wham/usage" if "/backend-api" in base else "/api/codex/usage"
    return base + path


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


def read_grok_credentials(home: Path, env: dict | None = None) -> dict | None:
    """``auth.json`` is a map keyed by scope URL. Prefer the OIDC entry
    (``https://auth.x.ai::`` prefix, SuperGrok), fall back to a legacy
    ``/sign-in`` scope. Returns {key, email, expires_at} or None."""
    env = env or {}
    grok_home = Path(env["GROK_HOME"]) if env.get("GROK_HOME") else home / ".grok"
    try:
        data = json.loads((grok_home / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    oidc, legacy = None, None
    for scope, entry in data.items():
        if not isinstance(entry, dict) or not entry.get("key"):
            continue
        if str(scope).startswith("https://auth.x.ai::"):
            oidc = oidc or entry
        elif "/sign-in" in str(scope):
            legacy = legacy or entry
    entry = oidc or legacy
    if entry is None:
        return None
    return {"key": entry["key"], "email": entry.get("email"),
            "expires_at": entry.get("expires_at")}


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


def read_opencode_credentials(home: Path) -> dict | None:
    """Parse ``~/.local/share/opencode/auth.json``: a map of providerID ->
    credential entry ({type: "api", key} or {type: "oauth", access, refresh,
    expires}). Returns the dict-valued entries, or None when the file is
    absent/malformed/empty."""
    path = home.joinpath(*OPENCODE_AUTH_FILE_REL)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    entries = {k: v for k, v in data.items() if isinstance(v, dict)}
    return entries or None


def opencode_minimax_key(auth: dict) -> str | None:
    """The MiniMax coding-plan API key from an opencode auth map, or None."""
    entry = auth.get("minimax-coding-plan")
    if not isinstance(entry, dict) or entry.get("type") != "api":
        return None
    key = entry.get("key")
    return key if isinstance(key, str) and key else None


def opencode_anthropic_oauth(auth: dict) -> dict | None:
    """Map an ``anthropic`` {type: "oauth"} entry to the claudeAiOauth shape
    (accessToken + epoch-ms expiresAt) so the existing Claude usage flow can
    be reused as-is."""
    entry = auth.get("anthropic")
    if not isinstance(entry, dict) or entry.get("type") != "oauth":
        return None
    access = entry.get("access")
    if not isinstance(access, str) or not access:
        return None
    return {"accessToken": access, "expiresAt": entry.get("expires")}


def _qwen_env_lookup(mapping: dict) -> str | None:
    for key in QWEN_ENV_KEYS:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _parse_dotenv(text: str) -> dict:
    """Minimal ``KEY=VALUE`` .env parse (comments/blank lines skipped,
    ``export`` prefix and surrounding quotes stripped) — enough for the .env
    files qwen-code resolves its API key from."""
    result: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        result[key] = value.strip().strip("'\"")
    return result


def read_qwen_credentials(home: Path, env: dict | None = None) -> str | None:
    """The Alibaba ModelStudio Coding Plan API key, resolved the way qwen-code
    does (read-only): process env first, then ``~/.qwen/.env``, then the
    ``env`` object in ``~/.qwen/settings.json``."""
    key = _qwen_env_lookup(env or {})
    if key is not None:
        return key
    qwen_home = home / ".qwen"
    try:
        key = _qwen_env_lookup(
            _parse_dotenv((qwen_home / ".env").read_text(encoding="utf-8")))
    except OSError:
        key = None
    if key is not None:
        return key
    try:
        settings = json.loads(
            (qwen_home / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    env_obj = settings.get("env") if isinstance(settings, dict) else None
    return _qwen_env_lookup(env_obj) if isinstance(env_obj, dict) else None


def qwen_legacy_oauth_present(home: Path) -> bool:
    """True when the defunct Qwen OAuth credential file exists. The free tier
    it belonged to was discontinued and no quota endpoint accepts the token,
    so it maps to status=unavailable rather than inventing client-side counts."""
    return (home / ".qwen" / "oauth_creds.json").is_file()


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


def read_pi_credentials(home: Path, env: dict | None = None) -> dict | None:
    """Parse pi's ``auth.json`` (under ``$PI_CODING_AGENT_DIR``, default
    ``~/.pi/agent`` — mirroring the pi log reader's root resolution): a map of
    provider id -> credential entry. Returns the dict-valued entries, or None
    when the file is absent/malformed/empty."""
    env = env or {}
    root = Path(env[PI_AGENT_DIR_ENV]) if env.get(PI_AGENT_DIR_ENV) \
        else home / ".pi" / "agent"
    try:
        data = json.loads((root / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    entries = {k: v for k, v in data.items() if isinstance(v, dict)}
    return entries or None


def pi_oauth_expired(entry: dict, now_ms: float | None = None) -> bool:
    """True when an oauth entry's ``expires`` (epoch ms) has passed. Tokens
    are never refreshed here — pi serializes its own refresh flow and Anthropic
    rotates refresh tokens, so refreshing would invalidate the CLI's copy."""
    expires = _num(entry.get("expires"))
    if expires is None:
        return False
    now = time.time() * 1000 if now_ms is None else now_ms
    return now >= expires


def pi_anthropic_oauth(auth: dict) -> dict | None:
    """Map an ``anthropic`` {type: "oauth"} entry to the claudeAiOauth shape
    (accessToken + epoch-ms expiresAt) so the existing Claude usage flow can
    be reused as-is — pi's Anthropic OAuth uses Claude Code's client id, so
    the stored token works against the same oauth/usage endpoint."""
    entry = auth.get("anthropic")
    if not isinstance(entry, dict) or entry.get("type") != "oauth":
        return None
    access = entry.get("access")
    if not isinstance(access, str) or not access:
        return None
    return {"accessToken": access, "expiresAt": entry.get("expires")}


def pi_codex_oauth(auth: dict) -> dict | None:
    """The ``openai-codex`` {type: "oauth"} entry -> {access_token, account_id,
    expires} for the ChatGPT ``wham/usage`` flow. api_key entries are BYOK and
    have no usage surface -> None."""
    entry = auth.get("openai-codex")
    if not isinstance(entry, dict) or entry.get("type") != "oauth":
        return None
    access = entry.get("access")
    if not isinstance(access, str) or not access:
        return None
    account = entry.get("accountId") or entry.get("account_id")
    return {"access_token": access,
            "account_id": account if isinstance(account, str) and account else None,
            "expires": entry.get("expires")}


def pi_openrouter_key(auth: dict) -> str | None:
    """The ``openrouter`` bearer credential: the oauth access token (the PKCE
    exchange yields a long-lived key) or a plain api key — both are accepted
    by ``GET /api/v1/key``."""
    entry = auth.get("openrouter")
    if not isinstance(entry, dict):
        return None
    if entry.get("type") == "oauth":
        access = entry.get("access")
        return access if isinstance(access, str) and access else None
    if entry.get("type") == "api_key":
        key = entry.get("key")
        return key if isinstance(key, str) and key else None
    return None


def read_copilot_config(home: Path) -> dict | None:
    """Parse ``~/.copilot/config.json`` (JSONC: ``//`` comment lines before the
    JSON body). Returns {host, login} for ``lastLoggedInUser`` (host reduced to
    a bare hostname, default github.com), or None when absent/malformed/logged
    out. The file is metadata only — the CLI's token lives in the Keychain."""
    path = home.joinpath(*COPILOT_CONFIG_FILE_REL)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    body = "\n".join(line for line in text.splitlines()
                     if not line.lstrip().startswith("//"))
    try:
        data = json.loads(body)
    except ValueError:
        return None
    user = data.get("lastLoggedInUser") if isinstance(data, dict) else None
    if not isinstance(user, dict):
        return None
    login = user.get("login")
    if not isinstance(login, str) or not login:
        return None
    hostname = COPILOT_DEFAULT_HOST
    host = user.get("host")
    if isinstance(host, str) and host.strip():
        stripped = host.strip().split("://", 1)[-1].split("/", 1)[0]
        hostname = stripped or COPILOT_DEFAULT_HOST
    return {"host": hostname, "login": login}


def read_copilot_hosts_token(home: Path, host: str = COPILOT_DEFAULT_HOST) -> str | None:
    """The VS Code/JetBrains-style Copilot credential fallback:
    ``~/.config/github-copilot/apps.json`` then ``hosts.json``, each a map of
    host key (bare, or suffixed like ``github.com:Iv1.xxx``) -> {oauth_token}.
    Returns the first matching host's token, or None."""
    for rel in COPILOT_HOSTS_FILES_REL:
        try:
            data = json.loads(home.joinpath(*rel).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        for key, entry in data.items():
            if not isinstance(entry, dict) or host not in str(key):
                continue
            token = entry.get("oauth_token")
            if isinstance(token, str) and token:
                return token
    return None


def copilot_env_token(env: dict) -> str | None:
    for key in COPILOT_ENV_KEYS:
        value = env.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def copilot_usage_url(host: str) -> str:
    """github.com -> api.github.com; enterprise hosts use ``api.<host>`` the
    same way (CodexBar's Copilot host mapping)."""
    return f"https://api.{host}/copilot_internal/user"


async def _copilot_gh_token(login: str, host: str) -> str | None:
    """``gh auth token -u <login>`` — gh keeps GitHub OAuth tokens in the
    Keychain and prints them read-only without prompting or rotating anything
    (verified live). None when gh is missing, fails or prints nothing; gh's
    active account may differ from Copilot's, hence the explicit ``--user``."""
    binary = shutil.which("gh")
    if not binary:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "auth", "token", "--user", login, "--hostname", host,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out = await _communicate_or_kill(proc, timeout=COPILOT_GH_TOKEN_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        return None
    if proc.returncode != 0:
        return None
    token = out.decode("utf-8", "replace").strip()
    return token or None


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
    import sqlite3

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
            out = await _communicate_or_kill(proc, timeout=2.0)
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


# ── Response normalizers (pure) ─────────────────────────────────────────────

_CLAUDE_NAMED_WINDOWS = (
    ("five_hour", "session", "Session (5h)"),
    ("seven_day", "weekly", "Weekly (all models)"),
    ("seven_day_opus", "weekly-model", "Weekly (Opus)"),
    ("seven_day_sonnet", "weekly-model", "Weekly (Sonnet)"),
)


def normalize_claude(data: dict) -> tuple[list[dict], str | None]:
    windows: list[dict] = []
    for key, kind, label in _CLAUDE_NAMED_WINDOWS:
        entry = data.get(key)
        if not isinstance(entry, dict):
            continue
        pct = _num(entry.get("utilization"))
        if pct is None:
            continue
        windows.append(_window(kind, label, pct, entry.get("resets_at")))
    # Mirrors CodexBar's ClaudeScopedWeeklyLimitMapper: drop the "all models"
    # aggregate row and de-duplicate by model slug.
    seen_models: set[str] = set()
    for entry in data.get("limits") or []:
        if not isinstance(entry, dict):
            continue
        # is_active is deliberately NOT a filter — enforceable scoped limits
        # report False in practice (CodexBar finding).
        if entry.get("kind") != "weekly_scoped" or entry.get("group") != "weekly":
            continue
        pct = _num(entry.get("percent"))
        scope_model = ((entry.get("scope") or {}).get("model")) or {}
        model = scope_model.get("display_name")
        model_id = scope_model.get("id")
        if pct is None or not model:
            continue
        slug = (model_id or model).strip().lower()
        if slug in ("all models", "all-models") or slug.endswith("-all-models"):
            continue
        if slug in seen_models:
            continue
        seen_models.add(slug)
        # Null-id "promotional" buckets (e.g. Fable) are surfaced as-is like any
        # other per-model window: the quota is real, so never hide or relabel it.
        windows.append(_window("weekly-model", f"{model} only", pct, entry.get("resets_at")))
    plan = None
    return windows, plan


# Codex classifies a rate window by its ``limit_window_seconds`` (mirrors
# CodexBar's CodexRateWindowNormalizer), not by position — the API does not
# guarantee primary=Session / secondary=Weekly ordering.
_CODEX_WINDOW_ROLES = {
    300: ("session", "Session (5h)"),
    10080: ("weekly", "Weekly"),
}
# Positional fallback for entries whose window length can't classify them.
_CODEX_POSITIONAL = (
    ("primary_window", ("session", "Session (5h)")),
    ("secondary_window", ("weekly", "Weekly")),
)


def _codex_window_minutes(entry: dict) -> int | None:
    secs = _num(entry.get("limit_window_seconds"))
    return int(secs // 60) if secs is not None else None


def _codex_window_role(entry: dict) -> tuple[str, str] | None:
    minutes = _codex_window_minutes(entry)
    if minutes is None:
        return None
    return _CODEX_WINDOW_ROLES.get(minutes)


def _resolve_codex_roles(rate: dict) -> list[tuple[dict, tuple[str, str]]]:
    """Assign (kind, label) to each present window. Prefer classification by
    window length; fall back to position only when length can't decide or
    would collide, so two windows never share a role."""
    present: list[tuple[int, dict, tuple[str, str]]] = []
    for index, (key, pos_role) in enumerate(_CODEX_POSITIONAL):
        entry = rate.get(key)
        if isinstance(entry, dict):
            present.append((index, entry, pos_role))

    resolved: dict[int, tuple[dict, tuple[str, str]]] = {}
    taken: set[str] = set()
    pending: list[tuple[int, dict, tuple[str, str]]] = []
    for index, entry, pos_role in present:
        role = _codex_window_role(entry)
        if role is not None and role[0] not in taken:
            taken.add(role[0])
            resolved[index] = (entry, role)
        else:
            pending.append((index, entry, pos_role))

    all_roles = [pos_role for _, pos_role in _CODEX_POSITIONAL]
    for index, entry, pos_role in pending:
        if pos_role[0] not in taken:
            role = pos_role
        else:
            remaining = [r for r in all_roles if r[0] not in taken]
            role = remaining[0] if remaining else pos_role
        taken.add(role[0])
        resolved[index] = (entry, role)
    return [resolved[i] for i in sorted(resolved)]


def _codex_windows(rate: dict) -> list[dict]:
    windows: list[dict] = []
    for entry, (kind, label) in _resolve_codex_roles(rate):
        pct = _num(entry.get("used_percent"))
        if pct is None:
            continue
        windows.append(_window(kind, label, pct,
                               _epoch_to_iso(entry.get("reset_at")),
                               window_minutes=_codex_window_minutes(entry)))
    return windows


def _codex_credits(data: dict) -> dict | None:
    credits = data.get("credits")
    if not isinstance(credits, dict):
        return None
    balance = credits.get("balance")
    parsed = _num(balance)
    return {
        "hasCredits": bool(credits.get("has_credits")),
        "unlimited": bool(credits.get("unlimited")),
        "balance": parsed if parsed is not None else balance,
    }


def _codex_extra_windows(data: dict) -> list[dict]:
    extra: list[dict] = []
    for item in data.get("additional_rate_limits") or []:
        if not isinstance(item, dict):
            continue
        rate = item.get("rate_limit")
        if not isinstance(rate, dict):
            continue
        windows = _codex_windows(rate)
        if windows:
            extra.append({"name": item.get("limit_name"), "windows": windows})
    return extra


def normalize_codex(data: dict) -> tuple[list[dict], str | None]:
    windows = _codex_windows(data.get("rate_limit") or {})
    plan = data.get("plan_type") if isinstance(data.get("plan_type"), str) else None
    return windows, plan


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


def normalize_grok(billing: dict) -> tuple[list[dict], str | None]:
    """``x.ai/billing`` result: cent amounts wrapped as ``{"val": n}``."""
    def val(node: Any) -> float | None:
        if isinstance(node, dict):
            return _num(node.get("val"))
        return _num(node)

    windows: list[dict] = []
    limit = val((billing or {}).get("monthlyLimit"))
    used = val(((billing or {}).get("usage") or {}).get("totalUsed"))
    cycle = (billing or {}).get("billingCycle") or {}
    resets = cycle.get("billingPeriodEnd")
    if limit and used is not None:
        windows.append(_window("monthly", "Monthly credits", used / limit * 100,
                               resets if isinstance(resets, str) else None))
    return windows, None


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


def normalize_opencode_minimax(data: dict) -> list[dict]:
    """MiniMax ``token_plan/remains``: ``model_remains[]`` per model; the
    coding plan is the ``model_name == "general"`` entry. Percents are
    remaining -> used; epoch-ms end times -> ISO resetsAt."""
    for entry in data.get("model_remains") or []:
        if not isinstance(entry, dict) or entry.get("model_name") != "general":
            continue
        windows: list[dict] = []
        interval = _num(entry.get("current_interval_remaining_percent"))
        if interval is not None:
            end = _num(entry.get("end_time"))
            windows.append(_window(
                "session", "MiniMax (5h)", 100.0 - interval,
                _epoch_to_iso(end / 1000) if end is not None else None))
        weekly = _num(entry.get("current_weekly_remaining_percent"))
        if weekly is not None:
            end = _num(entry.get("weekly_end_time"))
            windows.append(_window(
                "weekly", "MiniMax weekly", 100.0 - weekly,
                _epoch_to_iso(end / 1000) if end is not None else None))
        return windows
    return []


_QWEN_WINDOWS = (
    ("per5Hour", "session", "Session (5h)"),
    ("perWeek", "weekly", "Weekly"),
    ("perBillMonth", "monthly", "Monthly"),
)


def _qwen_reset_iso(raw: Any) -> str | None:
    """``*QuotaNextRefreshTime`` arrives as epoch ms, epoch s, ISO8601 or
    ``yyyy-MM-dd HH:mm[:ss]`` depending on gateway version."""
    num = _num(raw)
    if num is not None:
        return _epoch_to_iso(num / 1000 if num > 1e11 else num)
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def _qwen_instance_infos(data: Any, depth: int = 0) -> list | None:
    """Deep-search the console-gateway envelope for
    ``codingPlanInstanceInfos`` — the data/statusCode wrapping shifts between
    gateway versions, so CodexBar searches by key and so do we."""
    if depth > 6 or not isinstance(data, dict):
        return None
    infos = data.get("codingPlanInstanceInfos")
    if isinstance(infos, list):
        return infos
    for value in data.values():
        found = _qwen_instance_infos(value, depth + 1)
        if found is not None:
            return found
    return None


def normalize_qwen(data: dict) -> tuple[list[dict], str | None]:
    """First usable ``codingPlanInstanceInfos[]`` entry: per5Hour/perWeek/
    perBillMonth Used/Total quota pairs -> session/weekly/monthly windows;
    planName (falling back to instanceName/packageName) -> planType."""
    for info in _qwen_instance_infos(data) or []:
        if not isinstance(info, dict):
            continue
        windows: list[dict] = []
        for prefix, kind, label in _QWEN_WINDOWS:
            total = _num(info.get(f"{prefix}TotalQuota"))
            used = _num(info.get(f"{prefix}UsedQuota"))
            if not total or used is None:
                continue
            windows.append(_window(
                kind, label, used / total * 100,
                _qwen_reset_iso(info.get(f"{prefix}QuotaNextRefreshTime"))))
        if not windows:
            continue
        plan = next(
            (info[k] for k in ("planName", "instanceName", "packageName")
             if isinstance(info.get(k), str) and info[k]), None)
        return windows, plan
    return [], None


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


def normalize_pi_openrouter(data: dict) -> list[dict]:
    """OpenRouter ``GET /api/v1/key``: ``{"data": {"usage": <credits used>,
    "limit": <credit limit|null>}}`` — dollar/credit based, no reset window.
    With a limit the used/limit ratio is real; a null limit (unlimited key)
    pins usedPercent to 0 and the raw fields are surfaced as-is."""
    entry = data.get("data")
    if not isinstance(entry, dict):
        return []
    used = _num(entry.get("usage"))
    if used is None:
        return []
    limit = _num(entry.get("limit"))
    window = _window("credits", "OpenRouter credits",
                     used / limit * 100 if limit else 0.0, None)
    window["usage"] = used
    window["limit"] = limit
    return [window]


_COPILOT_QUOTA_KEYS = (
    ("chat", "Chat"),
    ("completions", "Completions"),
    ("premium_interactions", "Premium requests"),
)


def normalize_copilot(data: dict) -> tuple[list[dict], str | None]:
    """``copilot_internal/user``: one monthly window per ``quota_snapshots``
    entry with has_quota=true (usedPercent = 100 - percent_remaining), all
    resetting at ``quota_reset_date_utc``; ``copilot_plan`` -> planType.
    Entitlements without quota (has_quota=false) are skipped."""
    plan = data.get("copilot_plan")
    plan = plan if isinstance(plan, str) and plan else None
    snapshots = data.get("quota_snapshots")
    if not isinstance(snapshots, dict):
        return [], plan
    resets = data.get("quota_reset_date_utc")
    resets = resets if isinstance(resets, str) and resets else None
    windows: list[dict] = []
    for key, label in _COPILOT_QUOTA_KEYS:
        entry = snapshots.get(key)
        if not isinstance(entry, dict) or not entry.get("has_quota"):
            continue
        remaining = _num(entry.get("percent_remaining"))
        if remaining is None:
            continue
        windows.append(_window("monthly", label, 100.0 - remaining, resets))
    return windows, plan


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


def parse_retry_after(value: str | None) -> float:
    try:
        return max(1.0, float(value))  # seconds form only; date form -> default
    except (TypeError, ValueError):
        return RATE_LIMIT_COOLDOWN


# ── Fetchers ────────────────────────────────────────────────────────────────

async def fetch_claude_oauth(oauth: dict | None) -> dict:
    """Claude usage for an Anthropic OAuth credential another CLI stores.

    The claude provider itself no longer comes through here — it reads the
    CLI's own ``/usage`` panel (see :mod:`claude_cli_usage`). What remains are
    opencode and pi, which keep an Anthropic OAuth grant inside their own auth
    files; there is no vendor CLI to delegate to for those, so this call stays.
    It identifies itself as Navide, the same as every other provider fetcher:
    this app previously sent ``claude-code/<version>``, built by running
    ``claude --version``, which claimed to be a client it is not."""
    if oauth is None:
        return _snapshot("claude", "no-credentials")
    if claude_token_expired(oauth):
        return _snapshot("claude", "expired")
    import httpx

    headers = {
        "Authorization": f"Bearer {oauth['accessToken']}",
        "anthropic-beta": CLAUDE_BETA_HEADER,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(CLAUDE_USAGE_URL, headers=headers)
    if resp.status_code == 401:
        return _snapshot("claude", "expired")
    if resp.status_code == 429:
        snap = _snapshot("claude", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("claude", "error", error=f"HTTP {resp.status_code}")
    windows, plan = normalize_claude(resp.json())
    return _snapshot("claude", "ok", windows=windows, plan_type=plan)


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


async def grok_billing_rpc(binary: str, env: dict | None = None) -> dict:
    """Spawn ``grok agent stdio`` and ask ``x.ai/billing`` over newline-delimited
    JSON-RPC. The subprocess is short-lived — spawned, queried, terminated.
    json.dumps never escapes ``/`` so the method name arrives intact.

    ``env`` (``None`` = inherit the parent environment) lets a profile point the
    CLI at its isolated ``HOME`` shim so billing reflects that account."""
    proc = await asyncio.create_subprocess_exec(
        binary, "agent", "stdio",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env=env,
    )

    async def rpc(req_id: int, method: str, params: dict, timeout: float) -> dict:
        assert proc.stdin is not None and proc.stdout is not None
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        proc.stdin.write((json.dumps(msg, separators=(",", ":")) + "\n").encode())
        await proc.stdin.drain()
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise asyncio.TimeoutError()
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            if not line:
                raise ConnectionError("grok agent closed stdout")
            try:
                payload = json.loads(line)
            except ValueError:
                continue
            if isinstance(payload, dict) and payload.get("id") == req_id:
                if "error" in payload:
                    raise ConnectionError(str(payload["error"]))
                return payload.get("result") or {}

    try:
        await rpc(1, "initialize", {
            "protocolVersion": "1",
            "clientCapabilities": {
                "fs": {"readTextFile": False, "writeTextFile": False},
                "terminal": False,
            },
        }, GROK_INIT_TIMEOUT)
        return await rpc(2, "x.ai/billing", {}, GROK_BILLING_TIMEOUT)
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()


async def fetch_grok(home: Path, env: dict | None = None,
                     spawn_env: dict | None = None) -> dict:
    creds = read_grok_credentials(home, env)
    if creds is None:
        return _snapshot("grok", "no-credentials")
    binary = shutil.which("grok")
    if not binary:
        return _snapshot("grok", "unavailable", error="grok CLI not found")
    try:
        billing = await grok_billing_rpc(binary, spawn_env)
    except (OSError, ConnectionError, asyncio.TimeoutError) as err:
        return _snapshot("grok", "unavailable", error=str(err) or "grok agent stdio failed")
    windows, plan = normalize_grok(billing)
    if not windows:
        return _snapshot("grok", "error", error="billing response had no usable fields")
    return _snapshot("grok", "ok", windows=windows, plan_type=plan)


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


async def _fetch_opencode_minimax(key: str) -> dict:
    import httpx

    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(OPENCODE_MINIMAX_USAGE_URL, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("opencode", "expired")
    if resp.status_code == 429:
        snap = _snapshot("opencode", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("opencode", "error", error=f"HTTP {resp.status_code}")
    payload = resp.json()
    base = payload.get("base_resp") if isinstance(payload, dict) else None
    status_code = _num((base or {}).get("status_code"))
    if status_code is not None and status_code != 0:
        msg = (base or {}).get("status_msg")
        return _snapshot("opencode", "error",
                         error=str(msg or f"MiniMax status {int(status_code)}"))
    return _snapshot("opencode", "ok", windows=normalize_opencode_minimax(payload))


async def fetch_opencode(home: Path) -> dict:
    """opencode is an aggregator: each supported ``auth.json`` entry is asked
    its own provider's usage endpoint. Any source that answers makes the
    snapshot "ok" (windows combined); with none answering the first failure
    is surfaced; entries without a usage surface (Zen, BYOK keys) alone ->
    unavailable."""
    auth = read_opencode_credentials(home)
    if auth is None:
        return _snapshot("opencode", "no-credentials")
    sub_snaps: list[dict] = []
    key = opencode_minimax_key(auth)
    if key is not None:
        sub_snaps.append(await _fetch_opencode_minimax(key))
    oauth = opencode_anthropic_oauth(auth)
    if oauth is not None:
        snap = await fetch_claude_oauth(oauth)
        snap["provider"] = "opencode"
        snap["windows"] = [dict(w, label=f"Claude — {w['label']}")
                           for w in snap["windows"]]
        sub_snaps.append(snap)
    if not sub_snaps:
        return _snapshot(
            "opencode", "unavailable",
            error="no auth.json entry has a usage API "
                  "(opencode Zen and plain API keys expose none)")
    ok = [s for s in sub_snaps if s["status"] == "ok"]
    if ok:
        return _snapshot("opencode", "ok",
                         windows=[w for s in ok for w in s["windows"]])
    return sub_snaps[0]


async def _fetch_qwen_region(client, key: str, region: tuple) -> dict:
    """One region's console-gateway query -> snapshot.

    The API key is the credential the gateway checks; the browser User-Agent
    this used to send was decoration and is gone. Origin/Referer stay: the
    gateway refuses cross-site posts without them, and they name the console
    the endpoint belongs to rather than claiming to be its client."""
    url, commodity_code, origin, referer = region
    headers = {
        "Authorization": f"Bearer {key}",
        "x-api-key": key,
        "X-DashScope-API-Key": key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Navide",
        "Origin": origin,
        "Referer": referer,
    }
    resp = await client.post(
        url, headers=headers,
        json={"queryCodingPlanInstanceInfoRequest":
              {"commodityCode": commodity_code}})
    if resp.status_code in (401, 403):
        return _snapshot("qwen", "expired")
    if resp.status_code == 429:
        snap = _snapshot("qwen", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("qwen", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("qwen", "error", error="non-JSON response")
    # The gateway tunnels auth failures (invalid key, api-key mode unavailable
    # in this region) through HTTP 200 + a NeedLogin marker in the body.
    if "NeedLogin" in json.dumps(payload):
        return _snapshot("qwen", "expired")
    windows, plan = normalize_qwen(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("qwen", "error",
                         error="response had no usable quota fields")
    return _snapshot("qwen", "ok", windows=windows, plan_type=plan)


async def fetch_qwen(home: Path, env: dict | None = None) -> dict:
    env = env if env is not None else dict(os.environ)
    key = read_qwen_credentials(home, env)
    if key is None:
        if qwen_legacy_oauth_present(home):
            return _snapshot(
                "qwen", "unavailable",
                error="legacy Qwen OAuth has no usage API (free tier "
                      "discontinued; a Coding Plan API key is required)")
        return _snapshot("qwen", "no-credentials")
    import httpx

    first: dict | None = None
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        for region in QWEN_REGIONS:
            try:
                snap = await _fetch_qwen_region(client, key, region)
            except httpx.HTTPError as err:
                snap = _snapshot("qwen", "error", error=str(err))
            # ok answers; 429 means the key works, so the alternate region
            # would not help. Everything else retries the other region,
            # surfacing the FIRST failure when both refuse.
            if snap["status"] in ("ok", "rate-limited"):
                return snap
            first = first or snap
    return first or _snapshot("qwen", "error", error="no region answered")


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


async def _fetch_pi_codex(creds: dict) -> dict:
    """pi's ``openai-codex`` oauth token against ChatGPT ``wham/usage`` (the
    same endpoint the codex provider uses; pi has no config.toml base
    override, so the default base applies)."""
    if pi_oauth_expired(creds):
        return _snapshot("pi", "expired")
    import httpx

    headers = {
        "Authorization": f"Bearer {creds['access_token']}",
        "User-Agent": "Navide",
        "Accept": "application/json",
    }
    if creds.get("account_id"):
        headers["ChatGPT-Account-Id"] = creds["account_id"]
    url = codex_usage_url(CODEX_DEFAULT_BASE)
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("pi", "expired")
    if resp.status_code == 429:
        snap = _snapshot("pi", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("pi", "error", error=f"HTTP {resp.status_code}")
    windows, plan = normalize_codex(resp.json())
    windows = [dict(w, label=f"Codex — {w['label']}") for w in windows]
    return _snapshot("pi", "ok", windows=windows, plan_type=plan)


async def _fetch_pi_openrouter(key: str) -> dict:
    import httpx

    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(PI_OPENROUTER_KEY_URL, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("pi", "expired")
    if resp.status_code == 429:
        snap = _snapshot("pi", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("pi", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("pi", "error", error="non-JSON response")
    windows = normalize_pi_openrouter(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("pi", "error", error="response had no usable fields")
    return _snapshot("pi", "ok", windows=windows)


async def fetch_pi(home: Path, env: dict | None = None) -> dict:
    """pi is an aggregator with no server of its own: each supported
    ``auth.json`` credential is asked its own provider's usage endpoint. Any
    source that answers makes the snapshot "ok" (windows combined); with none
    answering the first failure is surfaced; entries without a usage surface
    (BYOK api keys, github-copilot/xai/radius) alone -> unavailable."""
    env = env if env is not None else dict(os.environ)
    auth = read_pi_credentials(home, env)
    if auth is None:
        return _snapshot("pi", "no-credentials")
    sub_snaps: list[dict] = []
    oauth = pi_anthropic_oauth(auth)
    if oauth is not None:
        snap = await fetch_claude_oauth(oauth)
        snap["provider"] = "pi"
        snap["windows"] = [dict(w, label=f"Claude — {w['label']}")
                           for w in snap["windows"]]
        sub_snaps.append(snap)
    codex_creds = pi_codex_oauth(auth)
    if codex_creds is not None:
        sub_snaps.append(await _fetch_pi_codex(codex_creds))
    key = pi_openrouter_key(auth)
    if key is not None:
        sub_snaps.append(await _fetch_pi_openrouter(key))
    if not sub_snaps:
        return _snapshot(
            "pi", "unavailable",
            error="no auth.json credential has a usage API "
                  "(plain API keys and github-copilot/xai/radius expose none)")
    ok = [s for s in sub_snaps if s["status"] == "ok"]
    if ok:
        return _snapshot("pi", "ok",
                         windows=[w for s in ok for w in s["windows"]])
    return sub_snaps[0]


async def fetch_copilot(home: Path, env: dict | None = None) -> dict:
    env = env if env is not None else dict(os.environ)
    config = read_copilot_config(home)
    host = config["host"] if config else COPILOT_DEFAULT_HOST
    token = None
    if config is not None:
        token = await _copilot_gh_token(config["login"], host)
    if token is None:
        token = read_copilot_hosts_token(home, host)
    if token is None:
        token = copilot_env_token(env)
    if token is None:
        return _snapshot("copilot", "no-credentials")
    import httpx

    # This read was once dressed as the VS Code extension — a spoofed
    # ``GitHubCopilotChat/…`` User-Agent plus ``Editor-Version`` headers.
    # Measured 2026-08-05: the endpoint does not gate on any of it, answering
    # 200 to a plain ``User-Agent: Navide`` with the same body. The costume was
    # never load-bearing, so it is gone and the reading stays.
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(copilot_usage_url(host), headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("copilot", "expired")
    if resp.status_code == 429:
        snap = _snapshot("copilot", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("copilot", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("copilot", "error", error="non-JSON response")
    windows, plan = normalize_copilot(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("copilot", "error",
                         error="response had no usable quota fields")
    return _snapshot("copilot", "ok", windows=windows, plan_type=plan)


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

    def _record_parked_claude_slot(self, slot_id: str) -> bool:
        """A parked account has no measurable quota.

        Only the CLI can report a figure now, and it can only speak for whoever
        is signed in. The cached percentage is dropped rather than left to
        stand in for a live one — an account showing a healthy number it can no
        longer back up is what sent the user to a signed-out account in the
        first place. Returns True when a cache entry was discarded."""
        changed = self._last_good.get("claude", {}).pop(slot_id, None) is not None
        self.account_snapshots.setdefault("claude", {})[slot_id] = _snapshot(
            "claude", "not-measured"
        )
        return changed

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
        # signed-in account can be reported that way, so parked accounts carry
        # no figure at all rather than a cached one pretending to be current.
        parked_slots: list[str] = []
        if claude_accounts is None:
            claude_active = "__default__"
        else:
            claude_active, credentials = claude_accounts
            parked_slots = [s for s in credentials if s != claude_active]
        claude_coros = {claude_active: lambda: fetch_claude(home)}
        for slot_id in parked_slots:
            cache_changed = self._record_parked_claude_slot(slot_id) or cache_changed
        self._active_claude_slot = claude_active
        claude_tasks: dict[str, asyncio.Task] = {}
        for slot_id, coro in claude_coros.items():
            key = ("claude", slot_id)
            if self._blocked_until.get(key, 0) <= now:
                claude_tasks[slot_id] = asyncio.create_task(coro())

        tasks: dict[str, Any] = {}
        for provider, coro in (
            ("codex", lambda: fetch_codex(codex_home)),
            ("kimi", lambda: fetch_kimi(home)),
            ("grok", lambda: fetch_grok(home)),
            ("antigravity", lambda: fetch_antigravity(home)),
            ("opencode", lambda: fetch_opencode(home)),
            ("qwen", lambda: fetch_qwen(home)),
            ("kilo", lambda: fetch_kilo(home)),
            ("pi", lambda: fetch_pi(home)),
            ("copilot", lambda: fetch_copilot(home)),
            ("cursor", lambda: fetch_cursor(home)),
        ):
            if self._blocked_until.get(provider, 0) > now:
                continue
            tasks[provider] = asyncio.create_task(coro())
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
