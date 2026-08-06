"""Characterization tests for kimi's resume preflight and resume-id parsing —
pinned against legacy behavior BEFORE the R10 migration."""

from __future__ import annotations

from agent_team_backend import app as app_module


def test_resume_id_parses_session_flag() -> None:
    sid = "session_0a1b2c3d"
    assert app_module._resume_id_for_agent("kimi", f"kimi --session {sid}") == sid
    assert app_module._resume_id_for_agent("kimi", "kimi") == ""
    assert app_module._resume_id_for_agent("kimi", "kimi --session -x") == ""


def test_lookup_path_is_empty_vendor_owned() -> None:
    assert app_module._session_lookup_path("kimi", "/ws", "s1") == ""


def test_session_exists_asks_the_reader() -> None:
    assert app_module._session_exists("kimi", "/ws", "no-such-session") is False
