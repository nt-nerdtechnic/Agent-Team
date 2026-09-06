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


# ── A machine is not something an account can claim ──────────────────────────
#
# One id for the whole machine made "this machine" and "this machine in this
# account" the same thing. Register a second account from a machine the server
# already knows and every auth.hello answers DEVICE_CONFLICT, for ever, because
# the id belongs to the first member — reported on M3, and the account view said
# "access token rejected", which sends people to retype a password that was
# never wrong.


def test_the_first_account_to_ask_inherits_the_id_this_machine_already_had(tmp_path, monkeypatch):
    """The migration rule that must not break: an existing pairing survives.

    Asserted on **the id this machine presents**, not on its own pin table. Its
    pins are keyed by the *other* machine's id and would be untouched either
    way — asserting those would be a test that passes whether or not the
    migration works.
    """
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    legacy = device_identity.device_id()

    presented = device_identity.node_id_for("m-existing")

    assert presented == legacy, "peers pinned this machine under that id"
    device_identity.claim_node_id("m-existing", presented)
    assert device_identity.node_id_for("m-existing") == legacy


def test_a_second_account_does_not_get_the_first_ones_id(tmp_path, monkeypatch):
    """The bug itself: two accounts sharing one id is what the server refuses."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    legacy = device_identity.device_id()
    device_identity.claim_node_id("m-first", legacy)

    second = device_identity.node_id_for("m-second")

    assert second != legacy
    assert device_identity.node_id_for("m-first") == legacy, "the first is untouched"


def test_nothing_is_recorded_until_the_server_accepts_it(tmp_path, monkeypatch):
    """A refused id must not be spent. The server caps a member at ten devices,
    so recording on every attempt would exhaust the account by trying."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    device_identity.device_id()

    for _ in range(5):
        device_identity.node_id_for("m-never-accepted")

    doc = json.loads(device_identity.device_identity_path().read_text(encoding="utf-8"))
    assert doc.get("nodes", {}) == {}


def test_a_fresh_id_is_one_this_machine_has_never_offered(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    legacy = device_identity.device_id()
    device_identity.claim_node_id("m-first", legacy)

    a, b = device_identity.fresh_node_id(), device_identity.fresh_node_id()

    assert a != b and a != legacy


def test_the_machine_id_is_not_any_accounts_node(tmp_path, monkeypatch):
    """They are different things and must not be merged back: the machine id
    names the physical machine, a node names it inside one account. Merging them
    is the bug this whole split exists to remove."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    legacy = device_identity.device_id()
    machine = device_identity.machine_id()
    device_identity.claim_node_id("m-first", legacy)
    second = device_identity.node_id_for("m-second")
    device_identity.claim_node_id("m-second", second)

    # Seeded from the legacy id, so a machine that has been running for months
    # stays recognisably the same machine.
    assert machine == legacy
    assert device_identity.machine_id() == machine, "and it never moves"
    doc = json.loads(device_identity.device_identity_path().read_text(encoding="utf-8"))
    assert doc["machine_id"] == machine
    assert set(doc["nodes"]) == {"m-first", "m-second"}


def test_local_addressing_still_asks_about_the_machine(tmp_path, monkeypatch):
    """`device_id()` is still the answer for everything not talking to a server.
    "Is this address segment this machine" has nothing to do with which account
    is signed in, and making it per-account would break addressing that works."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    legacy = device_identity.device_id()
    device_identity.claim_node_id("m-first", legacy)
    device_identity.claim_node_id("m-second", device_identity.fresh_node_id())

    assert device_identity.device_id() == legacy
