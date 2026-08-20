from __future__ import annotations

import zipfile
from io import BytesIO

from fastapi.testclient import TestClient

from tests.fixtures import (
    build_package,
    build_v2_package,
    contract_manifest,
    valid_manifest,
)


def _publish(client: TestClient, data: bytes, signature: str | None = None):
    params = {"signature": signature} if signature else None
    return client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
        params=params,
    )


def test_health(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_publish_new_version(client: TestClient) -> None:
    resp = _publish(client, build_package())
    assert resp.status_code == 201
    body = resp.json()
    assert body["namespace"] == "acme"
    assert body["name"] == "hello"
    assert body["version"] == "1.0.0"
    assert len(body["package_digest"]) == 64


def test_publish_manifest_v2_maps_marketplace_metadata(client: TestClient) -> None:
    resp = _publish(client, build_v2_package())
    assert resp.status_code == 201

    detail = client.get("/api/extensions/acme/files").json()
    assert detail["display_name"] == "Files"
    assert detail["description"] == (
        "Browse workspace files in workbench regions or a separate window."
    )
    assert detail["categories"] == ["productivity"]
    assert detail["versions"][0]["capabilities"] == ["fs", "ui", "shell"]
    assert detail["versions"][0]["sensitive_capabilities"] == ["fs", "shell"]


def test_publish_query_and_download_support_multi_segment_package_ids(client: TestClient) -> None:
    manifest = contract_manifest()
    manifest["id"] = "acme.tools.linter"
    manifest["publisher"] = "acme"
    package = build_v2_package(manifest)
    response = _publish(client, package)
    assert response.status_code == 201
    assert response.json()["name"] == "tools.linter"

    detail = client.get("/api/extensions/acme/tools.linter").json()
    assert detail["identity"] == "acme.tools.linter"
    version = str(manifest["version"])
    assert client.get(f"/api/extensions/acme/tools.linter/{version}/download").content == package


def test_publish_rejects_malformed(client: TestClient) -> None:
    resp = _publish(client, b"garbage")
    assert resp.status_code == 400


def test_publish_duplicate_version_rejected(client: TestClient) -> None:
    assert _publish(client, build_package()).status_code == 201
    dup = _publish(client, build_package())
    assert dup.status_code == 409
    assert "already exists" in dup.json()["detail"]


def test_publish_records_signature(client: TestClient) -> None:
    assert _publish(client, build_package(), signature="sig-abc").status_code == 201
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["versions"][0]["signed"] is True


def test_extension_detail_lists_versions(client: TestClient) -> None:
    _publish(client, build_package(manifest=valid_manifest(version="1.0.0")))
    _publish(client, build_package(manifest=valid_manifest(version="1.2.0")))
    resp = client.get("/api/extensions/acme/hello")
    assert resp.status_code == 200
    body = resp.json()
    assert body["publisher"] == "acme"
    assert body["latest_version"] == "1.2.0"
    versions = {v["version"] for v in body["versions"]}
    assert versions == {"1.0.0", "1.2.0"}


def test_extension_detail_resolves_semver_prerelease_versions(client: TestClient) -> None:
    older = contract_manifest()
    older["version"] = "1.2.3-0.3.7"
    newer = contract_manifest()
    newer["version"] = "1.2.3-0.3.8"
    assert _publish(client, build_v2_package(older)).status_code == 201
    assert _publish(client, build_v2_package(newer)).status_code == 201

    resp = client.get("/api/extensions/acme/files")
    assert resp.status_code == 200
    assert resp.json()["latest_version"] == "1.2.3-0.3.8"


def test_detail_404(client: TestClient) -> None:
    assert client.get("/api/extensions/acme/ghost").status_code == 404


def test_list_and_search(client: TestClient) -> None:
    _publish(client, build_package(manifest=valid_manifest(id="acme.hello")))
    _publish(
        client,
        build_package(
            manifest=valid_manifest(
                id="beta.notes",
                publisher="beta",
                description="take markdown notes",
                categories=["writing"],
            )
        ),
    )
    all_resp = client.get("/api/extensions").json()
    assert all_resp["total"] == 2
    assert len(all_resp["items"]) == 2

    hit = client.get("/api/extensions", params={"q": "markdown"}).json()
    assert hit["total"] == 1
    assert hit["items"][0]["identity"] == "beta.notes"

    by_category = client.get("/api/extensions", params={"q": "writing"}).json()
    assert by_category["total"] == 1

    miss = client.get("/api/extensions", params={"q": "nonexistent"}).json()
    assert miss["total"] == 0


def test_pagination(client: TestClient) -> None:
    for i in range(5):
        _publish(
            client,
            build_package(manifest=valid_manifest(id=f"acme.p{i}")),
        )
    page = client.get("/api/extensions", params={"limit": 2, "offset": 0}).json()
    assert page["total"] == 5
    assert len(page["items"]) == 2
    page2 = client.get("/api/extensions", params={"limit": 2, "offset": 4}).json()
    assert len(page2["items"]) == 1


def test_download_roundtrip(client: TestClient) -> None:
    original = build_package()
    _publish(client, original)
    resp = client.get("/api/extensions/acme/hello/1.0.0/download")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert resp.content == original
    # Downloaded bytes are a valid archive with the manifest inside.
    with zipfile.ZipFile(BytesIO(resp.content)) as zf:
        assert "manifest.json" in zf.namelist()


def test_download_missing_version_404(client: TestClient) -> None:
    _publish(client, build_package())
    assert (
        client.get("/api/extensions/acme/hello/9.9.9/download").status_code == 404
    )


def test_yank_excludes_from_latest_but_keeps_download(client: TestClient) -> None:
    _publish(client, build_package(manifest=valid_manifest(version="1.0.0")))
    _publish(client, build_package(manifest=valid_manifest(version="2.0.0")))

    yank = client.post("/api/extensions/acme/hello/2.0.0/yank")
    assert yank.status_code == 200
    assert yank.json()["yanked"] is True

    detail = client.get("/api/extensions/acme/hello").json()
    # Latest resolution excludes the yanked version.
    assert detail["latest_version"] == "1.0.0"
    yanked = {v["version"]: v["yanked"] for v in detail["versions"]}
    assert yanked["2.0.0"] is True

    # Still downloadable by exact version.
    dl = client.get("/api/extensions/acme/hello/2.0.0/download")
    assert dl.status_code == 200


def test_yank_missing_404(client: TestClient) -> None:
    assert client.post("/api/extensions/acme/hello/1.0.0/yank").status_code == 404
