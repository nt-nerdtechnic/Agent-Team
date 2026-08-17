"""Tests for on-startup store backup + forward-migration (Phase D data protection).

Covers: schemaVersion tolerance on load, safe read of newer files, startup
backup on version change (and skip on same version), backup retention, the
identity migration path, and failure isolation (must not crash startup).
"""

from __future__ import annotations

import json
import os

import pytest

from agent_team_backend import store_migrations as sm
from agent_team_backend.stages_store import PIPELINES_FILE, SCHEMA_VERSION, StagesStore
from agent_team_backend.tokens_store import (
    TOKENS_SCHEMA_VERSION,
    TokensStore,
)


# ─────────────────── helpers ───────────────────


def _write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def _valid_pipelines_doc(schema=None):
    doc = {
        "version": 2,
        "active_pipeline_id": "default",
        "pipelines": [
            {"id": "default", "name": "P", "builtin": True, "stages": []},
        ],
    }
    if schema is not None:
        doc["schemaVersion"] = schema
    return doc


# ─────────────────── stages_store schemaVersion ───────────────────


class TestStagesSchemaVersion:
    def test_write_adds_schema_version(self, tmp_path):
        store = StagesStore(tmp_path / PIPELINES_FILE)
        store._read_doc()  # triggers seed + write
        stored = store._db.kv_get("pipelines")
        assert stored["schemaVersion"] == SCHEMA_VERSION

    def test_load_tolerates_missing_schema_version(self, tmp_path):
        path = tmp_path / PIPELINES_FILE
        _write_json(path, _valid_pipelines_doc(schema=None))  # legacy file, no key
        store = StagesStore(path)
        doc = store._read_doc()
        assert doc["version"] == 2
        assert doc["pipelines"][0]["id"] == "default"

    def test_higher_schema_version_not_overwritten(self, tmp_path):
        path = tmp_path / PIPELINES_FILE
        future = _valid_pipelines_doc(schema=99)
        future["pipelines"][0]["name"] = "FROM_FUTURE"
        _write_json(path, future)

        store = StagesStore(path)
        doc = store._read_doc()

        # Loaded as-is, not regenerated to defaults.
        assert doc["pipelines"][0]["name"] == "FROM_FUTURE"
        # Stored document untouched (no regenerate/truncate) — forward data
        # survives a re-read with its future schemaVersion intact.
        stored = store._db.kv_get("pipelines")
        assert stored["schemaVersion"] == 99
        assert stored["pipelines"][0]["name"] == "FROM_FUTURE"
        assert store._read_doc()["pipelines"][0]["name"] == "FROM_FUTURE"


# ─────────────────── tokens_store schemaVersion ───────────────────


class TestTokensSchemaVersion:
    def _make(self, tmp_path):
        store = TokensStore(global_path=tmp_path / "tokens.json")
        # Stop the background save loop so it can't race the assertions.
        store._stop_event.set()
        return store

    def test_empty_doc_has_schema_version(self, tmp_path):
        store = self._make(tmp_path)
        assert store._load_global()["schemaVersion"] == TOKENS_SCHEMA_VERSION

    def test_load_tolerates_missing_schema_version(self, tmp_path):
        gp = tmp_path / "tokens.json"
        _write_json(gp, {"all_time": {}, "by_vendor": {}, "by_day": {}})
        store = self._make(tmp_path)
        doc = store._load_global()
        # Missing key filled in, no crash.
        assert doc["schemaVersion"] == TOKENS_SCHEMA_VERSION

    def test_higher_schema_version_load_does_not_crash(self, tmp_path):
        gp = tmp_path / "tokens.json"
        _write_json(
            gp,
            {"schemaVersion": 99, "all_time": {}, "by_vendor": {}, "by_day": {}, "x": 1},
        )
        store = self._make(tmp_path)
        doc = store._load_global()
        assert doc["schemaVersion"] == 99  # preserved, not downgraded
        assert doc["x"] == 1  # unknown forward key preserved


# ─────────────────── backup + marker ───────────────────


