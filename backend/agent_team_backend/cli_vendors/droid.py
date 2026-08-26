"""Droid (Factory) conversation log reader + vendor spec.

Layout (verified against droid 0.204.0's own session code and a real file on
disk):

  ~/.factory/sessions/<encoded-cwd>/<sessionId>.jsonl          messages
  ~/.factory/sessions/<encoded-cwd>/<sessionId>.settings.json  token totals
  ~/.factory/sessions/                                          flat fallback
  ~/.factory/sessions/btw/                                      forked sessions

The encoding is NOT ``encode_claude_cwd``. Droid replaces only path separators
(``realpath`` → strip trailing separators → strip leading ``/`` → every ``/``
run → ``-``, then one leading ``-``), so a directory named ``Agent-Team`` keeps
its hyphen and a dotted path keeps its dots, where Claude would flatten both.
Reusing Claude's encoder would silently miss the directory on any path holding
a non-alphanumeric character other than ``/``.

Record types, from droid's own reader loops (everything else is skipped):
  session_start        first line, carries ``cwd`` / ``lastCwd``
  message              ``message.role`` is only ever "user" or "assistant";
                       ``content`` is an Anthropic-shaped block list
  compaction_state     history compaction bookkeeping
  agent_turn_outcome   ``{turnId, reason, resultKind}`` — the turn boundary

Turn ends are a RECORD, not an inference: droid appends an
``agent_turn_outcome`` line naming why the turn stopped. There is no
``stop_reason`` field anywhere in the file — that name appears in the binary
only inside the bundled Anthropic SDK and in OpenTelemetry attributes.

Per-message token usage is likewise absent. The JSONL carries at most an
opaque ``tokens`` integer; the real breakdown lives in the sidecar
``.settings.json`` as a running session total, which is what this reader
differences into deltas.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from .base import Dep, VendorSpec, command_text
from ..log_readers.base import (
    ActivityEvent,
    LogReader,
    TokenUsage,
    activity_high_water,
    join_text_blocks,
    set_activity_high_water,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.droid")


def encode_droid_cwd(cwd: str) -> str:
    """Droid's session-directory name for a cwd.

    Mirrors droid's own encoder verbatim: strip trailing separators, strip
    leading slashes, collapse each ``/`` run to a single ``-``, prepend ``-``.
    Only separators are touched — every other character survives.
    """
    text = re.sub(r"[\\/]+$", "", cwd)
    text = re.sub(r"^/+", "", text)
    return "-" + re.sub(r"/+", "-", text)


def droid_sessions_root() -> Path | None:
    """The sessions root, or None when droid has never run on this machine."""
    override = os.environ.get("FACTORY_HOME_OVERRIDE")
    home = Path(override) if override else Path.home() / ".factory"
    root = home / "sessions"
    return root if root.is_dir() else None


def _session_settings_path(path: Path) -> Path:
    """Sidecar holding this session's token totals."""
    return path.parent / f"{path.stem}.settings.json"


def _int(value) -> int:  # noqa: ANN001
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


#: Running-total marker for the sidecar diff. One key, replaced in place: the
#: sidecar reports cumulative counters, so all a later poll needs is the pair
#: already accounted for. Kept off the per-event dedup keys deliberately —
#: see log_readers.base on unbounded seen_keys growth.
_TOKEN_MARK_PREFIX = "droid_tok::"


def _token_mark(seen_keys: set[str]) -> tuple[int, int]:
    for key in seen_keys:
        if key.startswith(_TOKEN_MARK_PREFIX):
            try:
                got_in, got_out = key[len(_TOKEN_MARK_PREFIX):].split(":")
                return int(got_in), int(got_out)
            except ValueError:
                return 0, 0
    return 0, 0


def _set_token_mark(seen_keys: set[str], total_in: int, total_out: int) -> None:
    seen_keys.difference_update(
        {k for k in seen_keys if k.startswith(_TOKEN_MARK_PREFIX)}
    )
    seen_keys.add(f"{_TOKEN_MARK_PREFIX}{total_in}:{total_out}")


def _is_hook_record(msg: dict) -> bool:
    """A hook's own bookkeeping entry, not conversation.

    Droid persists every hook invocation as a role="user" message carrying
    ``hookEventName``. Treating those as prompts would name a pane after a
    shell snippet.
    """
    return bool(msg.get("hookEventName"))


def _has_block(content, block_type: str) -> bool:
    if not isinstance(content, list):
        return False
    return any(
        isinstance(b, dict) and b.get("type") == block_type for b in content
    )


