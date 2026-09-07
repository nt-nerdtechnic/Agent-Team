"""grok and copilot activity dedup must fit the durable "@activity" bag.

Both readers used to leave one key per item in the `seen_keys` bag
parse_activity is handed — grok an `act:<session>:<seq>` per message row,
copilot an `act:<line>` per JSONL line plus a `db_act:*` per store row. In a
store that holds every session ever run, those bags cross the watcher's
`_ACTIVITY_KEYS_PERSIST_LIMIT` within a handful of turns, and an over-limit bag
is dropped whole rather than truncated. So nothing was ever written to the
durable checkpoint and both vendors replayed their entire history — every
`agent_active`, every `turn_complete` with its turn text and MSG blocks — on
every backend start (GitHub #28).

The fix is the same consolidation cursor/antigravity/opencode already use: one
bounded watermark instead of per-item keys. These tests pin all three halves of
that — the bag stays persistable, a restart resumes from it, and the watermark
neither replays a row nor skips one.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import grok as grok_module
from agent_team_backend.cli_vendors.copilot import CopilotLogReader
from agent_team_backend.cli_vendors.grok import _TURN_IDLE_SECONDS, GrokLogReader
from agent_team_backend.log_readers.watcher import _ACTIVITY_KEYS_PERSIST_LIMIT


# ── the bag round-trip the watcher actually performs ────────────────────────

def _persisted(bag: set[str]) -> set[str]:
    """The bag as it comes back out of the checkpoint store, or a failure.

    _persist_activity_seen refuses an over-limit bag outright, so a reader that
    exceeds the limit gets an empty bag back on the next start — which is
    exactly the full replay this is all about. Round-tripping through JSON also
    catches a sentinel that cannot survive serialization.
    """
    assert len(bag) <= _ACTIVITY_KEYS_PERSIST_LIMIT, (
        f"bag of {len(bag)} keys exceeds the persist limit "
        f"({_ACTIVITY_KEYS_PERSIST_LIMIT}); it would be dropped whole: "
        f"{sorted(bag)}"
    )
    return {str(k) for k in json.loads(json.dumps(sorted(bag)))}


# ── grok fixtures ───────────────────────────────────────────────────────────

def _grok_db(tmp_path: Path) -> Path:
    path = tmp_path / ".grok" / "grok.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, scope_key TEXT NOT NULL,
          canonical_path TEXT NOT NULL, git_root TEXT, display_name TEXT NOT NULL,
          last_seen_at TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
          title TEXT, recap_text TEXT, recap_model TEXT, recap_updated_at TEXT,
          model TEXT NOT NULL, mode TEXT NOT NULL, cwd_at_start TEXT NOT NULL,
          cwd_last TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL);
        CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          role TEXT NOT NULL, message_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, seq));
        """
    )
    con.commit()
    con.close()
    return path


def _grok_workspace(path: Path, ws_id: str, scope: str) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "INSERT OR IGNORE INTO workspaces VALUES (?,?,?,?,?,?)",
        (ws_id, scope, scope, scope, ws_id, "2026-09-07T00:00:00Z"),
    )
    con.commit()
    con.close()


def _grok_session(path: Path, sid: str, ws_id: str) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "INSERT OR IGNORE INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (sid, ws_id, None, None, None, None, "grok-4", "agent", "/w", "/w",
         "active", "2026-09-07T00:00:00Z", "2026-09-07T00:00:00Z"),
    )
    con.commit()
    con.close()


def _grok_msg(path: Path, sid: str, seq: int, role: str, text: str,
              ts: str = "2026-09-07T00:00:00.000Z") -> None:
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO messages VALUES (?,?,?,?,?)",
        (sid, seq, role, json.dumps({"content": [{"type": "text", "text": text}]}), ts),
    )
    con.commit()
    con.close()


def _old(seconds_ago: float = 3600.0) -> str:
    """An ISO stamp far enough back that the idle flush fires this pass."""
    return time.strftime(
        "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - seconds_ago)
    )


