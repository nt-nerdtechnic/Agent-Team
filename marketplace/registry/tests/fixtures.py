"""Helpers to build `.vsix`-style packages programmatically (no committed binary)."""

from __future__ import annotations

import io
import json
import stat
import zipfile
from pathlib import Path


CONTRACT_FIXTURES = Path(__file__).parents[3] / "docs" / "plugin-contracts" / "fixtures"


def valid_manifest(
    *,
    id: str = "acme.hello",
    version: str = "1.0.0",
    publisher: str = "acme",
    **overrides: object,
) -> dict:
    data: dict = {
        "id": id,
        "name": "Hello",
        "version": version,
        "publisher": publisher,
        "engines": {"navide": "^0.1.0"},
        "entry": "dist/hello.js",
        "contributes": {
            "views": [{"id": "hello.view", "title": "Hello"}],
            "commands": [{"id": "hello.run", "title": "Run"}],
        },
        "requires": ["fs", "ui"],
        "activationEvents": ["onStartup"],
        "displayName": "Hello World",
        "description": "A friendly greeter extension",
        "categories": ["productivity", "demo"],
        "icon": "icon.png",
    }
    data.update(overrides)
    return data


def build_package(
    *,
    manifest: dict | None = None,
    include_icon: bool = True,
    extra_files: dict[str, bytes] | None = None,
    omit_manifest: bool = False,
    manifest_bytes: bytes | None = None,
) -> bytes:
    """Return the bytes of a `.vsix`-style ZIP archive."""
    manifest = manifest if manifest is not None else valid_manifest()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        if not omit_manifest:
            if manifest_bytes is not None:
                zf.writestr("manifest.json", manifest_bytes)
            else:
                zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("README.md", b"# Hello\n\nDemo extension.\n")
        if include_icon:
            zf.writestr("icon.png", b"\x89PNG\r\n\x1a\n-fake-icon-bytes")
        for path, content in (extra_files or {}).items():
            zf.writestr(path, content)
    return buffer.getvalue()


def contract_manifest(name: str = "frontend-multi-view.json") -> dict:
    """Load one normative Manifest v2 fixture for package/API tests."""
    path = CONTRACT_FIXTURES / "valid" / name
    return json.loads(path.read_text(encoding="utf-8"))


def build_v2_package(
    manifest: dict | None = None,
    *,
    omit_paths: set[str] | None = None,
    backend_mode: int = stat.S_IFREG | 0o755,
    backend_data: bytes = b"\x7fELF-test-backend",
) -> bytes:
    """Build a package containing every file referenced by a v2 manifest."""
    manifest = manifest if manifest is not None else contract_manifest()
    omitted = omit_paths or set()
    paths: set[str] = set()
    marketplace = manifest.get("marketplace", {})
    if isinstance(marketplace, dict) and isinstance(marketplace.get("icon"), str):
        paths.add(marketplace["icon"])
    contributes = manifest.get("contributes", {})
    if isinstance(contributes, dict):
        for view in contributes.get("views", []):
            if not isinstance(view, dict):
                continue
            if isinstance(view.get("entry"), str):
                paths.add(view["entry"])
            if isinstance(view.get("icon"), str):
                paths.add(view["icon"])
    backend = manifest.get("backend", {})
    backend_entry: str | None = None
    if isinstance(backend, dict) and isinstance(backend.get("entry"), str):
        backend_entry = backend["entry"]
        paths.add(backend_entry)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("README.md", b"# Contract fixture\n")
        for path in sorted(paths - omitted):
            info = zipfile.ZipInfo(path)
            info.create_system = 3
            info.external_attr = (
                backend_mode if path == backend_entry else stat.S_IFREG | 0o644
            ) << 16
            data = (
                backend_data
                if path == backend_entry
                else b"<!doctype html>\n"
                if path.endswith(".html")
                else b"asset"
            )
            zf.writestr(info, data)
    return buffer.getvalue()
