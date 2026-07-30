"""ChatStore — per-workspace chat threads/notes in the workspace database.

Covers round-trips through disk, backward-compatible defaults for missing
documents/fields, the one-time import of the legacy chat-threads.json /
chat-notes.json files (including corrupt/oversize tolerance),
invalid-workspace no-ops (never creates anything), and the self-gitignoring
.agent-team dir.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from agent_team_backend.chat_store import MAX_FILE_BYTES, ChatStore


# ── threads ──────────────────────────────────────────────────────────────────

def test_threads_round_trip_through_disk(tmp_path: Path) -> None:
    store = ChatStore()
    threads = [{"id": "t1", "title": "Hi", "messages": [{"role": "user", "content": "hey"}]}]
    assert store.set_threads(str(tmp_path), threads) is not None
    assert ChatStore().get_threads(str(tmp_path)) == threads


def test_threads_missing_file_defaults_to_empty(tmp_path: Path) -> None:
    assert ChatStore().get_threads(str(tmp_path)) == []


def test_threads_corrupt_legacy_file_defaults_to_empty(tmp_path: Path) -> None:
    """An unreadable legacy file imports as empty and is kept for inspection."""
    legacy = tmp_path / ".agent-team" / "chat-threads.json"
    legacy.parent.mkdir()
    legacy.write_text("{not json", encoding="utf-8")
    store = ChatStore()
    assert store.get_threads(str(tmp_path)) == []
    assert legacy.read_text(encoding="utf-8") == "{not json"
    # The store recovers: later writes land in the database and read back.
    store.set_threads(str(tmp_path), [{"id": "t1"}])
    assert ChatStore().get_threads(str(tmp_path)) == [{"id": "t1"}]


def test_threads_non_list_legacy_document_defaults_to_empty(tmp_path: Path) -> None:
    legacy = tmp_path / ".agent-team" / "chat-threads.json"
    legacy.parent.mkdir()
    legacy.write_text('{"a": 1}', encoding="utf-8")
    assert ChatStore().get_threads(str(tmp_path)) == []


def test_threads_oversize_legacy_file_defaults_to_empty(tmp_path: Path) -> None:
    legacy = tmp_path / ".agent-team" / "chat-threads.json"
    legacy.parent.mkdir()
    legacy.write_text("[" + " " * MAX_FILE_BYTES + "]", encoding="utf-8")
    assert ChatStore().get_threads(str(tmp_path)) == []


def test_set_threads_overwrites_whole_document(tmp_path: Path) -> None:
    store = ChatStore()
    store.set_threads(str(tmp_path), [{"id": "old"}])
    store.set_threads(str(tmp_path), [{"id": "new"}])
    assert ChatStore().get_threads(str(tmp_path)) == [{"id": "new"}]


# ── notes ────────────────────────────────────────────────────────────────────

def test_notes_round_trip_through_disk(tmp_path: Path) -> None:
    store = ChatStore()
    pads = [{"id": "n1", "name": "Plan", "content": "steps", "updatedAt": 1}]
    assert store.set_notes(str(tmp_path), notes="quick note", notepads=pads) is not None
    assert ChatStore().get_notes(str(tmp_path)) == {"notes": "quick note", "notepads": pads}


def test_notes_missing_file_defaults(tmp_path: Path) -> None:
    assert ChatStore().get_notes(str(tmp_path)) == {"notes": "", "notepads": []}


def test_notes_corrupt_legacy_file_defaults(tmp_path: Path) -> None:
    legacy = tmp_path / ".agent-team" / "chat-notes.json"
    legacy.parent.mkdir()
    legacy.write_text("[[", encoding="utf-8")
    assert ChatStore().get_notes(str(tmp_path)) == {"notes": "", "notepads": []}


def test_notes_wrong_field_types_fall_back_per_field(tmp_path: Path) -> None:
    store = ChatStore()
    f = tmp_path / ".agent-team"
    f.mkdir()
    (f / "chat-notes.json").write_text(
        json.dumps({"notes": 42, "notepads": {"nope": True}}), encoding="utf-8"
    )
    assert store.get_notes(str(tmp_path)) == {"notes": "", "notepads": []}


# ── legacy JSON import ───────────────────────────────────────────────────────

def test_legacy_json_imported_once_and_retired(tmp_path: Path) -> None:
    d = tmp_path / ".agent-team"
    d.mkdir()
    (d / "chat-threads.json").write_text(json.dumps([{"id": "t1"}]), encoding="utf-8")
    (d / "chat-notes.json").write_text(
        json.dumps({"notes": "n", "notepads": []}), encoding="utf-8"
    )
    store = ChatStore()
    assert store.get_threads(str(tmp_path)) == [{"id": "t1"}]
    assert store.get_notes(str(tmp_path)) == {"notes": "n", "notepads": []}
    assert not (d / "chat-threads.json").exists()
    assert (d / "chat-threads.json.migrated-v1").exists()
    assert (d / "chat-notes.json.migrated-v1").exists()
    # A fresh store reads the imported data (no re-import, no data loss).
    assert ChatStore().get_threads(str(tmp_path)) == [{"id": "t1"}]


def test_legacy_writer_regenerated_threads_newer_wins(tmp_path: Path) -> None:
    """Coexistence: an older app version recreates chat-threads.json after
    the import — last-writer-wins at document granularity, by file mtime vs
    the kv row's updated_at."""
    ChatStore().set_threads(str(tmp_path), [{"id": "from-db"}])
    legacy = tmp_path / ".agent-team" / "chat-threads.json"
    legacy.write_text(json.dumps([{"id": "from-legacy"}]), encoding="utf-8")
    os.utime(legacy, (time.time() + 100,) * 2)  # regenerated after the kv write
    assert ChatStore().get_threads(str(tmp_path)) == [{"id": "from-legacy"}]
    assert not legacy.exists()
    assert legacy.with_name(legacy.name + ".migrated-v1").exists()


def test_legacy_writer_regenerated_threads_older_is_discarded(tmp_path: Path) -> None:
    ChatStore().set_threads(str(tmp_path), [{"id": "from-db"}])
    legacy = tmp_path / ".agent-team" / "chat-threads.json"
    legacy.write_text(json.dumps([{"id": "from-legacy"}]), encoding="utf-8")
    os.utime(legacy, (time.time() - 100,) * 2)  # stale copy, kv is newer
    assert ChatStore().get_threads(str(tmp_path)) == [{"id": "from-db"}]
    assert not legacy.exists()  # retired without merging


# ── workspace validity / dir hygiene ─────────────────────────────────────────

def test_invalid_workspace_is_a_safe_no_op(tmp_path: Path) -> None:
    store = ChatStore()
    missing = str(tmp_path / "does-not-exist")
    assert store.set_threads(missing, [{"id": "t"}]) is None
    assert store.set_notes(missing, notes="n", notepads=[]) is None
    assert store.get_threads(missing) == []
    assert store.get_notes(missing) == {"notes": "", "notepads": []}
    assert store.set_threads("", []) is None
    assert not (tmp_path / "does-not-exist").exists()


def test_write_creates_self_gitignoring_dir(tmp_path: Path) -> None:
    ChatStore().set_threads(str(tmp_path), [])
    gi = tmp_path / ".agent-team" / ".gitignore"
    assert gi.read_text(encoding="utf-8") == "*\n"
