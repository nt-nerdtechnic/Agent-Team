"""Regression: a pane's PTY child must own a controlling terminal.

`start_new_session=True` only calls setsid(), which leaves the child leading a
new session with NO controlling terminal. dup2'ing the pty slave onto fd 0/1/2
does not claim one — that takes an explicit TIOCSCTTY. Without it the kernel
never gives the tty a foreground process group, so it delivers neither SIGINT
(^C) nor SIGWINCH (resize), job control stays disabled, and /dev/tty is ENXIO.

That last one is what a user actually trips over: `sudo` insists on reading the
password from /dev/tty and refuses with "a terminal is required to read the
password", even though `tty` and `[ -t 0 ]` both report a healthy tty (they only
check isatty() on the fd, which was never the broken half).

Note the probes below exec a fresh interpreter. A shell would muddy the result:
on BSD/macOS a session leader acquires a ctty by merely open()ing a tty, and
bash re-opens its tty at startup (zsh does not), so a bash-hosted probe would
report a ctty that production never had.
"""

import asyncio
import os
import signal
import sys

from agent_team_backend.terminals import TerminalService


def _frame_data(frame: bytes) -> bytes:
    """Raw PTY bytes of a binary terminal-output frame (skip the header)."""
    assert frame[0] == 0x01
    off = 6 + frame[5]          # past sessionId
    off += 1 + frame[off]       # past paneId
    return frame[off:]


def _collect(received: list[str]):
    async def emit(event):
        if isinstance(event, (bytes, bytearray)):
            received.append(_frame_data(bytes(event)).decode("utf-8", "replace"))
    return emit


async def _run_probe(svc: TerminalService, received: list[str], child: str) -> str:
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=[sys.executable, "-u", "-c", child],
        cwd=".",
    )
    try:
        for _ in range(500):
            await asyncio.sleep(0.01)
            if any("PROBE:" in chunk for chunk in received):
                break
        return "".join(received)
    finally:
        await svc.kill(session.id)


async def test_child_owns_a_controlling_terminal():
    """/dev/tty must be openable in the child — the exact check sudo makes."""
    received: list[str] = []
    svc = TerminalService(_collect(received))
    child = (
        "import os, sys\n"
        "try:\n"
        "    fd = os.open('/dev/tty', os.O_RDWR)\n"
        "    os.close(fd)\n"
        "    out = 'PROBE:CTTY:OK'\n"
        "except OSError as err:\n"
        "    out = 'PROBE:CTTY:FAIL:%d' % err.errno\n"
        "sys.stdout.write(out + '\\n')\n"
        "sys.stdout.flush()\n"
    )
    combined = await _run_probe(svc, received, child)
    assert "PROBE:CTTY:OK" in combined, (
        "child has no controlling terminal — sudo/ssh password prompts and "
        f"kernel-delivered signals will not work; saw: {combined!r}"
    )


async def test_child_stays_its_own_session_and_group_leader():
    """pty_registry._classify_root treats `pgid != pid` as a dead root, so
    claiming the ctty must not disturb sid/pgid/pid all being the child's pid."""
    received: list[str] = []
    svc = TerminalService(_collect(received))
    child = (
        "import os, sys\n"
        "sys.stdout.write('PROBE:IDS:%d:%d:%d\\n' % ("
        "os.getpid(), os.getpgid(0), os.getsid(0)))\n"
        "sys.stdout.flush()\n"
    )
    combined = await _run_probe(svc, received, child)
    marker = [ln for ln in combined.splitlines() if ln.startswith("PROBE:IDS:")]
    assert marker, f"probe never reported its ids; saw: {combined!r}"
    _, _, pid, pgid, sid = marker[0].split(":")
    assert pid == pgid == sid, (
        f"child must lead its own session and group; got "
        f"pid={pid} pgid={pgid} sid={sid}"
    )


