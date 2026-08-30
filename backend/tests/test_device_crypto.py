"""The sealed box that keeps the relay out of cross-device messages."""

from __future__ import annotations

import base64
import json
import os
import stat

import pytest

from agent_team_backend import device_crypto
from agent_team_backend.device_crypto import CryptoError

A = "dev-alice"
B = "dev-bob"


@pytest.fixture(autouse=True)
def _isolated_keys(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))
    device_crypto._reset_for_test()
    yield
    device_crypto._reset_for_test()


def _peer(tmp_path, monkeypatch, name):
    """A second device: its own data dir, so its own key file."""
    home = tmp_path / name
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(home))
    return device_crypto.public_key()


# ---- keys --------------------------------------------------------------------


def test_a_key_is_generated_once_and_reused() -> None:
    first = device_crypto.public_key()
    assert device_crypto.public_key() == first
    assert device_crypto.is_public_key(first)


def test_the_private_key_is_owner_only_on_disk() -> None:
    device_crypto.public_key()
    mode = stat.S_IMODE(os.stat(device_crypto.keys_path()).st_mode)
    assert mode == 0o600, oct(mode)


def test_an_unusable_key_file_is_replaced_rather_than_fatal() -> None:
    """The backend has to start. A corrupt file costs a new identity, which is
    logged, not a process that will not boot."""
    device_crypto.public_key()
    device_crypto.keys_path().write_text("{ this is not json", encoding="utf-8")
    assert device_crypto.is_public_key(device_crypto.public_key())


def test_a_truncated_key_file_is_replaced() -> None:
    device_crypto.public_key()
    device_crypto.keys_path().write_text("", encoding="utf-8")
    assert device_crypto.is_public_key(device_crypto.public_key())


def test_the_private_key_never_appears_in_the_published_key() -> None:
    published = device_crypto.public_key()
    stored = json.loads(device_crypto.keys_path().read_text(encoding="utf-8"))
    assert stored["x25519_private"] != published


@pytest.mark.parametrize(
    "value", [None, "", 7, [], "not base64!!", base64.b64encode(b"short").decode()]
)
def test_a_key_that_could_not_be_used_is_refused_up_front(value) -> None:
    assert device_crypto.is_public_key(value) is False


# ---- sealing -----------------------------------------------------------------


def test_a_message_round_trips(tmp_path, monkeypatch) -> None:
    mine = tmp_path / "mine"
    mine.mkdir()
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(mine))
    my_key = device_crypto.public_key()

    # The sender is a different machine and needs nothing but that public key.
    _peer(tmp_path, monkeypatch, "sender")
    wire = device_crypto.seal("請幫我看一下結帳頁", recipient_public_key=my_key, from_device=A, to_device=B)

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(mine))
    assert device_crypto.open_sealed(wire, from_device=A, to_device=B) == "請幫我看一下結帳頁"


def test_the_relay_sees_nothing_of_the_message(tmp_path, monkeypatch) -> None:
    """The whole point: what goes on the wire must not contain the text."""
    key = device_crypto.public_key()
    wire = device_crypto.seal("deploy the payment fix", recipient_public_key=key, from_device=A, to_device=B)
    assert "deploy" not in wire
    assert b"deploy" not in base64.b64decode(wire)


def test_every_message_uses_a_fresh_ephemeral_key(tmp_path, monkeypatch) -> None:
    """Two identical messages must not produce identical ciphertext, or the
    relay could tell that the same thing was said twice."""
    key = device_crypto.public_key()
    kw = {"recipient_public_key": key, "from_device": A, "to_device": B}
    assert device_crypto.seal("same", **kw) != device_crypto.seal("same", **kw)


def test_a_ciphertext_cannot_be_redirected_to_another_device(tmp_path, monkeypatch) -> None:
    """The server routes by device id, so without binding it could hand this
    ciphertext to a different machine and nobody would notice."""
    key = device_crypto.public_key()
    wire = device_crypto.seal("for bob only", recipient_public_key=key, from_device=A, to_device=B)
    with pytest.raises(CryptoError):
        device_crypto.open_sealed(wire, from_device=A, to_device="dev-carol")
    with pytest.raises(CryptoError):
        device_crypto.open_sealed(wire, from_device="dev-mallory", to_device=B)


def test_a_message_sealed_for_a_previous_key_will_not_open(tmp_path, monkeypatch) -> None:
    """A device that rotated its key must not be served old ciphertext as if
    nothing happened."""
    old_key = device_crypto.public_key()
    wire = device_crypto.seal("before rotation", recipient_public_key=old_key, from_device=A, to_device=B)
    device_crypto._reset_for_test()
    assert device_crypto.public_key() != old_key
    with pytest.raises(CryptoError):
        device_crypto.open_sealed(wire, from_device=A, to_device=B)


def test_tampering_is_refused(tmp_path, monkeypatch) -> None:
    key = device_crypto.public_key()
    wire = device_crypto.seal("original", recipient_public_key=key, from_device=A, to_device=B)
    blob = bytearray(base64.b64decode(wire))
    blob[-1] ^= 0x01
    with pytest.raises(CryptoError):
        device_crypto.open_sealed(base64.b64encode(bytes(blob)).decode(), from_device=A, to_device=B)


@pytest.mark.parametrize("junk", ["", "!!!", "AAAA", base64.b64encode(b"x" * 40).decode()])
def test_garbage_is_refused_without_a_stack_trace(junk) -> None:
    with pytest.raises(CryptoError):
        device_crypto.open_sealed(junk, from_device=A, to_device=B)


def test_sealing_without_a_key_raises_instead_of_returning_the_text() -> None:
    """A caller that read a failure as 'send it as it is' would turn every edge
    case into a silent downgrade to plaintext."""
    for bad in ("", None, "not-a-key"):
        with pytest.raises(CryptoError):
            device_crypto.seal("secret", recipient_public_key=bad, from_device=A, to_device=B)


def test_failures_never_carry_key_material() -> None:
    key = device_crypto.public_key()
    wire = device_crypto.seal("x", recipient_public_key=key, from_device=A, to_device=B)
    with pytest.raises(CryptoError) as err:
        device_crypto.open_sealed(wire, from_device=A, to_device="somebody-else")
    assert str(err.value) == "could not open the message"


def test_unicode_survives_the_round_trip() -> None:
    key = device_crypto.public_key()
    text = "修結帳頁閃退 🚀 — naïve façade"
    wire = device_crypto.seal(text, recipient_public_key=key, from_device=A, to_device=B)
    assert device_crypto.open_sealed(wire, from_device=A, to_device=B) == text
