"""Characterization tests for qwen's resume preflight and resume-id parsing —
written against the legacy behavior BEFORE the R2 migration, required to pass
unchanged after it."""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import app as app_module


def test_resume_id_parses_long_and_short_flags() -> None:
    assert app_module._resume_id_for_agent("qwen", "qwen --resume abc123") == "abc123"
    assert app_module._resume_id_for_agent("qwen", "qwen -r abc123 --yolo") == "abc123"


def test_resume_id_rejects_non_resume_and_flag_values() -> None:
    assert app_module._resume_id_for_agent("qwen", "qwen chat") == ""
    # Flag guard: `--resume -x` must not swallow the following flag as an id.
    assert app_module._resume_id_for_agent("qwen", "qwen --resume -x") == ""


def test_lookup_path_uses_encoded_cwd_under_runtime_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("QWEN_RUNTIME_DIR", str(tmp_path))
    ws = "/Users/someone/Desktop/proj"
    path = app_module._session_lookup_path("qwen", ws, "sid-1")
    assert path == str(
        tmp_path / "projects" / "-Users-someone-Desktop-proj" / "chats" / "sid-1.jsonl"
    )


def test_session_exists_scans_chats_dirs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("QWEN_RUNTIME_DIR", str(tmp_path))
    chats = tmp_path / "projects" / "-any-encoded-dir" / "chats"
    chats.mkdir(parents=True)
    assert app_module._session_exists("qwen", "/irrelevant", "sid-2") is False
    (chats / "sid-2.jsonl").write_text("{}", encoding="utf-8")
    assert app_module._session_exists("qwen", "/irrelevant", "sid-2") is True