def _now() -> str:
    """An ISO stamp fresh enough that the idle flush leaves the turn open."""
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time()))


# ── grok: the bag ───────────────────────────────────────────────────────────

def test_grok_bag_stays_persistable_across_many_sessions(tmp_path: Path) -> None:
    """One db holds every session grok has ever run. The bag must not scale
    with that: 40 sessions x 20 messages used to leave 800 `act:` keys."""
    db = _grok_db(tmp_path)
    _grok_workspace(db, "w1", "/repo")
    for s in range(40):
        sid = f"sess{s:04d}"
        _grok_session(db, sid, "w1")
        for seq in range(20):
            _grok_msg(db, sid, seq, "user" if seq % 2 == 0 else "assistant",
                      f"m{seq}", _old())

    reader = GrokLogReader()
    seen: set[str] = set()
    events = reader.parse_activity(db, seen)

    assert events, "the first walk must still deliver the history it read"
    assert len(seen) <= _ACTIVITY_KEYS_PERSIST_LIMIT, sorted(seen)
    _persisted(seen)


def test_grok_restart_from_the_persisted_bag_replays_nothing(tmp_path: Path) -> None:
    """The #28 regression for grok: bag through the checkpoint, memory gone."""
    db = _grok_db(tmp_path)
    _grok_workspace(db, "w1", "/repo")
    _grok_session(db, "s1", "w1")
    for seq in range(12):
        _grok_msg(db, "s1", seq, "user" if seq % 2 == 0 else "assistant",
                  f"m{seq}", _old())

    first = GrokLogReader().parse_activity(db, (bag := set()))
    assert first

    # A different process, holding only what the checkpoint kept.
    second = GrokLogReader().parse_activity(db, _persisted(bag))
    assert second == [], f"replayed {len(second)} historic event(s)"


def test_grok_delivers_every_row_exactly_once(tmp_path: Path) -> None:
    """The correctness bar: the watermark may not skip a row or repeat one."""
    db = _grok_db(tmp_path)
    _grok_workspace(db, "w1", "/repo")
    _grok_session(db, "s1", "w1")

    reader = GrokLogReader()
    bag: set[str] = set()
    delivered: list[str] = []
    for seq in range(10):
        _grok_msg(db, "s1", seq, "user" if seq % 2 == 0 else "assistant",
                  f"m{seq}", _old())
        bag = _persisted(bag)  # restart before every poll
        delivered += [
            e.dedup_key for e in reader.parse_activity(db, bag)
            if e.event_type == "agent_active"
        ]

    assert delivered == [f"act:s1:{n}" for n in range(10)]


def test_grok_watermark_is_not_a_global_max_over_seq(tmp_path: Path) -> None:
    """`seq` restarts at 0 for each session, so a single mark over seq would
    swallow every row of a session started later. The mark is on rowid."""
    db = _grok_db(tmp_path)
    _grok_workspace(db, "w1", "/repo")
    _grok_session(db, "old", "w1")
    for seq in range(30):
        _grok_msg(db, "old", seq, "assistant", f"o{seq}", _old())

    reader = GrokLogReader()
    bag: set[str] = set()
    reader.parse_activity(db, bag)

    # A brand new session: its seq numbers are all BELOW the old session's max.
    _grok_session(db, "young", "w1")
    _grok_msg(db, "young", 0, "user", "hello", _old())
    _grok_msg(db, "young", 1, "assistant", "hi", _old())

    keys = [e.dedup_key for e in reader.parse_activity(db, _persisted(bag))
            if e.event_type == "agent_active"]
    assert keys == ["act:young:0", "act:young:1"], keys


