"""SpawnHistoryStore — full per-workspace spawn history + pagination.

Covers merge upsert semantics (replace by paneId, never delete), the one-time
migration seeded from the project.json mirror, newest-first page reads with
offset/limit edge cases, corrupt-file recovery, the runaway-size cap, and the
project.get_spawn_history ws handler.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent_team_backend import spawn_history as spawn_history_module
from agent_team_backend.projects import ProjectStore
from agent_team_backend.spawn_history import SpawnHistoryStore


def _entry(pane_id: str, **fields: Any) -> dict[str, Any]:
    return {"paneId": pane_id, "agentKey": "claude", **fields}


def _stored_entries(store: SpawnHistoryStore, ws: Path) -> list[dict[str, Any]]:
    data = json.loads(store.history_file(str(ws)).read_text(encoding="utf-8"))
    return data["entries"]


# ── merge ────────────────────────────────────────────────────────────────────


def test_merge_appends_new_entries_in_order(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    total = store.merge(str(tmp_path), [_entry("p1"), _entry("p2")])
    assert total == 2
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p1", "p2"]


def test_merge_upserts_existing_entry_in_place(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p1"), _entry("p2")])
    store.merge(str(tmp_path), [_entry("p1", customName="Renamed", sessionId="s-1")])
    entries = _stored_entries(store, tmp_path)
    # Position preserved (oldest → newest by spawn), fields updated.
    assert [e["paneId"] for e in entries] == ["p1", "p2"]
    assert entries[0]["customName"] == "Renamed"
    assert entries[0]["sessionId"] == "s-1"


def test_merge_replacement_clears_fields_the_renderer_removed(tmp_path: Path) -> None:
    """A reset customName is dropped from the entry JSON — replacement must not
    resurrect it from the stored copy."""
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p1", customName="Old name")])
    store.merge(str(tmp_path), [_entry("p1")])
    assert "customName" not in _stored_entries(store, tmp_path)[0]


def test_merge_never_deletes_entries_absent_from_payload(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(5)])
    # A later (windowed) snapshot containing only the newest entry.
    store.merge(str(tmp_path), [_entry("p4", removedAt="2026-07-22T00:00:00Z")])
    entries = _stored_entries(store, tmp_path)
    assert [e["paneId"] for e in entries] == ["p0", "p1", "p2", "p3", "p4"]
    assert entries[4]["removedAt"] == "2026-07-22T00:00:00Z"


def test_merge_skips_entries_without_pane_id(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    total = store.merge(
        str(tmp_path), [_entry("p1"), {"agentKey": "claude"}, {"paneId": ""}, "junk"]  # type: ignore[list-item]
    )
    assert total == 1
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p1"]


def test_merge_cap_drops_oldest_and_warns(tmp_path: Path, monkeypatch, caplog) -> None:
    monkeypatch.setattr(spawn_history_module, "MAX_ENTRIES", 3)
    store = SpawnHistoryStore()
    with caplog.at_level("WARNING", logger="agent_team_backend.spawn_history"):
        total = store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(5)])
    assert total == 3
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p2", "p3", "p4"]
    assert any("dropped 2 oldest" in r.message for r in caplog.records)


def test_merge_seeds_from_mirror_only_when_file_missing(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    seed = [_entry("old-1"), _entry("old-2")]
    store.merge(str(tmp_path), [_entry("new-1")], seed=seed)
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == [
        "old-1", "old-2", "new-1",
    ]
    # Once the file exists the seed is ignored — no duplicate resurrection.
    store.merge(str(tmp_path), [_entry("new-2")], seed=seed)
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == [
        "old-1", "old-2", "new-1", "new-2",
    ]


# ── read_page ────────────────────────────────────────────────────────────────


def test_read_page_returns_newest_first_with_total(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(5)])
    page, total = store.read_page(str(tmp_path), offset=0, limit=2)
    assert total == 5
    assert [e["paneId"] for e in page] == ["p4", "p3"]


def test_read_page_offset_walks_toward_oldest(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(5)])
    page, _ = store.read_page(str(tmp_path), offset=2, limit=2)
    assert [e["paneId"] for e in page] == ["p2", "p1"]


def test_read_page_limit_past_end_clips(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry(f"p{i}") for i in range(3)])
    page, total = store.read_page(str(tmp_path), offset=2, limit=10)
    assert total == 3
    assert [e["paneId"] for e in page] == ["p0"]


def test_read_page_out_of_range_offset_returns_empty(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p0")])
    page, total = store.read_page(str(tmp_path), offset=99, limit=10)
    assert page == []
    assert total == 1


def test_read_page_missing_file_and_no_seed_is_empty(tmp_path: Path) -> None:
    page, total = SpawnHistoryStore().read_page(str(tmp_path), offset=0, limit=10)
    assert page == []
    assert total == 0
    assert not SpawnHistoryStore().history_file(str(tmp_path)).exists()


def test_read_page_seeds_migration_from_mirror_and_persists(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    seed = [_entry("m1"), _entry("m2")]
    page, total = store.read_page(str(tmp_path), offset=0, limit=10, seed=seed)
    assert total == 2
    assert [e["paneId"] for e in page] == ["m2", "m1"]
    # The migration is written through: later reads work without the mirror.
    assert store.history_file(str(tmp_path)).exists()
    page2, total2 = store.read_page(str(tmp_path), offset=0, limit=10)
    assert total2 == 2
    assert [e["paneId"] for e in page2] == ["m2", "m1"]


# ── corrupt-file recovery ────────────────────────────────────────────────────


def test_corrupt_file_is_backed_up_and_store_starts_empty(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    hf = store.history_file(str(tmp_path))
    hf.parent.mkdir(parents=True)
    hf.write_text("{ not json", encoding="utf-8")
    page, total = store.read_page(str(tmp_path), offset=0, limit=10)
    assert page == []
    assert total == 0
    backup = hf.with_suffix(hf.suffix + ".corrupt")
    assert backup.read_text(encoding="utf-8") == "{ not json"
    # The store recovers: merging works again on the fresh file.
    store.merge(str(tmp_path), [_entry("p1")])
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p1"]


def test_wrong_shape_is_treated_as_corrupt(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    hf = store.history_file(str(tmp_path))
    hf.parent.mkdir(parents=True)
    hf.write_text(json.dumps({"entries": "nope"}), encoding="utf-8")
    page, total = store.read_page(str(tmp_path), offset=0, limit=10)
    assert page == []
    assert total == 0
    assert hf.with_suffix(hf.suffix + ".corrupt").exists()


# ── project.get_spawn_history ws handler ─────────────────────────────────────


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def test_get_spawn_history_handler_pages_and_migrates(
    tmp_path: Path, monkeypatch
) -> None:
    """The handler pages newest-first and seeds the full store from the
    project.json mirror on first read (old-project migration)."""
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    mirror = [_entry(f"p{i}", workspacePath=str(tmp_path)) for i in range(3)]
    store.set_ui_state(str(tmp_path), spawn_history=mirror)
    monkeypatch.setattr(app, "project_store", store)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.get_spawn_history")
    assert fn is not None
    await fn(session, "m1", "project.get_spawn_history", {
        "workspace_path": str(tmp_path),
        "offset": 1,
        "limit": 1,
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["total"] == 3
    assert resp["payload"]["offset"] == 1
    assert [e["paneId"] for e in resp["payload"]["entries"]] == ["p1"]
    # First paged read migrated the mirror into the full store.
    assert app.spawn_history_store.history_file(str(tmp_path)).exists()


async def test_get_spawn_history_handler_defaults_bad_params(
    tmp_path: Path, monkeypatch
) -> None:
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    app.spawn_history_store.merge(str(tmp_path), [_entry("p1")])
    monkeypatch.setattr(app, "project_store", store)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.get_spawn_history")
    assert fn is not None
    await fn(session, "m1", "project.get_spawn_history", {
        "workspace_path": str(tmp_path),
        "offset": -5,
        "limit": "huge",
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["offset"] == 0
    assert resp["payload"]["total"] == 1
    assert [e["paneId"] for e in resp["payload"]["entries"]] == ["p1"]


# ── workspace isolation (write-layer filter + symlink canonicalization) ─────


def test_merge_drops_foreign_workspace_entries_and_warns(
    tmp_path: Path, caplog
) -> None:
    """merge() never persists another workspace's entries; entries without a
    workspacePath (legacy data) still pass through."""
    ws = tmp_path / "ws"
    other = tmp_path / "other"
    ws.mkdir()
    other.mkdir()
    store = SpawnHistoryStore()
    with caplog.at_level("WARNING", logger="agent_team_backend.spawn_history"):
        total = store.merge(str(ws), [
            _entry("mine", workspacePath=str(ws)),
            _entry("foreign", workspacePath=str(other)),
            _entry("legacy"),
        ])
    assert total == 2
    assert [e["paneId"] for e in _stored_entries(store, ws)] == ["mine", "legacy"]
    assert any(
        "dropped 1 foreign spawn-history entries" in r.message for r in caplog.records
    )


def test_symlink_alias_and_real_path_share_one_store(tmp_path: Path) -> None:
    """Both spellings of a symlinked workspace read/write the same file, and
    entries recorded under either spelling count as equivalent."""
    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    store = SpawnHistoryStore()
    # Cross-spelled on purpose: each merge target uses the other spelling.
    store.merge(str(real), [_entry("p1", workspacePath=str(alias))])
    store.merge(str(alias), [_entry("p2", workspacePath=str(real))])
    assert store.history_file(str(alias)) == store.history_file(str(real))
    page, total = store.read_page(str(alias))
    assert total == 2
    assert [e["paneId"] for e in page] == ["p2", "p1"]


def test_seed_migration_drops_foreign_mirror_entries(tmp_path: Path) -> None:
    """A pre-filter mirror may hold foreign entries — they never migrate in."""
    ws = tmp_path / "ws"
    ws.mkdir()
    store = SpawnHistoryStore()
    seed = [
        _entry("mine", workspacePath=str(ws)),
        _entry("foreign", workspacePath=str(tmp_path / "other")),
    ]
    page, total = store.read_page(str(ws), seed=seed)
    assert total == 1
    assert [e["paneId"] for e in page] == ["mine"]


async def test_get_spawn_history_handler_returns_canonical_workspace_path(
    tmp_path: Path, monkeypatch
) -> None:
    """The response carries the symlink-resolved workspace identity, and an
    alias spelling serves the store written under the real one."""
    from agent_team_backend import app, ws_handlers

    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    store = ProjectStore()
    store.save(store.load_or_create(str(alias)))
    monkeypatch.setattr(app, "project_store", store)
    app.spawn_history_store.merge(str(real), [_entry("p1", workspacePath=str(real))])

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.get_spawn_history")
    assert fn is not None
    await fn(session, "m1", "project.get_spawn_history", {
        "workspace_path": str(alias),
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"]["canonical_workspace_path"] == str(real.resolve())
    assert [e["paneId"] for e in resp["payload"]["entries"]] == ["p1"]


# ── patch_entry ──────────────────────────────────────────────────────────────


def test_patch_entry_sets_and_removes_fields(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p1"), _entry("p2")])
    assert store.patch_entry(str(tmp_path), "p1", {"customName": "Renamed"})
    assert _stored_entries(store, tmp_path)[0]["customName"] == "Renamed"
    # A None value removes the key (customName reset).
    assert store.patch_entry(str(tmp_path), "p1", {"customName": None})
    entries = _stored_entries(store, tmp_path)
    assert "customName" not in entries[0]
    assert [e["paneId"] for e in entries] == ["p1", "p2"]


def test_patch_entry_unknown_pane_id_writes_nothing(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p1")])
    before = store.history_file(str(tmp_path)).read_text(encoding="utf-8")
    assert not store.patch_entry(str(tmp_path), "ghost", {"customName": "X"})
    assert store.history_file(str(tmp_path)).read_text(encoding="utf-8") == before


def test_patch_entry_seeds_migration_from_mirror(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    assert store.patch_entry(
        str(tmp_path), "m1", {"customName": "Renamed"}, seed=[_entry("m1")]
    )
    assert _stored_entries(store, tmp_path)[0]["customName"] == "Renamed"


# ── delete_entries ───────────────────────────────────────────────────────────


def test_delete_entries_ids_mode_ignores_unknown_ids(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("p0"), _entry("p1"), _entry("p2")])
    deleted, total, *_ = store.delete_entries(
        str(tmp_path), mode="ids", pane_ids=["p1", "ghost"]
    )
    assert deleted == ["p1"]
    assert total == 2
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["p0", "p2"]


def test_delete_entries_removed_mode_keeps_active(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [
        _entry("active"),
        _entry("gone-1", removedAt="2026-07-01T00:00:00Z"),
        _entry("gone-2", removedAt="2026-07-02T00:00:00Z"),
    ])
    deleted, total, *_ = store.delete_entries(str(tmp_path), mode="removed")
    assert deleted == ["gone-1", "gone-2"]
    assert total == 1
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["active"]


def test_delete_entries_older_than_boundary(tmp_path: Path) -> None:
    """Strictly before the cutoff; exact-cutoff, active, and unparseable
    spawnedAt entries all survive."""
    store = SpawnHistoryStore()
    cutoff = "2026-07-15T00:00:00Z"
    store.merge(str(tmp_path), [
        _entry("old-removed", spawnedAt="2026-07-14T23:59:59Z", removedAt="2026-07-14T23:59:59Z"),
        _entry("at-cutoff", spawnedAt=cutoff, removedAt=cutoff),
        _entry("new-removed", spawnedAt="2026-07-16T00:00:00Z", removedAt="2026-07-16T00:00:00Z"),
        _entry("old-active", spawnedAt="2026-07-01T00:00:00Z"),
        _entry("bad-ts", spawnedAt="not-a-date", removedAt="2026-07-01T00:00:00Z"),
    ])
    deleted, total, *_ = store.delete_entries(
        str(tmp_path), mode="older_than", cutoff_iso=cutoff
    )
    assert deleted == ["old-removed"]
    assert total == 4
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == [
        "at-cutoff", "new-removed", "old-active", "bad-ts",
    ]


def test_delete_entries_unknown_mode_and_empty_store_are_safe(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    # Empty store: nothing deleted and no file created.
    deleted, total, *_ = store.delete_entries(str(tmp_path), mode="removed")
    assert (deleted, total) == ([], 0)
    assert not store.history_file(str(tmp_path)).exists()
    store.merge(str(tmp_path), [_entry("p1", removedAt="2026-07-01T00:00:00Z")])
    deleted, total, *_ = store.delete_entries(str(tmp_path), mode="bogus")
    assert (deleted, total) == ([], 1)


def test_delete_entries_other_workspace_untouched(tmp_path: Path) -> None:
    """Deletion is per-workspace-store: the same pane id in another
    workspace's file is never affected."""
    ws_a = tmp_path / "a"
    ws_b = tmp_path / "b"
    ws_a.mkdir()
    ws_b.mkdir()
    store = SpawnHistoryStore()
    store.merge(str(ws_a), [_entry("shared-id", workspacePath=str(ws_a))])
    store.merge(str(ws_b), [_entry("shared-id", workspacePath=str(ws_b))])
    deleted, *_ = store.delete_entries(str(ws_a), mode="ids", pane_ids=["shared-id"])
    assert deleted == ["shared-id"]
    assert [e["paneId"] for e in _stored_entries(store, ws_b)] == ["shared-id"]


