"""fs_service — path safety + list_dir(show_hidden) + CRUD round-trips."""

from __future__ import annotations

import base64
import stat
from pathlib import Path

from agent_team_backend import fs_service


def _ws(tmp_path: Path) -> str:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.ts").write_text("x", encoding="utf-8")
    (tmp_path / "README.md").write_text("hi", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=1", encoding="utf-8")
    (tmp_path / ".agent-team").mkdir()
    (tmp_path / ".agent-team" / "project.json").write_text("{}", encoding="utf-8")
    return str(tmp_path)


# ── Path safety ─────────────────────────────────────────────────────────────
def test_list_rejects_parent_escape(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "../..")
    assert res["ok"] is False
    assert "escape" in res["error"].lower()


def test_list_rejects_absolute_escape(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "/etc")
    # leading slash is stripped → resolves to <ws>/etc which does not exist
    assert res["ok"] is False


def test_internal_dir_is_protected(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), ".agent-team")
    assert res["ok"] is False
    assert "protected" in res["error"].lower()


def test_no_workspace(tmp_path: Path) -> None:
    assert fs_service.list_dir("", "")["ok"] is False


# ── .agent-team/plans exemption ─────────────────────────────────────────────
def _ws_with_plans(tmp_path: Path) -> str:
    ws = _ws(tmp_path)
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir()
    (plans / "_spec.md").write_text("spec", encoding="utf-8")
    (plans / "my-plan.html").write_text("<h1>plan</h1>", encoding="utf-8")
    return ws


def test_plans_subtree_list_allowed(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws_with_plans(tmp_path), ".agent-team/plans")
    assert res["ok"] is True
    names = [e["name"] for e in res["entries"]]
    assert "my-plan.html" in names


def test_plans_subtree_read_allowed(tmp_path: Path) -> None:
    res = fs_service.read_file(_ws_with_plans(tmp_path), ".agent-team/plans/my-plan.html")
    assert res["ok"] is True
    assert res["content"] == "<h1>plan</h1>"


