"""Antigravity — per-vendor knowledge (see base.py for the contract).

Shell only for now: capabilities migrate here in this vendor's round of the
one-file-per-vendor refactor; until then dispatch sites fall back to their
legacy branches.
"""

from .base import VendorSpec

SPEC = VendorSpec(key="antigravity", label="Antigravity")
