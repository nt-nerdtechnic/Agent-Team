"""Push delivery: spawn wiring, the three transports, and their failure modes."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from agent_team_backend import push_delivery
from agent_team_backend.cli_vendors.base import PushChannel

HTTP_CHANNEL = PushChannel(
    holds_input_box=True,
    port_flag="--port",
    host_flag="--hostname",
    append_path="/tui/append-prompt",
    submit_path="/tui/submit-prompt",
    clear_path="/tui/clear-prompt",
)
FILE_CHANNEL = PushChannel(
    holds_input_box=False,
    input_file_flag="--input-file",
    record_type="submit",
)
HOOK_CHANNEL = PushChannel(holds_input_box=False, hook_wait=True)


@pytest.fixture(autouse=True)
def _clean() -> None:
    push_delivery._reset_for_test()
    yield
    push_delivery._reset_for_test()


@pytest.fixture
def runtime_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(push_delivery, "runtime_dir", lambda kind: tmp_path / kind)
    return tmp_path


def _use(monkeypatch: pytest.MonkeyPatch, channel: PushChannel | None) -> None:
    monkeypatch.setattr(push_delivery, "channel_for", lambda agent_key: channel)


# ── spawn wiring ────────────────────────────────────────────────────────────
def test_no_channel_leaves_the_command_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, None)
    command, state = push_delivery.wire_spawn("cursor", ["zsh", "-lc", "cursor"], "p1", {})
    assert command == ["zsh", "-lc", "cursor"]
    assert state is None
    assert push_delivery.get("p1") is None


def test_http_channel_appends_a_free_port(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, HTTP_CHANNEL)
    command, state = push_delivery.wire_spawn("opencode", ["zsh", "-lc", "opencode"], "p1", {})
    assert state is not None and state.port > 0
    assert command[:2] == ["zsh", "-lc"]
    assert command[2] == f"opencode --port {state.port} --hostname 127.0.0.1"
    assert push_delivery.is_ready("p1")


def test_http_channel_respects_a_port_the_user_supplied(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use(monkeypatch, HTTP_CHANNEL)
    command, state = push_delivery.wire_spawn(
        "opencode", ["zsh", "-lc", "opencode --port 4096"], "p1", {}
    )
    assert command == ["zsh", "-lc", "opencode --port 4096"]
    assert state is None


def test_http_channel_sets_a_password_only_when_the_vendor_declares_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use(monkeypatch, HTTP_CHANNEL)
    env: dict[str, str] = {}
    push_delivery.wire_spawn("opencode", "opencode", "p1", env)
    assert env == {}

    push_delivery._reset_for_test()
    _use(monkeypatch, PushChannel(**{**HTTP_CHANNEL.__dict__, "password_env": "PW", "username": "u"}))
    env = {}
    _, state = push_delivery.wire_spawn("kilo", "kilo", "p2", env)
    assert state is not None
    assert env["PW"] == state.password
    assert len(state.password) > 16


def test_file_channel_creates_an_empty_per_pane_file(
    monkeypatch: pytest.MonkeyPatch, runtime_root: Path
) -> None:
    _use(monkeypatch, FILE_CHANNEL)
    command, state = push_delivery.wire_spawn("qwen", ["zsh", "-lc", "qwen"], "p1", {})
    assert state is not None
    path = Path(state.input_file)
    assert path.is_file() and path.stat().st_size == 0
    assert path.name == "p1.jsonl"
    assert command[2] == f"qwen --input-file {state.input_file}"


def test_file_channel_truncates_a_previous_pane_run(
    monkeypatch: pytest.MonkeyPatch, runtime_root: Path
) -> None:
    _use(monkeypatch, FILE_CHANNEL)
    _, first = push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert first is not None
    Path(first.input_file).write_text("stale\n", encoding="utf-8")
    push_delivery.forget_pane("p1")
    _, second = push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert second is not None
    assert Path(second.input_file).stat().st_size == 0


def test_hook_channel_wires_nothing_at_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, HOOK_CHANNEL)
    command, state = push_delivery.wire_spawn("claude", ["zsh", "-lc", "claude"], "p1", {})
    assert command == ["zsh", "-lc", "claude"]
    assert state is not None and state.kind == push_delivery.KIND_HOOK
    # Registered, but not ready: nothing is parked on it yet.
    assert not push_delivery.is_ready("p1")


def test_wire_spawn_needs_a_pane_id(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, HTTP_CHANNEL)
    command, state = push_delivery.wire_spawn("opencode", "opencode", "", {})
    assert command == "opencode"
    assert state is None


# ── delivery ────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_push_to_an_unknown_pane_reports_no_channel() -> None:
    assert await push_delivery.deliver("nope", "hi") == (False, "no-channel")


@pytest.mark.asyncio
async def test_file_push_appends_one_json_line(
    monkeypatch: pytest.MonkeyPatch, runtime_root: Path
) -> None:
    _use(monkeypatch, FILE_CHANNEL)
    _, state = push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert state is not None
    assert await push_delivery.deliver("p1", "[Navide MSG] from: a\nbody") == (True, "")
    assert await push_delivery.deliver("p1", "second") == (True, "")
    lines = Path(state.input_file).read_text(encoding="utf-8").splitlines()
    assert [json.loads(line) for line in lines] == [
        {"type": "submit", "text": "[Navide MSG] from: a\nbody"},
        {"type": "submit", "text": "second"},
    ]


@pytest.mark.asyncio
async def test_file_push_never_truncates(
    monkeypatch: pytest.MonkeyPatch, runtime_root: Path
) -> None:
    """A watcher that sees the file shrink re-reads it from the start."""
    _use(monkeypatch, FILE_CHANNEL)
    _, state = push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert state is not None
    await push_delivery.deliver("p1", "one")
    size = Path(state.input_file).stat().st_size
    await push_delivery.deliver("p1", "two")
    assert Path(state.input_file).stat().st_size > size


@pytest.mark.asyncio
async def test_file_push_fails_when_the_file_is_gone(
    monkeypatch: pytest.MonkeyPatch, runtime_root: Path
) -> None:
    _use(monkeypatch, FILE_CHANNEL)
    _, state = push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert state is not None
    os.unlink(state.input_file)
    os.rmdir(Path(state.input_file).parent)
    assert await push_delivery.deliver("p1", "hi") == (False, "push-error")


@pytest.mark.asyncio
async def test_hook_push_needs_an_armed_waiter(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, HOOK_CHANNEL)
    push_delivery.wire_spawn("claude", "claude", "p1", {})
    assert await push_delivery.deliver("p1", "hi") == (False, "not-armed")

    armed = push_delivery.arm_hook("p1")
    assert armed is not None
    request_id, future = armed
    assert push_delivery.is_ready("p1")
    waiting = asyncio.create_task(push_delivery.wait_for_hook("p1", request_id, future))
    await asyncio.sleep(0)
    assert await push_delivery.deliver("p1", "envelope") == (True, "")
    assert await waiting == "envelope"
    # Consumed: the next message has nothing to hand to.
    assert await push_delivery.deliver("p1", "again") == (False, "not-armed")


@pytest.mark.asyncio
async def test_re_arming_releases_the_previous_waiter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The CLI re-arms on several events; only the newest waiter is answered."""
    _use(monkeypatch, HOOK_CHANNEL)
    push_delivery.wire_spawn("claude", "claude", "p1", {})
    first = push_delivery.arm_hook("p1")
    assert first is not None
    first_wait = asyncio.create_task(push_delivery.wait_for_hook("p1", *first))
    await asyncio.sleep(0)
    second = push_delivery.arm_hook("p1")
    assert second is not None
    second_wait = asyncio.create_task(push_delivery.wait_for_hook("p1", *second))
    await asyncio.sleep(0)
    assert await first_wait == ""
    assert await push_delivery.deliver("p1", "envelope") == (True, "")
    assert await second_wait == "envelope"


