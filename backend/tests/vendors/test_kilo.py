"""KiloLogReader: Kilo Code (OpenCode fork) token parsing + marker binding.

Kilo keeps OpenCode's schema (project / session / message / part) in ONE
shared db at <XDG_DATA_HOME|~/.local/share>/kilo/kilo.db; the reader is a
thin subclass of OpencodeLogReader, so these tests pin the kilo-specific
surface (vendor stamp, db location, dev-channel db exclusion) plus one pass
over each inherited behavior against the kilo paths.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend.log_readers import KiloLogReader, TokenUsage
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

_NOW_MS = 1785045142610
_SID = "ses_29e1bcdcaffe3eXy2s3zezKilo"


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    d = tmp_path / "xdg" / "kilo"
    d.mkdir(parents=True)
    return d


def _create_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path)
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
        " VALUES (?, 'proj1', ?, 'slug', ?, 'title', '7.4.16', ?, ?)",
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
        vendor="kilo", input_tokens=0, output_tokens=0, cwd="",
        session_id=db.stem, file_path=str(db), dedup_key="",
    )


# ── tolerance / location ─────────────────────────────────────────────────────

def test_missing_db_silently_skips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    reader = KiloLogReader()  # no data dir at all → CLI not installed
    assert reader.project_dirs() == []
    assert reader.session_files() == []
    db = tmp_path / "xdg" / "kilo" / "kilo.db"
    assert reader.parse_session_file(db, set()) == []
    assert reader.find_sessions_by_marker(["at-pane:x"]) == {}
    assert reader.has_session(_SID) is False


def test_reads_only_the_stable_kilo_db(data_dir: Path) -> None:
    """kilo.db is the session source; dev-channel dbs (kilo-<channel>.db) and
    sibling files under the data dir must not coin ids or parse."""
    reader = KiloLogReader()
    assert reader.project_dirs() == [data_dir]
    assert reader.session_files() == []  # no kilo.db yet

    nightly = data_dir / "kilo-nightly.db"
    con = _create_db(nightly)
    _add_session(con, _SID, "/ws")
    _add_message(con, "msg_a1", _SID, _assistant_data({"input": 9, "output": 3}))
    con.close()
    assert reader.session_files() == []
    assert reader.session_id_from_path(nightly) == ""
    assert reader.parse_session_file(nightly, set()) == []
    assert reader.parse_incremental(nightly, {}).events == []
    assert reader.has_session(_SID) is False  # only kilo.db is consulted

    db = data_dir / "kilo.db"
    _create_db(db).close()
    assert reader.session_files() == [db]
    assert reader.session_id_from_path(db) == "kilo"


def test_kilo_reader_does_not_read_opencode_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fork shares the schema, not the database — an installed opencode
    must stay invisible to the kilo reader (and its vendor stamp)."""
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    oc_dir = tmp_path / "xdg" / "opencode"
    oc_dir.mkdir(parents=True)
    con = _create_db(oc_dir / "opencode.db")
    _add_session(con, _SID, "/ws")
    con.close()

    reader = KiloLogReader()
    assert reader.project_dirs() == []
    assert reader.session_files() == []
    assert reader.has_session(_SID) is False


# ── usage parsing ────────────────────────────────────────────────────────────

def test_parse_stamps_kilo_vendor_and_folds_tokens(data_dir: Path) -> None:
    reader = KiloLogReader()
    ws = str(data_dir.parent / "proj")
    db = data_dir / "kilo.db"
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
    assert e.vendor == "kilo"
    assert e.input_tokens == 4050 + 8811 + 475
    assert e.output_tokens == 511 + 7
    assert e.cwd == ws
    assert e.session_id == _SID
    assert e.file_path == str(db)
    assert e.dedup_key == "msg:msg_a1"


def test_incremental_parse_uses_rowid_watermark(data_dir: Path) -> None:
    reader = KiloLogReader()
    db = data_dir / "kilo.db"
    con = _create_db(db)
    _add_session(con, _SID, "/ws")
    _add_message(con, "msg_a1", _SID, _assistant_data({"input": 10, "output": 2}))
    first = reader.parse_incremental(db, {})
    assert [(e.input_tokens, e.output_tokens) for e in first.events] == [(10, 2)]
    assert first.checkpoint["row_id"] == 1
    assert first.events[0].vendor == "kilo"

    _add_message(con, "msg_a2", _SID, _assistant_data({"input": 30, "output": 7}))
    con.close()
    second = reader.parse_incremental(db, first.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in second.events] == [(30, 7)]
    assert second.checkpoint["row_id"] == 2


# ── marker detection / session binding ───────────────────────────────────────

