"""Characterization tests for copilot's resume preflight and resume-id
parsing — written against the legacy behavior BEFORE the R4 migration,
required to pass unchanged after it."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import app as app_module


def test_resume_id_parses_both_forms() -> None:
    sid = "0a1b2c3d-1111-2222-3333-444455556666"
    assert app_module._resume_id_for_agent("copilot", f"copilot --resume={sid}") == sid
    assert app_module._resume_id_for_agent("copilot", f"copilot --yolo --resume {sid}") == sid
    assert app_module._resume_id_for_agent(
        "copilot", ["/bin/zsh", "-lc", f"copilot --resume={sid}"]
    ) == sid


def test_resume_id_rejects_non_resume_and_flag_values() -> None:
    assert app_module._resume_id_for_agent("copilot", "copilot") == ""
    assert app_module._resume_id_for_agent("copilot", "copilot --resume -x") == ""


def test_lookup_path_names_session_state_events_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path))
    path = app_module._session_lookup_path("copilot", "/ws", "sid-9")
    assert path.endswith("/session-state/sid-9/events.jsonl")


def test_session_exists_follows_lookup_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path))
    assert app_module._session_exists("copilot", "/ws", "sid-9") is False
    target = Path(app_module._session_lookup_path("copilot", "/ws", "sid-9"))
    target.parent.mkdir(parents=True)
    target.write_text("{}", encoding="utf-8")
    assert app_module._session_exists("copilot", "/ws", "sid-9") is True