@pytest.mark.asyncio
async def test_forgetting_a_pane_releases_its_waiter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use(monkeypatch, HOOK_CHANNEL)
    push_delivery.wire_spawn("claude", "claude", "p1", {})
    armed = push_delivery.arm_hook("p1")
    assert armed is not None
    waiting = asyncio.create_task(push_delivery.wait_for_hook("p1", *armed))
    await asyncio.sleep(0)
    push_delivery.forget_pane("p1")
    assert await waiting == ""
    assert not push_delivery.is_ready("p1")


@pytest.mark.asyncio
async def test_forgetting_a_pane_removes_its_watch_file(
    monkeypatch: pytest.MonkeyPatch, runtime_root: Path
) -> None:
    _use(monkeypatch, FILE_CHANNEL)
    _, state = push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert state is not None
    push_delivery.forget_pane("p1")
    assert not Path(state.input_file).exists()


@pytest.mark.asyncio
async def test_empty_text_is_never_pushed(
    monkeypatch: pytest.MonkeyPatch, runtime_root: Path
) -> None:
    _use(monkeypatch, FILE_CHANNEL)
    push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert await push_delivery.deliver("p1", "") == (False, "empty")


# ── the HTTP transport, against a real server ───────────────────────────────
class _FakeTui:
    """A stand-in for the CLI's own HTTP server, on a real loopback socket."""

    def __init__(
        self,
        *,
        submit_status: int = 200,
        append_status: int = 200,
        submit_drops: bool = False,
    ) -> None:
        self.submit_status = submit_status
        self.append_status = append_status
        #: Close the connection on submit without answering, which is what a
        #: TUI going away mid-push looks like from the client side.
        self.submit_drops = submit_drops
        self.appended: list[str] = []
        self.submits = 0
        self.clears = 0
        self.auth: list[str | None] = []
        self.port = 0
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        path = lines[0].split(" ")[1]
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                name, _, value = line.partition(":")
                headers[name.strip().lower()] = value.strip()
        body = b""
        length = int(headers.get("content-length", "0") or 0)
        if length:
            body = await reader.readexactly(length)
        self.auth.append(headers.get("authorization"))
        status = 200
        if path.endswith("/append-prompt"):
            status = self.append_status
            if status < 400:
                self.appended.append(json.loads(body)["text"])
        elif path.endswith("/submit-prompt"):
            if self.submit_drops:
                writer.close()
                return
            status = self.submit_status
            if status < 400:
                self.submits += 1
        elif path.endswith("/clear-prompt"):
            self.clears += 1
        payload = b"true"
        writer.write(
            f"HTTP/1.1 {status} X\r\nContent-Length: {len(payload)}\r\n"
            "Content-Type: application/json\r\nConnection: close\r\n\r\n".encode()
            + payload
        )
        await writer.drain()
        writer.close()