class TestStartupBackup:
    def test_same_version_is_noop(self, tmp_path):
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))
        (tmp_path / sm.MARKER_FILE).write_text("9.9.9", encoding="utf-8")

        sm.run_startup_migrations(tmp_path, "9.9.9")

        assert not (tmp_path / sm.BACKUP_DIR).exists()

    def test_version_change_backs_up(self, tmp_path):
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))
        (tmp_path / sm.MARKER_FILE).write_text("1.0.0", encoding="utf-8")

        sm.run_startup_migrations(tmp_path, "1.0.1")

        backup = tmp_path / sm.BACKUP_DIR / "1.0.1" / PIPELINES_FILE
        assert backup.exists()
        assert json.loads(backup.read_text())["version"] == 2
        # Marker advanced.
        assert (tmp_path / sm.MARKER_FILE).read_text().strip() == "1.0.1"

    def test_marker_missing_but_stores_exist_backs_up(self, tmp_path):
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))
        # No marker file.
        sm.run_startup_migrations(tmp_path, "2.0.0")
        assert (tmp_path / sm.BACKUP_DIR / "2.0.0" / PIPELINES_FILE).exists()

    def test_version_change_snapshots_navide_db(self, tmp_path):
        # Post-SQLite-migration layout: JSON stores retired, data in navide.db.
        from agent_team_backend.db import DB_FILENAME, Database

        db = Database(tmp_path / DB_FILENAME)
        db.kv_set("roles", [{"key": "dev"}], now=1)
        db.close()
        (tmp_path / sm.MARKER_FILE).write_text("1.0.0", encoding="utf-8")

        sm.run_startup_migrations(tmp_path, "1.0.1")

        snap = tmp_path / sm.BACKUP_DIR / "1.0.1" / DB_FILENAME
        assert snap.exists()
        restored = Database(snap)
        try:
            assert restored.kv_get("roles") == [{"key": "dev"}]
        finally:
            restored.close()

    def test_navide_db_backup_is_owner_only(self, tmp_path):
        # The backup carries the same secrets (API keys) as the live
        # database, which is chmod'd 0600 — the snapshot must match.
        from agent_team_backend.db import DB_FILENAME, Database

        db = Database(tmp_path / DB_FILENAME)
        db.kv_set("k", {"v": 1}, now=1)
        db.close()
        (tmp_path / sm.MARKER_FILE).write_text("1.0.0", encoding="utf-8")

        sm.run_startup_migrations(tmp_path, "1.0.1")

        snap = tmp_path / sm.BACKUP_DIR / "1.0.1" / DB_FILENAME
        assert snap.exists()
        assert snap.stat().st_mode & 0o777 == 0o600

    def test_backup_survives_live_db_connection(self, tmp_path):
        # The app's connection is open and mid-write when the startup task
        # backs up; the online backup API must still produce a valid snapshot.
        from agent_team_backend.db import DB_FILENAME, Database

        db = Database(tmp_path / DB_FILENAME)
        db.kv_set("k", {"v": 1}, now=1)
        try:
            (tmp_path / sm.MARKER_FILE).write_text("1.0.0", encoding="utf-8")
            sm.run_startup_migrations(tmp_path, "1.0.1")
            snap = Database(tmp_path / sm.BACKUP_DIR / "1.0.1" / DB_FILENAME)
            try:
                assert snap.kv_get("k") == {"v": 1}
            finally:
                snap.close()
        finally:
            db.close()

    def test_fresh_install_no_backup_but_marker_written(self, tmp_path):
        # No marker, no stores.
        sm.run_startup_migrations(tmp_path, "3.0.0")
        assert not (tmp_path / sm.BACKUP_DIR).exists()
        assert (tmp_path / sm.MARKER_FILE).read_text().strip() == "3.0.0"

    def test_idempotent_second_run_same_version(self, tmp_path):
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))
        sm.run_startup_migrations(tmp_path, "1.0.0")  # first run, no marker + stores
        first = tmp_path / sm.BACKUP_DIR / "1.0.0"
        assert first.exists()
        # Second run at the same version → no new work.
        sm.run_startup_migrations(tmp_path, "1.0.0")
        assert len(list((tmp_path / sm.BACKUP_DIR).iterdir())) == 1


# ─────────────────── version-change report ───────────────────


