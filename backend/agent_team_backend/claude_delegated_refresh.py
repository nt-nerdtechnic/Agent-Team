"""Delegated Claude OAuth refresh — the CLI mints, this app only observes.

Anthropic rotates refresh tokens: every exchange invalidates the previous one.
Whenever this app minted a token for a credential Claude Code also owns, one of
the two ended up holding a dead grant and the account had to be signed in again.
So nothing here performs the refresh grant. Instead it runs the CLI's own
read-only auth probe (``claude auth status --json``, no inference, no token
spend) and lets Claude Code renew the credential the way it normally would, then
confirms the live secret actually changed before reporting success.

Confirming matters: a probe that "ran fine" without renewing anything would
otherwise park the account in a long cooldown holding a still-expired token.

Scope is the ACTIVE account only. The probe touches whatever credential is live,
so a parked slot cannot be refreshed this way — it stays expired until a switch
brings it live and the CLI renews it there.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time

log = logging.getLogger("agent_team_backend.claude_refresh")

# Outcomes (also the log labels).
OUTCOME_REFRESHED = "refreshed"
OUTCOME_UNCHANGED = "unchanged"
OUTCOME_SKIPPED_COOLDOWN = "skipped-cooldown"
OUTCOME_CLI_UNAVAILABLE = "cli-unavailable"
OUTCOME_UNOBSERVABLE = "unobservable"
OUTCOME_FAILED = "failed"
OUTCOME_PANE_RUNNING = "pane-running"

# A successful renewal is good for hours, so a full cooldown after one that
# changed nothing keeps the probe rare. The short cooldown is for the cases we
# could not judge (CLI missing, Keychain unreadable) — those can self-heal.
COOLDOWN_S = 300.0
SHORT_COOLDOWN_S = 20.0
PROBE_TIMEOUT_S = 8.0

# Consecutive failures escalate, because the expensive failure mode is a macOS
# Keychain prompt the user declines: the probe spawns Claude Code in the
# background, so a flat retry would put a dialog on screen every poll with no
# user action to explain it. Escalating to a 6h ceiling means a denial costs a
# handful of dialogs, not one every five minutes forever. A probe that merely
# found nothing to renew is a healthy run and clears the streak.
FAILURE_BACKOFF_S = (300.0, 1_200.0, 3_600.0, 21_600.0)

# Read-only: prints the current auth status as JSON and exits. No prompt is
# sent to the model, so this costs no quota.
_PROBE_ARGS = ("auth", "status", "--json")

# An inherited API key would make the CLI authenticate with that instead of the
# OAuth credential, so the probe would never touch what we want renewed.
# CLAUDE_CONFIG_DIR would point it at some other account's home entirely; the
# backend already strips it at startup, but this must not depend on that having
# run first — the probe only means anything against the live credential.
_ENV_DROP = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR")

_lock = asyncio.Lock()
_cooldown_until: float | None = None  # time.monotonic() deadline
_consecutive_failures = 0


def cooldown_remaining_seconds(now: float | None = None) -> float:
    """Seconds until the next probe is allowed (0.0 when one may run)."""
    if _cooldown_until is None:
        return 0.0
    return max(0.0, _cooldown_until - (time.monotonic() if now is None else now))


def reset_state_for_testing() -> None:
    global _cooldown_until, _consecutive_failures
    _cooldown_until = None
    _consecutive_failures = 0


def _arm_cooldown(seconds: float) -> None:
    global _cooldown_until
    _cooldown_until = time.monotonic() + seconds


def _arm_failure_backoff() -> None:
    """Escalate one step and hold there once the ceiling is reached."""
    global _consecutive_failures
    _consecutive_failures += 1
    step = min(_consecutive_failures, len(FAILURE_BACKOFF_S)) - 1
    _arm_cooldown(FAILURE_BACKOFF_S[step])


def _clear_failure_streak() -> None:
    global _consecutive_failures
    _consecutive_failures = 0


def _claude_pane_running() -> bool:
    """True when a live Claude pane already owns the credential.

    Claude Code renews its own token as it works, so probing alongside a
    running pane spawns a background process for something that is about to
    happen anyway — and every avoided spawn is one less chance of a Keychain
    dialog appearing with no user action behind it. The trade is that an idle
    pane may sit on an expired token until it next needs one; the badge reads
    expired for that stretch, which is what it did before this existed.

    False when the ws layer is unavailable (unit tests, early startup)."""
    try:
        from .ws_handlers import _running_regular_terminals

        return bool(_running_regular_terminals("claude"))
    except Exception:  # noqa: BLE001 — never block the probe on introspection
        return False


def _probe_env() -> dict[str, str]:
    """The backend already drops CLI home relocations at startup (see
    ``app._sanitize_inherited_cli_env``), so the real home is inherited as-is."""
    env = dict(os.environ)
    for key in _ENV_DROP:
        env.pop(key, None)
    return env


def _live_fingerprint(vault) -> str | None:
    """Digest of the live claude secret, or None when it cannot be read.

    Never returns the secret itself. A read failure is reported as None rather
    than a sentinel digest so it can't be mistaken for "unchanged"."""
    try:
        secret = vault.read_live("claude").secret
    except Exception:  # noqa: BLE001 — observation must not sink the poll
        return None
    if not secret:
        return None
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


