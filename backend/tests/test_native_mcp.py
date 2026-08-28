from __future__ import annotations

import json
import os
from pathlib import Path

from agent_team_backend import native_mcp
from agent_team_backend.cli_vendors.registry import VENDORS


def _write(home: Path, relative: tuple[str, ...], text: str) -> Path:
    path = home.joinpath(*relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _snapshot(home: Path) -> set[tuple[str, int, int]]:
    """Every path under home with size and mtime — the write-nothing witness."""
    out = set()
    for dirpath, dirnames, filenames in os.walk(home):
        for name in dirnames + filenames:
            entry = Path(dirpath) / name
            st = entry.lstat()
            out.add((str(entry), st.st_size, st.st_mtime_ns))
    return out


def test_scan_reads_every_shape(tmp_path: Path) -> None:
    home = tmp_path
    _write(home, (".claude.json",), json.dumps({"mcpServers": {"ctx": {"command": "npx"}}}))
    _write(
        home,
        (".codex", "config.toml"),
        '[mcp_servers.xmind]\nenabled = false\nurl = "https://app.xmind.com/mcp"\n',
    )
    _write(
        home,
        (".grok", "user-settings.json"),
        json.dumps(
            {"mcp": {"servers": [{"id": "gk", "transport": "http", "url": "https://g/mcp"}]}}
        ),
    )

    found = {(s.agent, s.name): s for s in native_mcp.scan(home)}

    assert set(found) == {("claude", "ctx"), ("codex", "xmind"), ("grok", "gk")}
    assert found[("claude", "ctx")].transport == "stdio"
    assert found[("claude", "ctx")].command == "npx"
    assert found[("codex", "xmind")].transport == "http"
    assert found[("codex", "xmind")].enabled is False
    assert found[("grok", "gk")].url == "https://g/mcp"


def test_scan_never_writes(tmp_path: Path) -> None:
    home = tmp_path
    _write(home, (".claude.json",), json.dumps({"mcpServers": {"ctx": {"command": "npx"}}}))
    _write(home, (".config", "kilo", "kilo.jsonc"), "{ /* c */ }")
    before = _snapshot(home)

    native_mcp.scan(home)

    assert _snapshot(home) == before


def test_missing_configs_are_silent(tmp_path: Path) -> None:
    assert native_mcp.scan(tmp_path) == []


def test_jsonc_comments_and_trailing_commas_parse(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".copilot", "mcp-config.json"),
        """// User settings belong in settings.json.
{
  "mcpServers": {
    /* the docs one */
    "docs": { "command": "npx", "args": ["-y", "docs-mcp"], },
  },
}
""",
    )

    found = native_mcp.scan(tmp_path)

    assert [(s.agent, s.name, s.command) for s in found] == [("copilot", "docs", "npx")]
    assert found[0].args == ("-y", "docs-mcp")


def test_a_url_inside_a_string_is_not_a_comment(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".cursor", "mcp.json"),
        json.dumps({"mcpServers": {"remote": {"url": "https://example.com/mcp"}}}),
    )

    found = native_mcp.scan(tmp_path)

    assert [s.url for s in found] == ["https://example.com/mcp"]


def test_broken_config_is_reported_not_dropped(tmp_path: Path) -> None:
    _write(tmp_path, (".claude.json",), "{ not json")

    found = native_mcp.scan(tmp_path)

    assert len(found) == 1
    assert found[0].agent == "claude"
    assert found[0].valid is False
    assert "invalid JSON" in found[0].error


def test_secret_env_and_header_values_are_redacted(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".claude.json",),
        json.dumps(
            {
                "mcpServers": {
                    "s": {
                        "command": "x",
                        "env": {"API_KEY": "sk-live-1", "MODE": "fast"},
                        "headers": {"Authorization": "Bearer t", "Accept": "json"},
                    }
                }
            }
        ),
    )

    found = native_mcp.scan(tmp_path)[0]

    assert dict(found.env) == {"API_KEY": native_mcp.REDACTED_SECRET, "MODE": "fast"}
    assert dict(found.headers) == {
        "Authorization": native_mcp.REDACTED_SECRET,
        "Accept": "json",
    }


