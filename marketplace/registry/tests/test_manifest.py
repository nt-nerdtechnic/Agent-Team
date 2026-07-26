from __future__ import annotations

import pytest

from registry.manifest import ManifestError, parse_manifest
from tests.fixtures import valid_manifest


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
