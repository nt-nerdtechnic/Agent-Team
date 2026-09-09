"""Regressions for pipeline-document integrity in StagesStore.

Four defects live here:

1. Lock discipline. The stage CRUD methods (upsert/reorder/delete/reset) take
   ``self._lock`` around their read-modify-write, but the pipeline CRUD methods
   (create/rename/delete/set_active/reset_builtin) did not. Since every write
   replaces the whole document, two concurrent callers each wrote the document
   they had read and one of the two edits vanished.
2. ``replace_document`` rebuilt the document without ``schemaVersion``, so a
   settings-bundle import silently erased the forward-compatibility marker that
   ``_read_doc`` uses to refuse rewriting a newer document.
3. A blank ``pipeline_id`` resolves to the active pipeline inside
   ``_get_pipeline`` — right for the stage CRUD, wrong for pipeline CRUD, where
   ``rename_pipeline("")`` renamed whatever was active and ``delete_pipeline("")``
   reported success while deleting nothing.
4. ``reorder`` looked the ids up one by one without de-duplicating, so an id
   listed twice produced two copies of the same stage.

The concurrency tests widen the read-modify-write window by making ``_read_doc``
sleep; that makes the lost update deterministic rather than a race the test has
to be lucky to hit.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from agent_team_backend.stages_store import (
    PIPELINES_FILE,
    SCHEMA_VERSION,
    StagesStore,
    default_stages,
)


# ── helpers ────────────────────────────────────────────────────────────────────

def fresh_store(tmp_path: Path) -> StagesStore:
    return StagesStore(tmp_path / PIPELINES_FILE)


def widen_rmw_window(store: StagesStore, delay: float = 0.05) -> None:
    """Make every document read linger so two writers overlap on purpose."""
    original = store._read_doc

    def slow_read() -> dict:
        doc = original()
        time.sleep(delay)
        return doc

    store._read_doc = slow_read  # type: ignore[method-assign]


def run_together(*targets) -> None:
    threads = [threading.Thread(target=t) for t in targets]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
        assert not t.is_alive(), "a store call never returned (deadlock?)"


def a_stage(stage_id: str) -> dict:
    return {
        "id": stage_id,
        "title": stage_id,
        "short_title": stage_id,
        "question": "?",
        "description": "",
        "recommended_roles": [],
        "sentinel": "---DONE---",
        "slots": [
            {
                "agent_key": "claude",
                "role_key": "",
                "label": "A",
                "kickoff_body": "",
                "is_commander": False,
            }
        ],
    }


# ── 1. lock discipline ─────────────────────────────────────────────────────────

class TestConcurrentPipelineWrites:
    def test_two_creates_both_survive(self, tmp_path):
        store = fresh_store(tmp_path)
        store.list_pipelines()  # seed before the window is widened
        widen_rmw_window(store)

        run_together(
            lambda: store.create_pipeline("alpha"),
            lambda: store.create_pipeline("beta"),
        )

        names = {p["name"] for p in store.list_pipelines()}
        assert {"alpha", "beta"} <= names

    def test_rename_is_not_lost_to_a_concurrent_create(self, tmp_path):
        store = fresh_store(tmp_path)
        store.list_pipelines()
        widen_rmw_window(store)

        run_together(
            lambda: store.rename_pipeline("maintenance", "renamed"),
            lambda: store.create_pipeline("gamma"),
        )

        summaries = {p["id"]: p["name"] for p in store.list_pipelines()}
        assert summaries["maintenance"] == "renamed"
        assert "gamma" in summaries.values()

    def test_set_active_is_not_lost_to_a_concurrent_create(self, tmp_path):
        store = fresh_store(tmp_path)
        store.list_pipelines()
        widen_rmw_window(store)

        run_together(
            lambda: store.set_active_pipeline("maintenance"),
            lambda: store.create_pipeline("delta"),
        )

        assert store.get_active_pipeline_id() == "maintenance"
        assert "delta" in {p["name"] for p in store.list_pipelines()}

    def test_delete_is_not_lost_to_a_concurrent_create(self, tmp_path):
        store = fresh_store(tmp_path)
        store.list_pipelines()
        widen_rmw_window(store)

        run_together(
            lambda: store.delete_pipeline("maintenance"),
            lambda: store.create_pipeline("epsilon"),
        )

        summaries = store.list_pipelines()
        assert not any(p["id"] == "maintenance" for p in summaries)
        assert "epsilon" in {p["name"] for p in summaries}

    def test_reset_builtin_is_not_lost_to_a_concurrent_create(self, tmp_path):
        store = fresh_store(tmp_path)
        store.delete("01", "default")
        widen_rmw_window(store)

        run_together(
            lambda: store.reset_builtin("default"),
            lambda: store.create_pipeline("zeta"),
        )

        assert len(store.list("default")) == len(default_stages())
        assert "zeta" in {p["name"] for p in store.list_pipelines()}

    def test_stage_upsert_is_not_clobbered_by_a_concurrent_create(self, tmp_path):
        """The mixed discipline is what made this bite: upsert held the lock and
        create_pipeline did not, so create read the pre-upsert document and wrote
        it back over the new stage."""
        store = fresh_store(tmp_path)
        target = store.create_pipeline("host")["id"]
        widen_rmw_window(store)

        run_together(
            lambda: store.upsert(a_stage("s-01"), target),
            lambda: store.create_pipeline("eta"),
        )

        assert [s["id"] for s in store.list(target)] == ["s-01"]
        assert "eta" in {p["name"] for p in store.list_pipelines()}


# ── 2. replace_document keeps the schema marker ────────────────────────────────

class TestReplaceDocumentSchemaVersion:
    def test_replace_document_stamps_schema_version(self, tmp_path):
        store = fresh_store(tmp_path)
        doc = store.replace_document(store.export_document())
        assert doc["schemaVersion"] == SCHEMA_VERSION

    def test_a_newer_document_is_read_as_is(self, tmp_path):
        """The guard the marker feeds: a document stamped by a later app version
        is loaded whole rather than regenerated, so its forward data survives a
        round trip through this version.

        Not a regression test for the stamping fix above — this passes either
        way, because SCHEMA_VERSION is 1 and `_read_doc`'s fallback for a missing
        marker is also the current version. That coincidence is the only reason a
        dropped marker is harmless today; it stops holding the moment
        SCHEMA_VERSION is bumped, which is what the stamping fix is for.
        """
        store = fresh_store(tmp_path)
        doc = store.export_document()
        doc["schemaVersion"] = SCHEMA_VERSION + 1
        doc["pipelines"] = [
            {"id": "from-the-future", "name": "Future", "builtin": False, "stages": []}
        ]
        doc["active_pipeline_id"] = "from-the-future"
        doc["a_field_this_version_knows_nothing_about"] = 42
        store._write_doc(doc)

        again = store.export_document()
        assert again["schemaVersion"] == SCHEMA_VERSION + 1
        assert [p["id"] for p in again["pipelines"]] == ["from-the-future"]
        assert again["a_field_this_version_knows_nothing_about"] == 42


# ── 3. a blank pipeline id is not "whatever is active" ─────────────────────────

class TestBlankPipelineId:
    def test_rename_with_a_blank_id_does_not_rename_the_active_pipeline(self, tmp_path):
        store = fresh_store(tmp_path)
        with pytest.raises(KeyError):
            store.rename_pipeline("", "HIJACKED")
        names = {p["name"] for p in store.list_pipelines()}
        assert "HIJACKED" not in names

    def test_delete_with_a_blank_id_is_not_reported_as_success(self, tmp_path):
        store = fresh_store(tmp_path)
        with pytest.raises(KeyError):
            store.delete_pipeline("")

    def test_reset_builtin_with_a_blank_id_writes_nothing(self, tmp_path):
        """reset_builtin is safe from the same trap only by accident: the seed
        branches match the *requested* id, so a blank one falls through to the
        raise. Pinned here because the obvious "tidy-up" — matching the resolved
        pipeline's id instead — would silently reset whatever is active.
        """
        store = fresh_store(tmp_path)
        store.delete("01", "default")
        remaining = [s["id"] for s in store.list("default")]
        with pytest.raises(ValueError, match="''"):
            store.reset_builtin("")
        assert [s["id"] for s in store.list("default")] == remaining


# ── 4. reorder does not duplicate stages ───────────────────────────────────────

class TestReorderDeduplicates:
    def test_repeated_id_does_not_duplicate_the_stage(self, tmp_path):
        store = fresh_store(tmp_path)
        ids = [s["id"] for s in store.list("default")]
        result = store.reorder([ids[0], ids[0], *ids[1:]], "default")
        assert [s["id"] for s in result] == ids
        assert [s["id"] for s in store.list("default")] == ids