def test_delete_entries_via_symlink_alias_hits_the_shared_store(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real, target_is_directory=True)
    store = SpawnHistoryStore()
    store.merge(str(real), [_entry("p1", removedAt="2026-07-01T00:00:00Z")])
    deleted, total, *_ = store.delete_entries(str(alias), mode="removed")
    assert deleted == ["p1"]
    assert total == 0
    assert _stored_entries(store, real) == []


# ── manual log files deleted with their entries ─────────────────────────────
# Deleting an Agent History entry used to be record-only, stranding its
# `.agent-team/manual/<ymd>/<agentKey>-<paneId8>.log` forever (1.3 GB measured
# on one machine).


def _manual_log(ws: Path, ymd: str, name: str, size: int = 100) -> Path:
    path = ws / ".agent-team" / "manual" / ymd / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    return path


def test_delete_entries_removes_the_matching_manual_log(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("aaaa1111-2222"), _entry("bbbb3333-4444")])
    doomed = _manual_log(tmp_path, "20260101", "claude-aaaa1111.log", 100)
    keeper = _manual_log(tmp_path, "20260101", "claude-bbbb3333.log", 50)

    result = store.delete_entries(str(tmp_path), mode="ids", pane_ids=["aaaa1111-2222"])

    assert result.deleted_ids == ["aaaa1111-2222"]
    assert result.total == 1
    assert result.freed_bytes == 100
    assert result.removed_log_files == 1
    assert not doomed.exists()
    assert keeper.exists()


