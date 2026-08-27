"""Re-export shim — droid's reader lives in ``cli_vendors.droid``. Lazy like
the other vendor shims: the vendor module imports this package's ``base``, so
an eager import here would re-enter a module that is still executing."""

from __future__ import annotations

from typing import Any

_EXPORTS = ("DroidLogReader", "encode_droid_cwd", "droid_sessions_root")

__all__ = [*_EXPORTS]


def __getattr__(name: str) -> Any:
    if name in _EXPORTS:
        from ..cli_vendors import droid as _vendor

        return getattr(_vendor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
