"""On-disk registry of live PTY child process groups.

PTY children are spawned with start_new_session=True (own process group), so
a backend that dies without running its shutdown sweep (SIGKILL, crash) leaves
them behind as orphans. Every spawn is recorded here and removed on close; at
startup, entries left over from a previous run are identity-checked and their
process groups killed.

Identity is the process start time (ps lstart), not the command line: shells
spawned as `zsh -lc <cmd>` exec the final command, so the visible command
never matches the spawn argv, while pid+start-time survives exec and defeats
pid recycling. Each entry also records the owning backend pid so a second
backend sharing the data dir never reaps a live sibling's children.

Entries additionally carry the root's last descendant snapshot (pid -> lstart,
persisted by terminals' snapshot loop): killpg on the root's process group
misses grandchildren that detached into their own group (e.g. MCP servers a
CLI spawns), so reap_stale identity-checks and kills those individually — for
dead-owner entries whose root is still alive AND for roots that already died
on their own while the backend was down (their orphans outlive them).
"""

from __future__ import annotations

import logging
import os
import signal
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

from .applog import app_data_dir
from .db import DB_FILENAME, Database

log = logging.getLogger(__name__)

_KV_KEY = "pty_registry"

# Force a fixed locale so the lstart string captured at register time compares
# equal to the one read back at reap time.
_PS_ENV = {**os.environ, "LC_ALL": "C"}

# register/unregister run on executor threads (terminals.py keeps their ps +
# db I/O off the event loop), so every load-modify-save must be atomic.
_lock = threading.Lock()

# Lazily-opened database handle. The app injects its shared instance at
# startup (set_database); when the resolved app-data dir changes (tests
# repoint AGENT_TEAM_DATA_DIR per test) a fresh handle is opened for it.
_db: Database | None = None


def set_database(db: Database | None) -> None:
    """Share the app's Database instance instead of opening a second one."""
    global _db
    _db = db


def _registry_path() -> Path:
    return app_data_dir() / "pty-registry.json"


def _get_db() -> Database:
    global _db
    path = app_data_dir() / DB_FILENAME
    db = _db
    if db is None or db.path != path:
        db = Database(path)
        _db = db
    return db


def _import_legacy(cur: object, data: object) -> None:
    if isinstance(data, dict):
        _get_db().kv_set(_KV_KEY, data, now=int(time.time()))


def _load() -> dict[str, dict]:
    try:
        db = _get_db()
        data = db.kv_get(_KV_KEY)
        if data is None:
            db.import_json(_KV_KEY, _registry_path(), _import_legacy)
            data = db.kv_get(_KV_KEY)
    except (sqlite3.Error, OSError) as err:
        log.warning("pty registry read failed: %s", err)
        return {}
    return data if isinstance(data, dict) else {}


def _save(entries: dict[str, dict]) -> None:
    try:
        _get_db().kv_set(_KV_KEY, entries, now=int(time.time()))
    except (sqlite3.Error, OSError) as err:
        log.warning("pty registry write failed: %s", err)


def _ps(pid: int, fields: str) -> str | None:
    """One-line ps probe; None means the probe itself failed (not "no such
    process" — that returns an empty string)."""
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", fields],
            capture_output=True,
            text=True,
            timeout=5,
            env=_PS_ENV,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.strip()


def register(pid: int, argv: list[str]) -> None:
    lstart = _ps(pid, "lstart=") or ""  # probe outside the lock (up to 5s)
    with _lock:
        entries = _load()
        entries[str(pid)] = {
            "argv0": argv[0],  # diagnostic only; identity is lstart
            "lstart": lstart,
            "owner": os.getpid(),
        }
        _save(entries)


def unregister(pid: int) -> None:
    with _lock:
        entries = _load()
        if entries.pop(str(pid), None) is not None:
            _save(entries)


def update_descendants(snapshot: dict[int, dict[int, str]]) -> None:
    """Persist each live root's descendant snapshot (pid -> lstart) into its
    registry entry, so a backend that dies without its shutdown sweep leaves
    the next start's reap_stale enough to take the detached grandchildren
    down too. Blocking (lock + file I/O) — call via asyncio.to_thread. Only
    writes when something actually changed (the snapshot loop calls this
    every tick)."""
    with _lock:
        entries = _load()
        changed = False
        for root_pid, descendants in snapshot.items():
            info = entries.get(str(root_pid))
            if info is None:
                continue  # root already unregistered — nothing to attach to
            recorded = {str(p): ls for p, ls in descendants.items()}
            if info.get("descendants") != recorded:
                info["descendants"] = recorded
                changed = True
        if changed:
            _save(entries)


def _backend_alive(pid: int) -> bool:
    """Is `pid` a live agent_team_backend process (a sibling sharing this
    data dir)? A recycled pid running something else counts as dead."""
    out = _ps(pid, "command=")
    if out is None:
        return True  # can't tell — err on the side of not touching its children
    return "agent_team_backend" in out


_MATCH, _GONE = "match", "gone"


def _lstart_eq(a: str, b: str) -> bool:
    """Whitespace-normalized lstart equality: ps pads day-of-month, and the
    snapshot side stores single-space-joined fields. Empty on either side is
    never a match — an unverifiable identity must never authorize a kill."""
    return bool(a) and bool(b) and " ".join(a.split()) == " ".join(b.split())


