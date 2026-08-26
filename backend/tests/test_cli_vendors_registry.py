"""Structural tests for the per-vendor registry.

These are the CI guardrails of the one-file-per-vendor refactor:

* drift — the registry's key set must stay in lockstep with every other
  place a vendor list exists (install detection, log readers, frontend
  specs), so "added a vendor but forgot a spot" fails here instead of
  surfacing at runtime;
* import graph — vendor modules must stay self-contained (no vendor→vendor
  or vendor→app edges), which is what keeps "add a vendor" a one-file PR.
"""

from __future__ import annotations

import ast
import inspect
import re
import sys
from pathlib import Path

from agent_team_backend.cli_vendors import registry
from agent_team_backend.cli_vendors.base import VendorSpec

REPO_ROOT = Path(__file__).resolve().parents[2]
VENDORS_DIR = REPO_ROOT / "backend" / "agent_team_backend" / "cli_vendors"
FRONTEND_AGENTS_DIR = (
    REPO_ROOT / "src" / "renderer" / "src" / "platform" / "plugin-shell" / "agents"
)

EXPECTED_KEYS = {
    "aider", "antigravity", "claude", "codex", "copilot", "cursor",
    "grok", "kilo", "kimi", "muse", "opencode", "pi", "qwen",
}

# DEPS entries that are infrastructure, not CLI vendors.
NON_VENDOR_DEPS = {"homebrew", "node", "ollama", "pnpm", "python", "uv"}

# Frontend-only pane type, not a CLI vendor.
NON_VENDOR_AGENT_KEYS = {"terminal"}

# Modules a vendor file may import. log_readers.base is the shared reader
# contract (safe direction: it imports no vendor); kilo→opencode is the
# single allowed vendor→vendor edge (reader class inheritance).
ALLOWED_LOCAL_IMPORTS = {"base", "_protocols", "applog", "log_readers.base", "skills_store", "usage_common"}
VENDOR_IMPORT_EXEMPTIONS = {"kilo": {"opencode"}}
ALLOWED_THIRD_PARTY = {"httpx", "yaml"}


def test_registry_matches_expected_vendor_set() -> None:
    assert set(registry.VENDORS) == EXPECTED_KEYS
    for key, spec in registry.VENDORS.items():
        assert isinstance(spec, VendorSpec)
        assert spec.key == key
        assert spec.label


def test_registry_matches_install_detection_deps() -> None:
    from agent_team_backend.onboarding_deps import DEPS

    dep_ids = {dep.id for dep in DEPS}
    assert set(registry.VENDORS) <= dep_ids
    assert dep_ids - set(registry.VENDORS) == NON_VENDOR_DEPS


def test_registry_matches_log_reader_package() -> None:
    reader_modules = {
        path.stem
        for path in (VENDORS_DIR.parent / "log_readers").glob("*.py")
        if not path.stem.startswith("_")
        and path.stem not in {"base", "watcher", "attribution"}
    }
    assert reader_modules == set(registry.VENDORS)


def test_registry_matches_frontend_agent_specs() -> None:
    # Read-only regex over the frontend source: the backend must not import
    # or execute TS, but the two sides must never disagree about who exists.
    # Canonical location since stage 2: one spec file per vendor under
    # src/renderer/src/platform/plugin-shell/agents/ (underscore files are templates, not specs).
    frontend_keys: set[str] = set()
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types"}:
            continue
        source = path.read_text(encoding="utf-8")
        frontend_keys |= set(re.findall(r"agentKey: '([a-z]+)'", source))
    assert frontend_keys - NON_VENDOR_AGENT_KEYS == set(registry.VENDORS)


# --- turn-end inference cross-check ----------------------------------------
#
# Why this test lives on the backend side: the fact being checked is a
# property of the reader implementation (does parse_activity synthesize the
# turn boundary from a quiet timer?), and only pytest can resolve that fact
# honestly — it imports the reader classes, so an inherited parse_activity
# (kilo reuses opencode's) is attributed to the module that really defines
# it instead of to the empty subclass file. Reading the frontend flag from
# here is just a regex over four `.ts` files, which this module already does
# for the vendor key set. The mirror-image test in vitest would have to fake
# Python inheritance by hand.
#
# Known fragility: the backend fact is derived from a NAME, so renaming the
# constant makes every silence-inferring vendor look like a record-reading
# one. The failure message says so; keep the pattern below in sync with the
# readers.
_IDLE_CONST_RE = re.compile(r"_TURN_IDLE_[A-Z_]+")
_FRONTEND_FLAG_RE = re.compile(
    r"^[ \t]*turnEndInferredFromSilence:\s*true", re.MULTILINE
)


