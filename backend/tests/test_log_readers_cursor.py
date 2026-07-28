"""CursorLogReader: per-session store.db enumeration + at-pane marker binding.

Fixture layout mirrors the community-documented (agentgrep) Cursor CLI store:
~/.cursor/chats/<project-hash>/<session-uuid>/store.db, where meta holds one
hex-encoded JSON row and blobs holds opaque protobuf values with the user's
text embedded verbatim as UTF-8. The CLI is closed source and stores no token
usage locally, so the reader emits no TokenUsage — these tests pin the
defensive marker/enumeration behaviour instead.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
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


def _make_store(
    chats: Path,
    project_hash: str,
    session_id: str,
    *,
    marker_text: str = "",
) -> Path:
    """Create <chats>/<project-hash>/<session-id>/store.db with meta + blobs.

    Blob values are protobuf-ish: binary tag/varint junk (including invalid
    UTF-8) with the user text embedded verbatim as UTF-8 bytes.
    """
    d = chats / project_hash / session_id
    d.mkdir(parents=True)
    db = d / "store.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB)")
    con.execute(
        "INSERT INTO meta VALUES ('0', ?)", (_hex_meta(session_id).encode(),)
    )
    con.execute("CREATE TABLE blobs (id TEXT PRIMARY KEY, value BLOB)")
    con.execute(
        "INSERT INTO blobs VALUES (?, ?)",
        ("b" * 64, b"\x0a\x14\x08\x02\x12\xff\xfe some assistant output \x00\x03"),
    )
    if marker_text:
        payload = b"\x0a\x40\x08\x01\x1a" + marker_text.encode("utf-8") + b"\x00\xf3\x28"
        con.execute("INSERT INTO blobs VALUES (?, ?)", ("c" * 64, payload))
    con.commit()
    con.close()
    return db


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


def test_cwd_is_unknowable(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(tmp_path / ".cursor" / "chats", "3" * 32, _SID)
    assert reader.cwd_from_file(db) == ""


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

def test_activity_emits_once_per_db_change(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = _make_store(tmp_path / ".cursor" / "chats", "6" * 32, _SID)

    seen: set[str] = set()
    first = reader.parse_activity(db, seen)
    assert [e.event_type for e in first] == ["agent_active"]
    assert first[0].session_id == _SID
    # Unchanged db → no repeat signal.
    assert reader.parse_activity(db, seen) == []
    # A write (size change) → one new agent_active; never turn_complete
    # (the store has no known end-of-turn record).
    con = sqlite3.connect(db)
    con.execute("INSERT INTO blobs VALUES ('d0', x'0a03080112')")
    con.commit()
    con.close()
    again = reader.parse_activity(db, seen)
    assert [e.event_type for e in again] == ["agent_active"]
    assert again[0].dedup_key != first[0].dedup_key