def test_delete_entries_finds_the_log_in_any_day_folder(tmp_path: Path) -> None:
    """spawnedAt is rewritten on restore, so the day folder derived from it is
    unreliable — the filename is the stable key."""
    store = SpawnHistoryStore()
    store.merge(
        str(tmp_path),
        [_entry("aaaa1111-2222", spawnedAt="2026-07-20T00:00:00Z",
                removedAt="2026-07-21T00:00:00Z")],
    )
    stray = _manual_log(tmp_path, "20250315", "claude-aaaa1111.log", 30)

    result = store.delete_entries(str(tmp_path), mode="removed")

    assert result.removed_log_files == 1
    assert result.freed_bytes == 30
    assert not stray.exists()


def test_delete_entries_uses_the_stored_output_log_file_name(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(
        str(tmp_path),
        [_entry("p1", outputLogFile=str(
            tmp_path / ".agent-team" / "manual" / "20260101" / "legacy-name.log"
        ))],
    )
    legacy = _manual_log(tmp_path, "20260101", "legacy-name.log", 70)

    result = store.delete_entries(str(tmp_path), mode="ids", pane_ids=["p1"])

    assert result.removed_log_files == 1
    assert not legacy.exists()


def test_delete_entries_never_touches_a_log_outside_the_manual_dir(
    tmp_path: Path
) -> None:
    outsider = tmp_path / ".agent-team" / "runs" / "r1" / "claude-aaaa1111.log"
    outsider.parent.mkdir(parents=True)
    outsider.write_bytes(b"y" * 10)
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("aaaa1111-2222", outputLogFile=str(outsider))])

    result = store.delete_entries(str(tmp_path), mode="ids", pane_ids=["aaaa1111-2222"])

    assert result.removed_log_files == 0
    assert result.freed_bytes == 0
    assert outsider.exists()