async def _run_probe(binary: str, timeout: float) -> tuple[bool, str]:
    """(ran_cleanly, detail). Never raises.

    stderr is folded into stdout so a failing probe's last line can go in the
    log; the JSON payload itself is ignored — the credential is the verdict."""
    from .ai_chat_cli_engine import _terminate_proc_tree

    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            *_PROBE_ARGS,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=_probe_env(),
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001 — a broken spawn is just a failure
        return False, f"spawn failed: {exc}"
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        # start_new_session put the CLI in its own process group, so killing
        # the leader alone would strand anything it spawned. Take the group
        # down the same way every other CLI spawn in this app does.
        await _terminate_proc_tree(proc)
        return False, "timeout"
    except Exception as exc:  # noqa: BLE001
        return False, f"probe failed: {exc}"
    if proc.returncode != 0:
        tail = (out or b"").decode("utf-8", "replace").strip().splitlines()
        return False, f"exit {proc.returncode}" + (f": {tail[-1][:120]}" if tail else "")
    return True, ""


async def attempt(vault, *, timeout: float = PROBE_TIMEOUT_S) -> str:
    """Ask the CLI to renew the live claude credential. Returns an outcome.

    Serialized and rate-limited: concurrent callers queue on the lock and the
    later ones fall out on the cooldown the first one armed. Never raises — the
    caller is a usage poll that must survive anything this does."""
    async with _lock:
        if _claude_pane_running():
            # No cooldown armed: the moment the pane closes, a probe is useful
            # again and should not have to wait one out.
            return OUTCOME_PANE_RUNNING
        if cooldown_remaining_seconds() > 0:
            return OUTCOME_SKIPPED_COOLDOWN

        try:
            from .ai_chat_cli_engine import resolve_cli_binary

            binary = resolve_cli_binary("claude")
        except Exception:  # noqa: BLE001 — an unresolvable binary is "no CLI"
            binary = ""
        if not binary:
            _arm_cooldown(SHORT_COOLDOWN_S)
            return OUTCOME_CLI_UNAVAILABLE

        before = await asyncio.to_thread(_live_fingerprint, vault)
        if before is None:
            # Nothing signed in, or the Keychain read failed. Either way there
            # is no baseline, so a later read cannot prove a renewal happened.
            _arm_cooldown(SHORT_COOLDOWN_S)
            return OUTCOME_UNOBSERVABLE

        ran, detail = await _run_probe(binary, timeout)
        if not ran:
            # A declined Keychain dialog surfaces here, so escalate rather than
            # re-prompt on the same cadence forever.
            _arm_failure_backoff()
            log.info(
                "claude delegated refresh probe failed (%d in a row, next in %ds): %s",
                _consecutive_failures, int(cooldown_remaining_seconds()), detail,
            )
            return OUTCOME_FAILED

        after = await asyncio.to_thread(_live_fingerprint, vault)
        if after is None:
            _arm_cooldown(SHORT_COOLDOWN_S)
            return OUTCOME_UNOBSERVABLE

        # The probe ran cleanly, so whatever went wrong before is over.
        _clear_failure_streak()
        if after == before:
            # The CLI had nothing to renew (or declined to). Back off fully —
            # retrying every poll would just re-run the probe for nothing.
            _arm_cooldown(COOLDOWN_S)
            return OUTCOME_UNCHANGED

        # Renewed. Leave the cooldown clear: the caller re-reads immediately and
        # the fresh token is good for hours anyway.
        log.info("claude credential renewed by the CLI")
        return OUTCOME_REFRESHED
