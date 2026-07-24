"""End-to-end check that text written via TerminalService actually reaches the
spawned CLI process's stdin — i.e. "文字送出後 CLI 真的有收到".

Unlike test_terminals_write_eagain.py (which stands a plain os.pipe() in for the
PTY master), this spins up a REAL child process through a REAL pty and proves the
full backend half of the pipeline: write() → _flush_input() → os.write(master) →
pty → child stdin → child reacts. If this passes, a "sent but not received" bug
lives in the frontend / TUI handshake, not in TerminalService.
"""

import asyncio
import sys

import pytest

from agent_team_backend.terminals import TerminalService


def _collect(received: list[str]):
    async def emit(event):
        if event.get("type") == "terminal.output":
            received.append(event["payload"]["data"])
    return emit


async def test_written_text_reaches_child_stdin():
    # Collect every terminal.output event the service emits.
    received: list[str] = []
    svc = TerminalService(_collect(received))

    # A tiny child that reads one line from stdin and echoes a marker back.
    # If the bytes never reach its stdin, "GOT:" never appears in the output.
    child = (
        "import sys; "
        "line = sys.stdin.readline().strip(); "
        "sys.stdout.write('GOT:' + line + '\\n'); "
        "sys.stdout.flush()"
    )
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=[sys.executable, "-u", "-c", child],
        cwd=".",
    )
    try:
        # The action under test: send text exactly like terminal.input does.
        svc.write(session.id, "hello-pipeline\n")

        # Drain the event loop until the child echoes back (or we give up).
        for _ in range(500):
            await asyncio.sleep(0.01)
            if any("GOT:hello-pipeline" in chunk for chunk in received):
                break

        combined = "".join(received)
        assert "GOT:hello-pipeline" in combined, (
            f"child never received the input; saw: {combined!r}"
        )
    finally:
        await svc.kill(session.id)


async def test_write_to_dead_session_raises_not_silent():
    """When a CLI dies, a write to its (now stale) session_id must NOT vanish
    silently — it must raise so the frontend send() rejects.

    Writing this test corrected a wrong assumption: _close() pops the session out
    of _sessions (terminals.py:472), so once the child exits, write() → _require()
    raises KeyError. There is therefore NO silent backend drop on a dead session;
    the caller is always told. That matters for diagnosis: if text "送出但 CLI 沒收"
    and the frontend logged NO error, the dead-session path is ruled out.
    """
    received: list[str] = []
    svc = TerminalService(_collect(received))

    # Child exits immediately → its pty hits EOF → _close() removes the session.
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=[sys.executable, "-c", "pass"],
        cwd=".",
    )
    for _ in range(500):
        await asyncio.sleep(0.01)
        if session.id not in svc._sessions:
            break
    assert session.id not in svc._sessions, "dead child should be removed from sessions"

    # The action: send text to the now-dead session → loud failure, not silence.
    with pytest.raises(KeyError):
        svc.write(session.id, "into-the-void\n")


async def test_unknown_session_raises_not_silent():
    """The same guarantee for a wrong/typo'd session_id: it raises, so the
    frontend send() rejects instead of pretending success."""
    svc = TerminalService(_collect([]))
    with pytest.raises(KeyError):
        svc.write("does-not-exist", "hello\n")


async def test_text_then_enter_preserve_order():
    """Rules out a backend cause of the Enter-race: when the frontend sends the
    content and then '\\r', the child reads them in that exact order (FIFO). If a
    CLI submits an empty box, the reordering is NOT here."""
    received: list[str] = []
    svc = TerminalService(_collect(received))

    # Child echoes back exactly what it reads on the first line.
    child = (
        "import sys; "
        "line = sys.stdin.readline().rstrip(chr(10)); "
        "sys.stdout.write('LINE:[' + line + ']\\n'); "
        "sys.stdout.flush()"
    )
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=[sys.executable, "-u", "-c", child],
        cwd=".",
    )
    try:
        svc.write(session.id, "payload-here")  # content
        svc.write(session.id, "\r")            # Enter, sent after — must land after
        for _ in range(500):
            await asyncio.sleep(0.01)
            if any("LINE:[" in c for c in received):
                break
        combined = "".join(received)
        # The submitted line is exactly the content — Enter did not jump ahead of it.
        assert "LINE:[payload-here]" in combined, f"got: {combined!r}"
    finally:
        await svc.kill(session.id)
