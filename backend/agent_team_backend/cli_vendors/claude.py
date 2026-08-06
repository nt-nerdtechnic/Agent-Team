"""Claude Code conversation log reader.

Format reference: docs/cli-log-formats.md (Claude section).

Path resolution (first hit wins):
  1. $CLAUDE_CONFIG_DIR/projects
  2. ~/.config/claude/projects
  3. ~/.claude/projects

Each cwd → one subdirectory named per encode_claude_cwd (every
non-alphanumeric char → "-").
Each session → one {uuid}.jsonl file inside that subdirectory.
Token-relevant lines have type="assistant" and message.usage populated.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

import asyncio
import base64
import hashlib
import os
import pty as _pty_unused  # noqa: F401  (real import happens in read_usage_panel)
import re
import signal
import sys
import time
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .base import VendorSpec, command_text
from ..usage_common import (
    _KEYCHAIN_COOLDOWN_S,
    _snapshot,
    communicate_or_kill as _communicate_or_kill,
)
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    join_text_blocks,
    read_jsonl_tail,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.claude")


from ..log_readers.base import encode_claude_cwd  # noqa: F401


def _assistant_text(msg: dict) -> str:
    """Join the text blocks of an assistant message ("" when none)."""
    return join_text_blocks(msg.get("content"), "text")


_PREVIEW_MAX_CHARS = 80


def first_user_prompts(path: Path, limit: int = 2) -> list[str]:
    """The first ``limit`` real human prompts from a Claude .jsonl (best-effort).

    Mirrors parse_session_file's per-line ``json.loads`` loop. A "real" prompt
    is a ``type=="user"`` record whose ``message.content`` is a plain string of
    human text — not a tool_result / injected-text list, and not a slash-command
    or system wrapper (those render as a string starting with "<", e.g.
    ``<command-name>``, ``<task-notification>``, ``<local-command-stdout>``).
    Each prompt is truncated to ~80 chars. Malformed lines are skipped;
    returns ``[]`` when the file cannot be opened.
    """
    out: list[str] = []
    try:
        fh = path.open(encoding="utf-8")
    except OSError as err:
        log.debug("open %s failed: %s", path, err)
        return out

    with fh:
        for raw in fh:
            if len(out) >= limit:
                break
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if rec.get("type") != "user":
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if not isinstance(content, str):
                continue  # tool_result / injected-text lists aren't human prompts
            text = content.strip()
            if not text or text.startswith("<"):
                continue  # command wrappers, task-notifications, resume stubs
            out.append(text[:_PREVIEW_MAX_CHARS])
    return out


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


class ClaudeLogReader(LogReader):
    vendor: str = "claude"

    def _default_root(self) -> Path | None:
        """First-hit-wins default projects root (backend-process view).

        $CLAUDE_CONFIG_DIR overrides; the fallbacks are tried in CodexBar order.
        Returning a single root (not all of them) avoids double-counting if a
        user has both ~/.config/claude and ~/.claude populated by accident.
        """
        env_dir = os.environ.get("CLAUDE_CONFIG_DIR")
        candidates: list[Path] = []
        if env_dir:
            candidates.append(Path(env_dir) / "projects")
        candidates.append(Path.home() / ".config" / "claude" / "projects")
        candidates.append(Path.home() / ".claude" / "projects")
        for p in candidates:
            if p.is_dir():
                return p
        return None

    def project_dirs(self) -> list[Path]:
        """The single default projects root (empty list when none exists).

        Managed-account panes run with CLAUDE_CONFIG_DIR pointed at an isolated
        home, but that home's ``projects`` is symlinked back to the real home
        (credential_vault), so every account's sessions resolve into this one
        root — no separate profile-home scan is needed. Returned as a list for
        the callers that iterate it."""
        default = self._default_root()
        return [default] if default is not None else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if not child.is_dir():
                        continue
                    for f in child.iterdir():
                        if f.is_file() and f.suffix == ".jsonl":
                            out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the jsonl files under this workspace's project subdirectory.

        Claude names each project dir after the encoded cwd, so one
        workspace maps to exactly one folder — we can enumerate just that
        folder instead of the entire (potentially multi-GB) projects root.
        """
        encoded = encode_claude_cwd(workspace_path)
        out: list[Path] = []
        for root in self.project_dirs():
            d = root / encoded
            if not d.is_dir():
                continue
            try:
                for f in d.iterdir():
                    if f.is_file() and f.suffix == ".jsonl":
                        out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", d, err)
        return out

    def cwd_from_file(self, path: Path) -> str:
        """Reverse cwd-hash: project-dir-name `-foo-bar-baz` → `/foo/bar/baz`.

        Edge case: a literal `-` in the original path is ambiguous. Best-effort
        only; attribution layer handles "unmatched cwd" gracefully.
        """
        try:
            project_dir_name = path.parent.name
        except Exception:
            return ""
        if not project_dir_name.startswith("-"):
            return ""
        return project_dir_name.replace("-", "/")

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem

        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return out

        with fh:
            for line_no, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    log.debug("%s:%d malformed JSON, skipping", path.name, line_no)
                    continue

                if rec.get("type") != "assistant":
                    continue
                msg = rec.get("message")
                if not isinstance(msg, dict):
                    continue
                usage = msg.get("usage")
                if not isinstance(usage, dict):
                    continue

                msg_id = str(msg.get("id") or "")
                req_id = str(rec.get("requestId") or "")
                dedup_key = f"{msg_id}::{req_id}"
                if dedup_key == "::" or dedup_key in seen_keys:
                    continue

                input_tokens = (
                    _int(usage.get("input_tokens"))
                    + _int(usage.get("cache_read_input_tokens"))
                    + _int(usage.get("cache_creation_input_tokens"))
                )
                output_tokens = _int(usage.get("output_tokens"))
                if input_tokens == 0 and output_tokens == 0:
                    continue

                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="claude",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=str(rec.get("timestamp") or ""),
                        model=str(msg.get("model") or ""),
                    )
                )
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset."""
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        recent = [] if rotated else [str(k) for k in checkpoint.get("recent_keys", [])][-64:]
        recent_set = set(recent)
        out: list[TokenUsage] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem

        for end, rec in records:
            if rec is None or rec.get("type") != "assistant":
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            dedup_key = f"{msg.get('id') or ''}::{rec.get('requestId') or ''}"
            if dedup_key == "::" or dedup_key in recent_set:
                continue
            input_tokens = (
                _int(usage.get("input_tokens"))
                + _int(usage.get("cache_read_input_tokens"))
                + _int(usage.get("cache_creation_input_tokens"))
            )
            output_tokens = _int(usage.get("output_tokens"))
            if input_tokens == 0 and output_tokens == 0:
                continue
            recent.append(dedup_key)
            recent = recent[-64:]
            recent_set = set(recent)
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["recent_keys"] = list(recent)
            out.append(TokenUsage(
                vendor="claude",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=dedup_key,
                timestamp=str(rec.get("timestamp") or ""),
                model=str(msg.get("model") or ""),
                checkpoint=event_checkpoint,
            ))

        final_checkpoint["recent_keys"] = recent
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for every tool_use/text content, and
        `turn_complete` when an assistant turn ends with stop_reason=end_turn.

        Dedup keys are line-relative (file_lineno) so a streaming line that
        gets appended-to won't re-fire.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem
        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        with fh:
            for line_no, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                key = f"act:{line_no}"
                if key in seen_keys:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    seen_keys.add(key)
                    continue

                rtype = rec.get("type")
                ts = str(rec.get("timestamp") or "")
                if rtype == "assistant":
                    msg = rec.get("message") or {}
                    stop_reason = str(msg.get("stop_reason") or "")
                    # Mark every assistant line as activity so the watcher
                    # knows the agent is producing content. Text rides only on
                    # turn_complete (the sole event the frontend judges), so a
                    # tool-heavy turn doesn't broadcast its text on every line.
                    seen_keys.add(key)
                    out.append(ActivityEvent(
                        vendor="claude",
                        event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts,
                        detail="assistant",
                    ))
                    # end_turn = clean finish, not a tool_use pause.
                    if stop_reason == "end_turn":
                        out.append(ActivityEvent(
                            vendor="claude",
                            event_type="turn_complete",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=f"turn:{line_no}", timestamp=ts,
                            detail=stop_reason, text=_assistant_text(msg),
                        ))
                elif rtype in ("tool_use", "user"):
                    seen_keys.add(key)
                    # Real human prompts (same test as first_user_prompts:
                    # plain-string content, non-empty, not a "<...>" wrapper)
                    # carry their text so the frontend can name the pane.
                    # tool_result lists / command wrappers stay text-less.
                    text = ""
                    if rtype == "user":
                        msg = rec.get("message")
                        content = msg.get("content") if isinstance(msg, dict) else None
                        if isinstance(content, str):
                            text = user_prompt_text(content)
                    out.append(ActivityEvent(
                        vendor="claude",
                        event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts,
                        detail=str(rtype), text=text,
                    ))
                else:
                    # Mark seen so we don't re-evaluate this line later.
                    seen_keys.add(key)
        return out


# ---- attribution/watch hooks ----------------------------------------------

def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    # Claude names its per-project dir after the encoded cwd; the file path
    # carries it.
    expected_dir = encode_claude_cwd(pane_cwd)
    return f"/{expected_dir}/" in usage.file_path


ClaudeLogReader.pane_cwd_match = _pane_cwd_match


# ---- credentials -----------------------------------------------------------

CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"


def read_claude_credentials_file(home: Path) -> dict | None:
    """Parse ``~/.claude/.credentials.json``. Returns the claudeAiOauth dict
    or None when absent/unusable (an mcpOAuth-only payload counts as absent)."""
    path = home / ".claude" / ".credentials.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        return None
    return oauth


def parse_claude_credentials(raw: str | None) -> dict | None:
    """Extract Claude OAuth data from a vault credential payload."""
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        return None
    return oauth




# A failed Keychain read (denied prompt, timeout) is remembered so we don't
# re-prompt every poll — but only for a cooldown window, so a transient failure
# (e.g. a slow security call during an account switch) self-heals without an app
# restart. monotonic timestamp; None means no active cooldown.
_KEYCHAIN_COOLDOWN_S = 300.0
_keychain_failed_at: float | None = None


from ..usage_common import (  # noqa: E402,F401
    _KEYCHAIN_COOLDOWN_S as _SHARED_KEYCHAIN_COOLDOWN_S,
    communicate_or_kill as _communicate_or_kill,
)


async def read_claude_credentials(home: Path) -> dict | None:
    """File first; on macOS fall back to the Keychain generic password the
    Claude Code CLI writes. A failed Keychain read is remembered for
    ``_KEYCHAIN_COOLDOWN_S`` (the prompt/denial would otherwise re-fire every
    poll), then retried so a transient failure self-heals."""
    global _keychain_failed_at
    oauth = read_claude_credentials_file(home)
    if oauth is not None:
        return oauth
    if sys.platform != "darwin":
        return None
    now = time.monotonic()
    if _keychain_failed_at is not None and now - _keychain_failed_at < _KEYCHAIN_COOLDOWN_S:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "/usr/bin/security", "find-generic-password",
            "-s", CLAUDE_KEYCHAIN_SERVICE, "-w",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out = await _communicate_or_kill(proc, timeout=2.0)
        if proc.returncode != 0:
            _keychain_failed_at = now
            return None
        _keychain_failed_at = None
        data = json.loads(out.decode("utf-8", "replace").strip())
        oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
        if not isinstance(oauth, dict) or not oauth.get("accessToken"):
            return None
        return oauth
    except (OSError, ValueError, asyncio.TimeoutError):
        _keychain_failed_at = now
        return None




# ---- usage quota: the CLI's own /usage panel -------------------------------
# (merged from claude_cli_usage.py — nothing here talks to Anthropic; Claude
# Code makes the request under its own identity and prints the answer.)

PROBE_ARGS = ("--ax-screen-reader",)
# Typed first without the enter; the \r only goes in after the CLI echoes the
# text back (see read_usage_panel). On the screens where typing does not echo —
# the folder-trust dialog, the login wizard, the first-run theme picker — a
# blind \r would answer someone else's question with its default button.
SLASH_COMMAND_TEXT = b"/usage"
ENTER = b"\r"

# Boot, then the panel itself, both bounded. The panel repaints several times as
# it loads ("Scanning local sessions…" → final), so it is read until the output
# goes quiet rather than until any one marker appears.
BOOT_TIMEOUT_S = 25.0
PANEL_TIMEOUT_S = 25.0
QUIET_S = 1.5
ECHO_TIMEOUT_S = 5.0

_ENV_DROP = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR")

_ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][A-Z0-9]|\r")
_CSI = re.compile(r"\x1b\[([0-9;?]*)([a-zA-Z])")
# "4% 4% used" — the label is rendered twice (once for the bar, once as text).
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)%\s+(?:\d+(?:\.\d+)?%\s+)?used", re.I)
_RESETS = re.compile(r"^Resets\s+(.+?)\s*$", re.I)
_SESSION_HEAD = re.compile(r"^Current session\s*$", re.I)
_WEEK_HEAD = re.compile(r"^Current week\s*\((.+?)\)\s*$", re.I)


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


def render_screen(raw: str) -> str:
    """Replay the output into a line buffer and return what is on screen.

    Reading the byte stream directly does not work: while the panel loads it
    repaints by moving the cursor up and erasing lines in place, so a corrected
    number arrives with no header attached to it — a stream reader keeps the
    first, already-superseded value. Applying the cursor movements is what makes
    the settled screen, and only the settled screen, readable.

    Deliberately partial: it handles the sequences this panel actually emits
    (cursor up/down, column moves, line erase) and drops the rest, which are
    colour and mode changes with no effect on layout."""
    lines: list[str] = [""]
    row = col = 0

    def put(text: str) -> None:
        nonlocal col
        while len(lines) <= row:
            lines.append("")
        line = lines[row].ljust(col)
        lines[row] = line[:col] + text + line[col + len(text):]
        col += len(text)

    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\x1b":
            match = _CSI.match(raw, i)
            if not match:
                nxt = raw[i + 1] if i + 1 < len(raw) else ""
                if nxt in "()":
                    i += 3  # charset select is ESC ( B — the B is not text
                elif nxt == "]":
                    # OSC (window title and friends): payload runs to BEL or ST
                    bel = raw.find("\x07", i)
                    st = raw.find("\x1b\\", i + 2)
                    ends = [e for e in (bel, st) if e != -1]
                    if not ends:
                        break  # unterminated OSC swallows the rest
                    stop = min(ends)
                    i = stop + (1 if raw[stop] == "\x07" else 2)
                else:
                    i += 2  # other two-byte escapes
                continue
            params, final = match.group(1), match.group(2)
            first = params.split(";")[0]
            count = int(first) if first.isdigit() else (0 if final == "K" else 1)
            if final == "A":
                row = max(0, row - max(1, count))
            elif final == "B":
                row += max(1, count)
            elif final == "G":
                col = max(0, count - 1)
            elif final == "K":
                while len(lines) <= row:
                    lines.append("")
                lines[row] = "" if count == 2 else lines[row][:col]
            i = match.end()
            continue
        if ch == "\n":
            row += 1
            col = 0
            while len(lines) <= row:
                lines.append("")
        elif ch == "\r":
            col = 0
        else:
            put(ch)
        i += 1
    return "\n".join(lines)


def _parse_reset(phrase: str, now: datetime) -> str | None:
    """"Aug 7 at 11:59am (Asia/Taipei)" / "5:59am (Asia/Taipei)" -> ISO 8601.

    Returns None whenever the phrase is not confidently understood — the UI
    drops the countdown for that window, which beats inventing a time. The
    wording is the CLI's own and localized, so this only claims to handle the
    English form it ships today."""
    tz_match = re.search(r"\(([A-Za-z_]+/[A-Za-z_+\-]+)\)", phrase)
    if not tz_match:
        return None
    try:
        tz = ZoneInfo(tz_match.group(1))
    except (ZoneInfoNotFoundError, ValueError):
        return None
    body = phrase[: tz_match.start()].strip().rstrip("·").strip()

    clock = re.search(r"(\d{1,2})(?::(\d{2}))?\s*([ap]m)", body, re.I)
    if not clock:
        return None
    hour = int(clock.group(1)) % 12
    if clock.group(3).lower() == "pm":
        hour += 12
    minute = int(clock.group(2) or 0)

    local_now = now.astimezone(tz)
    dated = re.match(r"([A-Z][a-z]{2})\s+(\d{1,2})\b", body)
    if dated:
        months = ("jan", "feb", "mar", "apr", "may", "jun",
                  "jul", "aug", "sep", "oct", "nov", "dec")
        try:
            month = months.index(dated.group(1).lower()) + 1
        except ValueError:
            return None
        day = int(dated.group(2))
        year = local_now.year
        # The panel never dates the past; a month behind us means next year.
        if month < local_now.month - 6:
            year += 1
        try:
            when = local_now.replace(
                year=year, month=month, day=day,
                hour=hour, minute=minute, second=0, microsecond=0,
            )
        except ValueError:
            return None
    else:
        when = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if when <= local_now:  # a bare clock time means the next one
            when += timedelta(days=1)
    return when.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")


def parse_usage_panel(raw: str, *, now: datetime | None = None) -> list[dict]:
    """Windows in the shape ``usage_service._window`` produces.

    The raw stream is replayed through ``render_screen`` first: the panel
    corrects itself in place while loading, and only the rendered screen shows
    the values it settled on."""
    from ..usage_common import _window

    now = now or datetime.now().astimezone()
    lines = [line.strip() for line in render_screen(raw).splitlines()]
    found: dict[str, dict] = {}

    for idx, line in enumerate(lines):
        if _SESSION_HEAD.match(line):
            key, kind, label = "session", "session", "Session (5h)"
        else:
            week = _WEEK_HEAD.match(line)
            if not week:
                continue
            scope = week.group(1).strip()
            if scope.lower() == "all models":
                key, kind, label = "weekly", "weekly", "Weekly (all models)"
            else:
                key, kind, label = f"weekly:{scope}", "weekly-model", f"Weekly ({scope})"

        # The percent and the reset line follow the header within a few lines;
        # stop at the next header so blocks never borrow each other's numbers.
        pct: float | None = None
        resets: str | None = None
        for follow in lines[idx + 1: idx + 6]:
            if _SESSION_HEAD.match(follow) or _WEEK_HEAD.match(follow):
                break
            if pct is None:
                hit = _PERCENT.search(follow)
                if hit:
                    pct = float(hit.group(1))
                    continue
            reset_hit = _RESETS.match(follow)
            if reset_hit:
                resets = _parse_reset(reset_hit.group(1), now)
                break
        if pct is not None:
            found[key] = _window(kind, label, pct, resets)

    order = {"session": 0, "weekly": 1}
    return [found[k] for k in sorted(found, key=lambda k: (order.get(k, 2), k))]


def _panel_probe_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in _ENV_DROP:
        env.pop(key, None)
    env.update({"TERM": "xterm-256color", "COLUMNS": "100", "LINES": "40"})
    return env


async def _kill_group(pid: int) -> None:
    # Async on purpose: this runs on the backend's only event loop, and a
    # blocking sleep here freezes every WebSocket session for its duration.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            return
        await asyncio.sleep(0.2)


async def read_usage_panel(binary: str) -> str:
    """Drive the CLI to its ``/usage`` panel and return the raw screen text.

    Runs in a pty because the panel only renders for an interactive terminal.
    The process group is always taken down before returning."""
    import pty

    master, slave = pty.openpty()
    proc = await asyncio.create_subprocess_exec(
        binary, *PROBE_ARGS,
        stdin=slave, stdout=slave, stderr=slave,
        env=_panel_probe_env(), start_new_session=True,
    )
    os.close(slave)
    loop = asyncio.get_running_loop()
    chunks: list[bytes] = []
    reader_ready = asyncio.Event()
    eof = False

    def _on_readable() -> None:
        nonlocal eof
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data:
            chunks.append(data)
        else:
            # After EOF the fd stays readable forever; leaving the reader in
            # place turns the event loop into a busy spin until the deadline.
            eof = True
            loop.remove_reader(master)
        reader_ready.set()

    def _closed() -> bool:
        return eof

    loop.add_reader(master, _on_readable)
    try:
        await _wait_settled(reader_ready, chunks, BOOT_TIMEOUT_S, closed=_closed)
        chunks.clear()
        # Type the command, then require the CLI to echo it back before the
        # enter goes in. A select-style dialog (folder trust, login wizard,
        # theme picker) swallows typed text without echoing it, and a blind \r
        # there presses its default button — for the trust dialog that means
        # silently marking the cwd as trusted. No echo, no enter.
        await loop.run_in_executor(None, os.write, master, SLASH_COMMAND_TEXT)

        def _echoed() -> bool:
            return "/usage" in render_screen(b"".join(chunks).decode("utf-8", "replace"))

        end = time.monotonic() + ECHO_TIMEOUT_S
        while not _echoed() and not eof and time.monotonic() < end:
            reader_ready.clear()
            try:
                await asyncio.wait_for(reader_ready.wait(), timeout=0.3)
            except asyncio.TimeoutError:
                continue
        if not _echoed():
            raise RuntimeError(
                "the screen did not echo /usage back (dialog, login wizard, or "
                "unrecognized UI); refusing to press enter on it"
            )
        await loop.run_in_executor(None, os.write, master, ENTER)

        def _has_numbers() -> bool:
            return bool(parse_usage_panel(b"".join(chunks).decode("utf-8", "replace")))

        await _wait_settled(
            reader_ready, chunks, PANEL_TIMEOUT_S, ready=_has_numbers, closed=_closed,
        )
        return b"".join(chunks).decode("utf-8", "replace")
    finally:
        loop.remove_reader(master)  # no-op when the EOF path already removed it
        await _kill_group(proc.pid)
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except (asyncio.TimeoutError, ProcessLookupError):
            pass
        os.close(master)


async def _wait_settled(
    flag: asyncio.Event,
    chunks: list[bytes],
    deadline_s: float,
    ready=None,
    closed=None,
) -> None:
    """Wait for output to start, then for it to stop — and, when ``ready`` is
    given, for it to actually contain what the caller came for.

    Two failure modes make the obvious version wrong. A cold Claude Code takes
    seconds before its first byte, so silence-so-far would read as "finished"
    and the panel command would go to a CLI that has not drawn a prompt yet.
    And the panel pauses mid-render while it scans local sessions, so a pause
    longer than ``QUIET_S`` would end the read on a half-drawn screen with no
    numbers on it. ``ready`` turns quiet into a question rather than a verdict.
    Both phases share one deadline, so a panel that never fills still ends.
    ``closed`` reports the pty gone (the CLI exited); nothing further can
    arrive, so the wait ends instead of running out its deadline."""
    end = time.monotonic() + deadline_s
    while not chunks and time.monotonic() < end:
        if closed is not None and closed():
            return
        flag.clear()
        try:
            await asyncio.wait_for(flag.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            continue
    while time.monotonic() < end:
        if closed is not None and closed():
            return
        flag.clear()
        try:
            await asyncio.wait_for(flag.wait(), timeout=QUIET_S)
        except asyncio.TimeoutError:
            if ready is None or ready():
                return


async def fetch_claude_usage_via_cli(home: Path) -> dict[str, Any] | None:
    """Snapshot for the usage badge, or None when there is no CLI to ask.

    A read that actually started a Claude Code but came back empty returns an
    ``unavailable`` snapshot carrying a transient ``costlyRead`` flag: the
    poller prices that retry like a success (a spawn is a spawn), instead of
    re-running a full CLI boot on the short failure cooldown, forever."""
    from ..ai_chat_cli_engine import resolve_cli_binary
    from ..usage_common import _snapshot

    def _costly() -> dict[str, Any]:
        snap = _snapshot("claude", "unavailable")
        snap["costlyRead"] = True
        return snap

    # Logged out is knowable without a spawn. The CLI would only present its
    # login wizard — at a full boot's cost, on every retry, forever — and the
    # badge would say "unavailable" where it means "log in".
    if await read_claude_credentials(home) is None:
        return _snapshot("claude", "no-credentials")
    try:
        binary = resolve_cli_binary("claude")
    except Exception:  # noqa: BLE001
        binary = ""
    if not binary:
        return None
    try:
        raw = await read_usage_panel(binary)
    except Exception as err:  # noqa: BLE001 — a failed read is just "no data"
        log.warning("claude /usage read failed: %s", err)
        return _costly()
    windows = parse_usage_panel(raw)
    if not windows:
        log.info("claude /usage produced no readable windows")
        return _costly()
    return _snapshot("claude", "ok", windows=windows)


# ---- delegated OAuth refresh (merged from claude_delegated_refresh.py) -----
# The CLI mints, this app only observes; see the fingerprint contract below.

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
        from ..ws_handlers import _running_regular_terminals

        return bool(_running_regular_terminals("claude"))
    except Exception:  # noqa: BLE001 — never block the probe on introspection
        return False


def _refresh_probe_env() -> dict[str, str]:
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
    from ..ai_chat_cli_engine import _terminate_proc_tree

    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            *_PROBE_ARGS,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=_refresh_probe_env(),
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
            from ..ai_chat_cli_engine import resolve_cli_binary

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


async def fetch_claude(home: Path) -> dict:
    """Claude quota, read from the CLI's own ``/usage`` panel.

    Claude Code asks Anthropic under its own identity and prints the answer;
    this reads what it printed. It replaced a direct HTTP call this app made
    while presenting itself as ``claude-code/<version>``. ``home`` locates the
    live credential for the logged-out precheck; the CLI itself still reads
    whichever credential is live."""
    return await fetch_claude_usage_via_cli(home) or _snapshot("claude", "unavailable")




# ---- resume / session ------------------------------------------------------

_RESUME_RE = re.compile(r"^claude\s+(?:\S+\s+)*--resume\s+(\S+)")


def _resume_id_from_command(command) -> str:
    """Session id from a `claude ... --resume <id>` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_path(workspace_path: str, session_id: str) -> Path:
    # A managed-account pane resumes inside its profile's isolated config
    # home, but that home's ``projects`` is symlinked back to the real home
    # (credential_vault), so the session jsonl always resolves to the default
    # location — one check covers every account.
    project_dir = encode_claude_cwd(workspace_path)
    return Path.home() / ".claude" / "projects" / project_dir / f"{session_id}.jsonl"


# ---- vendor spec -----------------------------------------------------------

SPEC = VendorSpec(
    key="claude",
    label="Claude Code",
    live_file=(".claude", ".credentials.json"),
    slot_file=".credentials.json",
    profile_home_secret_file=(".credentials.json",),
    # login_home_secret_file stays None: claude's login-home secret lives in
    # a path-hashed Keychain item, not a peekable file (see credential_vault).
    # The vault's claude behavior branches (Keychain dual-track, oauthAccount,
    # wiped guard, login CLAUDE_CONFIG_DIR + env removals) are the documented
    # exemption list and are NOT routed through this spec.
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    home_env_vars=(
        "CLAUDE_CONFIG_DIR",
        # Claude Code stamps its own subprocesses with this; inherited, a
        # spawned pane silently skips transcript saving (blank pane after
        # restart — root-caused live 2026-08-07).
        "CLAUDE_CODE_CHILD_SESSION",
    ),
    make_log_reader=ClaudeLogReader,
)
