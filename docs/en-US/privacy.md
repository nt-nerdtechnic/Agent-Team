# Privacy and Data Flows

English | [繁體中文](../zh-TW/privacy.md) | [日本語](../ja-JP/privacy.md) | [Documentation](README.md)

Navide is **local-first**, not universally offline. Its Electron application, Python backend, terminal sessions, private project intelligence, workspace state, and orchestration logic run on your Mac. Data can leave the machine when you enable or use an external service.

## Data kept locally by Navide

Depending on enabled features, Navide stores:

- Private per-user project intelligence and run artifacts under `<workspace>/.agent-team/`
- Roles, pipelines, recent workspaces, UI settings, analyzer settings, and AI provider settings in the application data directory
- Token-attribution and deduplication metadata derived from local CLI logs
- Optional AI provider API keys in a local settings file protected with restrictive file permissions (`0600` on supported systems)

Navide does not operate a project telemetry service and does not require a Navide account.

## Private project intelligence

`.agent-team/` belongs to the individual user of that local workspace. It is excluded from Git and is not intended to synchronize state between human team members. It can contain private prompts, task context, session identifiers, agent output, run events, handoffs, token summaries, and future coordination metadata.

Do not remove `.agent-team/` from `.gitignore` or publish it as a substitute for intentionally authored project documentation. If an artifact must be shared, review and export only the specific specification, decision, report, patch, or evidence required.

A future portability feature should use explicit local export/import with redaction and selection controls. Navide must not silently turn private project intelligence into cloud or repository state.

## Features that may communicate externally

| Feature | Possible recipient | Data involved |
|---|---|---|
| Coding-agent CLI | The CLI vendor or configured model provider | Prompts, selected context, tool results, and provider-defined telemetry |
| Cloud AI (inline editing and code review) | Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, xAI, or a custom endpoint | Selected code, prompts, and model parameters |
| Context7 injection | Context7 and its MCP distribution/runtime dependencies | Detected library names and documentation queries |
| Web search | Search provider | Search query text |
| Git operations | Configured Git host | Repository data and credentials handled by Git or the host flow |
| Update checks | GitHub Releases | Application version and normal network metadata |
| Plugin Registry trust refresh | The selected Official Registry or an explicitly approved self-hosted Registry | The namespace/name of an installed marketplace plugin; no plugin source or archive is sent by the refresh |
| MCP servers | The configured MCP server and any service it uses | Depends entirely on that server's tools and configuration |

Read each provider's policy before sending private code or regulated data.

While an installed marketplace plugin is present, Navide sends that plugin's
namespace/name to its selected Registry when the app starts and every 15
minutes. The request retrieves signed trust metadata so Navide can detect
revoked publishers or packages and quarantine an installed plugin. The
destination is the App-pinned Official Registry when the Official URL is used,
or the exact self-hosted URL and root that the user explicitly approved. This
refresh does not upload plugin source, package archives, or workspace files.

Navide retains the latest signed trust snapshot locally with the plugin
installation so restart checks can continue; the Registry controls retention
of its own request logs. There is no separate refresh toggle today. Removing
the installed marketplace plugins stops this flow; other external-service
flows are governed by their own settings and configuration.

## Credentials

Agent CLI credentials remain in each CLI's own configuration. If you enter cloud AI keys in Navide, Navide stores them locally so AI features (inline editing, code review) can use them. Settings export redacts API keys and tokens.

Local file permissions reduce accidental access by other users on the same machine but do not protect against malware, a compromised user account, unrestricted agents, backups, or processes with equivalent permissions.

## Agent permissions

Agents run with the current user's operating-system permissions unless the external CLI provides and enables its own sandbox. Navide does not currently provide a complete workspace sandbox.

YOLO mode may bypass CLI confirmation or sandbox protections. Use it only in trusted, version-controlled workspaces and review commands and diffs afterward.

## Context handoffs

Cross-agent handoffs can include task context and prior-stage output. Automatic secret scrubbing is not yet a complete security boundary. Do not place credentials in prompts, generated plans, logs, or files that may be handed to another agent.

## Removing local data

Private project intelligence can be removed from the workspace's `.agent-team/` directory after active sessions are stopped. Deleting it can remove resumability, run history, attribution, and accumulated context without deleting the source repository. Application-wide settings and histories live in the Navide application data directory. Back up any configuration you intend to preserve before deletion.

For vulnerability reporting, see the [Security Policy](../../SECURITY.md).