class DroidLogReader(LogReader):
    vendor: str = "droid"

    def _default_root(self) -> Path | None:
        return droid_sessions_root()

    def project_dirs(self) -> list[Path]:
        root = self._default_root()
        return [root] if root is not None else []

    def session_files(self) -> list[Path]:
        """Every session file under the sessions root.

        Covers all three layouts droid's own ``findSessionFile`` looks in: the
        per-cwd subdirectory, the flat root, and ``btw/`` for forks.
        """
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if child.is_file() and child.suffix == ".jsonl":
                        out.append(child)
                        continue
                    if not child.is_dir():
                        continue
                    try:
                        for f in child.iterdir():
                            if f.is_file() and f.suffix == ".jsonl":
                                out.append(f)
                    except OSError as err:
                        log.debug("enumerate %s failed: %s", child, err)
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the files under this workspace's own session directory."""
        encoded = encode_droid_cwd(workspace_path)
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
        """The session's working directory, read from its ``session_start``.

        Droid records the absolute path outright, so this is exact rather than
        the best-effort directory-name reversal Claude has to do — a name like
        ``-Users-me-Agent-Team`` cannot be reversed unambiguously, since the
        hyphen in ``Agent-Team`` is indistinguishable from a separator.
        ``lastCwd`` wins over ``cwd`` because droid itself prefers it: ``cwd``
        is the directory the session is FILED under, ``lastCwd`` where it
        actually ran last.
        """
        try:
            with path.open(encoding="utf-8") as fh:
                first = fh.readline()
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return ""
        try:
            rec = json.loads(first)
        except json.JSONDecodeError:
            return ""
        if not isinstance(rec, dict) or rec.get("type") != "session_start":
            return ""
        return str(rec.get("lastCwd") or rec.get("cwd") or "")

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        """Difference the sidecar's running totals into one delta event.

        The JSONL itself has no usage breakdown, so there is nothing per-line
        to read here: droid keeps the counters in ``<id>.settings.json`` and
        rewrites them as the session advances.
        """
        sidecar = _session_settings_path(path)
        try:
            raw = sidecar.read_text(encoding="utf-8")
        except OSError:
            return []
        try:
            doc = json.loads(raw)
        except json.JSONDecodeError:
            log.debug("%s malformed JSON, skipping", sidecar.name)
            return []
        if not isinstance(doc, dict):
            return []
        usage = doc.get("tokenUsage")
        if not isinstance(usage, dict):
            return []

        # Cache counters fold into input, matching TokenUsage's contract.
        total_in = (
            _int(usage.get("inputTokens"))
            + _int(usage.get("cacheCreationTokens"))
            + _int(usage.get("cacheReadTokens"))
        )
        # thinkingTokens is NOT added: droid reports it beside outputTokens
        # rather than inside it in its own UI, and double-counting reasoning
        # would inflate every thinking-heavy turn. Left out until a real
        # authenticated session settles which it is.
        total_out = _int(usage.get("outputTokens"))

        seen_in, seen_out = _token_mark(seen_keys)
        delta_in = total_in - seen_in
        delta_out = total_out - seen_out
        # A shrink means the sidecar was replaced (a fork, a reset), not that
        # tokens were refunded — re-baseline instead of emitting nonsense.
        if delta_in < 0 or delta_out < 0:
            _set_token_mark(seen_keys, total_in, total_out)
            return []
        if delta_in == 0 and delta_out == 0:
            return []

        dedup_key = f"usage::{path.stem}::{total_in}::{total_out}"
        if dedup_key in seen_keys:
            return []
        seen_keys.add(dedup_key)
        _set_token_mark(seen_keys, total_in, total_out)

        return [
            TokenUsage(
                vendor="droid",
                input_tokens=delta_in,
                output_tokens=delta_out,
                cwd=self.cwd_from_file(path),
                session_id=path.stem,
                file_path=str(path),
                dedup_key=dedup_key,
                model=str(doc.get("model") or ""),
            )
        ]

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` per message and `turn_complete` per outcome.

        Every ``agent_turn_outcome`` closes the turn, whatever its ``reason``:
        a cancelled or errored turn has still stopped, and withholding the
        event there would park the pane mid-turn forever. The reason rides on
        ``detail`` so the caller can tell a clean finish from an abort.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem
        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        high_water = activity_high_water(seen_keys)
        last_line = high_water
        # Turn text is best-effort: the outcome record names no message, so the
        # most recent assistant text in this scan is the closest thing to "what
        # the turn said". A resumed scan that starts past that line carries no
        # text rather than guessing.
        last_assistant_text = ""

        try:
            with fh:
                for line_no, raw_line in enumerate(fh, 1):
                    raw = raw_line.strip()
                    if not raw:
                        continue
                    if line_no <= high_water:
                        continue
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        # Still being written — leave the mark behind it so the
                        # completed line is read next poll. Stepping over a
                        # half-written outcome line is what strands a pane.
                        if not raw_line.endswith("\n"):
                            break
                        last_line = line_no
                        continue
                    last_line = line_no
                    if not isinstance(rec, dict):
                        continue

                    rtype = rec.get("type")
                    ts = str(rec.get("timestamp") or "")

                    if rtype == "agent_turn_outcome":
                        reason = str(rec.get("reason") or "")
                        out.append(ActivityEvent(
                            vendor="droid",
                            event_type="turn_complete",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=f"turn:{line_no}", timestamp=ts,
                            detail=reason, text=last_assistant_text,
                        ))
                        continue

                    if rtype != "message":
                        continue
                    msg = rec.get("message")
                    if not isinstance(msg, dict):
                        continue

                    role = str(msg.get("role") or "")
                    content = msg.get("content")
                    key = f"act:{line_no}"

                    if role == "assistant":
                        last_assistant_text = join_text_blocks(content, "text")
                        out.append(ActivityEvent(
                            vendor="droid",
                            event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts,
                            detail="assistant",
                        ))
                        continue

                    # role == "user" covers three different things: a real
                    # prompt, a tool result droid files under the user role,
                    # and a hook's bookkeeping entry. Only the first may carry
                    # text, or a pane gets auto-named after a shell snippet.
                    text = ""
                    if (
                        role == "user"
                        and not _is_hook_record(msg)
                        and not _has_block(content, "tool_result")
                    ):
                        text = user_prompt_text(join_text_blocks(content, "text"))
                    out.append(ActivityEvent(
                        vendor="droid",
                        event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts,
                        detail="user", text=text,
                    ))
        finally:
            set_activity_high_water(seen_keys, last_line)
        return out


DroidLogReader.emits_session_sink = True
# Droid cannot pin a session id at launch, so the kickoff marker is what binds
# a new session file to the pane that started it; the single-candidate cwd
# fallback covers a marker that never made it into the transcript.
DroidLogReader.binds_by_marker_file = True
DroidLogReader.binds_new_session_single_candidate = True


# ---- resume / session ------------------------------------------------------

# `-r` and `--resume` are the same option (droid --help, 0.204.0).
_RESUME_RE = re.compile(r"^droid\s+(?:\S+\s+)*(?:--resume|-r)\s+(\S+)")


def _resume_id_from_command(command) -> str:  # noqa: ANN001
    match = _RESUME_RE.match(command_text(command).strip())
    return match.group(1) if match else ""


def _session_path(workspace_path: str, session_id: str) -> Path | None:
    root = droid_sessions_root()
    if root is None:
        return None
    return root / encode_droid_cwd(workspace_path) / f"{session_id}.jsonl"


def _session_exists(workspace_path: str, session_id: str) -> bool:
    """True when this workspace's session file is on disk.

    Also accepts the flat and ``btw/`` layouts droid falls back to, so a forked
    session is not reported missing and replaced with a fresh pane.
    """
    root = droid_sessions_root()
    if root is None:
        return False
    candidates = (
        root / encode_droid_cwd(workspace_path) / f"{session_id}.jsonl",
        root / f"{session_id}.jsonl",
        root / "btw" / f"{session_id}.jsonl",
    )
    return any(p.is_file() for p in candidates)


SPEC = VendorSpec(
    key="droid",
    label="Droid",
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    session_exists=_session_exists,
    home_env_vars=(
        # Relocates the whole ~/.factory tree.
        "FACTORY_HOME_OVERRIDE",
        # Points droid at a settings file for that process only (--settings).
        "FACTORY_RUNTIME_SETTINGS_PATH",
        # Droid stamps its own child processes with this. Inherited by a pane
        # spawned from inside a droid session, it makes that pane a child of
        # the parent's session instead of starting its own — the same class of
        # bug CLAUDE_CODE_CHILD_SESSION causes for claude.
        "DROID_PARENT_SESSION_ID",
    ),
    make_log_reader=DroidLogReader,
    install_dep=Dep("droid", "Droid", "Factory AI coding agent", "agent_cli",
        ["droid", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install --cask droid", needs_terminal=True,
        requires_binaries=("brew",),
        optional=True, docs_url="https://docs.factory.ai/cli/getting-started/overview",
        update_cmd="droid update", doctor_cmd="droid doctor",
        config_home_default=".factory"),
)
