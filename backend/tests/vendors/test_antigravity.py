"""AntigravityLogReader + marker-based session binding.

Conversations are SQLite dbs with protobuf blobs; the reader only does
session discovery (enumeration + cwd extraction). Binding goes through the
generic marker path in Attribution.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from agent_team_backend.log_readers import AntigravityLogReader, TokenUsage
from agent_team_backend.cli_vendors.antigravity import _extract_cwd
from agent_team_backend.log_readers.attribution import Attribution


def _make_conversation_db(path: Path, workspace: Path, extra_blob: bytes = b"") -> None:
    """Minimal conversation db: trajectory_metadata_blob with a file:// URI.

    Mimics the real layout: the URI appears once cleanly (own field) and once
    followed by protobuf tag bytes that happen to be printable ('z…').
    """
    con = sqlite3.connect(path)
    con.execute(
        'CREATE TABLE `trajectory_metadata_blob` '
        '(`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))'
    )
    uri = f"file://{workspace}".encode()
    blob = b"\x12\x30" + uri + b"\x00\x22\x41$9bc6-uuid:/" + uri + b"z\xc2\x88" + extra_blob
    con.execute("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)", (blob,))
    con.commit()
    con.close()


def _reader_rooted_at(tmp_path: Path, monkeypatch) -> AntigravityLogReader:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    root = tmp_path / ".gemini" / "antigravity-cli" / "conversations"
    root.mkdir(parents=True)
    return AntigravityLogReader()


def test_session_files_only_db(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    root = reader.project_dirs()[0]
    (root / "abc.db").write_bytes(b"")
    (root / "abc.db-wal").write_bytes(b"")
    (root / "abc.db-shm").write_bytes(b"")

    files = reader.session_files()
    assert [f.name for f in files] == ["abc.db"]


def test_cwd_from_file_extracts_workspace(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "my workspace"  # space + existing dir → realistic
    ws.mkdir()
    db = reader.project_dirs()[0] / "286db9c5.db"
    _make_conversation_db(db, ws)

    assert reader.cwd_from_file(db) == str(ws)
    # Cached second read returns the same value.
    assert reader.cwd_from_file(db) == str(ws)


def test_cwd_falls_back_to_raw_scan_on_corrupt_db(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    db = reader.project_dirs()[0] / "broken.db"
    db.write_bytes(b"not sqlite at all file://" + str(ws).encode() + b"\x00junk")

    assert reader.cwd_from_file(db) == str(ws)


def test_extract_cwd_prefers_existing_dir_over_junk_suffix(tmp_path: Path) -> None:
    ws = tmp_path / "proj"
    ws.mkdir()
    text = f"$uuid:/file://{ws}z\x88 file://{ws}\x00file://{ws}"
    assert _extract_cwd(text) == str(ws)


def test_parse_session_file_returns_no_tokens(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    db = reader.project_dirs()[0] / "abc.db"
    _make_conversation_db(db, tmp_path)

    assert reader.parse_session_file(db, set()) == []


def test_marker_binding_announces_antigravity_session(tmp_path: Path, monkeypatch) -> None:
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    marker = "at-pane:pane-ag-1"
    db = reader.project_dirs()[0] / "21fdfc1b-883a-47ce-b547-e9179ba62eef.db"
    _make_conversation_db(
        db, ws,
        extra_blob=f"\n<!-- agent-team-session: {marker} -->\n".encode(),
    )

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-ag-1", vendor="antigravity", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )

    usage = TokenUsage(
        vendor="antigravity", input_tokens=0, output_tokens=0,
        cwd=str(ws), session_id=db.stem, file_path=str(db), dedup_key="",
    )
    binding = attr.maybe_announce_session(usage)

    assert binding is not None
    assert binding.pane_id == "pane-ag-1"
    # Resume id is the conversation db stem — what `agy --conversation` needs.
    assert binding.resume_id == "21fdfc1b-883a-47ce-b547-e9179ba62eef"


def test_marker_in_wal_only_still_binds(tmp_path: Path, monkeypatch) -> None:
    """Markers typed right after spawn often sit in the -wal journal before
    SQLite checkpoints them into the main db."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()
    marker = "at-pane:pane-ag-2"
    db = reader.project_dirs()[0] / "aaaa1111-0000-0000-0000-000000000000.db"
    _make_conversation_db(db, ws)  # marker NOT in the db itself
    Path(str(db) + "-wal").write_bytes(
        b"\x00walframe<!-- agent-team-session: " + marker.encode() + b" -->\x00"
    )

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-ag-2", vendor="antigravity", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )
    usage = TokenUsage(
        vendor="antigravity", input_tokens=0, output_tokens=0,
        cwd=str(ws), session_id=db.stem, file_path=str(db), dedup_key="",
    )
    binding = attr.maybe_announce_session(usage)

    assert binding is not None
    assert binding.pane_id == "pane-ag-2"
    assert binding.resume_id == "aaaa1111-0000-0000-0000-000000000000"


def test_new_conversation_fallback_binds_single_antigravity_pane(
    tmp_path: Path, monkeypatch
) -> None:
    """If the marker has not reached SQLite yet, a single new conversation in
    the pane's cwd is still enough to capture the resume id."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-ag-single", vendor="antigravity", cwd=str(ws),
        workspace_path=str(ws), session_marker="at-pane:single",
    )

    db = reader.project_dirs()[0] / "single-new-session.db"
    _make_conversation_db(db, ws)
    usage = TokenUsage(
        vendor="antigravity", input_tokens=0, output_tokens=0,
        cwd=str(ws), session_id=db.stem, file_path=str(db), dedup_key="",
    )

    binding = attr.maybe_announce_session(usage)

    assert binding is not None
    assert binding.pane_id == "pane-ag-single"
    assert binding.resume_id == "single-new-session"


def test_new_conversation_fallback_does_not_guess_between_two_antigravity_panes(
    tmp_path: Path, monkeypatch
) -> None:
    """Two fresh Antigravity panes in one cwd must wait for marker matching
    rather than claiming the first new db arbitrarily."""
    reader = _reader_rooted_at(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    ws.mkdir()

    attr = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    attr.register_pane(
        "pane-ag-a", vendor="antigravity", cwd=str(ws),
        workspace_path=str(ws), session_marker="at-pane:a",
    )
    attr.register_pane(
        "pane-ag-b", vendor="antigravity", cwd=str(ws),
        workspace_path=str(ws), session_marker="at-pane:b",
    )

    db = reader.project_dirs()[0] / "ambiguous-session.db"
    _make_conversation_db(db, ws)
    usage = TokenUsage(
        vendor="antigravity", input_tokens=0, output_tokens=0,
        cwd=str(ws), session_id=db.stem, file_path=str(db), dedup_key="",
    )

    assert attr.maybe_announce_session(usage) is None
