from __future__ import annotations

import io
import json
import stat
import zipfile

import pytest

from registry.package import PackageError, _validate_archive_entries, read_package
from tests.fixtures import (
    CONTRACT_FIXTURES,
    build_package,
    build_v2_package,
    contract_manifest,
    valid_manifest,
)


def _zip_with_entries(entries: list[tuple[str, bytes, int | None]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            if mode is not None:
                info.create_system = 3
                info.external_attr = mode << 16
            zf.writestr(info, data)
    return buffer.getvalue()


def _valid_archive_entries() -> list[tuple[str, bytes, int | None]]:
    return [
        ("manifest.json", json.dumps(valid_manifest()).encode(), None),
        ("README.md", b"readme", None),
        ("icon.png", b"icon", None),
    ]


def _archive_path_contract() -> dict[str, dict[str, list[dict[str, str]]]]:
    return json.loads(
        (CONTRACT_FIXTURES.parent / "archive-paths-v1.json").read_text(encoding="utf-8")
    )


def _archive_entry_type_contract() -> list[dict[str, object]]:
    return json.loads(
        (CONTRACT_FIXTURES.parent / "archive-entry-types-v1.json").read_text(
            encoding="utf-8"
        )
    )["cases"]


def _archive_infos(entries: list[dict[str, str]]) -> list[zipfile.ZipInfo]:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry in entries:
            info = zipfile.ZipInfo(entry["path"])
            info.create_system = 3 if entry.get("creator", "unix") == "unix" else 0
            if info.create_system == 3 and entry["type"] == "directory":
                info.create_system = 3
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
            elif info.create_system == 3 and entry["type"] == "symlink":
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            elif info.create_system == 3 and entry["type"] == "special":
                info.create_system = 3
                info.external_attr = (stat.S_IFCHR | 0o644) << 16
            elif entry.get("dosDirectory"):
                info.external_attr = 0x10
            zf.writestr(info, b"")
    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as zf:
        return zf.infolist()


def test_read_valid_package() -> None:
    loaded = read_package(build_package())
    assert loaded.manifest.id == "acme.hello"
    assert len(loaded.digest) == 64
    paths = {a.path for a in loaded.assets}
    assert "README.md" in paths
    assert "icon.png" in paths
    assert "manifest.json" not in paths


def test_digest_is_stable() -> None:
    data = build_package()
    assert read_package(data).digest == read_package(data).digest


def test_not_a_zip_rejected() -> None:
    with pytest.raises(PackageError, match="ZIP"):
        read_package(b"not a zip file")


def test_zip64_end_of_central_directory_rejected() -> None:
    data = bytearray(build_package())
    data[-14:-12] = (0xFFFF).to_bytes(2, "little")
    data[-12:-10] = (0xFFFF).to_bytes(2, "little")
    with pytest.raises(PackageError, match="ZIP64 archives are not supported"):
        read_package(bytes(data))


def test_missing_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="missing manifest.json"):
        read_package(build_package(omit_manifest=True))


def test_invalid_json_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="not valid JSON"):
        read_package(build_package(manifest_bytes=b"{not json"))


def test_invalid_utf8_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="not valid JSON"):
        read_package(build_package(manifest_bytes=b'{"name":\xff}'))


def test_utf8_bom_manifest_rejected() -> None:
    raw = (CONTRACT_FIXTURES / "invalid-raw" / "manifest-utf8-bom.json").read_bytes()
    with pytest.raises(PackageError, match="BOM"):
        read_package(build_package(manifest_bytes=raw))


def test_invalid_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="invalid manifest"):
        read_package(build_package(manifest=valid_manifest(version="bad")))


def test_missing_icon_asset_rejected() -> None:
    with pytest.raises(PackageError, match="icon"):
        read_package(build_package(include_icon=False))


def test_manifest_without_icon_allows_missing_file() -> None:
    manifest = valid_manifest()
    del manifest["icon"]
    loaded = read_package(build_package(manifest=manifest, include_icon=False))
    assert loaded.manifest.icon is None


@pytest.mark.parametrize(
    "name",
    [path.name for path in sorted((CONTRACT_FIXTURES / "valid").glob("*.json"))],
)
def test_read_valid_manifest_v2_package(name: str) -> None:
    loaded = read_package(build_v2_package(contract_manifest(name)))
    assert loaded.manifest.schemaVersion == 2


def test_manifest_v2_backend_entry_requires_executable_metadata() -> None:
    manifest = contract_manifest("backend-only-skills.json")
    with pytest.raises(PackageError, match="not marked executable"):
        read_package(build_v2_package(manifest, backend_mode=stat.S_IFREG | 0o644))


