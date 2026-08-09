"""Unit tests for workspace plan-asset provisioning."""

from pathlib import Path

from agent_team_backend.plan_provisioning import (
    SPEC_FILENAME,
    TEMPLATE_FILENAME,
    ensure_plan_assets,
    plan_spec_exists,
)


def _plans_dir(workspace: Path) -> Path:
    return workspace / ".agent-team" / "plans"


def test_fresh_workspace_provisions_spec_and_template(tmp_path):
    assert ensure_plan_assets(str(tmp_path)) is True

    spec = _plans_dir(tmp_path) / SPEC_FILENAME
    template = _plans_dir(tmp_path) / TEMPLATE_FILENAME
    assert spec.is_file()
    assert template.is_file()
    assert "provisioned by Navide, spec-version: 2" in spec.read_text(encoding="utf-8")

    tpl_text = template.read_text(encoding="utf-8")
    # Workspace name substituted into the eyebrow; placeholder gone.
    assert f"{tmp_path.name} · Plan" in tpl_text
    assert "{{WORKSPACE_NAME}}" not in tpl_text
    # Validation stays a per-project placeholder.
    assert "fill in this project's verification commands" in tpl_text

    assert plan_spec_exists(str(tmp_path)) is True


def test_existing_files_are_never_overwritten(tmp_path):
    plans = _plans_dir(tmp_path)
    plans.mkdir(parents=True)
    (plans / SPEC_FILENAME).write_text("custom spec", encoding="utf-8")
    (plans / TEMPLATE_FILENAME).write_text("custom template", encoding="utf-8")

    assert ensure_plan_assets(str(tmp_path)) is True

    assert (plans / SPEC_FILENAME).read_text(encoding="utf-8") == "custom spec"
    assert (plans / TEMPLATE_FILENAME).read_text(encoding="utf-8") == "custom template"


def test_partial_install_fills_only_missing_files(tmp_path):
    plans = _plans_dir(tmp_path)
    plans.mkdir(parents=True)
    (plans / SPEC_FILENAME).write_text("custom spec", encoding="utf-8")

    assert ensure_plan_assets(str(tmp_path)) is True

    # Pre-existing spec untouched; missing template filled in.
    assert (plans / SPEC_FILENAME).read_text(encoding="utf-8") == "custom spec"
    tpl_text = (plans / TEMPLATE_FILENAME).read_text(encoding="utf-8")
    assert f"{tmp_path.name} · Plan" in tpl_text


def test_write_failure_is_swallowed(tmp_path, monkeypatch):
    def boom(self, *args, **kwargs):
        raise OSError("read-only file system")

    monkeypatch.setattr(Path, "write_text", boom)

    # Must not raise; reports the spec as unavailable.
    assert ensure_plan_assets(str(tmp_path)) is False


def test_missing_or_empty_workspace_returns_false(tmp_path):
    assert ensure_plan_assets("") is False
    assert ensure_plan_assets(str(tmp_path / "does-not-exist")) is False
    assert plan_spec_exists("") is False
    assert plan_spec_exists(str(tmp_path)) is False


def test_subdirectory_of_a_repo_provisions_into_the_repo_root(tmp_path):
    """Provisioning per opened folder is what scatters a project's plans."""
    (tmp_path / ".git").mkdir()
    subdir = tmp_path / "backend" / "src"
    subdir.mkdir(parents=True)

    assert ensure_plan_assets(str(subdir)) is True

    assert (_plans_dir(tmp_path) / SPEC_FILENAME).is_file()
    assert not (subdir / ".agent-team").exists()
    # The subdirectory reports the spec as present — same resolution both ways.
    assert plan_spec_exists(str(subdir)) is True


def test_a_container_folder_stays_its_own_plan_root(tmp_path):
    """No repository above it, so the folder the user opened is the root."""
    assert ensure_plan_assets(str(tmp_path)) is True
    assert (_plans_dir(tmp_path) / SPEC_FILENAME).is_file()
