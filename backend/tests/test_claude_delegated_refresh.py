"""Delegated Claude refresh: the CLI renews, this app only observes.

The load-bearing invariant is that nothing here mints a token — success is
"the live secret changed after the CLI probe ran", never "the probe exited 0".
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import asyncio

import pytest

from agent_team_backend import claude_delegated_refresh as dr


class FakeVault:
    """Live secret only — the probe touches whatever account is live."""

    def __init__(self, secret: str | None = "live-a") -> None:
        self.secret = secret
        self.reads = 0

    def read_live(self, agent_key: str) -> SimpleNamespace:
        self.reads += 1
        if self.secret is RAISE:
            raise RuntimeError("keychain denied")
        return SimpleNamespace(secret=self.secret)


RAISE = object()


@pytest.fixture(autouse=True)
def _reset() -> Any:
    dr.reset_state_for_testing()
    yield
    dr.reset_state_for_testing()


def _stub_probe(
    monkeypatch: pytest.MonkeyPatch,
    *,
    ran: bool = True,
    detail: str = "",
    on_run=None,
) -> list[tuple[str, float]]:
    calls: list[tuple[str, float]] = []

    async def fake_probe(binary: str, timeout: float) -> tuple[bool, str]:
        calls.append((binary, timeout))
        if on_run is not None:
            on_run()
        return ran, detail

    monkeypatch.setattr(dr, "_run_probe", fake_probe)
    monkeypatch.setattr(
        "agent_team_backend.ai_chat_cli_engine.resolve_cli_binary",
        lambda engine="claude": "/usr/local/bin/claude",
    )
    return calls


async def test_reports_refreshed_when_the_cli_renewed_the_credential(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = FakeVault("old-secret")
    calls = _stub_probe(
        monkeypatch, on_run=lambda: setattr(vault, "secret", "renewed-secret")
    )

    assert await dr.attempt(vault) == dr.OUTCOME_REFRESHED
    assert len(calls) == 1
    # A renewal leaves the gate open — the caller re-reads straight away.
    assert dr.cooldown_remaining_seconds() == 0.0


async def test_a_probe_that_renewed_nothing_is_not_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The probe exiting 0 proves nothing; only the secret changing does."""
    vault = FakeVault("same")
    _stub_probe(monkeypatch)

    assert await dr.attempt(vault) == dr.OUTCOME_UNCHANGED
    assert dr.cooldown_remaining_seconds() > 0


async def test_cooldown_blocks_the_next_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    vault = FakeVault("same")
    calls = _stub_probe(monkeypatch)

    assert await dr.attempt(vault) == dr.OUTCOME_UNCHANGED
    assert await dr.attempt(vault) == dr.OUTCOME_SKIPPED_COOLDOWN
    assert len(calls) == 1  # the CLI ran once, not once per poll


async def test_a_failing_probe_backs_off_fully(monkeypatch: pytest.MonkeyPatch) -> None:
    vault = FakeVault("same")
    _stub_probe(monkeypatch, ran=False, detail="exit 1")

    assert await dr.attempt(vault) == dr.OUTCOME_FAILED
    assert dr.cooldown_remaining_seconds() > dr.SHORT_COOLDOWN_S


async def test_consecutive_failures_escalate_to_the_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A declined Keychain dialog fails the probe. A flat retry would put that
    dialog back on screen every poll, so the wait grows and then holds."""
    vault = FakeVault("same")
    _stub_probe(monkeypatch, ran=False, detail="denied")
    waits: list[float] = []

    for _ in range(len(dr.FAILURE_BACKOFF_S) + 2):
        dr._arm_cooldown(0)  # let the next attempt through; keep the streak
        assert await dr.attempt(vault) == dr.OUTCOME_FAILED
        waits.append(round(dr.cooldown_remaining_seconds()))

    assert waits[: len(dr.FAILURE_BACKOFF_S)] == [
        round(s) for s in dr.FAILURE_BACKOFF_S
    ]
    # Past the last step it holds at the ceiling instead of growing forever.
    assert waits[-1] == waits[-2] == round(dr.FAILURE_BACKOFF_S[-1])


async def test_a_clean_probe_clears_the_failure_streak(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """"Nothing to renew" is a healthy run — the next failure starts over at
    the first step rather than inheriting a six-hour wait."""
    vault = FakeVault("same")
    _stub_probe(monkeypatch, ran=False)
    dr._arm_cooldown(0)
    await dr.attempt(vault)
    dr._arm_cooldown(0)
    await dr.attempt(vault)  # streak of 2

    _stub_probe(monkeypatch, ran=True)
    dr._arm_cooldown(0)
    assert await dr.attempt(vault) == dr.OUTCOME_UNCHANGED

    _stub_probe(monkeypatch, ran=False)
    dr._arm_cooldown(0)
    assert await dr.attempt(vault) == dr.OUTCOME_FAILED
    assert round(dr.cooldown_remaining_seconds()) == round(dr.FAILURE_BACKOFF_S[0])


async def test_a_running_pane_makes_the_probe_unnecessary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Claude Code renews its own token as it works, so spawning a second one
    only adds a chance of an unexplained Keychain dialog."""
    calls = _stub_probe(monkeypatch)
    monkeypatch.setattr(dr, "_claude_pane_running", lambda: True)

    assert await dr.attempt(FakeVault("live")) == dr.OUTCOME_PANE_RUNNING
    assert calls == []
    # No cooldown armed: closing the pane must not leave a probe blocked.
    assert dr.cooldown_remaining_seconds() == 0.0