def test_grok_idle_flush_survives_a_pass_with_no_new_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The flush pass used to recompute cwd and last-written from a full table
    scan. Reading only past the mark means a quiet session returns no rows at
    all, so both have to be carried in the per-session state instead — a
    turn_complete with an empty cwd never reaches its pane."""
    db = _grok_db(tmp_path)
    _grok_workspace(db, "w1", "/repo")
    _grok_session(db, "s1", "w1")
    _grok_msg(db, "s1", 0, "user", "do the thing", _now())

    reader = GrokLogReader()
    bag: set[str] = set()
    # The message is fresh, so this pass leaves the turn open.
    assert [e.event_type for e in reader.parse_activity(db, bag)] == ["agent_active"]

    bag = _persisted(bag)
    # The session then goes quiet past the idle window. No new rows at all, so
    # the flush has only the persisted per-session state to go on.
    later = time.time() + _TURN_IDLE_SECONDS + 60
    monkeypatch.setattr(grok_module.time, "time", lambda: later)
    done = [e for e in reader.parse_activity(db, bag)
            if e.event_type == "turn_complete"]
    assert done, "the open turn was never closed once the scan went incremental"
    assert done[0].cwd == "/repo", f"lost the session's cwd: {done[0].cwd!r}"
    assert done[0].session_id == "s1"


def test_grok_re_anchors_to_zero_when_the_store_is_replaced(tmp_path: Path) -> None:
    """rowids are handed out as max(rowid)+1, so they repeat once the newest
    rows go — and a replaced db restarts them at 1 while the bag, keyed by
    path, keeps the old mark. Rows already sitting BELOW that mark in the new
    store have never been delivered under those ids, so re-anchoring to the new
    max (rather than to 0) steps straight over them."""
    db = _grok_db(tmp_path)
    _grok_workspace(db, "w1", "/repo")
    _grok_session(db, "s1", "w1")
    for seq in range(9):
        _grok_msg(db, "s1", seq, "assistant", f"m{seq}", _old())

    reader = GrokLogReader()
    bag: set[str] = set()
    reader.parse_activity(db, bag)

    # The db is replaced by a smaller one that ALREADY holds rows: its max
    # rowid (3) is below the standing mark (9), and none of it has been sent.
    db.unlink()
    _grok_db(tmp_path)
    _grok_workspace(db, "w1", "/repo")
    _grok_session(db, "s2", "w1")
    for seq in range(3):
        _grok_msg(db, "s2", seq, "assistant", f"n{seq}", _old())

    reader.parse_activity(db, bag)          # notices the shrink, re-anchors
    keys = [e.dedup_key for e in reader.parse_activity(db, _persisted(bag))
            if e.event_type == "agent_active"]
    assert keys == ["act:s2:0", "act:s2:1", "act:s2:2"], keys


# ── copilot fixtures ────────────────────────────────────────────────────────

def _copilot_db(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / "session-store.db"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT,
          host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
          user_message TEXT, assistant_response TEXT, timestamp TEXT,
          UNIQUE(session_id, turn_index));
        CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL, turn_index INTEGER, agent_id TEXT,
          parent_tool_call_id TEXT, model TEXT NOT NULL, input_tokens INTEGER,
          output_tokens INTEGER, cache_read_tokens INTEGER,
          cache_write_tokens INTEGER, reasoning_tokens INTEGER,
          total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER,
          time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER,
          initiator TEXT, api_endpoint TEXT, reasoning_effort TEXT,
          finish_reason TEXT, content_filter_triggered INTEGER,
          token_details_json TEXT, created_at TEXT);
        """
    )
    con.commit()
    con.close()
    return path


def _copilot_session(path: Path, sid: str, cwd: str = "/repo") -> None:
    con = sqlite3.connect(path)
    con.execute("INSERT OR IGNORE INTO sessions (id, cwd) VALUES (?,?)", (sid, cwd))
    con.commit()
    con.close()


