"""OpencodeLogReader: assistant-message token parsing + at-pane marker binding.

Fixture schema mirrors opencode's Drizzle tables (v1.15.12): project / session
/ message / part, single shared db at
<XDG_DATA_HOME|~/.local/share>/opencode/opencode.db. message.data is the
message JSON (assistant rows carry tokens + time.completed and are UPDATEd in
place while streaming); user input text lives verbatim in part.data.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend.log_readers import OpencodeLogReader, TokenUsage
from agent_team_backend.log_readers.attribution import Attribution

_SCHEMA = """
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  worktree TEXT NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  slug TEXT NOT NULL,
  directory TEXT NOT NULL,
  title TEXT,
  version TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  cost REAL
);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
"""

_NOW_MS = 1780045142610
_SID = "ses_18d0acbcaffe3eXy2s3zezEmix"


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    d = tmp_path / "xdg" / "opencode"
    d.mkdir(parents=True)
    return d


def _create_db(path: Path, *, wal: bool = True) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    if wal:
        con.execute("PRAGMA journal_mode=WAL")
    con.executescript(_SCHEMA)
    con.commit()
    return con


def _add_session(
    con: sqlite3.Connection,
    sid: str,
    directory: str,
    *,
    parent_id: str | None = None,
) -> None:
    con.execute(
        "INSERT INTO session (id, project_id, parent_id, slug, directory,"
        " title, version, time_created, time_updated)"
        " VALUES (?, 'proj1', ?, 'slug', ?, 'title', '1.15.12', ?, ?)",
        (sid, parent_id, directory, _NOW_MS, _NOW_MS),
    )
    con.commit()


def _assistant_data(
    tokens: dict | None = None,
    *,
    completed: int | None = _NOW_MS + 15_000,
    model: str = "claude-sonnet-4-5",
) -> dict:
    data = {
        "role": "assistant",
        "mode": "build",
        "agent": "build",
        "modelID": model,
        "providerID": "anthropic",
        "cost": 0,
        "time": {"created": _NOW_MS},
        "tokens": tokens if tokens is not None else {},
    }
    if completed:
        data["time"]["completed"] = completed
        data["finish"] = "stop"
    return data


def _add_message(
    con: sqlite3.Connection, mid: str, sid: str, data: dict
) -> None:
    con.execute(
        "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
        (mid, sid, _NOW_MS, _NOW_MS, json.dumps(data)),
    )
    con.commit()


def _update_message(con: sqlite3.Connection, mid: str, data: dict) -> None:
    con.execute(
        "UPDATE message SET data = ?, time_updated = ? WHERE id = ?",
        (json.dumps(data), _NOW_MS + 20_000, mid),
    )
    con.commit()


def _add_user_turn(
    con: sqlite3.Connection, sid: str, mid: str, text: str
) -> None:
    _add_message(con, mid, sid, {"role": "user", "time": {"created": _NOW_MS}})
    con.execute(
        "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
        (f"prt_{mid}", mid, sid, _NOW_MS, _NOW_MS,
         json.dumps({"type": "text", "text": text})),
    )
    con.commit()


def _session_sink_usage(db: Path) -> TokenUsage:
    """The placeholder usage app._on_session_file builds for a db change."""
    return TokenUsage(
        vendor="opencode", input_tokens=0, output_tokens=0, cwd="",
        session_id=db.stem, file_path=str(db), dedup_key="",
    )


# ── tolerance ────────────────────────────────────────────────────────────────

def test_missing_db_silently_skips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    reader = OpencodeLogReader()  # no data dir at all → CLI not installed
    assert reader.project_dirs() == []
    assert reader.session_files() == []
    db = tmp_path / "xdg" / "opencode" / "opencode.db"
    assert reader.parse_session_file(db, set()) == []
    assert reader.find_sessions_by_marker(["at-pane:x"]) == {}
    assert reader.has_session(_SID) is False


def test_data_dir_without_db_is_empty(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    assert reader.project_dirs() == [data_dir]
    assert reader.session_files() == []


def test_non_session_files_under_data_dir_are_ignored(data_dir: Path) -> None:
    """The watcher routes any .json under the data dir here (auth.json)."""
    reader = OpencodeLogReader()
    auth = data_dir / "auth.json"
    auth.write_text('{"anthropic": {}}')
    assert reader.parse_session_file(auth, set()) == []
    assert reader.session_id_from_path(auth) == ""
    assert reader.session_id_from_path(data_dir / "opencode.db") == "opencode"


# ── usage parsing + dedup ────────────────────────────────────────────────────

def test_parse_folds_cache_into_input_and_reasoning_into_output(
    data_dir: Path,
) -> None:
    reader = OpencodeLogReader()
    ws = str(data_dir.parent / "proj")
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, _SID, ws)
    _add_message(con, "msg_a1", _SID, _assistant_data({
        "total": 13847, "input": 4050, "output": 511, "reasoning": 7,
        "cache": {"write": 475, "read": 8811},
    }))

    seen: set[str] = set()
    events = reader.parse_session_file(db, seen)  # writer con still open (WAL)
    con.close()

    assert len(events) == 1
    e = events[0]
    assert e.vendor == "opencode"
    assert e.input_tokens == 4050 + 8811 + 475
    assert e.output_tokens == 511 + 7
    assert e.cwd == ws
    assert e.session_id == _SID
    assert e.file_path == str(db)
    assert e.model == "claude-sonnet-4-5"
    assert e.dedup_key == "msg:msg_a1"


def test_streaming_assistant_row_counted_only_once_completed(
    data_dir: Path,
) -> None:
    """Assistant rows are UPDATEd in place while a turn streams; tokens are
    credited exactly once — when time.completed lands."""
    reader = OpencodeLogReader()
    ws = str(data_dir.parent / "proj")
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, _SID, ws)
    _add_user_turn(con, _SID, "msg_u1", "hello")
    _add_message(con, "msg_a1", _SID, _assistant_data(
        {"input": 10, "output": 2}, completed=None,
    ))

    seen: set[str] = set()
    assert reader.parse_session_file(db, seen) == []  # still streaming
    _update_message(con, "msg_a1", _assistant_data({"input": 40, "output": 9}))
    con.close()
    events = reader.parse_session_file(db, seen)
    assert [(e.input_tokens, e.output_tokens) for e in events] == [(40, 9)]
    # Same rows again → nothing new.
    assert reader.parse_session_file(db, seen) == []


def test_zero_token_completed_rows_are_skipped_but_marked_seen(
    data_dir: Path,
) -> None:
    reader = OpencodeLogReader()
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, _SID, "/ws")
    _add_message(con, "msg_a1", _SID, _assistant_data({"input": 0, "output": 0}))
    con.close()

    seen: set[str] = set()
    assert reader.parse_session_file(db, seen) == []
    assert "msg:msg_a1" in seen  # consumed, not re-visited next cycle


def test_incremental_parse_uses_rowid_watermark(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, _SID, "/ws")
    _add_message(con, "msg_a1", _SID, _assistant_data({"input": 10, "output": 2}))
    first = reader.parse_incremental(db, {})
    assert [(e.input_tokens, e.output_tokens) for e in first.events] == [(10, 2)]
    assert first.checkpoint["row_id"] == 1

    _add_message(con, "msg_a2", _SID, _assistant_data({"input": 30, "output": 7}))
    con.close()
    second = reader.parse_incremental(db, first.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in second.events] == [(30, 7)]
    assert second.checkpoint["row_id"] == 2


def test_incremental_parse_rechecks_pending_streaming_rows(
    data_dir: Path,
) -> None:
    """A row that completes AFTER the watermark passed it must still be
    credited — it rides in the checkpoint's pending list."""
    reader = OpencodeLogReader()
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, _SID, "/ws")
    _add_message(con, "msg_a1", _SID, _assistant_data(
        {"input": 10, "output": 2}, completed=None,
    ))
    _add_message(con, "msg_a2", _SID, _assistant_data({"input": 30, "output": 7}))

    first = reader.parse_incremental(db, {})
    assert [(e.input_tokens, e.output_tokens) for e in first.events] == [(30, 7)]
    assert first.checkpoint["row_id"] == 2
    assert first.checkpoint["pending"] == [1]

    _update_message(con, "msg_a1", _assistant_data({"input": 10, "output": 2}))
    con.close()
    second = reader.parse_incremental(db, first.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in second.events] == [(10, 2)]
    assert second.checkpoint["pending"] == []
    # Nothing new afterwards.
    assert reader.parse_incremental(db, second.checkpoint).events == []


