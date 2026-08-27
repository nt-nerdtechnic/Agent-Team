"""Per-process memory and CPU straight from the kernel, without a subprocess.

`footprint(1)` and `ps(1)` were the first sources for these numbers, and both
turned out to be the wrong shape for a panel that samples on a timer.
`footprint` in particular de-duplicates multiply-mapped regions across every
target it is given, which makes a sweep superlinear in the pid count: measured
here, twelve pids took 0.33s and a hundred and fifty took 16.5s — past the
20s timeout, so a machine busy enough to be worth looking at was exactly the
one that could not be measured.

`proc_pid_rusage` is where both numbers come from in the first place.
`ri_phys_footprint` is the same counter `footprint` prints (verified
byte-for-byte against it), and `ri_user_time + ri_system_time` matches `ps -o
time=` once converted out of mach time units. One syscall per pid, no argv, no
fork, no timeout: a sweep of a hundred and fifty pids costs about a
millisecond.

Darwin only — every caller already has a subprocess path for other platforms.
"""

from __future__ import annotations

import ctypes
import logging
import sys

log = logging.getLogger(__name__)

#: `RUSAGE_INFO_V0`, the oldest flavor and the only one this needs. Every macOS
#: that has the call at all supports it, and both fields live in V0.
_RUSAGE_INFO_V0 = 0


class _RUsageInfoV0(ctypes.Structure):
    """`struct rusage_info_v0` from <sys/resource.h>, field for field."""

    _fields_ = [
        ("ri_uuid", ctypes.c_uint8 * 16),
        ("ri_user_time", ctypes.c_uint64),
        ("ri_system_time", ctypes.c_uint64),
        ("ri_pkg_idle_wkups", ctypes.c_uint64),
        ("ri_interrupt_wkups", ctypes.c_uint64),
        ("ri_pageins", ctypes.c_uint64),
        ("ri_wired_size", ctypes.c_uint64),
        ("ri_resident_size", ctypes.c_uint64),
        ("ri_phys_footprint", ctypes.c_uint64),
        ("ri_proc_start_abstime", ctypes.c_uint64),
        ("ri_proc_exit_abstime", ctypes.c_uint64),
    ]


class _MachTimebaseInfo(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


def _load() -> tuple[object, float] | None:
    """(libSystem, nanoseconds per mach time unit), or None where unavailable.

    `CDLL(None)` resolves against the symbols already loaded into this process
    rather than a path on disk, so it keeps working inside the PyInstaller
    bundle, where libSystem is present but `find_library` has no SDK to search.
    """
    if sys.platform != "darwin":
        return None
    try:
        lib = ctypes.CDLL(None)
        lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        lib.proc_pid_rusage.restype = ctypes.c_int
        timebase = _MachTimebaseInfo()
        lib.mach_timebase_info(ctypes.byref(timebase))
    except (OSError, AttributeError) as err:  # pragma: no cover - platform specific
        log.info("proc_pid_rusage unavailable: %s", err)
        return None
    if timebase.denom == 0:  # pragma: no cover - kernel would have to lie
        return None
    return lib, timebase.numer / timebase.denom


#: Resolved once. `None` means "use the subprocess path"; the tuple means the
#: syscall is live. Module-level so the cost is paid at import, not per sweep.
_LOADED = _load()


def available() -> bool:
    """Whether the syscall path can be used at all."""
    return _LOADED is not None


def sample(pids: list[int]) -> dict[int, tuple[int, float]]:
    """{pid: (phys_footprint bytes, accumulated CPU seconds)} for what answered.

    A pid that has died, or that belongs to another user, simply does not
    appear — the same contract the subprocess sweeps had, so callers that
    already tolerate a missing pid need no new branch.

    Never raises: a panel that cannot measure shows nothing, which is honest,
    while an exception here would take down the request that asked.
    """
    if _LOADED is None or not pids:
        return {}
    lib, ns_per_unit = _LOADED
    out: dict[int, tuple[int, float]] = {}
    info = _RUsageInfoV0()
    for pid in pids:
        if pid <= 0:
            continue
        try:
            rc = lib.proc_pid_rusage(pid, _RUSAGE_INFO_V0, ctypes.byref(info))
        except (OSError, ValueError):  # pragma: no cover - ctypes marshalling
            continue
        # Non-zero is the normal answer for a pid that exited mid-sweep or that
        # this process may not inspect; there is nothing to report either way.
        if rc != 0:
            continue
        cpu_units = info.ri_user_time + info.ri_system_time
        out[pid] = (int(info.ri_phys_footprint), cpu_units * ns_per_unit / 1e9)
    return out
