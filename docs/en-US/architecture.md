# Architecture

This document describes the product model and stable ownership boundaries in the current Navide application. For the underlying beliefs, see the [Manifesto](manifesto.md). For historical implementation milestones, see [spec.md](spec.md). For future direction, see [roadmap.md](roadmap.md).

## Product architecture

Navide is an AI-native engineering environment for one engineer directing multiple coding agents. The orchestration control plane is a core subsystem, not the complete product identity.

The product is organized around three engineering loops:

```text
Genesis
Idea → requirements → plan → design → implementation → review → tests → prototype

Evolution
Goal → coordinated sessions → changes → tests → correction → verified result → next goal

Intervention
Observe → inspect evidence → edit / command / redirect → resume coordinated execution
```

Genesis creates the first working form. Evolution is the everyday center of development. Intervention preserves precise human control throughout both.

### Management by exception

The engineer owns intent, constraints, lasting decisions, external or irreversible actions, and final acceptance. Agents own execution inside approved boundaries. Navide owns session lifecycle, synchronization, visibility, recovery, and returning meaningful exceptions to the engineer.

The intended behavior is highly autonomous but not opaque: continuous execution, continuous visibility, immediate interruption, and evidence-backed accountability.

## System context

Navide is a desktop engineering environment built around external coding-agent CLIs and local engineering tools. It does not host the foundation models used by those CLIs and does not replace their authentication, billing, sandbox, or data policy.

```text
User and workspace
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Navide desktop application                               │
│                                                          │
│ Electron main ── IPC ── Vue renderer ── WS/HTTP ── Python│
│                                                          │
└──────────────────────────────────────────────────────────┘
        │ PTY, files, Git, local logs, MCP, model requests
        ▼
External agent CLIs, local models, cloud providers, and Git hosts
```

## Process boundaries

### Electron main process

The Electron main process owns operating-system integration:

- Application and window lifecycle
- Preload bridge and renderer IPC
- Python backend process startup and health supervision
- Native file dialogs, menus, permissions, and dock behavior
- Separate editor and management windows
- In-app update state and release checks

The renderer must not receive unrestricted Node.js access. Native operations should cross the preload boundary through narrow, typed APIs.

### Vue renderer

The renderer owns interactive application state and workflow presentation:

- Workspace entry and recent-workspace UI
- Pane layouts, terminal rendering, and user input
- Pipeline state machine and stage activation
- Manager/worker protocol parsing and routing
- Settings, roles, pipelines, MCP, and analyzer controls
- Explorer, Monaco editor, Git, issues, review, AI terminal, history, and token views

Renderer composables communicate with the backend through correlated WebSocket requests and broadcast events. Terminal display state is distinct from the underlying PTY state.

### Python FastAPI backend

The backend owns long-running local services and persistence:

- PTY creation, input buffering, resize, output batching, and session registry
- Workspace project state and recent workspaces
- File, Git, issue, review, and editor services
- Agent CLI log readers, session attribution, activity events, and token usage
- Local analyzer and optional model-provider calls
- MCP lifecycle and Context7 document injection
- Claude Code hooks and backend event ingestion
- Run history, UI settings, roles, and pipeline definitions

The backend listens on loopback and is supervised by Electron. It is not intended to be exposed as a network service.

## Runtime workflow

### Evolution session

```text
User defines an engineering outcome and selects or accepts an agent and role
  → renderer builds spawn request
  → backend starts PTY with CLI command
  → renderer waits for CLI readiness
  → role and task are injected
  → log reader binds the provider session when available
  → output, activity, history, and token events update the UI
  → additional sessions can be coordinated in parallel
  → tests, corrections, and evidence converge on a result
```

The current manual-spawn and maintenance flows are early implementations of this Evolution loop.

### Genesis pipeline

```text
Task description
  → load configurable stages and slots
  → pre-spawn eligible agent panes
  → activate current stage with prior-stage context
  → run slots in parallel
  → collect questions, analyzer signals, and completion sentinels
  → manager routes work when configured
  → persist handoff and advance
  → produce a first working form and enter continuous Evolution
```

Completion is a workflow signal, not proof that generated code is correct. Git review and explicit verification remain quality gates.

## Persistence boundaries

### Private Project Intelligence Layer

`.agent-team/` is the local, per-user intelligence layer for a workspace. Today it contains project state such as pipeline progress, run history, and token summaries. Its future model may include structured tasks, decisions, handoffs, evidence, and session-coordination metadata.

It has a strict boundary:

- Private to the individual Navide user
- Stored inside the local workspace
- Excluded from Git
- Not a human-team synchronization mechanism
- Separate from repository-owned source and shared documentation
- Portable only through a future explicit export/import operation
- Subject to deletion, retention, and redaction controls

Files under this directory can include task descriptions and agent output; treat them as private project data.

### Repository-shared project truth

Source code, tests, configuration, and explicitly authored project documents remain the team-visible truth shared through Git. Information from private project intelligence becomes shared only through an intentional artifact such as a specification, decision record, test report, commit, issue, or pull request.

### Application-scoped

The application data directory contains registries and preferences such as roles, pipeline definitions, recent workspaces, analyzer settings, token attribution metadata, and optional AI provider credentials.

### Provider-owned

Claude Code, Codex, Antigravity, Grok, Git clients, model runtimes, and MCP servers retain their own configuration, sessions, credentials, logs, and caches. Navide reads selected provider-owned logs or databases for session attribution and usage reporting.

## Agent integration boundary

An agent integration currently spans:

- Frontend agent key and launch specification
- CLI readiness and session-marker behavior
- Resume-command syntax
- Backend whitelist and support-registry entry (detection, install, and the CLI's own update and diagnostic commands)
- Provider log or database reader
- Session attribution and token display
- CLI-specific concurrency or home-directory handling when required

See the [CLI Extension Guide](cli-extension-guide.md). A capability-based adapter contract is a roadmap goal because the current integration surface is distributed across several modules.

## Session synchronization direction

Multi-session work must evolve beyond copying terminal output between panes. The shared local coordination model should let a session discover:

- Its assigned goal, scope, dependencies, and acceptance criteria
- Which other sessions exist and what they own
- Current progress, blockers, questions, and handoffs
- Files, modules, or repositories at risk of conflicting changes
- Project decisions and verified facts relevant to the task
- Tests and evidence required before completion

Sessions should publish structured progress back to the Project Intelligence Layer while preserving raw provider output for diagnosis. A manager may coordinate complex work, but it should not be the only place where shared state exists.

## Trust boundaries

- External agents can execute commands with the current user's permissions.
- YOLO mode can remove external CLI approval or sandbox gates.
- Cloud providers and MCP servers receive data according to the selected feature and configuration.
- Cross-agent handoffs can propagate sensitive text.
- Local API-key file permissions are defense in depth, not a secret vault.
- Git history and run artifacts can preserve data after a working file is deleted.

See [Privacy and Data Flows](privacy.md) and [SECURITY.md](../../SECURITY.md).

## Architectural direction

Long-term architecture work must turn the current control plane and engineering surfaces into a complete AI-native engineering environment. It should not copy traditional IDE interfaces uncritically, but it must eventually cover the full professional workflow. The primary seams are:

1. A declarative agent-adapter contract
2. A durable orchestration event and artifact model
3. Policy-controlled tool execution and workspace isolation
4. Dependency-graph scheduling beyond a fixed linear pipeline
5. Connectors that turn external work items into reviewable delivery runs
6. Integrated navigation, editing, execution, debugging, testing, review, versioning, and delivery