async def _registered_http(tui: _FakeTui, *, password: str = "") -> None:
    channel = HTTP_CHANNEL if not password else PushChannel(
        **{**HTTP_CHANNEL.__dict__, "password_env": "PW", "username": "kilo"}
    )
    push_delivery._panes["p1"] = push_delivery.PaneChannel(
        pane_id="p1",
        agent_key="opencode",
        kind=push_delivery.KIND_HTTP,
        channel=channel,
        port=tui.port,
        password=password,
    )


@pytest.mark.asyncio
async def test_http_push_appends_then_submits() -> None:
    tui = _FakeTui()
    await tui.start()
    try:
        await _registered_http(tui)
        assert await push_delivery.deliver("p1", "[Navide MSG] hi") == (True, "")
        assert tui.appended == ["[Navide MSG] hi"]
        assert tui.submits == 1
        assert tui.clears == 0
        assert tui.auth == [None, None]
    finally:
        await tui.stop()


@pytest.mark.asyncio
async def test_http_push_sends_basic_auth_when_the_pane_has_a_password() -> None:
    tui = _FakeTui()
    await tui.start()
    try:
        await _registered_http(tui, password="s3cret")
        assert await push_delivery.deliver("p1", "hi") == (True, "")
        assert all(a and a.startswith("Basic ") for a in tui.auth)
    finally:
        await tui.stop()


@pytest.mark.asyncio
async def test_http_push_reports_a_rejected_append_without_submitting() -> None:
    tui = _FakeTui(append_status=401)
    await tui.start()
    try:
        await _registered_http(tui)
        assert await push_delivery.deliver("p1", "hi") == (False, "append-401")
        assert tui.submits == 0
    finally:
        await tui.stop()


