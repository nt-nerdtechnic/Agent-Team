"""Which vendors the quota poll covers.

The poll used to iterate a hardcoded PROVIDERS tuple in usage_service. That
made adding a vendor a two-file change — declare `fetch_usage`, then remember
to edit a shared module — which is exactly what docs/adding-a-cli-vendor.md
promises you never have to do, and nothing caught the omission.

Iteration now derives from the specs, so adding a vendor needs no edit there.
The protection the tuple did provide — a fetch quietly disappearing and its
vendor dropping out of the poll unnoticed — moves here, where the expected set
is pinned explicitly.
"""

from __future__ import annotations

from agent_team_backend import usage_service
from agent_team_backend.cli_vendors.registry import VENDORS

# Vendors that expose a quota interface. Update deliberately: removing a name
# means that CLI's usage badge stops updating.
EXPECTED_USAGE_VENDORS = {
    "antigravity",
    "codex",
    "copilot",
    "cursor",
    "grok",
    "kilo",
    "kimi",
    "opencode",
    "pi",
    "qwen",
}


def test_vendors_declaring_fetch_usage_are_exactly_the_expected_set() -> None:
    declared = {k for k, s in VENDORS.items() if s.fetch_usage is not None}

    assert declared == EXPECTED_USAGE_VENDORS


def test_claude_is_polled_but_not_through_fetch_usage() -> None:
    # Claude is the one vendor polled per credential slot rather than once,
    # so it runs ahead of the loop and deliberately declares no fetch_usage.
    # If it ever gains one, the loop would poll it a second time.
    assert VENDORS["claude"].fetch_usage is None


def test_aider_and_muse_declare_no_quota_interface() -> None:
    # Not an oversight: neither CLI has a quota to report.
    assert VENDORS["aider"].fetch_usage is None
    assert VENDORS["muse"].fetch_usage is None


def test_no_hardcoded_provider_list_remains() -> None:
    # Guards the fix itself: a reintroduced module-level list of vendor names
    # would silently re-create the two-file requirement.
    assert not hasattr(usage_service, "PROVIDERS")