def _reader_sources() -> dict[str, str]:
    """vendor key -> the vendor module that really defines its parse_activity.

    Resolved through the class, not the filename, so an inherited reader is
    attributed to the module holding the code (kilo reuses opencode's
    parse_activity, and kilo.py itself contains no turn logic at all).
    """
    sources: dict[str, str] = {}
    for key, spec in registry.VENDORS.items():
        assert spec.make_log_reader is not None, f"{key} has no make_log_reader"
        parse_activity = type(spec.make_log_reader()).parse_activity
        sources[key] = parse_activity.__module__.rsplit(".", 1)[-1]
    return sources


def _backend_infers_turn_end_from_silence() -> set[str]:
    """Vendors whose reader closes a turn on a quiet timer, from the source.

    The signal is a module-level `_TURN_IDLE_*` constant referenced inside
    the `parse_activity` the vendor's reader actually resolves to.
    """
    inferring: set[str] = set()
    for key, spec in registry.VENDORS.items():
        parse_activity = type(spec.make_log_reader()).parse_activity
        module = sys.modules[parse_activity.__module__]
        declared = {n for n in vars(module) if _IDLE_CONST_RE.fullmatch(n)}
        used = set(_IDLE_CONST_RE.findall(inspect.getsource(parse_activity)))
        if declared & used:
            inferring.add(key)
    return inferring


def _frontend_infers_turn_end_from_silence() -> set[str]:
    """Vendors whose frontend spec sets `turnEndInferredFromSilence: true`."""
    flagged: set[str] = set()
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types"}:
            continue
        source = path.read_text(encoding="utf-8")
        if not _FRONTEND_FLAG_RE.search(source):
            continue
        keys = set(re.findall(r"agentKey: '([a-z]+)'", source))
        assert len(keys) == 1, f"{path.name} declares agentKeys {sorted(keys)}"
        flagged |= keys
    return flagged


def test_turn_end_inference_flag_matches_reader_implementation() -> None:
    """`turnEndInferredFromSilence` must describe what the reader does.

    The flag is not documentation: `isTurnInFlight` uses it to open a
    20-second silence escape hatch, so a vendor flagged by mistake has its
    panes declared idle mid-tool-call and gets a message injected into a
    running turn; a vendor missing the flag stalls forever on inter-CLI
    messages. Commit 3b6f1d02 drifted exactly this way — cursor's reader
    started reporting real turn ends from store.db while the frontend flag
    stayed `true` — and nothing failed.
    """
    backend = _backend_infers_turn_end_from_silence()
    frontend = _frontend_infers_turn_end_from_silence()
    if backend == frontend:
        return

    sources = _reader_sources()
    hint = (
        "If a reader was renamed away from the `_TURN_IDLE_*` convention, "
        "this test's detection rule (_IDLE_CONST_RE in "
        "backend/tests/test_cli_vendors_registry.py) is what needs updating, "
        "not the vendors."
    )
    problems = []
    for key in sorted(backend - frontend):
        problems.append(
            f"  {key}: backend cli_vendors/{sources[key]}.py infers the turn "
            f"end from a _TURN_IDLE_* quiet timer, but "
            f"src/renderer/src/platform/plugin-shell/agents/{key}.ts does not set "
            f"`turnEndInferredFromSilence: true`. FIX THE FRONTEND: add the "
            f"flag — without it, messaging waits for a turn end that only a "
            f"timer will ever produce."
        )
    for key in sorted(frontend - backend):
        problems.append(
            f"  {key}: src/renderer/src/platform/plugin-shell/agents/{key}.ts sets "
            f"`turnEndInferredFromSilence: true`, but the reader in "
            f"cli_vendors/{sources[key]}.py reports a real turn-end record "
            f"(no _TURN_IDLE_* timer in the parse_activity it resolves to). "
            f"FIX THE FRONTEND: remove the flag — leaving it on makes "
            f"isTurnInFlight() call a busy pane idle after TURN_SILENCE_MS "
            f"and inject into a running turn."
        )
    raise AssertionError(
        "turn-end inference drifted between the reader implementation and the "
        "frontend agent spec:\n" + "\n".join(problems) + f"\n\n{hint}"
    )


def test_mcp_wiring_declares_exactly_one_surface() -> None:
    """A spawn dispatches on which surface field is set, so a spec with two
    would silently take the first branch and a spec with none would no-op —
    both of which look like "this CLI has no MCP" at runtime."""
    for key, spec in registry.VENDORS.items():
        wiring = spec.mcp_wiring
        if wiring is None:
            continue  # the CLI has no MCP surface at all
        surfaces = [
            name
            for name in ("flag", "config_env", "project_config", "config_file")
            if getattr(wiring, name)
        ]
        assert len(surfaces) == 1, (
            f"{key} declares MCP surfaces {surfaces} — exactly one is dispatched"
        )
        # Every surface but codex's TOML override carries a config document.
        if not wiring.flag_value:
            assert wiring.config is not None, f"{key} has no config vocabulary"
        # A project file is shared by every pane, so its URL can only be a
        # reference to a variable the spawn env carries.
        assert bool(wiring.url_env_template) == bool(wiring.project_config)