def _ps_table() -> "dict[int, tuple[int, str]] | None":
    """pid -> (pgid, lstart) for every process, from ONE ps snapshot. One
    fork replaces the per-pid probes reap/scan used to run under the lock
    (N x descendants x 5s-timeout worst case). None means the probe itself
    failed — callers must treat that as 'cannot verify anything'."""
    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,pgid=,lstart="],
            capture_output=True,
            text=True,
            timeout=5,
            env=_PS_ENV,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    table: dict[int, tuple[int, str]] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            pid, pgid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        table[pid] = (pgid, " ".join(parts[2:]))
    return table


def _classify_root(table: dict[int, tuple[int, str]], pid: int, info: dict) -> str:
    entry = table.get(pid)
    if entry is None:
        return _GONE
    pgid, lstart = entry
    if pgid != pid:
        return _GONE  # not a session/group leader → recycled pid
    return _MATCH if _lstart_eq(lstart, info.get("lstart") or "") else _GONE


def _match_descendants(
    table: dict[int, tuple[int, str]], info: dict
) -> tuple[list[int], list[int]]:
    """Recorded descendants still identity-matched by lstart, split into
    process-group leaders and plain pids. Leaders (MCP wrappers detached via
    setsid) are killed with killpg so children they spawned after the last
    persisted snapshot die with the group — mirroring the runtime reaper's
    subtree kill. A recycled or unverifiable pid never matches."""
    leaders: list[int] = []
    plain: list[int] = []
    for pid_s, recorded in (info.get("descendants") or {}).items():
        try:
            pid = int(pid_s)
        except (TypeError, ValueError):
            continue
        entry = table.get(pid)
        if entry is None:
            continue
        pgid, lstart = entry
        if not _lstart_eq(lstart, recorded):
            continue
        (leaders if pgid == pid else plain).append(pid)
    return leaders, plain


def _signal_each(targets: "list[tuple[int, bool]]", sig: int) -> None:
    """Signal each (pid, is_group) target; already-dead pids are skipped."""
    for pid, group in targets:
        try:
            (os.killpg if group else os.kill)(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def _collect_stale(
    entries: dict[str, dict], table: dict[int, tuple[int, str]]
) -> "tuple[list[int], list[int], list[int], dict[str, dict]]":
    """Shared verdict logic for scan_orphans and reap_stale: identity-matched
    roots, descendant group-leaders, plain descendants, and the entries to
    keep. A root pid still PRESENT in the table but unverifiable (recycled,
    or its register-time lstart probe failed) never authorizes a descendant
    kill — the root may be a live CLI and its recorded descendants its live
    servers; the entry is dropped without signalling anything."""
    me = os.getpid()
    roots: list[int] = []
    desc_group: list[int] = []
    desc_solo: list[int] = []
    keep: dict[str, dict] = {}
    for pid_s, info in entries.items():
        owner = info.get("owner")
        if isinstance(owner, int) and (owner == me or _backend_alive(owner)):
            keep[pid_s] = info  # a live backend (this one or a sibling) owns it
            continue
        root = int(pid_s)
        if _classify_root(table, root, info) == _MATCH:
            roots.append(root)
        elif root in table:
            continue  # present but unverifiable — never kill under a live root
        # Root matched (whole leftover) or truly absent (died on its own while
        # its backend was down — no EOF reap ran): recorded descendants that
        # still match their lstart are leaked orphans.
        g, p = _match_descendants(table, info)
        desc_group.extend(g)
        desc_solo.extend(p)
    return roots, desc_group, desc_solo, keep


def scan_orphans() -> list[int]:
    """Pids of live processes recorded by a now-dead backend run — exactly the
    ones reap_stale would kill, detached descendants included. Read-only:
    never signals a process or rewrites the registry, so it is safe to poll
    for a "how many leftovers?" status check (the pileup that silently
    exhausted RAM was invisible until now)."""
    with _lock:
        entries = _load()
        if not entries:
            return []
        table = _ps_table()
        if table is None:
            return []  # cannot verify anything right now
        roots, desc_group, desc_solo, _keep = _collect_stale(entries, table)
        return roots + desc_group + desc_solo


def reap_stale(grace: float = 1.0) -> list[int]:
    """Kill process groups (and recorded detached descendants) left by a dead
    backend run.

    Blocking (ps + grace sleep) — call via asyncio.to_thread. Entries owned by
    a live sibling backend are left untouched; if the ps snapshot itself fails
    everything is kept for the next startup; everything else is killed or
    confirmed gone and dropped. Returns the pids that were signalled.

    Holds the registry lock for its whole run: _save(keep) rewrites the file
    from the entries loaded at the top, so an interleaved register would be
    lost if the load→save window were left open.
    """
    with _lock:
        entries = _load()
        if not entries:
            return []
        table = _ps_table()
        if table is None:
            # Cannot verify identities — keep everything for the next startup
            # rather than signalling blind.
            log.warning("pty reap skipped: ps snapshot failed")
            return []
        roots, desc_group, desc_solo, keep = _collect_stale(entries, table)
        # Roots and descendant group-leaders take their whole group (children
        # spawned after the last persisted snapshot die with it); plain
        # descendants are signalled individually.
        targets = [(pid, True) for pid in roots + desc_group] + [
            (pid, False) for pid in desc_solo
        ]
        if targets:
            _signal_each(targets, signal.SIGTERM)
            time.sleep(grace)
            _signal_each(targets, signal.SIGKILL)
            log.info(
                "reaped %d orphaned PTY process group(s) %s and %d detached descendant(s) %s",
                len(roots), roots, len(desc_group) + len(desc_solo), desc_group + desc_solo,
            )
        _save(keep)
        return roots + desc_group + desc_solo
