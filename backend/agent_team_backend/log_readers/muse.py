"""Placeholder — muse ships no log reader yet.

Every registered vendor needs a module here: ``test_cli_vendors_registry``
keeps this package's module set equal to the registry's key set, so a vendor
whose reader is not written yet still declares its slot. Muse Code's local
conversation-log format has not been verified against a real installation, so
``cli_vendors.muse`` leaves ``make_log_reader`` unset and this module exports
nothing.
"""

from __future__ import annotations

__all__: list[str] = []
