"""Characterization tests for antigravity's resume preflight — written
against the legacy behavior BEFORE the R5 migration, required to pass
unchanged after it."""

from __future__ import annotations

from pathlib import Path

from agent_team_backend import app as app_module


def test_backend_has_no_resume_extractor() -> None:
    # `agy --conversation <id>` parsing lives frontend-side today; the
    # backend deliberately claims nothing. Pinned so the migration doesn't
    # accidentally introduce claiming behavior.
    assert app_module._resume_id_for_agent(
        "antigravity", "agy --conversation abc123"
    ) == ""


def test_lookup_path_names_the_conversation_db() -> None:
    path = app_module._session_lookup_path("antigravity", "/ws", "conv-7")
    assert path == str(
        Path.home() / ".gemini" / "antigravity-cli" / "conversations" / "conv-7.db"
    )


def test_session_exists_follows_lookup_path_generic_check() -> None:
    # No such conversation db on disk → the generic is_file() preflight fails.
    assert app_module._session_exists(
        "antigravity", "/ws", "definitely-not-a-real-conv-id"
    ) is False
