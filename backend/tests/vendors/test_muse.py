"""Muse Code vendor spec — identity, install detection, resume parsing, and
the deliberate absence of every other capability.

The unset-capability test is the point of this file: Muse Code's credential
layout, session-file location and log format are still unverified, and a
future round that fills one in should have to update this test consciously
rather than acquire half-working behaviour by accident.
"""

from __future__ import annotations

from agent_team_backend.cli_vendors.muse import SPEC
from agent_team_backend.cli_vendors.registry import VENDORS, vendor


def test_spec_is_registered_under_its_key() -> None:
    assert VENDORS["muse"] is SPEC
    assert vendor("muse") is SPEC
    assert SPEC.key == "muse"
    assert SPEC.label == "Muse Code"


def test_install_dep_detects_and_installs_the_cli() -> None:
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.id == "muse"
    assert dep.group == "agent_cli"
    assert dep.check_cmd == ["muse", "--version"]
    # Shell-script install (like aider), so curl must be present first and the
    # command runs in an external terminal for the interactive login.
    assert dep.install_cmd == "curl -fsSL https://dev.meta.ai/install.sh | sh"
    assert dep.requires_binaries == ("curl",)
    assert dep.needs_terminal is True
    assert dep.optional is True


def test_install_dep_claims_no_maintenance_commands() -> None:
    # Meta documents no update/doctor command and ships no npm package; the
    # wizard must fall back to docs_url rather than invent one.
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.update_cmd == ""
    assert dep.doctor_cmd == ""
    assert dep.npm_package == ""
    assert dep.docs_url


def test_resume_id_is_read_from_the_documented_subcommand() -> None:
    # Meta documents `muse resume <id>` — a subcommand, not a --flag.
    parse = SPEC.resume_id_from_command
    assert parse is not None
    assert parse("muse resume 4d4a11fe-b08a-46df-9f86-685589531e65") == (
        "4d4a11fe-b08a-46df-9f86-685589531e65")
    assert parse("muse resume abc --disable-approval") == "abc"
    # The real command is the last element of the frontend's shell wrapper.
    assert parse(["/bin/zsh", "-ilc", "muse resume abc"]) == "abc"


def test_non_resume_commands_yield_no_id() -> None:
    parse = SPEC.resume_id_from_command
    assert parse is not None
    assert parse("muse") == ""
    assert parse("muse resume") == ""
    assert parse("muse exec 'run the tests'") == ""
    # Never claim another vendor's command.
    assert parse("codex resume abc") == ""


def test_unverified_capabilities_stay_unset() -> None:
    assert SPEC.live_file is None
    assert SPEC.slot_file is None
    assert SPEC.login_home_secret_file is None
    assert SPEC.profile_home_secret_file is None
    assert SPEC.login_home_env is None
    assert SPEC.fetch_usage is None
    # Session lookup: the docs never state where a session file lands, so a
    # known id cannot be turned into a path. Both stay unset so the resume
    # preflight passes through rather than vetoing on a guessed location.
    assert SPEC.session_path is None
    assert SPEC.session_exists is None
    # No real session.jsonl sample to validate a reader against.
    assert SPEC.make_log_reader is None
    assert SPEC.home_env_vars == ()
    assert SPEC.interrupt_key is None
