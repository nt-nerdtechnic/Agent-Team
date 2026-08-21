"""Tests for the server-rendered discovery website (p3-discovery)."""

from __future__ import annotations

import io
import json
import zipfile

from fastapi.testclient import TestClient

from tests.fixtures import build_package, build_v2_package, contract_manifest, valid_manifest


def _publish(client: TestClient, data: bytes):
    return client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
    )


def _publish_ext(client: TestClient, ident: str, **manifest_kw):
    ns, _ = ident.split(".", 1)
    manifest = valid_manifest(id=ident, publisher=ns, **manifest_kw)
    return _publish(client, build_package(manifest=manifest))


def _package_with_files(manifest: dict, files: dict[str, bytes]) -> bytes:
    """Build a .vsix with an explicit file set (custom README/screenshots)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        for path, content in files.items():
            zf.writestr(path, content)
    return buf.getvalue()


def test_home_renders_search_and_cards(client: TestClient) -> None:
    _publish_ext(client, "acme.hello")
    resp = client.get("/")
    assert resp.status_code == 200
    html = resp.text
    assert "Navide Marketplace" in html
    assert 'name="q"' in html  # search box
    assert "Browse" in html
    assert "Hello World" in html  # displayName on a card


def test_home_featured_section(client: TestClient) -> None:
    _publish_ext(client, "acme.hello")
    client.post("/api/extensions/acme/hello/featured", json={"featured": True})
    html = client.get("/").text
    assert "Featured" in html
    # Featured section renders before Browse.
    assert html.index("Featured") < html.index("Browse")


def test_home_search_query_filters(client: TestClient) -> None:
    _publish_ext(client, "acme.hello")
    _publish_ext(
        client, "beta.notes", description="markdown notes", categories=["writing"]
    )
    hit = client.get("/", params={"q": "markdown"}).text
    assert "/extensions/beta/notes" in hit
    assert "/extensions/acme/hello" not in hit


def test_home_category_and_sort_params(client: TestClient) -> None:
    _publish_ext(client, "acme.writer", categories=["writing"])
    _publish_ext(client, "acme.player", categories=["media"])
    filtered = client.get("/", params={"category": "media"})
    assert filtered.status_code == 200
    assert "player" in filtered.text
    # sort param accepted and page still renders
    assert client.get("/", params={"sort": "downloads"}).status_code == 200
    assert client.get("/", params={"sort": "rating"}).status_code == 200


def test_detail_renders_readme_versions_and_trust(client: TestClient) -> None:
    _publish(client, build_package(manifest=valid_manifest(version="1.0.0")))
    _publish(client, build_package(manifest=valid_manifest(version="1.2.0")))
    resp = client.get("/extensions/acme/hello")
    assert resp.status_code == 200
    html = resp.text
    # README markdown rendered to HTML.
    assert "<h1>Hello</h1>" in html
    # Version list present.
    assert "1.0.0" in html and "1.2.0" in html
    # Accepted artifacts are centrally signed even in permissive dev posture.
    assert "signed" in html
    assert "badge" in html


def test_detail_renders_semver_prerelease_versions(client: TestClient) -> None:
    older = contract_manifest()
    older["version"] = "1.2.3-alpha.beta"
    newer = contract_manifest()
    newer["version"] = "1.2.3-x.7.z.92"
    assert _publish(client, build_v2_package(older)).status_code == 201
    assert _publish(client, build_v2_package(newer)).status_code == 201

    resp = client.get("/extensions/acme/files")
    assert resp.status_code == 200
    assert "1.2.3-x.7.z.92" in resp.text


def test_detail_missing_404(client: TestClient) -> None:
    assert client.get("/extensions/acme/ghost").status_code == 404


def test_detail_sensitive_capability_warning(client: TestClient) -> None:
    # requires fs -> sensitive; valid_manifest already declares ["fs", "ui"].
    _publish_ext(client, "acme.hello")
    html = client.get("/extensions/acme/hello").text
    assert "sensitive" in html.lower()
    assert "fs" in html


def test_readme_script_is_sanitized(client: TestClient) -> None:
    manifest = valid_manifest(id="acme.evil", publisher="acme", icon=None)
    readme = b"# Evil\n\n<script>window.__pwned=1</script>\n\nhi"
    pkg = _package_with_files(manifest, {"README.md": readme})
    assert _publish(client, pkg).status_code == 201
    html = client.get("/extensions/acme/evil").text
    # The active script tag must NOT appear; it must be HTML-escaped.
    assert "<script>window.__pwned" not in html
    assert "&lt;script&gt;" in html


def test_detail_serves_screenshot_asset(client: TestClient) -> None:
    manifest = valid_manifest(id="acme.shot", publisher="acme", icon="icon.png")
    png = b"\x89PNG\r\n\x1a\n-fake"
    pkg = _package_with_files(
        manifest,
        {
            "README.md": b"# Shot\n",
            "icon.png": png,
            "screenshots/main.png": png,
        },
    )
    assert _publish(client, pkg).status_code == 201
    detail = client.get("/extensions/acme/shot").text
    assert "screenshots/main.png" in detail
    asset = client.get(
        "/extensions/acme/shot/1.0.0/assets/screenshots/main.png"
    )
    assert asset.status_code == 200
    assert asset.content == png
    assert asset.headers["content-type"].startswith("image/")


def test_asset_route_rejects_non_asset(client: TestClient) -> None:
    _publish_ext(client, "acme.hello")
    # manifest.json is not an asset -> must not be served through the asset route
    resp = client.get("/extensions/acme/hello/1.0.0/assets/manifest.json")
    assert resp.status_code == 404


def test_asset_route_rejects_active_mime_types(client: TestClient) -> None:
    # A package asset's Content-Type is attacker-controlled (guessed from the
    # filename). text/html and image/svg+xml served on this origin would be a
    # stored-XSS vector, so the asset route must refuse them, not sniff them.
    manifest = valid_manifest(id="acme.evil", publisher="acme", icon="icon.png")
    pkg = _package_with_files(
        manifest,
        {
            "README.md": b"# Evil\n",
            "icon.png": b"\x89PNG\r\n\x1a\n-fake",
            "payload.html": b"<script>window.__pwned=1</script>",
            "payload.svg": b"<svg xmlns='http://www.w3.org/2000/svg'>"
            b"<script>window.__pwned=1</script></svg>",
        },
    )
    assert _publish(client, pkg).status_code == 201
    for bad in ("payload.html", "payload.svg"):
        resp = client.get(f"/extensions/acme/evil/1.0.0/assets/{bad}")
        assert resp.status_code == 415, bad


def test_image_asset_is_hardened(client: TestClient) -> None:
    manifest = valid_manifest(id="acme.img", publisher="acme", icon="icon.png")
    png = b"\x89PNG\r\n\x1a\n-fake"
    pkg = _package_with_files(manifest, {"README.md": b"# I\n", "icon.png": png})
    assert _publish(client, pkg).status_code == 201
    resp = client.get("/extensions/acme/img/1.0.0/assets/icon.png")
    assert resp.status_code == 200
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'none'" in resp.headers["content-security-policy"]
    assert resp.headers["content-disposition"].startswith("inline")


def test_download_count_shows_on_home_card(client: TestClient) -> None:
    _publish_ext(client, "acme.hello")
    client.get("/api/extensions/acme/hello/1.0.0/download")
    html = client.get("/").text
    assert "⬇ 1" in html
