"""An unreadable project document must not take every pane record with it.

load_or_create recreates the document when it cannot be parsed, which is what
keeps the workspace openable — but the document it replaces holds the whole
restore roster for that workspace, and the overwrite used to be the only copy's
last moment. These cover that the original is kept aside first.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from agent_team_backend.projects import _KV_KEY, ProjectStore


def _seed_corrupt(store: ProjectStore, ws: str, panes: list[dict[str, Any]]) -> None:
    """Write a document that parses as JSON but blows up in Project.from_dict."""
    db = store._databases.get(ws)
    assert db is not None
    db.kv_set(_KV_KEY, {"panes": panes, "stages": 42}, now=1)


def _corrupt_keys(store: ProjectStore, ws: str) -> list[str]:
    db = store._databases.get(ws)
    assert db is not None
    with db._lock:  # type: ignore[attr-defined]
        rows = db._conn.execute(  # type: ignore[attr-defined]
            "SELECT key FROM kv WHERE key LIKE ?", (f"{_KV_KEY}.corrupt-%",)
        ).fetchall()
    return sorted(r["key"] for r in rows)


def test_corrupt_document_is_kept_before_it_is_recreated(tmp_path: Path) -> None:
    ws = str(tmp_path)
    store = ProjectStore()
    store.load_or_create(ws)  # materialise the database
    _seed_corrupt(store, ws, [{"pane_id": "keep-me", "spawn_status": "spawned"}])

    project = store.load_or_create(ws)

    assert project.panes == []  # recreated, as before
    keys = _corrupt_keys(store, ws)
    assert len(keys) == 1
    db = store._databases.get(ws)
    assert db is not None
    kept = db.kv_get(keys[0])
    assert kept["document"]["panes"] == [{"pane_id": "keep-me", "spawn_status": "spawned"}]
    assert kept["error"]
    assert kept["quarantined_at"]


def test_a_healthy_document_is_not_quarantined(tmp_path: Path) -> None:
    ws = str(tmp_path)
    store = ProjectStore()
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")

    store.load_or_create(ws)

    assert _corrupt_keys(store, ws) == []


def test_a_second_corruption_does_not_drop_the_first_copy(tmp_path: Path) -> None:
    """Both copies survive even when the two failures land in the same second."""
    ws = str(tmp_path)
    store = ProjectStore()
    store.load_or_create(ws)

    _seed_corrupt(store, ws, [{"pane_id": "first", "spawn_status": "spawned"}])
    store.load_or_create(ws)
    _seed_corrupt(store, ws, [{"pane_id": "second", "spawn_status": "spawned"}])
    store.load_or_create(ws)

    keys = _corrupt_keys(store, ws)
    assert len(keys) == 2
    db = store._databases.get(ws)
    assert db is not None
    kept = {k: db.kv_get(k)["document"]["panes"][0]["pane_id"] for k in keys}
    assert sorted(kept.values()) == ["first", "second"]


def test_quarantine_failure_still_lets_the_workspace_open(tmp_path: Path) -> None:
    """Keeping the copy is best-effort — it must never cost the recovery."""
    ws = str(tmp_path)
    store = ProjectStore()
    store.load_or_create(ws)
    _seed_corrupt(store, ws, [{"pane_id": "x", "spawn_status": "spawned"}])

    db = store._databases.get(ws)
    assert db is not None
    original = db.kv_set

    def boom(key: str, value: Any, **kwargs: Any) -> None:
        # Only the quarantine write fails; the recreate that follows must still
        # go through, which is the whole point of the guarantee under test.
        if key.startswith(f"{_KV_KEY}.corrupt-"):
            raise RuntimeError("disk gone")
        original(key, value, **kwargs)

    db.kv_set = boom  # type: ignore[method-assign]
    try:
        project = store.load_or_create(ws)
    finally:
        db.kv_set = original  # type: ignore[method-assign]

    assert project.panes == []
