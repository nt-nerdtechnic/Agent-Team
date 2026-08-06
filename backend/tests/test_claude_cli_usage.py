"""Reading the CLI's own /usage panel.

The fixture is a byte-faithful capture from ``claude --ax-screen-reader`` on a
real machine. It matters that it is verbatim: the panel corrects itself in
place while loading (this capture repaints 19 times and supersedes the session
figure from 4% to 5%), and a hand-tidied sample would hide exactly the case the
renderer exists for.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from agent_team_backend.cli_vendors import claude as cu

REAL_PANEL = (Path(__file__).parent / "fixtures" / "claude_usage_panel.txt").read_text(
    encoding="utf-8"
)
NOW = datetime(2026, 8, 5, 1, 20, tzinfo=ZoneInfo("Asia/Taipei"))


def test_reads_every_window_from_a_real_panel() -> None:
    windows = cu.parse_usage_panel(REAL_PANEL, now=NOW)

    assert [(w["kind"], w["label"], w["usedPercent"]) for w in windows] == [
        ("session", "Session (5h)", 5.0),
        ("weekly", "Weekly (all models)", 92.0),
        ("weekly-model", "Weekly (Fable)", 66.0),
    ]


def test_a_superseded_repaint_is_not_reported() -> None:
    """The stream carries 4% before the panel settles on 5%. Reading the bytes
    instead of the screen reports a number the CLI itself already corrected."""
    superseded = re.findall(r"(\d+)% \d+% used", cu.strip_ansi(REAL_PANEL))
    assert superseded[0] == "4"  # the fixture really does contain the stale value

    assert cu.parse_usage_panel(REAL_PANEL, now=NOW)[0]["usedPercent"] == 5.0


def test_reset_times_become_timestamps_the_ui_can_count_down() -> None:
    session, weekly, _fable = cu.parse_usage_panel(REAL_PANEL, now=NOW)

    # "Resets 6am (Asia/Taipei)" — a bare clock time means the next one.
    assert session["resetsAt"] == "2026-08-04T22:00:00Z"
    # "Resets Aug 7 at 12pm (Asia/Taipei)"
    assert weekly["resetsAt"] == "2026-08-07T04:00:00Z"


def test_an_unparseable_reset_is_dropped_not_guessed() -> None:
    """A localized or reworded phrase must cost the countdown, never produce a
    fabricated timestamp."""
    panel = "Current session\n50% 50% used\nResets bientôt\n"

    window = cu.parse_usage_panel(panel, now=NOW)[0]

    assert window["usedPercent"] == 50.0
    assert window["resetsAt"] is None


def test_blocks_never_borrow_a_neighbours_numbers() -> None:
    """A window whose own percent is missing is dropped, not filled in from the
    next block down."""
    panel = (
        "Current session\nResets 6am (Asia/Taipei)\n"
        "Current week (all models)\n92% 92% used\n"
    )

    assert [w["kind"] for w in cu.parse_usage_panel(panel, now=NOW)] == ["weekly"]


def test_a_panel_without_usage_yields_nothing() -> None:
    assert cu.parse_usage_panel("Settings  Status   Config\nEsc to cancel") == []


# ── screen renderer ─────────────────────────────────────────────────────────


def test_erase_and_cursor_up_replace_a_line_in_place() -> None:
    raw = "first\nsecond\nthird\x1b[2K\x1b[1A\x1b[2K\x1b[Greplaced"

    assert cu.render_screen(raw).splitlines() == ["first", "replaced"]


def test_column_moves_overwrite_without_truncating_the_tail() -> None:
    raw = "abcdefgh\x1b[3GXY"

    assert cu.render_screen(raw).splitlines() == ["abXYefgh"]


def test_unknown_escapes_do_not_disturb_the_layout() -> None:
    """Colour and mode sequences carry no geometry and must be dropped whole,
    not printed as text."""
    raw = "\x1b[38;5;244mplain\x1b[39m\x1b[?25l text"

    assert cu.render_screen(raw).splitlines() == ["plain text"]


def test_charset_select_is_three_bytes_not_two() -> None:
    """ESC ( B is three bytes; consuming two prints the B as text. The real
    capture opens with exactly this sequence — a stray B ahead of a header
    line makes that header unmatchable."""
    assert cu.render_screen("\x1b(Bhello").splitlines() == ["hello"]


def test_osc_payloads_are_swallowed_not_printed() -> None:
    """A window-title sequence carries free text; printing it would spray that
    text across the screen lines the parser reads."""
    assert cu.render_screen("\x1b]0;a title\x07hi").splitlines() == ["hi"]
    assert cu.render_screen("\x1b]0;a title\x1b\\hi").splitlines() == ["hi"]
    assert cu.render_screen("\x1b]0;never terminated").splitlines() == []


# ── settling ────────────────────────────────────────────────────────────────


async def test_waiting_does_not_mistake_a_slow_start_for_a_finish() -> None:
    """A cold Claude Code takes seconds before its first byte. Treating that
    silence as "done" sends the panel command to a CLI with no prompt yet, and
    nothing ever comes back — the read returned empty in exactly this way."""
    import asyncio

    flag = asyncio.Event()
    chunks: list[bytes] = []

    async def arrive_late() -> None:
        await asyncio.sleep(0.25)  # longer than the first-byte poll interval
        chunks.append(b"hello")
        flag.set()

    task = asyncio.create_task(arrive_late())
    await cu._wait_settled(flag, chunks, deadline_s=3.0)
    await task

    assert chunks == [b"hello"]  # it waited for output instead of giving up


async def test_a_mid_render_pause_does_not_end_the_read() -> None:
    """The panel stalls while it scans local sessions. A pause longer than the
    quiet window would otherwise end the read on a half-drawn screen carrying
    no numbers at all."""
    import asyncio

    flag = asyncio.Event()
    chunks: list[bytes] = [b"Current session\n"]  # header drawn, no figure yet
    ready_calls: list[int] = []

    async def finish_after_the_pause() -> None:
        await asyncio.sleep(cu.QUIET_S + 0.4)
        chunks.append(b"40% 40% used\n")
        flag.set()

    def ready() -> bool:
        ready_calls.append(1)
        return bool(cu.parse_usage_panel(b"".join(chunks).decode()))

    task = asyncio.create_task(finish_after_the_pause())
    await cu._wait_settled(flag, chunks, deadline_s=6.0, ready=ready)
    await task

    assert len(ready_calls) >= 2  # asked again instead of settling on the first quiet
    assert cu.parse_usage_panel(b"".join(chunks).decode())[0]["usedPercent"] == 40.0


async def test_a_panel_that_never_fills_still_ends() -> None:
    """`ready` must not be able to hold the read open past its deadline."""
    import asyncio

    flag = asyncio.Event()
    chunks: list[bytes] = [b"nothing useful"]

    await asyncio.wait_for(
        cu._wait_settled(flag, chunks, deadline_s=0.4, ready=lambda: False),
        timeout=5,
    )


async def test_a_dead_cli_ends_the_wait_at_once() -> None:
    """EOF on the pty means nothing further can arrive. The wait must end
    immediately instead of running out its full deadline."""
    import asyncio
    import time as _time

    flag = asyncio.Event()
    start = _time.monotonic()

    await cu._wait_settled(flag, [b"partial"], deadline_s=30.0, closed=lambda: True)

    assert _time.monotonic() - start < 1.0


# ── invocation safety ───────────────────────────────────────────────────────


def test_typed_probe_carries_no_select_shortcuts() -> None:
    """The command text goes in before the screen is proven to be the
    composer. On a select-style dialog a digit chooses an option directly, so
    the probe text must never contain one."""
    assert not any(ch.isdigit() for ch in cu.SLASH_COMMAND_TEXT.decode())


def _fake_cli(tmp_path, body: str):
    """An executable that owns a pty like the real CLI: raw mode, no kernel
    echo — whatever appears on screen is what the program itself drew."""
    script = tmp_path / "fake-claude"
    script.write_text("#!/usr/bin/env python3\nimport os, sys, tty\ntty.setraw(0)\n" + body)
    script.chmod(0o755)
    return str(script)


def _fast_probe(monkeypatch) -> None:
    monkeypatch.setattr(cu, "BOOT_TIMEOUT_S", 5.0)
    monkeypatch.setattr(cu, "PANEL_TIMEOUT_S", 5.0)
    monkeypatch.setattr(cu, "QUIET_S", 0.2)
    monkeypatch.setattr(cu, "ECHO_TIMEOUT_S", 1.0)


async def test_the_enter_only_goes_to_a_screen_that_echoed(monkeypatch, tmp_path) -> None:
    """A composer echoes what is typed; the read proceeds."""
    _fast_probe(monkeypatch)
    binary = _fake_cli(tmp_path, (
        "os.write(1, b'ready\\r\\n')\n"
        "while True:\n"
        "    c = os.read(0, 1)\n"
        "    if not c: break\n"
        "    if c == b'\\r':\n"
        "        os.write(1, b'\\r\\nCurrent session\\r\\n40% 40% used\\r\\n')\n"
        "        break\n"
        "    os.write(1, c)\n"
        "import time; time.sleep(5)\n"
    ))

    raw = await cu.read_usage_panel(binary)

    assert cu.parse_usage_panel(raw)[0]["usedPercent"] == 40.0


async def test_a_mute_dialog_never_gets_the_enter(monkeypatch, tmp_path) -> None:
    """The folder-trust dialog swallows typed text without echoing it, and its
    default button is the destructive answer. No echo means the \\r is never
    sent — the dialog must see the probe text at most, never the enter."""
    _fast_probe(monkeypatch)
    keylog = tmp_path / "keys.bin"
    binary = _fake_cli(tmp_path, (
        "os.write(1, b'Do you trust the files in this folder?\\r\\n')\n"
        f"log = open({str(keylog)!r}, 'ab', 0)\n"
        "while True:\n"
        "    c = os.read(0, 1)\n"
        "    if not c: break\n"
        "    log.write(c)\n"
    ))

    import pytest

    with pytest.raises(RuntimeError, match="refusing to press enter"):
        await cu.read_usage_panel(binary)

    assert b"\r" not in keylog.read_bytes()


# ── fetch wrapper ───────────────────────────────────────────────────────────

# Grabbed at import time, before the conftest guard swaps the module attribute.
_REAL_FETCH = cu.fetch_claude_usage_via_cli


async def test_logged_out_is_reported_without_a_spawn(monkeypatch, tmp_path) -> None:
    """No credential means the CLI could only present its login wizard — at a
    full boot's cost, on every retry. That is knowable up front."""
    from agent_team_backend import ai_chat_cli_engine, usage_service as us

    async def no_creds(home):
        return None

    def resolve_is_too_late(name):
        raise AssertionError("resolved the binary despite no credentials")

    monkeypatch.setattr(cu, "read_claude_credentials", no_creds)
    monkeypatch.setattr(ai_chat_cli_engine, "resolve_cli_binary", resolve_is_too_late)

    snap = await _REAL_FETCH(tmp_path)

    assert snap["status"] == "no-credentials"


async def test_a_spawned_but_empty_read_is_priced_like_a_success(monkeypatch, tmp_path) -> None:
    """A read that started a whole Claude Code and still came back empty cost
    as much as a successful one; the retry cadence must reflect that."""
    from agent_team_backend import ai_chat_cli_engine, usage_service as us

    async def creds(home):
        return {"accessToken": "x"}

    async def read_fails(binary):
        raise RuntimeError("boom")

    monkeypatch.setattr(cu, "read_claude_credentials", creds)
    monkeypatch.setattr(ai_chat_cli_engine, "resolve_cli_binary", lambda name: "/bin/claude")
    monkeypatch.setattr(cu, "read_usage_panel", read_fails)

    snap = await _REAL_FETCH(tmp_path)

    assert snap["status"] == "unavailable"
    assert snap["costlyRead"] is True


def test_probe_env_drops_credentials_and_home_relocations(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/tmp/other")

    env = cu._panel_probe_env()

    assert "ANTHROPIC_API_KEY" not in env
    assert "CLAUDE_CONFIG_DIR" not in env
    assert env["TERM"] == "xterm-256color"


def test_the_panel_is_requested_read_only() -> None:
    """/usage is a local CLI command, so reading the quota must not itself
    consume quota. A prompt-bearing invocation would bill the user for it."""
    assert cu.SLASH_COMMAND_TEXT == b"/usage"
    assert cu.ENTER == b"\r"
    assert cu.PROBE_ARGS == ("--ax-screen-reader",)
    assert "-p" not in cu.PROBE_ARGS
