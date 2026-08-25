"""Codex CLI rollout log reader.

Format reference: docs/cli-log-formats.md (Codex section).

Files: ~/.codex/sessions/{Y}/{M}/{D}/rollout-{ts}-{uuid}.jsonl
       (`codex archive` moves a rollout to ~/.codex/archived_sessions/)
Event filter: type=event_msg, payload.type=token_count
Token fields are CUMULATIVE session totals — we compute delta against the
previous totals seen in the same file.

cwd: extracted from the session_meta event (type=session_meta, payload.cwd).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import asyncio
import base64
import os
import tempfile
import re
import shutil
import threading
import time

from .base import Dep, McpWiring, SkillsWiring, VendorSpec, command_text
from ..applog import app_data_dir
from ..skills_store import SkillsStore
from . import _protocols
from ..usage_common import HTTP_TIMEOUT, _snapshot, parse_retry_after
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    activity_high_water,
    join_text_blocks,
    read_jsonl_tail,
    set_activity_high_water,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.codex")

# Sentinel prefix for storing the file's prior cumulative totals inside the
# per-file seen_keys set (avoids needing a separate state dict).
_CUM_PREFIX = "__cum__:"
# Prefix for stashing the last assistant text inside seen_keys, so a turn whose
# assistant message and token_count boundary land in different poll batches
# still delivers the text on its turn_complete (Codex's per-turn boundary).
_TEXT_PREFIX = "__lasttext__:"


def _read_last_text(seen_keys: set[str]) -> str:
    for k in seen_keys:
        if k.startswith(_TEXT_PREFIX):
            return k[len(_TEXT_PREFIX):]
    return ""


def _write_last_text(seen_keys: set[str], text: str) -> None:
    for k in [k for k in seen_keys if k.startswith(_TEXT_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_TEXT_PREFIX}{text}")


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
    # Drop any prior sentinel, write new one.
    for k in [k for k in seen_keys if k.startswith(_CUM_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_CUM_PREFIX}in={input_total},out={output_total}")


class CodexLogReader(LogReader):
    vendor: str = "codex"

    #: One filesystem sweep serves every workspace in a rescan cycle. The
    #: watcher calls session_files_for_workspace once per open workspace, so
    #: without this the sessions trees are re-walked N times per cycle — on a
    #: cold page cache that stalls the event loop for seconds per walk. Kept
    #: well under the watcher's rescan interval; a rollout created inside the
    #: window is picked up by the fs watcher, not this backfill enumeration.
    _SESSION_FILES_TTL_S = 5.0

    #: A rollout's session_meta is its FIRST record, written at creation. A
    #: file this much older than its last write and still headerless will
    #: never grow one (rollouts only append), so the miss is cached instead
    #: of re-opening the file on every rescan of every workspace forever.
    #: Fresh files stay uncached: their header may simply not have landed.
    _HEADER_GRACE_S = 60.0

    def __init__(self) -> None:
        # path -> cwd from the rollout's session_meta header. The header is
        # immutable once written, so each file is opened at most once — an
        # entry is stored once the meta record was read, or as "" once the
        # file aged past _HEADER_GRACE_S without one; a rollout whose header
        # has not landed yet is retried next pass.
        self._cwd_cache: dict[str, str] = {}
        self._files_cache: list[Path] = []
        self._files_cached_at: float = float("-inf")
        # Discovery runs concurrently from the rescan worker thread and the
        # executor threads behind register_pane/force_rescan. The lock keeps
        # the TTL coherent so overlapping callers share one tree walk instead
        # of each paying a cold rglob.
        self._discovery_lock = threading.Lock()

    def project_dirs(self) -> list[Path]:
        roots: list[Path] = []
        default_root = Path.home() / ".codex" / "sessions"
        if default_root.is_dir():
            roots.append(default_root)
        panes_root = Path.home() / ".codex-panes"
        if panes_root.is_dir():
            try:
                roots.extend(
                    p / "sessions"
                    for p in panes_root.iterdir()
                    if (p / "sessions").is_dir()
                )
            except OSError as err:
                log.debug("enumerate %s failed: %s", panes_root, err)
        return roots

    def watch_dirs(self) -> list[Path]:
        roots: list[Path] = []
        default_root = Path.home() / ".codex" / "sessions"
        if default_root.is_dir():
            roots.append(default_root)
        panes_root = Path.home() / ".codex-panes"
        if panes_root.is_dir():
            roots.append(panes_root)
        return roots

    def session_files(self) -> list[Path]:
        with self._discovery_lock:
            now = time.monotonic()
            if now - self._files_cached_at <= self._SESSION_FILES_TTL_S:
                return list(self._files_cache)
            out: list[Path] = []
            for root in self.project_dirs():
                try:
                    for f in root.rglob("rollout-*.jsonl"):
                        if f.is_file():
                            out.append(f)
                except OSError as err:
                    log.debug("rglob %s failed: %s", root, err)
            self._files_cache = out
            self._files_cached_at = now
            # Deleted/archived rollouts must not pin their header entries forever.
            existing = {str(p) for p in out}
            for k in list(self._cwd_cache):
                if k not in existing:
                    del self._cwd_cache[k]
            return list(out)

    def _cwd_from_meta(self, path: Path) -> str:
        """Read just the session_meta header for this rollout's cwd.

        Codex stores sessions by date, not cwd, but every file opens with a
        `session_meta` record carrying payload.cwd. We read only the first few
        lines (not the whole rollout) so per-workspace scoping stays cheap.
        """
        key = str(path)
        with self._discovery_lock:
            cached = self._cwd_cache.get(key)
            if cached is not None:
                return cached
            try:
                with path.open("r", encoding="utf-8", errors="replace") as fh:
                    for _ in range(5):  # session_meta is the first record
                        line = fh.readline()
                        if not line:
                            break
                        try:
                            rec = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if rec.get("type") == "session_meta":
                            payload = rec.get("payload") or {}
                            cwd = str(payload.get("cwd") or "") if isinstance(payload, dict) else ""
                            self._cwd_cache[key] = cwd
                            return cwd
            except OSError:
                return ""
            # No header in the first records. Once the file is old enough
            # that the header must have landed if it ever will, cache the
            # miss — otherwise this rollout is re-opened by every rescan of
            # every workspace for as long as it exists.
            try:
                if time.time() - path.stat().st_mtime >= self._HEADER_GRACE_S:
                    self._cwd_cache[key] = ""
            except OSError:
                pass
            return ""

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """Only rollouts whose session_meta.cwd matches this workspace.

        Reading each file's header to filter is far cheaper than parsing every
        full rollout, and keeps a per-workspace rescan from touching unrelated
        sessions.
        """
        return [
            p for p in self.session_files()
            if self._cwd_from_meta(p) == workspace_path
        ]

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return []

        prev_in, prev_out = _read_cumulative(seen_keys)
        latest_in, latest_out = prev_in, prev_out
        latest_event: dict | None = None
        cwd = ""
        model = ""
        session_id = path.stem

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

                # Pick up cwd / model from session_meta if present
                if rec.get("type") == "session_meta":
                    payload = rec.get("payload") or {}
                    if isinstance(payload, dict):
                        cwd = str(payload.get("cwd") or cwd)
                        model = str(payload.get("model_provider") or payload.get("model") or model)
                    continue

                # Token count events are the only ones we care about
                if rec.get("type") != "event_msg":
                    continue
                payload = rec.get("payload") or {}
                if not isinstance(payload, dict) or payload.get("type") != "token_count":
                    continue
                info = payload.get("info")
                if not isinstance(info, dict):
                    continue
                totals = info.get("total_token_usage")
                if not isinstance(totals, dict):
                    continue

                cur_in = _int(totals.get("input_tokens")) + _int(totals.get("cached_input_tokens"))
                cur_out = _int(totals.get("output_tokens")) + _int(totals.get("reasoning_output_tokens"))
                # Accept any monotonically non-decreasing pair; if values shrink
                # the user likely rotated session — reset baseline silently.
                if cur_in < latest_in or cur_out < latest_out:
                    latest_in = cur_in
                    latest_out = cur_out
                    latest_event = rec
                    continue
                latest_in = cur_in
                latest_out = cur_out
                latest_event = rec

        if latest_event is None:
            return []

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        # Detect session rotation: the totals shrank. Reset baseline to the
        # smaller value WITHOUT emitting (or we'd emit a negative delta).
        if delta_in < 0 or delta_out < 0:
            _write_cumulative(seen_keys, latest_in, latest_out)
            return []
        if delta_in == 0 and delta_out == 0:
            return []

        # Persist new baseline for the next call
        _write_cumulative(seen_keys, latest_in, latest_out)

        return [
            TokenUsage(
                vendor="codex",
                input_tokens=max(0, delta_in),
                output_tokens=max(0, delta_out),
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=f"codex_cumulative::{session_id}::{latest_in}::{latest_out}",
                timestamp=str(latest_event.get("timestamp") or ""),
                model=model,
            )
        ]

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Read only the rollout tail while persisting cumulative baselines."""
        records, next_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        replaced = bool(
            rotated
            and checkpoint.get("identity")
            and checkpoint.get("identity") != next_checkpoint.get("identity")
        )
        prev_in = 0 if replaced else max(0, int(checkpoint.get("input_total") or 0))
        prev_out = 0 if replaced else max(0, int(checkpoint.get("output_total") or 0))
        latest_in, latest_out = prev_in, prev_out
        cwd = "" if replaced else str(checkpoint.get("cwd") or "")
        model = "" if replaced else str(checkpoint.get("model") or "")
        session_id = path.stem if replaced else str(checkpoint.get("session_id") or path.stem)
        latest_event: dict | None = None
        latest_end = int(next_checkpoint.get("offset") or 0)

        for end, rec in records:
            if rec is None:
                continue
            if rec.get("type") == "session_meta":
                payload = rec.get("payload") or {}
                if isinstance(payload, dict):
                    cwd = str(payload.get("cwd") or cwd)
                    session_id = str(payload.get("id") or session_id)
                    model = str(payload.get("model_provider") or payload.get("model") or model)
                continue
            if rec.get("type") != "event_msg":
                continue
            payload = rec.get("payload") or {}
            if not isinstance(payload, dict) or payload.get("type") != "token_count":
                continue
            info = payload.get("info")
            totals = info.get("total_token_usage") if isinstance(info, dict) else None
            if not isinstance(totals, dict):
                continue
            latest_in = _int(totals.get("input_tokens")) + _int(totals.get("cached_input_tokens"))
            latest_out = _int(totals.get("output_tokens")) + _int(totals.get("reasoning_output_tokens"))
            latest_event = rec
            latest_end = end

        next_checkpoint.update({
            "input_total": latest_in,
            "output_total": latest_out,
            "cwd": cwd,
            "model": model,
            "session_id": session_id,
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
            vendor="codex",
            input_tokens=delta_in,
            output_tokens=delta_out,
            cwd=cwd,
            session_id=session_id,
            file_path=str(path),
            dedup_key=f"codex_cumulative::{session_id}::{latest_in}::{latest_out}",
            timestamp=str(latest_event.get("timestamp") or ""),
            model=model,
            checkpoint=event_checkpoint,
        )
        return IncrementalParseResult([event], next_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for assistant + event_msg lines.

        Codex doesn't have a clean "turn end" sentinel like Claude; we use the
        token_count event (which Codex emits at conversation boundaries) as
        a proxy for `turn_complete`.
        """
        out: list[ActivityEvent] = []
        session_id = path.stem
        cwd = ""
        # Latest assistant text for this turn. Persisted in seen_keys (per-file,
        # owned by the watcher) so a turn whose assistant message and its
        # token_count boundary land in DIFFERENT poll batches still delivers the
        # text on turn_complete — a scan-local variable would reset to "".
        last_text = _read_last_text(seen_keys)
        text_changed = False
        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        # Every rtype branch below — including the malformed-JSON one and the
        # `else` catch-all — used to mark its line seen, and the walk is a
        # dense ascending scan from line 1, so one high-water mark says exactly
        # what the per-line keys said without growing with the rollout. See
        # log_readers.base.
        high_water = activity_high_water(seen_keys)
        last_line = high_water

        try:
            with fh:
                for line_no, raw_line in enumerate(fh, 1):
                    raw = raw_line.strip()
                    if not raw:
                        continue
                    if line_no <= high_water:
                        continue
                    key = f"act:{line_no}"
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        # An unterminated final line is still being written.
                        # Leave the mark behind it so the completed line is
                        # read on the next poll: advancing past it dropped
                        # that line's events for good, and when the lost line
                        # was the turn's end record the pane stayed
                        # "mid-turn" forever (GitHub #21).
                        if not raw_line.endswith("\n"):
                            break
                        # A terminated line that will not parse is genuinely
                        # corrupt. Step over it for good rather than
                        # re-reading — and re-emitting — the rest of the file
                        # on every poll.
                        last_line = line_no
                        continue
                    last_line = line_no

                    rtype = rec.get("type")
                    if rtype == "session_meta":
                        payload = rec.get("payload") or {}
                        if isinstance(payload, dict):
                            cwd = str(payload.get("cwd") or cwd)
                        continue

                    ts = str(rec.get("timestamp") or "")
                    if rtype == "assistant":
                        out.append(ActivityEvent(
                            vendor="codex", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail="assistant",
                        ))
                    elif rtype == "response_item":
                        payload = rec.get("payload") or {}
                        if (
                            isinstance(payload, dict)
                            and payload.get("role") == "assistant"
                            and payload.get("type") == "message"
                        ):
                            text = join_text_blocks(payload.get("content"), "output_text")
                            if text:
                                last_text = text
                                text_changed = True
                    elif rtype == "event_msg":
                        payload = rec.get("payload") or {}
                        ptype = str(payload.get("type") or "") if isinstance(payload, dict) else ""
                        if ptype == "agent_message":
                            msg_text = str(payload.get("message") or "")
                            if msg_text:
                                last_text = msg_text
                                text_changed = True
                        # Turn text rides only on turn_complete (the event the
                        # frontend judges). The one exception: a user_message's
                        # typed prompt rides on its own agent_active event so the
                        # frontend can name the pane from the first user text.
                        # "<...>"-wrapped records are injected instruction/context
                        # stubs, not typed prompts.
                        text = ""
                        if ptype == "user_message":
                            text = user_prompt_text(str(payload.get("message") or ""))
                        out.append(ActivityEvent(
                            vendor="codex", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail=ptype, text=text,
                        ))
                        # token_count typically fires once per turn end in Codex.
                        if ptype == "token_count":
                            out.append(ActivityEvent(
                                vendor="codex", event_type="turn_complete",
                                cwd=cwd, session_id=session_id, file_path=str(path),
                                dedup_key=f"turn:{line_no}", timestamp=ts,
                                detail="token_count", text=last_text,
                            ))
                            # Turn consumed the text; reset so the next turn's
                            # empty-text boundary can't reuse it.
                            last_text = ""
                            text_changed = True
        finally:
            set_activity_high_water(seen_keys, last_line)
            if text_changed:
                _write_last_text(seen_keys, last_text)
        return out


# ---- per-pane CODEX_HOME management (merged from codex_home.py) ------------

_SAFE_HOME_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")

# CODEX_HOME *routing* lookup only: which home physically holds a rollout.
# `sessions` is nested {Y}/{M}/{D}; `codex archive` moves a rollout into the
# flat `archived_sessions` instead. Do NOT reuse this for watcher roots or for
# `_pane_id_from_home_path` — that helper hardcodes `parts[1] == "sessions"`,
# so an archived path would silently attribute to no pane (empty pane id).
# Resumability is a separate question: see `find_resumable_session_home`.
_SESSION_SUBDIRS = ("sessions", "archived_sessions")
# Sub-agent nesting seen in the wild is depth 3; the cap only stops a
# corrupted parent chain from looping.
_MAX_THREAD_HOPS = 8
# Same budget the attribution layer reads session files with.
_META_READ_BYTES = 524_288


class CodexHomeManager:
    """Create isolated CODEX_HOME dirs while sharing stable user config."""

    def __init__(
        self,
        *,
        real_home: Path | None = None,
        panes_root: Path | None = None,
        managed_skills_root: Path | None = None,
    ) -> None:
        self.real_home = real_home or (Path.home() / ".codex")
        self.panes_root = panes_root or (Path.home() / ".codex-panes")
        self.managed_skills_root = managed_skills_root or (app_data_dir() / "runtime" / "skills")
        self._refresh_managed_skills = managed_skills_root is None
        self.shared_entries = (
            "auth.json",
            "config.toml",
            "AGENTS.md",
            "plugins",
            "rules",
            "memories",
        )

    def prepare(self, home_id: str, *, source_home: Path | None = None) -> Path:
        """Create the per-pane home, symlinking shared entries from
        ``source_home`` (a CLI account profile home) or the real ~/.codex."""
        source = source_home or self.real_home
        if source_home is None:
            # A prior in-pane login may sit stranded in another pane's home
            # (fresh install: no real auth.json existed to symlink at that
            # pane's spawn). Adopt it first so this pane seeds logged-in.
            self.promote_stranded_auth()
        safe_id = self._safe_home_id(home_id)
        pane_home = self.panes_root / safe_id
        pane_home.mkdir(parents=True, exist_ok=True)
        for name in self.shared_entries:
            src = source / name
            dst = pane_home / name
            if not src.exists() or dst.exists() or dst.is_symlink():
                continue
            try:
                dst.symlink_to(src, target_is_directory=src.is_dir())
            except OSError as err:
                log.warning("codex home symlink %s -> %s failed: %s", dst, src, err)
        self._prepare_skills_view(pane_home, source / "skills")
        return pane_home

    def _prepare_skills_view(self, pane_home: Path, native_root: Path) -> None:
        """Expose native and enabled managed skills under ``CODEX_HOME/skills``.

        The generated view is rebuilt on every prepare so disabled managed
        skills disappear on the next spawn. Native entries are linked first;
        a managed skill with the same name is skipped. Every failure is logged
        and contained so optional skill wiring can never block a pane spawn.
        """
        view = pane_home / ".navide-skills"
        skills_link = pane_home / "skills"
        tmp: Path | None = None
        backup = pane_home / ".navide-skills.old"
        try:
            managed_root = self.managed_skills_root
            if self._refresh_managed_skills:
                try:
                    managed_root = SkillsStore().rebuild_runtime_projection()
                except Exception as err:  # noqa: BLE001 - optional wiring cannot block spawn
                    log.warning("refreshing managed Skills projection failed: %s", err)
                    managed_root = pane_home / ".navide-skills-unavailable"
            tmp = Path(tempfile.mkdtemp(prefix=".navide-skills-", dir=pane_home))
            native_entries = (
                sorted(native_root.iterdir(), key=lambda path: path.name)
                if native_root.is_dir()
                else []
            )
            native_names = {
                entry.name
                for entry in native_entries
                if entry.is_dir() or entry.is_file() or entry.is_symlink()
            }
            for entry in native_entries:
                if entry.is_dir():
                    (tmp / entry.name).symlink_to(entry, target_is_directory=True)
            if managed_root.is_dir():
                for entry in sorted(managed_root.iterdir(), key=lambda path: path.name):
                    if not entry.is_dir() or entry.name in native_names:
                        continue
                    (tmp / entry.name).symlink_to(entry, target_is_directory=True)

            if backup.exists() or backup.is_symlink():
                self._remove_generated_path(backup)
            if view.exists() or view.is_symlink():
                os.replace(view, backup)
            os.replace(tmp, view)
            tmp = None

            if skills_link.is_symlink():
                if os.readlink(skills_link) != os.fspath(view):
                    skills_link.unlink()
            elif skills_link.exists():
                log.warning("leaving real Codex skills directory unmodified: %s", skills_link)
                return
            if not skills_link.is_symlink():
                skills_link.symlink_to(view, target_is_directory=True)
            if backup.exists() or backup.is_symlink():
                self._remove_generated_path(backup)
        except OSError as err:
            log.warning("codex managed-skills view failed for %s: %s", pane_home, err)
            if not view.exists() and backup.exists():
                try:
                    os.replace(backup, view)
                except OSError:
                    pass
            if not skills_link.exists() and not skills_link.is_symlink() and native_root.is_dir():
                try:
                    skills_link.symlink_to(native_root, target_is_directory=True)
                except OSError:
                    pass
        finally:
            if tmp is not None:
                self._remove_generated_path(tmp)

    def promote_stranded_auth(self) -> bool:
        """Adopt an in-pane Codex login as the shared credential.

        On a fresh install the real ~/.codex/auth.json does not exist when a
        pane home is prepared, so prepare() seeds no auth.json symlink; an
        OAuth login completed INSIDE that pane then writes a real auth.json
        into the per-pane home — invisible to every other pane and to usage
        polling. While the real file is still absent, promote the newest such
        stranded credential: hard-link it into the real home (atomic; a
        concurrent writer beating us simply wins) and swap the pane's copy
        for the standard symlink so codex token refreshes write through to
        the shared file. Returns True when the real home gained the
        credential."""
        real_auth = self.real_home / "auth.json"
        try:
            if real_auth.exists() or real_auth.is_symlink():
                return False
            if not self.panes_root.is_dir():
                return False
            stranded = [
                p for p in self.panes_root.glob("*/auth.json")
                if p.is_file() and not p.is_symlink()
            ]
            if not stranded:
                return False
            newest = max(stranded, key=lambda p: p.stat().st_mtime)
            self.real_home.mkdir(parents=True, exist_ok=True)
            try:
                os.link(newest, real_auth)
            except FileExistsError:
                return False
        except OSError as err:
            log.warning("promoting in-pane codex login failed: %s", err)
            return False
        try:
            tmp = newest.with_name(".auth.json.promote-tmp")
            tmp.unlink(missing_ok=True)
            tmp.symlink_to(real_auth)
            os.replace(tmp, newest)
        except OSError as err:
            # Promotion itself succeeded; the pane keeps its own copy and
            # will diverge on refresh until its next prepare() re-links it.
            log.warning("relinking %s to shared codex auth failed: %s", newest, err)
        log.info("promoted in-pane codex login %s -> %s", newest, real_auth)
        return True

    @staticmethod
    def _remove_generated_path(path: Path) -> None:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)

    def find_session_home(self, resume_id: str) -> Path | None:
        """Locate the CODEX_HOME that physically holds this session, if any.

        Routing only: `codex resume <id>` reads the home it was recorded under
        (rollout file + that home's own state db), so a resume must be spawned
        with that CODEX_HOME rather than a fresh per-pane one. Checks the real
        ~/.codex first (sessions predating per-pane homes), then every per-pane
        home (covers persisted home ids that drifted from the dir actually
        holding the session). Returns None when no home has it.

        Archived rollouts count here — `codex archive` only moves the file into
        archived_sessions/, and routing to the owning home is still the right
        env for an unarchive. It does NOT mean the session can be resumed: use
        `find_resumable_session_home` for that question.
        """
        return self._locate_session_home(resume_id, _SESSION_SUBDIRS)

    def find_resumable_session_home(self, resume_id: str) -> Path | None:
        """Like `find_session_home`, but only for sessions codex will resume.

        `sessions/` only: codex refuses to resume an archived thread — the
        0.147.0 binary carries "session <id> is archived. Run `codex unarchive
        <id>` to unarchive it first." (alongside "failed to locate archived
        thread id"). Treating an archived id as existing would pass preflight
        and launch a doomed `codex resume`.
        """
        return self._locate_session_home(resume_id, ("sessions",))

    def _locate_session_home(
        self, resume_id: str, subdirs: tuple[str, ...]
    ) -> Path | None:
        rid = resume_id.strip()
        if not _SAFE_HOME_ID.match(rid):
            return None
        pattern = f"rollout-*{rid}.jsonl"

        def holds_session(home: Path) -> bool:
            for name in subdirs:
                subdir = home / name
                if not subdir.is_dir():
                    continue
                if next(subdir.rglob(pattern), None) is not None:
                    return True
            return False

        try:
            if holds_session(self.real_home):
                return self.real_home
        except OSError:
            pass
        if self.panes_root.is_dir():
            try:
                for pane_home in sorted(self.panes_root.iterdir()):
                    if holds_session(pane_home):
                        self._prepare_skills_view(pane_home, self.real_home / "skills")
                        return pane_home
            except OSError:
                pass
        return None

    def resolve_user_thread_id(self, resume_id: str) -> str:
        """Repair a resume id that names a SUB-AGENT thread.

        Builds shipped before sub-agent rollouts were recognised pinned
        whichever thread wrote last to a pane's CODEX_HOME, which is the
        sub-agent whenever codex spawned one. Resuming that id lands on a
        thread the parent owns and codex refuses the pane's input outright.
        The id the pane meant is the user thread the sub-agent descends from:
        take the ancestor session_meta the fork replayed into its own rollout,
        else hop to `parent_thread_id` and ask again (nesting is allowed).

        Returns `resume_id` unchanged for a normal thread, an unknown id, or a
        chain that cannot be resolved — the caller then resumes exactly what it
        was given, as it did before.
        """
        rid = resume_id.strip()
        seen: set[str] = set()
        for _ in range(_MAX_THREAD_HOPS):
            if not rid or rid in seen or not _SAFE_HOME_ID.match(rid):
                return resume_id
            seen.add(rid)
            rollout = self._rollout_path(rid)
            if rollout is None:
                return resume_id
            try:
                text = rollout.read_text(encoding="utf-8", errors="ignore")[:_META_READ_BYTES]
            except OSError:
                return resume_id
            metas = _session_meta_payloads(text)
            if not metas or metas[0].get("thread_source") != "subagent":
                return rid  # already a user thread
            ancestor = next(
                (str(m["id"]) for m in metas
                 if m.get("thread_source") != "subagent" and m.get("id")),
                "",
            )
            if ancestor:
                return ancestor
            rid = str(metas[0].get("parent_thread_id") or "")
        return resume_id

    def _rollout_path(self, resume_id: str) -> Path | None:
        """The rollout file recording this session, in whichever home holds it.
        Same search order as `_locate_session_home`, without its skills-view
        side effect — this runs while repairing an id, not while routing one."""
        pattern = f"rollout-*{resume_id}.jsonl"
        roots = [self.real_home]
        if self.panes_root.is_dir():
            try:
                roots.extend(sorted(self.panes_root.iterdir()))
            except OSError:
                pass
        for home in roots:
            for name in _SESSION_SUBDIRS:
                subdir = home / name
                if not subdir.is_dir():
                    continue
                try:
                    found = next(subdir.rglob(pattern), None)
                except OSError:
                    continue
                if found is not None:
                    return found
        return None

    def cleanup(self, home_id: str) -> bool:
        safe_id = self._safe_home_id(home_id)
        pane_home = (self.panes_root / safe_id).resolve()
        root = self.panes_root.resolve()
        try:
            pane_home.relative_to(root)
        except ValueError:
            raise ValueError(f"refusing to clean path outside codex panes root: {pane_home}")
        if pane_home == root:
            raise ValueError("refusing to clean codex panes root")
        if not pane_home.exists() and not pane_home.is_symlink():
            return False
        if pane_home.is_symlink():
            pane_home.unlink()
            return True
        shutil.rmtree(pane_home)
        return True

    def _safe_home_id(self, home_id: str) -> str:
        value = home_id.strip()
        if not value or not _SAFE_HOME_ID.match(value):
            raise ValueError(f"invalid codex home id: {home_id!r}")
        return value


# ---- attribution/watch hooks ----------------------------------------------

_CODEX_PANES_ROOT_NAME = ".codex-panes"


def _session_meta_resume_id(text: str) -> str:
    """The session_meta record's payload.id — the id `codex resume` actually
    needs (the filename stem includes a timestamp prefix and is NOT accepted).
    '' when the expected shape isn't found.

    A sub-agent thread is never that id. Codex writes each sub-agent it spawns
    as its own rollout inside the SAME per-pane CODEX_HOME, marked
    `thread_source: "subagent"`; resuming one lands on a thread whose input the
    parent owns, and codex refuses it outright ("This sub-agent is controlled
    by its parent. Direct input is disabled."). The pane is driving the thread
    that spawned the sub-agent, and that thread's own rollout always sits in
    the same home — so a sub-agent file announces nothing and the parent's file
    keeps the binding.
    """
    for payload in _session_meta_payloads(text):
        if payload.get("thread_source") == "subagent":
            return ""
        if payload.get("id"):
            return str(payload["id"])
    return ""


def _session_meta_payloads(text: str) -> list[dict]:
    """Every session_meta payload in `text`, in file order.

    A rollout normally opens with exactly one. A thread codex forked — a
    sub-agent — replays its ancestors' session_meta records after its own, so
    later entries describe the thread it was spawned from.
    """
    out: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or '"session_meta"' not in line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") == "session_meta":
            payload = rec.get("payload") or {}
            if isinstance(payload, dict):
                out.append(payload)
    return out


def command_with_resume_id(command: Any, old_id: str, new_id: str) -> Any:
    """The launch command with `old_id` swapped for `new_id`, preserving the
    ``[shell, '-ilc', '<cmd>']`` wrapper the frontend sends (see
    ``command_text``)."""
    if isinstance(command, list):
        if not command:
            return command
        return [*command[:-1], str(command[-1]).replace(old_id, new_id)]
    return str(command or "").replace(old_id, new_id)


def _pane_id_from_home_path(file_path: str) -> str:
    try:
        path = Path(file_path).resolve()
        panes_root = (Path.home() / _CODEX_PANES_ROOT_NAME).resolve()
        rel = path.relative_to(panes_root)
    except (OSError, ValueError):
        return ""
    parts = rel.parts
    if len(parts) >= 3 and parts[1] == "sessions":
        return parts[0]
    return ""


def _path_identity(self, usage):
    # Per-pane CODEX_HOME path encodes the pane id. The rollout file is
    # created before session_meta is always readable; return None until the
    # real resume id appears so a malformed fallback id is never announced.
    pane_id = _pane_id_from_home_path(usage.file_path)
    if not pane_id:
        return None
    try:
        text = Path(usage.file_path).read_text(
            encoding="utf-8", errors="ignore")[:524_288]
    except OSError:
        text = ""
    return pane_id, _session_meta_resume_id(text)


def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # session_meta carries cwd -> usage.cwd.
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


def _resume_id_from_session_text(self, text):
    return _session_meta_resume_id(text)


CodexLogReader.binds_by_marker_file = True
CodexLogReader.emits_session_sink = True
CodexLogReader.requires_real_resume_id = True
CodexLogReader.path_identity = _path_identity
CodexLogReader.workspace_match = _workspace_match
CodexLogReader.pane_cwd_match = _pane_cwd_match
CodexLogReader.resume_id_from_session_text = _resume_id_from_session_text


def _pane_home_id(self, file_path):
    return _pane_id_from_home_path(file_path)


CodexLogReader.pane_home_id = _pane_home_id


# ---- credentials (vault identity) ------------------------------------------

def identity_from_secret(secret):
    """Display identity for the accounts UI: codex auth.json's id_token JWT
    carries the login email (display only — signature not verified)."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    if not isinstance(data, dict):
        data = None
    tokens = (data or {}).get("tokens")
    id_token = tokens.get("id_token") if isinstance(tokens, dict) else None
    email = None
    if isinstance(id_token, str) and id_token.count(".") >= 2:
        payload = id_token.split(".")[1]
        try:
            decoded = json.loads(
                base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            value = decoded.get("email")
            email = value if isinstance(value, str) and value else None
        except (ValueError, UnicodeDecodeError):
            email = None
    signed_in = bool(
        isinstance(tokens, dict) and (tokens.get("access_token") or id_token)
        or (data or {}).get("OPENAI_API_KEY")
    )
    return {"email": email, "signedIn": signed_in}


# ---- usage quota -----------------------------------------------------------

def read_codex_credentials(codex_home: Path) -> dict | None:
    """Parse ``auth.json``: tokens object (snake_case or camelCase) or the
    bare ``{"OPENAI_API_KEY": ...}`` form."""
    try:
        data = json.loads((codex_home / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    tokens = data.get("tokens")
    if isinstance(tokens, dict):
        access = tokens.get("access_token") or tokens.get("accessToken")
        if access:
            return {
                "access_token": access,
                "account_id": tokens.get("account_id") or tokens.get("accountId"),
            }
    api_key = data.get("OPENAI_API_KEY")
    if isinstance(api_key, str) and api_key:
        return {"access_token": api_key, "account_id": None}
    return None


def codex_base_url(codex_home: Path) -> str:
    """``chatgpt_base_url`` from config.toml (simple line parse, matching
    CodexBar), normalized: strip trailing slash; chatgpt.com/chat.openai.com
    bases get ``/backend-api`` appended when missing."""
    base = ""
    try:
        for line in (codex_home / "config.toml").read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "chatgpt_base_url":
                base = value.strip().strip("'\"")
                break
    except OSError:
        pass
    if not base:
        return _protocols.CODEX_DEFAULT_BASE
    base = base.rstrip("/")
    if (base.startswith("https://chatgpt.com") or base.startswith("https://chat.openai.com")) \
            and "/backend-api" not in base:
        base += "/backend-api"
    return base




async def fetch_codex(codex_home: Path) -> dict:
    creds = read_codex_credentials(codex_home)
    if creds is None:
        # Fresh-install rescue: an OAuth login completed inside a manual pane
        # sits stranded in ~/.codex-panes/<pane>/auth.json (no real auth.json
        # existed to symlink at spawn). Adopt it so the credential is shared
        # and the badge lights without waiting for a new pane spawn.
        if await asyncio.to_thread(
            CodexHomeManager(real_home=codex_home).promote_stranded_auth
        ):
            creds = read_codex_credentials(codex_home)
    if creds is None:
        return _snapshot("codex", "no-credentials")
    import httpx

    headers = {
        "Authorization": f"Bearer {creds['access_token']}",
        "User-Agent": "Navide",
        "Accept": "application/json",
    }
    if creds.get("account_id"):
        headers["ChatGPT-Account-Id"] = creds["account_id"]
    url = _protocols.codex_usage_url(codex_base_url(codex_home))
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("codex", "expired")
    if resp.status_code == 429:
        snap = _snapshot("codex", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("codex", "error", error=f"HTTP {resp.status_code}")
    payload = resp.json()
    windows, plan = _protocols.normalize_codex(payload)
    snap = _snapshot("codex", "ok", windows=windows, plan_type=plan)
    credits = _protocols._codex_credits(payload)
    if credits is not None:
        snap["credits"] = credits
    extra = _protocols._codex_extra_windows(payload)
    if extra:
        snap["extraWindows"] = extra
    return snap




# ---- resume / session ------------------------------------------------------

_RESUME_RE = re.compile(r"^codex\s+resume\s+(\S+)")


def _resume_id_from_command(command) -> str:
    """Session id from a `codex resume <id> ...` command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return m.group(1) if m else ""


def _session_exists(workspace_path: str, session_id: str) -> bool:
    # Agent History stores only a pointer to the vendor-owned rollout. A
    # stale pointer must not pass preflight and launch a doomed
    # `codex resume`; search both the real and isolated per-pane homes.
    # Archived rollouts are deliberately excluded — codex refuses to resume
    # them, so "exists" here means "resumable".
    return CodexHomeManager().find_resumable_session_home(session_id) is not None


# ---- vendor spec -----------------------------------------------------------

SPEC = VendorSpec(
    key="codex",
    # Verified 2026-08-15: codex resolves its skills from $CODEX_HOME/skills.
    skills_supported=True,
    skills_wiring=SkillsWiring(
        root_env="CODEX_HOME",
        reads_shared_root=True,
        root_home=(".codex",),
        skills_rel=("skills",),
    ),
    label="Codex",
    # No JSON document at all: `-c` is a one-shot TOML override merged over
    # config.toml at process start, and stays valid after a subcommand
    # (`codex resume`). The dotted key doubles as the already-wired marker.
    mcp_wiring=McpWiring(
        flag="-c",
        flag_value='mcp_servers.{name}.url="{url}"',
        already_wired="mcp_servers.{name}",
    ),
    login_command_args="login",
    live_file=(".codex", "auth.json"),
    slot_file="auth.json",
    login_home_secret_file=("auth.json",),
    profile_home_secret_file=("auth.json",),
    login_home_env="CODEX_HOME",
    identity_from_secret=identity_from_secret,
    # Late-bound (module global at call time) so tests can monkeypatch. The
    # wham endpoint reads the EFFECTIVE codex home ($CODEX_HOME override,
    # else <home>/.codex) — the same resolution the poller used inline.
    fetch_usage=lambda home: fetch_codex(
        Path(os.environ["CODEX_HOME"]) if os.environ.get("CODEX_HOME")
        else home / ".codex"
    ),
    resume_id_from_command=_resume_id_from_command,
    session_exists=_session_exists,
    home_env_vars=("CODEX_HOME",),
    interrupt_key=b"\x1b",
    make_log_reader=CodexLogReader,
    install_dep=Dep("codex", "Codex", "OpenAI Codex CLI", "agent_cli",
        ["codex", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="npm install -g @openai/codex", needs_terminal=True,
        requires_binaries=("npm",),
        optional=True, docs_url="https://learn.chatgpt.com/docs/codex/cli",
        update_cmd="codex update", doctor_cmd="codex doctor",
        npm_package="@openai/codex"),
)
