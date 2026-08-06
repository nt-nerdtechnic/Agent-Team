"""Characterization tests for cursor's resume preflight and resume-id parsing
— written against the legacy behavior BEFORE the R3 migration, required to
pass unchanged after it."""

from __future__ import annotations

from agent_team_backend import app as app_module


def test_resume_id_parses_both_binaries_and_forms() -> None:
    sid = "chat-0a1b2c3d"
    assert app_module._resume_id_for_agent("cursor", f"agent --resume={sid}") == sid
    assert app_module._resume_id_for_agent("cursor", f"cursor-agent --resume {sid}") == sid
    assert app_module._resume_id_for_agent(
        "cursor", ["/bin/zsh", "-lc", f"agent --yolo --resume={sid}"]
    ) == sid


def test_resume_id_rejects_non_resume_and_flag_values() -> None:
    assert app_module._resume_id_for_agent("cursor", "agent") == ""
    assert app_module._resume_id_for_agent("cursor", "cursor-agent --resume -x") == ""


def test_lookup_path_is_empty_project_hash_segment_unknowable() -> None:
    # Cursor's session path has a project-hash segment the id alone can't
    # name, so the preflight reports no single stable path.
    assert app_module._session_lookup_path("cursor", "/ws", "chat-1") == ""


def test_session_exists_asks_the_reader() -> None:
    # With no cursor store on this machine the reader must answer False —
    # a stale persisted id fails preflight instead of launching a doomed
    # `agent --resume`.
    assert app_module._session_exists("cursor", "/ws", "no-such-chat-id") is False
