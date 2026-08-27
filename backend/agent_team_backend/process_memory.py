"""Real memory footprint of the CLI processes Navide runs.

`ps` RSS is the obvious source and the wrong one: it counts shared pages once
per process, which over-reports a fleet of same-binary CLIs by a wide margin
(measured at ~40% for a screenful of `claude` processes). macOS exposes the
number the kernel actually charges a process — `phys_footprint` — and that is
what a user comparing our figure against Activity Monitor will see.

That counter is read straight from the kernel through `proc_pid_rusage` (see
`proc_rusage`), which costs a syscall per pid and cannot time out. The
`footprint(1)` subprocess it replaced is kept as a fallback for the case where
the syscall cannot be resolved at all: correct, but superlinear in the pid
count, because footprint de-duplicates multiply-mapped regions across every
target it is handed. Measured here, twelve pids took 0.33s and a hundred and
fifty took 16.5s — which is how a busy machine ended up reporting no memory at
all, the sweep having hit its own timeout.
"""

from __future__ import annotations

import logging
import re
import subprocess
import sys

from . import proc_rusage

log = logging.getLogger(__name__)

#: `claude [22751]: 64-bit    Footprint: 279692800 B (16384 bytes per page)`
#: The header carries both the pid and the total, so the per-region table that
#: follows it can be ignored entirely.
_HEADER_RE = re.compile(r"\[(\d+)\]:.*?Footprint:\s*(\d+)\s*B", re.IGNORECASE)

#: A sweep of every pane's whole process tree. Generous — the command is fast,
#: but a machine deep in swap (exactly when this panel gets opened) is slow at
#: everything, and a timeout here must not read as "no memory in use".
_SWEEP_TIMEOUT_S = 20.0

#: Beyond this many pids the sweep is skipped rather than run: the panel is a
#: summary, not an audit. The syscall path is linear and would cope with far
#: more, but the fallback builds an argv out of these and should not be handed
#: an unbounded one.
_MAX_PIDS = 4000


def available() -> bool:
    """Whether footprint can be expected to work at all.

    Darwin-only; every other platform gets the panel's "not available" state
    rather than a wrong number from a fallback that measures something else.
    """
    return sys.platform == "darwin"


def footprints(pids: list[int]) -> dict[int, int]:
    """phys_footprint in bytes, per pid. Missing pids are simply absent.

    Never raises: a panel that cannot measure shows nothing, which is honest,
    while an exception here would take down the request that asked.
    """
    if not available() or not pids:
        return {}
    unique = sorted({p for p in pids if p > 0})
    if not unique or len(unique) > _MAX_PIDS:
        if unique:
            log.info("footprint sweep skipped: %d pids over the cap", len(unique))
        return {}
    sampled = proc_rusage.sample(unique)
    if sampled:
        return {pid: bytes_ for pid, (bytes_, _cpu) in sampled.items()}
    # Either the syscall is unavailable on this build, or every target died
    # between the caller listing them and the sweep. The subprocess path
    # answers both the same way it always did.
    if proc_rusage.available():
        return {}
    try:
        proc = subprocess.run(
            ["footprint", "-f", "bytes", *[str(p) for p in unique]],
            capture_output=True,
            text=True,
            timeout=_SWEEP_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as err:
        log.info("footprint sweep failed: %s", err)
        return {}
    # A non-zero exit is normal when some pids died mid-sweep; whatever printed
    # before that is still valid, so the output is parsed either way.
    out: dict[int, int] = {}
    for match in _HEADER_RE.finditer(proc.stdout or ""):
        try:
            out[int(match.group(1))] = int(match.group(2))
        except ValueError:
            continue
    return out


def sum_by_group(groups: dict[str, list[int]], measured: dict[int, int]) -> dict[str, int]:
    """Total each group's pids.

    A pane is a tree — the PTY child is a shell, and the CLI, its MCP servers
    and anything else it spawned hang below it — so the number a user reads
    next to a pane name has to be the whole tree, not the shell that happens to
    own the tty.
    """
    return {
        key: sum(measured.get(pid, 0) for pid in pids)
        for key, pids in groups.items()
    }
