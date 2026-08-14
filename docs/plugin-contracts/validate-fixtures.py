"""Validate the draft Plugin v2 contract corpus.

Run with the marketplace registry environment so Draft 2020-12 support matches
the contract checks used during documentation review:

    uv --project marketplace/registry run python docs/plugin-contracts/validate-fixtures.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parent


class DuplicateKeyError(ValueError):
    """Raised before schema validation when a JSON object repeats a key."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _load_strict(path: Path) -> Any:
    return json.loads(path.read_text(), object_pairs_hook=_unique_object)


def _validate_manifest_semantics(manifest: Any) -> None:
    """Validate invariants that Draft 2020-12 cannot express by itself."""
    if not isinstance(manifest, dict):
        return
    contributes = manifest.get("contributes")
    if not isinstance(contributes, dict):
        return
    views = contributes.get("views")
    if not isinstance(views, list):
        return
    view_ids = [view.get("id") for view in views if isinstance(view, dict)]
    if len(view_ids) != len(set(view_ids)):
        raise ValueError("contributes.views must contain unique ids")


def _catalog_permission_pairs(catalog: dict[str, Any]) -> dict[tuple[str, str], str]:
    pairs: dict[tuple[str, str], str] = {}
    for item in [*catalog["methods"], *catalog["events"]]:
        if item["visibility"] != "public":
            continue
        permission = item["permission"]
        key = (permission["id"], permission["access"])
        scope = permission["scope"]
        previous = pairs.setdefault(key, scope)
        if previous != scope:
            raise AssertionError(
                f"catalog assigns conflicting scopes to {key}: {previous!r} and {scope!r}"
            )
    return pairs


def main() -> None:
    schema = _load_strict(ROOT / "plugin-manifest-v2.schema.json")
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)

    for path in sorted((ROOT / "fixtures" / "valid").glob("*.json")):
        manifest = _load_strict(path)
        errors = list(validator.iter_errors(manifest))
        if errors:
            raise AssertionError(f"valid fixture rejected: {path}: {errors[0].message}")
        _validate_manifest_semantics(manifest)
        print(f"VALID   {path.name}")

    for path in sorted((ROOT / "fixtures" / "invalid").glob("*.json")):
        manifest = _load_strict(path)
        errors = list(validator.iter_errors(manifest))
        if not errors:
            try:
                _validate_manifest_semantics(manifest)
            except ValueError:
                pass
            else:
                raise AssertionError(f"invalid fixture accepted: {path}")
        print(f"INVALID {path.name}")

    for path in sorted((ROOT / "fixtures" / "invalid-raw").glob("*.json")):
        try:
            _load_strict(path)
        except (DuplicateKeyError, json.JSONDecodeError):
            print(f"RAW     {path.name}")
        else:
            raise AssertionError(f"invalid raw fixture parsed successfully: {path}")

    catalog = _load_strict(ROOT / "capabilities-v1.json")
    known_errors = set(catalog["errors"])
    addresses: list[str] = []
    for method in catalog["methods"]:
        addresses.append(method["address"])
        if not set(method["errors"]) <= known_errors:
            raise AssertionError(f"unknown error code on {method['address']}")
        Draft202012Validator.check_schema(method["params"])
        Draft202012Validator.check_schema(method["result"])
    for event in catalog["events"]:
        addresses.append(event["address"])
        Draft202012Validator.check_schema(event["payload"])
    if len(addresses) != len(set(addresses)):
        raise AssertionError("capability catalog contains duplicate addresses")

    catalog_pairs = _catalog_permission_pairs(catalog)
    permission_properties = schema["properties"]["permissions"]["properties"]
    schema_pairs: set[tuple[str, str]] = set()
    for permission_id, permission_schema in permission_properties.items():
        item_schema = permission_schema["items"]
        access_values = (
            [item_schema["const"]]
            if "const" in item_schema
            else item_schema["enum"]
        )
        schema_pairs.update((permission_id, access) for access in access_values)

    if schema_pairs != set(catalog_pairs):
        raise AssertionError(
            "manifest permissions and public capability catalog differ: "
            f"schema-only={sorted(schema_pairs - set(catalog_pairs))}, "
            f"catalog-only={sorted(set(catalog_pairs) - schema_pairs)}"
        )
    print(f"CATALOG {len(catalog_pairs)} permission/access pairs")


if __name__ == "__main__":
    main()