def test_secret_arguments_are_redacted(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".gemini", "config", "mcp_config.json"),
        json.dumps(
            {
                "mcpServers": {
                    "stitch": {
                        "command": "npx",
                        "args": [
                            "-y",
                            "mcp-remote",
                            "https://stitch.googleapis.com/mcp",
                            "--header",
                            "X-Goog-Api-Key: AQ.secret",
                            "--api-key=AQ.other",
                        ],
                    }
                }
            }
        ),
    )

    found = native_mcp.scan(tmp_path)[0]

    assert found.agent == "antigravity"
    assert found.args == (
        "-y",
        "mcp-remote",
        "https://stitch.googleapis.com/mcp",
        "--header",
        f"X-Goog-Api-Key:{native_mcp.REDACTED_SECRET}",
        f"--api-key={native_mcp.REDACTED_SECRET}",
    )


def test_an_unnamed_secret_argument_is_masked_whole(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".claude.json",),
        json.dumps({"mcpServers": {"s": {"command": "x", "args": ["--token", "abc123"]}}}),
    )

    assert native_mcp.scan(tmp_path)[0].args == ("--token", native_mcp.REDACTED_SECRET)


def test_our_own_endpoint_is_not_reported_as_the_users(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".kimi-code", "mcp.json"),
        json.dumps(
            {
                "mcpServers": {
                    "navide": {"url": "http://127.0.0.1:8765/plan-mcp?pane=p1"},
                    "mine": {"url": "https://example.com/mcp"},
                }
            }
        ),
    )

    assert [s.name for s in native_mcp.scan(tmp_path)] == ["mine"]


def test_both_accepted_filenames_are_read(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".config", "opencode", "opencode.json"),
        json.dumps({"mcp": {"a": {"type": "remote", "url": "https://a/mcp"}}}),
    )
    _write(
        tmp_path,
        (".config", "opencode", "opencode.jsonc"),
        json.dumps({"mcp": {"b": {"type": "remote", "url": "https://b/mcp"}}}),
    )

    assert sorted(s.name for s in native_mcp.scan(tmp_path)) == ["a", "b"]


def test_native_sources_agree_with_vendor_wiring() -> None:
    """The reflection's section must not drift from the vendor's own."""
    for source in native_mcp.NATIVE_SOURCES:
        spec = VENDORS.get(source.agent)
        if spec is None or spec.mcp_wiring is None or spec.mcp_wiring.config is None:
            continue
        assert source.section == spec.mcp_wiring.config.section, source.agent
        assert source.list_key == spec.mcp_wiring.config.list_key, source.agent


def test_agent_targets_separate_off_from_impossible() -> None:
    by_key = {agent["key"]: agent for agent in native_mcp.agent_targets()}

    assert set(by_key) == set(VENDORS)
    assert by_key["claude"]["state"] == "wired"
    assert by_key["claude"]["reflects"] is True
    # droid has MCP of its own but Navide has no wiring for it yet.
    assert by_key["droid"]["state"] == "planned"
    assert by_key["droid"]["reflects"] is True
    # aider has no MCP mechanism at all.
    assert by_key["aider"]["state"] == "unsupported"
    assert by_key["aider"]["reflects"] is False
def test_credentials_inside_a_url_are_redacted(tmp_path: Path) -> None:
    """A URL carries secrets in two places; neither may leave the backend."""
    _write(
        tmp_path,
        (".claude.json",),
        json.dumps(
            {
                "mcpServers": {
                    "remote": {
                        "url": "https://user:p%40ss@api.example.com/mcp?token=SECRET&mode=fast"
                    }
                }
            }
        ),
    )

    found = native_mcp.scan(tmp_path)[0]

    assert "SECRET" not in found.url
    assert "p%40ss" not in found.url
    # The host and the harmless parameter still identify the entry.
    assert found.url == "https://***@api.example.com/mcp?token=***&mode=fast"