def test_push_channel_declares_exactly_one_mechanism() -> None:
    """Push delivery dispatches on which mechanism field is set, so a spec with
    two would silently take the first branch and a spec with none would leave
    the pane registered with a channel that can never carry anything."""
    for key, spec in registry.VENDORS.items():
        channel = spec.push_channel
        if channel is None:
            continue  # the CLI has no way in but its PTY
        mechanisms = [
            name
            for name in ("append_path", "input_file_flag", "hook_wait")
            if getattr(channel, name)
        ]
        assert len(mechanisms) == 1, (
            f"{key} declares push mechanisms {mechanisms} — exactly one is dispatched"
        )
        if channel.append_path:
            # A composer that can be appended to has to be submittable, and a
            # failed submit has to be undoable or the fallback types it twice.
            assert channel.submit_path and channel.clear_path, key
            assert channel.port_flag, f"{key} serves HTTP but pins no port"
            # A password nothing authenticates with locks the CLI out of its own
            # server (opencode), so the two travel together or not at all.
            assert bool(channel.password_env) == bool(channel.username), key
        if channel.input_file_flag:
            assert channel.record_type, f"{key} writes records with no type"


def test_push_channel_matches_the_frontend_agent_spec() -> None:
    """The two sides declare different halves of one channel: the backend owns
    the transport, the frontend owns which delivery gates still apply. A vendor
    wired on one side only is a channel that is either never used or used
    without its gates."""
    backend = {
        key: (
            "tui-http"
            if spec.push_channel.append_path
            else "input-file"
            if spec.push_channel.input_file_flag
            else "rewake"
        )
        for key, spec in registry.VENDORS.items()
        if spec.push_channel is not None
    }
    frontend: dict[str, str] = {}
    holds: dict[str, bool] = {}
    for path in FRONTEND_AGENTS_DIR.glob("*.ts"):
        if path.stem.startswith("_") or path.stem in {"index", "types"}:
            continue
        source = path.read_text(encoding="utf-8")
        match = re.search(
            r"pushChannel:\s*\{\s*kind:\s*'([a-z-]+)'"
            r"(?:\s*,\s*holdsInputBox:\s*(true|false))?",
            source,
        )
        if match is None:
            continue
        keys = set(re.findall(r"agentKey: '([a-z]+)'", source))
        assert len(keys) == 1, f"{path.name} declares agentKeys {sorted(keys)}"
        key = keys.pop()
        frontend[key] = match.group(1)
        holds[key] = match.group(2) == "true"

    assert backend == frontend, (
        "push channels drifted between cli_vendors/<key>.py and "
        f"src/renderer/src/platform/plugin-shell/agents/<key>.ts: backend={backend} frontend={frontend}"
    )
    for key, spec in registry.VENDORS.items():
        if spec.push_channel is None:
            continue
        assert holds[key] == spec.push_channel.holds_input_box, (
            f"{key}: holdsInputBox disagrees with holds_input_box — the typing "
            f"hold would be applied to a channel that does not need it, or "
            f"skipped for one that does"
        )


def test_vendor_modules_import_only_allowed_modules() -> None:
    for path in sorted(VENDORS_DIR.glob("*.py")):
        if path.stem.startswith("_") or path.stem in {"base", "registry"}:
            continue
        allowed_local = (
            ALLOWED_LOCAL_IMPORTS | VENDOR_IMPORT_EXEMPTIONS.get(path.stem, set())
        )
        tree = ast.parse(path.read_text(encoding="utf-8"))
        # Module-level imports only: an import inside a function is a lazy
        # runtime backreference (the pre-existing pattern of the migrated
        # claude machines) and cannot create an import cycle.
        for node in tree.body:
            if isinstance(node, ast.ImportFrom):
                if node.level:  # relative: from .base / ..log_readers.base
                    module = node.module or ""
                    if module == "":  # from . import _protocols, base, ...
                        for alias in node.names:
                            assert alias.name in allowed_local, (
                                f"{path.name} imports .{alias.name} — vendor "
                                f"modules may only import "
                                f"{sorted(allowed_local)} locally"
                            )
                        continue
                    assert module in allowed_local, (
                        f"{path.name} imports .{node.module} — vendor modules "
                        f"may only import {sorted(allowed_local)} locally"
                    )
                else:
                    root = (node.module or "").split(".")[0]
                    _assert_absolute_import_allowed(path.name, root)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    _assert_absolute_import_allowed(
                        path.name, alias.name.split(".")[0]
                    )


def _assert_absolute_import_allowed(filename: str, root: str) -> None:
    import sys

    stdlib = root in sys.stdlib_module_names
    assert stdlib or root in ALLOWED_THIRD_PARTY, (
        f"{filename} imports {root!r} — vendor modules are limited to the "
        f"standard library and {sorted(ALLOWED_THIRD_PARTY)}; app modules "
        "must depend on vendors, never the reverse"
    )
