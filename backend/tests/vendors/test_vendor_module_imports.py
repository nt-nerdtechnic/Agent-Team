"""Every vendor module must import the stdlib modules it uses.

Moving a vendor out of the shared modules and into cli_vendors/<name>.py
carries its code but not the importing module's import block. A missed import
is invisible until the code path runs — `copilot.py` used `shutil.which("gh")`
without importing shutil, which only surfaced at runtime as
`usage poll failed for copilot: name 'shutil' is not defined`, silently
zeroing that vendor's usage badge.

Static AST check, so it costs nothing and covers paths no test exercises.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

VENDOR_DIR = Path(__file__).resolve().parents[2] / "agent_team_backend" / "cli_vendors"
VENDOR_FILES = sorted(p for p in VENDOR_DIR.glob("*.py") if p.name != "__init__.py")


def _bound_names(tree: ast.Module) -> set[str]:
    """Names this module can resolve locally — imports, definitions, bindings."""
    bound: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                bound.add(alias.asname or alias.name)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            bound.add(node.id)
        elif isinstance(node, ast.arg):
            bound.add(node.arg)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
    return bound


def _stdlib_attribute_roots(tree: ast.Module) -> set[str]:
    """Names used as `<name>.<attr>` that look like stdlib modules."""
    return {
        node.value.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
    } & sys.stdlib_module_names


def test_vendor_dir_is_populated() -> None:
    # Guards the parametrisation itself: a wrong path would make every case
    # below vacuously pass.
    assert len(VENDOR_FILES) >= 5


@pytest.mark.parametrize("path", VENDOR_FILES, ids=lambda p: p.stem)
def test_vendor_module_imports_every_stdlib_module_it_uses(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    missing = _stdlib_attribute_roots(tree) - _bound_names(tree)
    assert not missing, (
        f"{path.name} uses {sorted(missing)} without importing it — "
        "the import block did not follow the code into this vendor module"
    )
