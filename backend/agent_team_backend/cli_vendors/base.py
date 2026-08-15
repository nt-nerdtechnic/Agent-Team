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
from enum import Enum
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


class McpValue(Enum):
    """What a declarative server record cannot know: the server's identity.

    A vendor module may not import the plugin that serves an MCP endpoint, so
    the record below is a template — these stand in for the values the server's
    owner supplies, and ``mcp_entry`` substitutes them."""

    NAME = "name"
    LABEL = "label"
    URL = "url"


@dataclass(frozen=True)
class McpServerConfig:
    """The vocabulary one CLI reads MCP servers in.

    Verbatim shapes: every CLI names the transport differently (``type: http``,
    a bare ``httpUrl``, ``type: remote``) and rejects the others, so this is
    described rather than normalised.
    """

    # Path to the container holding server records inside the document, e.g.
    # ("mcpServers",). Every level but the last is a plain map.
    section: tuple[str, ...]
    # One record's fields in the order the CLI's own config writes them, with
    # McpValue members standing in for the server's identity.
    entry: tuple[tuple[str, Any], ...]
    # Document-level fields the CLI expects beside the section, e.g. opencode's
    # "$schema". Written only where the document does not have them already.
    document: tuple[tuple[str, Any], ...] = ()
    # Non-empty when the container is a LIST of self-identifying records rather
    # than a map keyed by the server name: the field our record is recognised
    # by, so a previous run's entry is replaced instead of duplicated.
    list_key: str = ""


@dataclass(frozen=True)
class McpWiring:
    """How a pane spawn points this CLI at an MCP server.

    Which fields are set selects the surface, and a CLI offers exactly one:
    ``flag`` (a spawn-time command-line flag), ``config_env`` (a variable
    carrying a whole config document), ``project_config`` (a file in the
    workspace) or ``config_file`` (a file in the CLI's own config directory,
    which the caller has to shim per pane). A CLI with no MCP surface at all
    declares no wiring.

    Declarative by necessity, like ``Dep``: the endpoint belongs to a plugin,
    and a vendor module must not import one.
    """

    config: McpServerConfig | None = None

    # --- spawn-time flag ---
    flag: str = ""
    # The flag's value as a format template over {name} and {url}; empty means
    # the JSON config document itself (codex takes a TOML override instead).
    flag_value: str = ""
    # Substring whose presence in a command means "leave it alone" — already
    # wired by us, or wired by the user and not ours to second-guess. Format
    # template over {flag} and {name}.
    already_wired: str = "{flag}"
    # The flag also accepts a path, so a spawn that cannot use a per-spawn
    # document can be handed a config file instead.
    flag_accepts_path: bool = False

    # --- whole config document in an environment variable ---
    config_env: str = ""

    # --- config file in the workspace, relative to the pane's cwd ---
    project_config: tuple[str, ...] = ()
    # The CLI interpolates an environment variable inside the URL, in this
    # syntax (%s = the variable name). A project file is shared by every pane
    # in the workspace, so only a variable can carry a per-pane URL.
    url_env_template: str = ""

    # --- config file in the CLI's own config directory ---
    config_dir: str = ""               # relative to the real home, e.g. ".grok"
    config_dir_env: str = ""           # variable relocating it; "" = the CLI has none
    config_file: tuple[str, ...] = ()  # relative to config_dir


