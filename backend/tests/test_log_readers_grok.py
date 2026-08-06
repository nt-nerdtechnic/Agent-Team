"""GrokLogReader: usage_events token parsing + at-pane marker session binding.

Fixture schema mirrors grok-cli's src/storage/migrations.ts (v1.1.7):
workspaces / sessions / messages / usage_events, single shared db at
~/.grok/grok.db.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from agent_team_backend.log_readers import GrokLogReader, TokenUsage
from agent_team_backend.log_readers.attribution import Attribution

_SCHEMA = """
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  canonical_path TEXT NOT NULL,
  git_root TEXT,
  display_name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT,
  recap_text TEXT,
  recap_model TEXT,
  recap_updated_at TEXT,
  model TEXT NOT NULL,
  mode TEXT NOT NULL,
  cwd_at_start TEXT NOT NULL,
  cwd_last TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_seq INTEGER,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
"""

_NOW = "2026-07-10T00:00:00.000Z"


def _reader_rooted_at(tmp_path: Path, monkeypatch) -> GrokLogReader:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / ".grok").mkdir()
    return GrokLogReader()


def _create_db(path: Path, *, wal: bool = True) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    if wal:
        con.execute("PRAGMA journal_mode=WAL")
    con.executescript(_SCHEMA)
    con.commit()
    return con


def _add_workspace(con: sqlite3.Connection, ws_id: str, scope_key: str) -> None:
    con.execute(
        "INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)",
        (ws_id, scope_key, scope_key, scope_key, Path(scope_key).name, _NOW),
    )
    con.commit()


def _add_session(con: sqlite3.Connection, sid: str, ws_id: str, cwd: str) -> None:
    con.execute(
        "INSERT INTO sessions (id, workspace_id, model, mode, cwd_at_start,"
        " cwd_last, status, created_at, updated_at)"
        " VALUES (?, ?, 'grok-4.3', 'chat', ?, ?, 'active', ?, ?)",
        (sid, ws_id, cwd, cwd, _NOW, _NOW),
    )
    con.commit()


def _add_message(con: sqlite3.Connection, sid: str, seq: int, text: str) -> None:
    con.execute(
        "INSERT INTO messages VALUES (?, ?, 'user', ?, ?)",
        (sid, seq, json.dumps({"role": "user", "content": text}), _NOW),
    )
    con.commit()


def _add_usage(
    con: sqlite3.Connection, sid: str, inp: int, out: int, model: str = "grok-4.3"
) -> None:
    con.execute(
        "INSERT INTO usage_events (session_id, message_seq, source, model,"
        " input_tokens, output_tokens, total_tokens, created_at)"
        " VALUES (?, 1, 'agent', ?, ?, ?, ?, ?)",
        (sid, model, inp, out, inp + out, _NOW),
    )
    con.commit()


def _session_sink_usage(db: Path) -> TokenUsage:
    """The placeholder usage app._on_session_file builds for a db change."""
    return TokenUsage(
        vendor="grok", input_tokens=0, output_tokens=0, cwd="",
        session_id=db.stem, file_path=str(db), dedup_key="",
    )


# ── tolerance ────────────────────────────────────────────────────────────────

def test_missing_db_silently_skips(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    reader = GrokLogReader()  # no ~/.grok at all → CLI not installed
    assert reader.project_dirs() == []
    assert reader.session_files() == []
    assert reader.parse_session_file(tmp_path / ".grok" / "grok.db", set()) == []
    assert reader.find_sessions_by_marker(["at-pane:x"]) == {}


def test_grok_dir_without_db_is_empty(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    assert reader.project_dirs() == [tmp_path / ".grok"]
    assert reader.session_files() == []


def test_non_session_files_under_grok_dir_are_ignored(
    tmp_path: Path, monkeypatch
) -> None:
    """The watcher routes any .json under ~/.grok here (user-settings.json)."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    settings = tmp_path / ".grok" / "user-settings.json"
    settings.write_text('{"apiKey": "x"}')
    assert reader.parse_session_file(settings, set()) == []


