"""GitHub Copilot CLI conversation log reader.

Layout (root = $COPILOT_HOME, default ~/.copilot):
  <root>/session-state/<uuid>/events.jsonl    (dir name = session id — the
  exact id accepted by `copilot --resume=<id>`)
  <root>/session-state/<uuid>/workspace.yaml  (id / cwd / timestamps)

Structure captured live against copilot-cli 1.0.75. Every events.jsonl line
is `{type, data, id, timestamp, parentId}` (ISO 8601 timestamps). Types this
reader consumes:
  * user.message       — data.content is the VERBATIM user text, so the
                         kickoff's at-pane marker lands in the file.
  * assistant.message  — data.content / data.model (activity + turn text).
  * assistant.turn_end — explicit end-of-turn record → turn_complete.
  * session.shutdown   — data.modelMetrics.<model>.usage carries the run's
                         token buckets; compaction events are expected to
                         carry the same shape mid-run.

Token buckets (verified 1.0.75): usage.inputTokens ALREADY includes
cacheReadTokens + cacheWriteTokens, and usage.outputTokens already includes
reasoningTokens — they map straight onto TokenUsage's cache-folded-into-input
/ reasoning-folded-into-output design. Totals appear only on shutdown /
compaction events and are point-in-time snapshots, so they are treated as
CUMULATIVE like the Codex reader: emit the delta against the previous
snapshot, and silently reset the baseline when totals shrink (session
rotation, or a resumed run restarting its in-process counters — this never
double-counts, at worst it undercounts a resumed run).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import yaml

from .base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    read_jsonl_tail,
)

log = logging.getLogger("agent_team_backend.log_readers.copilot")

# Sentinel prefixes persisted inside the watcher-owned per-file seen_keys set
# (same trick as the Codex reader): the previous cumulative totals, and the
# latest assistant text so a turn whose assistant.message and turn_end land
# in different poll batches still delivers the text on turn_complete.
_CUM_PREFIX = "__cum__:"
_TEXT_PREFIX = "__lasttext__:"


def copilot_root() -> Path:
    """Copilot CLI's config/session root ($COPILOT_HOME, default ~/.copilot)."""
    env = os.environ.get("COPILOT_HOME")
    return Path(env) if env else Path.home() / ".copilot"


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _read_cumulative(seen_keys: set[str]) -> tuple[int, int]:
    """Return (prev_input, prev_output) from sentinel key, or (0, 0)."""
    for k in seen_keys:
        if k.startswith(_CUM_PREFIX):
            try:
                _, body = k.split(":", 1)
                parts = dict(p.split("=") for p in body.split(","))
                return int(parts.get("in", 0)), int(parts.get("out", 0))
            except (ValueError, KeyError):
                continue
    return 0, 0


