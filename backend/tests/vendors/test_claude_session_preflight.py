"""Characterization tests for claude's resume preflight and resume-id parsing
— pinned against legacy behavior BEFORE the R12 migration."""

from __future__ import annotations

from pathlib import Path

from agent_team_backend import app as app_module
from agent_team_backend.log_readers.base import encode_claude_cwd


def test_resume_id_parses_resume_flag() -> None:
    sid = "0a1b2c3d-1111-2222-3333-444455556666"
    assert app_module._resume_id_for_agent("claude", f"claude --resume {sid}") == sid
    assert app_module._resume_id_for_agent(
        "claude", ["/bin/zsh", "-ilc", f"claude --resume {sid} --yolo"]
    ) == sid
    assert app_module._resume_id_for_agent("claude", "claude") == ""


def test_lookup_path_is_the_projects_jsonl() -> None:
    ws = "/Users/someone/Desktop/proj"
    path = app_module._session_lookup_path("claude", ws, "sid-1")
    assert path == str(
        Path.home() / ".claude" / "projects" / encode_claude_cwd(ws)
        / "sid-1.jsonl"
    )


def test_session_exists_checks_the_jsonl() -> None:
    assert app_module._session_exists(
        "claude", "/no/such/workspace-xyz", "no-such-session"
    ) is False
