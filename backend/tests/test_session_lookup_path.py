"""Resume preflight exposes the exact path it checks, for diagnosability.

A resume that reports "not found" now logs/returns the filesystem path it
looked at. This pins the claude cwd encoding (non-ASCII chars — e.g. a Chinese
folder name — collapse to '-', which is how four different Chinese workspaces
can collide in one ~/.claude/projects dir) and the existence check.
"""

import os

from agent_team_backend.app import _session_exists, _session_lookup_path


def test_claude_path_encodes_non_ascii_to_dashes():
    p = _session_lookup_path("claude", "/Users/x/Desktop/客戶名單", "sid1")
    # 4 Chinese chars + the leading slash → 5 dashes; the name is NOT preserved
    assert p.endswith("/-Users-x-Desktop-----/sid1.jsonl")
    assert "客戶名單" not in p


def test_claude_path_strips_trailing_slash():
    p = _session_lookup_path("claude", "/Users/x/Desktop/proj/", "sid1")
    assert p.endswith("/-Users-x-Desktop-proj/sid1.jsonl")  # no extra trailing dash


def test_antigravity_path_is_the_conversation_db():
    p = _session_lookup_path("antigravity", "/ws", "conv9")
    assert p.endswith("/.gemini/antigravity-cli/conversations/conv9.db")


def test_qwen_path_is_the_project_chats_file(monkeypatch):
    """Qwen reuses Claude's cwd encoding under <root>/projects/<encoded>/chats/."""
    monkeypatch.delenv("QWEN_RUNTIME_DIR", raising=False)
    p = _session_lookup_path("qwen", "/Users/x/Desktop/proj/", "sid1")
    assert p.endswith("/.qwen/projects/-Users-x-Desktop-proj/chats/sid1.jsonl")


def test_copilot_path_is_the_session_events_file(monkeypatch):
    """Copilot's session dir is named by the id alone, so the path is
    directly constructible: <root>/session-state/<id>/events.jsonl."""
    monkeypatch.delenv("COPILOT_HOME", raising=False)
    p = _session_lookup_path("copilot", "/ws", "sid1")
    assert p.endswith("/.copilot/session-state/sid1/events.jsonl")


def test_vendor_managed_agents_have_no_single_path():
    assert _session_lookup_path("codex", "/ws", "sid1") == ""
    assert _session_lookup_path("grok", "/ws", "sid1") == ""
    assert _session_lookup_path("opencode", "/ws", "sid1") == ""
    assert _session_lookup_path("kilo", "/ws", "sid1") == ""
    # Pi's filename carries a timestamp prefix the id alone can't reconstruct.
    assert _session_lookup_path("pi", "/ws", "sid1") == ""
    # Cursor's path has a <project-hash> segment the id alone can't name.
    assert _session_lookup_path("cursor", "/ws", "sid1") == ""


def test_empty_session_has_no_path():
    assert _session_lookup_path("claude", "/ws", "") == ""
    assert _session_lookup_path("claude", "/ws", "   ") == ""


def test_session_exists_tracks_the_looked_up_file(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    ws = "/Users/x/Desktop/客戶名單"
    sid = "sid-abc"
    assert _session_exists("claude", ws, sid) is False  # nothing on disk yet
    # Create exactly the file the lookup path names, then it must be found.
    target = tmp_path / ".claude" / "projects" / "-Users-x-Desktop-----" / f"{sid}.jsonl"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("{}\n")
    assert _session_lookup_path("claude", ws, sid) == str(target)
    assert _session_exists("claude", ws, sid) is True
