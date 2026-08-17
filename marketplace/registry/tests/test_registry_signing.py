from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import replace
from datetime import datetime, timezone

from fastapi.testclient import TestClient
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
import pytest

from registry.app import create_app
from registry.config import Settings, TrustedSignerConfig
from registry.registry_trust import RegistryTrustSigner
from registry.signing import (
    generate_keypair,
    load_or_create_private_key,
    public_key_fingerprint,
)
from tests.conftest import SignedEnv
from tests.fixtures import build_package


def _canonical_json(value: dict) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _verify(public_key_pem: str, value: dict, signature: str) -> None:
    public_key = serialization.load_pem_public_key(public_key_pem.encode("ascii"))
    assert isinstance(public_key, Ed25519PublicKey)
    public_key.verify(base64.b64decode(signature), _canonical_json(value))


def test_registry_signs_artifact_envelope_and_root_signs_trust_metadata(
    signed_env: SignedEnv,
) -> None:
    package = build_package()
    publisher_signature = signed_env.sign(hashlib.sha256(package).hexdigest())
    published = signed_env.client.post(
        "/api/publish",
        params={"signature": publisher_signature, "target": "darwin-arm64"},
        files={"package": ("plugin.vsix", package, "application/zip")},
        headers={"Authorization": f"Bearer {signed_env.token}"},
    )
    assert published.status_code == 201, published.text

    detail = signed_env.client.get("/api/extensions/acme/hello").json()
    assert "public_key" not in detail
    version = detail["versions"][0]
    assert version["target"] == "darwin-arm64"
    envelope = version["registry_envelope"]
    assert envelope == {
        "schemaVersion": 1,
        "artifactDigest": version["package_digest"],
        "packageId": "acme.hello",
        "version": "1.0.0",
        "target": "darwin-arm64",
        "publisherId": "acme",
        "keyId": "registry-2026-01",
        "signedAt": envelope["signedAt"],
    }
    _verify(
        signed_env.registry_signer_public_pem,
        envelope,
        version["registry_signature"],
    )

    trust = detail["trust_metadata"]
    assert trust["schemaVersion"] == 1
    assert trust["registryProfile"] == "official"
    assert trust["rootFingerprint"] == public_key_fingerprint(
        signed_env.root_public_pem
    )
    assert trust["signers"] == [
        {
            "keyId": "registry-2026-01",
            "publicKey": signed_env.registry_signer_public_pem,
            "status": "active",
            "notBefore": trust["signers"][0]["notBefore"],
            "notAfter": trust["signers"][0]["notAfter"],
        }
    ]
    assert trust["blockedPublishers"] == ["blocked-publisher"]
    assert trust["blockedPackages"] == [
        {"packageId": "blocked.package", "version": "1.0.0"},
        {"packageId": "blocked.all"},
    ]
    _verify(signed_env.root_public_pem, trust, detail["trust_metadata_signature"])


def test_publisher_supplied_key_is_not_a_client_trust_root(
    signed_env: SignedEnv,
) -> None:
    package = build_package()
    publisher_signature = signed_env.sign(hashlib.sha256(package).hexdigest())
    response = signed_env.client.post(
        "/api/publish",
        params={"signature": publisher_signature},
        files={"package": ("plugin.vsix", package, "application/zip")},
        headers={"Authorization": f"Bearer {signed_env.token}"},
    )
    assert response.status_code == 201, response.text

    detail = signed_env.client.get("/api/extensions/acme/hello").json()
    wire = json.dumps(detail)
    assert signed_env.public_pem not in wire
    signer = detail["trust_metadata"]["signers"][0]
    assert signer["publicKey"] == signed_env.registry_signer_public_pem


@pytest.mark.parametrize("status", ["expired", "revoked"])
def test_ineligible_registry_signer_cannot_sign_new_artifacts(
    tmp_path, status: str
) -> None:
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                require_signature=False,
                require_auth=False,
                signer_status=status,
            )
        )
    )
    response = client.post(
        "/api/publish",
        files={"package": ("plugin.vsix", build_package(), "application/zip")},
    )
    assert response.status_code == 503
    assert response.json()["detail"] == f"registry signer is {status}"


def test_invalid_target_is_rejected_before_publish(tmp_path) -> None:
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                require_signature=False,
                require_auth=False,
            )
        )
    )
    response = client.post(
        "/api/publish",
        params={"target": "darwin/arm64"},
        files={"package": ("plugin.vsix", build_package(), "application/zip")},
    )
    assert response.status_code == 422


