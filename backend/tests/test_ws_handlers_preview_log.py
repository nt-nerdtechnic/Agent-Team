"""preview.log_* handlers: the app's own writer into the preview record track.

Three writers feed the track and only this one goes through the renderer, so
the thing to pin is that the wire cannot claim to be one of the other two — a
row arriving here is a user action by construction. The other is the broadcast:
unlike the message log, a preview record has to reach every window showing the
same workspace, and the frame must be an *event* (no ``ok`` field), which is
how the renderer's ws client tells events from RPC replies.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.preview_log import PreviewLog


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.fixture()
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return captured


@pytest.fixture(autouse=True)
def store(monkeypatch: pytest.MonkeyPatch) -> PreviewLog:
    """A store of its own, so rows land under the test's tmp workspace."""
    fresh = PreviewLog()
    monkeypatch.setattr(app, "preview_log", fresh)
    return fresh


async def _call(session: app.Session, msg_type: str, **payload: Any) -> dict[str, Any]:
    await app.handle_message(session, {"id": "m1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


async def test_append_records_the_row_and_broadcasts_it(tmp_path, broadcasts) -> None:
    response = await _call(
        _session(),
        "preview.log_append",
        workspace_path=str(tmp_path),
        change="shown",
        rel_path="src/a.ts",
        title="a.ts",
    )
    entry = response["payload"]["entry"]
    assert entry["rel_path"] == "src/a.ts"
    assert entry["change"] == "shown"

    assert len(broadcasts) == 1
    event = broadcasts[0]
    assert event["type"] == "preview.recorded"
    assert event["payload"]["workspace_path"] == str(tmp_path)
    assert event["payload"]["entry"]["uid"] == entry["uid"]
    # An event, not a response: the renderer routes on the absence of `ok`.
    assert "ok" not in event


async def test_the_wire_cannot_claim_to_be_an_agent_or_the_watcher(tmp_path, broadcasts) -> None:
    response = await _call(
        _session(),
        "preview.log_append",
        workspace_path=str(tmp_path),
        change="modified",
        rel_path="src/a.ts",
        source="agent",
        agent="claude",
    )
    entry = response["payload"]["entry"]
    assert entry["source"] == "user"
    assert entry["agent"] is None


async def test_append_needs_a_workspace_and_a_change(tmp_path, broadcasts) -> None:
    missing_ws = await _call(_session(), "preview.log_append", change="modified")
    assert missing_ws["error"]["code"] == "BAD_REQUEST"
    missing_change = await _call(
        _session(), "preview.log_append", workspace_path=str(tmp_path)
    )
    assert missing_change["error"]["code"] == "BAD_REQUEST"
    assert broadcasts == []


async def test_a_rejected_row_is_reported_without_a_broadcast(tmp_path, broadcasts) -> None:
    # "renamed" is not in the store's vocabulary, so nothing is recorded and
    # there is nothing for the other windows to show.
    response = await _call(
        _session(),
        "preview.log_append",
        workspace_path=str(tmp_path),
        change="renamed",
        rel_path="src/a.ts",
    )
    assert response["payload"]["entry"] is None
    assert broadcasts == []


async def test_snapshot_returns_the_track_newest_first(tmp_path, store, broadcasts) -> None:
    store.append(str(tmp_path), change="modified", rel_path="old.ts", source="watcher")
    store.append(str(tmp_path), change="modified", rel_path="new.ts", source="agent", agent="claude")

    response = await _call(
        _session(), "preview.log_snapshot", workspace_path=str(tmp_path)
    )
    entries = response["payload"]["entries"]
    assert [e["rel_path"] for e in entries] == ["new.ts", "old.ts"]
    assert entries[0]["agent"] == "claude"


async def test_snapshot_rejects_a_missing_workspace_or_a_bad_limit(tmp_path) -> None:
    missing = await _call(_session(), "preview.log_snapshot")
    assert missing["error"]["code"] == "BAD_REQUEST"
    bad_limit = await _call(
        _session(), "preview.log_snapshot", workspace_path=str(tmp_path), limit="abc"
    )
    assert bad_limit["error"]["code"] == "BAD_REQUEST"


async def test_clear_reports_what_went_and_tells_the_other_windows(
    tmp_path, store, broadcasts
) -> None:
    store.append(str(tmp_path), change="modified", rel_path="a.ts", source="user")
    store.append(str(tmp_path), change="modified", rel_path="b.ts", source="user")

    response = await _call(_session(), "preview.log_clear", workspace_path=str(tmp_path))
    assert response["payload"]["removed"] == 2
    assert store.tail(str(tmp_path)) == []

    assert len(broadcasts) == 1
    assert broadcasts[0]["type"] == "preview.log_cleared"
    assert broadcasts[0]["payload"]["workspace_path"] == str(tmp_path)
    assert broadcasts[0]["payload"]["removed"] == 2
    assert "ok" not in broadcasts[0]


async def test_clear_keeps_rows_recorded_after_the_cutoff(tmp_path, store, broadcasts) -> None:
    old = store.append(str(tmp_path), change="modified", rel_path="a.ts", source="user")
    assert old is not None
    response = await _call(
        _session(),
        "preview.log_clear",
        workspace_path=str(tmp_path),
        before=old["created_at"],
    )
    assert response["payload"]["removed"] == 0
    assert len(store.tail(str(tmp_path))) == 1
    # Nothing went, so there is nothing for the other windows to apply.
    assert broadcasts == []


async def test_clear_rejects_a_missing_workspace_or_a_bad_cutoff(tmp_path) -> None:
    missing = await _call(_session(), "preview.log_clear")
    assert missing["error"]["code"] == "BAD_REQUEST"
    bad_before = await _call(
        _session(), "preview.log_clear", workspace_path=str(tmp_path), before="soon"
    )
    assert bad_before["error"]["code"] == "BAD_REQUEST"


async def test_every_handler_resolves_a_subdirectory_to_the_project_root(
    tmp_path, store, broadcasts
) -> None:
    """A window opened inside a repository reads and writes the root's track —
    the same database the hook, the watcher and the MCP tools land in."""
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    sub = tmp_path / "repo" / "pkg"
    sub.mkdir()
    root = str((tmp_path / "repo").resolve())

    appended = await _call(
        _session(),
        "preview.log_append",
        workspace_path=str(sub),
        change="created",
        rel_path="a.ts",
    )
    assert appended["payload"]["entry"] is not None
    assert [r["rel_path"] for r in store.tail(root)] == ["a.ts"]
    assert not (sub / ".agent-team").exists()
    # The resolved path, so a snapshot of the same window sees the same track.
    assert broadcasts[0]["payload"]["workspace_path"] == root

    snapshot = await _call(_session(), "preview.log_snapshot", workspace_path=str(sub))
    assert [e["rel_path"] for e in snapshot["payload"]["entries"]] == ["a.ts"]

    cleared = await _call(_session(), "preview.log_clear", workspace_path=str(sub))
    assert cleared["payload"]["removed"] == 1
    assert broadcasts[-1]["payload"]["workspace_path"] == root


async def test_snapshot_reports_the_root_it_resolved_the_workspace_to(
    tmp_path, store, broadcasts
) -> None:
    """The renderer matches live `preview.recorded` events on this value.

    Every broadcast carries the resolved root, so a window opened on a
    subdirectory that only knew its raw path would silently drop all of them.
    """
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    sub = tmp_path / "repo" / "pkg"
    sub.mkdir()
    root = str((tmp_path / "repo").resolve())

    from_sub = await _call(_session(), "preview.log_snapshot", workspace_path=str(sub))
    assert from_sub["payload"]["root"] == root

    # And the root itself resolves to itself, so the window at the top of the
    # repository compares against exactly what it already had.
    from_root = await _call(_session(), "preview.log_snapshot", workspace_path=root)
    assert from_root["payload"]["root"] == root