def test_incremental_parse_reanchors_when_watermark_drops(
    data_dir: Path,
) -> None:
    """MAX(rowid) below the stored watermark (a session deleted via
    ON DELETE CASCADE, or a Drizzle table rebuild on upgrade) must re-anchor,
    never rescan — a rescan re-credits the whole surviving history."""
    reader = OpencodeLogReader()
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, _SID, "/ws")
    for n in range(1, 5):
        _add_message(con, f"msg_a{n}", _SID,
                     _assistant_data({"input": 10 * n, "output": n}))
    first = reader.parse_incremental(db, {})
    assert sum(e.input_tokens for e in first.events) == 100
    assert first.checkpoint["row_id"] == 4

    con.execute("DELETE FROM message WHERE rowid = 4")
    con.commit()
    second = reader.parse_incremental(db, first.checkpoint)
    assert second.events == []
    assert second.checkpoint["row_id"] == 3

    _add_message(con, "msg_a5", _SID, _assistant_data({"input": 7, "output": 3}))
    con.close()
    third = reader.parse_incremental(db, second.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in third.events] == [(7, 3)]


def test_incremental_parse_resets_watermark_for_replaced_db(
    data_dir: Path,
) -> None:
    reader = OpencodeLogReader()
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, _SID, "/ws")
    _add_message(con, "msg_a1", _SID, _assistant_data({"input": 10, "output": 2}))
    con.close()
    first = reader.parse_incremental(db, {})

    db.unlink()
    replacement = _create_db(db)
    _add_session(replacement, _SID, "/ws")
    _add_message(replacement, "msg_a2", _SID, _assistant_data({"input": 30, "output": 7}))
    replacement.close()
    second = reader.parse_incremental(db, first.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in second.events] == [(30, 7)]
    assert second.checkpoint["identity"] != first.checkpoint["identity"]


