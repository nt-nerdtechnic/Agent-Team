"""End-to-end encryption for cross-device messages.

Until now a message to another machine travelled through the server as
plaintext: ``messages.send`` wrote the text straight into a table, so the relay
could read everything it carried. That is the one thing Tailscale's DERP
deliberately cannot do — it forwards packets it has no key for — and it is the
gap that has to close *before* a direct path exists, not after. Once some
messages go direct and some go relayed, "was this one encrypted?" becomes a
question the user cannot answer, and that is a worse position than today's
honest "none of them are".

The scheme is a sealed box: the sender needs only the recipient's long-term
public key, and every message gets a fresh ephemeral keypair.

    ephemeral X25519 keypair  ─┐
                               ├─ ECDH ─→ HKDF-SHA256 ─→ 32-byte key
    recipient's public key   ──┘                              │
                                                              ▼
                                        AES-256-GCM(nonce, plaintext, aad)

    wire := b64( ephemeral_pub[32] || nonce[12] || ciphertext+tag )

Three properties worth naming, because each is a decision rather than a default:

*Forward secrecy for the sender half.* The ephemeral private key is discarded
the moment the message is sealed, so a sender's stored state cannot decrypt
what it has already sent. The recipient's long-term key can, which is the
asymmetry a sealed box is: it exists so the sender needs no key of its own and
no handshake — and a handshake is exactly what a store-and-forward relay cannot
carry.

*The recipient is bound into the ciphertext.* Both device ids and the
recipient's public key go in as AEAD associated data, so a ciphertext lifted
from one message cannot be replayed as a message to somebody else — the
server, which routes by device id, would otherwise be able to redirect one.

*No key means no encryption, and that is a decision the caller makes.* This
module never silently falls back to plaintext: ``seal`` requires a key. The
caller decides what to do when a peer has published none, and ``server_link``
refuses to fall back for any peer it has ever seen a key for.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import stat
import threading
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from agent_team_backend.applog import app_data_dir

log = logging.getLogger(__name__)

KEYS_FILENAME = "device-keys.json"

#: Domain separation for the KDF. Changing it makes every existing ciphertext
#: undecryptable, which is why it is a constant and not a parameter.
_HKDF_INFO = b"navide/cross-device-message/v1"

_PUB_LEN = 32
_NONCE_LEN = 12

_lock = threading.Lock()


class CryptoError(Exception):
    """A message could not be sealed or opened. Never carries key material."""


# ---- key material ------------------------------------------------------------


def keys_path() -> Path:
    return app_data_dir() / KEYS_FILENAME


def _write_private(path: Path, raw: bytes) -> None:
    """Write the key file and take the permissions down to owner-only.

    Written to a temporary file and moved into place: a reader that opened the
    file between truncate and write would otherwise see an empty key and this
    machine would generate a new identity for itself.
    """
    payload = json.dumps({"x25519_private": base64.b64encode(raw).decode("ascii")})
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    # 模式在建立時就給，不是寫完再 chmod。兩者之間那一段時間裡，檔案的權限由
    # umask 決定——私鑰在那個窗裡可能是全體可讀，而它已經有內容了。
    # ws_auth.issue_token 是同一個做法，理由也一樣。
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
    try:
        os.write(fd, payload.encode("utf-8"))
    finally:
        os.close(fd)
    # O_CREAT 不會改動既有檔案的權限，所以殘留的 .tmp 仍要收一次。
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    tmp.replace(path)


def _load_private() -> X25519PrivateKey:
    """This device's long-term private key, generating one on first use.

    A missing, empty or unparseable file is regenerated rather than fatal — the
    backend has to start — but every generation is logged, because to a peer a
    new key means messages it sealed for the old one can no longer be opened.
    """
    path = keys_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        material = base64.b64decode(raw["x25519_private"], validate=True)
        return X25519PrivateKey.from_private_bytes(material)
    except FileNotFoundError:
        pass
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log.warning("device key file %s is unusable (%s); generating a new one", path, exc)

    key = X25519PrivateKey.generate()
    _write_private(
        path,
        key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        ),
    )
    log.info("generated a new device message key at %s", path)
    return key


def private_key() -> X25519PrivateKey:
    """Serialised because two connections authenticating at once would
    otherwise race to create the file and one of them would win silently."""
    with _lock:
        return _load_private()


def public_key() -> str:
    """This device's public key, base64, for publishing to the server."""
    raw = private_key().public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return base64.b64encode(raw).decode("ascii")


