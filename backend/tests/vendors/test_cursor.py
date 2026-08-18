"""CursorLogReader: store.db enumeration, at-pane marker binding, turn events.

Fixture layout mirrors a live Cursor CLI store sampled 2026-08-16:
~/.cursor/chats/<project-hash>/<session-uuid>/{store.db,meta.json}, where the
db's `meta` table holds one hex-encoded JSON row and `blobs (id, data)` mixes
plain-JSON chat messages with opaque protobuf structure nodes (the user's text
embedded verbatim as UTF-8). meta.json is the only record of the cwd. The CLI
stores no token usage locally, so the reader emits no TokenUsage — these tests
pin the activity/marker/enumeration behaviour instead.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path

from agent_team_backend.log_readers import CursorLogReader, TokenUsage
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.cursor import cursor_project_hash

_SID = "e6495800-dfd4-4a75-b2ab-d70980f83b89"
_SID2 = "0198f6a2-71aa-4d02-9c11-2233445566aa"


def _reader_rooted_at(tmp_path: Path, monkeypatch) -> CursorLogReader:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / ".cursor" / "chats").mkdir(parents=True)
    return CursorLogReader()


def _hex_meta(session_id: str) -> str:
    """meta value: hex-encoded JSON (agentId / latestRootBlobId / …, no cwd)."""
    body = {
        "agentId": session_id,
        "latestRootBlobId": "a" * 64,
        "lastUsedModel": {"modelId": "gpt-5"},
        "createdAt": 1753600000000,
    }
    return json.dumps(body).encode("utf-8").hex()


#: A protobuf structure node: binary tag/varint junk, including invalid UTF-8.
_PROTOBUF_BLOB = b"\x0a\x14\x08\x02\x12\xff\xfe some assistant output \x00\x03"


def _make_store(
    chats: Path,
    project_hash: str,
    session_id: str,
    *,
    marker_text: str = "",
    cwd: str = "",
    updated_at_ms: int = 1786844146562,
) -> Path:
    """Create <chats>/<project-hash>/<session-id>/store.db with meta + blobs.

    Blob values are protobuf-ish (see _PROTOBUF_BLOB) with the user text
    embedded verbatim as UTF-8 bytes. `cwd` also writes the meta.json sidecar,
    which is where the real CLI records the workspace.

    WAL is not decoration: the live store runs in WAL mode (confirmed on the
    2026-08-16 sample, which carries -wal/-shm siblings). Under the CLI's
    long-lived connection a commit lands in store.db-wal and leaves store.db's
    own mtime AND size untouched (measured: 30 commits, neither moved), which
    is why no reader logic here may lean on either. These helpers open and
    close a connection per write, and closing the last connection checkpoints
    — so the fixture's own mtime still moves; tests that care force the
    real-world stale mtime with os.utime rather than trusting the fixture.
    """
    d = chats / project_hash / session_id
    d.mkdir(parents=True)
    db = d / "store.db"
    con = sqlite3.connect(db)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    con.execute("INSERT INTO meta VALUES ('0', ?)", (_hex_meta(session_id),))
    con.execute("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
    con.execute("INSERT INTO blobs VALUES (?, ?)", ("b" * 64, _PROTOBUF_BLOB))
    if marker_text:
        payload = b"\x0a\x40\x08\x01\x1a" + marker_text.encode("utf-8") + b"\x00\xf3\x28"
        con.execute("INSERT INTO blobs VALUES (?, ?)", ("c" * 64, payload))
    con.commit()
    con.close()
    if cwd:
        (d / "meta.json").write_text(json.dumps({
            "schemaVersion": 1, "createdAtMs": 1786843987031,
            "hasConversation": True, "updatedAtMs": updated_at_ms, "cwd": cwd,
        }), encoding="utf-8")
    return db


def _append_blobs(db: Path, blob_id_prefix: str, *payloads) -> None:
    """Append blob rows the way the CLI does: a dict becomes a JSON message
    blob, bytes stay a raw protobuf structure node."""
    con = sqlite3.connect(db)
    for i, payload in enumerate(payloads):
        data = (
            json.dumps(payload).encode("utf-8")
            if isinstance(payload, dict) else payload
        )
        con.execute(
            "INSERT INTO blobs VALUES (?, ?)", (f"{blob_id_prefix}{i}", data)
        )
    con.commit()
    con.close()


def _session_sink_usage(db: Path) -> TokenUsage:
    """The placeholder usage app._on_session_file builds for a db change."""
    return TokenUsage(
        vendor="cursor", input_tokens=0, output_tokens=0, cwd="",
        session_id=db.parent.name, file_path=str(db), dedup_key="",
    )


# ── tolerance ────────────────────────────────────────────────────────────────

def test_missing_root_silently_skips(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    reader = CursorLogReader()  # no ~/.cursor at all → CLI not installed
    assert reader.project_dirs() == []
    assert reader.session_files() == []
    assert reader.find_sessions_by_marker(["at-pane:x"]) == {}
    assert reader.has_session(_SID) is False


def test_garbage_db_and_missing_table_are_tolerated(
    tmp_path: Path, monkeypatch
) -> None:
    """Not-a-sqlite-file and a db without a blobs table must both be skipped
    silently — the format is reverse engineered, so any surprise is survivable."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    chats = tmp_path / ".cursor" / "chats"
    garbage_dir = chats / ("a" * 32) / _SID
    garbage_dir.mkdir(parents=True)
    (garbage_dir / "store.db").write_bytes(b"this is not sqlite at all")
    no_blobs_dir = chats / ("b" * 32) / _SID2
    no_blobs_dir.mkdir(parents=True)
    con = sqlite3.connect(no_blobs_dir / "store.db")
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB)")
    con.commit()
    con.close()

    assert reader.find_sessions_by_marker(["at-pane:x"]) == {}
    result = reader.parse_incremental(garbage_dir / "store.db", {})
    assert result.events == []


