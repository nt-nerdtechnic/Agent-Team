import pytest

from agent_team_backend.host_shell import (
    HOST_SHELL_EXECUTABLE_ALLOWLIST,
    parse_allowlisted_command,
    parse_public_allowlisted_command,
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


@pytest.mark.parametrize(
    "command",
    [
        "git -c alias.pwn=!sh pwn",
        "git --config-env=credential.helper=TOKEN status",
        "git -C ../outside status",
        "git --git-dir=/tmp/repo status",
        "git --work-tree=/tmp/tree status",
        "git --exec-path=/tmp status",
        "git fetch --upload-pack=/tmp/helper origin",
        "git push --receive-pack=/tmp/helper origin",
        "git credential fill",
        "git config user.email attacker@example.com",
        "git difftool",
        "git mergetool",
        "git filter-branch",
        "git hook run pre-commit",
        "git send-email patch.txt",
        "git submodule foreach sh -c true",
        "git bisect run ./script",
        "git rebase --exec ./script main",
        "git rebase -x ./script main",
        "git made-up-external-command",
        "git apply ../outside.patch",
        "git clone https://github.com/acme/repo.git /tmp/repo",
        "gh auth token",
        "gh alias set pwn 'api user'",
        "gh extension exec owner/tool",
        "gh made-up-extension",
        "gh api --input /etc/passwd",
        "glab auth status",
        "glab alias set pwn api",
        "glab token list",
        "glab made-up-extension",
        "glab api --input ../../secret.json",
    ],
)
def test_public_allowlist_rejects_execution_and_credential_escape_hatches(command: str) -> None:
    with pytest.raises(ValueError):
        parse_public_allowlisted_command(command)


@pytest.mark.parametrize(
    "command",
    [
        "git status --short",
        "git --no-pager log -5 --oneline",
        "git diff --stat",
        "git branch --show-current",
        "git fetch origin",
        "git pull --ff-only",
        "git push origin HEAD",
        "gh issue list --limit 10",
        "gh pr view 123",
        "glab issue list",
        "glab mr view 123",
    ],
)
def test_public_allowlist_accepts_supported_git_and_provider_commands(command: str) -> None:
    assert parse_public_allowlisted_command(command)[0] in HOST_SHELL_EXECUTABLE_ALLOWLIST


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