def is_public_key(value: Any) -> bool:
    """Whether *value* is something ``seal`` could use. Remote-authored, so the
    check is on the shape rather than on trust."""
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(base64.b64decode(value, validate=True)) == _PUB_LEN
    except (ValueError, TypeError):
        return False


# ---- the sealed box ----------------------------------------------------------


def _aad(from_device: str, to_device: str, recipient_public_key: str) -> bytes:
    """What the ciphertext is bound to.

    The server routes by device id, so without this it could hand a ciphertext
    addressed to one device to another one and the recipient would have no way
    to notice. Including the recipient's key as well means a device that
    rotated its key cannot be served a message sealed for its previous one.
    """
    return json.dumps(
        {"from": from_device, "to": to_device, "key": recipient_public_key},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _derive(shared: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=_HKDF_INFO).derive(shared)


def seal(text: str, *, recipient_public_key: str, from_device: str, to_device: str) -> str:
    """Encrypt *text* for one device. Returns the base64 wire form.

    Raises CryptoError rather than returning the plaintext on any failure: a
    caller that treated a failed encryption as "send it as it is" would turn
    every edge case into a silent downgrade.
    """
    if not is_public_key(recipient_public_key):
        raise CryptoError("recipient has no usable public key")
    try:
        peer = X25519PublicKey.from_public_bytes(base64.b64decode(recipient_public_key))
        ephemeral = X25519PrivateKey.generate()
        key = _derive(ephemeral.exchange(peer))
        nonce = os.urandom(_NONCE_LEN)
        blob = AESGCM(key).encrypt(
            nonce, text.encode("utf-8"), _aad(from_device, to_device, recipient_public_key)
        )
        ephemeral_pub = ephemeral.public_key().public_bytes(
            encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
        )
        return base64.b64encode(ephemeral_pub + nonce + blob).decode("ascii")
    except CryptoError:
        raise
    except Exception as exc:  # noqa: BLE001 - never leak the reason to the wire
        raise CryptoError("could not seal the message") from exc


def open_sealed(wire: str, *, from_device: str, to_device: str) -> str:
    """Decrypt what ``seal`` produced, using this device's private key.

    Every failure is the same exception with the same message. The distinction
    between "malformed", "not for me" and "tampered with" is useful in a log and
    is an oracle on the wire, which is the same reason the delivery path answers
    a blocked sender exactly as it answers an unauthorized one.
    """
    try:
        blob = base64.b64decode(wire, validate=True)
    except (ValueError, TypeError) as exc:
        raise CryptoError("could not open the message") from exc
    if len(blob) < _PUB_LEN + _NONCE_LEN + 16:
        raise CryptoError("could not open the message")

    ephemeral_pub = blob[:_PUB_LEN]
    nonce = blob[_PUB_LEN : _PUB_LEN + _NONCE_LEN]
    ciphertext = blob[_PUB_LEN + _NONCE_LEN :]
    try:
        mine = private_key()
        key = _derive(mine.exchange(X25519PublicKey.from_public_bytes(ephemeral_pub)))
        aad = _aad(from_device, to_device, public_key())
        return AESGCM(key).decrypt(nonce, ciphertext, aad).decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        raise CryptoError("could not open the message") from exc


def _reset_for_test() -> None:
    """Drop this process's key file. Tests set AGENT_TEAM_DATA_DIR, so this only
    ever touches a temporary directory."""
    with _lock:
        keys_path().unlink(missing_ok=True)
