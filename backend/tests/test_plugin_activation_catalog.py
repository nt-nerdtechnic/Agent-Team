"""Host-approved Manifest v2 backend activation catalog tests."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from agent_team_backend.plugins.activation_catalog import (
    ACTIVATION_CATALOG_DIGEST_ENV,
    ACTIVATION_CATALOG_PATH_ENV,
    ActivationCatalogError,
    load_activation_catalog,
)

CONTRACT_FIXTURES = Path(__file__).parents[2] / "docs" / "plugin-contracts" / "fixtures"


def _fixture_version(group: str, name: str) -> str:
    return json.loads((CONTRACT_FIXTURES / group / name).read_text(encoding="utf-8"))["version"]


def _write_package(
    root: Path,
    plugin_id: str = "acme.tools",
    version: str = "1.2.3",
) -> tuple[Path, Path]:
    package_dir = root / plugin_id
    backend = package_dir / "backend" / "acme-tools"
    backend.parent.mkdir(parents=True)
    backend.write_bytes(b"\x7fELF")
    manifest = {
        "schemaVersion": 2,
        "id": plugin_id,
        "version": version,
        "backend": {
            "entry": "backend/acme-tools",
            "protocolVersion": 1,
            "activation": "startup",
        },
    }
    (package_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return package_dir, backend


def _catalog(
    package_dir: Path,
    backend: Path,
    plugin_id: str = "acme.tools",
    version: str = "1.2.3",
) -> dict:
    return {
        "schemaVersion": 1,
        "packages": [
            {
                "pluginId": plugin_id,
                "packageVersion": version,
                "packageDir": str(package_dir),
                "provenance": "official-registry",
                "artifactDigest": "a" * 64,
                "backend": {
                    "entryFile": str(backend),
                    "protocolVersion": 1,
                    "activation": "startup",
                },
            }
        ],
    }


def _write_catalog(root: Path, data: dict) -> tuple[Path, str]:
    path = root / ".navide-backend-activation.json"
    payload = json.dumps(data, separators=(",", ":")).encode()
    path.write_bytes(payload)
    path.chmod(0o600)
    return path, hashlib.sha256(payload).hexdigest()


def test_loads_host_bound_official_backend_activation(tmp_path: Path) -> None:
    package_dir, backend = _write_package(tmp_path)
    path, digest = _write_catalog(tmp_path, _catalog(package_dir, backend))

    entries = load_activation_catalog(
        {
            ACTIVATION_CATALOG_PATH_ENV: str(path),
            ACTIVATION_CATALOG_DIGEST_ENV: digest,
        }
    )

    assert len(entries) == 1
    assert entries[0].plugin_id == "acme.tools"
    assert entries[0].package_version == "1.2.3"
    assert entries[0].package_dir == package_dir
    assert entries[0].entry_file == backend


@pytest.mark.parametrize(
    "fixture_name",
    ["frontend-prerelease.json", "frontend-build-metadata.json"],
)
def test_accepts_manifest_v2_semver_fixture_versions(fixture_name: str, tmp_path: Path) -> None:
    version = _fixture_version("valid", fixture_name)
    package_dir, backend = _write_package(tmp_path, version=version)
    path, digest = _write_catalog(tmp_path, _catalog(package_dir, backend, version=version))

    entries = load_activation_catalog(
        {
            ACTIVATION_CATALOG_PATH_ENV: str(path),
            ACTIVATION_CATALOG_DIGEST_ENV: digest,
        }
    )

    assert [entry.package_version for entry in entries] == [version]


@pytest.mark.parametrize(
    ("fixture_group", "fixture_name"),
    [
        ("invalid", "version-leading-zero.json"),
        ("invalid", "version-prerelease-empty.json"),
        ("invalid", "version-prerelease-empty-segment.json"),
        ("invalid", "version-trailing-newline.json"),
    ],
)
def test_rejects_manifest_v2_invalid_semver_fixture_versions(
    fixture_group: str,
    fixture_name: str,
    tmp_path: Path,
) -> None:
    version = _fixture_version(fixture_group, fixture_name)
    package_dir, backend = _write_package(tmp_path, version=version)
    path, digest = _write_catalog(tmp_path, _catalog(package_dir, backend, version=version))

    with pytest.raises(ActivationCatalogError, match="invalid packageVersion"):
        load_activation_catalog(
            {
                ACTIVATION_CATALOG_PATH_ENV: str(path),
                ACTIVATION_CATALOG_DIGEST_ENV: digest,
            }
        )


def test_rejects_entire_catalog_when_one_package_version_is_invalid(tmp_path: Path) -> None:
    valid_version = _fixture_version("valid", "frontend-prerelease.json")
    invalid_version = _fixture_version("invalid", "version-leading-zero.json")
    valid_package, valid_backend = _write_package(tmp_path, version=valid_version)
    invalid_package, invalid_backend = _write_package(
        tmp_path,
        plugin_id="acme.other",
        version=invalid_version,
    )
    data = _catalog(valid_package, valid_backend, version=valid_version)
    data["packages"].append(
        _catalog(
            invalid_package,
            invalid_backend,
            plugin_id="acme.other",
            version=invalid_version,
        )["packages"][0]
    )
    path, digest = _write_catalog(tmp_path, data)

    with pytest.raises(ActivationCatalogError, match="invalid packageVersion"):
        load_activation_catalog(
            {
                ACTIVATION_CATALOG_PATH_ENV: str(path),
                ACTIVATION_CATALOG_DIGEST_ENV: digest,
            }
        )


@pytest.mark.parametrize("plugin_id", ["acme.tools.extra", "0.x.y"])
def test_loads_multi_segment_plugin_id(plugin_id: str, tmp_path: Path) -> None:
    package_dir, backend = _write_package(tmp_path, plugin_id)
    path, digest = _write_catalog(tmp_path, _catalog(package_dir, backend, plugin_id))

    entries = load_activation_catalog(
        {
            ACTIVATION_CATALOG_PATH_ENV: str(path),
            ACTIVATION_CATALOG_DIGEST_ENV: digest,
        }
    )

    assert [entry.plugin_id for entry in entries] == [plugin_id]


@pytest.mark.parametrize(
    "plugin_id",
    [
        "acme",
        "acme..tools",
        ".acme.tools",
        "acme.tools.",
        "acme.-tools",
        "acme/tools",
        "acme\\tools",
        "../acme.tools",
        "acme.tools/..",
        "Acme.tools",
        "acme.tools_extra",
        "acme.%2etools",
    ],
)
def test_rejects_malformed_or_traversal_plugin_id(plugin_id: str, tmp_path: Path) -> None:
    package_dir, backend = _write_package(tmp_path)
    data = _catalog(package_dir, backend, plugin_id)
    path, digest = _write_catalog(tmp_path, data)

    with pytest.raises(ActivationCatalogError, match="invalid pluginId"):
        load_activation_catalog(
            {
                ACTIVATION_CATALOG_PATH_ENV: str(path),
                ACTIVATION_CATALOG_DIGEST_ENV: digest,
            }
        )


def test_rejects_catalog_digest_mismatch(tmp_path: Path) -> None:
    package_dir, backend = _write_package(tmp_path)
    path, _digest = _write_catalog(tmp_path, _catalog(package_dir, backend))

    with pytest.raises(ActivationCatalogError, match="digest"):
        load_activation_catalog(
            {
                ACTIVATION_CATALOG_PATH_ENV: str(path),
                ACTIVATION_CATALOG_DIGEST_ENV: "0" * 64,
            }
        )


def test_rejects_duplicate_json_keys_before_projection(tmp_path: Path) -> None:
    package_dir, backend = _write_package(tmp_path)
    path = tmp_path / ".navide-backend-activation.json"
    payload = (
        '{"schemaVersion":1,"schemaVersion":1,"packages":['
        + json.dumps(_catalog(package_dir, backend)["packages"][0])
        + "]}"
    ).encode()
    path.write_bytes(payload)
    path.chmod(0o600)

    with pytest.raises(ActivationCatalogError, match="duplicate JSON key"):
        load_activation_catalog(
            {
                ACTIVATION_CATALOG_PATH_ENV: str(path),
                ACTIVATION_CATALOG_DIGEST_ENV: hashlib.sha256(payload).hexdigest(),
            }
        )


def test_rejects_package_outside_catalog_root(tmp_path: Path) -> None:
    root = tmp_path / "plugins"
    root.mkdir()
    package_dir, backend = _write_package(tmp_path / "outside")
    path, digest = _write_catalog(root, _catalog(package_dir, backend))

    with pytest.raises(ActivationCatalogError, match="direct child"):
        load_activation_catalog(
            {
                ACTIVATION_CATALOG_PATH_ENV: str(path),
                ACTIVATION_CATALOG_DIGEST_ENV: digest,
            }
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("pluginId", "acme.other", "package directory"),
        ("packageVersion", "9.9.9", "manifest identity"),
        ("provenance", "developer-local-unpacked", "provenance"),
        ("provenance", "publisher-supplied", "provenance"),
    ],
)
def test_rejects_identity_or_unapproved_provenance(
    tmp_path: Path,
    field: str,
    value: str,
    message: str,
) -> None:
    package_dir, backend = _write_package(tmp_path)
    data = _catalog(package_dir, backend)
    data["packages"][0][field] = value
    path, digest = _write_catalog(tmp_path, data)

    with pytest.raises(ActivationCatalogError, match=message):
        load_activation_catalog(
            {
                ACTIVATION_CATALOG_PATH_ENV: str(path),
                ACTIVATION_CATALOG_DIGEST_ENV: digest,
            }
        )


def test_rejects_backend_entry_outside_package(tmp_path: Path) -> None:
    package_dir, backend = _write_package(tmp_path)
    outside = tmp_path / "outside-binary"
    outside.write_bytes(b"binary")
    data = _catalog(package_dir, backend)
    data["packages"][0]["backend"]["entryFile"] = str(outside)
    path, digest = _write_catalog(tmp_path, data)

    with pytest.raises(ActivationCatalogError, match="backend entry"):
        load_activation_catalog(
            {
                ACTIVATION_CATALOG_PATH_ENV: str(path),
                ACTIVATION_CATALOG_DIGEST_ENV: digest,
            }
        )


def test_missing_catalog_binding_means_no_external_activation() -> None:
    assert load_activation_catalog({}) == ()

    with pytest.raises(ActivationCatalogError, match="must be set together"):
        load_activation_catalog({ACTIVATION_CATALOG_PATH_ENV: "/tmp/catalog.json"})
