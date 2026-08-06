from __future__ import annotations

import asyncio
import codecs
import errno
import fcntl
import logging
import os
import pty
import re
import shlex
import shutil
import signal
import struct
import subprocess
import termios
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import IO, Any, Awaitable, Callable
from uuid import uuid4

from . import pty_registry


# Strip ALL ANSI/VT escape sequences for clean log output:
#   CSI:  \x1b[ ... final-byte
#   OSC:  \x1b] ... \x07  (window title, colour palettes, etc.)
#   OSC (ST-terminated): \x1b] ... \x1b\\
#   DCS:  \x1b P ... \x1b\\
#   APC:  \x1b _ ... \x1b\\
#   SOS:  \x1b X ... \x1b\\
#   PM:   \x1b ^ ... \x1b\\
#   Single-char:  \x1b followed by any byte 0x20-0x7E (includes \x1b7, \x1b8, etc.)
_ANSI_RE = re.compile(
    r"\x1b(?:"
    r"\[[0-?]*[ -/]*[@-~]"          # CSI sequences
    r"|\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC (BEL or ST terminated)
    r"|[PX^_][^\x1b]*\x1b\\"        # DCS / APC / SOS / PM
    r"|[@-Z\\-~]"                   # single-byte Fe sequences (incl. \x1b7 \x1b8 = \x1b8)
    r")"
)

# TUI chrome lines we never want in the conversation log.
_TUI_NOISE_RE = re.compile(
    r"bypasspermissions|shift\+tab|esc to interrupt|esctointerrupt"
    r"|tointerrupt|for agents|/effort"
    r"|\[end of text\]"
    r"|^\s*$",   # blank lines (handled separately below)
    re.IGNORECASE,
)


def _clean_for_log(raw: str) -> str:
    """Strip ANSI codes, lone carriage returns, and TUI chrome from terminal output.

    The result is human-readable plain text suitable for a conversation log.
    """
    # 1. Strip all ANSI / VT escape sequences.
    text = _ANSI_RE.sub("", raw)
    # 2. Lone \\r (carriage-return without \\n) means "overwrite this line"
    #    in terminal semantics. Replace with newline so we don't lose content
    #    but accept that some duplicate/overwritten lines may appear.
    text = re.sub(r"\r(?!\n)", "\n", text)
    # 3. Filter out TUI chrome lines and collapse consecutive blank lines.
    lines_out: list[str] = []
    blank_run = 0
    for line in text.splitlines():
        stripped = line.rstrip()
        if _TUI_NOISE_RE.search(stripped):
            continue
        if not stripped:
            blank_run += 1
            if blank_run <= 1:
                lines_out.append("")
        else:
            blank_run = 0
            lines_out.append(stripped)
    return "\n".join(lines_out)

from .ipc import make_event

log = logging.getLogger("agent_team_backend.terminals")

EventSink = Callable[[dict[str, Any]], Awaitable[None]]
# Kept as a deprecated, no-op type alias — historical token sink callback.
# Tokens are now sourced from log files (see agent_team_backend.log_readers).
TokenEventSink = Callable[..., Awaitable[None]]


@dataclass
class TerminalSession:
    id: str
    pane_id: str
    agent_key: str | None
    command: list[str]
    cwd: str
    master_fd: int
    proc: subprocess.Popen[bytes]
    started_monotonic: float = field(default_factory=time.monotonic)
    sequence: int = 0
    closed: bool = False
    close_reason: str | None = None
    exit_code: int | None = None
    uptime_ms: int | None = None
    exit_signal: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    output_log_fp: IO[str] | None = field(default=None, repr=False)
    # Per-session vendor-parser state — used by vendor_parsers.parse_chunk to
    # compute deltas against the last seen cumulative token totals.
    vendor_parser_state: dict[str, Any] = field(default_factory=dict)
    # Rolling snapshot of the child's descendant pids (pid -> ps lstart at
    # capture time), refreshed by the service's snapshot loop while the child
    # is alive. When the child dies on its own (EOF path) its ancestry is
    # already gone from the ps table, so this is the only record of
    # grandchildren in their own process group (e.g. MCP servers a CLI spawns
    # detached) that leak as orphans. lstart is the identity check that keeps
    # a stale entry from ever matching a recycled pid (same pattern as
    # pty_registry).
    descendants: dict[int, str] = field(default_factory=dict)


# Output logs currently held open for append by a live session (terminal
# session id -> path). Process-wide on purpose: every WebSocket session owns
# its own TerminalService, while the storage scan that consults this runs
# without any session context. Mutated from the event loop and read from
# worker threads (asyncio.to_thread), hence the lock.
_live_output_logs: dict[str, str] = {}
_live_output_logs_lock = threading.Lock()


def _register_live_log(session_id: str, path: str) -> None:
    with _live_output_logs_lock:
        _live_output_logs[session_id] = path


def _forget_live_log(session_id: str) -> None:
    with _live_output_logs_lock:
        _live_output_logs.pop(session_id, None)


def live_output_log_paths() -> set[str]:
    """Paths of the transcript logs live panes are writing into right now.

    The storage scan uses this to keep such a log out of every cleanable
    bucket: unlinking it would send the PTY's ongoing writes to a deleted
    inode, so the transcript silently stops growing and the file is gone.
    """
    with _live_output_logs_lock:
        return set(_live_output_logs.values())


# Batch PTY output chunks for up to this many milliseconds before sending a
# single WebSocket message.  Without batching, a streaming agent can produce
# hundreds of tiny messages per second and overwhelm Electron's Network service
# process, causing it to crash (exit_code=15 / white-screen).
# 50ms keeps latency acceptable (<1 frame at 60fps perceived) while cutting
# the message rate by ~10-20x vs unbatched — empirically prevents the crash.
_OUTPUT_BATCH_MS = 50