def test_reports_subtree_allowed(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    reports = tmp_path / ".agent-team" / "reports"
    reports.mkdir()
    (reports / "report.html").write_text("<h1>report</h1>", encoding="utf-8")

    res = fs_service.read_file(ws, ".agent-team/reports/report.html")
    assert res["ok"] is True
    assert res["content"] == "<h1>report</h1>"

    list_res = fs_service.list_dir(ws, ".agent-team/reports")
    assert list_res["ok"] is True
    assert "report.html" in [e["name"] for e in list_res["entries"]]


def test_plans_subtree_write_allowed(tmp_path: Path) -> None:
    ws = _ws_with_plans(tmp_path)
    assert fs_service.write_file(ws, ".agent-team/plans/new.html", "<p>x</p>")["ok"] is True
    assert (tmp_path / ".agent-team" / "plans" / "new.html").read_text() == "<p>x</p>"


def test_plans_subtree_delete_allowed(tmp_path: Path, monkeypatch) -> None:
    _fake_trash(monkeypatch)
    ws = _ws_with_plans(tmp_path)
    assert fs_service.delete(ws, ".agent-team/plans/my-plan.html")["ok"] is True
    assert not (tmp_path / ".agent-team" / "plans" / "my-plan.html").exists()


def test_agent_team_root_still_protected_with_plans(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws_with_plans(tmp_path), ".agent-team")
    assert res["ok"] is False
    assert "protected" in res["error"].lower()


def test_agent_team_sibling_still_protected(tmp_path: Path) -> None:
    res = fs_service.read_file(_ws_with_plans(tmp_path), ".agent-team/project.json")
    assert res["ok"] is False
    assert "protected" in res["error"].lower()


def test_plans_traversal_still_protected(tmp_path: Path) -> None:
    ws = _ws_with_plans(tmp_path)
    for op, rel in (
        ("read", ".agent-team/plans/../project.json"),
        ("write", ".agent-team/plans/../evil.json"),
        ("delete", ".agent-team/plans/../project.json"),
    ):
        if op == "read":
            res = fs_service.read_file(ws, rel)
        elif op == "write":
            res = fs_service.write_file(ws, rel, "x")
        else:
            res = fs_service.delete(ws, rel)
        assert res["ok"] is False, f"{op} {rel} should be blocked"
        assert "protected" in res["error"].lower()


def test_internal_dir_protected_when_named_as_the_root(tmp_path: Path) -> None:
    """Rooting at .agent-team itself must not step around the guard.

    Any existing directory is accepted as a root (that is how files outside a
    workspace are opened), so a root of `<ws>/.agent-team` would leave a
    root-relative check inspecting a filename where it expects the internal dir.
    """
    _ws_with_plans(tmp_path)
    internal = str(tmp_path / ".agent-team")
    for res in (
        fs_service.read_file(internal, "project.json"),
        fs_service.list_dir(internal, ""),
        fs_service.write_file(internal, "evil.json", "x"),
    ):
        assert res["ok"] is False
        assert "protected" in res["error"].lower()


def test_plans_subtree_still_reachable_when_named_as_the_root(tmp_path: Path) -> None:
    """The user-facing subtrees stay open however the root is expressed."""
    _ws_with_plans(tmp_path)
    plans = str(tmp_path / ".agent-team" / "plans")
    assert fs_service.read_file(plans, "my-plan.html")["ok"] is True
    assert fs_service.list_dir(plans, "")["ok"] is True


# ── list_dir + show_hidden ──────────────────────────────────────────────────
def test_list_hides_dotfiles_by_default(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "")
    assert res["ok"] is True
    names = [e["name"] for e in res["entries"]]
    assert "src" in names and "README.md" in names
    assert ".env" not in names           # hidden by default
    assert ".agent-team" not in names     # always excluded


def test_list_show_hidden_includes_dotfiles_but_not_internal(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "", show_hidden=True)
    names = [e["name"] for e in res["entries"]]
    assert ".env" in names
    assert ".agent-team" not in names     # internal dir still hidden
    env = next(e for e in res["entries"] if e["name"] == ".env")
    assert env["is_hidden"] is True


def test_list_dirs_before_files(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "")
    kinds = [e["is_dir"] for e in res["entries"]]
    # all dirs come before all files
    assert kinds == sorted(kinds, reverse=True)


def test_noise_segment_flagged(tmp_path: Path) -> None:
    (tmp_path / "node_modules").mkdir()
    res = fs_service.list_dir(_ws(tmp_path), "")
    nm = next(e for e in res["entries"] if e["name"] == "node_modules")
    assert nm["is_noise"] is True


# ── CRUD ────────────────────────────────────────────────────────────────────
def test_create_file_and_list(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.create_file(ws, "src/new.ts", "// hi")["ok"] is True
    assert (Path(ws) / "src" / "new.ts").read_text() == "// hi"
    # duplicate fails
    assert fs_service.create_file(ws, "src/new.ts")["ok"] is False


def test_mkdir(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.mkdir(ws, "src/sub")["ok"] is True
    assert (Path(ws) / "src" / "sub").is_dir()


def test_rename(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.rename(ws, "README.md", "README2.md")["ok"] is True
    assert not (Path(ws) / "README.md").exists()
    assert (Path(ws) / "README2.md").exists()


def test_rename_into_internal_is_blocked(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.rename(ws, "README.md", ".agent-team/x.md")
    assert res["ok"] is False


def _fake_trash(monkeypatch) -> list[str]:
    """Patch send2trash so tests don't move files into the developer's real
    Trash; the fake actually removes the path so 'gone from disk' still holds.
    Returns the list of paths it was called with."""
    import shutil as _shutil

    calls: list[str] = []

    def fake(path: str) -> None:
        calls.append(path)
        p = Path(path)
        if p.is_dir():
            _shutil.rmtree(p)
        else:
            p.unlink()

    monkeypatch.setattr(fs_service, "send2trash", fake)
    return calls


def test_delete_file(tmp_path: Path, monkeypatch) -> None:
    _fake_trash(monkeypatch)
    ws = _ws(tmp_path)
    assert fs_service.delete(ws, "README.md")["ok"] is True
    assert not (Path(ws) / "README.md").exists()


def test_delete_nonempty_dir_ok(tmp_path: Path, monkeypatch) -> None:
    _fake_trash(monkeypatch)
    ws = _ws(tmp_path)
    res = fs_service.delete(ws, "src")  # contains main.ts
    assert res["ok"] is True
    assert not (Path(ws) / "src").exists()


def test_delete_empty_dir_ok(tmp_path: Path, monkeypatch) -> None:
    _fake_trash(monkeypatch)
    ws = _ws(tmp_path)
    fs_service.mkdir(ws, "emptydir")
    assert fs_service.delete(ws, "emptydir")["ok"] is True


def test_delete_sends_resolved_path_to_trash(tmp_path: Path, monkeypatch) -> None:
    """delete routes the resolved absolute target to send2trash rather than
    hard-removing it, so the file is recoverable from the OS Trash."""
    calls = _fake_trash(monkeypatch)
    ws = _ws(tmp_path)
    assert fs_service.delete(ws, "README.md")["ok"] is True
    assert calls == [str((Path(ws) / "README.md").resolve())]


def test_delete_preserves_targets_when_trash_unavailable(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    """If the trash is unavailable, delete returns an error and preserves the
    original file or directory so the operation remains recoverable."""
    def boom(path: str) -> None:
        raise OSError("no trash here")

    monkeypatch.setattr(fs_service, "send2trash", boom)
    ws = _ws(tmp_path)
    with caplog.at_level("WARNING"):
        file_result = fs_service.delete(ws, "README.md")
        dir_result = fs_service.delete(ws, "src")
    assert file_result == {"ok": False, "error": "no trash here"}
    assert dir_result == {"ok": False, "error": "no trash here"}
    assert (Path(ws) / "README.md").read_text(encoding="utf-8") == "hi"
    assert (Path(ws) / "src" / "main.ts").read_text(encoding="utf-8") == "x"
    assert sum("keeping original" in r.message for r in caplog.records) == 2


# ── read / write (editor) ────────────────────────────────────────────────────
def test_read_file(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.read_file(ws, "README.md")
    assert res["ok"] is True and res["content"] == "hi"


def test_read_file_returns_mtime(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.read_file(ws, "README.md")
    assert res["ok"] is True
    assert res["mtime"] == (Path(ws) / "README.md").stat().st_mtime


def test_read_file_rejects_oversized(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    size = fs_service._READ_SIZE_LIMIT + 1
    with (Path(ws) / "large.txt").open("wb") as fh:
        fh.truncate(size)

    res = fs_service.read_file(ws, "large.txt")

    assert res["ok"] is False
    assert "file too large" in res["error"]
    assert res["is_binary"] is False
    assert res["size"] == size


def test_read_large_pdf_is_classified_as_binary(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    size = 10 * 1024 * 1024 + 1
    pdf = Path(ws) / "large.pdf"
    with pdf.open("wb") as fh:
        fh.truncate(size)

    res = fs_service.read_file(ws, "large.pdf")

    assert res["ok"] is False
    assert res["error"] == "binary file"
    assert res["is_binary"] is True
    assert res["size"] == size


def test_read_file_rejects_escape(tmp_path: Path) -> None:
    assert fs_service.read_file(_ws(tmp_path), "../../etc/hosts")["ok"] is False


def test_write_file_roundtrip(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.write_file(ws, "src/main.ts", "// edited")["ok"] is True
    assert (Path(ws) / "src" / "main.ts").read_text() == "// edited"
    assert fs_service.read_file(ws, "src/main.ts")["content"] == "// edited"


def test_write_file_blocks_internal_dir(tmp_path: Path) -> None:
    assert fs_service.write_file(_ws(tmp_path), ".agent-team/x", "y")["ok"] is False


def test_write_file_returns_mtime(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "src/main.ts", "// edited")
    assert res["ok"] is True
    assert res["mtime"] == (Path(ws) / "src" / "main.ts").stat().st_mtime


def test_write_file_custom_encoding(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "big5.txt", "中文", encoding="big5")
    assert res["ok"] is True
    assert (Path(ws) / "big5.txt").read_bytes() == "中文".encode("big5")


def test_write_file_accepts_display_label(tmp_path: Path) -> None:
    # read_file returns display labels ("UTF-8 with BOM"); write_file must
    # accept them back so the encoding round-trips.
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "bom.txt", "hi", encoding="UTF-8 with BOM")
    assert res["ok"] is True
    assert (Path(ws) / "bom.txt").read_bytes() == b"\xef\xbb\xbfhi"


def test_write_file_unknown_encoding_errors(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "x.txt", "hi", encoding="no-such-codec")
    assert res["ok"] is False
    assert "cannot encode" in res["error"]
    assert not (Path(ws) / "x.txt").exists()


def test_write_file_unencodable_content_errors(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "x.txt", "中文", encoding="ascii")
    assert res["ok"] is False
    assert "cannot encode" in res["error"]
    assert not (Path(ws) / "x.txt").exists()


def test_write_file_mtime_conflict_refuses_write(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    target = Path(ws) / "README.md"
    stale = target.stat().st_mtime - 10.0
    res = fs_service.write_file(ws, "README.md", "clobber", expected_mtime=stale)
    assert res["ok"] is False
    assert res["conflict"] is True
    assert res["error"] == "file changed on disk"
    assert res["mtime"] == target.stat().st_mtime
    assert target.read_text() == "hi"  # untouched


def test_write_file_matching_mtime_writes(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    target = Path(ws) / "README.md"
    res = fs_service.write_file(
        ws, "README.md", "new", expected_mtime=target.stat().st_mtime
    )
    assert res["ok"] is True
    assert target.read_text() == "new"


def test_write_file_expected_mtime_ignored_for_new_file(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "brand-new.txt", "x", expected_mtime=123.0)
    assert res["ok"] is True
    assert (Path(ws) / "brand-new.txt").read_text() == "x"


def test_write_file_preserves_mode(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    script = Path(ws) / "run.sh"
    script.write_text("#!/bin/sh\n", encoding="utf-8")
    script.chmod(0o755)
    res = fs_service.write_file(ws, "run.sh", "#!/bin/sh\necho hi\n")
    assert res["ok"] is True
    assert stat.S_IMODE(script.stat().st_mode) == 0o755


# ── read_image ────────────────────────────────────────────────────────────────

# Smallest valid PNG: a 1x1 transparent pixel.
_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def test_read_image_returns_data_url(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (Path(ws) / "pic.png").write_bytes(_PNG_1X1)
    res = fs_service.read_image(ws, "pic.png")
    assert res["ok"] is True
    assert res["mime"] == "image/png"
    assert res["data_url"].startswith("data:image/png;base64,")
    assert res["size"] == len(_PNG_1X1)


def test_read_image_under_size_limit_ok(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    image = _PNG_1X1 + b"\0" * (10 * 1024 * 1024)  # 10 MB — below the 20 MB cap
    (Path(ws) / "large.png").write_bytes(image)

    res = fs_service.read_image(ws, "large.png")

    assert res["ok"] is True
    assert res["size"] == len(image)
    assert res["data_url"].startswith("data:image/png;base64,")


def test_read_image_rejects_oversized(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    with (Path(ws) / "huge.png").open("wb") as fh:
        fh.truncate(fs_service._IMAGE_SIZE_LIMIT + 1)

    res = fs_service.read_image(ws, "huge.png")

    assert res["ok"] is False
    assert "image too large" in res["error"]


def test_read_image_rejects_non_image(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.read_image(ws, "README.md")
    assert res["ok"] is False
    assert "not an image" in res["error"]


def test_read_image_missing_file(tmp_path: Path) -> None:
    res = fs_service.read_image(_ws(tmp_path), "nope.png")
    assert res["ok"] is False


def test_read_image_rejects_escape(tmp_path: Path) -> None:
    assert fs_service.read_image(_ws(tmp_path), "../../etc/secret.png")["ok"] is False


def test_stat_path_expands_home(tmp_path: Path, monkeypatch) -> None:
    """Terminal output prints '~/...' paths verbatim; stat must expand them."""
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "cert.pem").write_text("x", encoding="utf-8")
    assert fs_service.stat_path("~/cert.pem") == {"ok": True, "exists": True}
    assert fs_service.stat_path("~/missing.pem") == {"ok": True, "exists": False}
