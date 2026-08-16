"""Single-writer invariant: only Session.send_json may touch the raw websocket.

The websockets protocol forbids concurrent writes on one connection — two
coroutines hitting drain() together trip its waiter assertion and wedge the
socket permanently (see the pitfall comment on Session._send_lock in app.py).
Session.send_json serializes every outbound frame behind that lock, so it must
stay the ONLY call site of a raw websocket send method on that connection. This
test scans the backend source and fails if a raw send appears anywhere else;
new code must route through session.send_json() instead.

The backend also dials *out* to Navide-Server (server_link.py). That is a
different socket, but the same protocol hazard, so it follows the same rule:
one method behind one lock, listed below alongside Session.send_json.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1] / "agent_team_backend"

RAW_SEND_RE = re.compile(r"\b(?:websocket|ws)\.send(?:_json|_text|_bytes)?\(")

#: file name -> (class, method) allowed to touch a raw websocket, one per
#: connection kind. Adding an entry means committing that method to the
#: single-writer discipline (serialize every frame behind a lock).
SINGLE_WRITERS = {
    "app.py": ("Session", "send_json"),
    "server_link.py": ("ServerLink", "_send_frame"),
}


def _method_span(source: str, class_name: str, method_name: str) -> tuple[int, int]:
    """Line span (inclusive) of one method's body."""
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            for item in node.body:
                if (
                    isinstance(item, (ast.AsyncFunctionDef, ast.FunctionDef))
                    and item.name == method_name
                ):
                    return item.lineno, item.end_lineno or item.lineno
    raise AssertionError(f"{class_name}.{method_name} not found")


def test_only_session_send_json_touches_the_raw_websocket() -> None:
    offenders: list[str] = []
    for path in sorted(PACKAGE_DIR.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        writer = SINGLE_WRITERS.get(path.name)
        allowed_span = _method_span(source, *writer) if writer else None
        for lineno, line in enumerate(source.splitlines(), start=1):
            if not RAW_SEND_RE.search(line):
                continue
            if allowed_span and allowed_span[0] <= lineno <= allowed_span[1]:
                continue
            offenders.append(f"{path.relative_to(PACKAGE_DIR)}:{lineno}: {line.strip()}")
    assert not offenders, (
        "Raw websocket send outside Session.send_json — route it through "
        "session.send_json() (single-writer invariant):\n" + "\n".join(offenders)
    )