def test_delete_entries_tolerates_a_missing_log_file(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("aaaa1111-2222")])
    result = store.delete_entries(str(tmp_path), mode="ids", pane_ids=["aaaa1111-2222"])
    assert result.deleted_ids == ["aaaa1111-2222"]
    assert (result.freed_bytes, result.removed_log_files) == (0, 0)


def test_delete_entries_does_not_follow_a_symlinked_log(tmp_path: Path) -> None:
    real = tmp_path / "outside.log"
    real.write_bytes(b"z" * 40)
    link = tmp_path / ".agent-team" / "manual" / "20260101" / "claude-aaaa1111.log"
    link.parent.mkdir(parents=True)
    link.symlink_to(real)
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [_entry("aaaa1111-2222")])

    result = store.delete_entries(str(tmp_path), mode="ids", pane_ids=["aaaa1111-2222"])

    assert result.removed_log_files == 0
    assert real.exists()
    assert link.is_symlink()


# ── dry run (delete confirmation preview) ───────────────────────────────────
# The renderer has to tell the user which transcript logs a delete destroys
# and how much space it frees *before* they agree, so the same selection runs
# once with nothing written and nothing unlinked.


def test_delete_entries_dry_run_reports_what_a_real_run_would_free(
    tmp_path: Path,
) -> None:
    store = SpawnHistoryStore()
    entries = [
        _entry("aaaa1111-2222", removedAt="2026-07-01T00:00:00Z"),
        _entry("bbbb3333-4444", removedAt="2026-07-01T00:00:00Z"),
        _entry("cccc5555-6666"),
    ]
    store.merge(str(tmp_path), entries)
    doomed_a = _manual_log(tmp_path, "20260101", "claude-aaaa1111.log", 100)
    doomed_b = _manual_log(tmp_path, "20250315", "claude-bbbb3333.log", 40)
    keeper = _manual_log(tmp_path, "20260101", "claude-cccc5555.log", 7)

    preview = store.delete_entries(str(tmp_path), mode="removed", dry_run=True)

    assert preview.deleted_ids == ["aaaa1111-2222", "bbbb3333-4444"]
    assert preview.total == 1
    assert preview.freed_bytes == 140
    assert preview.removed_log_files == 2
    # Nothing happened: store intact, every log still on disk.
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == [
        "aaaa1111-2222", "bbbb3333-4444", "cccc5555-6666",
    ]
    assert doomed_a.exists() and doomed_b.exists() and keeper.exists()

    real = store.delete_entries(str(tmp_path), mode="removed")

    assert real == preview
    assert not doomed_a.exists() and not doomed_b.exists()
    assert keeper.exists()


