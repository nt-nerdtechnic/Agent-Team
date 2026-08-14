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
class Dep:
    """One install-wizard dependency: how to detect a tool and (where safe)
    how to install/update it. Vendor modules declare their own entry via
    ``VendorSpec.install_dep``; ``onboarding_deps`` aggregates them with the
    non-vendor foundation/analyzer entries and drives the wizard."""

    id: str
    label: str
    description: str
    group: str                       # 'foundation' | 'agent_cli' | 'analyzer'
    check_cmd: list[str]             # e.g. ['node', '--version']
    version_regex: str = r"(\d+\.\d+(?:\.\d+)?)"
    # Other executable names the SAME tool ships as (a vendor rename leaves the
    # old name on older installs). Probed in order only when check_cmd[0] is not
    # on PATH, so a machine carrying the legacy binary is not reported missing.
    alt_commands: tuple[str, ...] = ()
    min_version: str = ""            # '' = any version is fine
    install_cmd: str = ""            # shell command (whitelist); '' = no auto-install
    needs_terminal: bool = False     # interactive (sudo / OAuth) → external Terminal
    optional: bool = False
    docs_url: str = ""
    # Binaries install_cmd itself invokes (brew, npm). Checked before running it
    # so a missing bootstrap tool reports "install brew first" instead of a bare
    # exit 127 — on a fresh Mac every brew-based install used to fail this way.
    requires_binaries: tuple[str, ...] = ()
    # Maintenance — the CLI's OWN official commands. Navide never wraps, parses
    # or replaces them; it only surfaces and runs them. '' = the vendor ships no
    # such command, in which case the UI points at docs_url instead of guessing.
    update_cmd: str = ""             # e.g. 'claude update'
    doctor_cmd: str = ""             # e.g. 'claude doctor'
    npm_package: str = ""            # npm package name when installable via npm
    # Where the CLI itself records the outcome of its own auto-update. Navide
    # only reads what the vendor already wrote to disk.
    update_state_file: str = ""      # relative to a config home, e.g. '.last-update-result.json'
    config_home_env: str = ""        # env var overriding the config home, e.g. 'CLAUDE_CONFIG_DIR'
    config_home_default: str = ""    # default config home relative to $HOME, e.g. '.claude'
    autoupdate_env: str = ""         # vendor's own opt-out env var, e.g. 'DISABLE_AUTOUPDATER'


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

    # Env var that relocates the CLI's config home for an isolated login
    # pane ({VAR: <login-home>} with no removals). None = the vault's legacy
    # branch (claude adds env removals, grok builds a HOME shim — both stay
    # in the vault by design).
    login_home_env: str | None = None

    # Arguments that turn this CLI's binary into its direct sign-in trigger,
    # e.g. "auth login". A login pane keeps the resolved binary and replaces
    # everything after it with these, so YOLO flags never reach an auth
    # subcommand. Two distinct empty-ish values:
    #   None -> the CLI has no sign-in invocation; leave the command alone.
    #   ""   -> signing in IS the bare binary (grok's TUI prompts on launch),
    #           so the flags are still stripped but nothing is appended.
    login_command_args: str | None = None

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

    # --- install wizard (mirrors the legacy onboarding_deps agent_cli table) ---
    # This vendor's install/detect/update entry; onboarding_deps aggregates it.
    install_dep: Dep | None = None
