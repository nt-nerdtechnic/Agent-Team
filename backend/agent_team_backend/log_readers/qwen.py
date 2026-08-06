"""Qwen Code CLI conversation log reader.

Layout (root = $QWEN_RUNTIME_DIR, default ~/.qwen):
  <root>/projects/<encoded-cwd>/chats/<sessionId>.jsonl
  <root>/projects/<encoded-cwd>/chats/archive/<sessionId>.jsonl  (archived —
  still history, so listing/attribution include it)

<encoded-cwd> uses the exact encoding Claude Code uses for its projects dirs
(every non-alphanumeric char → "-"), so encode_claude_cwd is reused.

Every JSONL record carries uuid/parentUuid/sessionId/timestamp/type/cwd.
Token-relevant lines have type=="assistant" with usageMetadata populated.
Mapping into TokenUsage (cache folded into input, reasoning into output):
  input_tokens  = promptTokenCount (already includes cachedContentTokenCount,
                  Qwen's cache-read figure)
  output_tokens = candidatesTokenCount + thoughtsTokenCount
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from .base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    read_jsonl_tail,
    user_prompt_text,
)
from .claude import encode_claude_cwd

log = logging.getLogger("agent_team_backend.log_readers.qwen")

# Automated / mid-turn user records. Marker binding searches raw file text, so
# these never affect it — but they are not human prompts and must not count as
# user activity (cron/notification are injected by the CLI itself; a mid-turn
# message arrives while assistant records already carry the activity signal).
_EXCLUDED_USER_SUBTYPES = ("mid_turn_user_message", "cron", "notification")

# Qwen writes no end-of-turn record, so a turn is closed either by the next
# real user prompt or — for the latest turn, which has no successor — once the
# file has stopped growing for _TURN_IDLE_SECONDS. File mtime stands in for
# wall-clock activity: the log's own timestamps are ISO strings, and a write to
# the file is the same signal with none of the parsing.
_TURN_IDLE_SECONDS = 8.0
_STATE_PREFIX = "qwen_turn::"
_TEXT_PREFIX = "qwen_text::"
_TEXT_MAX_CHARS = 4_000


def _cap_text(text: str) -> str:
    if len(text) <= _TEXT_MAX_CHARS:
        return text
    half = _TEXT_MAX_CHARS // 2
    return f"{text[:half]}\n…\n{text[-half:]}"


def _parts_text(rec: dict) -> str:
    """Joined text blocks of a record's message.parts[] (user and assistant
    records share the shape)."""
    msg = rec.get("message")
    parts = msg.get("parts") if isinstance(msg, dict) else None
    if not isinstance(parts, list):
        return ""
    return "\n".join(
        p["text"] for p in parts
        if isinstance(p, dict) and isinstance(p.get("text"), str)
    )


def _read_sentinel(seen_keys: set[str], prefix: str) -> str:
    for k in seen_keys:
        if k.startswith(prefix):
            return k[len(prefix):]
    return ""


def _write_sentinel(seen_keys: set[str], prefix: str, value: str) -> None:
    seen_keys.difference_update({k for k in seen_keys if k.startswith(prefix)})
    if value:
        seen_keys.add(f"{prefix}{value}")


def qwen_root() -> Path:
    """Qwen Code's runtime output root ($QWEN_RUNTIME_DIR, default ~/.qwen)."""
    env = os.environ.get("QWEN_RUNTIME_DIR")
    return Path(env) if env else Path.home() / ".qwen"


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _usage_tokens(usage: dict) -> tuple[int, int]:
    """promptTokenCount already includes cachedContentTokenCount (cache read),
    matching TokenUsage's cache-folded-into-input design; thought (reasoning)
    tokens fold into output like other vendors' reasoning tokens."""
    input_tokens = _int(usage.get("promptTokenCount"))
    output_tokens = _int(usage.get("candidatesTokenCount")) + _int(
        usage.get("thoughtsTokenCount")
    )
    return input_tokens, output_tokens


