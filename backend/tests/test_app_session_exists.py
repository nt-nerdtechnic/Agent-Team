from __future__ import annotations

from pathlib import Path

from agent_team_backend.app import _session_exists
from agent_team_backend.cli_vendors import codex as codex_vendor
from agent_team_backend.codex_home import CodexHomeManager


def test_claude_session_exists_checks_workspace_transcript(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = "/Users/neillu/Desktop/Agent-Team-main/01-web"
    session_id = "sess-123"
    transcript = (
        tmp_path
        / ".claude"
        / "projects"
        / "-Users-neillu-Desktop-Agent-Team-main-01-web"
        / f"{session_id}.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")

    assert _session_exists("claude", ws, session_id) is True
    assert _session_exists("claude", ws, "missing") is False


def test_claude_session_file_encodes_non_alphanumeric_chars(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Claude Code turns every non-alphanumeric cwd char into '-', not just '/'."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = "/Users/neillu/Desktop/AI Coding/my.app_v2"
    session_id = "sess-456"
    transcript = (
        tmp_path
        / ".claude"
        / "projects"
        / "-Users-neillu-Desktop-AI-Coding-my-app-v2"
        / f"{session_id}.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")

    assert _session_exists("claude", ws, session_id) is True


def test_claude_session_exists_tolerates_trailing_slash(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """A trailing slash on the workspace path must not break resume lookup.

    Claude encodes its normalized cwd (no trailing separator); the frontend may
    pass a path with one. Without rstrip the extra '-' misses the real dir.
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    ws = "/Users/neillu/Desktop/Agent-Team"
    session_id = "sess-789"
    transcript = (
        tmp_path
        / ".claude"
        / "projects"
        / "-Users-neillu-Desktop-Agent-Team"
        / f"{session_id}.jsonl"
    )
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n", encoding="utf-8")

    assert _session_exists("claude", ws + "/", session_id) is True
    assert _session_exists("claude", ws, session_id) is True


def test_codex_session_exists_checks_real_and_pane_homes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    real_home = tmp_path / "real-codex"
    real_session = real_home / "sessions" / "2026" / "07" / "14"
    real_session.mkdir(parents=True)
    (real_session / "rollout-real-session.jsonl").write_text("{}\n", encoding="utf-8")

    panes_root = tmp_path / "codex-panes"
    pane_session = panes_root / "pane-1" / "sessions" / "2026" / "07" / "14"
    pane_session.mkdir(parents=True)
    (pane_session / "rollout-pane-session.jsonl").write_text("{}\n", encoding="utf-8")

    manager = CodexHomeManager(real_home=real_home, panes_root=panes_root)
    monkeypatch.setattr("agent_team_backend.app.codex_home_manager", manager)
    monkeypatch.setattr(codex_vendor, "CodexHomeManager", lambda **kw: manager)

    assert _session_exists("codex", "/tmp/ws", "real-session") is True
    assert _session_exists("codex", "/tmp/ws", "pane-session") is True
    assert _session_exists("codex", "/tmp/ws", "missing-session") is False
    assert _session_exists("codex", "/tmp/ws", "") is False
    assert _session_exists("codex", "/tmp/ws", "../unsafe") is False


def test_antigravity_session_checks_conversation_db(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    session_id = "286db9c5-814a-4391-9244-ae51bd0083d8"
    db = tmp_path / ".gemini" / "antigravity-cli" / "conversations" / f"{session_id}.db"
    db.parent.mkdir(parents=True)
    db.write_bytes(b"")

    assert _session_exists("antigravity", "/tmp/ws", session_id) is True
    assert _session_exists("antigravity", "/tmp/ws", "missing-id") is False


def test_opencode_session_checks_shared_db(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import sqlite3

    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    session_id = "ses_18d0acbcaffe3eXy2s3zezEmix"
    db = tmp_path / "xdg" / "opencode" / "opencode.db"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)")
    con.execute("INSERT INTO session VALUES (?, '/ws')", (session_id,))
    con.commit()
    con.close()

    assert _session_exists("opencode", "/tmp/ws", session_id) is True
    assert _session_exists("opencode", "/tmp/ws", "ses_missing") is False


def test_kilo_session_checks_shared_db(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Kilo Code (OpenCode fork) likewise keeps every session in one shared
    db — <XDG_DATA_HOME>/kilo/kilo.db."""
    import sqlite3

    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    session_id = "ses_29e1bcdcaffe3eXy2s3zezKilo"
    db = tmp_path / "xdg" / "kilo" / "kilo.db"
    db.parent.mkdir(parents=True)
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)")
    con.execute("INSERT INTO session VALUES (?, '/ws')", (session_id,))
    con.commit()
    con.close()

    assert _session_exists("kilo", "/tmp/ws", session_id) is True
    assert _session_exists("kilo", "/tmp/ws", "ses_missing") is False


def test_qwen_session_checks_chats_and_archive(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Qwen sessions live at <root>/projects/<encoded-cwd>/chats/<id>.jsonl;
    archived sessions move to chats/archive/ but remain history."""
    monkeypatch.setenv("QWEN_RUNTIME_DIR", str(tmp_path / ".qwen"))
    chats = tmp_path / ".qwen" / "projects" / "-ws" / "chats"
    (chats / "archive").mkdir(parents=True)
    (chats / "live-id.jsonl").write_text("{}\n", encoding="utf-8")
    (chats / "archive" / "old-id.jsonl").write_text("{}\n", encoding="utf-8")

    assert _session_exists("qwen", "/ws", "live-id") is True
    assert _session_exists("qwen", "/ws", "old-id") is True
    assert _session_exists("qwen", "/ws", "missing-id") is False


def test_pi_session_scans_session_dirs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Pi sessions live at <root>/--<encoded-cwd>--/<timestamp>_<id>.jsonl;
    the timestamp prefix means no single path can be built from the id, so
    the preflight scans session dirs and verifies the line-1 header id."""
    import json

    root = tmp_path / "pi-sessions"
    monkeypatch.setenv("PI_CODING_AGENT_SESSION_DIR", str(root))
    d = root / "--ws--"
    d.mkdir(parents=True)
    header = {"type": "session", "version": 3, "id": "sid-live", "cwd": "/ws"}
    (d / "2026-07-27T10-00-00-000Z_sid-live.jsonl").write_text(
        json.dumps(header) + "\n", encoding="utf-8"
    )

    assert _session_exists("pi", "/ws", "sid-live") is True
    assert _session_exists("pi", "/ws", "missing-id") is False


def test_copilot_session_path_from_id(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Copilot sessions live at <root>/session-state/<id>/events.jsonl — the
    id alone names the path. Preflight matters like Pi's: a stale id must
    fail fast because `copilot --resume=<stale-id>` silently starts a blank
    NEW session under that UUID."""
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path / ".copilot"))
    d = tmp_path / ".copilot" / "session-state" / "sid-live"
    d.mkdir(parents=True)
    (d / "events.jsonl").write_text("{}\n", encoding="utf-8")

    assert _session_exists("copilot", "/ws", "sid-live") is True
    assert _session_exists("copilot", "/ws", "missing-id") is False


def test_cursor_session_globs_across_project_hashes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """Cursor sessions live at ~/.cursor/chats/<project-hash>/<id>/store.db;
    the hash segment is not reliably derivable from the workspace, so the
    preflight globs every project dir for the id."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    sid = "e6495800-dfd4-4a75-b2ab-d70980f83b89"
    d = tmp_path / ".cursor" / "chats" / ("a" * 32) / sid
    d.mkdir(parents=True)
    (d / "store.db").write_bytes(b"")

    assert _session_exists("cursor", "/ws", sid) is True
    assert _session_exists(
        "cursor", "/ws", "0198f6a2-71aa-4d02-9c11-2233445566aa"
    ) is False
    assert _session_exists("cursor", "/ws", "not-a-uuid") is False


def test_aider_session_exists_iff_workspace_history_file_exists(
    tmp_path: Path,
) -> None:
    """Aider's resume (`aider --restore-chat-history`) takes no id, so ANY
    recorded slug is restorable exactly when the workspace's history file
    exists — a slug matching no section still passes (lossy by design)."""
    ws = tmp_path / "proj"
    ws.mkdir()
    slug = "aider-20260728-213045"
    assert _session_exists("aider", str(ws), slug) is False

    (ws / ".aider.chat.history.md").write_text(
        "# aider chat started at 2026-07-28 21:30:45\n", encoding="utf-8"
    )
    assert _session_exists("aider", str(ws), slug) is True
    # Mismatched id is still restorable — restore reads the whole file.
    assert _session_exists("aider", str(ws), "aider-19990101-000000") is True