@dataclass(frozen=True)
class SkillsWiring:
    """How a pane spawn points this CLI at a directory of managed skills.

    A CLI offers exactly one surface: ``flag`` (a repeatable command-line
    flag) or ``config_env`` (a variable carrying a whole config document). A
    CLI with no skills mechanism at all declares no wiring, which is what the
    UI reads to mark it unavailable rather than merely switched off.

    Declarative like ``McpWiring``: the skills library belongs to a plugin,
    and a vendor module must not import one.
    """

    # --- repeatable spawn-time flag ---
    flag: str = ""
    # What one occurrence of the flag takes: the directory holding every skill
    # ("root"), or a single skill's own directory, repeated per skill ("each").
    flag_takes: str = "root"
    # The flag suppresses the CLI's own discovery, so whatever it would have
    # found has to be passed back alongside ours or the user silently loses
    # their own skills.
    replaces_discovery: bool = False
    # Discovery roots to re-add when ``replaces_discovery``: paths under the
    # user's home, then paths under the pane's working directory. Only the
    # ones that exist are passed.
    discovery_home: tuple[tuple[str, ...], ...] = ()
    discovery_project: tuple[tuple[str, ...], ...] = ()

    # --- whole config document in an environment variable ---
    config_env: str = ""
    # Where the list of skill roots lives inside that document.
    config_paths_key: tuple[str, ...] = ()

    # --- a directory the CLI reads out of its own config home ---
    # The variable relocating that home. "HOME" is accepted but is a blunt
    # instrument: the shim mirrors the real home so the pane still sees
    # everything else the user has.
    root_env: str = ""
    # Where the real root sits under the user's home; () means the home itself.
    root_home: tuple[str, ...] = ()
    # The skills directory relative to that root.
    skills_rel: tuple[str, ...] = ()

    # --- a directory the CLI reads out of the workspace ---
    # Last resort for a CLI with no relocation variable: the path is inside the
    # user's own repository, so only our own entries may ever be written or
    # removed there.
    project_rel: tuple[str, ...] = ()

    # Layout the view directory must have for this CLI to find skills below
    # the path we hand it; empty means the skills sit directly in the view.
    view_layout: tuple[str, ...] = ()
    # Substring whose presence in a command means the spawn is already wired.
    already_wired: str = ""


def mcp_entry(
    config: McpServerConfig, *, name: str, label: str, url: str
) -> dict[str, Any]:
    """One server record in ``config``'s vocabulary, placeholders resolved."""
    supplied = {McpValue.NAME: name, McpValue.LABEL: label, McpValue.URL: url}
    return {
        key: (supplied[value] if isinstance(value, McpValue) else value)
        for key, value in config.entry
    }


def mcp_document(
    config: McpServerConfig,
    existing: dict[str, Any],
    *,
    name: str,
    label: str = "",
    url: str,
) -> dict[str, Any]:
    """``existing`` with this server's record merged in.

    Pure data in, data out: the caller owns the file (or the flag value, or the
    variable) and the server's identity. An ``existing`` of ``{}`` builds the
    document from scratch. Anything already in the container that is not ours
    is kept — a user's own servers are never displaced.
    """
    document = dict(existing)
    for key, value in config.document:
        document.setdefault(key, value)
    node = document
    for step in config.section[:-1]:
        child = node.get(step)
        child = dict(child) if isinstance(child, dict) else {}
        node[step] = child
        node = child
    leaf = config.section[-1]
    record = mcp_entry(config, name=name, label=label, url=url)
    if config.list_key:
        items = node.get(leaf)
        ours = record.get(config.list_key)
        kept = [
            item
            for item in (items if isinstance(items, list) else [])
            if isinstance(item, dict) and item.get(config.list_key) != ours
        ]
        kept.append(record)
        node[leaf] = kept
    else:
        servers = node.get(leaf)
        node[leaf] = {
            **(servers if isinstance(servers, dict) else {}),
            name: record,
        }
    return document


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

    # --- MCP wiring ---
    # How a spawn points this CLI at an MCP server. None = the CLI has no MCP
    # surface at all (aider, muse, pi).
    mcp_wiring: McpWiring | None = None

    # --- skills wiring ---
    # How a spawn points this CLI at the managed skills library. None = the
    # CLI has no skills mechanism (kilo, aider), or Navide has not wired the
    # one it has yet; ``skills_supported`` tells those two apart.
    skills_wiring: SkillsWiring | None = None
    # The CLI has a skills mechanism, verified against the binary or its
    # official docs. False = no such feature exists to wire.
    skills_supported: bool = False

    # --- log reading ---
    # () -> LogReader instance for this vendor. None = reader not migrated
    # (still constructed from log_readers/<key>.py by the legacy list).
    make_log_reader: Callable[[], Any] | None = None

    # --- install wizard (mirrors the legacy onboarding_deps agent_cli table) ---
    # This vendor's install/detect/update entry; onboarding_deps aggregates it.
    install_dep: Dep | None = None

    # --- lifecycle hooks ---
    # (backend_port_file: str) -> install result. Set when this CLI can be
    # configured to POST turn/permission events to /hooks/<key>, which is a
    # 100%-reliable signal the PTY cannot provide. Declaring it both installs
    # the hooks at startup and admits the vendor to that endpoint, so a vendor
    # cannot be one without the other. None = no hook mechanism.
    install_hooks: Callable[[str], Any] | None = None
