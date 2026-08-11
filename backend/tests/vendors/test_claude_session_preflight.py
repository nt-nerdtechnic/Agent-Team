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


def test_session_exists_finds_a_session_under_another_project(
    tmp_path: Path, monkeypatch
) -> None:
    """Claude Code >= 2.1.223 resolves an id against every project on the
    machine, so a transcript filed under a different project dir is resumable
    even though it is not under this workspace's own project dir."""
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = "/Users/me/proj"
    other = tmp_path / ".claude" / "projects" / "-Users-me-other-proj"
    other.mkdir(parents=True)
    (other / "sid-elsewhere.jsonl").write_text("{}\n", encoding="utf-8")

    assert app_module._session_exists("claude", ws, "sid-elsewhere") is True
    assert app_module._session_exists("claude", ws, "sid-nowhere") is False
    # The reported lookup path stays the single per-workspace one.
    assert app_module._session_lookup_path("claude", ws, "sid-elsewhere") == str(
        tmp_path / ".claude" / "projects" / encode_claude_cwd(ws)
        / "sid-elsewhere.jsonl"
    )


def test_session_exists_honours_claude_config_dir(
    tmp_path: Path, monkeypatch
) -> None:
    """Preflight resolves its root the same way the log reader does."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "empty-home")
    cfg = tmp_path / "cfg"
    (cfg / "projects" / "-ws").mkdir(parents=True)
    (cfg / "projects" / "-ws" / "sid-cfg.jsonl").write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(cfg))

    assert app_module._session_exists("claude", "/ws", "sid-cfg") is True


def test_session_exists_rejects_path_walking_ids(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / ".claude" / "projects" / "-ws").mkdir(parents=True)
    (tmp_path / ".claude" / "escape.jsonl").write_text("{}\n", encoding="utf-8")

    assert app_module._session_exists("claude", "/ws", "../escape") is False
