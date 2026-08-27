"""Common types + LogReader abstract base."""

from __future__ import annotations

import json
import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("agent_team_backend.log_readers")


@dataclass
class TokenUsage:
    """Single token-usage delta extracted from a CLI conversation log.

    input_tokens already includes cache_read + cache_creation (per design:
    cache folded into input). output_tokens includes any reasoning/thinking
    tokens for vendors that report them.
    """

    vendor: str                # "claude" | "codex"
    input_tokens: int
    output_tokens: int
    cwd: str                   # absolute working directory the session ran in
    session_id: str            # log file's session identifier (uuid)
    file_path: str             # absolute path to the .jsonl file
    dedup_key: str             # stable key per logical event; readers compose this
    timestamp: str = ""        # ISO 8601 if the log records one
    model: str = ""            # e.g. "claude-opus-4-7"
    checkpoint: dict[str, Any] = field(default_factory=dict, repr=False)
    replay_workspace: str = ""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens


#: Cap for the user-prompt text a reader attaches to a user-record
#: "agent_active" event (the frontend names a pane from the first one).
USER_PROMPT_MAX_CHARS = 500


def user_prompt_text(raw: str) -> str:
    """Normalize a user-record's text for pane auto-naming: strip, drop
    '<'-prefixed injected wrappers (session markers, command stubs), cap
    length. Shared by every reader so the filter is identical across CLIs.
    """
    text = raw.strip()
    if not text or text.startswith("<"):
        return ""
    return text[:USER_PROMPT_MAX_CHARS]


@dataclass
class ActivityEvent:
    """Vendor-agnostic activity signal extracted from a CLI conversation log.

    event_type:
      - "agent_active"    : agent produced new content or called a tool
                            (proves "still working", regardless of TUI spinner)
      - "turn_complete"   : agent finished its turn (e.g. Claude assistant line
                            with stop_reason=end_turn) — semantic "done" signal
    """

    vendor: str
    event_type: str            # "agent_active" | "turn_complete"
    cwd: str
    session_id: str
    file_path: str
    dedup_key: str             # stable key per event for in-memory dedup
    timestamp: str = ""        # ISO 8601 if available
    detail: str = ""           # e.g. tool name, stop_reason, record type.
                               # Part of the cross-end contract: the frontend
                               # treats "user"/"prompt"/"user_message" details
                               # as user-prompt events when auto-naming panes.
    text: str = ""             # assistant message text for this turn, when the
                               # vendor log carries it; "" when unavailable
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


def join_text_blocks(content: Any, block_type: str) -> str:
    """Join the text of a message's content blocks of one type ("" when none).

    Shared by the vendor readers so assistant-text extraction stays identical
    across CLIs — the pipeline's sentinel/question judgment depends on this
    normalization being the same for every vendor.
    """
    if isinstance(content, str):
        return content
    parts: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == block_type:
                parts.append(str(block.get("text") or ""))
    return "\n".join(p for p in parts if p)


@dataclass
class IncrementalParseResult:
    """Token events plus the compact cursor after the last complete source item."""

    events: list[TokenUsage]
    checkpoint: dict[str, Any]


@dataclass(frozen=True)
class TokenSinkResult:
    """Explicit sink acknowledgement used before a watcher advances a cursor."""

    handled: bool
    workspace_path: str = ""


