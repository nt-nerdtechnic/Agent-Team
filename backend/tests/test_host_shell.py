import pytest

from agent_team_backend.host_shell import (
    HOST_SHELL_EXECUTABLE_ALLOWLIST,
    parse_allowlisted_command,
    run_allowlisted_text,
    validate_argv,
)


def test_allowlist_contains_git_and_issue_clis_only() -> None:
    assert HOST_SHELL_EXECUTABLE_ALLOWLIST == frozenset({"git", "gh", "glab"})


@pytest.mark.parametrize("argv", [["rm", "-rf", "."], ["/tmp/git", "status"], ["git\x00", "status"]])
def test_validate_argv_rejects_unapproved_or_path_qualified_executable(argv: list[str]) -> None:
    with pytest.raises(ValueError):
        validate_argv(argv)


def test_parse_command_rejects_shell_syntax() -> None:
    with pytest.raises(ValueError):
        parse_allowlisted_command("git status; rm -rf .")


@pytest.mark.asyncio
async def test_git_runs_through_exec_broker() -> None:
    rc, stdout, stderr = await run_allowlisted_text(["git", "--version"])
    assert rc == 0
    assert stdout.startswith("git version")
    assert stderr == ""


@pytest.mark.asyncio
async def test_run_broker_returns_validation_failure_instead_of_raising() -> None:
    rc, stdout, stderr = await run_allowlisted_text(["rm", "-rf", "."])
    assert rc == 126
    assert stdout == ""
    assert "not allowlisted" in stderr
