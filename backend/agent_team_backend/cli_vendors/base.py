"""Per-vendor CLI knowledge — the one-file-per-vendor contract.

Every piece of code that concerns exactly one CLI vendor (usage reading,
credential file layout, resume-id parsing, session lookup, env vars, log
reader, attribution quirks) lives in that vendor's module in this package.
Shared modules are allowed to contain orchestration only — no per-vendor
branches; multi-vendor wire protocols live in ``_protocols.py``.

Migration model (strangler fig): every capability field below defaults to
``None``, meaning "not migrated yet". Dispatch sites consult the registry
first and fall back to their legacy branch when the field is ``None``, so an
empty spec changes nothing. A vendor's round moves its knowledge here and
deletes the legacy branch; the final cleanup round removes the bridges.

Vendor modules may import only this module, ``_protocols``, the standard
library, and httpx (enforced by ``test_cli_vendors_registry.py``); the single
exception is kilo importing opencode's reader class (inheritance, not logic
sprawl). In particular a vendor module must never import app/ws/vault
modules — those import the registry, and a back-edge would be a cycle.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


def command_text(command: Any) -> str:
    """Actual CLI command string from a terminal.create payload.

    The frontend wraps agent commands as [shell, '-ilc'|'-lc', '<cmd>'] — the
    real command is the LAST element. Plain strings pass through unchanged.
    Shared helper for every vendor's ``resume_id_from_command``.
    """
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


@dataclass(frozen=True)
class VendorSpec:
    """Everything the shared orchestration knows about one CLI vendor.

    ``key`` and ``label`` are mandatory identity; every other field is a
    capability that is ``None`` until that vendor's migration round fills it.
    Field shapes mirror the legacy structures they replace so rounds are
    mechanical moves, not redesigns.
    """

    key: str
    label: str

    # --- credentials (mirrors credential_vault's four per-agent tables) ---
    # Path parts of the live credential file under the real home,
    # e.g. (".codex", "auth.json").
    live_file: tuple[str, ...] | None = None
    # Filename of the parked copy inside the vendor's slot directory.
    slot_file: str | None = None
    # Path parts of the secret inside an isolated login home; None for
    # vendors whose login home holds no file-readable secret (claude).
    login_home_secret_file: tuple[str, ...] | None = None
    # Path parts of the secret inside a legacy profile home.
    profile_home_secret_file: tuple[str, ...] | None = None

    # Display identity for the accounts UI: (secret) -> {email, signedIn}.
    # None = the vault's legacy per-agent branch (or token-presence default).
    identity_from_secret: Callable[[str | None], dict] | None = None

    # --- usage quota ---
    # async (home: Path) -> snapshot dict, same shape usage_service._snapshot
    # produces. None = vendor has no quota interface (aider) or not migrated.
    fetch_usage: Callable[[Path], Any] | None = None

    # --- resume / session ---
    # (command) -> session id the launch command targets, "" when none.
    resume_id_from_command: Callable[[Any], str] | None = None
    # (workspace_path: str, session_id: str) -> the single stable path the
    # resume preflight checks, or None when the vendor has no such path.
    session_path: Callable[[str, str], Path | None] | None = None
    # (workspace_path: str, session_id: str) -> session exists on disk.
    session_exists: Callable[[str, str], bool] | None = None

    # --- spawn environment ---
    # Env var names that relocate this CLI's home/config; the backend strips
    # them from inherited env at startup and from probe spawns.
    home_env_vars: tuple[str, ...] = ()
    # Byte sent to interrupt the CLI in its PTY; None = legacy default (^C).
    interrupt_key: bytes | None = None

    # --- log reading ---
    # () -> LogReader instance for this vendor. None = reader not migrated
    # (still constructed from log_readers/<key>.py by the legacy list).
    make_log_reader: Callable[[], Any] | None = None