def _copilot_turn(path: Path, sid: str, idx: int, user: str, reply: str) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO turns (session_id, turn_index, user_message, "
        "assistant_response, timestamp) VALUES (?,?,?,?,?)",
        (sid, idx, user, reply, "2026-09-07T00:00:00Z"),
    )
    con.execute(
        "INSERT INTO assistant_usage_events (session_id, turn_index, model, "
        "input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?)",
        (sid, idx, "gpt-5", 10, 5, "2026-09-07T00:00:00Z"),
    )
    con.commit()
    con.close()


def _events_jsonl(root: Path, sid: str, turns: int) -> Path:
    d = root / "session-state" / sid
    d.mkdir(parents=True, exist_ok=True)
    path = d / "events.jsonl"
    with path.open("w", encoding="utf-8") as fh:
        for i in range(turns):
            for rec in (
                {"type": "user.message", "data": {"content": f"q{i}"},
                 "timestamp": f"2026-09-07T00:00:{i:02d}Z"},
                {"type": "assistant.message", "data": {"content": f"a{i}"},
                 "timestamp": f"2026-09-07T00:00:{i:02d}Z"},
                {"type": "assistant.turn_end", "data": {},
                 "timestamp": f"2026-09-07T00:00:{i:02d}Z"},
            ):
                fh.write(json.dumps(rec) + "\n")
    return path


# ── copilot: the store ──────────────────────────────────────────────────────

def test_copilot_store_bag_stays_persistable(tmp_path: Path) -> None:
    """One store holds every session. 30 sessions x 8 turns used to leave 480
    `db_act:*` keys — 60x the limit."""
    root = tmp_path / ".copilot"
    db = _copilot_db(root)
    for s in range(30):
        sid = f"sess-{s}"
        _copilot_session(db, sid)
        for t in range(8):
            _copilot_turn(db, sid, t, f"q{t}", f"a{t}")

    seen: set[str] = set()
    events = CopilotLogReader().parse_activity(db, seen)

    assert events
    assert len(seen) <= _ACTIVITY_KEYS_PERSIST_LIMIT, sorted(seen)
    _persisted(seen)


def test_copilot_store_restart_replays_nothing(tmp_path: Path) -> None:
    """The #28 regression for copilot's store path."""
    root = tmp_path / ".copilot"
    db = _copilot_db(root)
    _copilot_session(db, "s1")
    for t in range(5):
        _copilot_turn(db, "s1", t, f"q{t}", f"a{t}")

    first = CopilotLogReader().parse_activity(db, (bag := set()))
    assert first

    second = CopilotLogReader().parse_activity(db, _persisted(bag))
    assert second == [], f"replayed {len(second)} historic event(s)"


def test_copilot_store_delivers_every_row_exactly_once(tmp_path: Path) -> None:
    root = tmp_path / ".copilot"
    db = _copilot_db(root)
    _copilot_session(db, "s1")

    reader = CopilotLogReader()
    bag: set[str] = set()
    turns: list[str] = []
    for t in range(8):
        _copilot_turn(db, "s1", t, f"q{t}", f"a{t}")
        bag = _persisted(bag)
        turns += [e.dedup_key for e in reader.parse_activity(db, bag)
                  if e.event_type == "turn_complete"]

    assert turns == [f"db_turn:{n}" for n in range(1, 9)]


def test_copilot_store_re_anchors_when_it_is_replaced(tmp_path: Path) -> None:
    """AUTOINCREMENT ids never repeat — but a REPLACED store restarts them at
    1, and the bag is keyed by path, so the old mark would swallow the lot."""
    root = tmp_path / ".copilot"
    db = _copilot_db(root)
    _copilot_session(db, "s1")
    for t in range(5):
        _copilot_turn(db, "s1", t, f"q{t}", f"a{t}")

    reader = CopilotLogReader()
    bag: set[str] = set()
    reader.parse_activity(db, bag)

    db.unlink()
    _copilot_db(root)
    _copilot_session(db, "s2")
    _copilot_turn(db, "s2", 0, "fresh", "reply")

    # Re-anchoring to the new MAX(id) instead of 0 would step straight over
    # this row: it carries id 1, below a mark of 5, yet has never been sent.
    keys = [e.dedup_key for e in reader.parse_activity(db, _persisted(bag))
            if e.event_type == "turn_complete"]
    assert keys == ["db_turn:1"], keys


