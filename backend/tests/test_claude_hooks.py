import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from agent_team_backend.claude_hooks import _build_curl_command


def _run_hook(tmp_path, event_kind: str, body: bytes, endpoint: str = "claude"):
    """Run one installed hook command against a one-shot HTTP server.

    Returns (payloads the server received, the command's stdout) — stdout being
    the interesting half, because that is the only channel a CLI reads a hook's
    decision from.
    """
    received: list[bytes] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            received.append(self.rfile.read(length))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = 5
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    port_file = tmp_path / "backend.port"
    port_file.write_text(str(server.server_port), encoding="utf-8")
    payload = '{"hook_event_name":"Stop","session_id":"session-1"}'

    try:
        result = subprocess.run(
            _build_curl_command(str(port_file), event_kind, endpoint=endpoint),
            shell=True,
            input=payload,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
    finally:
        thread.join(timeout=6)
        server.server_close()

    assert received == [payload.encode()]
    return received, result.stdout


def test_stop_hook_puts_the_response_on_stdout_where_the_cli_reads_decisions(tmp_path) -> None:
    """A queued inter-CLI message comes back as the Stop hook's own decision,
    and Claude Code only ever sees it if the hook prints it."""
    decision = b'{"decision":"block","reason":"[Navide MSG] from: builder"}'

    _received, stdout = _run_hook(tmp_path, "stop", decision)

    assert stdout == decision.decode()


def test_other_events_still_discard_the_response(tmp_path) -> None:
    # Their replies are acks, and an unrecognized object on a hook's stdout is
    # reported to the user as a hook error.
    _received, stdout = _run_hook(tmp_path, "pre_tool_use", b'{"ok":true}')

    assert stdout == ""


def test_qwens_stop_hook_keeps_discarding_the_response(tmp_path) -> None:
    # qwen borrows this builder; the decision contract is claude's alone.
    _received, stdout = _run_hook(tmp_path, "stop", b'{"ok":true}', endpoint="qwen")

    assert stdout == ""