def read_jsonl_tail(
    path: Path,
    checkpoint: dict[str, Any],
) -> tuple[list[tuple[int, dict[str, Any] | None]], dict[str, Any], bool]:
    """Read complete JSONL records after a byte offset.

    Returns ``(records, next_checkpoint, rotated)``. A partial trailing line is
    intentionally left unread so a later append can complete it. File identity
    and shrink checks prevent seeking into a replaced/truncated generation.
    """
    stat = path.stat()
    identity = f"{stat.st_dev}:{stat.st_ino}"
    prior_identity = str(checkpoint.get("identity") or "")
    offset = max(0, int(checkpoint.get("offset") or 0))
    rotated = bool(offset and (prior_identity != identity or stat.st_size < offset))
    if rotated:
        offset = 0

    records: list[tuple[int, dict[str, Any] | None]] = []
    committed = offset
    with path.open("rb") as fh:
        fh.seek(offset)
        while True:
            raw = fh.readline()
            if not raw:
                break
            end = fh.tell()
            if not raw.endswith(b"\n"):
                break
            committed = end
            try:
                value = json.loads(raw.decode("utf-8"))
                records.append((end, value if isinstance(value, dict) else None))
            except (UnicodeDecodeError, json.JSONDecodeError):
                records.append((end, None))

    next_checkpoint = dict(checkpoint)
    next_checkpoint.update({"kind": "jsonl", "offset": committed, "identity": identity})
    return records, next_checkpoint, rotated


def encode_claude_cwd(cwd: str) -> str:
    """Claude Code's project-dir name for a cwd — the single source of truth.

    Claude replaces EVERY non-alphanumeric char with "-" (dots, underscores,
    spaces, unicode — not just "/"). It encodes its *normalized* cwd, which
    never carries a trailing separator, so strip one before encoding:
    otherwise the extra "-" makes the encoded dir miss the real one.

    Lives here rather than in claude's vendor module because qwen reuses the
    same encoding for its per-project dirs — shared infrastructure, not
    claude-only knowledge.
    """
    return re.sub(r"[^A-Za-z0-9]", "-", cwd.rstrip("/"))


# ── activity dedup: line-scan high-water mark ─────────────────────────────
#
# parse_activity's `seen_keys` is a per-file bag the watcher keeps for the life
# of the file (see LogWatcher._activity_seen). Readers that scan a text log from
# line 1 in ascending order used to put one `act:{line_no}` key in it per line,
# which meant the bag grew forever with the transcript: measured 2026-08-18,
# 452,693 live keys two minutes into a startup scan, pinning 481 MB of pymalloc
# arenas the interpreter can never hand back (GitHub #23). Those keys carry no
# information a single integer doesn't — after a scan to line N the set holds
# exactly lines 1..N — so such readers record one sentinel instead.
#
# Only valid for a strictly ascending, dense line counter where every line the
# reader does not skip *before* the seen test is marked. A reader keyed on db
# row ids, byte offsets, per-session sequence numbers, or one that deliberately
# leaves a malformed line unmarked so a later poll re-reads it, must keep exact
# per-item keys.
_ACTIVITY_HW_PREFIX = "act_hw::"


def activity_high_water(seen_keys: set[str]) -> int:
    """Highest line already parsed out of this file, or 0 for a fresh scan."""
    for k in seen_keys:
        if k.startswith(_ACTIVITY_HW_PREFIX):
            try:
                return int(k[len(_ACTIVITY_HW_PREFIX):])
            except ValueError:
                return 0
    return 0


def set_activity_high_water(seen_keys: set[str], line_no: int) -> None:
    """Record progress through `line_no`, replacing any earlier mark.

    Never moves backwards: a truncated or rewritten file leaves the old mark
    standing, which is exactly what the per-line keys used to do.
    """
    current = activity_high_water(seen_keys)
    if line_no <= current:
        return
    seen_keys.difference_update(
        {k for k in seen_keys if k.startswith(_ACTIVITY_HW_PREFIX)}
    )
    seen_keys.add(f"{_ACTIVITY_HW_PREFIX}{line_no}")


