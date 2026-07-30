"""Tests for the SQLite persistence layer (db.py)."""

from __future__ import annotations

import json
import sqlite3
import threading

import pytest

from agent_team_backend.db import MIGRATED_SUFFIX, Database


@pytest.fixture()
def db(tmp_path):
    d = Database(tmp_path / "navide.db")
    yield d
    d.close()


# ── kv ───────────────────────────────────────────────────────────────


def test_kv_round_trip(db):
    doc = {"theme": "dark", "panes": [1, 2, 3], "nested": {"a": None}}
    db.kv_set("ui_settings", doc, now=100)
    assert db.kv_get("ui_settings") == doc


def test_kv_get_missing_returns_default(db):
    assert db.kv_get("nope") is None
    assert db.kv_get("nope", default={}) == {}


def test_kv_set_overwrites(db):
    db.kv_set("k", {"v": 1}, now=1)
    db.kv_set("k", {"v": 2}, now=2)
    assert db.kv_get("k") == {"v": 2}


def test_kv_delete(db):
    db.kv_set("k", 1, now=1)
    db.kv_delete("k")
    assert db.kv_get("k") is None


def test_kv_survives_reopen(tmp_path):
    path = tmp_path / "navide.db"
    d1 = Database(path)
    d1.kv_set("k", {"v": "persisted"}, now=1)
    d1.close()
    d2 = Database(path)
    try:
        assert d2.kv_get("k") == {"v": "persisted"}
    finally:
        d2.close()


# ── transactions ─────────────────────────────────────────────────────


def test_transaction_rolls_back_on_error(db):
    db.kv_set("k", "before", now=1)
    with pytest.raises(RuntimeError):
        with db.transaction() as cur:
            cur.execute(
                "INSERT OR REPLACE INTO kv (key, value, updated_at)"
                " VALUES ('k', '\"during\"', 2)"
            )
            raise RuntimeError("boom")
    assert db.kv_get("k") == "before"


def test_nested_transaction_joins_outer(db):
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES ('a', '1', 1)"
        )
        # Inner transaction must not commit the outer one midway.
        with db.transaction() as inner:
            inner.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('b', '2', 1)"
            )
    assert db.kv_get("a") == 1
    assert db.kv_get("b") == 2


def test_nested_rollback_discards_everything(db):
    with pytest.raises(RuntimeError):
        with db.transaction() as cur:
            cur.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES ('a', '1', 1)"
            )
            with db.transaction() as inner:
                inner.execute(
                    "INSERT INTO kv (key, value, updated_at) VALUES ('b', '2', 1)"
                )
                raise RuntimeError("inner boom")
    assert db.kv_get("a") is None
    assert db.kv_get("b") is None


def test_no_implicit_open_transaction_after_write(db):
    db.kv_set("k", 1, now=1)
    # Autocommit mode: nothing should be left open between calls.
    assert not db._conn.in_transaction


# ── schema migrations ────────────────────────────────────────────────


def test_migrate_applies_in_sequence(db):
    ran = []
    assert db.migrate("tokens", 1, lambda cur: ran.append(1)) is True
    assert db.migrate("tokens", 1, lambda cur: ran.append("again")) is False
    assert db.migrate("tokens", 2, lambda cur: ran.append(2)) is True
    assert ran == [1, 2]
    assert db.schema_version("tokens") == 2


def test_migrate_rejects_version_gap(db):
    with pytest.raises(ValueError):
        db.migrate("tokens", 3, lambda cur: None)


def test_migrate_failure_rolls_back_version(db):
    def bad(cur):
        cur.execute("CREATE TABLE t1 (x)")
        raise RuntimeError("ddl boom")

    with pytest.raises(RuntimeError):
        db.migrate("tokens", 1, bad)
    assert db.schema_version("tokens") == 0
    with db.transaction() as cur:
        names = {
            r["name"]
            for r in cur.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert "t1" not in names


def test_migrate_components_are_independent(db):
    db.migrate("tokens", 1, lambda cur: None)
    assert db.schema_version("tokens") == 1
    assert db.schema_version("history") == 0


# ── JSON import ──────────────────────────────────────────────────────


def _kv_loader(key):
    def load(cur, data):
        cur.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)",
            (key, json.dumps(data)),
        )

    return load


