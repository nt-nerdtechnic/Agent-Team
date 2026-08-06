"""Re-export shim — delegated refresh moved into ``cli_vendors.claude``
(R12). Forwards everything; deleted in the cleanup round. ``_probe_env``
maps to the refresh variant."""

from __future__ import annotations

from typing import Any

_RENAMED = {"_probe_env": "_refresh_probe_env"}


def __getattr__(name: str) -> Any:
    from .cli_vendors import claude as _vendor

    return getattr(_vendor, _RENAMED.get(name, name))