async def test_ctrl_c_raises_sigint_in_a_line_mode_child():
    """^C must reach a child that leaves ISIG on (a plain shell, `cat`, `sleep`).

    Raw-mode TUIs read the 0x03 byte themselves and are unaffected either way,
    which is precisely why the missing ctty went unnoticed for so long: every
    CLI Navide ships masks it.
    """
    received: list[str] = []
    svc = TerminalService(_collect(received))
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        # Announce readiness only after the tty is in its default line mode.
        command=[
            sys.executable, "-u", "-c",
            "import sys, time; sys.stdout.write('PROBE:READY\\n');"
            " sys.stdout.flush(); time.sleep(30)",
        ],
        cwd=".",
    )
    try:
        for _ in range(500):
            await asyncio.sleep(0.01)
            if any("PROBE:READY" in chunk for chunk in received):
                break
        assert any("PROBE:READY" in c for c in received), "child never started"

        svc.interrupt(session.id)

        for _ in range(300):
            await asyncio.sleep(0.01)
            if session.proc.poll() is not None:
                break
        assert session.proc.poll() is not None, (
            "child survived ^C — the kernel had no foreground process group "
            "to deliver SIGINT to"
        )
        assert session.proc.returncode == -signal.SIGINT, (
            f"expected death by SIGINT, got returncode={session.proc.returncode}"
        )
    finally:
        await svc.kill(session.id)


# A stand-in for the real pane shape: the PTY child is a login shell, and once
# it has a ctty its job control goes live and it runs the CLI in a process
# group of its own, made foreground. Signalling only the shell's group then
# misses the CLI entirely.
_SHELL_WITH_JOB_CONTROL = """
import os, signal, sys, time
marker = sys.argv[1]
pid = os.fork()
if pid == 0:
    # tcsetpgrp from a background group would stop us with SIGTTOU; ignoring it
    # is what a real shell does here too.
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    # Ignore the hangup so ONLY a delivered SIGTERM can produce the marker --
    # otherwise closing the master would write it either way and the test
    # could not tell the two apart.
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    os.setpgid(0, 0)
    fd = os.open('/dev/tty', os.O_RDWR)
    os.tcsetpgrp(fd, os.getpgid(0))
    def _bye(*_a):
        with open(marker, 'w') as fh:
            fh.write('term')
        os._exit(0)
    signal.signal(signal.SIGTERM, _bye)
    os.write(1, b'PROBE:FG\\n')
    time.sleep(30)
    os._exit(0)
else:
    time.sleep(30)
"""


async def test_kill_reaches_the_cli_in_its_own_foreground_group(tmp_path):
    """A graceful kill must signal the tty's foreground group, not just the
    shell's.

    reclaimIdlePane and workspace switching send a graceful signal precisely so
    the CLI can finish writing its transcript -- the thing `--resume` reads. If
    only the shell's group is signalled, the CLI learns of the shutdown as the
    SIGHUP from the closing master and gets no such chance.
    """
    marker = tmp_path / "sigterm-landed"
    received: list[str] = []
    svc = TerminalService(_collect(received))
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=[sys.executable, "-u", "-c", _SHELL_WITH_JOB_CONTROL, str(marker)],
        cwd=".",
    )
    for _ in range(500):
        await asyncio.sleep(0.01)
        if any("PROBE:FG" in chunk for chunk in received):
            break
    assert any("PROBE:FG" in c for c in received), (
        f"inner process never took the foreground; saw: {''.join(received)!r}"
    )

    await svc.kill(session.id)

    # Check inside the escalation grace: _kill_breakaway SIGKILLs the whole
    # snapshotted tree after ~1s, which would hide a missing SIGTERM.
    for _ in range(30):
        await asyncio.sleep(0.01)
        if marker.exists():
            break
    assert marker.exists(), (
        "the CLI never received SIGTERM — killpg only covered the shell's "
        "process group, so the CLI would be killed by SIGHUP/SIGKILL with no "
        "chance to flush its transcript"
    )
