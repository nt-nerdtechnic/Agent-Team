"""Parser and write-back guard tests for the executions service.

Every test stubs ``_run`` — the real crontab/launchctl must never be touched —
and the fixture below redirects all three launchd directories into tmp_path, so
no test can read (let alone write) the machine's real plists.
"""

from __future__ import annotations

import plistlib

import pytest

from agent_team_backend import executions_service as svc


@pytest.fixture(autouse=True)
def isolate_launchd_dirs(tmp_path_factory, monkeypatch):
    """Point every scanned directory at an empty tmp dir.

    Autouse so a test that forgets one of the three still cannot reach
    ``~/Library/LaunchAgents``, ``/Library/LaunchAgents`` or
    ``/Library/LaunchDaemons``. Tests that need content override the ones they
    care about — their own ``monkeypatch`` calls run after this fixture's.
    """
    root = tmp_path_factory.mktemp("launchd-isolation")
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: root / "user")
    monkeypatch.setattr(svc, "_system_launch_agents_dir", lambda: root / "system-agents")
    monkeypatch.setattr(svc, "_system_launch_daemons_dir", lambda: root / "system-daemons")
    return root


def _scoped_dirs(monkeypatch, tmp_path):
    """Create and install the three launchd directories under ``tmp_path``."""
    user = tmp_path / "user"
    system_agents = tmp_path / "system-agents"
    system_daemons = tmp_path / "system-daemons"
    for directory in (user, system_agents, system_daemons):
        directory.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: user)
    monkeypatch.setattr(svc, "_system_launch_agents_dir", lambda: system_agents)
    monkeypatch.setattr(svc, "_system_launch_daemons_dir", lambda: system_daemons)
    return user, system_agents, system_daemons


def _stub_run(monkeypatch, responses):
    """Install a ``_run`` stub; returns the list of recorded argv calls.

    ``responses`` maps the first argv token to ``(code, stdout, stderr)``, or is
    a callable taking argv.
    """
    calls: list[list[str]] = []

    async def fake_run(argv, *, timeout=10.0, stdin=None):
        calls.append(list(argv))
        if callable(responses):
            return responses(argv)
        return responses.get(argv[0], (0, "", ""))

    monkeypatch.setattr(svc, "_run", fake_run)
    return calls


# ── parsing ──────────────────────────────────────────────────────────────────

def test_parses_special_schedules():
    entries, unparsed = svc.parse_crontab(
        "@reboot /usr/local/bin/warm-cache.sh\n@daily ~/bin/rotate.sh --verbose\n"
    )
    assert unparsed == 0
    assert [e["schedule"] for e in entries] == ["@reboot", "@daily"]
    assert [e["schedule_kind"] for e in entries] == ["special", "special"]
    assert entries[0]["command"] == "/usr/local/bin/warm-cache.sh"
    assert entries[0]["name"] == "warm-cache"
    assert entries[1]["command"] == "~/bin/rotate.sh --verbose"


def test_environment_lines_are_not_jobs():
    entries, unparsed = svc.parse_crontab(
        'PATH=/usr/bin:/bin\nMAILTO=""\nSHELL = /bin/sh\n0 3 * * * /bin/echo hi\n'
    )
    assert unparsed == 0
    assert len(entries) == 1
    assert entries[0]["schedule"] == "0 3 * * *"
    assert entries[0]["command"] == "/bin/echo hi"


def test_comments_ignored_and_disabled_marker_parsed():
    entries, _ = svc.parse_crontab(
        "# a normal note\n"
        "\n"
        "# [NAVIDE-DISABLED] 0 9 * * 1 ~/bin/weekly-report.sh\n"
        "30 2 * * * ~/bin/backup.sh\n"
    )
    assert len(entries) == 2
    disabled, enabled = entries
    assert disabled["enabled"] is False
    assert disabled["schedule"] == "0 9 * * 1"
    assert disabled["command"] == "~/bin/weekly-report.sh"
    assert disabled["raw"] == "# [NAVIDE-DISABLED] 0 9 * * 1 ~/bin/weekly-report.sh"
    assert enabled["enabled"] is True


