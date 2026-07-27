"""Phase B (simplification): readers/attribution/preflight scan ONE real home.

A managed account's pane still runs with its CLI config home relocated to an
isolated per-account home (credential_vault.prepare_profile_home), but only the
credentials stay isolated — ``projects``/``sessions``/``.grok/grok.db`` are
symlinked back to the user's real home. So every account's sessions resolve into
the single default root, and the readers/attribution/resume-preflight no longer
enumerate profile homes separately.

These tests assert (a) the reader scans exactly the single default root,
(b) a session in the (shared) real home is found, attributed and resumable, and
(c) a session that lives ONLY under an un-symlinked profile home is NOT picked
up — proving the redundant multi-root scan is gone. The ``profiles_root`` fixture
drops a profile home on disk purely to exercise that negative case.
"""

from __future__ import annotations

import json
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
    """Point profile-home enumeration at a tmp dir so a stray profile home on
    the dev machine can never leak into these tests."""
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

def test_claude_project_dirs_single_default_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    default = tmp_path / "default" / "projects"
    default.mkdir(parents=True)
    # A profile home exists on disk but is NOT separately scanned.
    (_profile_home(profiles_root, "claude", "acct1") / "projects").mkdir(parents=True)
    reader = ClaudeLogReader()
    assert reader.project_dirs() == [default]


def test_claude_shared_home_session_scanned_not_profile_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    root = tmp_path / "default" / "projects"
    reader = ClaudeLogReader()
    ws = "/Users/me/proj"
    encoded = encode_claude_cwd(ws)

    # Managed-account session reaches the real home via the projects symlink.
    shared = root / encoded / "sess-1.jsonl"
    _write_jsonl(shared, [{
        "type": "assistant", "requestId": "r1",
        "message": {"id": "m1", "model": "claude-opus-4-8",
                    "usage": {"input_tokens": 10, "output_tokens": 5}},
    }])
    # A session that lives ONLY under an un-symlinked profile home is invisible.
    orphan = _profile_home(profiles_root, "claude", "acct1") / "projects" / encoded / "orphan.jsonl"
    _write_jsonl(orphan, [{"type": "x"}])

    files = reader.session_files()
    assert shared in files
    assert orphan not in files
    assert reader.session_files_for_workspace(ws) == [shared]


def test_claude_attribution_credits_shared_home_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "default"))
    (tmp_path / "default" / "projects").mkdir(parents=True)
    reader = ClaudeLogReader()
    attr = Attribution([reader])
    ws = "/Users/me/proj"
    attr.register_workspace(ws)

    encoded = encode_claude_cwd(ws)
    file_path = str(tmp_path / "default" / "projects" / encoded / "sess-1.jsonl")
    usage = TokenUsage(
        vendor="claude", input_tokens=1, output_tokens=1,
        cwd=ws, session_id="sess-1", file_path=file_path, dedup_key="k1",
    )
    assert attr._lookup_workspace_for(usage) == ws


def test_claude_preflight_sees_shared_home_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    """A claude session in the shared real home (~/.claude, where a managed
    account's projects symlink back to) passes resume preflight; one that exists
    only under a profile home does not (single-root check)."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = "/Users/me/proj"
    encoded = encode_claude_cwd(ws)
    _write_jsonl(
        tmp_path / ".claude" / "projects" / encoded / "abc123.jsonl", [{"type": "x"}]
    )
    # Only under a profile home → invisible to the single-root preflight.
    _write_jsonl(
        _profile_home(profiles_root, "claude", "acct1") / "projects" / encoded / "prof.jsonl",
        [{"type": "x"}],
    )

    assert app._session_exists("claude", ws, "abc123") is True
    assert app._session_exists("claude", ws, "prof") is False
    assert app._session_exists("claude", ws, "does-not-exist") is False


# ── kimi ──────────────────────────────────────────────────────────────────────

def _kimi_wire(home: Path, workdir: str, sid: str) -> Path:
    sdir = home / "sessions" / "wd_abc" / sid
    sdir.mkdir(parents=True, exist_ok=True)
    (sdir / "state.json").write_text(json.dumps({"workDir": workdir}), encoding="utf-8")
    return sdir / "agents" / "main" / "wire.jsonl"


def test_kimi_project_dirs_single_default_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    home = tmp_path / ".kimi-code"
    monkeypatch.setenv("KIMI_CODE_HOME", str(home))
    (home / "sessions").mkdir(parents=True)
    reader = KimiLogReader()
    assert reader.project_dirs() == [home / "sessions"]


def test_kimi_shared_home_session_scanned_not_profile_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    monkeypatch.setenv("KIMI_CODE_HOME", str(tmp_path / ".kimi-code"))
    (tmp_path / ".kimi-code" / "sessions").mkdir(parents=True)
    reader = KimiLogReader()

    shared = _kimi_wire(tmp_path / ".kimi-code", "/ws", "session_abcdef")
    _write_jsonl(shared, [{"type": "x"}])
    orphan = _kimi_wire(
        _profile_home(profiles_root, "kimi", "acct1"), "/ws", "session_orphan"
    )
    _write_jsonl(orphan, [{"type": "x"}])

    assert shared in reader.session_files()
    assert orphan not in reader.session_files()
    assert reader.has_session("session_abcdef") is True
    assert reader.has_session("session_orphan") is False


# ── grok ──────────────────────────────────────────────────────────────────────

def test_grok_dirs_single_default_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profiles_root: Path
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    # A profile home exists on disk but is not part of the scan set.
    (_profile_home(profiles_root, "grok", "acct1") / ".grok").mkdir(parents=True)
    reader = GrokLogReader()
    assert reader._grok_dirs() == [tmp_path / ".grok"]


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
