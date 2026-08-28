"""plan_meta: JSON island parse/serialize + visible-markup sync."""

from __future__ import annotations

import json
from typing import Any

from agent_team_backend.plugins.builtin.navide_plans import plan_meta


def _meta(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "schemaVersion": 1,
        "name": "Test Plan",
        "overview": "A test plan.",
        "stage": "draft",
        "approvedAt": None,
        "todos": [
            {"id": "phase-a", "content": "Build the thing", "status": "pending"},
            {"id": "phase-b", "content": "Test the thing", "status": "pending"},
        ],
        "reviewNotes": [
            {"id": "n1", "author": "ai", "text": "Looks fine.", "resolved": False, "reply": ""},
        ],
    }
    base.update(overrides)
    return base


def _todo_li(todo: dict[str, Any]) -> str:
    return (
        f'        <li data-status="{todo["status"]}" data-todo-id="{todo["id"]}">\n'
        f'          <span class="st">{todo["status"]}</span>\n'
        f'          <span>{todo["content"]}</span>\n'
        f"        </li>"
    )


def _note_li(note: dict[str, Any]) -> str:
    resolved = "true" if note["resolved"] else "false"
    return (
        f'        <li data-note-id="{note["id"]}" data-resolved="{resolved}">\n'
        f'          <span class="who">{note["author"]}</span>{note["text"]}\n'
        f"        </li>"
    )


def _plan_html(meta: dict[str, Any]) -> str:
    """Canonical plan document: island serialized exactly as write_plan_meta
    would emit it, so an unchanged round-trip is byte-identical."""
    island = json.dumps(meta, indent=2, ensure_ascii=False).replace("<", "\\u003c")
    todos = "\n".join(_todo_li(t) for t in meta["todos"])
    notes = "\n".join(_note_li(n) for n in meta["reviewNotes"])
    return (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        f"<title>{meta['name']}</title>\n"
        '<script type="application/json" id="plan-meta">\n'
        f"{island}\n"
        "</script>\n"
        "<style>\n"
        "  .pill.draft { background: grey; }\n"
        '  li[data-status="pending"] .st { background: silver; }\n'
        "</style>\n"
        "</head>\n"
        "<body>\n"
        '<div class="wrap">\n'
        "<header>\n"
        f'  <h1>{meta["name"]}<span class="pill {meta["stage"]}">{meta["stage"]}</span></h1>\n'
        f"  <p class=\"overview\">{meta['overview']}</p>\n"
        "</header>\n"
        "<section>\n"
        "  <h2>Todos</h2>\n"
        '  <ul class="todos">\n'
        f"{todos}\n"
        "  </ul>\n"
        "</section>\n"
        "<section>\n"
        "  <h2>Review Notes</h2>\n"
        '  <ul class="notes">\n'
        f"{notes}\n"
        "  </ul>\n"
        "</section>\n"
        "</div>\n"
        "</body>\n"
        "</html>\n"
    )


# ── parse_plan_meta ──────────────────────────────────────────────────────


def test_parse_valid_island() -> None:
    meta = _meta()
    parsed = plan_meta.parse_plan_meta(_plan_html(meta))
    assert parsed == meta


def test_parse_single_quoted_id() -> None:
    html = _plan_html(_meta()).replace('id="plan-meta"', "id='plan-meta'")
    parsed = plan_meta.parse_plan_meta(html)
    assert parsed is not None
    assert parsed["name"] == "Test Plan"


def test_parse_missing_island() -> None:
    assert plan_meta.parse_plan_meta("<html><body>plain doc</body></html>") is None


def test_parse_malformed_json() -> None:
    html = '<script type="application/json" id="plan-meta">{nope</script>'
    assert plan_meta.parse_plan_meta(html) is None


def test_parse_non_object_json() -> None:
    html = '<script type="application/json" id="plan-meta">[1, 2]</script>'
    assert plan_meta.parse_plan_meta(html) is None


def test_parse_does_not_match_data_id() -> None:
    html = '<script type="application/json" data-id="plan-meta">{"stage": "draft"}</script>'
    assert plan_meta.parse_plan_meta(html) is None


# ── write_plan_meta: round-trip ──────────────────────────────────────────


def test_round_trip_unchanged_meta_is_byte_identical() -> None:
    html = _plan_html(_meta())
    parsed = plan_meta.parse_plan_meta(html)
    assert parsed is not None
    assert plan_meta.write_plan_meta(html, parsed) == html


def test_write_without_island_returns_input_unchanged() -> None:
    html = "<html><body>plain doc</body></html>"
    assert plan_meta.write_plan_meta(html, _meta()) == html


# ── write_plan_meta: stage sync ──────────────────────────────────────────