def test_blocked_publisher_is_rejected_before_registry_signing(tmp_path) -> None:
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                require_signature=False,
                require_auth=False,
                blocked_publishers=("acme",),
            )
        )
    )
    response = client.post(
        "/api/publish",
        files={"package": ("plugin.vsix", build_package(), "application/zip")},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "publisher is blocked"


def test_blocked_package_version_is_rejected_before_registry_signing(tmp_path) -> None:
    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path,
                require_signature=False,
                require_auth=False,
                blocked_packages=("acme.hello@1.0.0",),
            )
        )
    )
    response = client.post(
        "/api/publish",
        files={"package": ("plugin.vsix", build_package(), "application/zip")},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "package version is blocked"


def test_local_registry_trust_lifecycle_survives_restart(tmp_path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        require_signature=False,
        require_auth=False,
    )

    first = RegistryTrustSigner.from_settings(settings)
    second = RegistryTrustSigner.from_settings(settings)

    assert second.key_id == first.key_id
    assert second.signer_public_key == first.signer_public_key
    assert second.root_fingerprint == first.root_fingerprint
    assert second.not_before == first.not_before
    assert second.not_after == first.not_after
    state = json.loads(
        (tmp_path / "trust" / "registry-state.json").read_text(encoding="utf-8")
    )
    assert state["signers"]["registry-local-1"]["status"] == "active"

    metadata, _ = second.signed_metadata()
    assert metadata["registryProfile"] == "self-hosted-dev"
    assert metadata["rootFingerprint"] == second.root_fingerprint

    revoked = RegistryTrustSigner.from_settings(
        replace(settings, signer_status="revoked")
    )
    assert revoked.not_before == first.not_before
    state = json.loads(
        (tmp_path / "trust" / "registry-state.json").read_text(encoding="utf-8")
    )
    assert state["signers"]["registry-local-1"]["status"] == "revoked"


def test_generated_private_key_is_owner_only(tmp_path) -> None:
    path = tmp_path / "private.pem"

    load_or_create_private_key(path)

    assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize("kind", ["symlink", "directory", "group-readable"])
def test_private_key_reads_reject_unsafe_files(tmp_path, kind: str) -> None:
    path = tmp_path / "private.pem"
    if kind == "symlink":
        target = tmp_path / "target.pem"
        target.write_text("not a key", encoding="ascii")
        target.chmod(0o600)
        path.symlink_to(target)
    elif kind == "directory":
        path.mkdir()
    else:
        path.write_text("not a key", encoding="ascii")
        path.chmod(0o640)

    with pytest.raises(ValueError, match="regular|owner-only|symlink"):
        load_or_create_private_key(path)


def test_rotating_and_revoked_signers_are_published_in_root_signed_metadata(
    tmp_path,
) -> None:
    signer_private, _ = generate_keypair()
    root_private, _ = generate_keypair()
    _, old_public = generate_keypair()
    _, revoked_public = generate_keypair()
    settings = Settings(
        data_dir=tmp_path,
        require_signature=False,
        require_auth=False,
        registry_signer_private_key=signer_private,
        registry_signer_key_id="registry-2026-02",
        root_private_key=root_private,
        signer_not_before=datetime(2026, 8, 1, tzinfo=timezone.utc),
        signer_not_after=datetime(2027, 8, 1, tzinfo=timezone.utc),
        trusted_signers=(
            TrustedSignerConfig(
                key_id="registry-2026-01",
                public_key=old_public,
                status="rotating",
                not_before=datetime(2025, 8, 1, tzinfo=timezone.utc),
                not_after=datetime(2026, 9, 1, tzinfo=timezone.utc),
            ),
            TrustedSignerConfig(
                key_id="registry-compromised",
                public_key=revoked_public,
                status="revoked",
                not_before=datetime(2025, 1, 1, tzinfo=timezone.utc),
                not_after=datetime(2026, 1, 1, tzinfo=timezone.utc),
            ),
        ),
    )

    signer = RegistryTrustSigner.from_settings(settings)
    metadata, _ = signer.signed_metadata(datetime(2026, 8, 16, tzinfo=timezone.utc))

    assert [(entry["keyId"], entry["status"]) for entry in metadata["signers"]] == [
        ("registry-2026-02", "active"),
        ("registry-2026-01", "rotating"),
        ("registry-compromised", "revoked"),
    ]
