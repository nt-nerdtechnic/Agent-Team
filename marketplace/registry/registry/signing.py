"""Publisher-submission verification and registry Ed25519 signing primitives.

Publisher signatures authenticate submissions but are not a Client trust root.
Accepted artifacts are signed by a registry-owned signer, and signer status is
distributed in metadata signed by the configured registry root.

`AcceptingSignatureVerifier` is retained for dev/tests and applies only to the
publisher-submission gate; `Ed25519SignatureVerifier` is the real default.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Protocol, runtime_checkable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


@runtime_checkable
class SignatureVerifier(Protocol):
    def verify(
        self, *, digest: str, signature: str | None, public_key: str | None
    ) -> bool:
        """Return True if `signature` is valid over `digest` for `public_key`."""
        ...


class AcceptingSignatureVerifier:
    """Dev/test verifier: trusts any signature. Selected via config only."""

    def verify(
        self, *, digest: str, signature: str | None, public_key: str | None
    ) -> bool:
        return True


class Ed25519SignatureVerifier:
    """Verifies a detached Ed25519 signature over the package digest."""

    def verify(
        self, *, digest: str, signature: str | None, public_key: str | None
    ) -> bool:
        if not signature or not public_key:
            return False
        try:
            pub = _load_public_key(public_key)
            raw = base64.b64decode(signature, validate=True)
        except (ValueError, TypeError):
            return False
        try:
            pub.verify(raw, digest.encode("ascii"))
        except InvalidSignature:
            return False
        return True


# -- key + signing helpers (used by the CLI and registration) -----------
def generate_keypair() -> tuple[str, str]:
    """Return (private_key_pem, public_key_pem) for a fresh Ed25519 keypair."""
    private = Ed25519PrivateKey.generate()
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    public_pem = private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return private_pem, public_pem


def sign_digest(private_key_pem: str, digest: str) -> str:
    """Sign a hex digest with a PEM private key; return a base64 signature."""
    private = serialization.load_pem_private_key(
        private_key_pem.encode("ascii"), password=None
    )
    if not isinstance(private, Ed25519PrivateKey):
        raise ValueError("private key is not an Ed25519 key")
    return base64.b64encode(private.sign(digest.encode("ascii"))).decode("ascii")


def canonical_json(value: dict) -> bytes:
    """Encode signed registry objects with recursively sorted UTF-8 JSON keys."""
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sign_json(private_key_pem: str, value: dict) -> str:
    """Return a detached Ed25519 signature over canonical JSON."""
    private = serialization.load_pem_private_key(
        private_key_pem.encode("ascii"), password=None
    )
    if not isinstance(private, Ed25519PrivateKey):
        raise ValueError("private key is not an Ed25519 key")
    return base64.b64encode(private.sign(canonical_json(value))).decode("ascii")


def public_key_from_private(private_key_pem: str) -> str:
    private = serialization.load_pem_private_key(
        private_key_pem.encode("ascii"), password=None
    )
    if not isinstance(private, Ed25519PrivateKey):
        raise ValueError("private key is not an Ed25519 key")
    return private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")


def public_key_fingerprint(public_key_pem: str) -> str:
    """Return a stable sha256 fingerprint of an Ed25519 SPKI public key."""
    public_key = _load_public_key(public_key_pem)
    der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return f"sha256:{hashlib.sha256(der).hexdigest()}"


def _validate_private_key_stat(path: Path, info: os.stat_result) -> None:
    if stat.S_ISLNK(info.st_mode):
        raise ValueError(f"private key path is a symlink: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"private key path is not a regular file: {path}")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError(f"private key file must have owner-only permissions: {path}")


def read_private_key_file(path: Path) -> str:
    """Read an existing owner-only regular private-key file."""
    try:
        _validate_private_key_stat(path, path.lstat())
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise ValueError(f"private key path cannot be inspected: {path}") from exc

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise ValueError(f"private key path cannot be opened: {path}") from exc
    try:
        _validate_private_key_stat(path, os.fstat(fd))
        with os.fdopen(fd, "r", encoding="ascii") as stream:
            fd = -1
            return stream.read()
    except (OSError, UnicodeError) as exc:
        raise ValueError(f"private key file cannot be read: {path}") from exc
    finally:
        if fd >= 0:
            os.close(fd)


def load_or_create_private_key(path: Path) -> str:
    """Load a registry-owned key, creating it with owner-only access once."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        return read_private_key_file(path)
    except FileNotFoundError:
        pass

    private_pem, _ = generate_keypair()
    try:
        fd = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError:
        return read_private_key_file(path)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as stream:
            fd = -1
            stream.write(private_pem)
    finally:
        if fd >= 0:
            os.close(fd)
    return private_pem


def _load_public_key(public_key_pem: str) -> Ed25519PublicKey:
    pub = serialization.load_pem_public_key(public_key_pem.encode("ascii"))
    if not isinstance(pub, Ed25519PublicKey):
        raise ValueError("public key is not an Ed25519 key")
    return pub