def test_no_token_events_ever(tmp_path: Path, monkeypatch) -> None:
    """Cursor stores no usage locally → the token interface stays silent."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(
        tmp_path / ".cursor" / "chats", "f" * 32, _SID, marker_text="hello"
    )
    assert reader.parse_session_file(db, set()) == []
    result = reader.parse_incremental(db, {"kind": "x"})
    assert result.events == []
    assert result.checkpoint == {"kind": "x"}  # passes through unchanged


# ── enumeration / ids ────────────────────────────────────────────────────────

def test_session_enumeration_requires_uuid_dir_names(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    chats = tmp_path / ".cursor" / "chats"
    good = _make_store(chats, "1" * 32, _SID)
    # Non-UUID session dir (unknown future layout) is skipped, not crashed on.
    bogus = chats / ("2" * 32) / "not-a-uuid"
    bogus.mkdir(parents=True)
    (bogus / "store.db").write_bytes(b"")

    assert reader.session_files() == [good]


def test_session_id_from_path_only_for_store_db(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    chats = tmp_path / ".cursor" / "chats"
    db = _make_store(chats, "1" * 32, _SID)

    assert reader.session_id_from_path(db) == _SID
    # Sibling sqlite journals must not coin bogus ids.
    assert reader.session_id_from_path(db.parent / "store.db-wal") == ""
    # store.db under a non-uuid dir is not a session file.
    assert reader.session_id_from_path(chats / "x" / "nope" / "store.db") == ""


def test_cwd_comes_from_the_meta_json_sidecar(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    chats = tmp_path / ".cursor" / "chats"
    db = _make_store(chats, "3" * 32, _SID, cwd="/work/proj")
    assert reader.cwd_from_file(db) == "/work/proj"
    # No sidecar (or an unreadable one) → '' rather than a raise; store.db
    # itself never records the workspace.
    bare = _make_store(chats, "7" * 32, _SID2)
    assert reader.cwd_from_file(bare) == ""
    (bare.parent / "meta.json").write_text("{not json", encoding="utf-8")
    assert reader.cwd_from_file(bare) == ""


def test_has_session_globs_across_project_hashes(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    _make_store(tmp_path / ".cursor" / "chats", "4" * 32, _SID)

    assert reader.has_session(_SID) is True
    assert reader.has_session(_SID2) is False
    assert reader.has_session("not-a-uuid") is False
    assert reader.has_session("../" + _SID) is False


# ── md5 workspace scoping (best-effort, never a gate) ────────────────────────

def test_workspace_scoping_by_md5_hash_dir(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = str(tmp_path / "proj")
    hash_dir = hashlib.md5(ws.encode()).hexdigest()
    assert cursor_project_hash(ws) == hash_dir
    chats = tmp_path / ".cursor" / "chats"
    mine = _make_store(chats, hash_dir, _SID)
    _make_store(chats, "9" * 32, _SID2)  # other project

    assert reader.session_files_for_workspace(ws) == [mine]
    # Unknown hash dir → None so callers fall back to the full enumeration
    # (a wrong md5 assumption may widen scans but can never hide sessions).
    assert reader.session_files_for_workspace(str(tmp_path / "other")) is None


# ── marker detection / session binding ───────────────────────────────────────

def test_find_sessions_by_marker_scans_raw_blob_bytes(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    marker = "at-pane:pane-cursor-9"
    db = _make_store(
        tmp_path / ".cursor" / "chats", "5" * 32, _SID,
        marker_text=f"kickoff…\nsession marker: {marker}\n",
    )
    assert db.is_file()

    found = reader.find_sessions_by_marker([marker, "at-pane:absent"])
    # ws_root is '' — the store records no cwd — keeping the gate permissive.
    assert found == {marker: (_SID, "")}


def test_marker_binding_announces_cursor_session(
    tmp_path: Path, monkeypatch
) -> None:
    """Marker binding must not depend on the md5(cwd) project-hash guess:
    the session here lives under an arbitrary hash dir yet still binds."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    marker = "at-pane:pane-cursor-1"
    db = _make_store(
        tmp_path / ".cursor" / "chats", "deadbeef" * 4, _SID,
        marker_text=f"kickoff…\nsession marker: {marker}\n",
    )

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-cursor-1", vendor="cursor", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )

    binding = attr.maybe_announce_session(_session_sink_usage(db))
    assert binding is not None
    assert binding.pane_id == "pane-cursor-1"
    # Resume id is the session dir uuid `agent --resume=<id>` accepts.
    assert binding.resume_id == _SID
    assert binding.workspace_path == str(ws)
    # Binding is a transition: the same db event never re-announces.
    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


