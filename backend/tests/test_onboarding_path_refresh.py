"""Tests for _refresh_path_from_login_shell() in onboarding_deps."""

from __future__ import annotations

import os
import shutil
import sys
from unittest.mock import patch, MagicMock
import subprocess

import pytest

# Import the private function directly for unit testing
from agent_team_backend import onboarding_deps
from agent_team_backend.onboarding_deps import (
    _path_probe_command,
    _refresh_path_from_login_shell,
    get_status,
)


# ── helpers ──────────────────────────────────────────────────────────────────


def _make_run_result(stdout: str, returncode: int = 0) -> MagicMock:
    result = MagicMock()
    result.stdout = stdout
    result.returncode = returncode
    return result


# ── merge order ──────────────────────────────────────────────────────────────


def test_new_paths_prepended(monkeypatch):
    """Paths returned by the shell that are absent from PATH should be prepended."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    shell_path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    with patch("subprocess.run", return_value=_make_run_result(shell_path + "\n")):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(":")
    assert parts[0] == "/opt/homebrew/bin"
    assert parts[1] == "/usr/local/bin"
    # original paths preserved after new ones
    assert "/usr/bin" in parts
    assert "/bin" in parts


def test_existing_paths_not_duplicated(monkeypatch):
    """Paths already in PATH must not appear twice after refresh."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    shell_path = "/usr/bin:/bin"
    with patch("subprocess.run", return_value=_make_run_result(shell_path + "\n")):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(":")
    assert parts.count("/usr/bin") == 1
    assert parts.count("/bin") == 1


# ── dedup ─────────────────────────────────────────────────────────────────────


def test_dedup_within_shell_output(monkeypatch):
    """Even if shell output contains duplicates, only first occurrence is added."""
    monkeypatch.setenv("PATH", "/usr/bin")
    shell_path = "/new/path:/new/path:/usr/bin"
    with patch("subprocess.run", return_value=_make_run_result(shell_path + "\n")):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(":")
    assert parts.count("/new/path") == 1


# ── timeout / garbage tolerance ───────────────────────────────────────────────


def test_timeout_swallowed(monkeypatch):
    """TimeoutExpired must not propagate; PATH unchanged (fallback disabled)."""
    monkeypatch.setattr(onboarding_deps, "_FALLBACK_PATH_DIRS", ())
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="bash", timeout=3)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


def test_oserror_swallowed(monkeypatch):
    """OSError (e.g. bash not found) must not propagate."""
    monkeypatch.setattr(onboarding_deps, "_FALLBACK_PATH_DIRS", ())
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=OSError("not found")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


def test_garbage_output_no_crash(monkeypatch):
    """Non-path garbage in stdout must not raise; PATH may be unchanged or extended."""
    monkeypatch.setenv("PATH", "/usr/bin")
    # Last non-empty line is used; if it has no valid paths nothing bad happens
    with patch("subprocess.run", return_value=_make_run_result("some banner text\n\n")):
        _refresh_path_from_login_shell()
    # Just assert it didn't raise and PATH is still set
    assert "PATH" in os.environ


def test_empty_stdout_no_crash(monkeypatch):
    """Empty stdout must not crash."""
    monkeypatch.setattr(onboarding_deps, "_FALLBACK_PATH_DIRS", ())
    original = "/usr/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", return_value=_make_run_result("")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


# ── fallback install prefixes ────────────────────────────────────────────────


def test_fallback_dirs_merged_when_probe_fails(monkeypatch, tmp_path):
    """Standard install prefixes are merged even when the login-shell probe fails."""
    fallback = tmp_path / "brew-bin"
    fallback.mkdir()
    monkeypatch.setattr(onboarding_deps, "_FALLBACK_PATH_DIRS", (str(fallback),))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="zsh", timeout=3)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"].split(":")[0] == str(fallback)


def test_fallback_dir_skipped_when_missing(monkeypatch, tmp_path):
    """A fallback prefix that does not exist on disk is not added."""
    monkeypatch.setattr(onboarding_deps, "_FALLBACK_PATH_DIRS", (str(tmp_path / "nope"),))
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=OSError("not found")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