async def test_the_pane_check_never_blocks_the_probe_when_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Unit tests and early startup have no ws layer; that must read as "no
    pane", not as a reason to skip renewing."""
    monkeypatch.setattr(
        "agent_team_backend.ws_handlers._running_regular_terminals",
        lambda agent_key: (_ for _ in ()).throw(RuntimeError("no app")),
    )

    assert dr._claude_pane_running() is False


async def test_missing_cli_is_reported_and_briefly_gated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_probe(monkeypatch)
    monkeypatch.setattr(
        "agent_team_backend.ai_chat_cli_engine.resolve_cli_binary",
        lambda engine="claude": "",
    )

    assert await dr.attempt(FakeVault()) == dr.OUTCOME_CLI_UNAVAILABLE
    assert 0 < dr.cooldown_remaining_seconds() <= dr.SHORT_COOLDOWN_S


async def test_no_baseline_means_unobservable_and_no_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a readable baseline a later read cannot prove a renewal, so the
    probe is not even run — reporting success there would gate the account on a
    still-expired token."""
    calls = _stub_probe(monkeypatch)

    assert await dr.attempt(FakeVault(None)) == dr.OUTCOME_UNOBSERVABLE
    assert calls == []


async def test_a_keychain_failure_is_unobservable_not_a_renewal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = FakeVault("old")
    _stub_probe(monkeypatch, on_run=lambda: setattr(vault, "secret", RAISE))

    assert await dr.attempt(vault) == dr.OUTCOME_UNOBSERVABLE


async def test_concurrent_callers_run_the_cli_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = FakeVault("same")
    calls = _stub_probe(monkeypatch)

    outcomes = await asyncio.gather(*(dr.attempt(vault) for _ in range(4)))

    assert calls and len(calls) == 1
    assert outcomes.count(dr.OUTCOME_UNCHANGED) == 1
    assert outcomes.count(dr.OUTCOME_SKIPPED_COOLDOWN) == 3


def test_the_probe_never_asks_the_model_for_anything() -> None:
    """`auth status` is a read-only local command: no prompt, no quota spend.
    A prompt-bearing probe (`-p`) would bill the user for a token refresh."""
    assert dr._PROBE_ARGS == ("auth", "status", "--json")
    assert "-p" not in dr._PROBE_ARGS


def test_probe_env_drops_api_keys_that_would_shadow_oauth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-xxx")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok")
    monkeypatch.setenv("PATH", "/usr/bin")

    env = dr._probe_env()

    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    assert env["PATH"] == "/usr/bin"


def test_probe_env_drops_a_relocated_claude_home(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A leaked CLAUDE_CONFIG_DIR would point the probe at another account's
    home, so it would renew something the live fingerprint never sees."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/tmp/some-other-account")

    assert "CLAUDE_CONFIG_DIR" not in dr._probe_env()


async def test_a_timed_out_probe_takes_down_the_whole_process_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The probe runs with start_new_session=True, so killing only the leader
    would strand whatever it spawned in a detached group."""
    killed: list[Any] = []

    class HangingProc:
        returncode = None

        async def communicate(self):
            await asyncio.sleep(60)

    async def fake_terminate(proc, *a, **k):
        killed.append(proc)

    monkeypatch.setattr(
        "agent_team_backend.ai_chat_cli_engine._terminate_proc_tree", fake_terminate
    )

    async def fake_exec(*a, **k):
        return HangingProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    ran, detail = await dr._run_probe("/usr/local/bin/claude", 0.01)

    assert (ran, detail) == (False, "timeout")
    assert len(killed) == 1  # the group killer ran, not a bare proc.kill()


def test_fingerprint_never_returns_the_secret() -> None:
    digest = dr._live_fingerprint(FakeVault("super-secret-token"))

    assert digest is not None
    assert "super-secret-token" not in digest
    assert dr._live_fingerprint(FakeVault(None)) is None