def test_bound_session_activity_passes_workspace_gate(
    tmp_path: Path, monkeypatch
) -> None:
    """After a marker hit, attribute() must route the session's events to the
    pane's workspace even though the store carries no cwd and the project
    hash dir doesn't match md5(cwd) — the gate never undoes a marker bind."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    marker = "at-pane:pane-cursor-2"
    db = _make_store(
        tmp_path / ".cursor" / "chats", "cafebabe" * 4, _SID,
        marker_text=marker,
    )

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-cursor-2", vendor="cursor", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )
    assert attr.maybe_announce_session(_session_sink_usage(db)) is not None

    attributed = attr.attribute(_session_sink_usage(db))
    assert attributed.workspace_path == str(ws)
    assert attributed.pane_id == "pane-cursor-2"


def test_md5_hash_dir_matches_workspace_for_unbound_sessions(
    tmp_path: Path, monkeypatch
) -> None:
    """The community md5(cwd) hash is the fallback workspace signal for
    sessions no pane has claimed (e.g. started outside Agent-Team)."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "proj"
    ws.mkdir()
    db = _make_store(
        tmp_path / ".cursor" / "chats", cursor_project_hash(str(ws)), _SID
    )

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_workspace(str(ws))

    attributed = attr.attribute(_session_sink_usage(db))
    assert attributed.workspace_path == str(ws)


# ── activity ─────────────────────────────────────────────────────────────────

def _assistant(text: str, *, reasoning: str = "") -> dict:
    content = []
    if reasoning:
        content.append({"type": "reasoning", "text": reasoning, "signature": "x"})
    content.append({"type": "text", "text": text})
    return {"role": "assistant", "content": content, "id": "msg-1"}


def _user(text: str) -> dict:
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def _armed(reader, db: Path) -> set[str]:
    """seen_keys after the first pass: the blob watermark is anchored at the
    newest row, so only writes made afterwards count as activity."""
    seen: set[str] = set()
    reader.parse_activity(db, seen)
    return seen


