"""storage_service — size accounting, deletion guards and the storage.* handlers.

Every root the service walks is monkeypatched into tmp_path: the scan reaches
into ~/.navide, ~/.codex-panes and ~/Library/Caches, and a test must never
touch (let alone delete from) the developer's real home.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, storage_service, terminals
from agent_team_backend.storage_service import StorageGuardError


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.fixture
def roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """Point every root resolver at tmp_path and return the roots."""
    app_data = tmp_path / "app-data"
    profiles = tmp_path / "cli-profiles"
    panes = tmp_path / "codex-panes"
    shims = tmp_path / "navide-panes"
    for path in (app_data, profiles, panes, shims):
        path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(storage_service, "app_data_root", lambda: app_data)
    monkeypatch.setattr(storage_service, "profiles_root", lambda: profiles)
    monkeypatch.setattr(storage_service, "codex_panes_root", lambda: panes)
    monkeypatch.setattr(storage_service, "shim_panes_root", lambda: shims)
    monkeypatch.setattr(storage_service, "updater_cache_paths", list)
    return {"app_data": app_data, "profiles": profiles, "panes": panes, "shims": shims}


def _item(report: dict[str, Any], item_id: str) -> dict[str, Any]:
    for group in report["groups"]:
        for item in group["items"]:
            if item["id"] == item_id:
                return item
    raise AssertionError(f"item {item_id!r} missing from report")


def _write(path: Path, size: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    return path


def _cold_log(path: Path, size: int) -> Path:
    """A manual log no pane has written to for a long time.

    A freshly written log is presumed live (see LIVE_LOG_MTIME_WINDOW_SECONDS),
    so every test about the *cleanable* buckets has to back-date its mtime.
    """
    _write(path, size)
    long_ago = time.time() - 30 * 86400
    os.utime(path, (long_ago, long_ago))
    return path


# ── size accounting ─────────────────────────────────────────────────────────


def test_scan_does_not_follow_symlinks(roots: dict[str, Path], tmp_path: Path) -> None:
    """~/.codex-panes and runtime/skills are symlink farms pointing back at
    shared config; following them double-counts and can loop forever."""
    outside = _write(tmp_path / "outside" / "huge.bin", 5000)
    runtime = roots["app_data"] / "runtime" / "skills"
    _write(runtime / "real.txt", 10)
    (runtime / "linked-file").symlink_to(outside)
    (runtime / "linked-dir").symlink_to(outside.parent, target_is_directory=True)

    report = storage_service.collect_usage([], 30)

    item = _item(report, "runtimeArtifacts")
    # 10 real bytes; the two symlinks cost nothing but are still counted as
    # entries so the file count stays honest.
    assert item["bytes"] == 10
    assert item["fileCount"] == 3


def test_group_totals_equal_the_sum_of_their_items(roots: dict[str, Path]) -> None:
    _write(roots["app_data"] / "usage-cache.json", 40)
    _write(roots["app_data"] / "settings.json", 60)
    _write(roots["app_data"] / "logs" / "backend.log", 25)

    report = storage_service.collect_usage([], 30)

    for group in report["groups"]:
        assert group["totalBytes"] == sum(i["bytes"] for i in group["items"])
    assert report["totalBytes"] == sum(g["totalBytes"] for g in report["groups"])
    # Nothing under the app-data root goes unaccounted for.
    app_group = next(g for g in report["groups"] if g["id"] == "appData")
    assert app_group["totalBytes"] == 40 + 60 + 25
    assert _item(report, "appDataOther")["bytes"] == 60


def test_unreadable_directory_becomes_an_error_not_an_exception(
    roots: dict[str, Path]
) -> None:
    locked = roots["app_data"] / "skills" / "locked"
    locked.mkdir(parents=True)
    _write(locked / "a.txt", 5)
    locked.chmod(0o000)
    try:
        report = storage_service.collect_usage([], 30)
    finally:
        locked.chmod(0o700)
    assert any(str(locked) == e["path"] for e in report["errors"])


def test_report_caps_reported_paths_at_five(roots: dict[str, Path]) -> None:
    manual_root = roots["app_data"]
    for n in range(8):
        _write(manual_root / f"_pipeline-backup-{n}" / "x", 1)
    report = storage_service.collect_usage([], 30)
    item = _item(report, "storeBackups")
    assert len(item["paths"]) == storage_service.MAX_REPORTED_PATHS
    assert item["bytes"] == 8


def test_disk_block_is_present(roots: dict[str, Path]) -> None:
    disk = storage_service.collect_usage([], 30)["disk"]
    assert disk["totalBytes"] > 0
    assert disk["freeBytes"] > 0


def test_stale_days_falls_back_to_the_default(roots: dict[str, Path]) -> None:
    assert storage_service.collect_usage([], "nonsense")["staleDays"] == 30
    assert storage_service.collect_usage([], 0)["staleDays"] == 30
    assert storage_service.collect_usage([], 7)["staleDays"] == 7


# ── deletion guards ─────────────────────────────────────────────────────────


def test_remove_guarded_rejects_a_target_outside_the_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    victim = _write(tmp_path / "elsewhere" / "keep.txt", 3)
    with pytest.raises(StorageGuardError):
        storage_service._remove_guarded(victim, root)
    with pytest.raises(StorageGuardError):
        storage_service._remove_guarded(root / ".." / "elsewhere", root)
    assert victim.exists()


def test_remove_guarded_refuses_to_delete_the_root_itself(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    with pytest.raises(StorageGuardError):
        storage_service._remove_guarded(root, root)
    assert root.exists()


def test_remove_guarded_unlinks_a_symlink_without_touching_its_target(
    tmp_path: Path
) -> None:
    root = tmp_path / "root"
    root.mkdir()
    target = _write(tmp_path / "outside" / "real.txt", 7)
    link = root / "link"
    link.symlink_to(target)
    storage_service._remove_guarded(link, root)
    assert not link.is_symlink()
    assert target.exists()


# ── cleanup ─────────────────────────────────────────────────────────────────


def test_current_log_is_truncated_not_unlinked(roots: dict[str, Path]) -> None:
    """The RotatingFileHandler holds an open fd on backend.log; unlinking it
    would send every later log line to a deleted inode."""
    log_file = _write(roots["app_data"] / "logs" / "backend.log", 500)
    _write(roots["app_data"] / "logs" / "backend.log.1", 100)

    result = storage_service.cleanup(["currentLog", "rotatedLogs"], [], 30)

    assert log_file.exists()
    assert log_file.stat().st_size == 0
    assert not (roots["app_data"] / "logs" / "backend.log.1").exists()
    assert result["totalFreedBytes"] == 600
    assert all(r["ok"] for r in result["results"])


def test_cleanup_refuses_non_cleanable_and_electron_items(
    roots: dict[str, Path]
) -> None:
    _write(roots["app_data"] / "Cache" / "blob", 20)
    _write(roots["app_data"] / "Local Storage" / "leveldb" / "x", 30)

    result = storage_service.cleanup(
        ["chromiumCache", "browserState", "totallyUnknown"], [], 30
    )

    by_id = {r["itemId"]: r for r in result["results"]}
    assert set(by_id) == {"chromiumCache", "browserState", "totallyUnknown"}
    assert not any(r["ok"] for r in result["results"])
    assert all(r["error"] for r in result["results"])
    assert result["totalFreedBytes"] == 0
    # Electron owns the chromium cache — the backend must not have deleted it.
    assert (roots["app_data"] / "Cache" / "blob").exists()
    assert (roots["app_data"] / "Local Storage" / "leveldb" / "x").exists()


def test_cleanup_removes_archived_cli_profile_slots_only(
    roots: dict[str, Path]
) -> None:
    profiles = roots["profiles"]
    archived = _write(profiles / "claude" / "slot-1.deleted-123" / "home" / "a", 40)
    migrated = _write(profiles / "claude" / "slot-2.migrated-9" / "home" / "b", 10)
    live = _write(profiles / "claude" / "slot-3" / "home" / ".claude.json", 15)

    result = storage_service.cleanup(["cliProfilesArchived"], [], 30)

    assert result["totalFreedBytes"] == 50
    assert not archived.parent.parent.exists()
    assert not migrated.parent.parent.exists()
    assert live.exists()


def test_cleanup_never_unlinks_a_live_slots_shared_symlinks(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A live slot wires ``home/projects`` and ``home/shell-snapshots`` at the
    shared ``~/.claude`` dirs. They weigh zero bytes, so offering them for
    cleanup can only break the profile — the buckets must skip them."""
    shared = tmp_path / "dot-claude"
    _write(shared / "projects" / "a.jsonl", 90)
    _write(shared / "shell-snapshots" / "snap.sh", 30)
    home = roots["profiles"] / "claude" / "slot-1" / "home"
    real_cache = _write(home / "cache" / "blob", 12)
    home.mkdir(parents=True, exist_ok=True)
    (home / "projects").symlink_to(shared / "projects", target_is_directory=True)
    (home / "shell-snapshots").symlink_to(
        shared / "shell-snapshots", target_is_directory=True
    )

    report = storage_service.collect_usage([], 30)
    assert _item(report, "cliProfileHistory")["paths"] == []
    assert _item(report, "cliProfileCaches")["paths"] == [str(real_cache.parent)]

    result = storage_service.cleanup(["cliProfileHistory", "cliProfileCaches"], [], 30)

    assert (home / "projects").is_symlink()
    assert (home / "shell-snapshots").is_symlink()
    assert (shared / "projects" / "a.jsonl").exists()
    assert (shared / "shell-snapshots" / "snap.sh").exists()
    assert result["totalFreedBytes"] == 12
    assert not real_cache.exists()


