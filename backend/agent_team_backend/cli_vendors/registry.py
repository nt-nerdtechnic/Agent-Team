"""The vendor registry — one entry per CLI vendor, one line to register.

Adding a vendor: create ``<key>.py`` from ``_template.py``, then add its SPEC
to the tuple below. ``test_cli_vendors_registry.py`` cross-checks this set
against the install-detection table, the log-reader package, and the frontend
agent specs, so a missed registration fails CI rather than surfacing at
runtime.
"""

from __future__ import annotations

from .base import VendorSpec
from . import (
    aider,
    antigravity,
    claude,
    codex,
    copilot,
    cursor,
    grok,
    kilo,
    kimi,
    muse,
    opencode,
    pi,
    qwen,
)

_ALL: tuple[VendorSpec, ...] = (
    aider.SPEC,
    antigravity.SPEC,
    claude.SPEC,
    codex.SPEC,
    copilot.SPEC,
    cursor.SPEC,
    grok.SPEC,
    kilo.SPEC,
    kimi.SPEC,
    muse.SPEC,
    opencode.SPEC,
    pi.SPEC,
    qwen.SPEC,
)

VENDORS: dict[str, VendorSpec] = {spec.key: spec for spec in _ALL}


def vendor(key: str) -> VendorSpec | None:
    """The spec for ``key``, or None for unknown/non-vendor keys (terminal)."""
    return VENDORS.get(key)
