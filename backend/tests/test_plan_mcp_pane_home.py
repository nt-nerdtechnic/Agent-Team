from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.plugins.builtin.navide_plans import pane_home, plan_mcp_wiring

URL = "http://127.0.0.1:4567/plan-mcp?pane=p1&t=tok"
SERVER = "navide-plans"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake home the shims are built under, so no test touches the real one."""
    fake = tmp_path / "home"
    fake.mkdir()
    monkeypatch.setattr(pane_home, "real_home", lambda: fake)
    return fake


def _config(home: Path, agent: str, pane: str) -> Path:
    spec = pane_home.SHIM_SPECS[agent]
    root = pane_home.shim_root(agent, pane)
    assert root is not None
    base = root / spec.vendor_dir if spec.shims_home else root
    return base.joinpath(*spec.config_relpath)


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


# ---- kimi: config-dir shim, $HOME untouched ----


def test_kimi_shim_uses_its_config_dir_var_and_writes_mcp_json(home: Path) -> None:
    (home / ".kimi-code").mkdir()
    prepared = pane_home.prepare("kimi", "p1", URL, SERVER)
    assert prepared is not None
    env_var, root = prepared
    assert env_var == "KIMI_CODE_HOME"
    assert Path(root) == home / ".navide-panes" / "kimi" / "p1"
    assert _load(_config(home, "kimi", "p1")) == {"mcpServers": {SERVER: {"url": URL}}}


def test_kimi_shim_symlinks_credentials_back_to_the_real_dir(home: Path) -> None:
    real = home / ".kimi-code"
    (real / "credentials").mkdir(parents=True)
    (real / "credentials" / "kimi-code.json").write_text("secret", encoding="utf-8")
    (real / "config.toml").write_text("[providers]", encoding="utf-8")
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    creds = Path(root) / "credentials"
    # A link, not a copy: the user stays logged in and a refreshed token
    # written by the CLI lands in their real directory.
    assert creds.is_symlink() and creds.resolve() == (real / "credentials").resolve()
    assert (Path(root) / "config.toml").is_symlink()
    assert not (Path(root) / "mcp.json").is_symlink()  # only the config is ours


def test_kimi_shim_merges_the_users_own_servers(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    (real / "mcp.json").write_text(
        json.dumps({"mcpServers": {"mine": {"command": "x"}}, "extra": 7}),
        encoding="utf-8",
    )
    pane_home.prepare("kimi", "p1", URL, SERVER)
    document = _load(_config(home, "kimi", "p1"))
    assert document["mcpServers"]["mine"] == {"command": "x"}
    assert document["mcpServers"][SERVER] == {"url": URL}
    assert document["extra"] == 7
    # The user's own file is never written back to.
    assert "navide" not in (real / "mcp.json").read_text(encoding="utf-8")


# ---- antigravity: HOME shim, serverUrl, nested config dir ----


def test_antigravity_shim_shims_home_and_uses_server_url(home: Path) -> None:
    (home / ".gemini" / "config").mkdir(parents=True)
    (home / ".zshrc").write_text("export X=1", encoding="utf-8")
    prepared = pane_home.prepare("antigravity", "p1", URL, SERVER)
    assert prepared is not None
    env_var, root = prepared
    assert env_var == "HOME"  # no config-dir variable exists for this CLI
    assert (Path(root) / ".zshrc").is_symlink()  # shell config still the user's
    # url/httpUrl are rejected as legacy fields; a remote server is serverUrl.
    assert _load(_config(home, "antigravity", "p1")) == {
        "mcpServers": {SERVER: {"serverUrl": URL}}
    }


def test_antigravity_shim_keeps_oauth_token_linked(home: Path) -> None:
    gemini = home / ".gemini"
    (gemini / "config").mkdir(parents=True)
    (gemini / "oauth_creds.json").write_text("token", encoding="utf-8")
    (gemini / "config" / "other.json").write_text("{}", encoding="utf-8")
    _, root = pane_home.prepare("antigravity", "p1", URL, SERVER)  # type: ignore[misc]
    assert (Path(root) / ".gemini" / "oauth_creds.json").is_symlink()
    assert (Path(root) / ".gemini" / "config" / "other.json").is_symlink()
    assert not (Path(root) / ".gemini" / "config" / "mcp_config.json").is_symlink()


def test_home_shim_does_not_mirror_the_panes_root_into_itself(home: Path) -> None:
    (home / ".gemini" / "config").mkdir(parents=True)
    pane_home.prepare("antigravity", "p1", URL, SERVER)
    _, root = pane_home.prepare("antigravity", "p2", URL, SERVER)  # type: ignore[misc]
    assert not (Path(root) / ".navide-panes").exists()


# ---- grok: HOME shim, list-shaped servers, credential in the same file ----


def test_grok_shim_writes_a_list_entry_and_copies_the_settings_file(home: Path) -> None:
    grok = home / ".grok"
    grok.mkdir()
    (grok / "user-settings.json").write_text(
        json.dumps({"apiKey": "xai-secret", "mcp": {"servers": [{"id": "mine"}]}}),
        encoding="utf-8",
    )
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    config = _config(home, "grok", "p1")
    # The API key shares this file with the MCP servers, so it cannot be a
    # symlink — the pane runs against a copy.
    assert not config.is_symlink()
    document = _load(config)
    assert document["apiKey"] == "xai-secret"
    servers = document["mcp"]["servers"]
    assert isinstance(servers, list)
    assert [s["id"] for s in servers] == ["mine", SERVER]
    ours = servers[-1]
    assert ours["transport"] == "http" and ours["url"] == URL and ours["enabled"] is True


def test_grok_shim_replaces_our_entry_rather_than_appending(home: Path) -> None:
    (home / ".grok").mkdir()
    pane_home.prepare("grok", "p1", URL, SERVER)
    pane_home.prepare("grok", "p1", URL + "&again=1", SERVER)
    servers = _load(_config(home, "grok", "p1"))["mcp"]["servers"]
    assert [s["id"] for s in servers] == [SERVER]  # not accumulating per spawn


def test_grok_shim_config_is_not_world_readable(home: Path) -> None:
    (home / ".grok").mkdir()
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    config = _config(home, "grok", "p1")
    assert stat.S_IMODE(config.stat().st_mode) == 0o600
    assert stat.S_IMODE(Path(root).stat().st_mode) == 0o700


def test_grok_shim_shares_the_session_database_by_link(home: Path) -> None:
    grok = home / ".grok"
    grok.mkdir()
    (grok / "grok.db").write_text("sqlite", encoding="utf-8")
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    assert (Path(root) / ".grok" / "grok.db").is_symlink()


# ---- shared behaviour ----


def test_prepare_refreshes_links_added_since_the_last_spawn(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    pane_home.prepare("kimi", "p1", URL, SERVER)
    (real / "new-thing").write_text("later", encoding="utf-8")
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    assert (Path(root) / "new-thing").is_symlink()


def test_prepare_drops_links_whose_target_disappeared(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    (real / "going-away").write_text("x", encoding="utf-8")
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    (real / "going-away").unlink()
    pane_home.prepare("kimi", "p1", URL, SERVER)
    dangling = Path(root) / "going-away"
    assert not dangling.is_symlink() and not dangling.exists()


def test_prepare_survives_a_missing_vendor_directory(home: Path) -> None:
    """Fresh install: nothing to mirror, but the pane still gets its endpoint."""
    prepared = pane_home.prepare("kimi", "p1", URL, SERVER)
    assert prepared is not None
    assert _load(_config(home, "kimi", "p1"))["mcpServers"][SERVER] == {"url": URL}


def test_prepare_starts_over_when_the_users_config_is_unparseable(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    (real / "mcp.json").write_text("{ broken", encoding="utf-8")
    pane_home.prepare("kimi", "p1", URL, SERVER)
    assert _load(_config(home, "kimi", "p1")) == {"mcpServers": {SERVER: {"url": URL}}}
    assert (real / "mcp.json").read_text(encoding="utf-8") == "{ broken"


def test_prepare_rejects_an_unknown_agent_or_unsafe_pane_id(home: Path) -> None:
    assert pane_home.prepare("claude", "p1", URL, SERVER) is None
    assert pane_home.prepare("kimi", "../escape", URL, SERVER) is None
    assert pane_home.prepare("kimi", "", URL, SERVER) is None
    assert not (home / ".navide-panes").exists()


def test_two_panes_get_independent_shims(home: Path) -> None:
    (home / ".kimi-code").mkdir()
    pane_home.prepare("kimi", "p1", URL, SERVER)
    pane_home.prepare("kimi", "p2", "http://127.0.0.1:4567/plan-mcp?pane=p2&t=tok", SERVER)
    assert _load(_config(home, "kimi", "p1"))["mcpServers"][SERVER]["url"].endswith("pane=p1&t=tok")
    assert _load(_config(home, "kimi", "p2"))["mcpServers"][SERVER]["url"].endswith("pane=p2&t=tok")


# ---- wire_command integration ----


@pytest.mark.parametrize(
    ("agent", "env_var"),
    [("kimi", "KIMI_CODE_HOME"), ("grok", "HOME"), ("antigravity", "HOME")],
)
def test_wire_command_sets_the_shim_var_without_touching_the_command(
    home: Path, agent: str, env_var: str
) -> None:
    env: dict[str, str] = {}
    assert plan_mcp_wiring.wire_command(agent, agent, 4567, "p1", env) == agent
    assert env[env_var] == str(home / ".navide-panes" / agent / "p1")
    config = _config(home, agent, "p1")
    assert plan_mcp_wiring.caller_token() in config.read_text(encoding="utf-8")


def test_wire_command_skips_the_shim_without_a_pane_id(home: Path) -> None:
    env: dict[str, str] = {}
    assert plan_mcp_wiring.wire_command("grok", "grok", 4567, "", env) == "grok"
    assert env == {}
    assert not (home / ".navide-panes").exists()


def test_wire_command_leaves_a_preset_shim_var_alone(home: Path) -> None:
    env = {"KIMI_CODE_HOME": "/somewhere/else"}
    plan_mcp_wiring.wire_command("kimi", "kimi", 4567, "p1", env)
    assert env == {"KIMI_CODE_HOME": "/somewhere/else"}
