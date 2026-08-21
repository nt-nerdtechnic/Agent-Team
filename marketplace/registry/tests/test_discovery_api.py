"""Tests for the p3-discovery data additions on the JSON API:
download counter, ratings, featured flag, category filter + sort.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.fixtures import build_package, valid_manifest


def _publish(client: TestClient, data: bytes):
    return client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
    )


def _publish_ext(client: TestClient, ident: str, **manifest_kw):
    ns, name = ident.split(".", 1)
    manifest = valid_manifest(id=ident, publisher=ns, **manifest_kw)
    return _publish(client, build_package(manifest=manifest))


def test_detail_uses_registry_signing_even_without_publisher_signature(
    client: TestClient,
) -> None:
    # Permissive dev mode may accept an unsigned publisher submission, but the
    # artifact exposed to clients is still signed by the registry.
    _publish(client, build_package())
    detail = client.get("/api/extensions/acme/hello").json()
    assert "public_key" not in detail
    assert detail["versions"][0]["registry_signature"]
    assert detail["versions"][0]["signed"] is True


def test_download_increments_per_version_and_aggregate(client: TestClient) -> None:
    _publish(client, build_package())
    for _ in range(3):
        assert (
            client.get("/api/extensions/acme/hello/1.0.0/download").status_code
            == 200
        )
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["download_count"] == 3
    assert detail["versions"][0]["download_count"] == 3


def test_download_count_is_per_version(client: TestClient) -> None:
    _publish(client, build_package(manifest=valid_manifest(version="1.0.0")))
    _publish(client, build_package(manifest=valid_manifest(version="1.1.0")))
    client.get("/api/extensions/acme/hello/1.0.0/download")
    client.get("/api/extensions/acme/hello/1.1.0/download")
    client.get("/api/extensions/acme/hello/1.1.0/download")
    detail = client.get("/api/extensions/acme/hello").json()
    by_ver = {v["version"]: v["download_count"] for v in detail["versions"]}
    assert by_ver == {"1.0.0": 1, "1.1.0": 2}
    assert detail["download_count"] == 3


def test_rating_submit_and_average(client: TestClient) -> None:
    _publish(client, build_package())
    r1 = client.post("/api/extensions/acme/hello/rating", json={"score": 5})
    assert r1.status_code == 200
    assert r1.json()["rating_count"] == 1
    r2 = client.post("/api/extensions/acme/hello/rating", json={"score": 3})
    body = r2.json()
    assert body["rating_count"] == 2
    assert body["rating_average"] == 4.0
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["rating_average"] == 4.0
    assert detail["rating_count"] == 2


def test_rating_out_of_range_rejected(client: TestClient) -> None:
    _publish(client, build_package())
    assert (
        client.post("/api/extensions/acme/hello/rating", json={"score": 6}).status_code
        == 422
    )
    assert (
        client.post("/api/extensions/acme/hello/rating", json={"score": 0}).status_code
        == 422
    )


def test_rating_missing_extension_404(client: TestClient) -> None:
    assert (
        client.post("/api/extensions/acme/ghost/rating", json={"score": 5}).status_code
        == 404
    )


def test_featured_flag_defaults_false_and_can_be_set(client: TestClient) -> None:
    _publish(client, build_package())
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["featured"] is False
    resp = client.post(
        "/api/extensions/acme/hello/featured", json={"featured": True}
    )
    assert resp.status_code == 200
    assert resp.json()["featured"] is True
    detail = client.get("/api/extensions/acme/hello").json()
    assert detail["featured"] is True


def test_sort_by_downloads(client: TestClient) -> None:
    _publish_ext(client, "acme.low")
    _publish_ext(client, "acme.high")
    for _ in range(4):
        client.get("/api/extensions/acme/high/1.0.0/download")
    client.get("/api/extensions/acme/low/1.0.0/download")
    ordered = client.get(
        "/api/extensions", params={"sort": "downloads"}
    ).json()["items"]
    assert ordered[0]["name"] == "high"
    assert ordered[1]["name"] == "low"


def test_sort_by_rating(client: TestClient) -> None:
    _publish_ext(client, "acme.good")
    _publish_ext(client, "acme.ok")
    client.post("/api/extensions/acme/good/rating", json={"score": 5})
    client.post("/api/extensions/acme/ok/rating", json={"score": 2})
    ordered = client.get("/api/extensions", params={"sort": "rating"}).json()["items"]
    assert ordered[0]["name"] == "good"
    assert ordered[1]["name"] == "ok"


def test_category_filter(client: TestClient) -> None:
    _publish_ext(client, "acme.writer", categories=["writing", "tools"])
    _publish_ext(client, "acme.player", categories=["media"])
    hit = client.get("/api/extensions", params={"category": "writing"}).json()
    assert hit["total"] == 1
    assert hit["items"][0]["name"] == "writer"
    media = client.get("/api/extensions", params={"category": "media"}).json()
    assert media["total"] == 1
    assert media["items"][0]["name"] == "player"