def _write_cumulative(seen_keys: set[str], input_total: int, output_total: int) -> None:
    for k in [k for k in seen_keys if k.startswith(_CUM_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_CUM_PREFIX}in={input_total},out={output_total}")


def _read_last_text(seen_keys: set[str]) -> str:
    for k in seen_keys:
        if k.startswith(_TEXT_PREFIX):
            return k[len(_TEXT_PREFIX):]
    return ""


def _write_last_text(seen_keys: set[str], text: str) -> None:
    for k in [k for k in seen_keys if k.startswith(_TEXT_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_TEXT_PREFIX}{text}")


def _metrics_totals(data: dict) -> tuple[int, int] | None:
    """Cumulative (input, output) totals from a metrics-bearing event's data.

    modelMetrics (per-model buckets, summed across models) is authoritative;
    the top-level tokenDetails buckets are the fallback for shapes that omit
    it. Returns None when the record carries no token buckets at all (e.g.
    session.usage_checkpoint only records billing units).
    """
    metrics = data.get("modelMetrics")
    if isinstance(metrics, dict) and metrics:
        total_in = total_out = 0
        for per_model in metrics.values():
            usage = per_model.get("usage") if isinstance(per_model, dict) else None
            if isinstance(usage, dict):
                total_in += _int(usage.get("inputTokens"))
                total_out += _int(usage.get("outputTokens"))
        return total_in, total_out
    details = data.get("tokenDetails")
    if isinstance(details, dict):
        def bucket(name: str) -> int:
            b = details.get(name)
            return _int(b.get("tokenCount")) if isinstance(b, dict) else 0

        input_tokens = bucket("input") + bucket("cache_read") + bucket("cache_write")
        return input_tokens, bucket("output")
    return None


class CopilotLogReader(LogReader):
    vendor: str = "copilot"

    def _sessions_root(self) -> Path:
        return copilot_root() / "session-state"

    def project_dirs(self) -> list[Path]:
        """The single session-state root (empty list when it doesn't exist)."""
        default = self._sessions_root()
        return [default] if default.is_dir() else []

    def session_files(self) -> list[Path]:
        out: list[Path] = []
        for root in self.project_dirs():
            try:
                for f in root.glob("*/events.jsonl"):
                    if f.is_file():
                        out.append(f)
            except OSError as err:
                log.debug("glob %s failed: %s", root, err)
        return out

    def _workspace_meta(self, path: Path) -> dict:
        """The session's sibling workspace.yaml ({} when unreadable)."""
        meta = path.parent / "workspace.yaml"
        try:
            rec = yaml.safe_load(meta.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            return {}
        return rec if isinstance(rec, dict) else {}

    def cwd_from_file(self, path: Path) -> str:
        return str(self._workspace_meta(path).get("cwd") or "")

    def session_id_from_path(self, path: Path) -> str:
        """Id is the session dir name (what `copilot --resume=<id>` accepts),
        NOT the stem — every session file is events.jsonl. Sibling files in
        the session dir (session.db, workspace.yaml, checkpoints/) are not
        session files → '' so the resume sink skips them instead of coining
        bogus ids like "session" or "workspace"."""
        if path.name != "events.jsonl" or path.parent.parent.name != "session-state":
            return ""
        return path.parent.name

    def has_session(self, session_id: str) -> bool:
        """True when <root>/session-state/<id>/events.jsonl exists. The
        resume preflight uses this because `copilot --resume=<stale-id>`
        would not fail — it silently starts a blank NEW session under that
        UUID."""
        session_id = session_id.strip()
        if not session_id or "/" in session_id:
            return False
        return any(
            (root / session_id / "events.jsonl").is_file()
            for root in self.project_dirs()
        )

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only sessions whose workspace.yaml cwd matches this workspace
        (Copilot keys session dirs by uuid, not by cwd)."""
        return [
            p for p in self.session_files()
            if self.cwd_from_file(p) == workspace_path
        ]

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        if path.name != "events.jsonl":
            return []
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return []

        prev_in, prev_out = _read_cumulative(seen_keys)
        latest_in, latest_out = prev_in, prev_out
        latest_event: dict | None = None
        model = ""
        session_id = path.parent.name
        cwd = self.cwd_from_file(path)

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
                data = rec.get("data")
                if not isinstance(data, dict):
                    continue
                totals = _metrics_totals(data)
                if totals is None:
                    continue
                latest_in, latest_out = totals
                latest_event = rec
                model = str(data.get("currentModel") or "") or model

        if latest_event is None:
            return []

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        # Totals shrank (rotation / a resumed run's counters restarting):
        # reset the baseline WITHOUT emitting, or we'd emit a negative delta.
        if delta_in < 0 or delta_out < 0:
            _write_cumulative(seen_keys, latest_in, latest_out)
            return []
        if delta_in == 0 and delta_out == 0:
            return []

        _write_cumulative(seen_keys, latest_in, latest_out)
        return [
            TokenUsage(
                vendor="copilot",
                input_tokens=delta_in,
                output_tokens=delta_out,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=f"copilot_cumulative::{session_id}::{latest_in}::{latest_out}",
                timestamp=str(latest_event.get("timestamp") or ""),
                model=model,
            )
        ]

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Read only the events tail while persisting the cumulative baseline.

        Metrics snapshots land only at shutdown/compaction, so most polls
        emit nothing; when one lands, emit its delta against the persisted
        totals (negative/zero deltas advance the baseline silently).
        """
        records, next_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        replaced = bool(
            rotated
            and checkpoint.get("identity")
            and checkpoint.get("identity") != next_checkpoint.get("identity")
        )
        prev_in = 0 if replaced else _int(checkpoint.get("input_total"))
        prev_out = 0 if replaced else _int(checkpoint.get("output_total"))
        latest_in, latest_out = prev_in, prev_out
        model = "" if replaced else str(checkpoint.get("model") or "")
        cwd = "" if replaced else str(checkpoint.get("cwd") or "")
        if not cwd:
            cwd = self.cwd_from_file(path)
        session_id = path.parent.name
        latest_event: dict | None = None
        latest_end = int(next_checkpoint.get("offset") or 0)

        for end, rec in records:
            if rec is None:
                continue
            data = rec.get("data")
            if not isinstance(data, dict):
                continue
            totals = _metrics_totals(data)
            if totals is None:
                continue
            latest_in, latest_out = totals
            latest_event = rec
            latest_end = end
            model = str(data.get("currentModel") or "") or model

        next_checkpoint.update({
            "input_total": latest_in,
            "output_total": latest_out,
            "cwd": cwd,
            "model": model,
        })
        if latest_event is None:
            return IncrementalParseResult([], next_checkpoint)

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        if delta_in < 0 or delta_out < 0 or (delta_in == 0 and delta_out == 0):
            return IncrementalParseResult([], next_checkpoint)

        event_checkpoint = dict(next_checkpoint)
        event_checkpoint["offset"] = latest_end
        event = TokenUsage(
            vendor="copilot",
            input_tokens=delta_in,
            output_tokens=delta_out,
            cwd=cwd,
            session_id=session_id,
            file_path=str(path),
            dedup_key=f"copilot_cumulative::{session_id}::{latest_in}::{latest_out}",
            timestamp=str(latest_event.get("timestamp") or ""),
            model=model,
            checkpoint=event_checkpoint,
        )
        return IncrementalParseResult([event], next_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for user/assistant messages and tool execution
        records, and `turn_complete` on assistant.turn_end — Copilot's
        explicit end-of-turn record — carrying the turn's last assistant text.
        """
        if path.name != "events.jsonl":
            return []
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.parent.name
        last_text = _read_last_text(seen_keys)
        text_changed = False
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

                rtype = str(rec.get("type") or "")
                data = rec.get("data")
                data = data if isinstance(data, dict) else {}
                ts = str(rec.get("timestamp") or "")
                if rtype == "user.message":
                    out.append(ActivityEvent(
                        vendor="copilot", event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts, detail="user",
                    ))
                elif rtype == "assistant.message":
                    text = str(data.get("content") or "")
                    if text:
                        last_text = text
                        text_changed = True
                    out.append(ActivityEvent(
                        vendor="copilot", event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts, detail="assistant",
                    ))
                elif rtype.startswith("tool."):
                    out.append(ActivityEvent(
                        vendor="copilot", event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts, detail=rtype,
                    ))
                elif rtype == "assistant.turn_end":
                    out.append(ActivityEvent(
                        vendor="copilot", event_type="turn_complete",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=f"turn:{line_no}", timestamp=ts,
                        detail="turn_end", text=last_text,
                    ))
                    # The turn consumed the text; reset so the next turn's
                    # empty-text boundary can't reuse it.
                    last_text = ""
                    text_changed = True

        if text_changed:
            _write_last_text(seen_keys, last_text)
        return out
