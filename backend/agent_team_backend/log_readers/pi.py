"""Re-export shim — pi's reader moved to ``cli_vendors.pi`` (R8 of the
one-file-per-vendor refactor). Deleted in the cleanup round; lazy like the
other vendor shims."""

from __future__ import annotations

from typing import Any

_EXPORTS = ("PiLogReader",)

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import pi as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
