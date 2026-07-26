"""Phase 1 (isolation groundwork): CLI-profile-aware log readers, attribution,
resume preflight and watcher.

A regular pane on a managed account runs with its CLI config home relocated to
that account's persistent isolated home under
``<profiles_root>/<agent>/<id>/home`` (credential_vault.prepare_profile_home).
These tests assert every reader now finds sessions under a profile home, that
attribution credits them to the workspace, that the claude resume preflight
sees them (the crash-loop gate of pitfalls.md), that the watcher can subscribe
to a new home, and — the hard regression — that with NO profile the behavior is
byte-for-byte unchanged.

Enumeration is scan-based (profiles_store.profile_config_homes), so these tests
just point ``default_profiles_root`` at a tmp dir and drop homes under it.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend import app, profiles_store
from agent_team_backend.log_readers import ClaudeLogReader, GrokLogReader, KimiLogReader
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage
from agent_team_backend.log_readers.claude import encode_claude_cwd
from agent_team_backend.log_readers.watcher import LogWatcher


@pytest.fixture()
def profiles_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point profile-home enumeration at a tmp dir for every reader/preflight."""
    root = tmp_path / "cli-profiles"
    monkeypatch.setattr(profiles_store, "default_profiles_root", lambda: root)
    return root


def _profile_home(root: Path, agent_key: str, profile_id: str) -> Path:
    return root / agent_key / profile_id / profiles_store.PROFILE_HOME_DIRNAME


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


# ── claude ────────────────────────────────────────────────────────────────────

def test_claude_no_profile_project_dirs_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    default = tmp_path / "default" / "projects"
    default.mkdir(parents=True)
    reader = ClaudeLogReader()
    # No profile home exists → exactly the single default root, as before.
    assert reader.project_dirs() == [default]


def test_claude_profile_home_scanned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    (tmp_path / "default" / "projects").mkdir(parents=True)
    reader = ClaudeLogReader()

    home = _profile_home(profiles_root, "claude", "acct1")
    ws = "/Users/me/proj"
    encoded = encode_claude_cwd(ws)
    session = home / "projects" / encoded / "sess-1.jsonl"
    _write_jsonl(session, [{
        "type": "assistant", "requestId": "r1",
        "message": {"id": "m1", "model": "claude-opus-4-8",
                    "usage": {"input_tokens": 10, "output_tokens": 5}},
    }])

    assert (home / "projects") in reader.project_dirs()
    assert session in reader.session_files()
    assert session in reader.session_files_for_workspace(ws)


def test_claude_attribution_credits_profile_home_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    # claude_dir is pinned to the DEFAULT root; the session lives in a profile
    # home, so only the restored profile-home loop can attribute it.
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    (tmp_path / "default" / "projects").mkdir(parents=True)
    reader = ClaudeLogReader()
    attr = Attribution([reader])
    ws = "/Users/me/proj"
    attr.register_workspace(ws)

    home = _profile_home(profiles_root, "claude", "acct1")
    encoded = encode_claude_cwd(ws)
    (home / "projects" / encoded).mkdir(parents=True)
    file_path = str(home / "projects" / encoded / "sess-1.jsonl")

    usage = TokenUsage(
        vendor="claude", input_tokens=1, output_tokens=1,
        cwd=ws, session_id="sess-1", file_path=file_path, dedup_key="k1",
    )
    assert attr._lookup_workspace_for(usage) == ws


def test_claude_preflight_sees_profile_home_no_crash_loop(
    profiles_root: Path,
) -> None:
    """Crash-loop gate: a claude session written under the profile isolated
    home must pass resume preflight, so a restore does not launch a
    ``--resume`` that dies with "No conversation found"."""
    ws = "/Users/me/proj"
    home = _profile_home(profiles_root, "claude", "acct1")
    encoded = encode_claude_cwd(ws)
    _write_jsonl(home / "projects" / encoded / "abc123.jsonl", [{"type": "x"}])

    assert app._session_exists("claude", ws, "abc123") is True
    # A bogus id in the same workspace still fails preflight.
    assert app._session_exists("claude", ws, "does-not-exist") is False


# ── kimi ──────────────────────────────────────────────────────────────────────

def _kimi_wire(home: Path, workdir: str, sid: str) -> Path:
    sdir = home / "sessions" / "wd_abc" / sid
    sdir.mkdir(parents=True, exist_ok=True)
    (sdir / "state.json").write_text(json.dumps({"workDir": workdir}), encoding="utf-8")
    return sdir / "agents" / "main" / "wire.jsonl"


def test_kimi_no_profile_roots_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    home = tmp_path / ".kimi-code"
    monkeypatch.setenv("KIMI_CODE_HOME", str(home))
    (home / "sessions").mkdir(parents=True)
    reader = KimiLogReader()
    assert reader.project_dirs() == [home / "sessions"]


def test_kimi_profile_home_scanned_and_resumable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    monkeypatch.setenv("KIMI_CODE_HOME", str(tmp_path / ".kimi-code"))
    (tmp_path / ".kimi-code" / "sessions").mkdir(parents=True)
    reader = KimiLogReader()

    home = _profile_home(profiles_root, "kimi", "acct1")
    wire = _kimi_wire(home, "/ws", "session_abcdef")
    _write_jsonl(wire, [{"type": "x"}])

    assert (home / "sessions") in reader.project_dirs()
    assert wire in reader.session_files()
    assert reader.has_session("session_abcdef") is True


# ── grok ──────────────────────────────────────────────────────────────────────

def _grok_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE sessions (id INTEGER)")
    con.commit()
    con.close()


def test_grok_no_profile_dirs_unchanged(profiles_root: Path) -> None:
    reader = GrokLogReader()
    assert reader._grok_dirs() == [Path.home() / ".grok"]


def test_grok_profile_home_scanned(profiles_root: Path) -> None:
    reader = GrokLogReader()
    home = _profile_home(profiles_root, "grok", "acct1")
    db = home / ".grok" / "grok.db"
    _grok_db(db)

    assert (home / ".grok") in reader._grok_dirs()
    assert db in reader.session_files()


# ── watcher ───────────────────────────────────────────────────────────────────

async def test_watcher_watch_dir_subscribes_new_home(tmp_path: Path) -> None:
    watcher = LogWatcher(sink=lambda *a, **k: None)
    # Not started → refuses (no observer/handler yet).
    assert watcher.watch_dir(tmp_path) is False
    watcher.start()
    try:
        home = tmp_path / "new-home"
        home.mkdir()
        assert watcher.watch_dir(home) is True
        assert watcher.watch_dir(home) is False  # deduped
        assert watcher.watch_dir(tmp_path / "missing") is False  # nonexistent
    finally:
        watcher.stop()