def test_protobuf_only_writes_report_nothing(
    tmp_path: Path, monkeypatch
) -> None:
    """No db-write heartbeat: a write that decodes to no chat message is
    silent.

    A live store keeps appending protobuf rows AFTER the turn's last assistant
    row. A heartbeat would turn those into a bare agent_active stamped later
    than the turn_complete, and turnCompleteDone (completion.ts) requires
    turnCompleteAt >= lastActiveAt — a pane that can never read as done, so
    'done' notifications vanish and an unattended loop stalls forever.
    """
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(tmp_path / ".cursor" / "chats", "6" * 32, _SID)

    seen: set[str] = set()
    assert reader.parse_activity(db, seen) == []  # first sight anchors only
    assert reader.parse_activity(db, seen) == []  # unchanged db

    _append_blobs(db, "pb", b"\x0a\x03\x08\x01\x12")
    assert reader.parse_activity(db, seen) == []

    # The trailing-write shape that used to strand the pane: an assistant row
    # (turn_complete) followed by more protobuf nodes in a LATER pass.
    _append_blobs(db, "t", _assistant("done"))
    assert [e.event_type for e in reader.parse_activity(db, seen)] == [
        "turn_complete"
    ]
    _append_blobs(db, "tail", b"\x0a\x02\x08\x09", b"\x0a\x02\x08\x0a")
    assert reader.parse_activity(db, seen) == []


def test_assistant_blob_completes_the_turn_without_reasoning(
    tmp_path: Path, monkeypatch
) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(
        tmp_path / ".cursor" / "chats", "6" * 32, _SID, cwd="/work/proj"
    )
    seen = _armed(reader, db)

    _append_blobs(
        db, "t",
        _user("<timestamp>Sun</timestamp>\n<user_query>\nsay two\n</user_query>"),
        b"\x0a\x05\x08\x01\x12\x03",          # tool/step node: skipped
        _assistant("two", reasoning="the user wants exactly 'two'"),
    )
    events = reader.parse_activity(db, seen)

    kinds = [(e.event_type, e.detail) for e in events]
    assert kinds == [
        ("agent_active", "user"),
        ("turn_complete", "assistant"),
    ]
    turn = events[-1]
    assert turn.text == "two"          # reasoning parts are excluded
    assert turn.session_id == _SID     # id = the session dir name
    assert turn.cwd == "/work/proj"    # from the meta.json sidecar
    # The timestamp must parse: the frontend dedups messaging turns by it and
    # treats an unparseable one as always-fresh (resending the turn).
    assert datetime.fromisoformat(turn.timestamp) is not None
    # The user event carries what the person typed, unwrapped from Cursor's
    # <user_query>. Without unwrapping, user_prompt_text drops the whole row
    # for starting with '<' and panes lose their auto-name.
    assert events[0].text == "say two"


def test_events_in_one_pass_get_strictly_increasing_timestamps(
    tmp_path: Path, monkeypatch
) -> None:
    """meta.json gives a whole pass ONE time, but App.vue's
    onTurnCompleteForMessaging admits a turn only when
    eventMs > paneMsgProcessedAt (strictly greater). Identical stamps would
    silently drop the second turn's ---MSG--- block."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(
        tmp_path / ".cursor" / "chats", "6" * 32, _SID, cwd="/work/proj"
    )
    seen = _armed(reader, db)

    _append_blobs(
        db, "t",
        _user("<user_query>\nfirst\n</user_query>"),
        _assistant("one"),
        _user("<user_query>\nsecond\n</user_query>"),
        _assistant("two"),
    )
    events = reader.parse_activity(db, seen)
    assert len(events) == 4
    stamps = [datetime.fromisoformat(e.timestamp) for e in events]
    assert stamps == sorted(stamps) and len(set(stamps)) == 4


def test_injected_context_row_is_not_user_activity(tmp_path: Path, monkeypatch) -> None:
    """Cursor's own first `user` row is context, not something anyone typed.

    It is ~30k characters of <user_info>/<rules>/<agent_transcripts> and has
    no <user_query>. Reporting it would name the pane after the rule set.
    """
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(
        tmp_path / ".cursor" / "chats", "8" * 32, _SID, cwd="/work/proj"
    )
    seen = _armed(reader, db)

    _append_blobs(
        db, "c",
        _user("<user_info>\nWorkspace Path: /work/proj\n</user_info>\n<rules>x</rules>"),
        _user("<timestamp>Sun</timestamp>\n<user_query>\nreal prompt\n</user_query>"),
    )
    events = reader.parse_activity(db, seen)

    # Only ONE user event: the <rules> row is skipped.
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
    ]
    assert events[-1].text == "real prompt"


def test_marker_only_row_is_not_user_activity(tmp_path: Path, monkeypatch) -> None:
    """Navide's own session marker is typed into the TUI as a standalone
    prompt, so Cursor wraps it in a normal <user_query> row. It is the app
    talking to itself at spawn time, not activity — but a real prompt that
    merely MENTIONS at-pane: is still the user's and must be reported."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(
        tmp_path / ".cursor" / "chats", "a" * 32, _SID, cwd="/work/proj"
    )
    seen = _armed(reader, db)
    marker = "at-pane:2d215901-c03c-4a4e-852a-0584d14e977d"

    _append_blobs(
        db, "m",
        # The exact wire form App.vue's sendSessionMarkerBootstrap pastes.
        _user(f"<user_query>\n<!-- agent-team-session: {marker} -->\n</user_query>"),
        # A bare marker (kickoff-appended form, whitespace around it).
        _user(f"<user_query>\n  {marker}  \n</user_query>"),
        _user(f"<user_query>\nwhy does {marker} show up in the store?\n</user_query>"),
    )
    events = reader.parse_activity(db, seen)

    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
    ]
    assert events[0].text == f"why does {marker} show up in the store?"


