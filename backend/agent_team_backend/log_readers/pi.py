"""Pi Coding Agent CLI conversation log reader.

Layout (root = $PI_CODING_AGENT_SESSION_DIR, else
$PI_CODING_AGENT_DIR/sessions, default ~/.pi/agent/sessions):
  <root>/--<encoded-cwd>--/<timestamp>_<sessionId>.jsonl

<encoded-cwd>: the leading "/" is dropped, ONLY "/", "\\" and ":" become "-",
and the result is wrapped in "--" (e.g. /Users/x/proj → --Users-x-proj--).
Unlike the Claude/Qwen encoding, every other character (spaces, unicode)
survives verbatim.

Line 1 is a session header {"type":"session","version":3,"id","timestamp",
"cwd"} — the session id and cwd come from it. The filename is only a
fallback for the id: its timestamp prefix is joined to the id with "_", and
ids may themselves contain "_" (charset [A-Za-z0-9._-]), so the id is
everything after the FIRST "_" (the timestamp contains none). Later entries
form a tree (8-hex id / parentId; /tree can branch inside one file); token
accounting scans ALL entries carrying a usage payload (assistant messages
plus compaction / branch-summary records), accepting abandoned branches in
the per-file total.

Usage mapping into TokenUsage (cache folded into input, no reasoning field):
  input_tokens  = input + cacheRead + cacheWrite
  output_tokens = output

Two vendor quirks this reader must survive:
  * Lazy flush — the session file does not exist until the first assistant
    reply completes (header+user+assistant land in one O_EXCL write), so
    "no file yet" is normal for a brand-new busy pane.
  * Whole-file rewrites — version migrations and /tree branch operations
    rewrite the file in place (NOT append-only). read_jsonl_tail's
    identity/shrink check resets the offset for a full re-read; entry-id
    dedup (ids are stable across rewrites) absorbs the re-read entries.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from .base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    join_text_blocks,
    read_jsonl_tail,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.pi")

# Rewrites re-read the WHOLE file, so the dedup window must cover far more
# than the append-tail case other vendors need (qwen keeps 64).
_RECENT_KEYS_WINDOW = 256


def pi_sessions_root() -> Path:
    """Pi's session root ($PI_CODING_AGENT_SESSION_DIR, else
    $PI_CODING_AGENT_DIR/sessions, default ~/.pi/agent/sessions)."""
    env = os.environ.get("PI_CODING_AGENT_SESSION_DIR")
    if env:
        return Path(env)
    home = os.environ.get("PI_CODING_AGENT_DIR")
    base = Path(home) if home else Path.home() / ".pi" / "agent"
    return base / "sessions"


def encode_pi_cwd(cwd: str) -> str:
    """Pi's cwd → session-dir-name encoding: drop the leading "/", replace
    ONLY [/\\:] with "-", wrap in "--" (all other chars survive)."""
    if cwd.startswith("/"):
        cwd = cwd[1:]
    return "--" + re.sub(r"[/\\:]", "-", cwd) + "--"


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _usage_tokens(usage: dict) -> tuple[int, int]:
    """Fold cacheRead/cacheWrite into input (per TokenUsage design); Pi
    reports no reasoning tokens, so output passes through unchanged."""
    input_tokens = (
        _int(usage.get("input"))
        + _int(usage.get("cacheRead"))
        + _int(usage.get("cacheWrite"))
    )
    return input_tokens, _int(usage.get("output"))


def _usage_of(rec: dict) -> dict | None:
    """The usage payload of one entry: assistant messages carry it on the
    message object; compaction / branch-summary entries carry it top-level."""
    msg = rec.get("message")
    if isinstance(msg, dict):
        usage = msg.get("usage")
        return usage if isinstance(usage, dict) else None
    usage = rec.get("usage")
    return usage if isinstance(usage, dict) else None


def _model_of(rec: dict) -> str:
    msg = rec.get("message")
    if isinstance(msg, dict) and msg.get("model"):
        return str(msg["model"])
    return str(rec.get("model") or "")


class PiLogReader(LogReader):
    vendor: str = "pi"

    def project_dirs(self) -> list[Path]:
        """The single sessions root (empty list when it doesn't exist)."""
        default = pi_sessions_root()
        return [default] if default.is_dir() else []

    def _session_dir_files(self, d: Path) -> list[Path]:
        out: list[Path] = []
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
                        out.extend(self._session_dir_files(child))
            except OSError as err:
                log.debug("enumerate %s failed: %s", root, err)
        return out

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only the jsonl files under this workspace's encoded session dir.

        Pi names each session dir after the encoded cwd, so one workspace
        maps to exactly one folder — enumerate just that folder. A missing
        folder is normal (lazy flush: no file exists until the first
        assistant reply completes)."""
        encoded = encode_pi_cwd(workspace_path)
        out: list[Path] = []
        for root in self.project_dirs():
            d = root / encoded
            if d.is_dir():
                out.extend(self._session_dir_files(d))
        return out

    def _in_session_dir(self, path: Path) -> bool:
        name = path.parent.name
        return len(name) > 4 and name.startswith("--") and name.endswith("--")

    def _header(self, path: Path) -> dict:
        """The line-1 session header ({} when unreadable/unexpected). The
        first write creates the file with the header already present, so a
        missing header means the file is not a Pi session file."""
        try:
            with path.open(encoding="utf-8") as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        return {}
                    if isinstance(rec, dict) and rec.get("type") == "session":
                        return rec
                    return {}
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
        return {}

    def _fallback_id(self, path: Path) -> str:
        """Filename fallback: everything after the FIRST "_" (the timestamp
        prefix contains no "_"; the id itself may)."""
        _, sep, sid = path.stem.partition("_")
        return sid if sep else ""

    def cwd_from_file(self, path: Path) -> str:
        """The session's exact cwd from the line-1 header (exact, unlike
        decoding the "-"-encoded dir name, which is lossy for "-")."""
        return str(self._header(path).get("cwd") or "")

    def session_id_from_path(self, path: Path) -> str:
        """The header id is authoritative — the filename's timestamp prefix
        is NOT part of the id `pi --session-id <id>` accepts. Non-session
        siblings return '' so the resume-binding sink never coins bogus ids."""
        if path.suffix != ".jsonl" or not self._in_session_dir(path):
            return ""
        header_id = str(self._header(path).get("id") or "")
        return header_id or self._fallback_id(path)

    def has_session(self, session_id: str) -> bool:
        """True when any session dir holds a file for this id. Filename glob
        first (cheap), then header verification — a glob hit like
        `<ts>_x_<id>.jsonl` (an id ENDING with `_<id>`) must not pass. Used
        by the resume preflight: `pi --session-id <missing-id>` would not
        fail but silently start a blank NEW session under that id."""
        session_id = session_id.strip()
        if not session_id:
            return False
        for root in self.project_dirs():
            try:
                for child in root.iterdir():
                    if not child.is_dir():
                        continue
                    for f in child.glob(f"*_{session_id}.jsonl"):
                        if f.is_file() and self.session_id_from_path(f) == session_id:
                            return True
            except OSError:
                continue
        return False

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        out: list[TokenUsage] = []
        header = self._header(path)
        session_id = str(header.get("id") or "") or self._fallback_id(path)
        file_cwd = str(header.get("cwd") or "")

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
                if not isinstance(rec, dict) or rec.get("type") == "session":
                    continue
                usage = _usage_of(rec)
                if usage is None:
                    continue
                dedup_key = str(rec.get("id") or "")
                if not dedup_key or dedup_key in seen_keys:
                    continue
                input_tokens, output_tokens = _usage_tokens(usage)
                if input_tokens == 0 and output_tokens == 0:
                    continue
                seen_keys.add(dedup_key)
                out.append(
                    TokenUsage(
                        vendor="pi",
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cwd=file_cwd,
                        session_id=session_id,
                        file_path=str(path),
                        dedup_key=dedup_key,
                        timestamp=str(rec.get("timestamp") or ""),
                        model=_model_of(rec),
                    )
                )
        return out

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Parse only complete JSONL records after the persisted byte offset.

        Pi files are NOT append-only: version migrations and /tree branch
        operations rewrite the whole file in place, so mtime/size can go
        backwards and the inode can change. read_jsonl_tail detects both
        (identity/shrink) and resets the offset for a full re-read. The
        recent-id window is KEPT across that reset (the path names one session
        forever and entry ids are stable across rewrites), but it is bounded
        and therefore CANNOT stop a re-read of a session with more credited
        entries than the window holds. The durable `credited_count` is what
        stops the double counting: on a full re-read the first
        `credited_count` usage-bearing entries are replayed silently and only
        what follows them is emitted."""
        records, final_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        recent = [str(k) for k in checkpoint.get("recent_keys", [])][-_RECENT_KEYS_WINDOW:]
        recent_set = set(recent)
        prior_raw = checkpoint.get("credited_count")  # absent ≠ 0
        prior_credited = max(0, int(prior_raw or 0))
        # A full re-read recounts from zero, suppressing the entries the old
        # count already covers; the append path just carries the count forward.
        skip_remaining = prior_credited if rotated else 0
        credited = 0 if rotated else prior_credited
        # Checkpoints persisted before credited_count existed carry no count at
        # all (rotated already implies a non-zero prior offset, i.e. a tracked
        # file). How many entries were credited is unknowable, so this one
        # re-read suppresses everything and just records the true count: losing
        # the entries that single rewrite added beats re-crediting the whole
        # session. The count is durable from the next poll on.
        legacy_reread = rotated and prior_raw is None
        header_cached = bool(checkpoint.get("session_id")) and not rotated
        if header_cached:
            session_id = str(checkpoint.get("session_id") or "")
            cwd = str(checkpoint.get("cwd") or "")
        else:
            header = self._header(path)
            session_id = str(header.get("id") or "") or self._fallback_id(path)
            cwd = str(header.get("cwd") or "")
        out: list[TokenUsage] = []

        for end, rec in records:
            if rec is None or rec.get("type") == "session":
                continue
            usage = _usage_of(rec)
            if usage is None:
                continue
            dedup_key = str(rec.get("id") or "")
            if not dedup_key:
                continue
            input_tokens, output_tokens = _usage_tokens(usage)
            if input_tokens == 0 and output_tokens == 0:
                continue
            # From here the entry qualifies: it is one of the entries the
            # credited count counts.
            if legacy_reread or skip_remaining > 0:
                skip_remaining = max(0, skip_remaining - 1)
                credited += 1
                recent.append(dedup_key)
                recent = recent[-_RECENT_KEYS_WINDOW:]
                recent_set = set(recent)
                continue
            if dedup_key in recent_set:
                continue
            credited += 1
            recent.append(dedup_key)
            recent = recent[-_RECENT_KEYS_WINDOW:]
            recent_set = set(recent)
            event_checkpoint = dict(final_checkpoint)
            event_checkpoint["offset"] = end
            event_checkpoint["recent_keys"] = list(recent)
            event_checkpoint["session_id"] = session_id
            event_checkpoint["cwd"] = cwd
            event_checkpoint["credited_count"] = credited
            out.append(TokenUsage(
                vendor="pi",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=dedup_key,
                timestamp=str(rec.get("timestamp") or ""),
                model=_model_of(rec),
                checkpoint=event_checkpoint,
            ))

        final_checkpoint["recent_keys"] = recent
        final_checkpoint["session_id"] = session_id
        final_checkpoint["cwd"] = cwd
        final_checkpoint["credited_count"] = credited
        return IncrementalParseResult(out, final_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for user and assistant message entries.

        Pi's log carries no explicit end-of-turn signal (an assistant turn
        spans several message/tool entries with no stop record), so no
        turn_complete is emitted. Non-message entries (tool results,
        compaction, branch summaries) are not user-visible activity."""
        out: list[ActivityEvent] = []
        header = self._header(path)
        session_id = str(header.get("id") or "") or self._fallback_id(path)
        cwd = str(header.get("cwd") or "")
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
                if not isinstance(rec, dict) or rec.get("type") != "message":
                    continue
                msg = rec.get("message")
                role = str(msg.get("role") or "") if isinstance(msg, dict) else ""
                if role in ("user", "assistant"):
                    # User message content is either a plain string or text
                    # blocks; carry it so the frontend can name the pane.
                    text = ""
                    if role == "user":
                        text = user_prompt_text(
                            join_text_blocks(msg.get("content"), "text")
                        )
                    out.append(ActivityEvent(
                        vendor="pi",
                        event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key,
                        timestamp=str(rec.get("timestamp") or ""),
                        detail=role, text=text,
                    ))
        return out