def test_import_json_happy_path(db, tmp_path):
    src = tmp_path / "roles.json"
    src.write_text(json.dumps({"roles": ["dev"]}), encoding="utf-8")

    assert db.import_json("roles", src, _kv_loader("roles")) is True
    assert db.kv_get("roles") == {"roles": ["dev"]}
    assert not src.exists()
    retired = tmp_path / ("roles.json" + MIGRATED_SUFFIX)
    assert retired.exists()
    assert json.loads(retired.read_text()) == {"roles": ["dev"]}


def test_import_json_is_idempotent(db, tmp_path):
    src = tmp_path / "roles.json"
    src.write_text(json.dumps({"v": 1}), encoding="utf-8")
    assert db.import_json("roles", src, _kv_loader("roles")) is True

    # A stale copy reappearing (e.g. restored from backup) must not re-import.
    src.write_text(json.dumps({"v": 999}), encoding="utf-8")
    assert db.import_json("roles", src, _kv_loader("roles")) is False
    assert db.kv_get("roles") == {"v": 1}
    # ...but it is retired out of the way.
    assert not src.exists()


def test_import_json_missing_source_marks_done(db, tmp_path):
    src = tmp_path / "ghost.json"
    assert db.import_json("ghost", src, _kv_loader("ghost")) is False
    assert db.import_completed("ghost")


def test_import_json_corrupt_source_starts_empty_keeps_file(db, tmp_path):
    src = tmp_path / "bad.json"
    src.write_text("{not json", encoding="utf-8")
    assert db.import_json("bad", src, _kv_loader("bad")) is False
    assert db.import_completed("bad")
    # Kept in place, unrenamed, for manual inspection.
    assert src.exists()


def test_import_json_failure_rolls_back_completely(db, tmp_path):
    src = tmp_path / "data.json"
    src.write_text(json.dumps({"v": 1}), encoding="utf-8")

    def exploding(cur, data):
        cur.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES ('partial', '1', 0)"
        )
        raise RuntimeError("import boom")

    with pytest.raises(RuntimeError):
        db.import_json("data", src, exploding)
    # All-or-nothing: no marker, no partial rows, source untouched.
    assert not db.import_completed("data")
    assert db.kv_get("partial") is None
    assert src.exists()

    # And the import can be retried successfully afterwards.
    assert db.import_json("data", src, _kv_loader("data")) is True
    assert db.kv_get("data") == {"v": 1}


def test_import_json_finishes_rename_after_crash_window(db, tmp_path):
    # Simulate a crash between commit and rename: marker present, source
    # still under its original name.
    src = tmp_path / "data.json"
    src.write_text(json.dumps({"v": 1}), encoding="utf-8")
    db._mark_imported("data")

    assert db.import_json("data", src, _kv_loader("data")) is False
    assert not src.exists()
    assert (tmp_path / ("data.json" + MIGRATED_SUFFIX)).exists()


# ── legacy-writer coexistence (merge) ────────────────────────────────


def test_import_json_merges_regenerated_source(db, tmp_path):
    src = tmp_path / "roles.json"
    src.write_text(json.dumps({"v": 1}), encoding="utf-8")
    assert db.import_json("roles", src, _kv_loader("roles")) is True

    # An older app version sharing the data dir regenerates the file.
    src.write_text(json.dumps({"v": 2}), encoding="utf-8")
    merged = []
    assert (
        db.import_json(
            "roles", src, _kv_loader("roles"),
            merge=lambda cur, data: merged.append(data),
        )
        is True
    )
    assert merged == [{"v": 2}]
    # Marker untouched, load not re-run, regenerated source retired again.
    assert db.import_completed("roles")
    assert db.kv_get("roles") == {"v": 1}
    assert not src.exists()


def test_import_json_merge_unused_on_first_import(db, tmp_path):
    src = tmp_path / "roles.json"
    src.write_text(json.dumps({"v": 1}), encoding="utf-8")
    merged = []
    assert (
        db.import_json(
            "roles", src, _kv_loader("roles"),
            merge=lambda cur, data: merged.append(data),
        )
        is True
    )
    # The first import goes through load; merge is coexistence-only.
    assert merged == []
    assert db.kv_get("roles") == {"v": 1}