@pytest.mark.parametrize(
    "data",
    [b"#!/bin/sh\nexit 0\n", b"\xef\xbb\xbf#!/bin/sh\nexit 0\n"],
    ids=["shebang", "bom-shebang"],
)
def test_manifest_v2_backend_entry_rejects_extensionless_scripts(data: bytes) -> None:
    manifest = contract_manifest("backend-only-skills.json")
    with pytest.raises(PackageError, match="raw script"):
        read_package(build_v2_package(manifest, backend_data=data))


def test_manifest_v2_backend_entry_rejects_empty_file() -> None:
    manifest = contract_manifest("backend-only-skills.json")
    with pytest.raises(PackageError, match="backend entry is empty"):
        read_package(build_v2_package(manifest, backend_data=b""))


def test_manifest_v2_referenced_file_is_required() -> None:
    manifest = contract_manifest()
    first_entry = manifest["contributes"]["views"][0]["entry"]
    with pytest.raises(PackageError, match="referenced file"):
        read_package(build_v2_package(manifest, omit_paths={first_entry}))


def test_duplicate_manifest_key_is_rejected_in_package_reader() -> None:
    raw = (
        CONTRACT_FIXTURES / "invalid-raw" / "duplicate-permission-key.json"
    ).read_bytes()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", raw)
        zf.writestr("left.html", b"<!doctype html>")
    with pytest.raises(PackageError, match="duplicate JSON object key: system"):
        read_package(buffer.getvalue())


def test_duplicate_archive_entry_is_rejected_before_manifest_read() -> None:
    entries = _valid_archive_entries()
    entries.append(("README.md", b"duplicate", None))
    with pytest.raises(PackageError, match="duplicate archive entry: README.md"):
        read_package(_zip_with_entries(entries))


def test_trailing_slash_symlink_is_rejected_as_special_entry() -> None:
    with pytest.raises(PackageError, match="not a regular file"):
        _validate_archive_entries(
            _archive_infos([{"path": "link/", "type": "symlink"}])
        )


def test_case_folded_manifest_alias_is_rejected_before_manifest_read() -> None:
    entries = _valid_archive_entries()
    entries.append(("MANIFEST.JSON", json.dumps(valid_manifest()).encode(), None))
    with pytest.raises(PackageError, match="duplicate archive entry"):
        read_package(_zip_with_entries(entries))


@pytest.mark.parametrize(
    "case", _archive_entry_type_contract(), ids=lambda case: case["name"]
)
def test_shared_archive_entry_type_contract(case: dict[str, object]) -> None:
    infos = _archive_infos(
        [
            {
                "path": str(case["path"]),
                "type": str(case["type"]),
                "creator": str(case["creator"]),
                "dosDirectory": bool(case["dosDirectory"]),
            }
        ]
    )
    if case["expected"] == "rejected":
        with pytest.raises(PackageError, match="not a regular file"):
            _validate_archive_entries(infos)
    else:
        validated = _validate_archive_entries(infos)
        assert validated[0][2] == case["expected"]


@pytest.mark.parametrize("name, entries", _archive_path_contract()["valid"].items())
def test_shared_archive_path_contract_accepts(
    name: str, entries: list[dict[str, str]]
) -> None:
    del name
    _validate_archive_entries(_archive_infos(entries))


@pytest.mark.parametrize("name, entries", _archive_path_contract()["invalid"].items())
def test_shared_archive_path_contract_rejects(
    name: str, entries: list[dict[str, str]]
) -> None:
    del name
    with pytest.raises(PackageError):
        _validate_archive_entries(_archive_infos(entries))


def test_noncanonical_manifest_alias_is_rejected_before_manifest_read() -> None:
    entries = [
        ("manifest.json", json.dumps(valid_manifest()).encode(), None),
        (
            "./manifest.json",
            json.dumps(valid_manifest(entry="evil.html")).encode(),
            None,
        ),
    ]
    with pytest.raises(PackageError, match="unsafe archive entry path"):
        read_package(_zip_with_entries(entries))


def test_unsafe_unreferenced_archive_entry_is_rejected() -> None:
    with pytest.raises(PackageError, match="unsafe archive entry path"):
        read_package(build_package(extra_files={"../escape.js": b"blocked"}))


@pytest.mark.parametrize(
    "mode",
    [stat.S_IFLNK | 0o777, stat.S_IFCHR | 0o600],
)
def test_non_regular_archive_entry_is_rejected(mode: int) -> None:
    entries = _valid_archive_entries()
    entries.append(("special-entry", b"not a regular file", mode))
    with pytest.raises(PackageError, match="not a regular file"):
        read_package(_zip_with_entries(entries))


def test_directory_metadata_is_preserved_as_a_non_asset() -> None:
    entries = _valid_archive_entries()
    entries.append(("nested", b"", stat.S_IFDIR | 0o755))
    loaded = read_package(_zip_with_entries(entries))
    assert "nested" not in {asset.path for asset in loaded.assets}