def test_marker_binding_announces_kilo_session(data_dir: Path) -> None:
    reader = KiloLogReader()
    ws = data_dir.parent / "ws"
    ws.mkdir()
    marker = "at-pane:pane-kilo-1"
    db = data_dir / "kilo.db"
    con = _create_db(db)
    _add_session(con, _SID, str(ws))
    _add_user_turn(con, _SID, "msg_u1", f"kickoff…\nsession marker: {marker}\n")

    attr = Attribution([reader], workspaces_path=data_dir.parent / "ws.json")
    attr.register_pane(
        "pane-kilo-1", vendor="kilo", cwd=str(ws),
        workspace_path=str(ws), session_marker=marker,
    )

    binding = attr.maybe_announce_session(_session_sink_usage(db))
    con.close()

    assert binding is not None
    assert binding.pane_id == "pane-kilo-1"
    # Resume id is the session.id (`ses_…`) that `kilo --session` accepts.
    assert binding.resume_id == _SID
    assert binding.workspace_path == str(ws)
    # Binding is a transition: the same db event never re-announces.
    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


def test_marker_in_other_workspace_does_not_bind(data_dir: Path) -> None:
    """A marker echoed in a session of ANOTHER project must not cross-bind."""
    reader = KiloLogReader()
    pane_ws = data_dir.parent / "pane-ws"
    pane_ws.mkdir()
    marker = "at-pane:pane-kilo-2"
    db = data_dir / "kilo.db"
    con = _create_db(db)
    _add_session(con, "ses_other", str(data_dir.parent / "other-ws"))
    _add_user_turn(con, "ses_other", "msg_u1", f"pasted text with {marker}")
    con.close()

    attr = Attribution([reader], workspaces_path=data_dir.parent / "ws.json")
    attr.register_pane(
        "pane-kilo-2", vendor="kilo", cwd=str(pane_ws),
        workspace_path=str(pane_ws), session_marker=marker,
    )

    assert attr.maybe_announce_session(_session_sink_usage(db)) is None


def test_marker_in_subagent_child_session_does_not_bind(data_dir: Path) -> None:
    """parent_id ≠ NULL = subagent session — never a resumable pane session."""
    reader = KiloLogReader()
    con = _create_db(data_dir / "kilo.db")
    _add_session(con, "ses_parent", "/ws")
    _add_session(con, "ses_child", "/ws", parent_id="ses_parent")
    _add_user_turn(con, "ses_child", "msg_u1", "forwarded at-pane:pane-x")
    con.close()

    assert reader.find_sessions_by_marker(["at-pane:pane-x"]) == {}


# ── resume preflight ─────────────────────────────────────────────────────────

def test_has_session_checks_the_shared_db(data_dir: Path) -> None:
    reader = KiloLogReader()
    con = _create_db(data_dir / "kilo.db")
    _add_session(con, _SID, "/ws")
    con.close()
    assert reader.has_session(_SID) is True
    assert reader.has_session("ses_missing") is False
    assert reader.has_session("") is False


# ── credentials (multi-account slot layout + identity) ───────────────────────

def test_spec_declares_the_credential_slot_layout() -> None:
    """The credential-swap fields: the live file is the path `kilo auth list`
    prints, and no login-home isolation is claimed (kilo has no config-home
    variable — a login pane signs in against the real home)."""
    from agent_team_backend.cli_vendors.kilo import KILO_AUTH_FILE_REL, SPEC

    assert SPEC.live_file == KILO_AUTH_FILE_REL == (
        ".local", "share", "kilo", "auth.json")
    assert SPEC.slot_file == "auth.json"
    assert SPEC.login_home_env is None
    assert SPEC.login_home_secret_file is None


@pytest.mark.parametrize("secret,signed_in", [
    ('{"kilo": {"type": "api", "key": "kilo_abc"}}', True),
    ('{"kilo": {"type": "oauth", "access": "at", "accountId": "org-1"}}', True),
    ('{"kilo": {"type": "api", "key": ""}}', False),
    ('{"kilo": {"type": "oauth", "accountId": "org-1"}}', False),
    ('{"kilo": "not-an-object"}', False),
    ('{"anthropic": {"type": "api", "key": "k"}}', False),
    ("{not json", False),
    ("[]", False),
    (None, False),
])
def test_identity_from_secret_reports_only_presence(secret, signed_in: bool) -> None:
    """kilo's auth.json carries no email/user id (``accountId`` is the ORG), so
    the identity is a presence flag and the email stays empty rather than
    borrowing a field that names something else."""
    from agent_team_backend.cli_vendors.kilo import identity_from_secret

    assert identity_from_secret(secret) == {"email": None, "signedIn": signed_in}
