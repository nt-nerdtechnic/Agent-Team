"""The machine's stable device id: generated once, reread forever, self-healing.

Cross-device messaging addresses devices, so a value that changed per restart
would leave ghost devices in the remote roster and break peers' cached
addressing — hence the emphasis on "same value on the next read".
"""

from __future__ import annotations

import json
import logging
import uuid

import pytest

from agent_team_backend import device_identity


def test_the_id_is_generated_and_persisted_on_first_read() -> None:
    value = device_identity.device_id()
    uuid.UUID(value)  # raises if it is not a real UUID
    path = device_identity.device_identity_path()
    assert path.exists()
    assert json.loads(path.read_text(encoding="utf-8")) == {"device_id": value}


def test_rereading_returns_the_same_id() -> None:
    value = device_identity.device_id()
    assert device_identity.device_id() == value
    assert device_identity.device_id() == value


def test_two_machines_do_not_collide(tmp_path, monkeypatch) -> None:
    first = device_identity.device_id()
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "other-machine"))
    assert device_identity.device_id() != first


# ── the data dir is where the id lives ──────────────────────────────────────


def test_the_file_follows_the_data_dir_override(tmp_path, monkeypatch) -> None:
    override = tmp_path / "elsewhere"
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(override))
    value = device_identity.device_id()
    assert device_identity.device_identity_path() == override / "device-identity.json"
    assert json.loads((override / "device-identity.json").read_text(encoding="utf-8")) == {
        "device_id": value
    }


def test_the_data_dir_is_created_when_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "not" / "there" / "yet"))
    assert device_identity.device_id()


# ── self-healing: never let a bad file stop the backend ─────────────────────


@pytest.mark.parametrize(
    "content",
    [
        "",
        "   ",
        "not json at all",
        '{"device_id": ',  # truncated mid-write
        "{}",
        '{"device_id": null}',
        '{"device_id": 42}',
        '{"device_id": "not-a-uuid"}',
        '["device_id"]',
    ],
    ids=[
        "empty",
        "blank",
        "garbage",
        "truncated",
        "no-key",
        "null",
        "not-a-string",
        "malformed-uuid",
        "not-an-object",
    ],
)
def test_an_unusable_file_is_regenerated(content: str) -> None:
    path = device_identity.device_identity_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    value = device_identity.device_id()
    uuid.UUID(value)
    assert device_identity.device_id() == value  # and the repair sticks


def test_a_deleted_file_is_regenerated() -> None:
    first = device_identity.device_id()
    device_identity.device_identity_path().unlink()
    second = device_identity.device_id()
    uuid.UUID(second)
    assert second != first


def test_regenerating_leaves_a_trace_in_the_log(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="agent_team_backend.device_identity"):
        value = device_identity.device_id()
    assert any(value in record.getMessage() for record in caplog.records)


def test_a_corrupt_file_is_reported_before_it_is_replaced(caplog) -> None:
    device_identity.device_identity_path().write_text("garbage", encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="agent_team_backend.device_identity"):
        device_identity.device_id()
    assert any(record.levelno == logging.WARNING for record in caplog.records)


def test_no_temp_file_survives_a_failed_write(monkeypatch) -> None:
    path = device_identity.device_identity_path()
    tmp = path.with_suffix(path.suffix + ".tmp")

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(device_identity.os, "replace", boom)
    with pytest.raises(OSError):
        device_identity.device_id()
    assert not tmp.exists()