def test_import_json_merge_corrupt_regenerated_source_kept(db, tmp_path):
    src = tmp_path / "roles.json"
    src.write_text(json.dumps({"v": 1}), encoding="utf-8")
    assert db.import_json("roles", src, _kv_loader("roles")) is True

    src.write_text("{not json", encoding="utf-8")
    merged = []
    assert (
        db.import_json(
            "roles", src, _kv_loader("roles"),
            merge=lambda cur, data: merged.append(data),
        )
        is False
    )
    # Nothing merged; the bad file stays in place for inspection.
    assert merged == []
    assert src.exists()
    assert db.kv_get("roles") == {"v": 1}


def test_retire_preserves_earlier_backups_with_serial_names(db, tmp_path):
    src = tmp_path / "roles.json"
    src.write_text(json.dumps({"v": 1}), encoding="utf-8")
    assert db.import_json("roles", src, _kv_loader("roles")) is True

    # Two regenerations: each retirement takes the next free serial name
    # instead of overwriting the .migrated-v1 backup.
    for v in (2, 3):
        src.write_text(json.dumps({"v": v}), encoding="utf-8")
        db.import_json("roles", src, _kv_loader("roles"))
    base = "roles.json" + MIGRATED_SUFFIX
    assert json.loads((tmp_path / base).read_text()) == {"v": 1}
    assert json.loads((tmp_path / (base + "-2")).read_text()) == {"v": 2}
    assert json.loads((tmp_path / (base + "-3")).read_text()) == {"v": 3}
    assert not src.exists()


def test_retire_gives_up_after_bounded_serials(db, tmp_path, caplog):
    src = tmp_path / "roles.json"
    src.write_text("{}", encoding="utf-8")
    base = "roles.json" + MIGRATED_SUFFIX
    (tmp_path / base).write_text("{}", encoding="utf-8")
    for n in range(2, 100):
        (tmp_path / f"{base}-{n}").write_text("{}", encoding="utf-8")
    with caplog.at_level("WARNING"):
        assert db._retire_source(src) is False
    assert src.exists()
    assert any("too many retired copies" in r.message for r in caplog.records)


def test_merge_removes_source_when_retirement_is_exhausted(db, tmp_path, caplog):
    """A merged source that cannot be retired must not stay in place: the
    data is already in the database and a leftover file would be re-merged
    (re-appended) on every later access."""
    src = tmp_path / "roles.json"
    src.write_text(json.dumps({"v": 1}), encoding="utf-8")
    assert db.import_json("roles", src, _kv_loader("roles")) is True

    # Regenerated source with every retirement serial already taken.
    src.write_text(json.dumps({"v": 2}), encoding="utf-8")
    base = "roles.json" + MIGRATED_SUFFIX
    for n in range(2, 100):
        (tmp_path / f"{base}-{n}").write_text("{}", encoding="utf-8")
    merged = []
    with caplog.at_level("WARNING"):
        assert (
            db.import_json(
                "roles", src, _kv_loader("roles"),
                merge=lambda cur, data: merged.append(data),
            )
            is True
        )
    assert merged == [{"v": 2}]
    assert not src.exists()
    assert any("removed merged" in r.message for r in caplog.records)


# ── concurrency ──────────────────────────────────────────────────────


def test_concurrent_writers_do_not_corrupt(db):
    errors = []

    def writer(n):
        try:
            for i in range(50):
                db.kv_set(f"k{n}", i, now=i)
        except Exception as err:  # pragma: no cover
            errors.append(err)

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    for n in range(4):
        assert db.kv_get(f"k{n}") == 49


def test_reader_sees_consistent_snapshot_not_partial(db):
    # A multi-row write in one transaction must never be half-visible.
    def write_pair():
        with db.transaction() as cur:
            cur.execute(
                "INSERT OR REPLACE INTO kv (key, value, updated_at)"
                " VALUES ('left', '1', 0)"
            )
            cur.execute(
                "INSERT OR REPLACE INTO kv (key, value, updated_at)"
                " VALUES ('right', '1', 0)"
            )

    write_pair()
    assert (db.kv_get("left"), db.kv_get("right")) == (1, 1)