def test_activity_watermark_does_not_replay(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(tmp_path / ".cursor" / "chats", "6" * 32, _SID)
    seen = _armed(reader, db)

    _append_blobs(db, "t", _assistant("one"))
    assert [e.event_type for e in reader.parse_activity(db, seen)] == [
        "turn_complete",
    ]
    # Same rows again → nothing; only the new blob of the next turn counts.
    assert reader.parse_activity(db, seen) == []
    _append_blobs(db, "u", _assistant("two"))
    second = [e for e in reader.parse_activity(db, seen)
              if e.event_type == "turn_complete"]
    assert [e.text for e in second] == ["two"]


def test_activity_reanchors_when_the_store_shrinks(
    tmp_path: Path, monkeypatch
) -> None:
    """A recreated/vacuumed db leaves the watermark past MAX(rowid). Re-anchor
    rather than rescan, so old turns are never replayed as new ones."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    chats = tmp_path / ".cursor" / "chats"
    db = _make_store(chats, "6" * 32, _SID)
    seen = _armed(reader, db)
    _append_blobs(db, "t", _assistant("one"), _assistant("two"))
    assert len(reader.parse_activity(db, seen)) == 2

    con = sqlite3.connect(db)
    con.execute("DELETE FROM blobs")
    con.execute("INSERT INTO blobs VALUES ('fresh', ?)",
                (json.dumps(_assistant("rebuilt")).encode(),))
    con.commit()
    con.close()

    # Re-anchored: the surviving row is below the old watermark, so it counts
    # as history — nothing is reported this pass.
    assert reader.parse_activity(db, seen) == []
    _append_blobs(db, "after", _assistant("next"))
    after = [e for e in reader.parse_activity(db, seen)
             if e.event_type == "turn_complete"]
    assert [e.text for e in after] == ["next"]


def test_activity_survives_an_unreadable_db(tmp_path: Path, monkeypatch) -> None:
    """A corrupt or locked store must yield no activity and no raise — and
    must not move the watermark, so a later readable pass still works."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    chats = tmp_path / ".cursor" / "chats"
    d = chats / ("8" * 32) / _SID
    d.mkdir(parents=True)
    db = d / "store.db"
    db.write_bytes(b"this is not sqlite at all")

    seen: set[str] = set()
    assert reader.parse_activity(db, seen) == []
    assert not any(k.startswith("cursor_blob::") for k in seen)


def test_timestamp_falls_back_to_now_not_the_db_mtime(
    tmp_path: Path, monkeypatch
) -> None:
    """store.db is WAL: a commit lands in store.db-wal and leaves the main
    file's mtime at the session's start. With meta.json missing or corrupt,
    an mtime fallback would stamp every turn of the session with that start
    time — past 60s isReplayedTurnComplete discards them all, silencing done
    notifications, pipeline sentinels and inter-CLI messaging alike."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(tmp_path / ".cursor" / "chats", "6" * 32, _SID)
    assert not (db.parent / "meta.json").exists()
    seen = _armed(reader, db)

    _append_blobs(db, "t", _assistant("late reply"))
    stale = time.time() - 7200
    os.utime(db, (stale, stale))

    events = reader.parse_activity(db, seen)
    assert [e.event_type for e in events] == ["turn_complete"]
    stamped = datetime.fromisoformat(events[0].timestamp).timestamp()
    assert abs(stamped - time.time()) < 60
