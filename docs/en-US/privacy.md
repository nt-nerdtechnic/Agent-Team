# Privacy and Data Flows

English | [繁體中文](../zh-TW/privacy.md) | [日本語](../ja-JP/privacy.md) | [Documentation](README.md)

Navide is **local-first**, not universally offline. Its Electron application, Python backend, terminal sessions, private project intelligence, workspace state, and orchestration logic run on your Mac. Data can leave the machine when you enable or use an external service.

## Data kept locally by Navide

Depending on enabled features, Navide stores:

- Private per-user project intelligence and run artifacts under `<workspace>/.agent-team/`
- Roles, pipelines, recent workspaces, UI settings, analyzer settings, and AI provider settings in the application data directory
- Host-managed plugin storage partitions in the application data directory;
  these are keyed by authenticated plugin/package and, for workspace scope, by
  authenticated workspace, and are not sent to Navide or plugin registries
- Token-attribution and deduplication metadata derived from local CLI logs
- Optional AI provider API keys in a local settings file protected with restrictive file permissions (`0600` on supported systems)

Navide does not operate a project telemetry service and does not require a Navide account.

When the Issue 16 production storage integration is enabled, uninstalling a
plugin removes its local storage after the cleanup step succeeds. A later
reinstall does not restore that deleted storage. Ordinary third-party
production plugin calls remain denied until their later grant/context
integration is enabled. The first-party `navide.git` migration is an explicit
Host-owned consumer: its Git preferences use the authenticated package and
workspace storage partitions, and an upgrade can clone the prior active
snapshot into the new candidate while retaining the old snapshot for
rollback.

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
| Git operations and Issue detection | Configured Git host, through local `git`, `gh`, or `glab` CLIs | Repository and Issue data, plus credentials handled by the CLI or Host account flow |
| Update checks | GitHub Releases | Application version and normal network metadata |
| Plugin Registry trust refresh | The selected Official Registry or an explicitly approved self-hosted Registry | The namespace/name of an installed marketplace plugin; no plugin source or archive is sent by the refresh |
| MCP servers | The configured MCP server and any service it uses | Depends entirely on that server's tools and configuration |

Read each provider's policy before sending private code or regulated data.

### Cross-device messaging

When you sign in to a Navide account and address a pane on another device, the
message body is sealed for that device's public key before it leaves. Navide’s
relay stores and forwards it without being able to read it — it holds no
corresponding private key.

What the relay *does* see is the metadata around the message: the sending and
receiving device ids, the workspace label and pane name on both ends, delivery
state, and timestamps. It also holds the session directory, which is how devices
find each other at all.

The absolute filesystem path of a workspace is **not** published. It used to be:
the session directory carried `workspacePath` verbatim, which in practice meant
the whole local path including your account name. Devices now publish a salted
digest instead. The salt is generated per install, kept in the local credential
vault, and never leaves the machine — so the digest is stable enough to group
panes from one workspace and cannot be turned back into a path by the relay or
by another device. An unsalted digest would not be enough here, because a path
is short and highly structured and would fall to a dictionary.

The workspace *label* (the folder's basename) and the pane name do remain
readable. They are the two halves of the `<device>/<workspace>/<pane>` address a
remote agent has to type, so hiding them would remove cross-device addressing by
name rather than protecting it. Reducing them further needs a user-chosen alias.

The production Git package invokes `git`, `gh`, and `glab` locally through a
Host-owned argv allowlist. Navide does not proxy those services or upload the
repository to Navide. GitHub or GitLab may still receive data when the local
CLI performs a remote operation or Issue query, according to the configured
remote, CLI login, and provider policy. Git account credentials remain in the
Host's protected local account store or the CLI's own credential flow; they are
not written into plugin-renderer storage. The isolated v2 Git renderer receives
only non-secret account metadata and workspace binding state. For a remote Git
operation, the Host injects the bound credential immediately before the backend
call. When no Host account is bound to the workspace, v2 can still use an
interactive credential flow owned by the Host: the Host creates an opaque,
instance-bound owner for that operation, forwards Git's prompts to the exact
originating Git view, and validates request ownership before accepting a
response. The entered secret is held only for that exchange and is never
persisted in plugin storage. A credential response from another view or for a
different workspace is rejected.

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

## Local ports and files opened for agent CLIs

Some CLIs accept an inter-CLI message through a channel other than their terminal input. Navide gives those panes what that channel needs at launch, all of it on this machine: a loopback-only HTTP port the CLI itself serves (`opencode`, `kilo`), or a per-pane file in the Navide application data directory that the CLI watches. Nothing here leaves the machine.

An `opencode` pane's port carries no password, because that CLI's own interface cannot authenticate against its own server. Any process running as you can therefore drive that pane. A `kilo` pane's port is protected by a per-pane secret passed in its environment.

A `qwen` pane's file holds the text of each message sent to it in the clear. It is removed when the pane closes, and any file an interrupted backend left behind is removed the next time Navide starts.

A `claude` pane's channel is a hook in that CLI's own settings file instead. It carries a secret Navide keeps in one owner-only file in its application data directory, which marks the hook as one this machine installed; it is not readable by other users and never leaves the machine.

Every one of these is per CLI and can be switched off in Settings → CLI Agents → Push channels, after which messages to those panes are typed into the terminal as before. See [Inter-CLI messaging](inter-cli-messaging.md) for the full trade-off.

## Context handoffs

Cross-agent handoffs can include task context and prior-stage output. Automatic secret scrubbing is not yet a complete security boundary. Do not place credentials in prompts, generated plans, logs, or files that may be handed to another agent.

## Removing local data

Private project intelligence can be removed from the workspace's `.agent-team/` directory after active sessions are stopped. Deleting it can remove resumability, run history, attribution, and accumulated context without deleting the source repository. Application-wide settings and histories live in the Navide application data directory. Back up any configuration you intend to preserve before deletion.

For vulnerability reporting, see the [Security Policy](../../SECURITY.md).