# ── workspace manual logs ───────────────────────────────────────────────────


def _workspace(tmp_path: Path, entries: list[dict[str, Any]]) -> Path:
    ws = tmp_path / "ws"
    data = ws / ".agent-team"
    data.mkdir(parents=True)
    (data / "spawn-history.json").write_text(
        json.dumps({"version": 1, "entries": entries}), encoding="utf-8"
    )
    return ws


def test_orphan_manual_logs_are_detected_by_filename(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Entries keep their log's *name*, not its date folder: spawnedAt is
    rewritten on restore, so a live entry's log can sit under any day."""
    ws = _workspace(
        tmp_path,
        [{"paneId": "aaaa1111-2222-3333-4444-555555555555", "agentKey": "claude"}],
    )
    manual = ws / ".agent-team" / "manual"
    kept = _cold_log(manual / "20200101" / "claude-aaaa1111.log", 10)
    orphan = _cold_log(manual / "20200101" / "claude-bbbb2222.log", 90)

    report = storage_service.collect_usage([str(ws)], 30)

    orphan_item = _item(report, "manualLogsOrphan")
    assert orphan_item["bytes"] == 90
    assert orphan_item["paths"] == [str(orphan)]
    # The referenced log sits in an old day folder → stale, not orphan.
    assert _item(report, "manualLogsStale")["bytes"] == 10
    assert _item(report, "manualLogsRecent")["bytes"] == 0
    assert kept.exists()


def test_recent_manual_logs_are_not_cleanable(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    ws = _workspace(
        tmp_path,
        [{"paneId": "aaaa1111-2222-3333-4444-555555555555", "agentKey": "claude"}],
    )
    recent = _write(
        ws / ".agent-team" / "manual" / today / "claude-aaaa1111.log", 12
    )

    report = storage_service.collect_usage([str(ws)], 30)
    assert _item(report, "manualLogsRecent")["bytes"] == 12
    assert _item(report, "manualLogsRecent")["cleanable"] is False

    result = storage_service.cleanup(["manualLogsRecent"], [str(ws)], 30)
    assert result["results"][0]["ok"] is False
    assert recent.exists()


def test_cleanup_removes_orphan_manual_logs(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    ws = _workspace(
        tmp_path,
        [{"paneId": "aaaa1111-2222-3333-4444-555555555555", "agentKey": "claude"}],
    )
    manual = ws / ".agent-team" / "manual"
    kept = _cold_log(manual / "20200101" / "claude-aaaa1111.log", 10)
    orphan = _cold_log(manual / "20200102" / "claude-bbbb2222.log", 90)

    result = storage_service.cleanup(["manualLogsOrphan"], [str(ws)], 30)

    assert result == {
        "totalFreedBytes": 90,
        "results": [
            {
                "itemId": "manualLogsOrphan",
                "ok": True,
                "freedBytes": 90,
                "removedCount": 1,
                "error": None,
            }
        ],
    }
    assert not orphan.exists()
    assert kept.exists()


def test_a_live_panes_log_is_never_stale_even_in_an_old_day_folder(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A pane alive longer than staleDays keeps writing into the day folder its
    *spawn* date named, so mtime alone would not save it — the terminal
    service's live set has to."""
    ws = _workspace(
        tmp_path,
        [{"paneId": "aaaa1111-2222-3333-4444-555555555555", "agentKey": "claude"}],
    )
    live = _cold_log(
        ws / ".agent-team" / "manual" / "20200101" / "claude-aaaa1111.log", 70
    )
    terminals._register_live_log("term-1", str(live))
    try:
        report = storage_service.collect_usage([str(ws)], 30)
        assert _item(report, "manualLogsStale")["bytes"] == 0
        assert _item(report, "manualLogsOrphan")["bytes"] == 0
        assert _item(report, "manualLogsRecent")["bytes"] == 70

        storage_service.cleanup(["manualLogsStale", "manualLogsOrphan"], [str(ws)], 30)
        assert live.exists()
    finally:
        terminals._forget_live_log("term-1")


def test_a_just_spawned_panes_log_is_never_orphan(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Its spawn-history entry is not persisted yet, so nothing references the
    log — but it is being written *right now*, and manualLogsOrphan is in the
    one-click "clean safe items" action."""
    ws = _workspace(tmp_path, [])
    fresh = _write(
        ws / ".agent-team" / "manual" / "20200101" / "claude-cccc3333.log", 55
    )

    report = storage_service.collect_usage([str(ws)], 30)
    assert _item(report, "manualLogsOrphan")["bytes"] == 0
    assert _item(report, "manualLogsRecent")["bytes"] == 55

    storage_service.cleanup(["manualLogsOrphan"], [str(ws)], 30)
    assert fresh.exists()


def test_workspace_without_agent_team_dir_is_skipped(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    report = storage_service.collect_usage([str(plain), "/nope/nowhere"], 30)
    ws_group = next(g for g in report["groups"] if g["id"] == "workspaces")
    assert ws_group["totalBytes"] == 0
    assert ws_group["rootPath"] == ""


def test_a_workspace_reached_by_two_paths_is_scanned_once(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A symlink alias must not double-count the workspace's bytes."""
    ws = tmp_path / "ws"
    _cold_log(ws / ".agent-team" / "manual" / "20200101" / "claude-aaaa1111.log", 900)
    alias = tmp_path / "alias"
    alias.symlink_to(ws)

    once = storage_service.collect_usage([str(ws)], 30)
    twice = storage_service.collect_usage([str(ws), str(alias)], 30)

    assert _item(twice, "manualLogsOrphan")["bytes"] == _item(once, "manualLogsOrphan")["bytes"]
    assert _item(twice, "manualLogsOrphan")["fileCount"] == 1


# ── codex pane homes ────────────────────────────────────────────────────────


def _registry(roots: dict[str, Path], workspaces: list[Path | str]) -> None:
    """Write the recent-workspaces registry the referenced set is built from.

    Without it the scan cannot establish which homes are still reachable and
    fails closed, so every codex-pane test has to declare its workspaces.
    """
    (roots["app_data"] / "recent-workspaces.json").write_text(
        json.dumps(
            {"version": 1, "max_size": 20, "recent": [{"path": str(w)} for w in workspaces]}
        ),
        encoding="utf-8",
    )


def _pane_home(roots: dict[str, Path], name: str, size: int, *, age_days: int = 90) -> Path:
    """A pane home whose mtime is old enough to clear the grace window."""
    home = roots["panes"] / name
    _write(home / "auth.json", size)
    old = time.time() - age_days * 86400
    os.utime(home, (old, old))
    return home


def _shim_home(
    roots: dict[str, Path], agent: str, name: str, size: int, *, age_days: int = 90
) -> Path:
    """An MCP shim home, nested one level deeper than a codex pane home."""
    home = roots["shims"] / agent / name
    _write(home / "mcp.json", size)
    old = time.time() - age_days * 86400
    os.utime(home, (old, old))
    return home


def _pane_workspace(
    tmp_path: Path,
    *,
    panes: list[dict[str, Any]] | None = None,
    history: list[dict[str, Any]] | None = None,
) -> Path:
    ws = tmp_path / "pane-ws"
    data = ws / ".agent-team"
    data.mkdir(parents=True, exist_ok=True)
    (data / "project.json").write_text(
        json.dumps({"id": "proj_x", "panes": panes or []}), encoding="utf-8"
    )
    if history is not None:
        (data / "spawn-history.json").write_text(
            json.dumps({"version": 1, "entries": history}), encoding="utf-8"
        )
    return ws


def test_a_home_a_pane_record_names_is_never_cleanable(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Orphan-ness is decided by the panes that exist, not by mtime: a home
    whose pane record is still on file stays protected however old it is."""
    ws = _pane_workspace(tmp_path, panes=[{"pane_id": "kept", "spawn_status": "spawned"}])
    _registry(roots, [ws])
    kept = _pane_home(roots, "kept", 30)
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesRecent")["bytes"] == 30
    assert _item(report, "codexPanesRecent")["cleanable"] is False
    assert _item(report, "codexPanesStale")["bytes"] == 40
    assert _item(report, "codexPanesStale")["risk"] == "caution"

    storage_service.cleanup(["codexPanesStale"], [str(ws)], 30)
    assert kept.exists()
    assert not orphan.exists()


def test_shim_pane_homes_answer_to_the_same_reference_set(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """MCP shim homes are keyed by pane id like the codex ones, so a pane
    record protects them on exactly the same test — across every agent dir."""
    ws = _pane_workspace(tmp_path, panes=[{"pane_id": "kept", "spawn_status": "spawned"}])
    _registry(roots, [ws])
    kept = _shim_home(roots, "kimi", "kept", 30)
    orphan = _shim_home(roots, "grok", "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "shimPanesRecent")["bytes"] == 30
    assert _item(report, "shimPanesRecent")["cleanable"] is False
    assert _item(report, "shimPanesStale")["bytes"] == 40
    assert _item(report, "shimPanesStale")["paths"] == [str(orphan)]

    storage_service.cleanup(["shimPanesStale"], [str(ws)], 30)
    assert kept.exists()
    assert not orphan.exists()


def test_cleaning_a_shim_home_removes_links_not_their_targets(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A shim home is mostly symlinks back into the real home. Deleting one
    must take the links and leave everything they point at."""
    ws = _pane_workspace(tmp_path, panes=[{"pane_id": "other", "spawn_status": "spawned"}])
    _registry(roots, [ws])
    real = _write(tmp_path / "real-home" / "credentials.json", 100)
    orphan = _shim_home(roots, "kimi", "orphan", 40)
    (orphan / "credentials.json").symlink_to(real)
    old = time.time() - 90 * 86400
    os.utime(orphan, (old, old))  # the symlink above reset the dir mtime
    old = time.time() - 90 * 86400
    os.utime(orphan, (old, old))

    # A symlink counts as zero bytes, so the target is not double-counted.
    assert _item(storage_service.collect_usage([str(ws)], 30), "shimPanesStale")["bytes"] == 40

    storage_service.cleanup(["shimPanesStale"], [str(ws)], 30)
    assert not orphan.exists()
    assert real.exists() and real.stat().st_size == 100


def test_a_removed_pane_record_still_protects_its_home(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A pane the user closed keeps its record — and the App restores from it,
    so the home behind it is not an orphan."""
    ws = _pane_workspace(
        tmp_path,
        panes=[{"pane_id": "closed", "spawn_status": "removed", "session_home_id": "drifted"}],
    )
    _registry(roots, [ws])
    _pane_home(roots, "closed", 30)
    _pane_home(roots, "drifted", 15)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 0
    assert _item(report, "codexPanesRecent")["bytes"] == 45


def test_an_agent_history_entry_protects_its_home(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Agent History's resume re-enters the home that recorded the rollout, so
    a history entry keeps its home alive after the pane record is gone."""
    ws = _pane_workspace(
        tmp_path,
        panes=[],
        history=[{"paneId": "from-history", "agentKey": "codex", "sessionId": "s1"}],
    )
    _registry(roots, [ws])
    _pane_home(roots, "from-history", 30)
    _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesRecent")["bytes"] == 30
    assert _item(report, "codexPanesStale")["bytes"] == 40


def test_a_home_nothing_references_is_cleanable_but_never_safe(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    ws = _pane_workspace(tmp_path, panes=[], history=[])
    _registry(roots, [ws])
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)
    item = _item(report, "codexPanesStale")

    assert item["bytes"] == 40
    assert item["cleanable"] is True
    # "caution" keeps it out of the one-click sweep; sessions die with it.
    assert item["risk"] == "caution"
    assert item["paths"] == [str(orphan)]


def test_a_freshly_modified_unreferenced_home_stays_protected(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A spawn creates the home before the pane record is persisted; a scan
    racing that window must not call the new home an orphan."""
    ws = _pane_workspace(tmp_path, panes=[], history=[])
    _registry(roots, [ws])
    fresh = _pane_home(roots, "mid-spawn", 40, age_days=0)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 0
    assert _item(report, "codexPanesRecent")["bytes"] == 40

    storage_service.cleanup(["codexPanesStale"], [str(ws)], 30)
    assert fresh.exists()


def test_an_unreadable_project_json_protects_every_home(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Fail closed: a home id never records which workspace made it, so one
    unreadable record file poisons the whole answer."""
    ws = _pane_workspace(tmp_path, panes=[])
    (ws / ".agent-team" / "project.json").write_text("{ truncated", encoding="utf-8")
    _registry(roots, [ws])
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 0
    assert _item(report, "codexPanesRecent")["bytes"] == 40
    assert any(str(ws / ".agent-team" / "project.json") == e["path"] for e in report["errors"])

    storage_service.cleanup(["codexPanesStale"], [str(ws)], 30)
    assert orphan.exists()


def test_an_unreadable_spawn_history_protects_every_home(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    ws = _pane_workspace(tmp_path, panes=[])
    (ws / ".agent-team" / "spawn-history.json").write_text("[]", encoding="utf-8")
    _registry(roots, [ws])
    _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 0


def _pane_workspace_db(
    tmp_path: Path,
    *,
    project: dict[str, Any] | None = None,
    history: dict[str, Any] | None = None,
) -> Path:
    """A workspace whose records live in navide.db's kv (post-migration)."""
    from agent_team_backend.db import Database

    ws = tmp_path / "pane-ws"
    data = ws / ".agent-team"
    data.mkdir(parents=True, exist_ok=True)
    db = Database(data / "navide.db")
    if project is not None:
        db.kv_set("project", project, now=1)
    if history is not None:
        db.kv_set("spawn_history", history, now=1)
    db.close()
    return ws


def test_pane_records_in_the_workspace_database_protect_homes(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Post-migration the project and spawn-history documents live in the
    workspace navide.db; references must come from there, not from the
    retired (absent) JSON files — else every home reads as orphaned."""
    ws = _pane_workspace_db(
        tmp_path,
        project={"id": "p", "panes": [{"pane_id": "kept"}]},
        history={"version": 1, "entries": [{"paneId": "resumable"}]},
    )
    _registry(roots, [ws])
    kept = _pane_home(roots, "kept", 30)
    _pane_home(roots, "resumable", 20)
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesRecent")["bytes"] == 50
    assert _item(report, "codexPanesStale")["bytes"] == 40
    assert _item(report, "codexPanesStale")["paths"] == [str(orphan)]

    storage_service.cleanup(["codexPanesStale"], [str(ws)], 30)
    assert kept.exists()
    assert not orphan.exists()


def test_empty_database_documents_are_a_legal_empty_state(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A workspace whose kv documents exist but name nothing is genuinely
    empty — its unnamed homes are orphans, not protected unknowns."""
    ws = _pane_workspace_db(
        tmp_path,
        project={"id": "p", "panes": []},
        history={"version": 1, "entries": []},
    )
    _registry(roots, [ws])
    _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 40
    assert _item(report, "codexPanesStale")["cleanable"] is True


def test_an_unreadable_workspace_database_protects_every_home(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Fail closed: a workspace database that cannot be read may hold the
    very records that would have named these homes."""
    ws = tmp_path / "pane-ws"
    data = ws / ".agent-team"
    data.mkdir(parents=True)
    (data / "navide.db").write_text("this is not a database", encoding="utf-8")
    _registry(roots, [ws])
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 0
    assert _item(report, "codexPanesRecent")["bytes"] == 40
    assert any(str(data / "navide.db") == e["path"] for e in report["errors"])

    storage_service.cleanup(["codexPanesStale"], [str(ws)], 30)
    assert orphan.exists()


def test_a_workspace_database_without_documents_falls_back_to_legacy_json(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Transition window: the database exists (another store created it) but
    the project/spawn-history documents were not imported yet — the legacy
    JSON files still answer."""
    from agent_team_backend.db import Database

    ws = _pane_workspace(tmp_path, panes=[{"pane_id": "kept"}])
    db = Database(ws / ".agent-team" / "navide.db")
    db.kv_set("chat_threads", [], now=1)
    db.close()
    _registry(roots, [ws])
    _pane_home(roots, "kept", 30)
    _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesRecent")["bytes"] == 30
    assert _item(report, "codexPanesStale")["bytes"] == 40


def test_a_deleted_workspace_contributes_no_references(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A deleted folder took its record files with it: it has no references
    left to contribute, and one dead bookmark must not freeze the scan."""
    live = _pane_workspace(tmp_path, panes=[{"pane_id": "kept"}])
    _registry(roots, [live, tmp_path / "gone" / "ws"])
    _pane_home(roots, "kept", 30)
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 40
    assert _item(report, "codexPanesRecent")["bytes"] == 30
    assert any(str(tmp_path / "gone" / "ws") == e["path"] for e in report["errors"])

    storage_service.cleanup(["codexPanesStale"], [], 30)
    assert not orphan.exists()


def test_an_unmounted_volume_still_protects_every_home(
    roots: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A disk nobody plugged in is not a deleted workspace: its records would
    have named some of these homes, so nothing is an orphan this scan."""
    volumes = tmp_path / "Volumes"
    volumes.mkdir()
    monkeypatch.setattr(storage_service, "MOUNT_HOST_DIRS", (str(volumes),))
    _registry(roots, [volumes / "Backup" / "ws"])
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 0
    assert _item(report, "codexPanesRecent")["bytes"] == 40
    assert any(str(volumes / "Backup" / "ws") == e["path"] for e in report["errors"])

    storage_service.cleanup(["codexPanesStale"], [], 30)
    assert orphan.exists()


def test_an_unreadable_ancestor_is_unknown_not_deleted(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """The walk up must not turn a permission error into "deleted"."""
    locked = tmp_path / "locked"
    locked.mkdir()
    # Nested one level down: stat'ing ``locked/sub`` needs +x on ``locked``,
    # which is exactly the ancestor the walk cannot read.
    _registry(roots, [locked / "sub" / "ws"])
    orphan = _pane_home(roots, "orphan", 40)
    locked.chmod(0o000)
    try:
        report = storage_service.collect_usage([], 30)
        storage_service.cleanup(["codexPanesStale"], [], 30)
    finally:
        locked.chmod(0o700)

    assert _item(report, "codexPanesStale")["bytes"] == 0
    assert orphan.exists()


def test_a_missing_workspace_registry_protects_every_home(roots: dict[str, Path]) -> None:
    """No registry, no referenced set — every home is kept."""
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 0
    assert _item(report, "codexPanesRecent")["bytes"] == 40

    storage_service.cleanup(["codexPanesStale"], [], 30)
    assert orphan.exists()


def test_a_workspace_without_records_contributes_no_references(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """A workspace that never spawned a pane has no record files; that is an
    answer (no references), not a failure."""
    ws = tmp_path / "never-used"
    ws.mkdir()
    _registry(roots, [ws])
    _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesStale")["bytes"] == 40


def test_loose_entries_next_to_the_codex_pane_homes_are_counted_not_cleaned(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Only pane-id subdirectories are homes; a stray .DS_Store and a hidden
    dir somebody else owns still have to land in a bucket or the cliHomes
    total under-reports them."""
    ws = _pane_workspace(tmp_path, panes=[], history=[])
    _registry(roots, [ws])
    _pane_home(roots, "pane-new", 40, age_days=0)
    stray = _write(roots["panes"] / ".DS_Store", 14)
    hidden = _write(roots["panes"] / ".agents" / "skills" / "x.md", 9)

    report = storage_service.collect_usage([str(ws)], 30)

    recent = _item(report, "codexPanesRecent")
    assert recent["bytes"] == 40 + 14 + 9
    assert recent["cleanable"] is False
    assert _item(report, "codexPanesStale")["bytes"] == 0
    group = next(g for g in report["groups"] if g["id"] == "cliHomes")
    assert group["totalBytes"] == sum(i["bytes"] for i in group["items"])

    storage_service.cleanup(["codexPanesStale"], [str(ws)], 30)
    assert stray.exists()
    assert hidden.exists()


# ── ws handlers ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_storage_usage_handler_offloads_and_returns_the_report(
    roots: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    _write(roots["app_data"] / "usage-cache.json", 11)
    threaded: list[Any] = []
    orig_to_thread = asyncio.to_thread

    async def spy(fn: Any, *args: Any, **kwargs: Any) -> Any:
        threaded.append(fn)
        return await orig_to_thread(fn, *args, **kwargs)

    monkeypatch.setattr("agent_team_backend.ws_handlers.asyncio.to_thread", spy)
    session = _session()

    await app.handle_message(session, {
        "id": "s1",
        "type": "storage.usage",
        "payload": {"workspacePaths": [], "staleDays": 30},
    })

    assert storage_service.collect_usage in threaded
    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["staleDays"] == 30
    assert [g["id"] for g in payload["groups"]] == [
        "appData", "electron", "cliHomes", "workspaces",
    ]
    assert _item(payload, "usageCache")["bytes"] == 11


@pytest.mark.asyncio
async def test_storage_cleanup_handler_returns_per_item_results(
    roots: dict[str, Path]
) -> None:
    _write(roots["app_data"] / "usage-cache.json", 11)
    session = _session()

    await app.handle_message(session, {
        "id": "s2",
        "type": "storage.cleanup",
        "payload": {"itemIds": ["usageCache", "browserState"], "workspacePaths": []},
    })

    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["totalFreedBytes"] == 11
    by_id = {r["itemId"]: r for r in payload["results"]}
    assert by_id["usageCache"]["ok"] is True
    assert by_id["browserState"]["ok"] is False
    assert not (roots["app_data"] / "usage-cache.json").exists()


def test_migrated_json_backups_are_cleanable(roots: dict[str, Path]) -> None:
    """Retired ``*.migrated-v1`` sources count under storeBackups and clean."""
    top = _write(roots["app_data"] / "roles.json.migrated-v1", 7)
    ws_backup = _write(
        roots["app_data"] / "workspaces" / "abc123" / "tokens.json.migrated-v1", 5
    )

    report = storage_service.collect_usage([], 30)
    assert _item(report, "storeBackups")["bytes"] == 12

    storage_service.cleanup(["storeBackups"], [], 30)
    assert not top.exists()
    assert not ws_backup.exists()


def test_navide_database_is_reported_but_never_cleanable(
    roots: dict[str, Path]
) -> None:
    db_file = _write(roots["app_data"] / "navide.db", 100)

    report = storage_service.collect_usage([], 30)
    item = _item(report, "navideDatabase")
    assert item["bytes"] == 100
    assert item["cleanable"] is False

    result = storage_service.cleanup(["navideDatabase"], [], 30)
    assert result["results"][0]["ok"] is False
    assert db_file.exists()


def test_recent_registry_is_read_from_the_database(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """After the SQLite migration the recent list lives in navide.db's kv."""
    from agent_team_backend.db import Database

    ws = _pane_workspace(tmp_path, panes=[{"pane_id": "kept", "spawn_status": "spawned"}])
    db = Database(roots["app_data"] / "navide.db")
    db.kv_set(
        "recent_workspaces",
        {"version": 1, "max_size": 20, "recent": [{"path": str(ws)}]},
        now=1,
    )
    db.close()
    kept = _pane_home(roots, "kept", 30)
    orphan = _pane_home(roots, "orphan", 40)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "codexPanesRecent")["bytes"] == 30
    assert _item(report, "codexPanesStale")["bytes"] == 40
    assert kept.exists() and orphan.exists()


def test_an_unreadable_spawn_history_protects_every_manual_log(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Nothing established which transcripts are still owned, so none of them
    may be called an orphan. An orphan is cleanable from the one-click safe
    sweep, so conflating "could not read" with "no entries" would offer a
    workspace's whole agent history for deletion without a warning."""
    ws = _workspace(tmp_path, [])
    (ws / ".agent-team" / "spawn-history.json").write_text("{trunc", encoding="utf-8")
    manual = ws / ".agent-team" / "manual"
    transcript = _cold_log(manual / "20200101" / "claude-aaaa1111.log", 90)

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "manualLogsOrphan")["bytes"] == 0
    assert _item(report, "manualLogsStale")["bytes"] == 0
    assert _item(report, "manualLogsRecent")["bytes"] == 90

    storage_service.cleanup(["manualLogsOrphan", "manualLogsStale"], [str(ws)], 30)
    assert transcript.exists()


def test_a_store_with_no_entries_still_orphans(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """The guard is for unreadable stores only. A store that genuinely holds no
    entries is an answer, and its logs really are unowned."""
    ws = _workspace(tmp_path, [])
    orphan = _cold_log(
        ws / ".agent-team" / "manual" / "20200101" / "claude-aaaa1111.log", 90
    )

    report = storage_service.collect_usage([str(ws)], 30)

    assert _item(report, "manualLogsOrphan")["bytes"] == 90
    assert orphan.exists()


def test_the_running_pipeline_run_is_never_offered(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """runs/ was listed whole, taking the in-progress run with it. Its log and
    timeline are appended per event, so the files come back — but everything
    the run had recorded so far is gone."""
    ws = _workspace(tmp_path, [])
    data = ws / ".agent-team"
    (data / "project.json").write_text(
        json.dumps({"id": "p", "log_file_name": "runs/live-run/pipeline.log"}),
        encoding="utf-8",
    )
    live = _write(data / "runs" / "live-run" / "pipeline.log", 70)
    finished = _write(data / "runs" / "old-run" / "pipeline.log", 30)

    report = storage_service.collect_usage([str(ws)], 30)
    assert _item(report, "pipelineLogs")["bytes"] == 30

    storage_service.cleanup(["pipelineLogs"], [str(ws)], 30)
    assert live.exists()
    assert not finished.exists()


def test_an_unreadable_project_offers_no_pipeline_run(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """With project.json unreadable there is no way to tell which run is live."""
    ws = _workspace(tmp_path, [])
    data = ws / ".agent-team"
    (data / "project.json").write_text("{trunc", encoding="utf-8")
    run = _write(data / "runs" / "some-run" / "pipeline.log", 30)

    storage_service.cleanup(["pipelineLogs"], [str(ws)], 30)
    assert run.exists()


def test_the_running_run_is_read_from_the_workspace_database(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Post-migration the live run's name comes from the kv project document;
    with project.json retired the in-progress run must still be spared."""
    from agent_team_backend.db import Database

    ws = _workspace(tmp_path, [])
    data = ws / ".agent-team"
    db = Database(data / "navide.db")
    db.kv_set(
        "project", {"id": "p", "log_file_name": "runs/live-run/pipeline.log"}, now=1
    )
    db.close()
    live = _write(data / "runs" / "live-run" / "pipeline.log", 70)
    finished = _write(data / "runs" / "old-run" / "pipeline.log", 30)

    report = storage_service.collect_usage([str(ws)], 30)
    assert _item(report, "pipelineLogs")["bytes"] == 30

    storage_service.cleanup(["pipelineLogs"], [str(ws)], 30)
    assert live.exists()
    assert not finished.exists()


def test_an_unreadable_workspace_database_offers_no_pipeline_run(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    ws = _workspace(tmp_path, [])
    data = ws / ".agent-team"
    (data / "navide.db").write_text("this is not a database", encoding="utf-8")
    run = _write(data / "runs" / "some-run" / "pipeline.log", 30)

    storage_service.cleanup(["pipelineLogs"], [str(ws)], 30)
    assert run.exists()


def test_runtime_cleanup_spares_the_git_askpass_helper(
    roots: dict[str, Path], tmp_path: Path
) -> None:
    """Its path is resolved once at import, so removing it breaks every
    authenticated git operation until the backend restarts."""
    runtime = roots["app_data"] / "runtime"
    helper = _write(runtime / "git_askpass_helper.py", 20)
    projection = _write(runtime / "skills" / "demo" / "SKILL.md", 40)

    item = _item(storage_service.collect_usage([], 30), "runtimeArtifacts")
    assert item["bytes"] == 40
    # Not part of the one-click safe sweep: an open Codex pane symlinks into
    # the projection this clears.
    assert item["risk"] == "caution"

    storage_service.cleanup(["runtimeArtifacts"], [], 30)
    assert helper.exists()
    assert not projection.exists()