class QwenLogReader(LogReader):
    vendor: str = "qwen"

    def _projects_root(self) -> Path:
        return qwen_root() / "projects"

    def project_dirs(self) -> list[Path]:
        """The single projects root (empty list when it doesn't exist)."""
        default = self._projects_root()
        return [default] if default.is_dir() else []

    def _chats_files(self, chats: Path) -> list[Path]:
        """All session jsonl files in one chats dir, archive/ included."""
        out: list[Path] = []
        for d in (chats, chats / "archive"):
            if not d.is_dir():
                continue
            try:
                for f in d.iterdir():
                    if f.is_file() and f.suffix == ".jsonl":
                        out.append(f)
            except OSError as err:
                log.debug("enumerate %s failed: %s", d, err)
        return out

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if child.is_dir():
                        out.extend(self._chats_files(child / "chats"))
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the jsonl files under this workspace's project chats dir.

        Qwen names each project dir after the Claude-encoded cwd, so one
        workspace maps to exactly one folder — enumerate just that folder.
        """
        encoded = encode_claude_cwd(workspace_path)
        out: list[Path] = []
        for root in self.project_dirs():
            out.extend(self._chats_files(root / encoded / "chats"))
        return out

    def _in_chats_dir(self, path: Path) -> bool:
        parent = path.parent
        if parent.name == "archive":
            parent = parent.parent
        return parent.name == "chats"

    def cwd_from_file(self, path: Path) -> str:
        """Every record carries the session's cwd — read it from the first
        parseable line (exact, unlike decoding the "-"-encoded dir name)."""
        try:
            with path.open(encoding="utf-8") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(rec, dict):
                        return str(rec.get("cwd") or "")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
        return ""

    def session_id_from_path(self, path: Path) -> str:
        """Session files are named <sessionId>.jsonl inside chats/ (or
        chats/archive/). Anything else (writer locks, stray siblings) returns
        '' so the resume-binding sink never coins a bogus id."""
        if path.suffix != ".jsonl" or not self._in_chats_dir(path):
            return ""
        return path.stem

    def has_session(self, session_id: str) -> bool:
        """True when any project's chats dir (archive included) holds
        <session_id>.jsonl. The resume preflight uses this so a stale
        persisted id fails fast instead of launching a doomed
        `qwen --resume <id>`."""
        session_id = session_id.strip()
        if not session_id:
            return False
        name = f"{session_id}.jsonl"
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if not child.is_dir():
                        continue
                    chats = child / "chats"
                    if (chats / name).is_file() or (chats / "archive" / name).is_file():
                        return True
            except OSError:
                continue
        return False

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        file_cwd = self.cwd_from_file(path)
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
                usage = rec.get("usageMetadata")
                if not isinstance(usage, dict):
                    continue

                dedup_key = str(rec.get("uuid") or "")
                if not dedup_key or dedup_key in seen_keys:
                    continue

                input_tokens, output_tokens = _usage_tokens(usage)
                if input_tokens == 0 and output_tokens == 0:
                    continue

                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="qwen",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=str(rec.get("cwd") or "") or file_cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=str(rec.get("timestamp") or ""),
                        model=str(rec.get("model") or ""),
                    )
                )
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset.

        Qwen appends whole records under a per-session writer lock, so a byte
        offset plus a short recent-uuid window guarantees no double count.
        """
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        recent = [] if rotated else [str(k) for k in checkpoint.get("recent_keys", [])][-64:]
        recent_set = set(recent)
        out: list[TokenUsage] = []
        session_id = path.stem

        for end, rec in records:
            if rec is None or rec.get("type") != "assistant":
                continue
            usage = rec.get("usageMetadata")
            if not isinstance(usage, dict):
                continue
            dedup_key = str(rec.get("uuid") or "")
            if not dedup_key or dedup_key in recent_set:
                continue
            input_tokens, output_tokens = _usage_tokens(usage)
            if input_tokens == 0 and output_tokens == 0:
                continue
            recent.append(dedup_key)
            recent = recent[-64:]
            recent_set = set(recent)
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["recent_keys"] = list(recent)
            out.append(TokenUsage(
                vendor="qwen",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=str(rec.get("cwd") or ""),
                session_id=session_id,
                file_path=str(path),
                dedup_key=dedup_key,
                timestamp=str(rec.get("timestamp") or ""),
                model=str(rec.get("model") or ""),
                checkpoint=event_checkpoint,
            ))

        final_checkpoint["recent_keys"] = recent
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for assistant records and real user prompts, and
        `turn_complete` once per user-facing turn.

        Qwen's chat log carries no explicit end-of-turn record (assistant
        records have no stop_reason, and one user turn spans several
        assistant/tool steps), so the turn boundary is inferred: the next real
        user prompt closes the previous turn, and the latest turn is flushed
        once the file has been quiet for _TURN_IDLE_SECONDS. turn_complete
        carries the assistant's closing text, which is what lets a Qwen pane
        send inter-CLI messages — the frontend only parses the
        ---MSG-START--- protocol out of a turn_complete that has text.

        Automated user records (_EXCLUDED_USER_SUBTYPES) are not user activity
        and do not open a turn.
        """
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.stem
        state_raw = _read_sentinel(seen_keys, _STATE_PREFIX)
        state: dict | None = None
        if state_raw:
            try:
                parsed = json.loads(state_raw)
                state = parsed if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                state = None
        last_text = _read_sentinel(seen_keys, _TEXT_PREFIX)

        def _complete(idx: int, detail: str) -> ActivityEvent:
            return ActivityEvent(
                vendor="qwen", event_type="turn_complete",
                cwd=cwd, session_id=session_id, file_path=str(path),
                dedup_key=f"turn:{idx}", timestamp="", detail=detail,
                text=last_text,
            )

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
                seen_keys.add(key)
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                rtype = rec.get("type")
                ts = str(rec.get("timestamp") or "")
                is_user_prompt = (
                    rtype == "user"
                    and str(rec.get("subtype") or "") not in _EXCLUDED_USER_SUBTYPES
                )
                if rtype == "assistant" or is_user_prompt:
                    # User prompts live in message.parts[].text; join them so
                    # the frontend can name the pane from the first user text.
                    text = ""
                    if is_user_prompt:
                        # A new prompt closes the previous turn (if still open).
                        if state is not None and not state.get("flushed"):
                            out.append(_complete(int(state["idx"]), "boundary"))
                            last_text = ""
                        idx = (int(state["idx"]) + 1) if state is not None else 0
                        state = {"idx": idx, "flushed": False}
                        text = user_prompt_text(_parts_text(rec))
                    else:
                        # An assistant record with no preceding prompt (a
                        # resumed session joined mid-turn) still opens a turn.
                        if state is None or state.get("flushed"):
                            idx = (int(state["idx"]) + 1) if state is not None else 0
                            state = {"idx": idx, "flushed": False}
                        reply = _parts_text(rec).strip()
                        if reply:
                            last_text = _cap_text(reply)
                    out.append(ActivityEvent(
                        vendor="qwen",
                        event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts,
                        detail=str(rtype), text=text,
                    ))

            # The latest turn has no following prompt; flush it once the file
            # has stopped being written to for long enough to call it finished.
            if state is not None and not state.get("flushed"):
                try:
                    quiet_for = time.time() - path.stat().st_mtime
                except OSError:
                    quiet_for = 0.0
                if quiet_for >= _TURN_IDLE_SECONDS:
                    out.append(_complete(int(state["idx"]), "idle"))
                    state["flushed"] = True
                    last_text = ""

        _write_sentinel(
            seen_keys, _STATE_PREFIX, json.dumps(state) if state is not None else ""
        )
        _write_sentinel(seen_keys, _TEXT_PREFIX, last_text)
        return out