def test_delete_entries_dry_run_honours_starred_immunity(tmp_path: Path) -> None:
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [
        _entry("aaaa1111-2222", removedAt="2026-07-01T00:00:00Z", starred=True),
    ])
    starred_log = _manual_log(tmp_path, "20260101", "claude-aaaa1111.log", 100)

    preview = store.delete_entries(str(tmp_path), mode="removed", dry_run=True)

    assert preview.deleted_ids == []
    assert (preview.freed_bytes, preview.removed_log_files) == (0, 0)
    assert starred_log.exists()


# ── project.delete_spawn_history / project.rename_spawn_history handlers ────


async def test_delete_spawn_history_handler_syncs_mirror_and_broadcasts(
    tmp_path: Path, monkeypatch
) -> None:
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    mirror = [
        _entry("p0", workspacePath=str(tmp_path)),
        _entry("p1", workspacePath=str(tmp_path), removedAt="2026-07-01T00:00:00Z"),
        _entry("p2", workspacePath=str(tmp_path)),
    ]
    store.set_ui_state(str(tmp_path), spawn_history=mirror)
    monkeypatch.setattr(app, "project_store", store)

    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any], exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.delete_spawn_history")
    assert fn is not None
    await fn(session, "m1", "project.delete_spawn_history", {
        "workspace_path": str(tmp_path),
        "mode": "removed",
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"] == {
        "deleted": 1, "total": 2, "freed_bytes": 0, "removed_log_files": 0,
    }
    # Full store (seeded from the mirror) and mirror both lost p1.
    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert [e["paneId"] for e in stored] == ["p0", "p2"]
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert [e["paneId"] for e in fresh.ui_spawn_history or []] == ["p0", "p2"]
    # Peers got the updated mirror over the existing ui_state_changed channel.
    assert len(events) == 1
    assert events[0]["type"] == "project.ui_state_changed"
    assert [e["paneId"] for e in events[0]["payload"]["spawn_history"]] == ["p0", "p2"]


async def test_delete_spawn_history_handler_dry_run_previews_then_deletes(
    tmp_path: Path, monkeypatch
) -> None:
    """`dry_run: true` answers with the real figures but changes nothing; the
    same request without it (the user confirmed) then goes through."""
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    store.set_ui_state(str(tmp_path), spawn_history=[
        _entry("aaaa1111-2222", workspacePath=str(tmp_path),
               removedAt="2026-07-01T00:00:00Z"),
        _entry("cccc5555-6666", workspacePath=str(tmp_path)),
    ])
    monkeypatch.setattr(app, "project_store", store)
    doomed = _manual_log(tmp_path, "20260101", "claude-aaaa1111.log", 100)

    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any], exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.delete_spawn_history")
    assert fn is not None
    request = {"workspace_path": str(tmp_path), "mode": "removed"}
    await fn(session, "m1", "project.delete_spawn_history", {**request, "dry_run": True})

    preview = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert preview == {
        "deleted": 1, "total": 1, "freed_bytes": 100, "removed_log_files": 1,
    }
    assert doomed.exists()
    assert events == []
    mirror = ProjectStore().peek(str(tmp_path))
    assert mirror is not None
    assert [e["paneId"] for e in mirror.ui_spawn_history or []] == [
        "aaaa1111-2222", "cccc5555-6666",
    ]

    await fn(session, "m2", "project.delete_spawn_history", request)

    assert session.websocket.sent[1]["payload"] == preview  # type: ignore[attr-defined]
    assert not doomed.exists()
    assert [e["paneId"] for e in _stored_entries(app.spawn_history_store, tmp_path)] == [
        "cccc5555-6666",
    ]
    assert len(events) == 1