# How much we take from the PTY per readable callback.  This has to be larger
# than one TUI viewport repaint: a full-screen CLI (Claude Code, Codex) rewrites
# its whole viewport plus cursor-positioning escapes on every single keystroke,
# which easily runs past 20 KB.  Reading it 4 KB at a time turned one repaint
# into enough chunks to saturate the fast-path window below, so every keystroke
# echo paid the full batch delay for as long as the user kept typing — the
# window never got a chance to cool down.  Chunk count only means "sustained
# stream" if a chunk is big enough to represent real throughput.
#
# CAVEAT (measured 2026-08-06): on macOS this size is aspirational.  A PTY
# master read returns at most 1024 bytes however much is asked for — a 200 KB
# burst comes back as 196 reads, never one — so a repaint is still split here.
# _COALESCE_MS below is what actually reassembles it.
_READ_CHUNK_BYTES = 64 * 1024

# Interactive fast path: keystroke echo is a trickle of bytes, and delaying it
# the full batch window makes typing feel laggy (worst for IME input, where the
# wait lands on the commit).  When a session produced less than
# _FAST_PATH_MAX_BYTES within _FAST_PATH_WINDOW_S, flush on the next loop tick
# instead.  Sustained streams exceed the threshold and fall back to
# _OUTPUT_BATCH_MS batching, so the flood protection above still holds.
#
# The gate is BYTES, not chunk count.  Counting chunks conflated "many small
# reads" with "high throughput": a CLI that wakes the reader often — repainting
# a spinner, or splitting one repaint across reads — looked like a stream and
# pushed the typist onto the 50ms path even though the actual data rate was
# trivial.  _READ_CHUNK_BYTES above already made one repaint one chunk for the
# well-behaved CLIs; the byte gate covers the ones it didn't.
# 192KB/0.1s ~= 1.9MB/s: an order of magnitude above per-keystroke repaint
# traffic (tens of KB per key, even while a CLI redraws its footer), well
# below what a real output flood sustains.
_FAST_PATH_WINDOW_S = 0.1
_FAST_PATH_MAX_BYTES = 192 * 1024

# Coalescing window on the interactive fast path.  Flushing on the next loop
# tick (0ms) sounds like the lowest-latency choice, but because macOS caps a
# PTY read at 1024 bytes (see _READ_CHUNK_BYTES), one 20 KB repaint arrives as
# ~20 reads and each got its own flush — 20 WebSocket frames per keystroke,
# every one of them paying a remove_reader/send/add_reader cycle that stops
# draining the PTY while it sends, and costing the renderer 20 parses and 20
# xterm writes.  Waiting 2ms lets a whole repaint land in one flush.
#
# Measured (20 KB-per-keystroke TUI, 60 keystrokes, same round):
#   0ms: p50 7.6ms, p95 34.7ms, 20 frames/keystroke
#   2ms: p50 5.4ms, p95 25.1ms,  1 frame/keystroke
# The window pays for itself — the per-frame overhead it removes exceeds the
# wait.  It stays well under one 16.7ms display frame, so the IME-commit
# concern that motivated the 0ms path (a commit must not wait for a frame)
# still holds.
_COALESCE_MS = 2


def _ps_snapshot() -> dict[int, tuple[int, int, str]]:
    """pid -> (ppid, pgid, lstart) for every process, from one ps snapshot.
    lstart (process start time) is the identity that defeats pid recycling;
    pgid distinguishes detached descendants (own group) from same-group
    children. The registry's fixed locale (pty_registry._PS_ENV) keeps the
    lstart string comparable to one captured by a previous backend run.
    Empty on failure."""
    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,ppid=,pgid=,lstart="],
            capture_output=True,
            text=True,
            timeout=5,
            env=pty_registry._PS_ENV,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    snap: dict[int, tuple[int, int, str]] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        try:
            pid, ppid, pgid = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        snap[pid] = (ppid, pgid, " ".join(parts[3:]))
    return snap


def _children_map(snap: dict[int, tuple[int, int, str]]) -> dict[int, list[int]]:
    children: dict[int, list[int]] = {}
    for pid, entry in snap.items():
        children.setdefault(entry[0], []).append(pid)
    return children


def _walk_descendants(children: dict[int, list[int]], root_pid: int) -> list[int]:
    found: list[int] = []
    seen: set[int] = {root_pid}  # never re-list root itself if a cycle points back
    stack = list(children.get(root_pid, []))
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue  # defends against a recycled-pid cycle in the ps table
        seen.add(pid)
        found.append(pid)
        stack.extend(children.get(pid, []))
    return found


def _descendant_pids(root_pid: int) -> list[int]:
    """Every PID descended from root_pid (child, grandchild, ...) from one ps
    snapshot. killpg on the PTY child's process group misses any grandchild
    that called setsid to start its own session/group (some CLIs do) — those
    outlive the group kill and become orphans. Snapshot the tree while root is
    still alive; once it dies the grandchildren reparent to launchd (ppid 1)
    and the ancestry is gone."""
    return _walk_descendants(_children_map(_ps_snapshot()), root_pid)


# Steady-state cadence of the descendant-snapshot loop. MCP servers and other
# grandchildren appear within seconds of the CLI starting and the set is
# stable afterwards, so a coarse interval is enough once sessions are mature.
_DESCENDANT_SNAPSHOT_INTERVAL_S = 30.0

# Fast cadence while any session is younger than the normal interval: a CLI's
# grandchildren spawn a few seconds after it, and crash-on-startup is the most
# common ungraceful death — without the fast ticks every young session would
# be blind for up to a full interval.
_DESCENDANT_SNAPSHOT_FAST_S = 5.0

# After an EOF (child died on its own), wait this long before sweeping its
# snapshot: a gracefully exiting CLI shuts its own servers down within this
# window, leaving nothing to kill.
_EXIT_ORPHAN_GRACE_S = 1.0


