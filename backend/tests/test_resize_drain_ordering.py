from __future__ import annotations

import fcntl
import os
import pty
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.terminals import TerminalSession


class OrderRecordingWS:
    """Records every outbound frame in send order — binary output frames and
    the JSON resize ack share one list so their relative order can be
    asserted."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any] | bytes] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    async def send_bytes(self, data: bytes) -> None:
        self.sent.append(data)


def _frame_data(frame: bytes) -> bytes:
    """Raw PTY bytes of a binary terminal-output frame (skip the header)."""
    assert frame[0] == 0x01
    off = 6 + frame[5]          # past sessionId
    off += 1 + frame[off]       # past paneId
    return frame[off:]


def _type_of(msg: dict[str, Any] | bytes) -> str:
    return "terminal.output" if isinstance(msg, bytes) else msg["type"]


def _fake_session_entry(session: app.Session, sid: str) -> tuple[int, int]:
    """Register a TerminalSession backed by a real PTY (TIOCSWINSZ needs a
    real tty) whose master has no pending bytes (non-blocking read → EAGAIN)."""
    master, slave = pty.openpty()
    fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)
    entry = TerminalSession(
        id=sid,
        pane_id="p1",
        agent_key=None,
        command=["x"],
        cwd="/",
        master_fd=master,
        proc=SimpleNamespace(pid=1234, returncode=None),  # type: ignore[arg-type]
    )
    session.terminals._sessions[sid] = entry
    return master, slave


@pytest.mark.asyncio
async def test_resize_drains_buffered_output_before_ack() -> None:
    """Old-width output queued behind the batch timer must reach the client
    BEFORE the resize ack — otherwise xterm re-wraps it at the new width and
    the CLI's repaints strand corrupt frames in scrollback."""
    ws = OrderRecordingWS()
    session = app.Session(ws)  # type: ignore[arg-type]
    sid = "term-drain"
    app._PTY_OWNERS[sid] = session  # route terminal output back to this ws
    master, slave = _fake_session_entry(session, sid)
    svc = session.terminals
    try:
        # Old-width output sitting behind the 50ms batch timer (simulated with a
        # long delay so it would NOT fire on its own during the test).
        svc._out_buffers[sid] = [b"OLD_WIDTH_OUTPUT"]
        svc._out_handles[sid] = svc._loop.call_later(10, svc._flush_output, svc._sessions[sid])

        await app.handle_message(session, {
            "id": "r1",
            "type": "terminal.resize",
            "payload": {"terminal_session_id": sid, "cols": 80, "rows": 24},
        })
    finally:
        os.close(master)
        os.close(slave)

    types = [_type_of(m) for m in ws.sent]
    assert "terminal.output" in types, "buffered output was never flushed"
    assert "terminal.resize.result" in types, "resize was never acked"
    assert types.index("terminal.output") < types.index("terminal.resize.result"), (
        f"output must precede the resize ack, got order: {types}"
    )
    out_frame = next(m for m in ws.sent if isinstance(m, bytes))
    assert _frame_data(out_frame) == b"OLD_WIDTH_OUTPUT"
    # The pending batch timer was cancelled by the drain, so it must not have
    # re-emitted the same output a second time.
    assert types.count("terminal.output") == 1
    assert sid not in svc._out_handles


@pytest.mark.asyncio
async def test_drain_output_noop_on_unknown_session() -> None:
    """Draining a session that doesn't exist is a silent no-op (the resize
    handler still raises for unknown sessions via resize())."""
    ws = OrderRecordingWS()
    session = app.Session(ws)  # type: ignore[arg-type]
    await session.terminals.drain_output("does-not-exist")
    assert ws.sent == []
