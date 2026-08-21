from __future__ import annotations

import hashlib

from fastapi.testclient import TestClient

from tests.conftest import SignedEnv
from tests.fixtures import build_package, valid_manifest


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _publish(env: SignedEnv, data: bytes, *, signature=None, token=None):
    params = {"signature": signature} if signature else None
    headers = {"Authorization": f"Bearer {token or env.token}"}
    return env.client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
        params=params,
        headers=headers,
    )


# -- signature gate -----------------------------------------------------
def test_signed_publish_accepted_and_trusted(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(data))
    resp = _publish(signed_env, data, signature=sig)
    assert resp.status_code == 201, resp.text

    detail = signed_env.client.get("/api/extensions/acme/hello").json()
    version = detail["versions"][0]
    assert version["signed"] is True
    assert version["trust_tier"] == "signed-verified"
    assert version["capabilities"] == ["fs", "ui"]
    assert version["sensitive_capabilities"] == ["fs"]
    # Client trust is rooted in registry metadata, never the publisher key.
    assert version["registry_signature"]
    assert version["registry_envelope"]["publisherId"] == "acme"
    assert "public_key" not in detail


def test_unsigned_publish_rejected_when_required(signed_env: SignedEnv) -> None:
    resp = _publish(signed_env, build_package())
    assert resp.status_code == 403
    assert "signature is required" in resp.json()["detail"]


def test_tampered_signature_rejected(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(b"different bytes"))
    resp = _publish(signed_env, data, signature=sig)
    assert resp.status_code == 403
    assert "invalid package signature" in resp.json()["detail"]


# -- publisher auth -----------------------------------------------------
def test_missing_token_rejected(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(data))
    resp = signed_env.client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
        params={"signature": sig},
    )
    assert resp.status_code == 401


def test_bad_token_rejected(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(data))
    resp = _publish(signed_env, data, signature=sig, token="wrong-token")
    assert resp.status_code == 401


def test_cross_namespace_publish_rejected(signed_env: SignedEnv) -> None:
    # acme's token publishing under the 'beta' namespace.
    data = build_package(manifest=valid_manifest(id="beta.notes", publisher="beta"))
    sig = signed_env.sign(_digest(data))
    resp = _publish(signed_env, data, signature=sig)
    assert resp.status_code == 403
    assert "not entitled" in resp.json()["detail"]


# -- yank auth ----------------------------------------------------------
def test_owner_can_yank_nonowner_cannot(signed_env: SignedEnv) -> None:
    data = build_package()
    sig = signed_env.sign(_digest(data))
    assert _publish(signed_env, data, signature=sig).status_code == 201

    # Register a second publisher and try to yank acme's version.
    signed_env.client.post(
        "/api/publishers",
        json={"name": "beta", "token": "tok-beta"},
        headers={"X-Admin-Token": "official-admin-token"},
    )
    intruder = signed_env.client.post(
        "/api/extensions/acme/hello/1.0.0/yank",
        headers={"Authorization": "Bearer tok-beta"},
    )
    assert intruder.status_code == 403

    owner = signed_env.client.post(
        "/api/extensions/acme/hello/1.0.0/yank",
        headers={"Authorization": f"Bearer {signed_env.token}"},
    )
    assert owner.status_code == 200
    assert owner.json()["yanked"] is True


# -- registration admin gate --------------------------------------------
def test_registration_admin_gate(tmp_path) -> None:
    from registry.app import create_app
    from registry.config import VERIFIER_ED25519, Settings

    settings = Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ED25519,
        admin_token="admin-secret",
    )
    client = TestClient(create_app(settings))

    denied = client.post("/api/publishers", json={"name": "acme"})
    assert denied.status_code == 401

    allowed = client.post(
        "/api/publishers",
        json={"name": "acme", "token": "t"},
        headers={"X-Admin-Token": "admin-secret"},
    )
    assert allowed.status_code == 201
    assert allowed.json()["has_token"] is True


def test_official_profile_keeps_publisher_registration_admin_gated(
    signed_env: SignedEnv,
) -> None:
    denied = signed_env.client.post(
        "/api/publishers",
        json={"name": "beta", "token": "tok-beta"},
    )
    assert denied.status_code == 401

    wrong = signed_env.client.post(
        "/api/publishers",
        json={"name": "beta", "token": "tok-beta"},
        headers={"X-Admin-Token": "wrong-admin-token"},
    )
    assert wrong.status_code == 401
