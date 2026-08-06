"""Characterization tests for opencode's resume preflight and resume-id
parsing — pinned against legacy behavior BEFORE the R6 migration."""

from __future__ import annotations

from agent_team_backend import app as app_module


def test_resume_id_parses_session_flags() -> None:
    assert app_module._resume_id_for_agent("opencode", "opencode --session ab12") == "ab12"
    assert app_module._resume_id_for_agent("opencode", "opencode -s ab12 --yolo") == "ab12"
    assert app_module._resume_id_for_agent("opencode", "opencode") == ""
    assert app_module._resume_id_for_agent("opencode", "opencode --session -x") == ""


def test_lookup_path_is_empty_shared_db() -> None:
    assert app_module._session_lookup_path("opencode", "/ws", "s1") == ""


def test_session_exists_asks_the_reader() -> None:
    assert app_module._session_exists("opencode", "/ws", "no-such-session") is False
