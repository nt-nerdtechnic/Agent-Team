"""Characterization tests for grok's resume preflight — pinned against legacy
behavior BEFORE the R9 migration."""

from __future__ import annotations

from agent_team_backend import app as app_module


def test_backend_has_no_resume_extractor() -> None:
    # `grok -s <id>` parsing lives frontend-side today; pinned.
    assert app_module._resume_id_for_agent("grok", "grok -s abc") == ""


def test_lookup_path_is_empty_shared_db() -> None:
    assert app_module._session_lookup_path("grok", "/ws", "s1") == ""


def test_session_exists_assumes_resumable_without_a_path() -> None:
    # No per-id path exists for the shared db, and grok has no reader-backed
    # existence check — the legacy contract is "assume resumable".
    assert app_module._session_exists("grok", "/ws", "anything") is True