def test_locked_db_treated_as_no_new_data(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = tmp_path / ".grok" / "grok.db"
    # Rollback-journal mode so BEGIN EXCLUSIVE actually blocks readers
    # (WAL never blocks them — covered by the live-WAL parse tests).
    con = _create_db(db, wal=False)
    _add_workspace(con, "w" * 16, str(tmp_path / "ws"))
    _add_session(con, "a" * 12, "w" * 16, str(tmp_path / "ws"))
    _add_usage(con, "a" * 12, 10, 5)
    con.execute("BEGIN EXCLUSIVE")
    try:
        seen: set[str] = set()
        assert reader.parse_session_file(db, seen) == []
        assert seen == set()  # nothing marked seen → retried next cycle
    finally:
        con.rollback()
        con.close()


# ── usage parsing + dedup ────────────────────────────────────────────────────

def test_parse_usage_events(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "proj"
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    _add_workspace(con, "1f2e3d4c5b6a7980", str(ws))
    _add_session(con, "abc123def456", "1f2e3d4c5b6a7980", str(ws))
    _add_usage(con, "abc123def456", 100, 40)
    _add_usage(con, "abc123def456", 220, 9, model="grok-4.3-mini")

    seen: set[str] = set()
    events = reader.parse_session_file(db, seen)  # writer con still open (WAL)
    con.close()

    assert [(e.input_tokens, e.output_tokens) for e in events] == [(100, 40), (220, 9)]
    for e in events:
        assert e.vendor == "grok"
        assert e.session_id == "abc123def456"
        assert e.cwd == str(ws)  # workspaces.scope_key via sessions join
        assert e.file_path == str(db)
    assert events[0].model == "grok-4.3"
    assert events[1].model == "grok-4.3-mini"
    assert len({e.dedup_key for e in events}) == 2


def test_parse_dedups_by_row_id_across_calls(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "proj"
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    _add_workspace(con, "w" * 16, str(ws))
    _add_session(con, "abc123def456", "w" * 16, str(ws))
    _add_usage(con, "abc123def456", 10, 2)

    seen: set[str] = set()
    assert len(reader.parse_session_file(db, seen)) == 1
    # Same rows again → nothing new.
    assert reader.parse_session_file(db, seen) == []
    # A new turn lands → only the new row is emitted.
    _add_usage(con, "abc123def456", 30, 7)
    con.close()
    events = reader.parse_session_file(db, seen)
    assert [(e.input_tokens, e.output_tokens) for e in events] == [(30, 7)]


def test_zero_token_rows_are_skipped_but_marked_seen(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "proj"
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    _add_workspace(con, "w" * 16, str(ws))
    _add_session(con, "abc123def456", "w" * 16, str(ws))
    _add_usage(con, "abc123def456", 0, 0)
    con.close()

    seen: set[str] = set()
    assert reader.parse_session_file(db, seen) == []
    assert len(seen) == 1  # row consumed, not re-visited next cycle


def test_incremental_parse_uses_row_id_watermark(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "proj"
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    _add_workspace(con, "w" * 16, str(ws))
    _add_session(con, "abc123def456", "w" * 16, str(ws))
    _add_usage(con, "abc123def456", 10, 2)
    first = reader.parse_incremental(db, {})
    assert len(first.events) == 1
    assert first.checkpoint["row_id"] == 1

    _add_usage(con, "abc123def456", 30, 7)
    con.close()
    second = reader.parse_incremental(db, first.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in second.events] == [(30, 7)]
    assert second.checkpoint["row_id"] == 2


def test_incremental_parse_resets_row_watermark_for_replaced_db(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "proj"
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    _add_workspace(con, "w" * 16, str(ws))
    _add_session(con, "abc123def456", "w" * 16, str(ws))
    _add_usage(con, "abc123def456", 10, 2)
    con.close()
    first = reader.parse_incremental(db, {})

    db.unlink()
    replacement = _create_db(db)
    _add_workspace(replacement, "w" * 16, str(ws))
    _add_session(replacement, "abc123def456", "w" * 16, str(ws))
    _add_usage(replacement, "abc123def456", 30, 7)
    replacement.close()
    second = reader.parse_incremental(db, first.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in second.events] == [(30, 7)]
    assert second.checkpoint["identity"] != first.checkpoint["identity"]


# ── marker detection / session binding ──────────────────────────────────────

def test_marker_binding_announces_grok_session(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    marker = "at-pane:pane-grok-1"
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    _add_workspace(con, "w" * 16, str(ws))
    _add_session(con, "1f9e02aabb3c", "w" * 16, str(ws))
    _add_message(con, "1f9e02aabb3c", 1, f"kickoff…\nsession marker: {marker}\n")

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-grok-1", vendor="grok", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )

    binding = attr.maybe_announce_session(_session_sink_usage(db))
    con.close()

    assert binding is not None
    assert binding.pane_id == "pane-grok-1"
    # Resume id is the sessions.id (12-hex) that `grok -s <id>` accepts.
    assert binding.resume_id == "1f9e02aabb3c"
    assert binding.workspace_path == str(ws)
    # Binding is a transition: the same db event never re-announces.
    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


def test_marker_in_other_workspace_does_not_bind(tmp_path: Path, monkeypatch) -> None:
    """A marker echoed in a session of ANOTHER project must not cross-bind."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    pane_ws = tmp_path / "pane-ws"
    pane_ws.mkdir()
    other_ws = tmp_path / "other-ws"
    marker = "at-pane:pane-grok-2"
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    _add_workspace(con, "o" * 16, str(other_ws))
    _add_session(con, "ffee00112233", "o" * 16, str(other_ws))
    _add_message(con, "ffee00112233", 1, f"pasted text with {marker}")
    con.close()

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-grok-2", vendor="grok", cwd=str(pane_ws),
        workspace_path=str(pane_ws), session_marker=marker,
    )

    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


def test_two_panes_bind_their_own_markers(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    _add_workspace(con, "w" * 16, str(ws))
    _add_session(con, "aaaaaaaaaaa1", "w" * 16, str(ws))
    _add_session(con, "bbbbbbbbbbb2", "w" * 16, str(ws))
    _add_message(con, "aaaaaaaaaaa1", 1, "kickoff at-pane:pane-a")
    _add_message(con, "bbbbbbbbbbb2", 1, "kickoff at-pane:pane-b")
    con.close()

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane("pane-a", vendor="grok", cwd=str(ws),
                       workspace_path=str(ws), session_marker="at-pane:pane-a")
    attr.register_pane("pane-b", vendor="grok", cwd=str(ws),
                       workspace_path=str(ws), session_marker="at-pane:pane-b")

    # One binding per db event; the watcher fires again on the next write.
    first = attr.maybe_announce_session(_session_sink_usage(db))
    second = attr.maybe_announce_session(_session_sink_usage(db))
    assert first is not None and second is not None
    bound = {b.pane_id: b.resume_id for b in (first, second)}
    assert bound == {"pane-a": "aaaaaaaaaaa1", "pane-b": "bbbbbbbbbbb2"}
    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


# ---- parse_activity: turn boundaries in a shared, multi-session db ----


def _add_role_message(
    con: sqlite3.Connection, sid: str, seq: int, role: str, text: str,
    created_at: str = _NOW,
) -> None:
    con.execute(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?)",
        (sid, seq, role, json.dumps({"role": role, "content": text}), created_at),
    )
    con.commit()


def _grok_db_with_session(tmp_path: Path, monkeypatch) -> tuple[GrokLogReader, Path, sqlite3.Connection]:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = tmp_path / ".grok" / "grok.db"
    con = _create_db(db)
    ws = tmp_path / "proj"
    ws.mkdir(exist_ok=True)
    _add_workspace(con, "w" * 16, str(ws))
    _add_session(con, "aaaaaaaaaaa1", "w" * 16, str(ws))
    return reader, db, con


def _completes(events) -> list[tuple[str, str, str]]:
    return [
        (e.dedup_key, e.detail, e.text) for e in events
        if e.event_type == "turn_complete"
    ]


def test_parse_activity_completes_a_turn_with_the_assistant_reply(
    tmp_path: Path, monkeypatch
) -> None:
    """Grok has no end-of-turn record, so the turn is closed by the session
    going quiet — and must carry the reply for the messaging protocol."""
    reader, db, con = _grok_db_with_session(tmp_path, monkeypatch)
    _add_role_message(con, "aaaaaaaaaaa1", 1, "user", "ask reviewer to take over")
    _add_role_message(con, "aaaaaaaaaaa1", 2, "assistant", "looking into it")
    _add_role_message(con, "aaaaaaaaaaa1", 3, "assistant", "done, handing over")
    con.close()
    # _NOW is far in the past relative to the real clock, so the session reads
    # as quiet without having to move time.
    assert _completes(reader.parse_activity(db, set())) == [
        ("turn:aaaaaaaaaaa1:0", "idle", "done, handing over")
    ]


def test_parse_activity_open_turn_stays_open_while_the_session_is_live(
    tmp_path: Path, monkeypatch
) -> None:
    import agent_team_backend.log_readers.grok as grok_mod

    reader, db, con = _grok_db_with_session(tmp_path, monkeypatch)
    _add_role_message(con, "aaaaaaaaaaa1", 1, "user", "go")
    _add_role_message(con, "aaaaaaaaaaa1", 2, "assistant", "working")
    con.close()
    # Pretend now is right after the messages were written.
    monkeypatch.setattr(
        grok_mod.time, "time", lambda: grok_mod._epoch(_NOW) + 1.0
    )
    assert _completes(reader.parse_activity(db, set())) == []


def test_parse_activity_next_user_message_closes_the_previous_turn(
    tmp_path: Path, monkeypatch
) -> None:
    import agent_team_backend.log_readers.grok as grok_mod

    reader, db, con = _grok_db_with_session(tmp_path, monkeypatch)
    _add_role_message(con, "aaaaaaaaaaa1", 1, "user", "first")
    _add_role_message(con, "aaaaaaaaaaa1", 2, "assistant", "answer one")
    _add_role_message(con, "aaaaaaaaaaa1", 3, "user", "second")
    con.close()
    monkeypatch.setattr(grok_mod.time, "time", lambda: grok_mod._epoch(_NOW) + 1.0)
    assert _completes(reader.parse_activity(db, set())) == [
        ("turn:aaaaaaaaaaa1:0", "boundary", "answer one")
    ]


def test_parse_activity_idle_is_per_session_not_per_file(
    tmp_path: Path, monkeypatch
) -> None:
    """One db holds every session. A session that is still being written to
    must not keep another session's finished turn from completing, and the two
    replies must not cross over."""
    import agent_team_backend.log_readers.grok as grok_mod

    reader, db, con = _grok_db_with_session(tmp_path, monkeypatch)
    _add_session(con, "bbbbbbbbbbb2", "w" * 16, str(tmp_path / "proj"))
    quiet, busy = _NOW, "2026-07-10T00:01:00.000Z"
    _add_role_message(con, "aaaaaaaaaaa1", 1, "user", "old", quiet)
    _add_role_message(con, "aaaaaaaaaaa1", 2, "assistant", "quiet reply", quiet)
    _add_role_message(con, "bbbbbbbbbbb2", 1, "user", "new", busy)
    _add_role_message(con, "bbbbbbbbbbb2", 2, "assistant", "busy reply", busy)
    con.close()
    # Now sits just after the busy session's last write: session a is long
    # past the idle window, session b is still inside it.
    monkeypatch.setattr(grok_mod.time, "time", lambda: grok_mod._epoch(busy) + 1.0)
    assert _completes(reader.parse_activity(db, set())) == [
        ("turn:aaaaaaaaaaa1:0", "idle", "quiet reply")
    ]


def test_parse_activity_reparse_does_not_reemit(tmp_path: Path, monkeypatch) -> None:
    reader, db, con = _grok_db_with_session(tmp_path, monkeypatch)
    _add_role_message(con, "aaaaaaaaaaa1", 1, "user", "go")
    _add_role_message(con, "aaaaaaaaaaa1", 2, "assistant", "done")
    con.close()
    seen: set[str] = set()
    assert len(_completes(reader.parse_activity(db, seen))) == 1
    assert reader.parse_activity(db, seen) == []


def test_parse_activity_ignores_non_session_files(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    settings = tmp_path / ".grok" / "user-settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text("{}", encoding="utf-8")
    assert reader.parse_activity(settings, set()) == []