def test_a_url_argument_is_redacted_like_a_url(tmp_path: Path) -> None:
    """mcp-remote is routinely handed the credential inside the URL."""
    _write(
        tmp_path,
        (".claude.json",),
        json.dumps(
            {
                "mcpServers": {
                    "s": {
                        "command": "npx",
                        "args": ["-y", "mcp-remote", "https://h/mcp?apikey=SECRET123"],
                    }
                }
            }
        ),
    )

    args = native_mcp.scan(tmp_path)[0].args

    assert "SECRET123" not in " ".join(args)
    assert args == ("-y", "mcp-remote", "https://h/mcp?apikey=***")


def test_unseparated_secret_names_are_redacted(tmp_path: Path) -> None:
    """``APIKEY`` never splits into API + KEY, so the token test alone misses it."""
    _write(
        tmp_path,
        (".claude.json",),
        json.dumps(
            {"mcpServers": {"s": {"command": "x", "env": {"APIKEY": "leak", "GITHUB_PAT": "leak"}}}}
        ),
    )

    env = dict(native_mcp.scan(tmp_path)[0].env)

    assert env == {"APIKEY": native_mcp.REDACTED_SECRET, "GITHUB_PAT": native_mcp.REDACTED_SECRET}


def test_a_non_string_env_value_is_rendered_not_dropped(tmp_path: Path) -> None:
    """An empty value reads as "not set", which is a different answer."""
    _write(
        tmp_path,
        (".claude.json",),
        json.dumps(
            {"mcpServers": {"s": {"command": "x", "env": {"PORT": 8080, "OPTS": {"a": 1}}}}}
        ),
    )

    env = dict(native_mcp.scan(tmp_path)[0].env)

    assert env == {"PORT": "8080", "OPTS": '{"a": 1}'}


def test_a_bom_does_not_make_a_healthy_config_invalid(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".copilot", "mcp-config.json"),
        "\ufeff" + json.dumps({"mcpServers": {"a": {"command": "x"}}}),
    )

    found = native_mcp.scan(tmp_path)

    assert [(s.name, s.valid) for s in found] == [("a", True)]


def test_a_non_ascii_server_name_is_listed(tmp_path: Path) -> None:
    """Dropping it silently made the matrix answer "not configured" wrongly."""
    _write(
        tmp_path,
        (".claude.json",),
        json.dumps({"mcpServers": {"高德地圖": {"command": "npx"}, "@scope/thing": {"command": "npx"}}}),
    )

    assert sorted(s.name for s in native_mcp.scan(tmp_path)) == ["@scope/thing", "高德地圖"]


def test_a_control_character_name_is_reported_and_sanitised(tmp_path: Path) -> None:
    _write(
        tmp_path,
        (".claude.json",),
        json.dumps({"mcpServers": {"ctl\u0007name": {"command": "x"}}}),
    )

    found = native_mcp.scan(tmp_path)[0]

    assert found.name == "ctlname"
    assert found.valid is False
    assert found.error == "unreadable server name"


def test_the_roo_style_disabled_flag_is_honoured(tmp_path: Path) -> None:
    """kilo's lineage writes ``disabled: true`` where others write ``enabled``."""
    _write(
        tmp_path,
        (".config", "kilo", "kilo.jsonc"),
        json.dumps({"mcp": {"off": {"command": "x", "disabled": True}, "on": {"command": "x"}}}),
    )

    states = {s.name: s.enabled for s in native_mcp.scan(tmp_path)}

    assert states == {"off": False, "on": True}


def test_every_reflected_agent_is_a_registered_vendor() -> None:
    """A source for an unknown agent would render nowhere in the matrix."""
    assert {source.agent for source in native_mcp.NATIVE_SOURCES} <= set(VENDORS)
