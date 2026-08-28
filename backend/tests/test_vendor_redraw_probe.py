"""Which shipped CLI vendors actually repaint when force_redraw nudges them.

OPT-IN. Skipped unless AGENT_TEAM_VENDOR_PROBE=1, because it launches real CLI
binaries: each takes seconds to boot, some reach the network, and all of them
depend on whatever version happens to be installed. That makes it useless as a
gate and valuable as an audit — run it deliberately:

    AGENT_TEAM_VENDOR_PROBE=1 uv --project backend run pytest \
        backend/tests/test_vendor_redraw_probe.py -v -s

The regression line for the resize path is test_force_redraw_signal.py, which
pins the mechanism (a SIGWINCH is delivered at an unchanged size) without
launching anything. This file pins the fact that motivates keeping that
mechanism: as of 2026-08-28, five of eleven vendors repaint on the signal
alone. It is how you find out that list has changed.

Baseline, bytes emitted in response to force_redraw's ioctl pair:

    kilo 8437 · copilot 6030 · qwen 4446 · aider 442 · codex 144
    claude · opencode · droid · kimi · grok · cursor-agent — all 0

A vendor dropping out of the responding set is not a bug in Navide, but it does
mean the "keep force_redraw" argument rests on a smaller set than it used to.
"""

from __future__ import annotations

import fcntl
import os
import pty
import select
import shutil
import struct
import sys
import termios
import time

import pytest

# The five that repaint on the signal alone. Kept as an explicit list rather
# than probing every vendor: the other six emit nothing by design (they compare
# the winsize and skip), so they cannot regress in the direction this guards.
RESPONDING_VENDORS = ["kilo", "copilot", "qwen", "aider", "codex"]

# Boot is drained to QUIET, not for a fixed window. A fixed window was how the
# first measurement of this got the vendor list wrong: slower CLIs were still
# emitting startup output when the nudge landed, and that trailing output was
# counted as a response.
BOOT_QUIET_S = 1.5
BOOT_MAX_S = 25.0
BOOT_MIN_BYTES = 50
REPLY_WINDOW_S = 2.0

pytestmark = pytest.mark.skipif(
    os.environ.get("AGENT_TEAM_VENDOR_PROBE") != "1" or sys.platform == "win32",
    reason="opt-in vendor probe; set AGENT_TEAM_VENDOR_PROBE=1 to run",
)


def _winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _read_for(fd: int, seconds: float) -> bytes:
    out = b""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    return out


def _read_until_quiet(fd: int, quiet: float, hard: float) -> bytes:
    """Wait for the CLI's first output, then read until it goes quiet.

    The initial grace matters: several CLIs take seconds to emit anything, and
    a quiet-gap loop with no warmup returns empty before they have started.
    """
    out = b""
    start = time.monotonic()
    while not out and time.monotonic() - start <= hard:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        try:
            out += os.read(fd, 65536)
        except OSError:
            return out
    last = time.monotonic()
    while time.monotonic() - last <= quiet and time.monotonic() - start <= hard:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        last = time.monotonic()
    return out


@pytest.mark.parametrize("vendor", RESPONDING_VENDORS)
def test_vendor_repaints_on_the_force_redraw_nudge(vendor: str) -> None:
    binary = shutil.which(vendor)
    if binary is None:
        pytest.skip(f"{vendor} is not installed on this machine")

    pid, fd = pty.fork()
    if pid == 0:  # child
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("CLAUDE", "CLAUDECODE", "NAVIDE"))}
        env["TERM"] = "xterm-256color"
        try:
            os.execve(binary, [binary], env)
        finally:
            os._exit(1)

    try:
        _winsize(fd, 30, 120)
        boot = _read_until_quiet(fd, BOOT_QUIET_S, BOOT_MAX_S)
        if len(boot) < BOOT_MIN_BYTES:
            pytest.skip(f"{vendor} did not start an interactive TUI (needs login?)")

        # Exactly what TerminalService.force_redraw does, at the size the PTY
        # already has — the case the resize path uses.
        _winsize(fd, 29, 120)
        _winsize(fd, 30, 120)
        nudge = _read_for(fd, REPLY_WINDOW_S)

        # Control: a genuine width change. If this is also silent the CLI is
        # wedged or has exited, and the nudge result means nothing.
        _winsize(fd, 30, 95)
        real = _read_for(fd, REPLY_WINDOW_S)

        print(f"\n{vendor}: boot={len(boot)}B nudge={len(nudge)}B real={len(real)}B")
        assert real, f"{vendor} ignored a real width change — probe is unreliable here"
        assert nudge, (
            f"{vendor} no longer repaints on force_redraw's nudge. It was in the "
            f"responding set on 2026-08-28; if it has genuinely changed, update "
            f"RESPONDING_VENDORS and the note in test_force_redraw_signal.py."
        )
    finally:
        try:
            os.kill(pid, 9)
            os.waitpid(pid, 0)
        except OSError:
            pass
        os.close(fd)
