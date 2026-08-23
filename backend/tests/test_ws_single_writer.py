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

#: file name -> [(class or None, function)] allowed to touch a raw websocket.
#: Adding an entry means committing that function to the single-writer
#: discipline: every frame it sends is serialized behind a lock, OR it owns its
#: connection outright so no second writer can exist.
#:
#: A None class means a module-level function. There is exactly one, and it is
#: the second kind: `account_request` opens its own connection, sends one frame,
#: reads the reply and closes. Nothing else is ever handed that socket, so the
#: concurrent-write hazard this test exists to prevent cannot arise — the lock
#: on ServerLink._send_frame protects the *shared, long-lived* link, which this
#: call deliberately does not use (it runs before a token exists, so that link
#: is not connected yet).
SINGLE_WRITERS = {
    "app.py": [("Session", "send_json")],
    "server_link.py": [("ServerLink", "_send_frame"), (None, "account_request")],
}


def _spans(source: str, writers: list[tuple[str | None, str]]) -> list[tuple[int, int]]:
    """Line spans (inclusive) of each allowed function body."""
    tree = ast.parse(source)
    found: list[tuple[int, int]] = []
    for class_name, func_name in writers:
        for node in ast.walk(tree):
            if class_name is None:
                # Module level only: a same-named method must not grant a pass.
                container: list = tree.body
            elif isinstance(node, ast.ClassDef) and node.name == class_name:
                container = node.body
            else:
                continue
            for item in container:
                if (
                    isinstance(item, (ast.AsyncFunctionDef, ast.FunctionDef))
                    and item.name == func_name
                ):
                    found.append((item.lineno, item.end_lineno or item.lineno))
                    break
            else:
                continue
            break
        else:
            raise AssertionError(f"{class_name or '<module>'}.{func_name} not found")
    return found


def test_only_session_send_json_touches_the_raw_websocket() -> None:
    offenders: list[str] = []
    for path in sorted(PACKAGE_DIR.rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        writers = SINGLE_WRITERS.get(path.name)
        allowed = _spans(source, writers) if writers else []
        for lineno, line in enumerate(source.splitlines(), start=1):
            if not RAW_SEND_RE.search(line):
                continue
            if any(start <= lineno <= end for start, end in allowed):
                continue
            offenders.append(f"{path.relative_to(PACKAGE_DIR)}:{lineno}: {line.strip()}")
    assert not offenders, (
        "Raw websocket send outside Session.send_json — route it through "
        "session.send_json() (single-writer invariant):\n" + "\n".join(offenders)
    )
