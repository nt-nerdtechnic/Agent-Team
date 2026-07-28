"""Kilo Code CLI conversation reader.

Kilo Code (@kilocode/cli) is an OpenCode fork with the same SQLite schema:
one shared WAL database at <XDG_DATA_HOME|~/.local/share>/kilo/kilo.db with
session / message / part tables (message.data carries per-message tokens and
time.completed; user input text is preserved verbatim in part.data, so the
`at-pane:` kickoff marker lands there). Everything OpencodeLogReader does —
read-only short-lived connections, rowid-watermark incremental parsing with a
streaming-pending list, marker scanning over top-level sessions, has_session
preflight, cache-into-input / reasoning-into-output folding — applies
unchanged, so this reader only re-points the vendor name and db location.

Dev-channel databases (kilo-<channel>.db) are intentionally ignored — only
the stable kilo.db is read. Resume: `kilo --session <ses_…>` / `-s <id>`.
"""

from __future__ import annotations

from .opencode import OpencodeLogReader


class KiloLogReader(OpencodeLogReader):
    vendor: str = "kilo"
    _dir_name: str = "kilo"
    _db_name: str = "kilo.db"
