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

import asyncio
import re
import shutil
import sys
import time

from .base import VendorSpec, command_text
from ..usage_common import (
    HTTP_TIMEOUT,
    _num,
    _snapshot,
    _window,
    communicate_or_kill as _communicate_or_kill,
    parse_retry_after,
)
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    read_jsonl_tail,
    user_prompt_text,
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
        usable = False
        for per_model in metrics.values():
            usage = per_model.get("usage") if isinstance(per_model, dict) else None
            if isinstance(usage, dict):
                usable = True
                total_in += _int(usage.get("inputTokens"))
                total_out += _int(usage.get("outputTokens"))
        # No per-model entry carried a usage dict — that is "no reading", not
        # a genuine zero total; fall through to the tokenDetails branch.
        if usable:
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
        totals, which are a high-water mark: a downward blip emits nothing and
        leaves the baseline where it was.
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

        # High-water mark: a downward blip must not lower the baseline, or the
        # tokens already credited above it get credited a second time when the
        # counter climbs back.
        next_in = max(prev_in, latest_in)
        next_out = max(prev_out, latest_out)
        next_checkpoint.update({
            "input_total": next_in,
            "output_total": next_out,
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
            dedup_key=f"copilot_cumulative::{session_id}::{next_in}::{next_out}",
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
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    # Text iteration yields the partial trailing line of a
                    # file mid-write; leave it unseen so the completed line is
                    # parsed on a later poll (a permanently malformed line is
                    # just re-attempted each poll — cheap).
                    continue
                seen_keys.add(key)

                rtype = str(rec.get("type") or "")
                data = rec.get("data")
                data = data if isinstance(data, dict) else {}
                ts = str(rec.get("timestamp") or "")
                if rtype == "user.message":
                    # data.content holds the prompt verbatim; the frontend
                    # names the pane from the first user text.
                    out.append(ActivityEvent(
                        vendor="copilot", event_type="agent_active",
                        cwd=cwd, session_id=session_id, file_path=str(path),
                        dedup_key=key, timestamp=ts, detail="user",
                        text=user_prompt_text(str(data.get("content") or "")),
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


# ---- attribution/watch hooks ----------------------------------------------

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # Reader emits cwd = the session's workspace.yaml cwd.
    return bool(usage.cwd and usage.cwd == ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return usage.cwd == pane_cwd


CopilotLogReader.binds_by_marker_file = True
CopilotLogReader.binds_new_session_single_candidate = True
CopilotLogReader.emits_session_sink = True
CopilotLogReader.workspace_match = _workspace_match
CopilotLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------

# copilot (GitHub Copilot CLI). ``~/.copilot/config.json`` is metadata only —
# the CLI keeps its OAuth token in the macOS Keychain (never probed here), so
# the token is resolved read-only via ``gh auth token -u <login>`` (gh shares
# the same gho_ GitHub OAuth scope; verified to print without rotating
# anything), then the VS Code/JetBrains-style ~/.config/github-copilot files,
# then GH_TOKEN/GITHUB_TOKEN env. ``copilot_internal/user`` is the surface
# CodexBar and the JetBrains quota monitor use; the Copilot-client headers
# are required for it to answer.
COPILOT_CONFIG_FILE_REL = (".copilot", "config.json")
COPILOT_HOSTS_FILES_REL = (
    (".config", "github-copilot", "apps.json"),
    (".config", "github-copilot", "hosts.json"),
)
COPILOT_DEFAULT_HOST = "github.com"
COPILOT_ENV_KEYS = ("GH_TOKEN", "GITHUB_TOKEN")
# The Editor-Version/User-Agent set this once sent identified the app as the
# VS Code Copilot Chat extension. Measured 2026-08-05: the endpoint answers the
# same without any of it, so the read stays and the costume does not.
COPILOT_GH_TOKEN_TIMEOUT = 5.0


def read_copilot_config(home: Path) -> dict | None:
    """Parse ``~/.copilot/config.json`` (JSONC: ``//`` comment lines before the
    JSON body). Returns {host, login} for ``lastLoggedInUser`` (host reduced to
    a bare hostname, default github.com), or None when absent/malformed/logged
    out. The file is metadata only — the CLI's token lives in the Keychain."""
    path = home.joinpath(*COPILOT_CONFIG_FILE_REL)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    body = "\n".join(line for line in text.splitlines()
                     if not line.lstrip().startswith("//"))
    try:
        data = json.loads(body)
    except ValueError:
        return None
    user = data.get("lastLoggedInUser") if isinstance(data, dict) else None
    if not isinstance(user, dict):
        return None
    login = user.get("login")
    if not isinstance(login, str) or not login:
        return None
    hostname = COPILOT_DEFAULT_HOST
    host = user.get("host")
    if isinstance(host, str) and host.strip():
        stripped = host.strip().split("://", 1)[-1].split("/", 1)[0]
        hostname = stripped or COPILOT_DEFAULT_HOST
    return {"host": hostname, "login": login}


def read_copilot_hosts_token(home: Path, host: str = COPILOT_DEFAULT_HOST) -> str | None:
    """The VS Code/JetBrains-style Copilot credential fallback:
    ``~/.config/github-copilot/apps.json`` then ``hosts.json``, each a map of
    host key (bare, or suffixed like ``github.com:Iv1.xxx``) -> {oauth_token}.
    Returns the first matching host's token, or None."""
    for rel in COPILOT_HOSTS_FILES_REL:
        try:
            data = json.loads(home.joinpath(*rel).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        for key, entry in data.items():
            if not isinstance(entry, dict) or host not in str(key):
                continue
            token = entry.get("oauth_token")
            if isinstance(token, str) and token:
                return token
    return None


def copilot_env_token(env: dict) -> str | None:
    for key in COPILOT_ENV_KEYS:
        value = env.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def copilot_usage_url(host: str) -> str:
    """github.com -> api.github.com; enterprise hosts use ``api.<host>`` the
    same way (CodexBar's Copilot host mapping)."""
    return f"https://api.{host}/copilot_internal/user"


async def _copilot_gh_token(login: str, host: str) -> str | None:
    """``gh auth token -u <login>`` — gh keeps GitHub OAuth tokens in the
    Keychain and prints them read-only without prompting or rotating anything
    (verified live). None when gh is missing, fails or prints nothing; gh's
    active account may differ from Copilot's, hence the explicit ``--user``."""
    binary = shutil.which("gh")
    if not binary:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, "auth", "token", "--user", login, "--hostname", host,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out = await _communicate_or_kill(proc, timeout=COPILOT_GH_TOKEN_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        return None
    if proc.returncode != 0:
        return None
    token = out.decode("utf-8", "replace").strip()
    return token or None




_COPILOT_QUOTA_KEYS = (
    ("chat", "Chat"),
    ("completions", "Completions"),
    ("premium_interactions", "Premium requests"),
)


def normalize_copilot(data: dict) -> tuple[list[dict], str | None]:
    """``copilot_internal/user``: one monthly window per ``quota_snapshots``
    entry with has_quota=true (usedPercent = 100 - percent_remaining), all
    resetting at ``quota_reset_date_utc``; ``copilot_plan`` -> planType.
    Entitlements without quota (has_quota=false) are skipped."""
    plan = data.get("copilot_plan")
    plan = plan if isinstance(plan, str) and plan else None
    snapshots = data.get("quota_snapshots")
    if not isinstance(snapshots, dict):
        return [], plan
    resets = data.get("quota_reset_date_utc")
    resets = resets if isinstance(resets, str) and resets else None
    windows: list[dict] = []
    for key, label in _COPILOT_QUOTA_KEYS:
        entry = snapshots.get(key)
        if not isinstance(entry, dict) or not entry.get("has_quota"):
            continue
        remaining = _num(entry.get("percent_remaining"))
        if remaining is None:
            continue
        windows.append(_window("monthly", label, 100.0 - remaining, resets))
    return windows, plan




async def fetch_copilot(home: Path, env: dict | None = None) -> dict:
    env = env if env is not None else dict(os.environ)
    config = read_copilot_config(home)
    host = config["host"] if config else COPILOT_DEFAULT_HOST
    token = None
    if config is not None:
        token = await _copilot_gh_token(config["login"], host)
    if token is None:
        token = read_copilot_hosts_token(home, host)
    if token is None:
        token = copilot_env_token(env)
    if token is None:
        return _snapshot("copilot", "no-credentials")
    import httpx

    # This read was once dressed as the VS Code extension — a spoofed
    # ``GitHubCopilotChat/…`` User-Agent plus ``Editor-Version`` headers.
    # Measured 2026-08-05: the endpoint does not gate on any of it, answering
    # 200 to a plain ``User-Agent: Navide`` with the same body. The costume was
    # never load-bearing, so it is gone and the reading stays.
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(copilot_usage_url(host), headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("copilot", "expired")
    if resp.status_code == 429:
        snap = _snapshot("copilot", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("copilot", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("copilot", "error", error="non-JSON response")
    windows, plan = normalize_copilot(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("copilot", "error",
                         error="response had no usable quota fields")
    return _snapshot("copilot", "ok", windows=windows, plan_type=plan)




# ---- resume / session ------------------------------------------------------

# `copilot --resume=<id>` (or `--resume <id>`) resumes when the id exists and
# silently starts a blank NEW session under that UUID when it does not — so
# the id names this pane's session either way and preflight matters.
_RESUME_RE = re.compile(
    r"^copilot\s+(?:\S+\s+)*--resume(?:=(\S+)|\s+([^-\s]\S*))"
)


def _resume_id_from_command(command) -> str:
    """Session id from a `copilot ... --resume=<id>` / `--resume <id>`
    command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return (m.group(1) or m.group(2)) if m else ""


def _session_path(workspace_path: str, session_id: str) -> Path:
    # Sessions live at <root>/session-state/<id>/events.jsonl, so the id
    # alone names the path. A stale id would not fail — it silently starts a
    # blank NEW session under that UUID — which is why preflight matters.
    return copilot_root() / "session-state" / session_id / "events.jsonl"


# ---- vendor spec -----------------------------------------------------------

SPEC = VendorSpec(
    key="copilot",
    label="Copilot CLI",
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_copilot(home),
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    home_env_vars=("COPILOT_HOME",),
    make_log_reader=CopilotLogReader,
)
