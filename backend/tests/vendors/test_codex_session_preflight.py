"""Characterization tests for codex's resume preflight and resume-id parsing
— pinned against legacy behavior BEFORE the R11 migration."""

from __future__ import annotations

from agent_team_backend import app as app_module


def test_resume_id_parses_resume_subcommand() -> None:
    sid = "0a1b2c3d-1111-2222-3333-444455556666"
    assert app_module._resume_id_for_agent("codex", f"codex resume {sid}") == sid
    assert app_module._resume_id_for_agent(
        "codex", ["/bin/zsh", "-lc", f"codex resume {sid} --yolo"]
    ) == sid
    assert app_module._resume_id_for_agent("codex", "codex") == ""


def test_lookup_path_is_empty_vendor_owned() -> None:
    assert app_module._session_lookup_path("codex", "/ws", "s1") == ""


def test_session_exists_searches_codex_homes() -> None:
    # Stale pointers must fail preflight instead of launching a doomed
    # `codex resume` (searches both the real and per-pane homes).
    assert app_module._session_exists("codex", "/ws", "no-such-rollout-id") is False
