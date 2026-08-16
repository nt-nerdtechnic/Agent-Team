"""Manifest v2 Host grant/binding enforcement tests."""

from __future__ import annotations

from agent_team_backend.plugins.capability_grants import (
    AuthenticatedRuntimeBinding,
    HostCapabilityGrant,
    authorize_host_request,
    inject_host_context,
)


def _context(
    *,
    eligible: bool = True,
    workspace: str | None = "ws-1",
    instance_id: str | None = "instance-1",
    audience: str | None = "audience-1",
):
    binding = AuthenticatedRuntimeBinding(
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        workspace_id=workspace,
        instance_id=instance_id,
        audience=audience,
    )
    grant = HostCapabilityGrant(
        package_version="1.0.0",
        system=("aiCli",),
    )
    return inject_host_context(
        publisher_eligible=eligible,
        user_grant=grant,
        runtime_binding=binding,
    )


def test_host_binding_is_the_only_source_of_identity() -> None:
    decision = authorize_host_request(
        _context(),
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="workspace",
        declared_system=("aiCli",),
        payload={"workspaceId": "attacker-workspace", "sessionOwner": "attacker"},
    )

    assert decision.allowed is False
    assert decision.code == "CAPABILITY_DENIED"


def test_nested_plugin_identity_fields_are_rejected() -> None:
    decision = authorize_host_request(
        _context(),
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="workspace",
        declared_system=("aiCli",),
        payload={"options": {"audience": "attacker-audience"}},
    )

    assert decision.allowed is False
    assert decision.code == "CAPABILITY_DENIED"


def test_missing_workspace_binding_fails_closed() -> None:
    decision = authorize_host_request(
        _context(workspace=None),
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="workspace",
        declared_system=("aiCli",),
    )

    assert decision.allowed is False
    assert decision.code == "WORKSPACE_SCOPE_VIOLATION"


def test_ai_cli_missing_instance_binding_fails_closed() -> None:
    decision = authorize_host_request(
        _context(instance_id=None),
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="workspace",
        declared_system=("aiCli",),
    )

    assert decision.allowed is False
    assert decision.code == "CAPABILITY_DENIED"


def test_ai_cli_missing_audience_binding_fails_closed() -> None:
    decision = authorize_host_request(
        _context(audience=None),
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="workspace",
        declared_system=("aiCli",),
    )

    assert decision.allowed is False
    assert decision.code == "CAPABILITY_DENIED"


def test_ai_cli_missing_instance_and_audience_fails_closed() -> None:
    decision = authorize_host_request(
        _context(instance_id=None, audience=None),
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="workspace",
        declared_system=("aiCli",),
    )

    assert decision.allowed is False
    assert decision.code == "CAPABILITY_DENIED"


def test_ai_cli_complete_binding_is_allowed() -> None:
    decision = authorize_host_request(
        _context(),
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="workspace",
        declared_system=("aiCli",),
    )

    assert decision.allowed is True
    assert decision.code is None


def test_first_party_eligibility_does_not_bypass_user_grant() -> None:
    context = inject_host_context(
        publisher_eligible=True,
        user_grant=None,
        runtime_binding=_context().runtime_binding,
    )
    decision = authorize_host_request(
        context,
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="workspace",
        declared_system=("aiCli",),
    )

    assert decision.allowed is False
    assert decision.code == "CAPABILITY_DENIED"


def test_full_shell_requires_high_risk_confirmation() -> None:
    base = _context()
    grant = HostCapabilityGrant(
        package_version="1.0.0",
        system=(),
        shell="full",
    )
    context = inject_host_context(
        publisher_eligible=False,
        user_grant=grant,
        runtime_binding=base.runtime_binding,
    )
    decision = authorize_host_request(
        context,
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="shell",
        scope="workspace",
        declared_shell="full",
    )

    assert decision.allowed is False
    assert decision.code == "CAPABILITY_DENIED"


def test_unknown_shell_mode_fails_closed() -> None:
    base = _context()
    decision = authorize_host_request(
        base,
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="shell",
        scope="workspace",
        declared_shell="unrestricted",
    )

    assert decision.allowed is False
    assert decision.code == "CAPABILITY_DENIED"


def test_ai_cli_cannot_be_rebound_to_plugin_scope() -> None:
    decision = authorize_host_request(
        _context(),
        plugin_id="acme.ai-cli",
        package_version="1.0.0",
        namespace="aiCli",
        scope="plugin",
        declared_system=("aiCli",),
    )

    assert decision.allowed is False
    assert decision.code == "METHOD_NOT_FOUND"
