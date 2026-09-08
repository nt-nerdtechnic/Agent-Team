"""Plan-document discovery plus a per-workspace ``plan-meta`` cache.

Two operations back the plans list:

- :meth:`PlanIndex.list_docs` — scan every plan/report directory in one pass and
  return ``(rel_path, name, mtime)`` per document, each carrying the cached meta
  when the cached mtime still matches the file on disk.
- :meth:`PlanIndex.cache_put` — store the meta a caller parsed, keyed by
  ``rel_path`` + mtime.

The cache is **never the source of truth**. An entry whose mtime does not match
the file is reported as a miss and the caller re-reads that file; a missing or
unusable database degrades to "every document is a miss", so the list stays
complete either way. Parsing also stays in one place (the frontend plan stores,
which own both the HTML-island and the markdown-frontmatter formats) — this
module treats meta as an opaque JSON payload and never interprets it.

Storage is the workspace database (``<workspace>/.agent-team/navide.db``).
Reads go through ``WorkspaceDatabases.peek`` so that merely listing a folder's
plans never plants a database in someone's project; the file is created on the
first :meth:`cache_put`, i.e. only once the workspace actually has plan
documents.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from pathlib import Path
from threading import RLock
from typing import Any

from .db import Database, WorkspaceDatabases

log = logging.getLogger(__name__)

_COMPONENT = "plan_index"

# Directories scanned for plan and report documents, in list order. Mirrors the
# frontend PLAN_DOC_DIRS (editor/PlansPane.vue) and the watcher's set
# (git_watcher.PLAN_DOC_DIRS); all three must stay in sync.
PLAN_DOC_DIRS: tuple[str, ...] = (
    ".agent-team/plans",
    ".agent-team/reports",
    ".claude/loop-reports",
    ".claude/plans",
    ".cursor/plans",
    "docs/plans",
    "docs/reports",
)

_PLAN_DOC_DIR_SET = frozenset(PLAN_DOC_DIRS)

# Documents the list surfaces. `_`-prefixed files are infrastructure (spec,
# template) and dotfiles are hidden — both per `.agent-team/plans/_spec.md`.
_DOC_SUFFIXES = (".html", ".plan.md", ".md")

# Guards a single cache_put payload; a plans directory that large is a caller
# bug rather than a real workspace.
_MAX_CACHE_ENTRIES = 5_000

# ── Nested plan roots ───────────────────────────────────────────────────────
# A workspace is whatever folder the user opened, which is often a container
# holding the actual project(s) — the plans of a repo one level down would
# otherwise be invisible. Nested git repositories are treated as plan roots of
# their own: git already draws the project boundary the agents work against.
#
# Bounded on purpose. Depth 2 covers `<ws>/<repo>` and the usual monorepo
# `<ws>/<container>/<repo>` shape; noise directories are pruned so a scan never
# walks node_modules or a build tree.
_MAX_ROOT_DEPTH = 2

# Mirrors fs_service._NOISE_SEGMENTS (minus `.git`, which is the marker here).
_NOISE_SEGMENTS = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
    "target", ".next", ".nuxt", ".turbo", ".cache", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".gradle",
})

# Backstop for a pathological tree (thousands of sibling repos).
_MAX_NESTED_ROOTS = 50

# Maximum candidate directory entries scanned per directory level per data contract fixture.
_MAX_DIRECTORY_ENTRIES = 2000
_MAX_NESTED_CANDIDATES = 2000


def _create_plan_index_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE plan_index ("
        " rel_path TEXT PRIMARY KEY,"
        " mtime REAL NOT NULL,"
        " meta TEXT)"  # NULL = parsed to "no meta"; the row itself is the hit
    )


# Upward search bound: deep enough to escape a source tree, short enough that a
# workspace outside any repository never walks far up the filesystem.
_MAX_ROOT_ASCENT = 6


def resolve_plan_root(workspace_path: str) -> str:
    """The project root whose plans a path belongs to.

    Walks up to the nearest git repository root: git already draws the boundary
    that agents and users agree on, so a plan created from a subdirectory lands
    with the rest of the project's plans instead of starting a new pile.

    Returns ``workspace_path`` unchanged when there is no repository within the
    bound, when the path is not a directory, or when the walk reaches the user's
    home directory — a dotfiles repo at ``~`` must never become a plan root.

    The packaged Issue 21 test child carries a standalone copy of this resolver
    because it is built without importing the application backend package. The
    backend test suite keeps both implementations in parity.
    """
    if not workspace_path:
        return workspace_path
    try:
        current = Path(workspace_path).resolve()
        if not current.is_dir():
            return workspace_path
    except OSError:
        return workspace_path

    try:
        stop = Path.home().resolve()
    except (OSError, RuntimeError):
        stop = None

    for _ in range(_MAX_ROOT_ASCENT + 1):
        if current == stop or current.parent == current:
            break
        # `.git` is a directory in a normal clone, a file in a submodule or
        # linked worktree.
        if (current / ".git").exists():
            return str(current)
        current = current.parent
    return workspace_path


def is_plan_doc_name(name: str) -> bool:
    """True for a user-facing plan/report filename (infra and dotfiles excluded)."""
    if name.startswith(("_", ".")):
        return False
    lowered = name.lower()
    return any(lowered.endswith(suffix) for suffix in _DOC_SUFFIXES)


def is_plan_doc_rel_path(rel_path: str) -> bool:
    """True for ``[<root>/]<plan-doc-dir>/<filename>`` with a listable filename.

    ``<root>`` is the optional nested plan root the document belongs to. Cache
    keys are validated against this so a caller cannot write rows for arbitrary
    paths, and so stale keys from an older directory list are ignored.
    """
    normalized = (rel_path or "").replace("\\", "/").strip("/")
    parent, _, name = normalized.rpartition("/")
    if not name or not is_plan_doc_name(name):
        return False
    for plan_dir in PLAN_DOC_DIRS:
        if parent == plan_dir:
            return True
        if parent.endswith("/" + plan_dir):
            root = parent[: -len(plan_dir) - 1]
            # A root is a plain relative subpath: no traversal, no absolutes.
            segments = root.split("/")
            return bool(root) and all(seg not in ("", ".", "..") for seg in segments)
    return False


def find_nested_plan_roots(root: Path) -> list[str]:
    """Relative paths of nested git repositories, breadth-first and bounded.

    Only a real clone counts — a ``.git`` *directory*. A ``.git`` file marks a
    linked worktree or a submodule: a worktree is another checkout of a
    repository already listed, so honouring it would show every one of its plans
    a second time (once per branch checked out), and a submodule's documents
    belong to a third party.

    A repository is a leaf: the walk does not descend into one, so a vendored
    checkout cannot flood the list either. Shared with plan history so snapshot
    coverage and list coverage can never drift apart.
    """
    found: list[str] = []
    frontier: list[tuple[Path, int]] = [(root, 0)]
    visited = 0
    while frontier and len(found) < _MAX_NESTED_ROOTS and visited < _MAX_NESTED_CANDIDATES:
        current, depth = frontier.pop(0)
        if depth >= _MAX_ROOT_DEPTH:
            continue
        try:
            with os.scandir(current) as it:
                candidates = [
                    de
                    for de in it
                    if de.is_dir()
                    and not de.name.startswith(".")
                    and de.name not in _NOISE_SEGMENTS
                ]
            candidates.sort(key=lambda de: de.name.encode("utf-8"))
            children = candidates[:_MAX_DIRECTORY_ENTRIES]
        except (OSError, ValueError):
            continue
        for de in children:
            if len(found) >= _MAX_NESTED_ROOTS or visited >= _MAX_NESTED_CANDIDATES:
                break
            visited += 1
            child = Path(de.path)
            if (child / ".git").is_dir():
                found.append(child.relative_to(root).as_posix())
            else:
                frontier.append((child, depth + 1))
    return found


class PlanIndex:
    """Directory scan + meta cache for one or more workspaces."""

    def __init__(self, databases: WorkspaceDatabases | None = None) -> None:
        self._databases = databases or WorkspaceDatabases()
        self._lock = RLock()
        # db paths whose plan_index schema is already ensured
        self._migrated: set[str] = set()

    # ───────────────────────── Database plumbing ─────────────────────
    def _db(self, workspace_path: str, *, create: bool) -> Database | None:
        """The workspace database, or None when it should not be materialized."""
        db = (
            self._databases.get(workspace_path)
            if create
            else self._databases.peek(workspace_path)
        )
        if db is None:
            return None
        key = str(db.path)
        with self._lock:
            if key not in self._migrated:
                db.migrate(_COMPONENT, 1, _create_plan_index_schema)
                self._migrated.add(key)
        return db

    # ───────────────────────── Scanning ──────────────────────────────
    @staticmethod
    def _scan_root(root: Path, rel_root: str, docs: list[dict[str, Any]], seen: set[str]) -> None:
        """Append every plan document of one plan root, in directory-list order."""
        base = root / rel_root if rel_root else root
        for rel_dir in PLAN_DOC_DIRS:
            try:
                with os.scandir(base / rel_dir) as it:
                    entries = [de for de in it if not de.is_dir() and is_plan_doc_name(de.name)]
            except (OSError, ValueError):
                continue  # absent, unreadable, or not a directory
            entries.sort(key=lambda de: de.name.lower())
            for de in entries:
                rel_path = f"{rel_root}/{rel_dir}/{de.name}" if rel_root else f"{rel_dir}/{de.name}"
                if rel_path in seen:
                    continue
                try:
                    mtime = de.stat().st_mtime
                except OSError:
                    continue  # vanished between scandir and stat
                seen.add(rel_path)
                docs.append(
                    {"rel_path": rel_path, "name": de.name, "mtime": mtime, "root": rel_root}
                )

    @staticmethod
    def _scan(root: Path) -> list[dict[str, Any]]:
        """Every plan document of the workspace and of any nested plan root.

        One ``os.scandir`` per directory, ``stat`` only on the files that pass
        the name filter. Missing directories are skipped silently — most plan
        roots have only one or two of the seven. The workspace's own documents
        come first, then each nested root's, so the list groups by origin.
        """
        docs: list[dict[str, Any]] = []
        seen: set[str] = set()
        for rel_root in ["", *find_nested_plan_roots(root)]:
            PlanIndex._scan_root(root, rel_root, docs, seen)
        return docs

    # ───────────────────────── Public API ────────────────────────────
    def list_docs(self, workspace_path: str) -> dict[str, Any]:
        """Every plan document in the workspace, with cached meta where valid.

        Each document carries ``cached``: True means ``meta`` is authoritative
        for the file as it is on disk right now; False means the caller must
        read and parse the file (and may then feed it back via
        :meth:`cache_put`).
        """
        if not workspace_path:
            return {"ok": False, "error": "no workspace selected"}
        root = Path(workspace_path)
        try:
            if not root.is_dir():
                return {"ok": False, "error": "workspace not found"}
            root = root.resolve()
        except OSError as exc:
            return {"ok": False, "error": str(exc)}

        docs = self._scan(root)
        cached = self._read_cache(workspace_path)

        for doc in docs:
            entry = cached.get(doc["rel_path"])
            # Float equality is exact here: both sides originate from the same
            # st_mtime value, stored and returned by SQLite as an IEEE double.
            if entry is not None and entry[0] == doc["mtime"]:
                doc["meta"] = entry[1]
                doc["cached"] = True
            else:
                doc["meta"] = None
                doc["cached"] = False

        if cached:
            self._drop_orphans(workspace_path, cached.keys() - {d["rel_path"] for d in docs})
        return {"ok": True, "docs": docs}

    def cache_put(self, workspace_path: str, entries: Any) -> dict[str, Any]:
        """Store parsed meta for documents the caller just read.

        ``entries`` is a list of ``{rel_path, mtime, meta}``; ``meta`` may be
        null, which caches the "this file has no valid meta" outcome so an
        unparseable document is not re-read on every refresh. Entries with an
        unknown path shape or a non-numeric mtime are skipped rather than
        failing the batch — a bad row must never cost the caller its whole
        cache write.
        """
        if not workspace_path:
            return {"ok": False, "error": "no workspace selected"}
        if not isinstance(entries, list):
            return {"ok": False, "error": "entries must be a list"}
        if len(entries) > _MAX_CACHE_ENTRIES:
            return {"ok": False, "error": "too many entries"}

        rows: list[tuple[str, float, str | None]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            rel_path = entry.get("rel_path")
            mtime = entry.get("mtime")
            if not isinstance(rel_path, str) or not is_plan_doc_rel_path(rel_path):
                continue
            if isinstance(mtime, bool) or not isinstance(mtime, (int, float)):
                continue
            meta = entry.get("meta")
            if meta is None:
                payload = None
            elif isinstance(meta, dict):
                try:
                    payload = json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
                except (TypeError, ValueError):
                    continue
            else:
                continue
            rows.append((rel_path.replace("\\", "/").strip("/"), float(mtime), payload))

        if not rows:
            return {"ok": True, "stored": 0}

        db = self._db(workspace_path, create=True)
        if db is None:
            return {"ok": False, "error": "workspace not found"}
        try:
            with db.transaction() as cur:
                cur.executemany(
                    "INSERT INTO plan_index (rel_path, mtime, meta) VALUES (?, ?, ?)"
                    " ON CONFLICT(rel_path) DO UPDATE SET"
                    " mtime = excluded.mtime, meta = excluded.meta",
                    rows,
                )
        except sqlite3.Error as exc:
            log.warning("plan index write failed for %s: %s", workspace_path, exc)
            return {"ok": False, "error": "cache write failed"}
        return {"ok": True, "stored": len(rows)}

    def invalidate(self, workspace_path: str) -> None:
        """Drop the whole cache for a workspace (used by tests and recovery)."""
        db = self._db(workspace_path, create=False)
        if db is None:
            return
        try:
            with db.transaction() as cur:
                cur.execute("DELETE FROM plan_index")
        except sqlite3.Error as exc:
            log.warning("plan index clear failed for %s: %s", workspace_path, exc)

    # ───────────────────────── Internals ─────────────────────────────
    def _read_cache(self, workspace_path: str) -> dict[str, tuple[float, Any]]:
        """Cached rows as ``rel_path → (mtime, meta)``; empty on any failure."""
        db = self._db(workspace_path, create=False)
        if db is None:
            return {}
        try:
            with db.transaction() as cur:
                rows = cur.execute("SELECT rel_path, mtime, meta FROM plan_index").fetchall()
        except sqlite3.Error as exc:
            log.warning("plan index read failed for %s: %s", workspace_path, exc)
            return {}

        out: dict[str, tuple[float, Any]] = {}
        for row in rows:
            raw = row["meta"]
            if raw is None:
                out[row["rel_path"]] = (float(row["mtime"]), None)
                continue
            try:
                out[row["rel_path"]] = (float(row["mtime"]), json.loads(raw))
            except (ValueError, TypeError):
                continue  # corrupt payload: treat as a miss, the file wins
        return out

    def _drop_orphans(self, workspace_path: str, orphans: set[str]) -> None:
        """Delete cache rows whose document no longer exists on disk."""
        if not orphans:
            return
        db = self._db(workspace_path, create=False)
        if db is None:
            return
        try:
            with db.transaction() as cur:
                cur.executemany(
                    "DELETE FROM plan_index WHERE rel_path = ?", [(p,) for p in orphans]
                )
        except sqlite3.Error as exc:
            log.warning("plan index prune failed for %s: %s", workspace_path, exc)
