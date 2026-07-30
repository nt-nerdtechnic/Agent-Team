"""One-time, on-startup backup + forward-migration of persisted JSON stores.

When a NEW app version's backend starts for the first time we:

1. BACKUP the persisted app-data JSON stores into
   ``<app-data>/store-backups/<version>/`` (keeping the most recent 2 backup
   dirs), so a version upgrade can never silently corrupt a user's saved data.
2. MIGRATE each versioned store forward to the current schema via a registry
   keyed by ``schemaVersion``. At schema v1 the registry is empty, so this is a
   clean identity/no-op — the extension point exists for future bumps.
3. Record the current backend version in a marker file so the next same-version
   start is a fast no-op.

Everything here is best-effort: it is idempotent and must NEVER raise or block
backend startup. Errors are caught and logged. It never deletes user data
(only prunes its own older backup directories).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .applog import app_data_dir
from .db import DB_FILENAME
from .roles_store import ROLES_FILE
from .stages_store import PIPELINES_FILE, SCHEMA_VERSION as STORE_SCHEMA_VERSION
from .tokens_store import (
    TOKENS_FILE,
    TOKENS_SCHEMA_VERSION,
    WORKSPACES_SUBDIR,
    migrate_tokens_v1_to_v2,
    migrate_tokens_v2_to_v3,
)

log = logging.getLogger("agent_team_backend.store_migrations")

# Marker holding the last backend version that ran against this app-data dir.
MARKER_FILE = ".navide-last-version"
# Subdir under app-data holding per-version backup copies.
BACKUP_DIR = "store-backups"
# How many most-recent backup dirs to keep; older ones are pruned.
KEEP_BACKUPS = 2

# The canonical user-data JSON stores that live directly under app-data.
# Derived token caches (recorded-event-keys.json, ingestion-state, journal) and
# per-workspace project.json are intentionally excluded — they self-heal.
# After the SQLite migration these files are retired (*.migrated-v1) and the
# live data sits in navide.db, which _backup_stores snapshots separately.
STORE_FILENAMES: tuple[str, ...] = (PIPELINES_FILE, ROLES_FILE, TOKENS_FILE)

# Each store carries its own schemaVersion and target. Roles is a bare list
# (no version) and never migrates; pipelines tracks STORE_SCHEMA_VERSION.
_TARGET_VERSION: dict[str, int] = {
    PIPELINES_FILE: STORE_SCHEMA_VERSION,
    ROLES_FILE: STORE_SCHEMA_VERSION,
    TOKENS_FILE: TOKENS_SCHEMA_VERSION,
}

# Forward-migration registry, per store filename: maps a doc's current
# schemaVersion N to a function upgrading it from N to N+1. Each function must
# return a NEW dict when it changes anything (so the writer knows to persist)
# and the same object once no upgrade applies (idempotent, gated on version).
_MIGRATIONS: dict[str, dict[int, Callable[[Any], Any]]] = {
    TOKENS_FILE: {1: migrate_tokens_v1_to_v2, 2: migrate_tokens_v2_to_v3},
}


def run_startup_migrations(
    data_dir: Path | None = None, current_version: str | None = None
) -> None:
    """Entry point called once on backend startup. Never raises.

    Backs up + forward-migrates the persisted stores when the backend version
    changed since the last run (or the marker is missing but stores exist).
    Same version → no backup, no-op.
    """
    try:
        _run(data_dir, current_version)
    except Exception as err:  # noqa: BLE001
        # Data protection must never block startup.
        log.warning("store backup/migration failed (non-fatal): %s", err)


def _run(data_dir: Path | None, current_version: str | None) -> None:
    base = data_dir or app_data_dir()
    version = current_version or __version__
    marker = base / MARKER_FILE
    last = _read_marker(marker)

    if last == version:
        return  # Same version already recorded — nothing to do.

    stores_exist = any((base / name).exists() for name in STORE_FILENAMES)
    if last is None and not stores_exist:
        # Fresh install: no prior data to protect. Just stamp the version.
        _write_marker(marker, version)
        return

    # Version changed (or marker missing but stores exist) → protect data.
    _backup_stores(base, version)
    _run_migrations(base)
    _write_marker(marker, version)
    log.info("store data protected for version upgrade %s -> %s", last, version)


# ─────────────────────────── marker ────────────────────────────


def _read_marker(marker: Path) -> str | None:
    try:
        text = marker.read_text(encoding="utf-8").strip()
        return text or None
    except (OSError, ValueError):
        return None


def _write_marker(marker: Path, version: str) -> None:
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(version, encoding="utf-8")


# ─────────────────────────── backup ────────────────────────────


def _backup_stores(base: Path, version: str) -> None:
    dest = base / BACKUP_DIR / version
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
    for name in STORE_FILENAMES:
        src = base / name
        if src.exists():
            shutil.copy2(src, dest / name)
            copied += 1
    if _backup_database(base, dest):
        copied += 1
    log.info("backed up %d store file(s) to %s", copied, dest)
    _prune_backups(base / BACKUP_DIR)


def _backup_database(base: Path, dest: Path) -> bool:
    """Snapshot navide.db into the version backup dir. Returns True on success.

    Uses SQLite's online backup API rather than a file copy: by the time this
    runs (startup task), the app's own connection is already live and writing,
    so a plain copy2 could capture a torn page image.
    """
    src = base / DB_FILENAME
    if not src.exists():
        return False
    out_file = dest / DB_FILENAME
    try:
        with closing(sqlite3.connect(str(src))) as conn, closing(
            sqlite3.connect(str(out_file))
        ) as out:
            conn.backup(out)
        # The backup holds the same secrets as the live database (which gets
        # 0600 from AIChatSettingsStore); don't leave it at the umask default.
        os.chmod(out_file, 0o600)
        return True
    except (sqlite3.Error, OSError) as err:  # noqa: BLE001
        log.warning("navide.db backup failed (%s); continuing", err)
        return False


def _prune_backups(backup_root: Path) -> None:
    """Keep only the KEEP_BACKUPS most recently modified backup dirs."""
    try:
        dirs = [d for d in backup_root.iterdir() if d.is_dir()]
    except OSError:
        return
    if len(dirs) <= KEEP_BACKUPS:
        return
    dirs.sort(key=lambda d: d.stat().st_mtime)
    for old in dirs[:-KEEP_BACKUPS]:
        shutil.rmtree(old, ignore_errors=True)


# ────────────────────────── migration ──────────────────────────


def apply_migrations(doc: Any, name: str | None = None) -> Any:
    """Forward-migrate a parsed store doc to its store's target schemaVersion.

    `name` selects the store's target version + migration chain; when omitted
    the pipelines/roles default (STORE_SCHEMA_VERSION, empty chain) applies.
    Bare-list stores (roles.json) carry no schemaVersion and pass through
    unchanged.
    """
    if not isinstance(doc, dict):
        return doc
    target = _TARGET_VERSION.get(name, STORE_SCHEMA_VERSION)
    migrations = _MIGRATIONS.get(name, {})
    version = _coerce_version(doc.get("schemaVersion", 1))
    while version < target and version in migrations:
        doc = migrations[version](doc)
        version += 1
    return doc


def _coerce_version(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


def _run_migrations(base: Path) -> None:
    """Apply forward migrations to each versioned store file in place.

    Covers the top-level canonical stores AND every per-workspace tokens.json
    under ``<base>/workspaces/<sha>/`` (the tokens schema versions in both).
    Docs that come back unchanged are not rewritten; files newer than we
    understand are left untouched.
    """
    for name in STORE_FILENAMES:
        path = base / name
        if not path.exists():
            continue
        try:
            _migrate_file(path, name)
        except Exception as err:  # noqa: BLE001
            log.warning("migration of %s failed (non-fatal): %s", path, err)

    ws_root = base / WORKSPACES_SUBDIR
    if ws_root.is_dir():
        for ws_dir in ws_root.iterdir():
            ws_tokens = ws_dir / TOKENS_FILE
            if not ws_tokens.exists():
                continue
            try:
                _migrate_file(ws_tokens, TOKENS_FILE)
            except Exception as err:  # noqa: BLE001
                log.warning("migration of %s failed (non-fatal): %s", ws_tokens, err)


def _migrate_file(path: Path, name: str) -> None:
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        return  # bare-list store; nothing to migrate
    target = _TARGET_VERSION.get(name, STORE_SCHEMA_VERSION)
    version = _coerce_version(doc.get("schemaVersion", 1))
    if version > target:
        # Newer than we understand — do not touch it.
        return
    migrated = apply_migrations(doc, name)
    if migrated is not doc:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(migrated, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(path)
