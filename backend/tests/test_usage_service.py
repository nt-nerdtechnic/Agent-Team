"""Unit tests for usage_service: credential parsing, response normalization,
and the poller's cooldown behavior. No network, no real CLI spawns."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend import usage_service as us


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


# ── Claude credentials ──────────────────────────────────────────────────────

def test_claude_credentials_file_ok(tmp_path):
    _write(tmp_path / ".claude" / ".credentials.json",
           {"claudeAiOauth": {"accessToken": "tok", "expiresAt": 2_000_000_000_000}})
    oauth = us.read_claude_credentials_file(tmp_path)
    assert oauth is not None and oauth["accessToken"] == "tok"


def test_claude_credentials_missing_and_mcp_only(tmp_path):
    assert us.read_claude_credentials_file(tmp_path) is None
    _write(tmp_path / ".claude" / ".credentials.json", {"mcpOAuth": {"x": 1}})
    assert us.read_claude_credentials_file(tmp_path) is None


def test_claude_token_expired_boundary():
    oauth = {"expiresAt": 1_000}
    assert us.claude_token_expired(oauth, now_ms=1_000) is True
    assert us.claude_token_expired(oauth, now_ms=999) is False
    assert us.claude_token_expired({}, now_ms=0) is False  # no expiry -> assume valid


# ── Codex credentials & base URL ────────────────────────────────────────────

def test_codex_credentials_snake_and_camel(tmp_path):
    _write(tmp_path / "auth.json",
           {"tokens": {"access_token": "a", "account_id": "acct"}})
    creds = us.read_codex_credentials(tmp_path)
    assert creds == {"access_token": "a", "account_id": "acct"}
    _write(tmp_path / "auth.json",
           {"tokens": {"accessToken": "b", "accountId": "acct2"}})
    creds = us.read_codex_credentials(tmp_path)
    assert creds == {"access_token": "b", "account_id": "acct2"}


def test_codex_credentials_api_key_form_and_missing(tmp_path):
    _write(tmp_path / "auth.json", {"OPENAI_API_KEY": "sk-x"})
    assert us.read_codex_credentials(tmp_path) == {"access_token": "sk-x", "account_id": None}
    _write(tmp_path / "auth.json", {"tokens": {}})
    assert us.read_codex_credentials(tmp_path) is None
    assert us.read_codex_credentials(tmp_path / "nope") is None


def test_codex_base_url_normalization(tmp_path):
    assert us.codex_base_url(tmp_path) == us.CODEX_DEFAULT_BASE
    (tmp_path / "config.toml").write_text(
        'chatgpt_base_url = "https://chatgpt.com"  # comment\n', encoding="utf-8")
    assert us.codex_base_url(tmp_path) == "https://chatgpt.com/backend-api"
    (tmp_path / "config.toml").write_text(
        "chatgpt_base_url = 'https://proxy.example.com/'\n", encoding="utf-8")
    assert us.codex_base_url(tmp_path) == "https://proxy.example.com"


def test_codex_usage_url_path_selection():
    assert us.codex_usage_url("https://chatgpt.com/backend-api").endswith("/wham/usage")
    assert us.codex_usage_url("https://proxy.example.com").endswith("/api/codex/usage")


# ── Kimi credentials ────────────────────────────────────────────────────────

def test_kimi_env_key_wins(tmp_path):
    assert us.read_kimi_credentials(tmp_path, {"KIMI_CODE_API_KEY": "env-key"}) == "env-key"


def test_kimi_file_expiry_boundary(tmp_path):
    _write(tmp_path / ".kimi-code" / "credentials" / "kimi-code.json",
           {"access_token": "tok", "expires_at": 1_000})
    assert us.read_kimi_credentials(tmp_path, {}, now=939) == "tok"
    assert us.read_kimi_credentials(tmp_path, {}, now=940) is None  # <= now+60
    assert us.read_kimi_credentials(tmp_path / "nope", {}) is None


# ── Grok credentials ────────────────────────────────────────────────────────

def test_grok_prefers_oidc_over_legacy(tmp_path):
    _write(tmp_path / ".grok" / "auth.json", {
        "https://accounts.x.ai/sign-in": {"key": "legacy", "email": "l@x.ai"},
        "https://auth.x.ai::scope": {"key": "oidc", "email": "o@x.ai"},
    })
    creds = us.read_grok_credentials(tmp_path, {})
    assert creds is not None and creds["key"] == "oidc"


def test_grok_legacy_fallback_and_missing(tmp_path):
    _write(tmp_path / ".grok" / "auth.json",
           {"https://accounts.x.ai/sign-in": {"key": "legacy"}})
    creds = us.read_grok_credentials(tmp_path, {})
    assert creds is not None and creds["key"] == "legacy"
    _write(tmp_path / ".grok" / "auth.json", {"other": {"nokey": True}})
    assert us.read_grok_credentials(tmp_path, {}) is None


# ── Normalizers ─────────────────────────────────────────────────────────────

def test_normalize_claude_named_and_scoped_windows():
    windows, _ = us.normalize_claude({
        "five_hour": {"utilization": 42.5, "resets_at": "2026-07-24T10:00:00.123Z"},
        "seven_day": {"utilization": 12, "resets_at": "2026-07-28T00:00:00Z"},
        "seven_day_opus": {"utilization": None},  # skipped: no utilization
        "limits": [
            {"kind": "weekly_scoped", "group": "weekly", "percent": 7.5,
             "resets_at": "2026-07-28T00:00:00Z", "is_active": False,
             "scope": {"model": {"id": "m", "display_name": "Fable"}}},
            {"kind": "other", "group": "weekly", "percent": 1},  # wrong kind
        ],
    })
    kinds = [(w["kind"], w["usedPercent"]) for w in windows]
    assert ("session", 42.5) in kinds
    assert ("weekly", 12.0) in kinds
    # is_active False must NOT filter the scoped limit out
    assert any(w["label"] == "Fable only" and w["usedPercent"] == 7.5 for w in windows)
    assert len(windows) == 3


def test_normalize_claude_scoped_filters_all_models_and_dedupes():
    windows, _ = us.normalize_claude({
        "limits": [
            # "all models" aggregate row must be dropped.
            {"kind": "weekly_scoped", "group": "weekly", "percent": 50,
             "scope": {"model": {"id": "all-models", "display_name": "All Models"}}},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 7.5,
             "resets_at": "2026-07-28T00:00:00Z",
             "scope": {"model": {"id": "opus", "display_name": "Opus"}}},
            # duplicate opus slug must be de-duplicated (first wins).
            {"kind": "weekly_scoped", "group": "weekly", "percent": 99,
             "scope": {"model": {"id": "opus", "display_name": "Opus"}}},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 3,
             "scope": {"model": {"id": "sonnet", "display_name": "Sonnet"}}},
        ],
    })
    labels = [(w["label"], w["usedPercent"]) for w in windows]
    assert ("Opus only", 7.5) in labels
    assert ("Sonnet only", 3.0) in labels
    assert not any("All Models" in w["label"] for w in windows)
    assert len(windows) == 2  # all-models dropped, duplicate opus collapsed


def test_normalize_claude_marks_null_id_promotional_scoped():
    # Real /api/oauth/usage shape (2026-07): the only weekly_scoped entry is a
    # promotional "Fable" bucket with scope.model.id=None — Anthropic reports it
    # at 100% but does NOT enforce it (requests fall back to the main quota). It
    # stays visible (CodexBar surfaces it too) but is marked "(promo)" so the
    # exhausted row is not read as an account-wide block. Sibling limits[]
    # entries (kind=session/weekly_all) must not become extra windows.
    windows, _ = us.normalize_claude({
        "five_hour": {"utilization": 4.0, "resets_at": "2026-07-24T15:50:00Z"},
        "seven_day": {"utilization": 92.0, "resets_at": "2026-07-29T23:00:00Z"},
        "seven_day_opus": None,
        "seven_day_sonnet": None,
        "limits": [
            {"kind": "session", "group": "session", "percent": 4},
            {"kind": "weekly_all", "group": "weekly", "percent": 92},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 100,
             "is_active": True, "severity": "critical",
             "scope": {"model": {"id": None, "display_name": "Fable"}}},
        ],
    })
    labels = [w["label"] for w in windows]
    assert "Session (5h)" in labels
    assert "Weekly (all models)" in labels
    assert any(w["label"] == "Fable (promo)" and w["usedPercent"] == 100.0 for w in windows)
    assert len(windows) == 3


def test_normalize_codex_epoch_and_plan():
    windows, plan = us.normalize_codex({
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": {"used_percent": 37, "reset_at": 1753350000,
                               "limit_window_seconds": 18000},
            "secondary_window": {"used_percent": 12, "reset_at": 1753900000,
                                 "limit_window_seconds": 604800},
        },
    })
    assert plan == "plus"
    session = next(w for w in windows if w["kind"] == "session")
    assert session["usedPercent"] == 37.0
    assert session["resetsAt"].startswith("2025-07-24T")  # epoch converted to ISO
    assert session["windowMinutes"] == 300
    weekly = next(w for w in windows if w["kind"] == "weekly")
    assert weekly["windowMinutes"] == 10080


def test_normalize_codex_classifies_by_window_length_when_reversed():
    # primary carries the 7-day window, secondary the 5-hour one: roles must
    # follow limit_window_seconds, not position.
    windows, _ = us.normalize_codex({
        "rate_limit": {
            "primary_window": {"used_percent": 12, "reset_at": 1753900000,
                               "limit_window_seconds": 604800},
            "secondary_window": {"used_percent": 37, "reset_at": 1753350000,
                                 "limit_window_seconds": 18000},
        },
    })
    weekly = next(w for w in windows if w["kind"] == "weekly")
    session = next(w for w in windows if w["kind"] == "session")
    assert weekly["usedPercent"] == 12.0
    assert session["usedPercent"] == 37.0


def test_normalize_codex_positional_fallback_without_window_minutes():
    # No limit_window_seconds -> fall back to primary=session, secondary=weekly.
    windows, _ = us.normalize_codex({
        "rate_limit": {
            "primary_window": {"used_percent": 5},
            "secondary_window": {"used_percent": 9},
        },
    })
    assert [(w["kind"], w["usedPercent"]) for w in windows] == [
        ("session", 5.0), ("weekly", 9.0)]
    assert all(w["windowMinutes"] is None for w in windows)


def test_codex_credits_parsing():
    windows, _ = us.normalize_codex({"rate_limit": {}})
    assert windows == []
    assert us._codex_credits({}) is None
    assert us._codex_credits({
        "credits": {"has_credits": True, "unlimited": False, "balance": "12.5"},
    }) == {"hasCredits": True, "unlimited": False, "balance": 12.5}
    # Non-numeric balance is preserved as-is.
    assert us._codex_credits({"credits": {"balance": "n/a"}}) == {
        "hasCredits": False, "unlimited": False, "balance": "n/a"}


def test_codex_extra_windows_parsing():
    extra = us._codex_extra_windows({
        "additional_rate_limits": [
            {"limit_name": "gpt-image", "metered_feature": "image_gen",
             "rate_limit": {
                 "primary_window": {"used_percent": 20,
                                    "limit_window_seconds": 18000},
                 "secondary_window": {"used_percent": 80,
                                      "limit_window_seconds": 604800},
             }},
        ],
    })
    assert len(extra) == 1
    assert extra[0]["name"] == "gpt-image"
    kinds = {w["kind"]: w["usedPercent"] for w in extra[0]["windows"]}
    assert kinds == {"session": 20.0, "weekly": 80.0}
    assert us._codex_extra_windows({}) == []


def test_normalize_kimi_string_numbers_and_session():
    # CodexBar's Code-API model nests the 5h rate-limit under limits[0].detail.
    windows, _ = us.normalize_kimi({
        "usage": {"limit": "200", "used": "50", "resetTime": "2026-07-28T00:00:00Z"},
        "limits": [{"window": "5h",
                    "detail": {"limit": 10, "used": 2,
                               "reset_time": "2026-07-24T08:00:00Z"}}],
    })
    weekly = next(w for w in windows if w["kind"] == "weekly")
    assert weekly["usedPercent"] == 25.0
    session = next(w for w in windows if w["kind"] == "session")
    assert session["usedPercent"] == 20.0
    assert session["resetsAt"] == "2026-07-24T08:00:00Z"


def test_normalize_kimi_session_window_reads_nested_detail():
    # Core regression guard: with the 5h window nested in detail, the session
    # window must still emit (top-level limit/used are absent).
    windows, _ = us.normalize_kimi({
        "limits": [{"window": "5h",
                    "detail": {"limit": 100, "used": 40,
                               "resetTime": "2026-07-24T12:00:00Z"}}],
    })
    session = next(w for w in windows if w["kind"] == "session")
    assert session["label"] == "Rate limit (5h)"
    assert session["usedPercent"] == 40.0
    assert session["resetsAt"] == "2026-07-24T12:00:00Z"


def test_normalize_kimi_weekly_remaining_fallback():
    # No "used" — derive it from limit - remaining.
    windows, _ = us.normalize_kimi({
        "usage": {"limit": 200, "remaining": 150},
    })
    weekly = next(w for w in windows if w["kind"] == "weekly")
    assert weekly["usedPercent"] == 25.0


def test_normalize_kimi_reset_at_key():
    windows, _ = us.normalize_kimi({
        "limits": [{"detail": {"limit": 10, "used": 1,
                               "reset_at": "2026-07-24T09:00:00Z"}}],
    })
    session = next(w for w in windows if w["kind"] == "session")
    assert session["resetsAt"] == "2026-07-24T09:00:00Z"


def test_normalize_kimi_zero_limit_is_skipped():
    windows, _ = us.normalize_kimi({"usage": {"limit": 0, "used": 5}})
    assert windows == []


def test_normalize_grok_cents_math():
    windows, _ = us.normalize_grok({
        "billingCycle": {"billingPeriodEnd": "2026-08-01T00:00:00Z"},
        "monthlyLimit": {"val": 3000},
        "usage": {"totalUsed": {"val": 750}},
    })
    assert len(windows) == 1
    assert windows[0]["kind"] == "monthly"
    assert windows[0]["usedPercent"] == 25.0
    assert windows[0]["resetsAt"] == "2026-08-01T00:00:00Z"


def test_normalize_grok_empty():
    windows, _ = us.normalize_grok({})
    assert windows == []


def test_parse_retry_after():
    assert us.parse_retry_after("42") == 42.0
    assert us.parse_retry_after("0") == 1.0
    assert us.parse_retry_after(None) == us.RATE_LIMIT_COOLDOWN
    assert us.parse_retry_after("Thu, 24 Jul 2026 00:00:00 GMT") == us.RATE_LIMIT_COOLDOWN


# ── Poller cooldown behavior ────────────────────────────────────────────────

async def test_poll_once_rate_limit_sets_cooldown(tmp_path, monkeypatch):
    calls = {"claude": 0}

    async def fake_claude(home):
        calls["claude"] += 1
        snap = us._snapshot("claude", "rate-limited")
        snap["retryAfterSec"] = 120.0
        return snap

    async def fake_ok(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", fake_claude)
    monkeypatch.setattr(us, "fetch_codex", lambda home: fake_ok("codex"))
    monkeypatch.setattr(us, "fetch_kimi", lambda home: fake_ok("kimi"))
    monkeypatch.setattr(us, "fetch_grok", lambda home: fake_ok("grok"))

    svc = us.UsageService()
    payload = await svc.poll_once(tmp_path)
    assert payload["providers"]["claude"]["status"] == "rate-limited"
    assert "retryAfterSec" not in payload["providers"]["claude"]
    # Second poll skips the blocked provider entirely.
    await svc.poll_once(tmp_path)
    assert calls["claude"] == 1
    # request_refresh clears the gate.
    svc.request_refresh()
    await svc.poll_once(tmp_path)
    assert calls["claude"] == 2


async def test_poll_once_survives_fetcher_exception(tmp_path, monkeypatch):
    async def boom(home):
        raise RuntimeError("kaput")

    async def fake_ok(provider):
        return us._snapshot(provider, "no-credentials")

    monkeypatch.setattr(us, "fetch_claude", boom)
    monkeypatch.setattr(us, "fetch_codex", lambda home: fake_ok("codex"))
    monkeypatch.setattr(us, "fetch_kimi", lambda home: fake_ok("kimi"))
    monkeypatch.setattr(us, "fetch_grok", lambda home: fake_ok("grok"))

    svc = us.UsageService()
    payload = await svc.poll_once(tmp_path)
    assert payload["providers"]["claude"]["status"] == "error"
    assert payload["providers"]["codex"]["status"] == "no-credentials"


async def test_grok_billing_rpc_with_fake_stdio(tmp_path, monkeypatch):
    """Drive grok_billing_rpc against a scripted fake `grok agent stdio`."""
    import sys as _sys

    script = tmp_path / "fake_grok.py"
    script.write_text(
        "import sys, json\n"
        "for line in sys.stdin:\n"
        "    msg = json.loads(line)\n"
        "    if msg['method'] == 'initialize':\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': {}}), flush=True)\n"
        "    elif msg['method'] == 'x.ai/billing':\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': {\n"
        "            'billingCycle': {'billingPeriodEnd': '2026-08-01T00:00:00Z'},\n"
        "            'monthlyLimit': {'val': 1000}, 'usage': {'totalUsed': {'val': 100}}}}), flush=True)\n",
        encoding="utf-8",
    )

    real_exec = us.asyncio.create_subprocess_exec

    async def fake_exec(binary, *args, **kwargs):
        # Replace `<binary> agent stdio` with `python fake_grok.py`.
        return await real_exec(_sys.executable, str(script), **kwargs)

    monkeypatch.setattr(us.asyncio, "create_subprocess_exec", fake_exec)
    billing = await us.grok_billing_rpc("grok")
    windows, _ = us.normalize_grok(billing)
    assert windows and windows[0]["usedPercent"] == 10.0