# ── marker detection / session binding ──────────────────────────────────────

def test_marker_binding_announces_opencode_session(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    ws = data_dir.parent / "ws"
    ws.mkdir()
    marker = "at-pane:pane-oc-1"
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, _SID, str(ws))
    _add_user_turn(con, _SID, "msg_u1", f"kickoff…\nsession marker: {marker}\n")

    attr = Attribution([reader], workspaces_path=data_dir.parent / "ws.json")
    attr.register_pane(
        "pane-oc-1", vendor="opencode", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )

    binding = attr.maybe_announce_session(_session_sink_usage(db))
    con.close()

    assert binding is not None
    assert binding.pane_id == "pane-oc-1"
    # Resume id is the session.id (`ses_…`) that `opencode --session` accepts.
    assert binding.resume_id == _SID
    assert binding.workspace_path == str(ws)
    # Binding is a transition: the same db event never re-announces.
    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


def test_marker_in_other_workspace_does_not_bind(data_dir: Path) -> None:
    """A marker echoed in a session of ANOTHER project must not cross-bind."""
    reader = OpencodeLogReader()
    pane_ws = data_dir.parent / "pane-ws"
    pane_ws.mkdir()
    marker = "at-pane:pane-oc-2"
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, "ses_other", str(data_dir.parent / "other-ws"))
    _add_user_turn(con, "ses_other", "msg_u1", f"pasted text with {marker}")
    con.close()

    attr = Attribution([reader], workspaces_path=data_dir.parent / "ws.json")
    attr.register_pane(
        "pane-oc-2", vendor="opencode", cwd=str(pane_ws),
        workspace_path=str(pane_ws), session_marker=marker,
    )

    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


def test_marker_in_subagent_child_session_does_not_bind(data_dir: Path) -> None:
    """parent_id ≠ NULL = subagent session — never a resumable pane session."""
    reader = OpencodeLogReader()
    con = _create_db(data_dir / "opencode.db")
    _add_session(con, "ses_parent", "/ws")
    _add_session(con, "ses_child", "/ws", parent_id="ses_parent")
    _add_user_turn(con, "ses_child", "msg_u1", "forwarded at-pane:pane-x")
    con.close()

    assert reader.find_sessions_by_marker(["at-pane:pane-x"]) == {}


def test_marker_in_assistant_part_does_not_bind(data_dir: Path) -> None:
    """Only user-typed text carries a kickoff marker; an assistant echoing it
    must not match."""
    reader = OpencodeLogReader()
    con = _create_db(data_dir / "opencode.db")
    _add_session(con, _SID, "/ws")
    _add_message(con, "msg_a1", _SID, _assistant_data({"input": 1, "output": 1}))
    con.execute(
        "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
        ("prt_a1", "msg_a1", _SID, _NOW_MS, _NOW_MS,
         json.dumps({"type": "text", "text": "echoing at-pane:pane-y"})),
    )
    con.commit()
    con.close()

    assert reader.find_sessions_by_marker(["at-pane:pane-y"]) == {}


def test_two_panes_bind_their_own_markers(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    ws = data_dir.parent / "ws"
    ws.mkdir()
    db = data_dir / "opencode.db"
    con = _create_db(db)
    _add_session(con, "ses_aaa1", str(ws))
    _add_session(con, "ses_bbb2", str(ws))
    _add_user_turn(con, "ses_aaa1", "msg_u1", "kickoff at-pane:pane-a")
    _add_user_turn(con, "ses_bbb2", "msg_u2", "kickoff at-pane:pane-b")
    con.close()

    attr = Attribution([reader], workspaces_path=data_dir.parent / "ws.json")
    attr.register_pane("pane-a", vendor="opencode", cwd=str(ws),
                       workspace_path=str(ws), session_marker="at-pane:pane-a")
    attr.register_pane("pane-b", vendor="opencode", cwd=str(ws),
                       workspace_path=str(ws), session_marker="at-pane:pane-b")

    # One binding per db event; the watcher fires again on the next write.
    first = attr.maybe_announce_session(_session_sink_usage(db))
    second = attr.maybe_announce_session(_session_sink_usage(db))
    assert first is not None and second is not None
    bound = {b.pane_id: b.resume_id for b in (first, second)}
    assert bound == {"pane-a": "ses_aaa1", "pane-b": "ses_bbb2"}
    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


# ── resume preflight ─────────────────────────────────────────────────────────

def test_has_session_checks_the_shared_db(data_dir: Path) -> None:
    reader = OpencodeLogReader()
    con = _create_db(data_dir / "opencode.db")
    _add_session(con, _SID, "/ws")
    con.close()
    assert reader.has_session(_SID) is True
    assert reader.has_session("ses_missing") is False
    assert reader.has_session("") is False