async def test_delete_spawn_history_handler_rejects_bad_requests(
    tmp_path: Path, monkeypatch
) -> None:
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    monkeypatch.setattr(app, "project_store", store)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.delete_spawn_history")
    assert fn is not None
    for bad in (
        {"mode": "bogus"},
        {"mode": "ids", "pane_ids": []},
        {"mode": "older_than"},
    ):
        await fn(session, "m1", "project.delete_spawn_history", {
            "workspace_path": str(tmp_path), **bad,
        })
    for resp in session.websocket.sent:  # type: ignore[attr-defined]
        assert resp["ok"] is False
        assert resp["error"]["code"] == "BAD_REQUEST"


async def test_rename_spawn_history_handler_patches_store_and_mirror(
    tmp_path: Path, monkeypatch
) -> None:
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    # Full store holds an old entry the 100-entry mirror no longer carries.
    app.spawn_history_store.merge(str(tmp_path), [
        _entry("p-old", workspacePath=str(tmp_path)),
        _entry("p1", workspacePath=str(tmp_path)),
    ])
    store.set_ui_state(
        str(tmp_path), spawn_history=[_entry("p1", workspacePath=str(tmp_path))]
    )
    monkeypatch.setattr(app, "project_store", store)

    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any], exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.rename_spawn_history")
    assert fn is not None

    # Beyond-mirror entry: full store patched, no mirror change → no broadcast.
    await fn(session, "m1", "project.rename_spawn_history", {
        "workspace_path": str(tmp_path), "pane_id": "p-old", "custom_name": "Oldie",
    })
    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert stored[0]["customName"] == "Oldie"
    assert events == []

    # Mirror entry: both layers patched + mirror broadcast to peers.
    await fn(session, "m2", "project.rename_spawn_history", {
        "workspace_path": str(tmp_path), "pane_id": "p1", "custom_name": "Newie",
    })
    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert stored[1]["customName"] == "Newie"
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert (fresh.ui_spawn_history or [])[0]["customName"] == "Newie"
    assert len(events) == 1
    assert events[0]["type"] == "project.ui_state_changed"

    # Empty custom_name resets the name in the full store.
    await fn(session, "m3", "project.rename_spawn_history", {
        "workspace_path": str(tmp_path), "pane_id": "p-old", "custom_name": "",
    })
    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert "customName" not in stored[0]


