"""Characterization tests for kilo's resume preflight and resume-id parsing —
pinned against legacy behavior BEFORE the R7 migration."""

from __future__ import annotations

from agent_team_backend import app as app_module


def test_resume_id_parses_session_flags() -> None:
    assert app_module._resume_id_for_agent("kilo", "kilo --session k1") == "k1"
    assert app_module._resume_id_for_agent("kilo", "kilo -s k1 --yolo") == "k1"
    assert app_module._resume_id_for_agent("kilo", "kilo") == ""
    assert app_module._resume_id_for_agent("kilo", "kilo --session -x") == ""


def test_lookup_path_is_empty_shared_db() -> None:
    assert app_module._session_lookup_path("kilo", "/ws", "s1") == ""


def test_session_exists_asks_the_reader() -> None:
    assert app_module._session_exists("kilo", "/ws", "no-such-session") is False
