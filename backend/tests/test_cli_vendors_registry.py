"""Structural tests for the per-vendor registry.

These are the CI guardrails of the one-file-per-vendor refactor:

* drift — the registry's key set must stay in lockstep with every other
  place a vendor list exists (install detection, log readers, frontend
  specs), so "added a vendor but forgot a spot" fails here instead of
  surfacing at runtime;
* import graph — vendor modules must stay self-contained (no vendor→vendor
  or vendor→app edges), which is what keeps "add a vendor" a one-file PR.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

from agent_team_backend.cli_vendors import registry
from agent_team_backend.cli_vendors.base import VendorSpec

REPO_ROOT = Path(__file__).resolve().parents[2]
VENDORS_DIR = REPO_ROOT / "backend" / "agent_team_backend" / "cli_vendors"
AGENT_SPECS_TS = REPO_ROOT / "src" / "renderer" / "src" / "lib" / "agentSpecs.ts"

EXPECTED_KEYS = {
    "aider", "antigravity", "claude", "codex", "copilot", "cursor",
    "grok", "kilo", "kimi", "opencode", "pi", "qwen",
}

# DEPS entries that are infrastructure, not CLI vendors.
NON_VENDOR_DEPS = {"homebrew", "node", "ollama", "pnpm", "python", "uv"}

# Frontend-only pane type, not a CLI vendor.
NON_VENDOR_AGENT_KEYS = {"terminal"}

# Modules a vendor file may import. log_readers.base is the shared reader
# contract (safe direction: it imports no vendor); kilo→opencode is the
# single allowed vendor→vendor edge (reader class inheritance).
ALLOWED_LOCAL_IMPORTS = {"base", "_protocols", "log_readers.base", "usage_common"}
VENDOR_IMPORT_EXEMPTIONS = {"kilo": {"opencode"}}
ALLOWED_THIRD_PARTY = {"httpx", "yaml"}


def test_registry_matches_expected_vendor_set() -> None:
    assert set(registry.VENDORS) == EXPECTED_KEYS
    for key, spec in registry.VENDORS.items():
        assert isinstance(spec, VendorSpec)
        assert spec.key == key
        assert spec.label


def test_registry_matches_install_detection_deps() -> None:
    from agent_team_backend.onboarding_deps import DEPS

    dep_ids = {dep.id for dep in DEPS}
    assert set(registry.VENDORS) <= dep_ids
    assert dep_ids - set(registry.VENDORS) == NON_VENDOR_DEPS


def test_registry_matches_log_reader_package() -> None:
    reader_modules = {
        path.stem
        for path in (VENDORS_DIR.parent / "log_readers").glob("*.py")
        if not path.stem.startswith("_")
        and path.stem not in {"base", "watcher", "attribution"}
    }
    assert reader_modules == set(registry.VENDORS)


def test_registry_matches_frontend_agent_specs() -> None:
    # Read-only regex over the frontend source: the backend must not import
    # or execute TS, but the two sides must never disagree about who exists.
    source = AGENT_SPECS_TS.read_text(encoding="utf-8")
    frontend_keys = set(re.findall(r"agentKey: '([a-z]+)'", source))
    assert frontend_keys - NON_VENDOR_AGENT_KEYS == set(registry.VENDORS)


def test_vendor_modules_import_only_allowed_modules() -> None:
    for path in sorted(VENDORS_DIR.glob("*.py")):
        if path.stem.startswith("_") or path.stem in {"base", "registry"}:
            continue
        allowed_local = (
            ALLOWED_LOCAL_IMPORTS | VENDOR_IMPORT_EXEMPTIONS.get(path.stem, set())
        )
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.level:  # relative: from .base / ..log_readers.base
                    module = node.module or ""
                    if module == "":  # from . import _protocols, base, ...
                        for alias in node.names:
                            assert alias.name in allowed_local, (
                                f"{path.name} imports .{alias.name} — vendor "
                                f"modules may only import "
                                f"{sorted(allowed_local)} locally"
                            )
                        continue
                    assert module in allowed_local, (
                        f"{path.name} imports .{node.module} — vendor modules "
                        f"may only import {sorted(allowed_local)} locally"
                    )
                else:
                    root = (node.module or "").split(".")[0]
                    _assert_absolute_import_allowed(path.name, root)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    _assert_absolute_import_allowed(
                        path.name, alias.name.split(".")[0]
                    )


def _assert_absolute_import_allowed(filename: str, root: str) -> None:
    import sys

    stdlib = root in sys.stdlib_module_names
    assert stdlib or root in ALLOWED_THIRD_PARTY, (
        f"{filename} imports {root!r} — vendor modules are limited to the "
        f"standard library and {sorted(ALLOWED_THIRD_PARTY)}; app modules "
        "must depend on vendors, never the reverse"
    )
