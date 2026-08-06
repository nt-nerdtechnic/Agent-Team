"""Characterization tests for aider's resume preflight — written against the
legacy behavior BEFORE the R1 migration, and required to pass unchanged after
it. Aider has no session id: the lookup path is a history file of the
workspace, and existence of that file is the whole preflight."""

from __future__ import annotations

from pathlib import Path

from agent_team_backend import app as app_module


def test_lookup_path_defaults_to_shared_history_file(tmp_path: Path) -> None:
    path = app_module._session_lookup_path("aider", str(tmp_path), "any-slug")
    assert path == str(tmp_path / ".aider.chat.history.md")


def test_lookup_path_prefers_existing_history_file(tmp_path: Path) -> None:
    shared = tmp_path / ".aider.chat.history.md"
    shared.write_text("# aider chat started at 2026-08-06\n", encoding="utf-8")
    path = app_module._session_lookup_path("aider", str(tmp_path), "any-slug")
    assert path == str(shared)


def test_lookup_path_reports_pane_file_when_only_it_exists(tmp_path: Path) -> None:
    pane = tmp_path / ".aider.chat.history.abcd1234.md"
    pane.write_text("# aider chat started at 2026-08-06\n", encoding="utf-8")
    path = app_module._session_lookup_path("aider", str(tmp_path), "any-slug")
    assert path == str(pane)


def test_session_exists_follows_lookup_path(tmp_path: Path) -> None:
    # No file → the generic is_file() preflight fails.
    assert app_module._session_exists("aider", str(tmp_path), "slug") is False
    (tmp_path / ".aider.chat.history.md").write_text("x", encoding="utf-8")
    assert app_module._session_exists("aider", str(tmp_path), "slug") is True


def test_blank_session_id_short_circuits(tmp_path: Path) -> None:
    assert app_module._session_lookup_path("aider", str(tmp_path), " ") == ""
    assert app_module._session_exists("aider", str(tmp_path), "") is False
