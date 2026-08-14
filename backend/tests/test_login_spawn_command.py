"""Login panes jump straight into the CLI's sign-in flow.

The sign-in trigger is per-vendor knowledge read from `login_command_args`.
This module had no coverage while the table lived in app.py, so these tests
pin the behaviour the table used to encode — including the distinction that is
easy to lose in a move: `None` (no sign-in invocation, leave the command
alone) versus `""` (sign-in IS the bare binary, so strip the flags and append
nothing).
"""

from __future__ import annotations

from agent_team_backend.app import _login_spawn_command
from agent_team_backend.cli_vendors.registry import VENDORS


def test_appends_the_vendors_auth_subcommand() -> None:
    assert _login_spawn_command("claude", "claude") == "claude auth login"
    assert _login_spawn_command("codex", "codex") == "codex login"
    assert _login_spawn_command("kimi", "kimi") == "kimi login"
    assert _login_spawn_command("kilo", "kilo") == "kilo auth login"


def test_drops_yolo_flags_that_do_not_apply_to_auth() -> None:
    command = "claude --dangerously-skip-permissions --continue"

    assert _login_spawn_command("claude", command) == "claude auth login"


def test_empty_args_strip_flags_without_appending() -> None:
    # grok has no auth subcommand: its TUI starts first-run auth on a bare
    # launch. Empty must not behave like None (which would keep the flags).
    assert _login_spawn_command("grok", "grok --yolo") == "grok"


def test_vendor_without_a_sign_in_invocation_is_left_alone() -> None:
    command = "aider --restore-chat-history"

    assert _login_spawn_command("aider", command) == command


def test_unknown_agent_key_is_left_alone() -> None:
    assert _login_spawn_command("not-a-vendor", "whatever --flag") == "whatever --flag"


def test_keeps_an_overridden_binary_path() -> None:
    # _command_with_persisted_cli_binary may have replaced the bare name with
    # an absolute path; the rewrite must build on that, not on the vendor key.
    command = "/opt/homebrew/bin/codex --dangerously-bypass-approvals"

    assert _login_spawn_command("codex", command) == "/opt/homebrew/bin/codex login"


def test_preserves_the_shell_wrapper() -> None:
    command = ["/bin/zsh", "-lc", "claude --dangerously-skip-permissions"]

    assert _login_spawn_command("claude", command) == [
        "/bin/zsh",
        "-lc",
        "claude auth login",
    ]


def test_every_declared_trigger_still_produces_a_command() -> None:
    # Guards the move itself: a vendor that declares the field must actually
    # rewrite, so a typo'd or misplaced value cannot pass silently.
    declared = [k for k, s in VENDORS.items() if s.login_command_args is not None]

    assert set(declared) == {"claude", "codex", "kimi", "grok", "kilo"}
    for key in declared:
        rewritten = _login_spawn_command(key, f"{key} --some-flag")
        assert rewritten.startswith(key), key
        assert "--some-flag" not in rewritten, key