def test_write_stage_updates_island_and_pill() -> None:
    html = _plan_html(_meta())
    meta = plan_meta.parse_plan_meta(html)
    assert meta is not None
    meta["stage"] = "approved"
    out = plan_meta.write_plan_meta(html, meta)
    reparsed = plan_meta.parse_plan_meta(out)
    assert reparsed is not None
    assert reparsed["stage"] == "approved"
    assert '<span class="pill approved">approved</span>' in out
    assert '<span class="pill draft">' not in out
    # The CSS rule mentioning .pill.draft is not a <span> and stays untouched.
    assert ".pill.draft { background: grey; }" in out


def test_write_unknown_stage_updates_island_but_not_pill() -> None:
    html = _plan_html(_meta())
    meta = plan_meta.parse_plan_meta(html)
    assert meta is not None
    meta["stage"] = "not-a-stage"
    out = plan_meta.write_plan_meta(html, meta)
    reparsed = plan_meta.parse_plan_meta(out)
    assert reparsed is not None
    assert reparsed["stage"] == "not-a-stage"
    assert '<span class="pill draft">draft</span>' in out


# ── write_plan_meta: todo sync ───────────────────────────────────────────


def test_write_todo_status_updates_li_and_st_span() -> None:
    html = _plan_html(_meta())
    meta = plan_meta.parse_plan_meta(html)
    assert meta is not None
    meta["todos"][1]["status"] = "done"
    out = plan_meta.write_plan_meta(html, meta)
    assert '<li data-status="done" data-todo-id="phase-b">' in out
    assert out.count('<span class="st">done</span>') == 1
    # The other todo row is untouched.
    assert '<li data-status="pending" data-todo-id="phase-a">' in out
    reparsed = plan_meta.parse_plan_meta(out)
    assert reparsed is not None
    assert reparsed["todos"][1]["status"] == "done"


def test_write_todo_without_matching_markup_is_best_effort() -> None:
    meta = _meta()
    meta["todos"].append({"id": "ghost", "content": "no markup", "status": "done"})
    html = _plan_html(_meta())  # markup only has phase-a / phase-b
    out = plan_meta.write_plan_meta(html, meta)
    reparsed = plan_meta.parse_plan_meta(out)
    assert reparsed is not None
    assert reparsed["todos"][2]["id"] == "ghost"
    assert "ghost" not in out.split('id="plan-meta"')[0]  # island only, no markup invented


# ── write_plan_meta: review note sync ────────────────────────────────────


def test_write_note_resolved_updates_data_resolved() -> None:
    html = _plan_html(_meta())
    meta = plan_meta.parse_plan_meta(html)
    assert meta is not None
    meta["reviewNotes"][0]["resolved"] = True
    out = plan_meta.write_plan_meta(html, meta)
    assert '<li data-note-id="n1" data-resolved="true">' in out
    reparsed = plan_meta.parse_plan_meta(out)
    assert reparsed is not None
    assert reparsed["reviewNotes"][0]["resolved"] is True


# ── write_plan_meta: preservation ────────────────────────────────────────


def test_unknown_fields_preserved_through_write() -> None:
    meta = _meta(customField={"nested": [1, 2, 3]}, executions=[{"agent": "claude", "startedAt": "x"}])
    meta["todos"][0]["extra"] = "keep-me"
    html = _plan_html(_meta())
    out = plan_meta.write_plan_meta(html, meta)
    reparsed = plan_meta.parse_plan_meta(out)
    assert reparsed == meta


def test_surrounding_html_untouched_by_write() -> None:
    html = _plan_html(_meta())
    meta = plan_meta.parse_plan_meta(html)
    assert meta is not None
    meta["approvedAt"] = "2026-07-26T00:00:00Z"  # meta-only change, no markup sync target
    out = plan_meta.write_plan_meta(html, meta)
    # Everything before the island's inner JSON and after </script> is identical.
    assert out.split('id="plan-meta">')[0] == html.split('id="plan-meta">')[0]
    assert out.split("</script>", 1)[1] == html.split("</script>", 1)[1]


def test_script_terminator_in_meta_is_escaped() -> None:
    html = _plan_html(_meta())
    meta = plan_meta.parse_plan_meta(html)
    assert meta is not None
    meta["overview"] = "sneaky </script> <!-- injection"
    out = plan_meta.write_plan_meta(html, meta)
    # Exactly one </script> closes the island; the payload's "<" is escaped.
    island = plan_meta._PLAN_META_RE.search(out)
    assert island is not None
    assert "\\u003c" in island.group(1)
    reparsed = plan_meta.parse_plan_meta(out)
    assert reparsed is not None
    assert reparsed["overview"] == "sneaky </script> <!-- injection"


def test_non_ascii_preserved_unescaped() -> None:
    meta = _meta(name="測試計畫", overview="中文概述")
    html = _plan_html(meta)
    out = plan_meta.write_plan_meta(html, meta)
    assert '"name": "測試計畫"' in out
    reparsed = plan_meta.parse_plan_meta(out)
    assert reparsed is not None
    assert reparsed["overview"] == "中文概述"