async def test_rename_pane_handler_patches_full_store(
    tmp_path: Path, monkeypatch
) -> None:
    """A live-pane rename must reach spawn-history.json at the source, not
    only via the renderer's debounced snapshot merge."""
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    store.set_ui_state(
        str(tmp_path), spawn_history=[_entry("p1", workspacePath=str(tmp_path))]
    )
    app.spawn_history_store.merge(
        str(tmp_path), [_entry("p1", workspacePath=str(tmp_path))]
    )
    monkeypatch.setattr(app, "project_store", store)

    async def no_broadcast(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(app, "broadcast", no_broadcast)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.rename_pane")
    assert fn is not None
    await fn(session, "m1", "project.rename_pane", {
        "workspace_path": str(tmp_path), "pane_id": "p1", "custom_name": "Live name",
    })

    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert stored[0]["customName"] == "Live name"


async def test_set_pane_auto_name_handler_broadcasts_once_and_skips_history(
    tmp_path: Path, monkeypatch
) -> None:
    """First auto-name write is broadcast to peers; set-once repeats are
    silent no-ops, and neither touches the spawn-history layers."""
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    store.record_manual_pane_spawn(str(tmp_path), pane_id="p1", agent="claude")
    store.set_ui_state(
        str(tmp_path), spawn_history=[_entry("p1", workspacePath=str(tmp_path))]
    )
    monkeypatch.setattr(app, "project_store", store)

    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any], exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.set_pane_auto_name")
    assert fn is not None

    # First write wins: persisted + broadcast with the auto_name field.
    await fn(session, "m1", "project.set_pane_auto_name", {
        "workspace_path": str(tmp_path), "pane_id": "p1", "auto_name": "Fix login",
    })
    assert len(events) == 1
    assert events[0]["type"] == "project.ui_state_changed"
    assert events[0]["payload"]["auto_named_pane"] == {
        "pane_id": "p1", "auto_name": "Fix login",
    }
    pane = next(p for p in store.peek(str(tmp_path)).panes if p.pane_id == "p1")
    assert pane.auto_name == "Fix login"

    # Set-once: the losing write is ignored and NOT broadcast.
    await fn(session, "m2", "project.set_pane_auto_name", {
        "workspace_path": str(tmp_path), "pane_id": "p1", "auto_name": "Loser",
    })
    assert len(events) == 1
    pane = next(p for p in store.peek(str(tmp_path)).panes if p.pane_id == "p1")
    assert pane.auto_name == "Fix login"

    # Unlike rename_pane, neither the mirror nor spawn-history.json changed.
    history = store.peek(str(tmp_path)).ui_spawn_history
    assert "autoName" not in history[0] and "customName" not in history[0]
    assert not app.spawn_history_store.history_file(str(tmp_path)).exists()

    ok_responses = session.websocket.sent  # type: ignore[attr-defined]
    assert [r["payload"] for r in ok_responses] == [{"ok": True}, {"ok": True}]


async def test_set_pane_auto_name_handler_skips_broadcast_when_custom_named(
    tmp_path: Path, monkeypatch
) -> None:
    """custom_name wins: the handler neither writes nor broadcasts."""
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    store.record_manual_pane_spawn(str(tmp_path), pane_id="p1", agent="claude")
    store.rename_pane(str(tmp_path), pane_id="p1", custom_name="User Name")
    monkeypatch.setattr(app, "project_store", store)

    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any], exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.set_pane_auto_name")
    assert fn is not None
    await fn(session, "m1", "project.set_pane_auto_name", {
        "workspace_path": str(tmp_path), "pane_id": "p1", "auto_name": "Auto",
    })

    assert events == []
    pane = next(p for p in store.peek(str(tmp_path)).panes if p.pane_id == "p1")
    assert pane.custom_name == "User Name"
    assert pane.auto_name == ""