# ── copilot: events.jsonl ───────────────────────────────────────────────────

def test_copilot_jsonl_bag_is_one_mark_not_one_key_per_line(tmp_path: Path) -> None:
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=200)

    seen: set[str] = set()
    events = CopilotLogReader().parse_activity(path, seen)

    assert len(events) == 600
    assert len(seen) <= _ACTIVITY_KEYS_PERSIST_LIMIT, sorted(seen)
    _persisted(seen)


def test_copilot_jsonl_restart_replays_nothing(tmp_path: Path) -> None:
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=20)

    first = CopilotLogReader().parse_activity(path, (bag := set()))
    assert first

    second = CopilotLogReader().parse_activity(path, _persisted(bag))
    assert second == [], f"replayed {len(second)} historic event(s)"


def test_copilot_jsonl_delivers_appended_lines_exactly_once(tmp_path: Path) -> None:
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=3)

    reader = CopilotLogReader()
    bag: set[str] = set()
    seen_keys = [e.dedup_key for e in reader.parse_activity(path, bag)]

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "user.message", "data": {"content": "q3"},
                             "timestamp": "t"}) + "\n")
    bag = _persisted(bag)
    after = [e.dedup_key for e in reader.parse_activity(path, bag)]

    assert after == ["act:10"], after
    assert "act:10" not in seen_keys


def test_copilot_jsonl_holds_the_mark_behind_a_partial_line(tmp_path: Path) -> None:
    """GitHub #21: advancing past a half-written turn-end record drops it for
    good and leaves the pane mid-turn forever."""
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=1)
    reader = CopilotLogReader()
    bag: set[str] = set()
    reader.parse_activity(path, bag)

    complete = json.dumps({"type": "assistant.turn_end", "data": {},
                           "timestamp": "t9"})
    with path.open("a", encoding="utf-8") as fh:
        fh.write(complete[:20])                       # mid-write, no newline
    assert reader.parse_activity(path, bag) == []

    with path.open("a", encoding="utf-8") as fh:
        fh.write(complete[20:] + "\n")                # the CLI finishes it
    kinds = [e.event_type for e in reader.parse_activity(path, _persisted(bag))]
    assert kinds == ["turn_complete"], kinds


def test_copilot_jsonl_steps_over_a_terminated_corrupt_line(tmp_path: Path) -> None:
    """Unchanged behaviour, and why the partial-line test checks the newline:
    a terminated line that will not parse never will, so holding the mark
    behind it would re-emit the whole rest of the file on every poll."""
    root = tmp_path / ".copilot"
    path = _events_jsonl(root, "s1", turns=1)
    with path.open("a", encoding="utf-8") as fh:
        fh.write("NOT JSON AT ALL\n")
        fh.write(json.dumps({"type": "user.message", "data": {"content": "q"},
                             "timestamp": "t"}) + "\n")

    reader = CopilotLogReader()
    bag: set[str] = set()
    reader.parse_activity(path, bag)

    assert reader.parse_activity(path, _persisted(bag)) == []


# ── the dispatch these two were missing ─────────────────────────────────────

@pytest.mark.parametrize("vendor", ["grok", "copilot"])
def test_neither_vendor_declares_the_line_seeding_hook(vendor: str) -> None:
    """Both are keyed on db row ids (and copilot's ONE reader serves both a
    JSONL log and a SQLite store), so neither may claim
    `activity_resumes_by_line` — the watcher would count newlines in a store
    and drop a line number into a bag nothing consults."""
    reader = {"grok": GrokLogReader, "copilot": CopilotLogReader}[vendor]()
    assert reader.activity_resumes_by_line is False
