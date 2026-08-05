from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time

import pytest

# Importing `app` below instantiates the module-level stores; since the SQLite
# migration that import moves real JSON stores into navide.db (renaming the
# sources). Point app-data at a throwaway dir BEFORE the import so collecting
# tests can never migrate the developer's real app data.
os.environ.setdefault(
    "AGENT_TEAM_DATA_DIR", tempfile.mkdtemp(prefix="agent-team-tests-")
)

from agent_team_backend import app
from agent_team_backend.credential_vault import CredentialVault


@pytest.fixture(autouse=True)
def _no_real_claude_cli(monkeypatch):
    """Never let a test start the developer's Claude Code.

    Claude quota is read by driving the CLI's own ``/usage`` panel, so an
    unstubbed poll would spawn a real Claude Code — seconds per test, the
    user's MCP servers, and their live account read for no reason. Tests that
    care about the numbers stub ``usage_service.fetch_claude``; this only makes
    the accident impossible."""
    from agent_team_backend import claude_cli_usage

    async def _refuse(*_args, **_kwargs):
        raise AssertionError(
            "a test tried to read Claude usage through the real CLI; "
            "stub usage_service.fetch_claude instead"
        )

    monkeypatch.setattr(claude_cli_usage, "fetch_claude_usage_via_cli", _refuse)


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Keep app-data side effects (e.g. pty-registry.json written on every
    TerminalService.create) out of the real app-data dir during tests."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path))


@pytest.fixture(autouse=True)
def _isolated_credential_vault(tmp_path, monkeypatch):
    """Tests must NEVER touch the real home or the real Keychain: swap the
    app-wide vault for one rooted in tmp with a security runner that always
    reports 'not found' (the security CLI's exit code 44 — anything else
    means a transient failure and makes strict capture reads raise)."""
    vault = CredentialVault(
        root=tmp_path / "vault-root",
        real_home=tmp_path / "vault-home",
        security_runner=lambda args, input_text=None: (44, ""),
    )
    monkeypatch.setattr(app, "credential_vault", vault)


@pytest.fixture(autouse=True)
def _reset_terminal_singleton():
    """The TerminalService is an app-level singleton (terminals outlive a single
    ws connection) bound to the running event loop. pytest-asyncio uses a fresh
    loop per test, so reset the singleton and the active-session pointer before
    and after each test to keep them isolated and bound to the current loop.
    _PTY_OWNERS is likewise process-global (cli_profiles.set_default consults it
    for the running-pane guard) and must not leak between tests."""
    app._TERMINALS = None
    app._active_session = None
    app._PTY_OWNERS.clear()
    yield
    app._TERMINALS = None
    app._active_session = None
    app._PTY_OWNERS.clear()


# ---- shared helpers for the PTY kill/reap tests ----
# (test_terminals_breakaway_kill.py and test_terminals_exit_orphan_reap.py
# exercise the same ps/kill machinery; the timing-sensitive harness lives here
# once so flake fixes land in one place.)


@pytest.fixture
def fake_ps():
    """Factory for a subprocess.run stub that yields `table` as ps stdout."""
    def make(table: str):
        def run(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 0, stdout=table, stderr="")
        return run
    return make


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.fixture
def pid_alive():
    """Signal-0 liveness probe."""
    return _pid_alive


@pytest.fixture
def wait_pid_dead():
    """Poll until pid is gone (or timeout); returns True when it died."""
    def wait(pid: int, timeout: float = 2.0) -> bool:
        deadline = time.time() + timeout
        while _pid_alive(pid) and time.time() < deadline:
            time.sleep(0.02)
        return not _pid_alive(pid)
    return wait


@pytest.fixture
def setsid_grandchild():
    """Spawn a `sh` parent (own session) that backgrounds a python grandchild
    which setsid()s into its OWN session/group, wait until the breakaway is
    visible, and yield (parent, grand_pid). Teardown SIGKILLs both. This is
    the escape shape that killpg(parent group) cannot reach — the orphan class
    both kill-path and exit-path reap tests target."""
    grand_script = "import os, time; os.setsid(); print('ready', flush=True); time.sleep(30)"
    parent = subprocess.Popen(
        ["sh", "-c", f'{sys.executable} -c "{grand_script}" & echo $!; wait'],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    grand_pid = None
    try:
        grand_pid = int(parent.stdout.readline().strip())
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                if os.getpgid(grand_pid) == grand_pid != os.getpgid(parent.pid):
                    break
            except ProcessLookupError:
                pass
            time.sleep(0.02)
        assert os.getpgid(grand_pid) == grand_pid, "grandchild never broke away"
        yield parent, grand_pid
    finally:
        for pid in filter(None, [grand_pid, parent.pid]):
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            parent.wait(timeout=2)
        except Exception:
            pass