class TestVersionChange:
    """What app.py tells a connecting window, so it can warn that an MCP client
    from the previous backend is holding that backend's tool list."""

    def test_reports_the_transition_once_the_version_moved(self, tmp_path):
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))
        (tmp_path / sm.MARKER_FILE).write_text("1.0.0", encoding="utf-8")

        sm.run_startup_migrations(tmp_path, "1.0.1")

        assert sm.version_change() == ("1.0.0", "1.0.1")

    def test_same_version_reports_nothing(self, tmp_path):
        (tmp_path / sm.MARKER_FILE).write_text("9.9.9", encoding="utf-8")

        sm.run_startup_migrations(tmp_path, "9.9.9")

        assert sm.version_change() is None

    def test_a_first_start_is_not_an_upgrade(self, tmp_path):
        # No marker: nothing was ever running against this dir, so no client can
        # be holding an older tool list.
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))

        sm.run_startup_migrations(tmp_path, "2.0.0")

        assert sm.version_change() is None

    def test_a_later_same_version_start_clears_an_earlier_report(self, tmp_path):
        (tmp_path / sm.MARKER_FILE).write_text("1.0.0", encoding="utf-8")
        sm.run_startup_migrations(tmp_path, "1.0.1")
        assert sm.version_change() is not None

        sm.run_startup_migrations(tmp_path, "1.0.1")

        assert sm.version_change() is None


# ─────────────────── retention ───────────────────


class TestRetention:
    def test_prune_keeps_two_newest(self, tmp_path):
        root = tmp_path / sm.BACKUP_DIR
        for i, name in enumerate(["v1", "v2", "v3"]):
            d = root / name
            d.mkdir(parents=True)
            # Force strictly increasing mtimes so ordering is deterministic.
            os.utime(d, (1000 + i, 1000 + i))

        sm._prune_backups(root)

        remaining = sorted(p.name for p in root.iterdir())
        assert remaining == ["v2", "v3"]

    def test_backup_over_three_versions_keeps_two(self, tmp_path):
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))
        for i, v in enumerate(["1.0.0", "1.0.1", "1.0.2"]):
            sm.run_startup_migrations(tmp_path, v)
            # Nudge mtime so prune ordering is unambiguous.
            os.utime(tmp_path / sm.BACKUP_DIR / v, (2000 + i, 2000 + i))

        dirs = sorted(p.name for p in (tmp_path / sm.BACKUP_DIR).iterdir())
        assert dirs == ["1.0.1", "1.0.2"]


# ─────────────────── migration registry ───────────────────


class TestMigrations:
    def test_identity_on_v1_dict(self, tmp_path):
        doc = _valid_pipelines_doc(1)
        assert sm.apply_migrations(doc) is doc  # empty registry → untouched

    def test_identity_on_bare_list(self, tmp_path):
        roles = [{"key": "dev"}]
        assert sm.apply_migrations(roles) is roles

    def test_run_migrations_leaves_v1_file_unchanged(self, tmp_path):
        path = tmp_path / PIPELINES_FILE
        _write_json(path, _valid_pipelines_doc(1))
        before = path.read_bytes()
        sm._run_migrations(tmp_path)
        assert path.read_bytes() == before

    def test_run_migrations_skips_newer_file(self, tmp_path):
        path = tmp_path / PIPELINES_FILE
        _write_json(path, _valid_pipelines_doc(99))
        before = path.read_bytes()
        sm._run_migrations(tmp_path)
        assert path.read_bytes() == before


# ─────────────────── failure isolation ───────────────────


class TestFailureIsolation:
    def test_backup_failure_does_not_raise(self, tmp_path, monkeypatch):
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))
        (tmp_path / sm.MARKER_FILE).write_text("1.0.0", encoding="utf-8")

        def boom(*a, **k):
            raise OSError("disk on fire")

        monkeypatch.setattr(sm.shutil, "copy2", boom)

        # Must not propagate — startup must not be blocked.
        sm.run_startup_migrations(tmp_path, "1.0.1")

    def test_migration_failure_does_not_raise(self, tmp_path, monkeypatch):
        _write_json(tmp_path / PIPELINES_FILE, _valid_pipelines_doc(1))
        (tmp_path / sm.MARKER_FILE).write_text("1.0.0", encoding="utf-8")

        def boom(doc):
            raise ValueError("bad migration")

        # A registered migration that blows up must be swallowed per-file.
        monkeypatch.setitem(sm._MIGRATIONS, PIPELINES_FILE, {1: boom})
        monkeypatch.setitem(sm._TARGET_VERSION, PIPELINES_FILE, 2)

        sm.run_startup_migrations(tmp_path, "1.0.1")  # no raise