def test_command_whitespace_is_preserved_verbatim():
    line = "0 3 * * * /bin/sh   -c   'echo    a  b'"
    entries, _ = svc.parse_crontab(line + "\n")
    assert entries[0]["command"] == "/bin/sh   -c   'echo    a  b'"
    assert entries[0]["raw"] == line


def test_short_lines_counted_as_unparsed():
    entries, unparsed = svc.parse_crontab("0 3 * *\n@reboot\n0 3 * * * /bin/true\n")
    assert len(entries) == 1
    assert unparsed == 2


async def test_list_crontab_treats_no_crontab_as_empty(monkeypatch):
    _stub_run(monkeypatch, {"crontab": (1, "", "crontab: no crontab for neil")})
    result = await svc.list_crontab()
    assert result == {"supported": True, "entries": [], "unparsed": 0, "error": None}


async def test_list_crontab_reports_other_failures(monkeypatch):
    _stub_run(monkeypatch, {"crontab": (1, "", "crontab: permission denied")})
    result = await svc.list_crontab()
    assert result["error"] == "crontab: permission denied"


# ── crontab write-back guards ────────────────────────────────────────────────

async def test_set_enabled_never_writes_when_read_fails(monkeypatch):
    calls = _stub_run(monkeypatch, {"crontab": (1, "", "crontab: permission denied")})
    with pytest.raises(svc.ExecutionsError):
        await svc.set_crontab_enabled("0 3 * * * /bin/true", False)
    assert calls == [["crontab", "-l"]]


async def test_set_enabled_never_writes_when_crontab_is_empty(monkeypatch):
    # "no crontab" is fine for listing but fatal for a modify cycle.
    calls = _stub_run(monkeypatch, {"crontab": (1, "", "crontab: no crontab for neil")})
    with pytest.raises(svc.ExecutionsError):
        await svc.set_crontab_enabled("0 3 * * * /bin/true", False)
    assert calls == [["crontab", "-l"]]


async def test_missing_target_line_raises_and_does_not_write(monkeypatch):
    calls = _stub_run(monkeypatch, {"crontab": (0, "0 3 * * * /bin/true\n", "")})
    with pytest.raises(svc.ExecutionsError, match="modified by another program"):
        await svc.set_crontab_enabled("0 9 * * * /bin/false", False)
    assert calls == [["crontab", "-l"]]


def _capture_write(monkeypatch, listing):
    """Stub _run so `crontab -l` returns listing; capture the installed body."""
    written: list[str] = []

    def respond(argv):
        if argv[1] == "-l":
            return (0, listing, "")
        with open(argv[1], encoding="utf-8") as fh:
            written.append(fh.read())
        return (0, "", "")

    _stub_run(monkeypatch, respond)
    return written


async def test_disable_only_touches_the_first_duplicate(monkeypatch):
    listing = "0 3 * * * /bin/true\n0 3 * * * /bin/true\n"
    written = _capture_write(monkeypatch, listing)
    await svc.set_crontab_enabled("0 3 * * * /bin/true", False)
    assert written == [
        "# [NAVIDE-DISABLED] 0 3 * * * /bin/true\n0 3 * * * /bin/true\n"
    ]


async def test_disable_leaves_other_lines_byte_for_byte(monkeypatch):
    listing = (
        'PATH=/usr/bin:/bin\n'
        '# keep me\n'
        '*/15 * * * * ~/bin/sync-notes.sh\n'
        '30 2 * * * ~/bin/backup.sh   --deep\n'
    )
    written = _capture_write(monkeypatch, listing)
    await svc.set_crontab_enabled("*/15 * * * * ~/bin/sync-notes.sh", False)
    assert written == [
        'PATH=/usr/bin:/bin\n'
        '# keep me\n'
        '# [NAVIDE-DISABLED] */15 * * * * ~/bin/sync-notes.sh\n'
        '30 2 * * * ~/bin/backup.sh   --deep\n'
    ]


