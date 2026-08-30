from __future__ import annotations

import argparse
import logging
import sys

import socket

import uvicorn

from . import __version__
from .app import app as _fastapi_app
from . import ws_auth
from .applog import backend_port_file, setup_file_logging


def main() -> int:
    parser = argparse.ArgumentParser(prog="navide-backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 = pick a free port")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("agent_team_backend")
    log_file = setup_file_logging(args.log_level)
    log.info("starting backend version=%s", __version__)
    log.info("backend log file: %s", log_file)
    print(f"AGENT_TEAM_BACKEND_LOG path={log_file}", flush=True)

    # When --port=0, resolve to an actual free port BEFORE handing to uvicorn so
    # we can write the port file (Claude hooks rely on it being available
    # before the server starts accepting).
    resolved_port = args.port
    if resolved_port == 0:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind((args.host, 0))
            resolved_port = s.getsockname()[1]
        log.info("resolved free port: %d", resolved_port)

    # Write the current port to a discovery file so Claude hooks (installed
    # globally in ~/.claude/settings.json) can find us. Best-effort.
    try:
        port_path = backend_port_file()
        port_path.parent.mkdir(parents=True, exist_ok=True)
        port_path.write_text(str(resolved_port), encoding="utf-8")
        log.info("wrote backend port to %s", port_path)
    except OSError as err:
        log.warning("could not write port-file: %s", err)

    # The credential for that port. Separate file, 0600, minted fresh each run:
    # the port above is written world-readable on purpose (a shell hook resolves
    # it with `cat`), and a secret must not inherit that. Unlike the port this
    # is not best-effort — a backend that cannot write it would accept nobody,
    # and failing here says so instead of leaving that to every client.
    ws_auth.issue_token()

    # Use the already-imported app object so PyInstaller can detect this
    # dependency statically (string-based import is invisible to the bundler).
    config = uvicorn.Config(
        _fastapi_app,
        host=args.host,
        port=resolved_port,
        log_level=args.log_level,
        access_log=False,
        # Terminal output dominates this socket: many panes, each emitting
        # frames up to 64 KB. Deflating every one of them runs zlib on the
        # event loop, and everything else -- including the heartbeat pong --
        # waits behind that. The traffic is loopback, so the bytes saved buy
        # nothing.
        ws_per_message_deflate=False,
        # Be explicit about the protocol-level heartbeat rather than inheriting
        # 20s/20s. Under heavy PTY output a send can stall for seconds, and a
        # tight server-side timeout closes connections that are busy, not dead.
        ws_ping_interval=20.0,
        ws_ping_timeout=60.0,
    )
    server = uvicorn.Server(config)

    log.info("listening on http://%s:%s", args.host, resolved_port)
    print(f"AGENT_TEAM_BACKEND_LISTEN host={args.host} port={resolved_port}", flush=True)

    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
