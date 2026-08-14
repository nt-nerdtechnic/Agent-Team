from __future__ import annotations

import json
from pathlib import Path

import pytest

from registry.manifest import ManifestError, parse_manifest
from tests.fixtures import valid_manifest


CONTRACT_FIXTURES = Path(__file__).parents[3] / "docs" / "plugin-contracts" / "fixtures"
VALID_V2_FIXTURES = sorted((CONTRACT_FIXTURES / "valid").glob("*.json"))
INVALID_V2_FIXTURES = sorted((CONTRACT_FIXTURES / "invalid").glob("*.json"))


def _read_fixture(group: str, name: str) -> str:
    return (CONTRACT_FIXTURES / group / name).read_text(encoding="utf-8")


def _read_strict(text: str) -> dict:
    def unique(pairs: list[tuple[str, object]]) -> dict:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON object key: {key}")
            result[key] = value
        return result

    value = json.loads(text, object_pairs_hook=unique)
    assert isinstance(value, dict)
    return value


def test_valid_manifest_parses() -> None:
    m = parse_manifest(valid_manifest())
    assert m.id == "acme.hello"
    assert m.namespace == "acme"
    assert m.extension_name == "hello"
    assert m.categories == ["productivity", "demo"]


def test_minimal_manifest_without_marketplace_fields() -> None:
    data = {
        "id": "acme.hello",
        "name": "Hello",
        "version": "0.1.0",
        "publisher": "acme",
        "engines": {"navide": "^0.1.0"},
    }
    m = parse_manifest(data)
    assert m.displayName is None
    assert m.categories == []
    assert m.icon is None


@pytest.mark.parametrize("field", ["id", "name", "version", "publisher", "engines"])
def test_missing_required_field_rejected(field: str) -> None:
    data = valid_manifest()
    del data[field]
    with pytest.raises(ManifestError, match=field):
        parse_manifest(data)


def test_bad_id_rejected() -> None:
    with pytest.raises(ManifestError, match="id"):
        parse_manifest(valid_manifest(id="NoDot"))


def test_bad_version_rejected() -> None:
    with pytest.raises(ManifestError, match="version"):
        parse_manifest(valid_manifest(version="1.0"))


def test_unknown_capability_rejected() -> None:
    with pytest.raises(ManifestError, match="capabilities"):
        parse_manifest(valid_manifest(requires=["fs", "bogus"]))


def test_v2_storage_permission_is_not_accepted_as_legacy_requires() -> None:
    with pytest.raises(ManifestError, match="storage"):
        parse_manifest(valid_manifest(requires=["storage"]))


def test_all_client_capabilities_accepted() -> None:
    # Mirrors backend plugins/manifest.py and client pluginVerify.ts.
    all_caps = ["fs", "git", "terminal", "search", "chat", "ui", "issues"]
    m = parse_manifest(valid_manifest(requires=all_caps))
    assert m.requires == all_caps


def test_bad_activation_event_rejected() -> None:
    with pytest.raises(ManifestError, match="activation"):
        parse_manifest(valid_manifest(activationEvents=["whenever"]))


def test_empty_engines_rejected() -> None:
    with pytest.raises(ManifestError, match="engines"):
        parse_manifest(valid_manifest(engines={}))


@pytest.mark.parametrize(
    "name",
    [path.name for path in VALID_V2_FIXTURES],
)
def test_manifest_v2_valid_fixture_parses(name: str) -> None:
    manifest = parse_manifest(_read_strict(_read_fixture("valid", name)))
    assert manifest.schemaVersion == 2


@pytest.mark.parametrize("path", INVALID_V2_FIXTURES, ids=lambda path: path.name)
def test_manifest_v2_invalid_fixture_rejected(path: Path) -> None:
    with pytest.raises(ManifestError):
        parse_manifest(_read_strict(path.read_text(encoding="utf-8")))


def test_manifest_v2_duplicate_key_fixture_rejected_before_validation() -> None:
    with pytest.raises(ValueError, match="duplicate JSON object key: ui"):
        _read_strict(_read_fixture("invalid-raw", "duplicate-permission-key.json"))


def test_manifest_v2_bom_fixture_rejected_before_validation() -> None:
    with pytest.raises(json.JSONDecodeError, match="BOM"):
        _read_strict(_read_fixture("invalid-raw", "manifest-utf8-bom.json"))
