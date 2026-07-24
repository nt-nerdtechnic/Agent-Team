"""Per-CLI quota/usage monitor (CodexBar-style).

Reads the credentials each CLI already stores locally and calls that
provider's own usage surface — no login flow, no credential writes:

- claude: ``~/.claude/.credentials.json`` (macOS Keychain fallback) ->
  ``GET https://api.anthropic.com/api/oauth/usage``
- codex:  ``$CODEX_HOME/auth.json`` -> ``GET <base>/wham/usage``
  (base from ``config.toml`` ``chatgpt_base_url``, default chatgpt.com)
- kimi:   ``~/.kimi-code/credentials/kimi-code.json`` ->
  ``GET https://api.kimi.com/coding/v1/usages``
- grok:   ``~/.grok/auth.json`` + ``grok agent stdio`` JSON-RPC
  method ``x.ai/billing``
- antigravity: macOS Keychain (``gemini``/``antigravity``, stale-file fallback)
  -> refresh the agy token in memory -> ``v1internal:retrieveUserQuotaSummary``

Every credential file is read-only here; token refresh is left to the CLI
that owns the file (refreshing ourselves would rotate the CLI's tokens).
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
import json
import logging
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .applog import app_data_dir

log = logging.getLogger(__name__)

PROVIDERS = ("claude", "codex", "kimi", "grok", "antigravity")

CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_BETA_HEADER = "oauth-2025-04-20"
CLAUDE_UA_FALLBACK = "claude-code/2.1.0"
CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"
CODEX_DEFAULT_BASE = "https://chatgpt.com/backend-api"
KIMI_DEFAULT_BASE = "https://api.kimi.com"
# Antigravity (Google "agy" CLI). We only ever READ its credentials — never
# write back to the Keychain or ~/.gemini, and the refreshed access token stays
# in memory. client_id/secret live in a local Navide config, never in the repo.
ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini"
ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity"
ANTIGRAVITY_KEYRING_PREFIX = "go-keyring-base64:"
ANTIGRAVITY_STALE_TOKEN_REL = (".gemini", "antigravity-cli", "antigravity-oauth-token")
ANTIGRAVITY_OAUTH_CONFIG = "antigravity-oauth.json"
ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token"
ANTIGRAVITY_API_BASE = "https://daily-cloudcode-pa.googleapis.com"
ANTIGRAVITY_LOAD_URL = f"{ANTIGRAVITY_API_BASE}/v1internal:loadCodeAssist"
ANTIGRAVITY_QUOTA_URL = f"{ANTIGRAVITY_API_BASE}/v1internal:retrieveUserQuotaSummary"
# TODO(antigravity): endpoint bodies + clientMetadata values are not yet
# empirically verified against a live agy session. These are best-effort
# placeholders; a non-200 response falls through to status="error" and never
# affects the other providers, so shipping them is safe until we can capture a
# real request. Values to confirm before trusting the numbers:
#   - clientMetadata.ideType / pluginType (exact enum strings agy sends)
#   - whether retrieveUserQuotaSummary needs a body at all, and its shape
#   - the x-goog-api-client version string
ANTIGRAVITY_CLIENT_METADATA = {"ideType": "IDE_UNSPECIFIED", "pluginType": "GEMINI"}
ANTIGRAVITY_GOOG_API_CLIENT = "gl-node/unknown gemini-cli/unknown"
GROK_INIT_TIMEOUT = 4.0
GROK_BILLING_TIMEOUT = 3.0
HTTP_TIMEOUT = 30.0
RATE_LIMIT_COOLDOWN = 300.0
RESET_BOUNDARY_GRACE = 30.0
DEFAULT_INTERVAL = 300.0
MIN_INTERVAL = 60.0


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

def read_claude_credentials_file(home: Path, config_dir: Path | None = None) -> dict | None:
    """Parse ``~/.claude/.credentials.json``. Returns the claudeAiOauth dict
    or None when absent/unusable (an mcpOAuth-only payload counts as absent).

    ``config_dir`` overrides the lookup with an explicit ``CLAUDE_CONFIG_DIR``
    (a profile's isolated home): the file is read from
    ``<config_dir>/.credentials.json`` directly, without the ``.claude``
    sub-directory. Default (``None``) keeps ``home/.claude``."""
    base = config_dir if config_dir is not None else home / ".claude"
    path = base / ".credentials.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
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


_keychain_failed = False


async def read_claude_credentials(home: Path, config_dir: Path | None = None) -> dict | None:
    """File first; on macOS fall back to the Keychain generic password the
    Claude Code CLI writes. A failed Keychain read is remembered for the
    process lifetime (the prompt/denial would otherwise re-fire every poll).

    When ``config_dir`` is set (a profile's isolated ``CLAUDE_CONFIG_DIR``) the
    read is file-only: the fixed-service Keychain entry belongs to the default
    account, so falling back to it would report the wrong account's usage."""
    global _keychain_failed
    oauth = read_claude_credentials_file(home, config_dir)
    if oauth is not None:
        return oauth
    if config_dir is not None or sys.platform != "darwin" or _keychain_failed:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/security", "find-generic-password",
            "-s", CLAUDE_KEYCHAIN_SERVICE, "-w",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
        if proc.returncode != 0:
            _keychain_failed = True
            return None
        data = json.loads(out.decode("utf-8", "replace").strip())
        oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
        if not isinstance(oauth, dict) or not oauth.get("accessToken"):
            return None
        return oauth
    except (OSError, ValueError, asyncio.TimeoutError):
        _keychain_failed = True
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
    """Extract ``token.refresh_token`` from a stored agy credential blob.

    Accepts both the Keychain form (``go-keyring-base64:`` + base64(JSON)) and
    a bare JSON file. The access_token is deliberately ignored — it is almost
    always expired and we mint a fresh one in memory from the refresh token."""
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
    path = home.joinpath(*ANTIGRAVITY_STALE_TOKEN_REL)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return _antigravity_refresh_token(raw)


_antigravity_keychain_failed = False


async def read_antigravity_credentials(home: Path) -> str | None:
    """Keychain first (macOS ``security find-generic-password``, read-only), then
    the stale token file. Returns the agy refresh_token or None. A failed
    Keychain read is remembered for the process lifetime so a denial does not
    re-prompt every poll (mirrors ``read_claude_credentials``)."""
    global _antigravity_keychain_failed
    if sys.platform == "darwin" and not _antigravity_keychain_failed:
        try:
            proc = await asyncio.create_subprocess_exec(
                "/usr/bin/security", "find-generic-password",
                "-s", ANTIGRAVITY_KEYCHAIN_SERVICE,
                "-a", ANTIGRAVITY_KEYCHAIN_ACCOUNT, "-w",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            if proc.returncode == 0:
                rt = _antigravity_refresh_token(out.decode("utf-8", "replace"))
                if rt is not None:
                    return rt
            else:
                _antigravity_keychain_failed = True
        except (OSError, asyncio.TimeoutError):
            _antigravity_keychain_failed = True
    return read_antigravity_credentials_file(home)


def _load_antigravity_oauth_config() -> dict | None:
    """Read ``{client_id, client_secret}`` from the local Navide config at
    ``app_data_dir()/antigravity-oauth.json``. The real secret values live only
    in this user-data file, never in the repo. Missing/unusable -> None so the
    fetch degrades to status="error" instead of crashing."""
    path = app_data_dir() / ANTIGRAVITY_OAUTH_CONFIG
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    client_id = data.get("client_id")
    client_secret = data.get("client_secret")
    if not (isinstance(client_id, str) and client_id
            and isinstance(client_secret, str) and client_secret):
        return None
    return {"client_id": client_id, "client_secret": client_secret}


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
        # A well-formed, enforceable per-model weekly limit carries a concrete
        # model id. Entries with only a display_name and no id are Anthropic
        # PROMOTIONAL per-model buckets (e.g. "Fable"): reported at 100% once the
        # promo is spent but NOT enforced (requests fall back to the main quota).
        # Keep showing them (CodexBar surfaces them too), but mark the label so
        # an exhausted promo row is not mistaken for an account-wide block.
        promotional = not (model_id and str(model_id).strip())
        label = f"{model} (promo)" if promotional else f"{model} only"
        windows.append(_window("weekly-model", label, pct, entry.get("resets_at")))
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


def normalize_antigravity(data: dict) -> tuple[list[dict], str | None]:
    """``quotaSummaryGroups[].buckets[].quotaInfo`` -> windows. remainingFraction
    is a 0..1 remaining ratio, so usedPercent = 100*(1-remainingFraction). Every
    bucket becomes a window; the tightest (lowest remainingFraction) sorts first
    so a windows[0]-only consumer surfaces the most-constrained bucket."""
    ranked: list[tuple[float, dict]] = []
    groups = data.get("quotaSummaryGroups")
    if isinstance(groups, list):
        for group in groups:
            if not isinstance(group, dict):
                continue
            group_name = group.get("groupName")
            buckets = group.get("buckets")
            if not isinstance(buckets, list):
                continue
            for bucket in buckets:
                if not isinstance(bucket, dict):
                    continue
                info = bucket.get("quotaInfo")
                if not isinstance(info, dict):
                    continue
                frac = _num(info.get("remainingFraction"))
                if frac is None:
                    continue
                label = bucket.get("bucketName") or group_name or "Quota"
                reset = info.get("resetTime")
                ranked.append((frac, _window(
                    "antigravity", str(label), 100.0 * (1.0 - frac),
                    reset if isinstance(reset, str) else None)))
    ranked.sort(key=lambda item: item[0])
    return [w for _, w in ranked], None


def parse_retry_after(value: str | None) -> float:
    try:
        return max(1.0, float(value))  # seconds form only; date form -> default
    except (TypeError, ValueError):
        return RATE_LIMIT_COOLDOWN


# ── Fetchers ────────────────────────────────────────────────────────────────

_claude_ua: str | None = None


async def _claude_user_agent() -> str:
    """``claude --version`` once per process; CodexBar-style fallback."""
    global _claude_ua
    if _claude_ua is not None:
        return _claude_ua
    binary = shutil.which("claude")
    version = ""
    if binary:
        try:
            proc = await asyncio.create_subprocess_exec(
                binary, "--version",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            version = out.decode("utf-8", "replace").strip().split()[0] if out.strip() else ""
        except (OSError, asyncio.TimeoutError, IndexError):
            version = ""
    _claude_ua = f"claude-code/{version}" if version else CLAUDE_UA_FALLBACK
    return _claude_ua


async def fetch_claude(home: Path, config_dir: Path | None = None) -> dict:
    oauth = await read_claude_credentials(home, config_dir)
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
        "User-Agent": await _claude_user_agent(),
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


async def fetch_codex(codex_home: Path) -> dict:
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


async def refresh_antigravity_token(refresh_token: str, cfg: dict) -> str | None:
    """Exchange the agy refresh_token for a fresh access_token, held in memory
    only (never written back to the Keychain or ~/.gemini). Returns the token,
    or None on invalid_grant/400 (treated as expired, mirroring claude/kimi
    401->expired). Other non-200s and network errors raise for the caller to
    map to status="error"."""
    import httpx

    body = {
        "grant_type": "refresh_token",
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "refresh_token": refresh_token,
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.post(ANTIGRAVITY_TOKEN_URL, data=body)
    if resp.status_code == 400:
        return None
    resp.raise_for_status()
    token = resp.json().get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("token response had no access_token")
    return token


async def fetch_antigravity(home: Path) -> dict:
    # Config first: cheap, no side effects, and lets a machine without the
    # local oauth config short-circuit before ever touching the Keychain.
    cfg = _load_antigravity_oauth_config()
    if cfg is None:
        return _snapshot("antigravity", "error",
                         error=f"missing {ANTIGRAVITY_OAUTH_CONFIG}")
    refresh_token = await read_antigravity_credentials(home)
    if refresh_token is None:
        return _snapshot("antigravity", "no-credentials")
    import httpx

    try:
        access_token = await refresh_antigravity_token(refresh_token, cfg)
    except (httpx.HTTPError, ValueError) as err:
        return _snapshot("antigravity", "error", error=f"token refresh: {err}")
    if access_token is None:
        return _snapshot("antigravity", "expired")

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Navide",
        "x-goog-api-client": ANTIGRAVITY_GOOG_API_CLIENT,
    }
    # TODO(antigravity): request bodies below are unverified placeholders.
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        # agy primes a session with loadCodeAssist first; treat it as best
        # effort — a failure here must not block the quota read.
        try:
            await client.post(ANTIGRAVITY_LOAD_URL, headers=headers,
                              json={"metadata": ANTIGRAVITY_CLIENT_METADATA})
        except httpx.HTTPError:
            pass
        try:
            resp = await client.post(
                ANTIGRAVITY_QUOTA_URL, headers=headers,
                json={"clientMetadata": ANTIGRAVITY_CLIENT_METADATA})
        except httpx.HTTPError as err:
            return _snapshot("antigravity", "error", error=str(err))
    if resp.status_code in (401, 403):
        return _snapshot("antigravity", "expired")
    if resp.status_code == 429:
        snap = _snapshot("antigravity", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("antigravity", "error", error=f"HTTP {resp.status_code}")
    windows, plan = normalize_antigravity(resp.json())
    return _snapshot("antigravity", "ok", windows=windows, plan_type=plan)


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


def _profile_credential_home(store, agent_key: str) -> Path | None:
    """The active profile's isolated credential base for ``agent_key`` (see
    ``profiles_store.credential_home_for``), or ``None`` for the built-in
    default. Never raises — a resolution failure falls back to the real home."""
    if store is None:
        return None
    try:
        from .profiles_store import credential_home_for
        return credential_home_for(agent_key, store)
    except Exception:  # noqa: BLE001
        return None


class UsageService:
    """Single app-wide poller. ``configure`` is idempotent and multi-window
    safe (last write wins); results are cached and broadcast on change."""

    def __init__(self) -> None:
        self.enabled = False
        self.interval = DEFAULT_INTERVAL
        self.snapshots: dict[str, dict] = {}
        self._blocked_until: dict[str, float] = {}
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()

    def payload(self) -> dict:
        return {"providers": self.snapshots, "enabled": self.enabled,
                "intervalSec": self.interval}

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

    async def poll_once(self, home: Path | None = None) -> dict:
        home = home or Path.home()
        import os

        codex_home = Path(os.environ["CODEX_HOME"]) if os.environ.get("CODEX_HOME") \
            else home / ".codex"
        # Redirect each provider's credential read to the ACTIVE account
        # profile's isolated home; None keeps the built-in default (real home).
        store = _get_profiles_store()
        claude_cfg = _profile_credential_home(store, "claude")
        codex_profile = _profile_credential_home(store, "codex")
        kimi_profile = _profile_credential_home(store, "kimi")
        grok_shim = _profile_credential_home(store, "grok")
        if codex_profile is not None:
            codex_home = codex_profile
        claude_call = (lambda: fetch_claude(home, claude_cfg)) if claude_cfg is not None \
            else (lambda: fetch_claude(home))
        kimi_call = (
            (lambda: fetch_kimi(home, {**os.environ, "KIMI_CODE_HOME": str(kimi_profile)}))
            if kimi_profile is not None else (lambda: fetch_kimi(home))
        )
        grok_call = (
            (lambda: fetch_grok(grok_shim, spawn_env={**os.environ, "HOME": str(grok_shim)}))
            if grok_shim is not None else (lambda: fetch_grok(home))
        )
        now = time.monotonic()
        tasks: dict[str, Any] = {}
        for provider, coro in (
            ("claude", claude_call),
            ("codex", lambda: fetch_codex(codex_home)),
            ("kimi", kimi_call),
            ("grok", grok_call),
            ("antigravity", lambda: fetch_antigravity(home)),
        ):
            if self._blocked_until.get(provider, 0) > now:
                continue
            tasks[provider] = asyncio.create_task(coro())
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
        return self.payload()

    def _next_sleep(self) -> float:
        """Regular interval, shortened to land just after the nearest window
        reset (CodexBar's reset-boundary refresh)."""
        sleep = self.interval
        now = datetime.now(timezone.utc)
        for snap in self.snapshots.values():
            for win in snap.get("windows", []):
                raw = win.get("resetsAt")
                if not raw:
                    continue
                try:
                    resets = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                except ValueError:
                    continue
                delta = (resets - now).total_seconds() + RESET_BOUNDARY_GRACE
                if 5.0 < delta < sleep:
                    sleep = delta
        return max(5.0, sleep)

    async def _run(self) -> None:
        from . import app
        from .ipc import make_event

        while self.enabled:
            try:
                payload = await self.poll_once()
                await app.broadcast(make_event("usage.changed", payload))
            except Exception as err:  # noqa: BLE001 — poller must survive anything
                log.warning("usage poll cycle failed: %s", err)
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self._next_sleep())
            except asyncio.TimeoutError:
                pass


service = UsageService()


# ── One-time setup (manual only; never auto-run on import or in tests) ───────

def setup_antigravity_oauth_config(binary: str | Path | None = None) -> Path:
    """Extract the OAuth client_id/client_secret embedded in the ``agy`` binary
    and write them to ``app_data_dir()/antigravity-oauth.json`` (chmod 600).

    This is a manual, one-shot bootstrap — it is NOT called on import or during
    fetches, so the repo never contains the secret values (only this reader).
    Run once via ``python -m agent_team_backend.usage_service``. Prints only the
    config path, never the extracted values."""
    import re

    path = binary or shutil.which("agy") or Path.home() / ".local" / "bin" / "agy"
    blob = Path(path).read_bytes()
    # Format-bounded so we don't over-capture into adjacent bytes of the Go
    # string table: an OAuth client_id is ``<digits>-<hash>.apps...`` and a
    # client_secret is exactly ``GOCSPX-`` + 28 chars. NOTE: the binary embeds
    # more than one candidate (Gemini CLI vs Antigravity) — this takes the first
    # match; verify it is the Antigravity pair before trusting live numbers.
    id_match = re.search(
        rb"[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com", blob)
    secret_match = re.search(rb"GOCSPX-[0-9A-Za-z_\-]{28}", blob)
    if not id_match or not secret_match:
        raise SystemExit(f"could not find client_id/secret in {path}")
    cfg = {
        "client_id": id_match.group(0).decode("ascii"),
        "client_secret": secret_match.group(0).decode("ascii"),
    }
    out = app_data_dir() / ANTIGRAVITY_OAUTH_CONFIG
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(cfg), encoding="utf-8")
    out.chmod(0o600)
    return out


if __name__ == "__main__":
    import sys as _sys

    dest = setup_antigravity_oauth_config(_sys.argv[1] if len(_sys.argv) > 1 else None)
    print(f"wrote {dest} (chmod 600)")