@pytest.mark.asyncio
async def test_http_push_clears_the_composer_when_the_submit_fails() -> None:
    """Otherwise the typed fallback would submit the envelope twice over."""
    tui = _FakeTui(submit_status=500)
    await tui.start()
    try:
        await _registered_http(tui)
        assert await push_delivery.deliver("p1", "hi") == (False, "submit-500")
        assert tui.appended == ["hi"]
        assert tui.clears == 1
    finally:
        await tui.stop()


# ── flag detection, sweeping, and the user's switches ───────────────────────
def test_a_lookalike_flag_is_not_mistaken_for_the_real_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`--portable` contains `--port`. A substring test would read it as "the
    user wired this themselves" and leave the pane without a channel."""
    _use(monkeypatch, HTTP_CHANNEL)
    _, state = push_delivery.wire_spawn(
        "opencode", ["zsh", "-lc", "opencode --portable --port-forward"], "p1", {}
    )
    assert state is not None and state.port > 0


def test_an_equals_form_flag_counts_as_the_users_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use(monkeypatch, HTTP_CHANNEL)
    _, state = push_delivery.wire_spawn(
        "opencode", ["zsh", "-lc", "opencode --port=4096"], "p1", {}
    )
    assert state is None


def test_an_unparseable_command_still_finds_the_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unbalanced quote would not run anyway; guessing wrong there must not
    take out the check itself."""
    _use(monkeypatch, HTTP_CHANNEL)
    _, state = push_delivery.wire_spawn(
        "opencode", ["zsh", "-lc", "opencode --port 4096 'unclosed"], "p1", {}
    )
    assert state is None


def test_startup_sweep_removes_watch_files_a_killed_backend_left(
    runtime_root: Path,
) -> None:
    """They hold message text in the clear and their panes died with the
    previous process, so nothing but this ever removes them."""
    directory = push_delivery.runtime_dir(push_delivery.KIND_FILE)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "old-pane.jsonl").write_text('{"type":"submit","text":"secret"}\n')
    (directory / "another.jsonl").write_text("\n")
    assert push_delivery.sweep_runtime_files() == 2
    assert list(directory.iterdir()) == []


def test_startup_sweep_is_fine_with_no_directory(runtime_root: Path) -> None:
    assert push_delivery.sweep_runtime_files() == 0


def test_a_switched_off_vendor_is_wired_and_pushed_to_no_more(
    runtime_root: Path,
) -> None:
    push_delivery.set_disabled_reader(lambda: {"qwen"})
    try:
        command, state = push_delivery.wire_spawn("qwen", ["zsh", "-lc", "qwen"], "p1", {})
        assert command == ["zsh", "-lc", "qwen"]
        assert state is None
    finally:
        push_delivery.set_disabled_reader(None)


@pytest.mark.asyncio
async def test_switching_a_vendor_off_stops_an_already_running_pane(
    runtime_root: Path,
) -> None:
    """A pane keeps its watch file, but nothing is pushed to it any more —
    without the pane having to be restarted."""
    _, state = push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert state is not None
    assert await push_delivery.deliver("p1", "hi") == (True, "")
    push_delivery.set_disabled_reader(lambda: {"qwen"})
    try:
        assert not push_delivery.is_ready("p1")
        assert await push_delivery.deliver("p1", "hi") == (False, "no-channel")
        assert push_delivery.apply_switches() == [("p1", push_delivery.KIND_FILE, False)]
    finally:
        push_delivery.set_disabled_reader(None)
    # ...and switching it back on makes the same pane usable again.
    assert push_delivery.apply_switches() == [("p1", push_delivery.KIND_FILE, True)]
    assert await push_delivery.deliver("p1", "hi") == (True, "")


@pytest.mark.asyncio
async def test_switching_claude_off_releases_a_parked_hook() -> None:
    push_delivery.register_hook_pane("pane-1", "claude")
    armed = push_delivery.arm_hook("pane-1")
    assert armed is not None
    waiting = asyncio.create_task(push_delivery.wait_for_hook("pane-1", *armed))
    await asyncio.sleep(0)
    push_delivery.set_disabled_reader(lambda: {"claude"})
    try:
        push_delivery.apply_switches()
        assert await waiting == ""
        assert push_delivery.arm_hook("pane-1") is None
    finally:
        push_delivery.set_disabled_reader(None)


def test_an_unreadable_switch_setting_leaves_every_channel_on() -> None:
    def boom() -> set[str]:
        raise RuntimeError("store is down")

    push_delivery.set_disabled_reader(boom)
    try:
        assert push_delivery.disabled_agents() == set()
        assert push_delivery.channel_for("qwen") is not None
    finally:
        push_delivery.set_disabled_reader(None)


# ── a waiter whose hook went away ───────────────────────────────────────────
@pytest.mark.asyncio
async def test_discarding_a_waiter_takes_the_channel_with_it() -> None:
    """The hook's connection dropped — `/exit` inside a pane left open. Nothing
    resolved the future, so without this the pane would keep advertising a
    channel and report every message pushed to it as delivered."""
    push_delivery.register_hook_pane("pane-1", "claude")
    armed = push_delivery.arm_hook("pane-1")
    assert armed is not None
    request_id, _ = armed
    assert push_delivery.is_ready("pane-1")
    push_delivery.discard_waiter("pane-1", request_id)
    assert not push_delivery.is_ready("pane-1")
    assert await push_delivery.deliver("pane-1", "hi") == (False, "not-armed")


# ── the vendors that actually declare a channel ─────────────────────────────
def test_opencode_spawn_opens_a_loopback_port_with_no_password() -> None:
    """Verified against opencode 1.15.12: its own TUI cannot authenticate
    against its own server, so a password there kills the pane on startup."""
    env: dict[str, str] = {}
    command, state = push_delivery.wire_spawn(
        "opencode", ["zsh", "-lc", "opencode --auto"], "p1", env
    )
    assert state is not None and state.kind == push_delivery.KIND_HTTP
    assert command[2] == f"opencode --auto --port {state.port} --hostname 127.0.0.1"
    assert state.password == ""
    assert env == {}


def test_kilo_spawn_carries_a_per_pane_password() -> None:
    """Verified against kilo 7.4.22: unauthenticated /tui/* is 401, and unlike
    opencode its TUI does read the variable."""
    env: dict[str, str] = {}
    command, state = push_delivery.wire_spawn("kilo", ["zsh", "-lc", "kilo"], "p1", env)
    assert state is not None and state.kind == push_delivery.KIND_HTTP
    assert command[2] == f"kilo --port {state.port} --hostname 127.0.0.1"
    assert env["KILO_SERVER_PASSWORD"] == state.password != ""
    assert state.channel.username == "kilo"


@pytest.mark.asyncio
async def test_qwen_spawn_watches_an_empty_per_pane_file(runtime_root: Path) -> None:
    """Verified against qwen 0.21.12: the watcher records the file's size when
    it opens it, so anything already in the file is skipped."""
    command, state = push_delivery.wire_spawn("qwen", ["zsh", "-lc", "qwen --yolo"], "p1", {})
    assert state is not None and state.kind == push_delivery.KIND_FILE
    assert command[2] == f"qwen --yolo --input-file {state.input_file}"
    assert Path(state.input_file).stat().st_size == 0
    assert await push_delivery.deliver("p1", "hi") == (True, "")
    assert Path(state.input_file).read_text(encoding="utf-8") == (
        '{"type": "submit", "text": "hi"}\n'
    )


@pytest.mark.asyncio
async def test_qwen_push_writes_a_multi_line_envelope_as_one_record(
    runtime_root: Path,
) -> None:
    """The watcher splits on newlines, so an envelope's own line breaks have to
    survive as JSON escapes rather than as record boundaries."""
    _, state = push_delivery.wire_spawn("qwen", "qwen", "p1", {})
    assert state is not None
    await push_delivery.deliver("p1", "[Navide MSG] from: a\nline two\nline three")
    raw = Path(state.input_file).read_text(encoding="utf-8")
    assert raw.count("\n") == 1
    assert json.loads(raw)["text"].count("\n") == 2


def test_a_vendor_without_a_channel_is_left_alone() -> None:
    command, state = push_delivery.wire_spawn("cursor", ["zsh", "-lc", "agent"], "p1", {})
    assert command == ["zsh", "-lc", "agent"]
    assert state is None


@pytest.mark.asyncio
async def test_http_push_clears_the_composer_when_the_submit_errors() -> None:
    """A submit that never answers leaves exactly the mess a refused one does,
    so it gets the same compensation — otherwise the typed fallback would send
    the envelope twice over, concatenated."""
    tui = _FakeTui(submit_drops=True)
    await tui.start()
    try:
        await _registered_http(tui)
        assert await push_delivery.deliver("p1", "hi") == (False, "submit-error")
        assert tui.appended == ["hi"]
        assert tui.clears == 1
    finally:
        await tui.stop()


@pytest.mark.asyncio
async def test_a_failed_submit_is_the_only_thing_that_leaves_text_behind() -> None:
    """The caller reads this to decide whether it may type the message in, so
    it has to be exactly the cases where our text is still in the composer."""
    assert push_delivery.leaves_text_behind(push_delivery.KIND_HTTP, "submit-500")
    assert push_delivery.leaves_text_behind(push_delivery.KIND_HTTP, "submit-error")
    # Nothing reached the composer in any of these.
    assert not push_delivery.leaves_text_behind(push_delivery.KIND_HTTP, "not-listening")
    assert not push_delivery.leaves_text_behind(push_delivery.KIND_HTTP, "append-401")
    assert not push_delivery.leaves_text_behind(push_delivery.KIND_HTTP, "append-error")
    # And the other two channels have no composer at all.
    assert not push_delivery.leaves_text_behind(push_delivery.KIND_FILE, "push-error")
    assert not push_delivery.leaves_text_behind(push_delivery.KIND_HOOK, "not-armed")


@pytest.mark.asyncio
async def test_http_push_names_a_server_that_is_not_up_yet() -> None:
    """Distinct from a broken channel: this one fixes itself, so the caller
    retries in seconds rather than writing the pane off for a minute."""
    tui = _FakeTui()
    await tui.start()
    port = tui.port
    await tui.stop()
    push_delivery._panes["p1"] = push_delivery.PaneChannel(
        pane_id="p1",
        agent_key="opencode",
        kind=push_delivery.KIND_HTTP,
        channel=HTTP_CHANNEL,
        port=port,
    )
    assert await push_delivery.deliver("p1", "hi") == (False, "not-listening")


# ── the rewake secret ───────────────────────────────────────────────────────
# The hook command is written into the CLI's settings file once, and a pane
# that is already running keeps firing exactly the command it was given. A
# secret that changed with every backend start would refuse every one of those
# hooks, and the only symptom is those panes quietly going back to being typed
# into until their CLI is restarted.
def test_the_rewake_token_is_minted_once_and_kept() -> None:
    first = push_delivery.rewake_token()
    assert first
    assert push_delivery._rewake_token_path().read_text(encoding="utf-8").strip() == first
    # Nothing is cached in the process, so a second call is exactly what a
    # restarted backend does: it reads the file it left behind.
    assert push_delivery.rewake_token() == first


def test_the_rewake_token_file_is_owner_only() -> None:
    push_delivery.rewake_token()
    mode = push_delivery._rewake_token_path().stat().st_mode
    assert mode & 0o077 == 0


def test_a_token_file_left_readable_is_tightened_without_changing_it() -> None:
    """A file written by an older version, or under a wide umask."""
    token = push_delivery.rewake_token()
    path = push_delivery._rewake_token_path()
    path.chmod(0o644)
    assert push_delivery.rewake_token() == token
    assert path.stat().st_mode & 0o077 == 0


def test_a_data_dir_that_cannot_be_written_still_gives_one_stable_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Minting per call would refuse every hook. One token for the process is
    the same thing the backend had before the file existed."""
    def unwritable(*_args: object) -> None:
        raise OSError("read-only file system")

    monkeypatch.setattr(push_delivery, "_write_rewake_token", unwritable)
    assert push_delivery.rewake_token() == push_delivery.rewake_token() != ""
