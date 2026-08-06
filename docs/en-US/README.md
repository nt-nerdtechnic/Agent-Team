# Navide Documentation

English | [繁體中文](../zh-TW/README.md) | [日本語](../ja-JP/README.md) | [Language gateway](../README.md)

Navide is the engineering instrument for the Agent era: an AI-native software engineering environment in which one person directs multiple coding agents through creation, continuous evolution, and precise human intervention.

The root [README](../../README.md) introduces the product and current distribution. This index organizes the complete English documentation set.

## Product

| Document | Purpose |
|---|---|
| [Manifesto](manifesto.md) | The historical shift Navide responds to and the beliefs guiding the product |
| [Product vision](vision.md) | Target user, product model, ownership, operating philosophy, and definition of success |
| [Product positioning](product-positioning.md) | Category, message hierarchy, vocabulary, evidence, and public-claim boundaries |
| [Product roadmap](roadmap.md) | Directional path from today's system to a complete AI-native engineering environment |

## Use Navide

| Document | Purpose |
|---|---|
| [Getting started](getting-started.md) | Download the unsigned preview or install from source, then complete the first launch |
| [User guide](user-guide.md) | Learn workspaces, panes, pipelines, coordination, Git, history, and editor workflows |
| [Troubleshooting](troubleshooting.md) | Resolve startup, permissions, agent-session, analyzer, and token-tracking problems |

## Trust and safety

| Document | Purpose |
|---|---|
| [Privacy and data flows](privacy.md) | Understand what stays local, what may reach third parties, and where credentials are stored |
| [Security policy](../../SECURITY.md) | Understand supported security boundaries and report vulnerabilities privately |

## Development and maintenance

| Document | Purpose |
|---|---|
| [Contributing](../../CONTRIBUTING.md) | Set up a development environment and submit changes |
| [Architecture](architecture.md) | Understand process boundaries, state ownership, and major services |
| [CLI extension guide](cli-extension-guide.md) | Add or maintain an AI coding CLI integration |
| [Plugin development](plugin-development.md) | Build a frontend view plugin or a backend plugin, then package and sign it |
| [External MCP control](external-mcp-control.md) | Connect an external MCP client to control a running Navide window, and understand the security model |
| [Release guide](releases.md) | Version, package, sign, notarize, publish, and recover a release |

## Reference

| Document | Purpose |
|---|---|
| [Keyboard shortcuts](keybindings.md) | Review default keyboard commands and interaction patterns |
| [Editor design](editor-design.md) | Understand the current editor architecture and design direction |
| [Historical milestone record](spec.md) | Review the original implementation milestone record |
| [Changelog](../../CHANGELOG.md) | Review shipped changes by version |

## Documentation model

- `README.md` is the public English product and distribution entry point; `README.zh-TW.md` and `README.ja-JP.md` are its Traditional Chinese and Japanese counterparts.
- `docs/en-US/` is the canonical English documentation root.
- `docs/zh-TW/` and `docs/ja-JP/` mirror the localized public product and core user journey. Their indexes label English-only fallbacks explicitly.
- English documents are the source of truth for product and technical facts. Update English first, then synchronize localized counterparts in the same change.
- Vision and roadmap documents may describe intended future outcomes. README capability lists and the User Guide describe current behavior.
- Released behavior belongs in the Changelog and GitHub Releases. The roadmap is directional and does not promise dates.
- Private Project Intelligence under `.agent-team/` belongs to each user, stays local by default, and is excluded from Git; it is not a human-team synchronization layer.