class LogReader(ABC):
    """Abstract reader for one CLI vendor's local conversation logs.

    Subclasses implement `vendor` + the three methods below. The watcher
    orchestrator calls them; readers themselves are stateless apart from
    `seen_keys` which the caller passes in to enable per-file dedup.
    """

    #: Vendor identifier matching `agent_key` in panes ("claude" | "codex").
    vendor: str = ""

    # ---- per-vendor attribution/watch hooks (one-file-per-vendor bridge) --
    # Defaults mean "not migrated": attribution/watcher fall back to their
    # legacy vendor-name branches. A vendor's migration round overrides the
    # hooks on its reader and deletes its name from the legacy branches.

    #: Participates in kickoff-marker file binding (attribution's marker
    #: paths). Migrated replacement for membership in the vendor-name tuples.
    binds_by_marker_file: bool = False

    #: Session files feed the session sink (Agent History). Migrated
    #: replacement for membership in the watcher's vendor-name tuple.
    emits_session_sink: bool = False

    #: Binds via the shared-db marker path (one SQLite store for every
    #: session; grok/opencode/kilo/cursor). Migrated replacement for
    #: membership in attribution's shared-db tuple.
    binds_shared_db_by_marker: bool = False

    #: When a kickoff marker misses, fall back to binding a NEW session to
    #: the single unbound candidate pane in the same cwd. Migrated
    #: replacement for membership in attribution's fallback tuple.
    binds_new_session_single_candidate: bool = False

    def marker_scan_text(self, path: Path) -> str | None:
        """Text to scan for a kickoff marker, or None for the generic
        plain-file read. Override when only part of the file may bind
        (e.g. aider: only the last started-at section is the live session).
        May raise OSError; callers treat that as unreadable."""
        return None

    def workspace_match(
        self, usage: TokenUsage, ws_path: str,
        owner_workspace: str | None = None,
    ) -> bool | None:
        """Does this usage event belong to the workspace at ``ws_path``?
        ``owner_workspace`` is the workspace of the pane a marker binding
        already assigned this session to, when one exists — vendors whose
        logs carry no cwd (cursor) attribute bound sessions through it.
        None = not migrated (attribution's legacy chain decides)."""
        return None

    def pane_cwd_match(
        self, usage: TokenUsage, pane_cwd: str, pane_id: str
    ) -> bool | None:
        """Does this usage event belong to a pane running in ``pane_cwd``?
        None = not migrated (attribution's legacy chain decides)."""
        return None

    #: Marker binding must wait for the vendor's REAL resume id to appear in
    #: the session file (codex: session_meta payload.id — the filename stem
    #: is not accepted by its resume command). Migrated replacement for the
    #: vendor-name check in attribution's marker path.
    requires_real_resume_id: bool = False

    def path_identity(self, usage: TokenUsage) -> tuple[str, str] | None:
        """Identity-path binding, three-state:

        - None: this file is not on the vendor's identity path — fall
          through to marker binding.
        - (pane_id, resume_id): bind now.
        - (pane_id, ""): the path names a pane but the vendor's real resume
          id isn't readable yet — the caller must WAIT (bind nothing this
          event) rather than announce a malformed fallback id.
        Codex: per-pane CODEX_HOME encodes the pane id; session_meta carries
        the real id."""
        return None

    def pane_home_id(self, file_path: str) -> str:
        """Pane/home id encoded in the session file's PATH ('' when none).
        Used to claim sessions for panes spawned with an isolated per-pane
        home (codex)."""
        return ""

    def resume_id_from_session_text(self, text: str) -> str:
        """The id the vendor's resume command needs, parsed from session-file
        text ('' when not found — callers fall back to usage.session_id)."""
        return ""

    def accepts_watch_path(self, path_str: str) -> bool:
        """Accept a filesystem-event path the generic extension filter would
        drop (e.g. aider's Markdown history filenames). Hot path — must be
        a cheap string check."""
        return False

    @abstractmethod
    def project_dirs(self) -> list[Path]:
        """Return all existing root directories under which session jsonl files live.

        Implementations should silently skip non-existent paths (e.g. a user
        without the CLI installed). Returns empty list when nothing exists.
        """

    @abstractmethod
    def session_files(self) -> list[Path]:
        """Enumerate every JSONL session file under project_dirs(), recursively."""

    @abstractmethod
    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        """Parse one JSONL file, return NEW TokenUsage events.

        Implementations MUST:
          - Skip malformed lines (log.debug, never raise)
          - Skip lines whose dedup_key is already in seen_keys
          - Add new dedup_keys to seen_keys (mutating in place is fine)
        """

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict[str, Any],
    ) -> IncrementalParseResult:
        """Parse from a compact cursor.

        Real token readers override this with byte/row watermarks. The fallback
        keeps compatibility for third-party/test readers using the legacy set
        contract; production readers never persist this unbounded form.
        """
        seen = set(str(k) for k in checkpoint.get("legacy_seen", []))
        events = self.parse_session_file(path, seen)
        return IncrementalParseResult(events, {"kind": "legacy", "legacy_seen": sorted(seen)})

    def cwd_from_file(self, path: Path) -> str:
        """Best-effort: derive the spawning cwd from the session file location.

        Default impl returns empty string (subclasses with deterministic
        path → cwd mapping override).
        """
        return ""

    def session_id_from_path(self, path: Path) -> str:
        """The resume session id for a discovered session file.

        Default: the filename stem — Codex/Grok/Antigravity name each session
        file after its id. Readers whose id lives elsewhere (e.g. Kimi, in the
        `session_<uuid>` grandparent dir; every file is named wire.jsonl)
        override. Return '' for a path that is not a real session file so the
        resume-binding sink skips sibling files (state.json, logs) instead of
        coining bogus ids from their stems.
        """
        return path.stem

    def session_files_for_workspace(self, workspace_path: str) -> list[Path] | None:
        """Return only the session files belonging to `workspace_path`.

        Readers whose on-disk layout maps a workspace to a specific folder
        (e.g. Claude's ~/.claude/projects/<encoded-cwd>/) override this to
        return just that subset, so a per-workspace rescan never has to touch
        unrelated files. Return None to signal "can't scope by path" (e.g.
        Codex stores sessions by date), letting the caller fall back to
        session_files(). Default: None.
        """
        return None

    def watch_dirs(self) -> list[Path]:
        """Return directories the watcher should subscribe to.

        By default this is the same as project_dirs(). Readers with dynamic
        child session directories can override this to watch a stable parent
        while still scanning precise session roots.
        """
        return self.project_dirs()

    def claims_path(self, path: Path) -> bool:
        """True when this reader owns `path` (the watcher's routing test).

        Default: the path lives under one of project_dirs(). Readers whose
        files sit outside any fixed root (Aider's per-workspace history
        file) override with their own match. `path` arrives resolved.
        """
        s = str(path)
        for d in self.project_dirs():
            try:
                if s.startswith(str(d.resolve()) + "/"):
                    return True
            except OSError:
                continue
        return False

    def total_usage_for_session(
        self, path: Path, session_id: str
    ) -> dict[str, int]:
        """Sum EVERY usage event this log holds for one session.

        Pure arithmetic for the live per-session backfill: it re-parses the
        whole source with a throwaway dedup set, so nothing is recorded,
        checkpointed, or credited to cumulative/global — replaying through
        the ingestion pipeline would double-count history it already holds.

        The `session_id` filter is what makes this correct for the vendors
        whose sessions share one source (a single SQLite DB for every
        session); for a one-file-per-session vendor it matches every event.
        Pass "" to take the whole file unfiltered.

        Heavy (session files reach tens of MB) — callers MUST run it off the
        event loop. Vendors inherit this; none should need to override it.
        """
        totals = {"input": 0, "output": 0, "calls": 0}
        for usage in self.parse_session_file(path, set()):
            if session_id and usage.session_id != session_id:
                continue
            totals["input"] += int(usage.input_tokens)
            totals["output"] += int(usage.output_tokens)
            totals["calls"] += 1
        return totals

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Parse one JSONL file for activity events (agent_active / turn_complete).

        Default returns no events — vendor-specific subclasses override.
        Same dedup discipline as parse_session_file: skip already-seen keys,
        mutate seen_keys in place for new ones.
        """
        return []
