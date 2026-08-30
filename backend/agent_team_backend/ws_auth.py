"""Who may open the local ``/ws`` socket.

The endpoint binds to 127.0.0.1, which stops the network but not the browser:
a WebSocket handshake is **not** subject to the same-origin policy, so any page
the user happens to visit can open ``ws://127.0.0.1:<port>/ws``, scanning the
ephemeral range until something answers. Until now that socket accepted the
connection and went straight into its dispatch loop, and one of the messages it
dispatches is ``terminal.create`` with a caller-supplied ``command`` and
``env``. That is arbitrary code execution as the user, reachable from a web
page, with no cloud service involved at all.

The fix is a credential the browser cannot obtain. A page can guess the port —
there are only so many — but it cannot read a file, and that asymmetry is the
whole defence:

* the backend mints a fresh token per run and writes it 0600 beside the
  port file;
* Electron's main process reads it and folds it into the ``wsUrl`` it already
  hands to every window and to the plugin broker, so no client had to learn a
  new mechanism;
* a caller with no token, or the wrong one, is closed before any message is
  read.

Two smaller decisions worth writing down.

*The token is minted per run rather than persisted.* A token that outlived the
process would still be sitting in a file when the next one started, and every
client already re-reads the port after a restart — so there is nothing to gain
by keeping it and one more stale secret to lose.

*The Origin check is second, not first.* It refuses a handshake that carries a
web origin, which is what a hostile page would send; it deliberately does not
refuse a missing or ``file://`` origin, because that is what Electron's own
renderers send and guessing wrong there would look like "the backend will not
start". The token is what actually closes the hole. This only makes the hostile
case fail earlier and more legibly in the log.
"""

from __future__ import annotations

import logging
import os
import secrets
import stat
from urllib.parse import urlsplit

from agent_team_backend.applog import backend_ws_token_file

log = logging.getLogger(__name__)

#: Close code for a refused handshake. In the application range (4000-4999) so
#: it cannot be confused with a transport-level close, and distinct from the
#: 4001 the renderer already knows, which means something else entirely.
WS_UNAUTHORIZED = 4403

_token: str = ""


def issue_token() -> str:
    """Mint this run's token and write it beside the port file, owner-only.

    Written via ``os.open`` with the mode set at creation rather than a
    write-then-chmod: the gap between the two is a window in which the secret
    exists at whatever the umask allowed. That is exactly the mistake the port
    file makes today (0644), and the reason this is a separate file.
    """
    global _token
    _token = secrets.token_urlsafe(32)
    path = backend_ws_token_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.S_IRUSR | stat.S_IWUSR)
        try:
            os.write(fd, _token.encode("utf-8"))
        finally:
            os.close(fd)
        # A file that already existed keeps its old mode through O_CREAT.
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        log.info("wrote the ws token to %s", path)
    except OSError as err:
        # Fail loudly rather than silently running without a credential: an
        # unwritable token file means every client is about to be refused, and
        # "nothing can connect" is far easier to diagnose than "the socket is
        # open to anyone".
        log.error("could not write the ws token file: %s", err)
        raise
    return _token


def current_token() -> str:
    return _token


def _hostile_origin(origin: str) -> bool:
    """Whether this Origin belongs to a web page rather than to the app.

    Electron's renderers send ``file://`` when packaged and the dev-server
    origin when not, and some clients send nothing at all — none of those are
    refused. A page served over http(s) from anywhere other than loopback is
    not one of ours.
    """
    if not origin:
        return False
    parts = urlsplit(origin)
    if parts.scheme not in ("http", "https"):
        return False
    return parts.hostname not in ("127.0.0.1", "localhost", "::1")


def check(token: str, origin: str) -> str:
    """Empty when the handshake may proceed, else a short reason for the log.

    Compared with ``compare_digest`` because the obvious loop leaks the length
    of the shared prefix through timing, and a local attacker is precisely the
    one who can measure that.
    """
    if _hostile_origin(origin):
        return f"origin {origin!r} is a web page"
    if not _token:
        return "the backend has no token yet"
    if not token or not secrets.compare_digest(token, _token):
        return "missing or invalid token"
    return ""


def _reset_for_test(token: str = "") -> None:
    global _token
    _token = token
