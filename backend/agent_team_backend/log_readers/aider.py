"""Re-export shim — aider's reader moved to ``cli_vendors.aider`` (R1 of the
one-file-per-vendor refactor). Deleted in the cleanup round once every import
site points at the vendor module directly.

Lazy on purpose: this package's ``__init__`` imports every reader module, so
an eager re-import of ``cli_vendors.aider`` (which itself needs
``log_readers.base``) would bite its own tail while the package is still
initializing. PEP 562 resolves names on first use, after both packages exist.
"""

from __future__ import annotations

from typing import Any

_EXPORTS = (
    "HISTORY_NAME",
    "AiderLogReader",
    "aider_history_path",
    "aider_pane_history_path",
    "history_namespace",
    "is_history_name",
    "pane_history_name",
)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import aider as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
