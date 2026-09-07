"""Grok's activity dedup is a bounded watermark, not a key per message row.

GitHub #28: the watcher persists each file's activity dedup bag into the
"@activity" checkpoint so a restart resumes instead of replaying, but it drops
a bag larger than _ACTIVITY_KEYS_PERSIST_LIMIT rather than truncating it — a
partial bag would read back as a real resume point and silently swallow what it
dropped. Grok used to add one `act:<session>:<seq>` key per message row, in a
database that holds every session ever run, so its bag passed that limit almost
immediately, was never persisted, and the whole store replayed on every start.

The mark is global, on `messages.rowid`, and that is the load-bearing choice:
`seq` restarts at 0 for each new session, so a single maximum over seq would
sit above a younger session's rows and swallow all of them.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from agent_team_backend.cli_vendors.grok import GrokLogReader
from agent_team_backend.log_readers.watcher import _ACTIVITY_KEYS_PERSIST_LIMIT

_SCHEMA = """
CREATE TABLE workspaces (id INTEGER PRIMARY KEY, scope_key TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id INTEGER);
CREATE TABLE messages (
    session_id TEXT, seq INTEGER, role TEXT, message_json TEXT, created_at REAL
);
CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY, session_id TEXT, model TEXT,
    input_tokens INTEGER, output_tokens INTEGER, created_at REAL
);
"""


def _db(tmp_path: Path) -> Path:
    root = tmp_path / "grok"
    root.mkdir(parents=True, exist_ok=True)
    path = root / "grok.db"
    con = sqlite3.connect(path)
    con.executescript(_SCHEMA)
    con.execute("INSERT INTO workspaces (id, scope_key) VALUES (1, '/ws')")
    con.commit()
    con.close()
    return path


def _session(path: Path, sid: str) -> None:
    con = sqlite3.connect(path)
    con.execute("INSERT INTO sessions (id, workspace_id) VALUES (?, 1)", (sid,))
    con.commit()
    con.close()


def _msg(path: Path, sid: str, seq: int, role: str, text: str, at: float) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO messages (session_id, seq, role, message_json, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (sid, seq, role, json.dumps({"content": text}), at),
    )
    con.commit()
    con.close()


def _reader() -> GrokLogReader:
    return GrokLogReader()


def test_a_second_pass_over_an_unchanged_store_emits_nothing(tmp_path: Path) -> None:
    """The whole point: a restart must not replay what is already delivered."""
    path = _db(tmp_path)
    _session(path, "s1")
    now = time.time()
    _msg(path, "s1", 0, "user", "hello", now)
    _msg(path, "s1", 1, "assistant", "hi", now)

    seen: set[str] = set()
    first = _reader().parse_activity(path, seen)
    assert first, "the first pass delivered nothing at all"

    second = _reader().parse_activity(path, seen)
    assert second == [], "the store replayed on the second pass"


def test_only_rows_past_the_mark_are_emitted(tmp_path: Path) -> None:
    path = _db(tmp_path)
    _session(path, "s1")
    now = time.time()
    _msg(path, "s1", 0, "user", "first", now)

    seen: set[str] = set()
    _reader().parse_activity(path, seen)

    _msg(path, "s1", 1, "assistant", "second", now)
    out = _reader().parse_activity(path, seen)
    texts = [e.text or "" for e in out]
    assert not any("first" in t for t in texts), "a row before the mark came back"


def test_the_bag_stays_small_enough_to_persist(tmp_path: Path) -> None:
    """A bag over the limit is dropped whole by the watcher, which is exactly
    how this reader used to lose its cursor and replay forever."""
    path = _db(tmp_path)
    now = time.time()
    for s in range(3):
        sid = f"s{s}"
        _session(path, sid)
        for i in range(40):
            _msg(path, sid, i, "user" if i % 2 == 0 else "assistant", f"m{i}", now)

    seen: set[str] = set()
    _reader().parse_activity(path, seen)
    assert len(seen) <= _ACTIVITY_KEYS_PERSIST_LIMIT, (
        f"{len(seen)} keys for 120 rows — the watcher would refuse to persist this"
    )


def test_a_new_session_whose_seq_restarts_is_not_swallowed(tmp_path: Path) -> None:
    """Why the mark is on rowid and not on seq.

    seq is per-session and starts again at 0, so a mark kept as 'highest seq
    seen' would sit above every row of the next session and drop all of them.
    """
    path = _db(tmp_path)
    now = time.time()
    _session(path, "old")
    for i in range(10):
        _msg(path, "old", i, "user" if i % 2 == 0 else "assistant", f"old{i}", now)

    seen: set[str] = set()
    _reader().parse_activity(path, seen)

    # A brand-new session: its seq counts from 0 again, below everything above.
    _session(path, "fresh")
    _msg(path, "fresh", 0, "user", "brand new", now)
    out = _reader().parse_activity(path, seen)
    assert any(e.session_id == "fresh" for e in out), (
        "the younger session was swallowed — the mark is keyed on seq, not rowid"
    )


def test_a_shrunken_store_re_anchors_instead_of_replaying(tmp_path: Path) -> None:
    """rowids are handed out as max(rowid)+1, so a mark left standing above a
    rebuilt store's max would swallow everything written after it. Re-anchor —
    but do not rescan, since replaying is the bug the mark exists to stop."""
    path = _db(tmp_path)
    now = time.time()
    _session(path, "s1")
    for i in range(6):
        _msg(path, "s1", i, "user" if i % 2 == 0 else "assistant", f"m{i}", now)

    seen: set[str] = set()
    _reader().parse_activity(path, seen)

    con = sqlite3.connect(path)
    con.execute("DELETE FROM messages")
    con.commit()
    con.close()

    assert _reader().parse_activity(path, seen) == [], "an emptied store replayed"

    # And the re-anchored mark lets genuinely new rows through again.
    _msg(path, "s1", 0, "user", "after the reset", now)
    out = _reader().parse_activity(path, seen)
    assert any("after the reset" in (e.text or "") for e in out) or out, (
        "rows written after the re-anchor never arrived"
    )
