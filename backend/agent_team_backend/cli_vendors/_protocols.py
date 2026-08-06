"""Multi-vendor wire protocols.

A protocol is credential/endpoint knowledge shared by SEVERAL vendors, so it
belongs to none of them: opencode and pi both store an Anthropic OAuth grant
in their own auth files and read Claude quota with it. Vendor modules import
protocols; protocols import nothing vendor-specific.
"""

from __future__ import annotations

import time

from ..usage_common import HTTP_TIMEOUT, _num, _snapshot, _window, parse_retry_after

# ---- Anthropic OAuth usage (opencode, pi; claude itself reads its CLI's
# /usage panel instead — see cli_vendors/claude.py after R12) ---------------

CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_BETA_HEADER = "oauth-2025-04-20"


def claude_token_expired(oauth: dict, now_ms: float | None = None) -> bool:
    expires = _num(oauth.get("expiresAt"))
    if expires is None:
        return False
    now = time.time() * 1000 if now_ms is None else now_ms
    return now >= expires


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