def test_shell_paths_ordered_before_fallback(monkeypatch, tmp_path):
    """Shell-derived paths are prepended ahead of fallback prefixes."""
    fallback = tmp_path / "fb"
    fallback.mkdir()
    monkeypatch.setattr(onboarding_deps, "_FALLBACK_PATH_DIRS", (str(fallback),))
    monkeypatch.setenv("PATH", "/usr/bin")
    with patch("subprocess.run", return_value=_make_run_result("/shell/bin:/usr/bin\n")):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(":")
    assert parts[0] == "/shell/bin"
    assert parts[1] == str(fallback)


def test_last_line_used_when_banner_present(monkeypatch):
    """When shell emits a banner, the last non-empty line is treated as PATH."""
    monkeypatch.setenv("PATH", "/usr/bin")
    banner_then_path = "Welcome to zsh!\n/opt/homebrew/bin:/usr/bin\n"
    with patch("subprocess.run", return_value=_make_run_result(banner_then_path)):
        _refresh_path_from_login_shell()
    assert "/opt/homebrew/bin" in os.environ["PATH"].split(":")


# ── probe command shape ───────────────────────────────────────────────────────


def test_probe_uses_interactive_zsh(monkeypatch):
    """zsh reads ~/.zshrc only in interactive mode; installers (e.g. grok)
    write PATH exports there, so the probe must run zsh with -i."""
    monkeypatch.setenv("SHELL", "/bin/zsh")
    assert _path_probe_command() == ["/bin/zsh", "-ilc", "echo $PATH"]


def test_probe_uses_login_shell_for_non_zsh(monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/bash")
    assert _path_probe_command() == ["/bin/bash", "-lc", "echo $PATH"]


def test_probe_falls_back_to_bash_without_shell_env(monkeypatch):
    monkeypatch.delenv("SHELL", raising=False)
    assert _path_probe_command() == ["/bin/bash", "-lc", "echo $PATH"]


# ── non-POSIX no-op ───────────────────────────────────────────────────────────


def test_non_posix_noop(monkeypatch):
    """On non-POSIX platforms the function should be a no-op (no subprocess call)."""
    original = "/usr/bin"
    monkeypatch.setenv("PATH", original)
    monkeypatch.setattr(os, "name", "nt")
    with patch("subprocess.run") as mock_run:
        _refresh_path_from_login_shell()
    mock_run.assert_not_called()
    assert os.environ["PATH"] == original


# ── detection missing → ok after refresh ─────────────────────────────────────


def test_detection_missing_to_ok_after_refresh(monkeypatch, tmp_path):
    """
    Simulate a tool that is absent from the original PATH but present in the
    login-shell PATH. After refresh, detect_dep should find it as 'ok'.
    """
    from agent_team_backend.onboarding_deps import detect_dep, Dep

    # Create a fake 'mytool' binary that prints a version string
    fake_bin = tmp_path / "mytool"
    fake_bin.write_text("#!/bin/sh\necho 'mytool 1.2.3'\n")
    fake_bin.chmod(0o755)

    dep = Dep(
        id="mytool",
        label="My Tool",
        description="test tool",
        group="foundation",
        check_cmd=["mytool", "--version"],
        version_regex=r"(\d+\.\d+\.\d+)",
    )

    # Before refresh: tmp_path is not in PATH, so tool is missing
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    assert shutil.which("mytool") is None
    result_before = detect_dep(dep)
    assert result_before["status"] == "missing"

    # Simulate login shell returning a PATH that includes tmp_path
    shell_path_output = f"{tmp_path}:/usr/bin:/bin\n"
    with patch("subprocess.run", return_value=_make_run_result(shell_path_output)):
        _refresh_path_from_login_shell()

    # After refresh: tmp_path is now in os.environ["PATH"]
    assert str(tmp_path) in os.environ["PATH"].split(":")

    # detect_dep uses shutil.which which reads os.environ["PATH"]
    assert shutil.which("mytool") is not None

    # Now we need subprocess.run to actually run the real binary for detect_dep
    # Restore subprocess.run to real implementation
    result_after = detect_dep(dep)
    assert result_after["status"] == "ok"
    assert result_after["version"] == "1.2.3"