def _kill_breakaway(pids: "list[int] | tuple[int, ...]") -> None:
    """SIGKILL each pid still alive — the breakaway grandchildren a process-
    group kill could not reach. Idempotent: pids already reaped by the group
    kill raise ProcessLookupError and are skipped. Best-effort: a pid recycled
    within the ~1s grace could in theory be mis-hit, but macOS/Linux recycle
    pids slowly enough that this is negligible on a kill path."""
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


class TerminalService:
    def __init__(
        self,
        emit: EventSink,
        token_event_sink: TokenEventSink | None = None,
    ) -> None:
        self._sessions: dict[str, TerminalSession] = {}
        self._emit = emit
        self._token_event_sink = token_event_sink
        self._loop = asyncio.get_event_loop()
        # Per-session output batching state
        self._out_buffers: dict[str, list[str]] = {}   # session_id -> pending chunks
        self._out_handles: dict[str, asyncio.TimerHandle] = {}  # session_id -> timer
        # Per-session pending INPUT bytes not yet accepted by the non-blocking
        # PTY master (EAGAIN / partial write). Drained via add_writer.
        self._in_buffers: dict[str, bytearray] = {}    # session_id -> pending bytes
        # Per-session incremental UTF-8 decoders. PTY reads are raw byte chunks
        # that can split a multi-byte character (CJK is 3 bytes/char); decoding
        # each chunk independently turns the halves into U+FFFD, which desyncs
        # the CLI's cursor math from what xterm renders (layout corruption).
        self._decoders: dict[str, codecs.IncrementalDecoder] = {}
        # Per-session (monotonic loop time, byte count) of recent PTY chunks,
        # used to pick the interactive fast path vs. batched flush delay.
        # maxlen only bounds memory against pathological tiny reads; the
        # window itself is trimmed by time in _window_bytes.
        self._recent_chunks: dict[str, deque[tuple[float, int]]] = {}
        # Temporary Phase B probe (plan residual-cli-latency-fix-plan_4b8e2f):
        # per-session rolling counters for fast-path saturation reporting.
        # Remove with _note_fastpath_stats once the measurement round is done.
        self._fastpath_stats: dict[str, dict[str, float]] = {}
        # Background task keeping each live session's descendant snapshot
        # fresh, so the EOF path can reap orphans (see _reap_exit_orphans).
        # The wakeup event lets create() pull the next refresh forward.
        # Dead sessions' snapshots queue in _pending_reaps and one sweeper
        # task drains them in batches (one ps per batch, however many
        # sessions died together); kill_all awaits it so in-flight sweeps
        # finish before shutdown.
        self._snapshot_task: "asyncio.Task[None] | None" = None
        self._snapshot_wakeup = asyncio.Event()
        self._pending_reaps: dict[int, str] = {}
        self._reap_task: "asyncio.Task[None] | None" = None
        self._last_persisted: dict[int, dict[int, str]] = {}

    def create(
        self,
        *,
        pane_id: str,
        agent_key: str | None,
        command: str | list[str],
        cwd: str,
        cols: int = 100,
        rows: int = 30,
        env: dict[str, str] | None = None,
        env_remove: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        output_log_file: str = "",
    ) -> TerminalSession:
        argv = self._resolve_command(command)
        if not os.path.isdir(cwd):
            raise FileNotFoundError(f"cwd does not exist: {cwd}")
        if not shutil.which(argv[0]):
            raise FileNotFoundError(f"executable not found: {argv[0]}")

        master, slave = pty.openpty()
        self._set_winsize(master, rows, cols)
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        final_env = os.environ.copy()
        final_env["TERM"] = final_env.get("TERM", "xterm-256color")
        final_env["COLUMNS"] = str(cols)
        final_env["LINES"] = str(rows)
        if env:
            final_env.update(env)
        for key in env_remove or ():
            final_env.pop(key, None)

        started_monotonic = time.monotonic()
        try:
            proc = subprocess.Popen(
                argv,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=cwd,
                env=final_env,
                close_fds=True,
                start_new_session=True,
            )
        except Exception:
            os.close(master)
            os.close(slave)
            raise
        try:
            os.close(slave)
        except BaseException:
            self._abort_failed_create(proc, master, registry_future=None)
            raise
        # Record the child so a future backend start can reap it if this
        # process dies without running its shutdown sweep. register runs a ps
        # probe + registry-file I/O — keep it off the event loop so the
        # terminal.create ack isn't delayed behind it.
        registry_future: asyncio.Future[Any] | None = None
        try:
            registry_future = asyncio.get_running_loop().run_in_executor(
                None, pty_registry.register, proc.pid, argv
            )
        except RuntimeError:
            # No running loop (non-async caller) — fall back to inline.
            try:
                pty_registry.register(proc.pid, argv)
            except BaseException:
                self._abort_failed_create(proc, master, registry_future=None)
                raise
        except BaseException:
            self._abort_failed_create(proc, master, registry_future=None)
            raise

        # Open output log file if requested (pipeline panes pass a path).
        log_fp: IO[str] | None = None
        if output_log_file:
            try:
                os.makedirs(os.path.dirname(output_log_file), exist_ok=True)
                log_fp = open(output_log_file, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
            except Exception as err:  # noqa: BLE001
                log.warning("cannot open output log %s: %s", output_log_file, err)

        session: TerminalSession | None = None
        try:
            session = TerminalSession(
                id=str(uuid4()),
                pane_id=pane_id,
                agent_key=agent_key,
                command=argv,
                cwd=cwd,
                master_fd=master,
                proc=proc,
                started_monotonic=started_monotonic,
                metadata=metadata or {},
                output_log_fp=log_fp,
            )
            self._sessions[session.id] = session
            if log_fp is not None:
                _register_live_log(session.id, output_log_file)
            self._loop.add_reader(master, self._on_readable, session)
        except BaseException:
            if session is not None:
                self._sessions.pop(session.id, None)
                _forget_live_log(session.id)
            if log_fp:
                try:
                    log_fp.close()
                except Exception:  # noqa: BLE001
                    pass
            self._abort_failed_create(proc, master, registry_future=registry_future)
            raise
        if self._snapshot_task is None or self._snapshot_task.done():
            try:
                self._snapshot_task = asyncio.get_running_loop().create_task(
                    self._snapshot_loop()
                )
            except RuntimeError:
                # No running loop (non-async caller, e.g. sync tests) — rolling
                # snapshots stay empty; kill() still sweeps via its own snapshot.
                pass
        else:
            # Pull the next refresh forward so this session isn't blind for a
            # full interval (the loop then ticks fast while it is young).
            self._snapshot_wakeup.set()
        log.info(
            "terminal session created id=%s pane=%s pid=%s cmd=%s",
            session.id,
            pane_id,
            proc.pid,
            argv,
        )
        return session

    def _abort_failed_create(
        self,
        proc: subprocess.Popen[bytes],
        master_fd: int,
        *,
        registry_future: asyncio.Future[Any] | None,
    ) -> None:
        """Undo a Popen whose TerminalSession setup did not complete."""
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=1.0)
        except (subprocess.TimeoutExpired, OSError):
            pass

        def unregister(_future: asyncio.Future[Any] | None = None) -> None:
            try:
                pty_registry.unregister(proc.pid)
            except Exception as err:  # noqa: BLE001
                log.warning("failed-create registry cleanup failed for pid %s: %s", proc.pid, err)

        # register() may already be running in the executor.  Queue unregister
        # only after it settles, or its eventual write could resurrect the
        # failed child in the crash-recovery registry.
        if registry_future is not None:
            registry_future.add_done_callback(
                lambda future: self._loop.run_in_executor(None, unregister, future)
            )
        else:
            unregister()

    def get(self, session_id: str) -> TerminalSession | None:
        """The session for ``session_id``, or None when unknown."""
        return self._sessions.get(session_id)

    def list_session_ids(self) -> list[str]:
        """Ids of all live (not closed) sessions."""
        return [s.id for s in self._sessions.values() if not s.closed]

    def find_live_by_resume_id(
        self,
        agent_key: str,
        resume_id: str,
        extract_resume_id: Callable[[list[str]], str],
    ) -> list[TerminalSession]:
        """Live sessions of ``agent_key`` whose launch command resumes
        ``resume_id`` (extractor injected to keep argv parsing out of this
        module)."""
        return [
            s
            for s in self._sessions.values()
            if not s.closed
            and s.agent_key == agent_key
            and extract_resume_id(s.command) == resume_id
        ]

    def write(self, session_id: str, data: str) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        # Queue the bytes and try to drain now. The PTY master is non-blocking,
        # so a full kernel buffer raises EAGAIN. The old code dropped the chunk
        # on EAGAIN (silent data loss — the agent's input box stayed empty while
        # the caller still logged "✓ sent"). Instead we buffer whatever the
        # kernel won't take and finish it from an add_writer callback. partial
        # writes (os.write accepting < len) are handled the same way.
        buf = self._in_buffers.setdefault(session_id, bytearray())
        buf.extend(data.encode("utf-8"))
        self._flush_input(session)

    def _flush_input(self, session: TerminalSession) -> None:
        """Drain a session's pending input into the PTY master without blocking.

        Loops on partial writes; on EAGAIN leaves the remainder buffered and
        registers an add_writer callback to resume once the fd is writable.
        """
        buf = self._in_buffers.get(session.id)
        if buf is None or session.closed:
            return
        while buf:
            try:
                n = os.write(session.master_fd, buf)
            except BlockingIOError:
                break  # kernel buffer full — resume on writable
            except OSError as err:
                log.warning("write to session %s failed: %s", session.id, err)
                buf.clear()
                self._unwatch_writable(session)
                return
            if n <= 0:
                break
            del buf[:n]
        if buf:
            self._watch_writable(session)
        else:
            self._unwatch_writable(session)

    def _on_writable(self, session: TerminalSession) -> None:
        self._flush_input(session)

    def _watch_writable(self, session: TerminalSession) -> None:
        self._loop.add_writer(session.master_fd, self._on_writable, session)

    def _unwatch_writable(self, session: TerminalSession) -> None:
        try:
            self._loop.remove_writer(session.master_fd)
        except (ValueError, KeyError, OSError):
            pass

    def log_sent(self, session_id: str, label: str, text: str) -> None:
        """Append a human-readable record of injected text to the session log.

        Call this BEFORE chunked write() calls so the log shows the full
        message in one block rather than fragmented 512-byte slices.
        The output_log_fp is only set for pipeline panes — silently ignored
        for manual/interactive panes.
        """
        session = self._sessions.get(session_id)
        if not session or not session.output_log_fp:
            return
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        marker = f"[→ {label.upper()} @ {ts}]"
        sep = "─" * min(60, len(marker) + 4)
        try:
            session.output_log_fp.write(
                f"\n{sep}\n{marker}\n{sep}\n{text}\n{sep}\n\n"
            )
        except Exception as err:  # noqa: BLE001
            log.warning("log_sent write failed: %s", err)

    def resize(self, session_id: str, cols: int, rows: int) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        self._set_winsize(session.master_fd, rows, cols)

    def force_redraw(self, session_id: str, cols: int, rows: int) -> None:
        """Nudge the PTY size to raise SIGWINCH so a TUI repaints after reattach.
        Resizing to the identical current size would not signal the program, so
        set a transient off-by-one row then the real size. This is how a
        reattaching renderer recovers the screen — there is no output buffer."""
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return
        self._set_winsize(session.master_fd, max(rows - 1, 1), cols)
        self._set_winsize(session.master_fd, rows, cols)

    async def drain_output(self, session_id: str) -> None:
        """Flush all pending and kernel-buffered output before the caller's
        next send (the resize ack), AWAITING each emit so it lands first.

        Output is normally batched behind a 50ms timer (`_out_handles`) and
        emitted via `create_task`, so old-width bytes can reach the frontend
        AFTER the resize ack — xterm then re-wraps stale-width content and the
        CLI's cursor-up repaints strand corrupt frames in scrollback. Draining
        makes the ack a true ordering barrier: old-width output < ack < any
        new-width output.
        """
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return
        # 1. Slurp any kernel-buffered bytes the reader hasn't picked up yet,
        #    reusing the incremental decoder so a split multi-byte char isn't
        #    turned into U+FFFD.
        decoder = self._decoders.get(session.id)
        if decoder is None:
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            self._decoders[session.id] = decoder
        while True:
            try:
                chunk = os.read(session.master_fd, 4096)
            except (BlockingIOError, OSError):
                break
            if not chunk:
                break
            decoded = decoder.decode(chunk)
            if decoded:
                self._out_buffers.setdefault(session.id, []).append(decoded)
        # 2. Cancel the pending batch timer; we emit synchronously below.
        handle = self._out_handles.pop(session.id, None)
        if handle:
            handle.cancel()
        # 3. Emit everything buffered, awaiting so it precedes the ack on the wire.
        chunks = self._out_buffers.pop(session.id, None)
        if not chunks:
            return
        combined = "".join(chunks)
        for piece in self._split_chunks(combined):
            await self._emit(self._build_output_event(session, piece))
        if session.output_log_fp:
            try:
                session.output_log_fp.write(_clean_for_log(combined))
            except Exception as err:  # noqa: BLE001
                log.warning("output log write failed: %s", err)

    def interrupt(self, session_id: str) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        try:
            from .cli_vendors.registry import vendor

            spec = vendor(session.agent_key or "")
            if spec is not None and spec.interrupt_key is not None:
                seq = spec.interrupt_key
            else:
                seq = b"\x1b" if session.agent_key == "codex" else b"\x03"
            os.write(session.master_fd, seq)
        except OSError as err:
            log.warning("interrupt session %s failed: %s", session_id, err)

    async def kill(self, session_id: str, force: bool = False) -> None:
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return

        # Snapshot the descendant tree BEFORE close: killpg below only reaches
        # the child's own process group, so a grandchild that called setsid
        # would survive. Capture the tree now — after the child dies its
        # grandchildren reparent to launchd and can no longer be found.
        # Offload the full-system `ps` snapshot (timeout 5s) to a thread so a
        # slow snapshot never blocks the event loop — a batch of kills on
        # workspace switch would otherwise stall unrelated requests (e.g. the
        # Welcome screen's workspace.list_recent) past their 10s timeout.
        descendants = await asyncio.to_thread(_descendant_pids, session.proc.pid)
        try:
            pgid = os.getpgid(session.proc.pid)
            if force:
                os.killpg(pgid, signal.SIGKILL)
            else:
                os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            # Group already gone — closing the PTY master HUPs the child, so
            # it often dies before the SIGTERM lands. The escalation task
            # still runs to reap it and drop its crash-recovery record.
            pgid = 0

        self._close(session, reason="killed")

        # A CLI that traps SIGTERM would survive the close and, being gone
        # from _sessions, escape the shutdown sweep — escalate to SIGKILL
        # after a grace period and only then drop its crash-recovery record.
        self._loop.create_task(
            self._escalate_kill(session, pgid, descendants=descendants)
        )

    async def _put_down_error_survivor(self, session: TerminalSession) -> None:
        """Kill a child whose PTY master died on a read error while the child
        itself is still alive. The session is already closed and popped from
        _sessions at this point, so without this the child would escape both
        terminal.kill and the shutdown sweep until the next backend start's
        reap_stale — yet nobody can ever interact with it again (its tty is
        gone). Mirrors kill(): snapshot descendants while the child is alive,
        then TERM the group and escalate."""
        descendants = await asyncio.to_thread(_descendant_pids, session.proc.pid)
        try:
            pgid = os.getpgid(session.proc.pid)
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pgid = 0
        await self._escalate_kill(session, pgid, descendants=descendants)

    async def _escalate_kill(
        self,
        session: TerminalSession,
        pgid: int,
        grace: float = 1.0,
        descendants: "list[int] | tuple[int, ...]" = (),
    ) -> None:
        deadline = self._loop.time() + grace
        # ASYNC110 suppressed: bounded poll (<= grace) with awaited sleeps —
        # the loop is never blocked, and there is no event source for
        # child-exit here.
        while session.proc.poll() is None and self._loop.time() < deadline:  # noqa: ASYNC110
            await asyncio.sleep(0.05)
        if session.proc.poll() is None and pgid > 0:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                # Reap the zombie so poll() flips before we unregister.
                await asyncio.to_thread(session.proc.wait, 1.0)
            except subprocess.TimeoutExpired:
                pass
        # Reap breakaway grandchildren that escaped the process group via setsid.
        _kill_breakaway(descendants)
        if session.proc.poll() is not None:
            await asyncio.to_thread(pty_registry.unregister, session.proc.pid)

    async def _snapshot_loop(self) -> None:
        """Keep every live session's descendant snapshot fresh. kill()
        snapshots on demand because the child is still alive then; the EOF
        path cannot — by the time the PTY master reports EIO the child is
        dead and its grandchildren have reparented, so the tree must have
        been captured beforehand. Self-terminating: returns when no live
        session remains (create() restarts it). Ticks fast while any session
        is young, at the normal interval otherwise; create() can also pull
        the next tick forward via the wakeup event."""
        while True:
            live = [s for s in self._sessions.values() if not s.closed]
            if not live:
                return
            try:
                snap = await asyncio.to_thread(_ps_snapshot)
                payload = self._refresh_descendants(snap)
                # Persist into the crash-recovery registry so a backend that
                # dies without its shutdown sweep leaves the next start's
                # reap_stale enough to take detached grandchildren down too.
                # Skipped entirely when nothing changed since the last write
                # (steady state) — no lock, no file read.
                if payload and payload != self._last_persisted:
                    await asyncio.to_thread(
                        pty_registry.update_descendants, payload
                    )
                    self._last_persisted = payload
            except Exception as err:  # noqa: BLE001 — the loop must survive
                log.warning("descendant snapshot failed: %s", err)
            youngest = min(time.monotonic() - s.started_monotonic for s in live)
            interval = (
                _DESCENDANT_SNAPSHOT_FAST_S
                if youngest < _DESCENDANT_SNAPSHOT_INTERVAL_S
                else _DESCENDANT_SNAPSHOT_INTERVAL_S
            )
            self._snapshot_wakeup.clear()
            try:
                await asyncio.wait_for(self._snapshot_wakeup.wait(), timeout=interval)
            except TimeoutError:
                pass

    def _refresh_descendants(
        self, snap: dict[int, tuple[int, int, str]]
    ) -> dict[int, dict[int, str]]:
        """Update every live session's in-memory descendant snapshot and
        return the registry-worthy view: only descendants that escaped the
        root's process group can outlive its killpg, so persisting same-group
        churn (transient git/rg children) would rewrite the registry every
        tick for nothing. A live session with no detached descendants is
        still included (empty dict) so a stale registry record gets cleared."""
        if not snap:
            return {}  # ps failed — keep the last good snapshots
        children = _children_map(snap)
        persist: dict[int, dict[int, str]] = {}
        for session in self._sessions.values():
            if session.closed:
                continue
            if session.proc.pid not in snap:
                # Child already gone from the table (its death racing the EOF
                # callback) — keep the last snapshot; _close still needs it.
                continue
            pids = _walk_descendants(children, session.proc.pid)
            session.descendants = {pid: snap[pid][2] for pid in pids}
            persist[session.proc.pid] = {
                pid: snap[pid][2]
                for pid in pids
                if snap[pid][1] != session.proc.pid
            }
        return persist

    async def _reap_pending_orphans(self) -> None:
        """Batch sweeper for _pending_reaps: sessions that died around the
        same time share one grace window and one ps snapshot — a mass die-off
        (e.g. an OOM sweep killing dozens of CLIs in the same second) would
        otherwise fork one full-table ps per session at once. The queue is
        drained BEFORE the grace sleep so every dead session gets at least
        the full grace (a death landing during the sleep or sweep waits for
        the next round). Exception-guarded — a failed sweep must not strand
        queued entries; self-terminating when the queue drains (_close
        restarts it on the next death)."""
        while self._pending_reaps:
            batch, self._pending_reaps = self._pending_reaps, {}
            await asyncio.sleep(_EXIT_ORPHAN_GRACE_S)
            try:
                await self._reap_exit_orphans(batch)
            except Exception as err:  # noqa: BLE001 — the sweeper must survive
                log.warning("exit-orphan sweep failed: %s", err)

    async def _reap_exit_orphans(self, descendants: dict[int, str]) -> None:
        """After a PTY child died on its own (EOF/error path — no kill() ran)
        and the sweeper's grace elapsed, sweep its last descendant snapshot.
        A pid is killed only when it is (a) now orphaned — reparented to
        launchd (ppid 1) or to this backend (observed macOS behavior) — and
        (b) still the same process, verified by comparing its ps lstart
        against the one recorded at snapshot time (defeats pid recycling;
        empty lstart on either side skips the check). A verified orphan's
        current subtree is killed with it (a leaked `npm exec` wrapper still
        parents its own node child at sweep time)."""
        snap = await asyncio.to_thread(_ps_snapshot)
        if not snap:
            return  # ps failed — cannot verify identities, do not kill blind
        children = _children_map(snap)
        me = os.getpid()
        targets: list[int] = []
        for pid, recorded_lstart in descendants.items():
            entry = snap.get(pid)
            if entry is None:
                continue
            ppid, _pgid, lstart = entry
            if ppid not in (1, me):
                continue  # still parented by a live process — not our orphan
            if recorded_lstart and lstart and lstart != recorded_lstart:
                continue  # pid recycled since the snapshot — different process
            targets.append(pid)
            targets.extend(_walk_descendants(children, pid))
        if targets:
            log.info("reaping %d orphaned descendant(s): %s", len(targets), targets)
            _kill_breakaway(targets)

    async def kill_all(self, grace: float = 1.0) -> None:
        """Terminate every live PTY child. Children run with
        start_new_session=True (own process group), so killing the backend
        never propagates to them — without this explicit sweep on shutdown
        they outlive the app as orphans."""
        if self._snapshot_task is not None:
            self._snapshot_task.cancel()
            self._snapshot_task = None
        targets: list[tuple[TerminalSession, int]] = []
        breakaway: list[int] = []
        # One shared ps snapshot for every session's descendant sweep. The
        # previous per-session snapshot (a full `ps -Ao` each, 5s budget)
        # pushed a many-pane shutdown past Electron's SIGKILL deadline, so
        # the sweep never got to the actual kills. Off the loop via to_thread.
        children = _children_map(await asyncio.to_thread(_ps_snapshot))
        for session in list(self._sessions.values()):
            if session.closed:
                continue
            # Snapshot descendants while the child is still alive (see kill()).
            breakaway.extend(_walk_descendants(children, session.proc.pid))
            try:
                targets.append((session, os.getpgid(session.proc.pid)))
            except ProcessLookupError:
                # Child already gone — still close so the session is removed
                # and its registry entry is dropped.
                self._close(session, reason="shutdown")
        for _, pgid in targets:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        deadline = self._loop.time() + grace
        # ASYNC110 suppressed: bounded poll with awaited sleeps, as above.
        while (  # noqa: ASYNC110
            any(s.proc.poll() is None for s, _ in targets)
            and self._loop.time() < deadline
        ):
            await asyncio.sleep(0.05)
        for session, pgid in targets:
            if session.proc.poll() is None:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    # Reap immediately (SIGKILL is not trappable) so _close's
                    # death-confirmed unregister drops the registry entry.
                    session.proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    pass
            self._close(session, reason="shutdown")
        # Let the in-flight exit-orphan sweep finish: a CLI that EOF'd moments
        # before shutdown would otherwise leak its orphans when the loop
        # closes mid-grace.
        if self._reap_task is not None and not self._reap_task.done():
            await asyncio.gather(self._reap_task, return_exceptions=True)
        # Reap breakaway grandchildren that escaped every process group.
        _kill_breakaway(breakaway)

    def _require(self, session_id: str) -> TerminalSession:
        session = self._sessions.get(session_id)
        if not session:
            raise KeyError(f"unknown terminal session: {session_id}")
        return session

    def _resolve_command(self, command: str | list[str]) -> list[str]:
        if isinstance(command, list):
            argv = list(command)
        else:
            argv = shlex.split(command)
        if not argv:
            raise ValueError("command is empty")
        return argv

    def _set_winsize(self, fd: int, rows: int, cols: int) -> None:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def _on_readable(self, session: TerminalSession) -> None:
        if session.closed:
            return
        try:
            chunk = os.read(session.master_fd, _READ_CHUNK_BYTES)
        except BlockingIOError:
            return
        except OSError as err:
            if err.errno in (errno.EIO,):
                # PTY closed (child exited and tty was released)
                self._close(session, reason="exit")
                return
            log.warning("read session %s failed: %s", session.id, err)
            self._close(session, reason="error")
            return

        if not chunk:
            self._close(session, reason="exit")
            return

        # Accumulate decoded bytes; schedule a flush if not already pending.
        _BUF_CAP = 5 * 1024 * 1024  # 5 MB — force an immediate flush if exceeded
        decoder = self._decoders.get(session.id)
        if decoder is None:
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            self._decoders[session.id] = decoder
        decoded = decoder.decode(chunk)
        if not decoded:
            return  # chunk ended mid-character; bytes held until the rest arrives
        buf = self._out_buffers.setdefault(session.id, [])
        buf.append(decoded)
        window = self._recent_chunks.setdefault(session.id, deque(maxlen=512))
        now = self._loop.time()
        window.append((now, len(chunk)))
        self._note_fastpath_stats(session, len(chunk), now)
        buf_size = sum(len(s) for s in buf)
        if buf_size >= _BUF_CAP:
            # Cancel the pending debounce timer and flush now to avoid OOM.
            existing = self._out_handles.pop(session.id, None)
            if existing:
                existing.cancel()
            self._flush_output(session)
        elif session.id not in self._out_handles:
            handle = self._loop.call_later(
                self._flush_delay(session.id),
                self._flush_output,
                session,
            )
            self._out_handles[session.id] = handle

    def _note_fastpath_stats(
        self, session: TerminalSession, nbytes: int, now: float
    ) -> None:
        """Temporary Phase B probe (plan residual-cli-latency-fix-plan_4b8e2f):
        once per ~5s per session, report how many PTY chunks arrived with the
        fast-path window already saturated (i.e. would be flushed on the 50ms
        batch delay), so laggy CLIs can be checked against the byte envelope.
        Silent while nothing saturates. Remove after measurement."""
        st = self._fastpath_stats.setdefault(
            session.id, {"t0": now, "chunks": 0, "bytes": 0, "max": 0, "batched": 0}
        )
        st["chunks"] += 1
        st["bytes"] += nbytes
        st["max"] = max(st["max"], nbytes)
        if self._window_bytes(session.id) > _FAST_PATH_MAX_BYTES:
            st["batched"] += 1
        if now - st["t0"] >= 5.0:
            if st["batched"]:
                log.info(
                    "fastpath-stats session=%s agent=%s chunks=%d bytes=%d "
                    "maxchunk=%d batched=%d window=%.1fs",
                    session.id, session.agent_key, st["chunks"], st["bytes"],
                    st["max"], st["batched"], now - st["t0"],
                )
            self._fastpath_stats.pop(session.id, None)

    def _window_bytes(self, session_id: str) -> int:
        """Bytes read from this PTY within the last _FAST_PATH_WINDOW_S,
        dropping entries that fell out of the window."""
        window = self._recent_chunks.get(session_id)
        if not window:
            return 0
        cutoff = self._loop.time() - _FAST_PATH_WINDOW_S
        while window and window[0][0] < cutoff:
            window.popleft()
        return sum(nbytes for _, nbytes in window)

    def _flush_delay(self, session_id: str) -> float:
        """Batch delay for the next flush: _COALESCE_MS while the output rate
        looks interactive, _OUTPUT_BATCH_MS once it looks like a stream."""
        if self._window_bytes(session_id) > _FAST_PATH_MAX_BYTES:
            return _OUTPUT_BATCH_MS / 1000
        return _COALESCE_MS / 1000

    def _flush_output(self, session: TerminalSession) -> None:
        """Send all buffered output for this session as a single WS message.

        If the combined payload exceeds _MAX_WS_PAYLOAD_BYTES we split it into
        chunks so the Electron Network service is never given a single massive
        frame (large frames have been observed to trigger the crash).
        """
        self._out_handles.pop(session.id, None)
        chunks = self._out_buffers.pop(session.id, None)
        if not chunks:
            return
        combined = "".join(chunks)

        # Suspend reading from the PTY while we drain the network buffer.
        # This provides natural backpressure so the CLI blocks when writing
        # instead of OOMing the Python backend or Electron WebSocket receiver.
        try:
            self._loop.remove_reader(session.master_fd)
        except (ValueError, KeyError):
            pass

        async def _drain() -> None:
            try:
                for piece in self._split_chunks(combined):
                    await self._emit(self._build_output_event(session, piece))
            finally:
                if not session.closed:
                    try:
                        self._loop.add_reader(session.master_fd, self._on_readable, session)
                    except (ValueError, OSError) as err:
                        log.warning("re-add reader for session %s failed: %s", session.id, err)

        self._loop.create_task(_drain())

        # Persist cleaned output to the conversation log (if one was opened).
        if session.output_log_fp:
            try:
                session.output_log_fp.write(_clean_for_log(combined))
            except Exception as err:  # noqa: BLE001
                log.warning("output log write failed: %s", err)

    @staticmethod
    def _split_chunks(combined: str) -> list[str]:
        """Split a payload into <=64 KB pieces at valid UTF-8 boundaries.

        Caps individual WS messages well below the point where the Electron
        Network service becomes overwhelmed, never cutting a multi-byte
        character (emoji, CJK, etc.) in half into U+FFFD.
        """
        _MAX_BYTES = 64 * 1024
        encoded = combined.encode("utf-8")
        if len(encoded) <= _MAX_BYTES:
            return [combined]
        pieces: list[str] = []
        pos = 0
        while pos < len(encoded):
            end = min(pos + _MAX_BYTES, len(encoded))
            # Walk back to the start of a multi-byte sequence if we landed
            # inside one (continuation bytes have the form 10xxxxxx).
            while end > pos and end < len(encoded) and (encoded[end] & 0xC0) == 0x80:
                end -= 1
            pieces.append(encoded[pos:end].decode("utf-8"))
            pos = end
        return pieces

    def _build_output_event(self, session: TerminalSession, data: str) -> dict[str, Any]:
        session.sequence += 1
        return make_event(
            "terminal.output",
            {
                "terminal_session_id": session.id,
                "pane_id": session.pane_id,
                "sequence": session.sequence,
                "data": data,
                "stream": "stdout",
            },
        )

    def _send_chunk(self, session: TerminalSession, data: str) -> None:
        self._loop.create_task(self._emit(self._build_output_event(session, data)))

    def _close(self, session: TerminalSession, *, reason: str) -> None:
        if session.closed:
            return
        session.closed = True
        try:
            self._loop.remove_reader(session.master_fd)
        except (ValueError, KeyError):
            pass
        # Stop any pending input drain and discard unwritten bytes before the
        # fd is closed (remove_writer needs a still-valid fd).
        self._unwatch_writable(session)
        self._in_buffers.pop(session.id, None)
        self._recent_chunks.pop(session.id, None)
        self._fastpath_stats.pop(session.id, None)
        try:
            os.close(session.master_fd)
        except OSError:
            pass
        # Cancel pending batch timer and flush any buffered output before the
        # exit event so the client sees all output in order.
        handle = self._out_handles.pop(session.id, None)
        if handle:
            handle.cancel()
        # Drain any bytes the incremental decoder is still holding (a final
        # chunk that ended mid-character) so the tail isn't silently dropped.
        decoder = self._decoders.pop(session.id, None)
        if decoder:
            tail = decoder.decode(b"", final=True)
            if tail:
                self._out_buffers.setdefault(session.id, []).append(tail)
        self._flush_output(session)
        # Best-effort wait for child to avoid zombies
        try:
            session.proc.poll()
        except Exception:
            pass
        exit_code = session.proc.returncode
        uptime_ms = max(0, round((time.monotonic() - session.started_monotonic) * 1000))
        exit_signal: str | None = None
        if exit_code is not None and exit_code < 0:
            try:
                exit_signal = signal.Signals(-exit_code).name
            except ValueError:
                exit_signal = f"SIG{-exit_code}"
        session.close_reason = reason
        session.exit_code = exit_code
        session.uptime_ms = uptime_ms
        session.exit_signal = exit_signal
        log.info("terminal session closed id=%s reason=%s exit=%s", session.id, reason, exit_code)
        if session.output_log_fp:
            try:
                session.output_log_fp.close()
            except Exception:  # noqa: BLE001
                pass
            session.output_log_fp = None
        _forget_live_log(session.id)
        event = make_event(
            "terminal.exit",
            {
                "terminal_session_id": session.id,
                "pane_id": session.pane_id,
                "reason": reason,
                "exit_code": exit_code,
                "uptime_ms": uptime_ms,
                "signal": exit_signal,
                "startup_probe": session.metadata.get("startup_probe"),
            },
        )
        self._loop.create_task(self._emit(event))
        self._sessions.pop(session.id, None)
        # Child died on its own (no kill() ran, so no on-demand descendant
        # sweep happened) — queue its snapshot for the batch sweeper. The poll
        # gate skips the error path's still-alive child: its descendants are
        # not orphans, and killing under a live CLI would be wrong.
        if (
            reason in ("exit", "error")
            and session.descendants
            and session.proc.poll() is not None
        ):
            self._pending_reaps.update(session.descendants)
            if self._reap_task is None or self._reap_task.done():
                self._reap_task = self._loop.create_task(
                    self._reap_pending_orphans()
                )
        # A read error closed the PTY while the child is still alive: it is
        # now unreachable (tty gone, session popped) — put it down, or it
        # escapes both terminal.kill and the shutdown sweep until the next
        # backend start. kill()'s own close passes reason="killed", so this
        # never double-kills.
        if reason == "error" and session.proc.poll() is None:
            self._loop.create_task(self._put_down_error_survivor(session))
        # Drop the crash-recovery record only once the child is confirmed
        # dead: a still-live child (e.g. a TERM-trapping CLI) must stay
        # visible to the next start's reap_stale. kill()'s escalation task
        # and kill_all() unregister the survivors they put down.
        if session.proc.poll() is not None:
            self._loop.run_in_executor(None, pty_registry.unregister, session.proc.pid)