async def test_enable_strips_the_marker(monkeypatch):
    listing = "# [NAVIDE-DISABLED] 0 9 * * 1 ~/bin/report.sh\n0 3 * * * /bin/true\n"
    written = _capture_write(monkeypatch, listing)
    await svc.set_crontab_enabled("# [NAVIDE-DISABLED] 0 9 * * 1 ~/bin/report.sh", True)
    assert written == ["0 9 * * 1 ~/bin/report.sh\n0 3 * * * /bin/true\n"]


async def test_remove_deletes_only_the_target_line(monkeypatch):
    listing = "0 3 * * * /bin/true\n0 9 * * * /bin/false\n"
    written = _capture_write(monkeypatch, listing)
    await svc.remove_crontab_entry("0 9 * * * /bin/false")
    assert written == ["0 3 * * * /bin/true\n"]


async def test_failed_install_raises_with_stderr(monkeypatch):
    def respond(argv):
        if argv[1] == "-l":
            return (0, "0 3 * * * /bin/true\n", "")
        return (1, "", 'crontab: errors in crontab file, can\'t install')

    _stub_run(monkeypatch, respond)
    with pytest.raises(svc.ExecutionsError, match="can't install"):
        await svc.remove_crontab_entry("0 3 * * * /bin/true")


# ── LaunchAgents ─────────────────────────────────────────────────────────────

def test_launchctl_list_matches_the_label_column_exactly():
    out = (
        "PID\tStatus\tLabel\n"
        "4182\t0\tcom.foo\n"
        "-\t78\tcom.foo.bar\n"
        "921\t-\tcom.syncthing.syncthing\n"
    )
    parsed = svc.parse_launchctl_list(out)
    assert parsed["com.foo"] == (4182, 0)
    assert parsed["com.foo.bar"] == (None, 78)
    assert parsed["com.syncthing.syncthing"] == (921, None)
    assert "PID" not in parsed


def test_binary_plist_is_parsed(tmp_path, monkeypatch):
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    target = tmp_path / "local.nightly.plist"
    with open(target, "wb") as fh:
        plistlib.dump(
            {
                "Label": "local.nightly.index",
                "KeepAlive": {"SuccessfulExit": False},
                "RunAtLoad": True,
                "StartCalendarInterval": {"Hour": 3, "Minute": 0, "Bogus": "x"},
                "Comment": "Nightly Index",
            },
            fh,
            fmt=plistlib.FMT_BINARY,
        )
    found, unreadable = svc._scan_plists()
    assert unreadable == 0
    info = found[str(target)]
    assert info["label"] == "local.nightly.index"
    assert info["keep_alive"] is True
    assert info["run_at_load"] is True
    assert info["start_calendar"] == [{"Hour": 3, "Minute": 0}]
    assert info["comment"] == "Nightly Index"


def test_unreadable_plist_is_counted_not_fatal(tmp_path, monkeypatch):
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    (tmp_path / "broken.plist").write_text("not a plist at all", encoding="utf-8")
    (tmp_path / "ok.plist").write_bytes(
        plistlib.dumps({"Label": "com.ok"}, fmt=plistlib.FMT_XML)
    )
    found, unreadable = svc._scan_plists()
    assert unreadable == 1
    assert [info["label"] for info in found.values()] == ["com.ok"]


def test_start_calendar_list_is_normalized(tmp_path, monkeypatch):
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    (tmp_path / "a.plist").write_bytes(
        plistlib.dumps(
            {
                "Label": "com.multi",
                "StartCalendarInterval": [{"Hour": 1}, {"Weekday": 2, "Minute": 30}],
            }
        )
    )
    found, _ = svc._scan_plists()
    assert found[str(tmp_path / "a.plist")]["start_calendar"] == [
        {"Hour": 1},
        {"Minute": 30, "Weekday": 2},
    ]