def test_delete_entries_bulk_modes_skip_starred(tmp_path: Path) -> None:
    """Starred entries survive "removed" and "older_than" cleanup."""
    store = SpawnHistoryStore()
    cutoff = "2026-07-15T00:00:00Z"
    store.merge(str(tmp_path), [
        _entry("plain-removed", spawnedAt="2026-07-01T00:00:00Z", removedAt="2026-07-01T00:00:00Z"),
        _entry("starred-removed", spawnedAt="2026-07-01T00:00:00Z", removedAt="2026-07-01T00:00:00Z", starred=True),
        _entry("active"),
    ])
    deleted, total, *_ = store.delete_entries(str(tmp_path), mode="removed")
    assert deleted == ["plain-removed"]
    assert total == 2
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == [
        "starred-removed", "active",
    ]
    # older_than: the starred entry is old and removed, yet still kept.
    deleted, total, *_ = store.delete_entries(
        str(tmp_path), mode="older_than", cutoff_iso=cutoff
    )
    assert deleted == []
    assert total == 2


def test_delete_entries_ids_mode_still_deletes_starred(tmp_path: Path) -> None:
    """An explicit single delete overrides the star protection."""
    store = SpawnHistoryStore()
    store.merge(str(tmp_path), [
        _entry("starred", removedAt="2026-07-01T00:00:00Z", starred=True),
        _entry("other"),
    ])
    deleted, total, *_ = store.delete_entries(
        str(tmp_path), mode="ids", pane_ids=["starred"]
    )
    assert deleted == ["starred"]
    assert total == 1
    assert [e["paneId"] for e in _stored_entries(store, tmp_path)] == ["other"]


async def test_delete_spawn_history_handler_keeps_starred_in_store_and_mirror(
    tmp_path: Path, monkeypatch
) -> None:
    """End-to-end check that the mirror inherits the starred protection:
    the mirror is filtered by the store's deleted_ids, so an entry doomed()
    skips must survive in BOTH layers after a bulk cleanup."""
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    mirror = [
        _entry(
            "starred-gone",
            workspacePath=str(tmp_path),
            removedAt="2026-07-01T00:00:00Z",
            starred=True,
        ),
        _entry("plain-gone", workspacePath=str(tmp_path), removedAt="2026-07-02T00:00:00Z"),
    ]
    store.set_ui_state(str(tmp_path), spawn_history=mirror)
    monkeypatch.setattr(app, "project_store", store)

    async def no_broadcast(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(app, "broadcast", no_broadcast)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.delete_spawn_history")
    assert fn is not None
    await fn(session, "m1", "project.delete_spawn_history", {
        "workspace_path": str(tmp_path),
        "mode": "removed",
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["payload"] == {
        "deleted": 1, "total": 1, "freed_bytes": 0, "removed_log_files": 0,
    }
    # Full store: only the unstarred removed entry was cleaned.
    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert [e["paneId"] for e in stored] == ["starred-gone"]
    # project.json mirror: same survivor set.
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert [e["paneId"] for e in fresh.ui_spawn_history or []] == ["starred-gone"]


async def test_star_spawn_history_handler_patches_store_and_mirror(
    tmp_path: Path, monkeypatch
) -> None:
    from agent_team_backend import app, ws_handlers

    store = ProjectStore()
    store.save(store.load_or_create(str(tmp_path)))
    # Full store holds an old entry the 100-entry mirror no longer carries.
    app.spawn_history_store.merge(str(tmp_path), [
        _entry("p-old", workspacePath=str(tmp_path)),
        _entry("p1", workspacePath=str(tmp_path)),
    ])
    store.set_ui_state(
        str(tmp_path), spawn_history=[_entry("p1", workspacePath=str(tmp_path))]
    )
    monkeypatch.setattr(app, "project_store", store)

    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any], exclude: Any = None) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", capture)

    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    fn = ws_handlers.lookup("project.star_spawn_history")
    assert fn is not None

    # Beyond-mirror entry: full store patched, no mirror change -> no broadcast.
    await fn(session, "m1", "project.star_spawn_history", {
        "workspace_path": str(tmp_path), "pane_id": "p-old", "starred": True,
    })
    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert stored[0]["starred"] is True
    assert events == []

    # Mirror entry: both layers patched + mirror broadcast to peers.
    await fn(session, "m2", "project.star_spawn_history", {
        "workspace_path": str(tmp_path), "pane_id": "p1", "starred": True,
    })
    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert stored[1]["starred"] is True
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert (fresh.ui_spawn_history or [])[0]["starred"] is True
    assert len(events) == 1
    assert events[0]["type"] == "project.ui_state_changed"

    # Unstar removes the key from the full store rather than storing False.
    await fn(session, "m3", "project.star_spawn_history", {
        "workspace_path": str(tmp_path), "pane_id": "p1", "starred": False,
    })
    stored = _stored_entries(app.spawn_history_store, tmp_path)
    assert "starred" not in stored[1]
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert "starred" not in (fresh.ui_spawn_history or [])[0]