@pytest.mark.parametrize("label", ["x$(id)", "../evil", "com.foo bar", "", "a;b"])
async def test_injection_labels_are_rejected(label, tmp_path, monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    calls = _stub_run(monkeypatch, {"launchctl": (0, "", "")})
    with pytest.raises(svc.ExecutionsError, match="invalid LaunchAgent label"):
        await svc.set_launch_agent_enabled(label, False)
    with pytest.raises(svc.ExecutionsError, match="invalid LaunchAgent label"):
        await svc.remove_launch_agent(label)
    assert calls == []


async def test_bootout_treats_not_loaded_as_success(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    (tmp_path / "com.foo.plist").write_bytes(plistlib.dumps({"Label": "com.foo"}))
    calls = _stub_run(
        monkeypatch, {"launchctl": (3, "", "Boot-out failed: 3: No such process")}
    )
    await svc.set_launch_agent_enabled("com.foo", False)
    # disable runs first now; "not loaded" is tolerated on both calls.
    assert [c[1] for c in calls] == ["disable", "bootout"]


async def test_bootout_failure_raises_with_stderr(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    (tmp_path / "com.foo.plist").write_bytes(plistlib.dumps({"Label": "com.foo"}))
    _stub_run(
        monkeypatch, {"launchctl": (5, "", "Boot-out failed: 5: Input/output error")}
    )
    with pytest.raises(svc.ExecutionsError, match="Input/output error"):
        await svc.set_launch_agent_enabled("com.foo", False)


async def test_remove_keeps_the_plist_when_bootout_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    plist = tmp_path / "com.foo.plist"
    plist.write_bytes(plistlib.dumps({"Label": "com.foo"}))
    _stub_run(monkeypatch, {"launchctl": (5, "", "Boot-out failed: 5: I/O error")})
    with pytest.raises(svc.ExecutionsError):
        await svc.remove_launch_agent("com.foo")
    assert plist.exists()


async def test_remove_deletes_the_plist_after_a_clean_bootout(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    plist = tmp_path / "com.foo.plist"
    plist.write_bytes(plistlib.dumps({"Label": "com.foo"}))
    _stub_run(monkeypatch, {"launchctl": (0, "", "")})
    await svc.remove_launch_agent("com.foo")
    assert not plist.exists()


async def test_list_launch_agents_unions_both_sources(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: tmp_path)
    (tmp_path / "a.plist").write_bytes(
        plistlib.dumps({"Label": "com.syncthing.syncthing", "StartInterval": 3600})
    )
    (tmp_path / "b.plist").write_bytes(plistlib.dumps({"Label": "local.legacy.backup"}))
    _stub_run(
        monkeypatch,
        {
            "launchctl": (
                0,
                "PID\tStatus\tLabel\n"
                "921\t0\tcom.syncthing.syncthing\n"
                "-\t0\tcom.apple.only.in.launchctl\n",
                "",
            )
        },
    )
    result = await svc.list_launch_agents()
    by_label = {e["label"]: e for e in result["entries"]}
    assert by_label["com.syncthing.syncthing"]["running"] is True
    assert by_label["com.syncthing.syncthing"]["pid"] == 921
    assert by_label["com.syncthing.syncthing"]["name"] == "syncthing"
    assert by_label["com.syncthing.syncthing"]["start_interval"] == 3600
    assert by_label["local.legacy.backup"]["loaded"] is False
    assert by_label["local.legacy.backup"]["plist_exists"] is True
    # launchctl-only labels are excluded: a real machine reports ~550 transient
    # `application.com.apple.*` registrations that have no plist and no action.
    assert "com.apple.only.in.launchctl" not in by_label
    assert all(e["plist_exists"] for e in result["entries"])


# ── system-level launchd jobs (read-only) ────────────────────────────────────

def _launchctl(listing: str):
    return {"launchctl": (0, listing, "")}


async def test_scan_covers_all_three_directories_with_scopes(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    user, system_agents, system_daemons = _scoped_dirs(monkeypatch, tmp_path)
    (user / "u.plist").write_bytes(plistlib.dumps({"Label": "local.user.job"}))
    (system_agents / "s.plist").write_bytes(plistlib.dumps({"Label": "com.vendor.agent"}))
    (system_daemons / "d.plist").write_bytes(plistlib.dumps({"Label": "com.vendor.daemon"}))
    _stub_run(monkeypatch, _launchctl("PID\tStatus\tLabel\n"))

    result = await svc.list_launch_agents()
    by_label = {e["label"]: e for e in result["entries"]}
    assert by_label["local.user.job"]["scope"] == "user"
    assert by_label["com.vendor.agent"]["scope"] == "system-agent"
    assert by_label["com.vendor.daemon"]["scope"] == "system-daemon"
    # User jobs — the only actionable ones — are listed first.
    assert result["entries"][0]["label"] == "local.user.job"


async def test_same_label_in_user_and_system_stays_two_rows(tmp_path, monkeypatch):
    """Google's keystone really does install the same label in both places."""
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    user, system_agents, _daemons = _scoped_dirs(monkeypatch, tmp_path)
    label = "com.google.keystone.agent"
    (user / f"{label}.plist").write_bytes(plistlib.dumps({"Label": label}))
    (system_agents / f"{label}.plist").write_bytes(plistlib.dumps({"Label": label}))
    _stub_run(monkeypatch, _launchctl("PID\tStatus\tLabel\n"))

    result = await svc.list_launch_agents()
    rows = [e for e in result["entries"] if e["label"] == label]
    assert len(rows) == 2
    assert sorted(e["scope"] for e in rows) == ["system-agent", "user"]
    assert {e["plist_path"] for e in rows} == {
        str(user / f"{label}.plist"),
        str(system_agents / f"{label}.plist"),
    }


async def test_system_daemon_runtime_is_unknown_not_stopped(tmp_path, monkeypatch):
    """`launchctl list` without sudo cannot see the system domain at all.

    Reporting those daemons as "not running" would be a confident lie, so every
    runtime field has to come back as None.
    """
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    _user, _agents, system_daemons = _scoped_dirs(monkeypatch, tmp_path)
    (system_daemons / "d.plist").write_bytes(plistlib.dumps({"Label": "com.vendor.daemon"}))
    _stub_run(monkeypatch, _launchctl("PID\tStatus\tLabel\n4182\t0\tcom.other\n"))

    entry = (await svc.list_launch_agents())["entries"][0]
    assert entry["runtime_known"] is False
    assert entry["loaded"] is None
    assert entry["running"] is None
    assert entry["pid"] is None
    assert entry["last_exit_code"] is None


async def test_system_agent_state_is_known_from_launchctl(tmp_path, monkeypatch):
    """/Library/LaunchAgents is bootstrapped into gui/$UID, so it is visible."""
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    _user, system_agents, system_daemons = _scoped_dirs(monkeypatch, tmp_path)
    (system_agents / "s.plist").write_bytes(plistlib.dumps({"Label": "com.vendor.agent"}))
    # A daemon that *is* in the listing is knowable too.
    (system_daemons / "d.plist").write_bytes(plistlib.dumps({"Label": "com.vendor.seen"}))
    _stub_run(
        monkeypatch,
        _launchctl(
            "PID\tStatus\tLabel\n1234\t0\tcom.vendor.agent\n-\t78\tcom.vendor.seen\n"
        ),
    )

    by_label = {e["label"]: e for e in (await svc.list_launch_agents())["entries"]}
    agent = by_label["com.vendor.agent"]
    assert agent["runtime_known"] is True
    assert agent["loaded"] is True
    assert agent["running"] is True
    assert agent["pid"] == 1234
    seen = by_label["com.vendor.seen"]
    assert seen["runtime_known"] is True
    assert seen["running"] is False
    assert seen["last_exit_code"] == 78


async def test_only_user_entries_are_managed(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    user, system_agents, system_daemons = _scoped_dirs(monkeypatch, tmp_path)
    (user / "u.plist").write_bytes(plistlib.dumps({"Label": "local.user.job"}))
    (system_agents / "s.plist").write_bytes(plistlib.dumps({"Label": "com.vendor.agent"}))
    (system_daemons / "d.plist").write_bytes(plistlib.dumps({"Label": "com.vendor.daemon"}))
    _stub_run(monkeypatch, _launchctl("PID\tStatus\tLabel\n"))

    managed = {e["label"]: e["managed"] for e in (await svc.list_launch_agents())["entries"]}
    assert managed == {
        "local.user.job": True,
        "com.vendor.agent": False,
        "com.vendor.daemon": False,
    }


@pytest.mark.parametrize("directory", ["system-agents", "system-daemons"])
async def test_system_level_jobs_cannot_be_mutated(directory, tmp_path, monkeypatch):
    """The path containment guard must hold before any command is spawned."""
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    dirs = dict(zip(("user", "system-agents", "system-daemons"), _scoped_dirs(monkeypatch, tmp_path)))
    (dirs[directory] / "x.plist").write_bytes(plistlib.dumps({"Label": "com.vendor.system"}))
    calls = _stub_run(monkeypatch, {})

    with pytest.raises(svc.ExecutionsError, match="system-level"):
        await svc.set_launch_agent_enabled("com.vendor.system", False)
    with pytest.raises(svc.ExecutionsError, match="system-level"):
        await svc.set_launch_agent_enabled("com.vendor.system", True)
    with pytest.raises(svc.ExecutionsError, match="system-level"):
        await svc.remove_launch_agent("com.vendor.system")
    assert calls == []
    assert (dirs[directory] / "x.plist").exists()


async def test_a_user_job_shadowing_a_system_label_is_still_manageable(tmp_path, monkeypatch):
    """The user's own copy is the one a mutation resolves to."""
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    user, system_agents, _daemons = _scoped_dirs(monkeypatch, tmp_path)
    label = "com.google.keystone.agent"
    user_plist = user / f"{label}.plist"
    user_plist.write_bytes(plistlib.dumps({"Label": label}))
    system_plist = system_agents / f"{label}.plist"
    system_plist.write_bytes(plistlib.dumps({"Label": label}))
    _stub_run(monkeypatch, {"launchctl": (0, "", "")})

    await svc.remove_launch_agent(label)
    assert not user_plist.exists()
    assert system_plist.exists()


async def test_launch_agents_unsupported_off_darwin(monkeypatch):
    monkeypatch.setattr(svc.sys, "platform", "linux")
    result = await svc.list_launch_agents()
    assert result["supported"] is False
    assert result["entries"] == []


async def test_list_executions_matches_window_contract(monkeypatch):
    """Pins the wire shape the executions window reads.

    The section key is "agents" here even though the scanner returns "entries",
    and scanned_at is epoch seconds — a mismatch on either silently empties the
    window, so it gets its own test rather than riding on the scanners'.
    """
    monkeypatch.setattr(svc.sys, "platform", "darwin")

    async def fake_crontab():
        return {"supported": True, "entries": [{"id": "a1"}], "unparsed": 0, "error": None}

    async def fake_agents():
        return {"supported": True, "entries": [{"label": "com.x"}], "unreadable": 0, "error": None}

    monkeypatch.setattr(svc, "list_crontab", fake_crontab)
    monkeypatch.setattr(svc, "list_launch_agents", fake_agents)

    snapshot = await svc.list_executions()

    assert set(snapshot) == {"platform", "scanned_at", "crontab", "launch_agents"}
    assert snapshot["platform"] == "darwin"
    assert isinstance(snapshot["scanned_at"], float)
    assert snapshot["crontab"]["entries"] == [{"id": "a1"}]
    assert snapshot["launch_agents"]["agents"] == [{"label": "com.x"}]
    assert "entries" not in snapshot["launch_agents"]


def test_entry_name_skips_the_interpreter():
    """Naming a job after its interpreter tells the user nothing.

    Shape taken from a real user crontab: a PHP artisan scheduler whose script
    path contains both spaces and non-ASCII characters.
    """
    entries, _ = svc.parse_crontab(
        '* * * * * /usr/bin/php "/Users/x/Downloads/客戶名單/lead-manager/artisan"'
        " schedule:run >> /dev/null 2>&1\n"
    )
    assert entries[0]["name"] == "artisan"
    # The command itself is still preserved verbatim, quotes and all.
    assert '"/Users/x/Downloads/客戶名單/lead-manager/artisan"' in entries[0]["command"]


def test_entry_name_variants():
    cases = {
        "/Users/x/bin/backup-photos.sh": "backup-photos",
        "/usr/bin/env python3 /srv/app/tick.py": "tick.py",
        "/bin/bash -lc /srv/run.bin": "run.bin",
        "node /srv/worker.js": "worker.js",
    }
    for command, expected in cases.items():
        entries, _ = svc.parse_crontab(f"0 1 * * * {command}\n")
        assert entries[0]["name"] == expected, command


async def test_symlink_escape_is_refused(tmp_path, monkeypatch):
    """The realpath containment guard is the only thing stopping a symlink escape.

    Without this test, deleting those three lines leaves the suite green.
    """
    agents_dir = tmp_path / "LaunchAgents"
    agents_dir.mkdir()
    outside = tmp_path / "outside.plist"
    outside.write_bytes(plistlib.dumps({"Label": "com.evil"}))
    (agents_dir / "com.evil.plist").symlink_to(outside)
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: agents_dir)
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    calls = _stub_run(monkeypatch, {})

    with pytest.raises(svc.ExecutionsError, match="refusing to touch a plist outside"):
        await svc.remove_launch_agent("com.evil")
    assert calls == []
    assert outside.exists()


async def test_disable_persists_through_launchd_override(tmp_path, monkeypatch):
    """bootout alone is undone at next login, so `launchctl disable` must run."""
    agents_dir = tmp_path / "LaunchAgents"
    agents_dir.mkdir()
    (agents_dir / "com.demo.job.plist").write_bytes(plistlib.dumps({"Label": "com.demo.job"}))
    monkeypatch.setattr(svc, "_launch_agents_dir", lambda: agents_dir)
    monkeypatch.setattr(svc.sys, "platform", "darwin")
    calls = _stub_run(monkeypatch, {})

    await svc.set_launch_agent_enabled("com.demo.job", False)
    verbs = [c[1] for c in calls]
    assert verbs == ["disable", "bootout"], calls

    calls.clear()
    await svc.set_launch_agent_enabled("com.demo.job", True)
    # enable must precede bootstrap: launchd refuses to bootstrap a disabled job.
    assert [c[1] for c in calls] == ["enable", "bootstrap"], calls


async def test_write_is_abandoned_when_the_crontab_changed_underneath(monkeypatch):
    """Another program editing the crontab mid-cycle must not be overwritten."""
    listing = ["0 3 * * * /bin/true\n", "0 3 * * * /bin/true\n0 9 * * * /bin/new\n"]
    installed: list[str] = []

    def respond(argv):
        if argv[1] == "-l":
            return (0, listing.pop(0), "")
        installed.append(argv[1])
        return (0, "", "")

    _stub_run(monkeypatch, respond)
    with pytest.raises(svc.ExecutionsError, match="changed while it was being edited"):
        await svc.remove_crontab_entry("0 3 * * * /bin/true")
    assert installed == []


def test_duplicate_lines_get_distinct_ids():
    entries, _ = svc.parse_crontab("0 3 * * * /bin/true\n0 3 * * * /bin/true\n")
    assert len({e["id"] for e in entries}) == 2
