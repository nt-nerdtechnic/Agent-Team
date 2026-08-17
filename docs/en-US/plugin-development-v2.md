# Plugin Developer Spec v2

> **Status: target draft; Issue 03 contract enforcement is implemented.** The current runtime uses manifest
> v1 and is documented in [Plugin development guide](plugin-development.md).
> This document is the author-facing contract that the v2 migration must
> implement before third-party publishing opens.
>
> Issue 03 adds strict Manifest v2 grant parsing, catalog validation, and the
> Host authorization/planning seam. Actual backend child-process lifecycle
> remains deferred to its owning follow-up issue. Issue 03 completes the
> parser, catalog, authorization planner, and Host enforcement seams.
> Production execution adapters and persisted consent wiring remain disabled
> and belong to the later runtime integration issue.
>
> **Migration decision:** Plan B (the B0-B9 checkpoint path) was approved on
> 2026-08-13. Plans A and C are not active implementation alternatives.

## What is public

Third-party plugins may depend only on these published npm packages:

- `@navide/plugin-contracts`: manifest types, capability addresses, payloads,
  error codes, and JSON Schema exports.
- `@navide/plugin-sdk`: activation, capability calls, events, lifecycle, view,
  and target APIs.
- `@navide/plugin-ui`: stable design tokens and UI primitives.

The repository's `packages/features/*` packages are private, unpublished
first-party implementation. A bundled plugin such as `navide.git` can use them;
a third-party plugin cannot. They are not compatibility promises or examples of
the public dependency graph.

The packages will be published to npm with normal SemVer 2.0.0 versions. Third-party
projects must use registry versions, never `workspace:` dependencies. The v2
release gate requires a public package tarball smoke test from a directory
outside the Navide workspace.

## Recommended source project

The source project is a scaffold convention, not the installed package
contract. Authors may change framework- or language-specific files, but the
generated publish staging directory must use the artifact layout defined
below.

```text
acme-files/
├── manifest.json
├── package.json
├── src/
│   ├── frontend/
│   │   ├── left/
│   │   │   └── main.ts
│   │   └── window/
│   │       └── main.ts
│   ├── backend/                 # Optional; language-specific source
│   └── shared/                  # Optional; package-private source
├── assets/
│   └── files.png
├── tests/
├── vite.config.ts               # Example frontend build configuration
└── dist/
    └── package/                 # Generated publish staging directory
```

```json
{
  "scripts": {
    "build": "vite build",
    "check": "navide-plugin validate manifest.json",
    "dev": "navide-plugin dev"
  },
  "dependencies": {
    "@navide/plugin-contracts": "^1.0.0",
    "@navide/plugin-sdk": "^1.0.0",
    "@navide/plugin-ui": "^1.0.0"
  }
}
```

The SDK distribution must include a `navide-plugin` executable with `init`,
`validate`, `dev`, and `package` commands. `init` generates this layout;
`validate` checks the same schema and capability catalog as the Host;
`dev` registers an unpacked directory and prints renderer/backend logs; and
`package` creates the canonical signed archive input. These commands are a v2
release requirement, not current v1 behavior.

## Normative publish artifact

A publishable plugin is one ZIP archive conventionally named `*.vsix`. The ZIP
does not contain a wrapping package directory: `manifest.json` is located at
the archive root. The filename below is illustrative only; package identity and
version come from the manifest, never from the filename.

```text
acme.files-1.0.0-darwin-arm64.vsix
├── manifest.json                # Required at the archive root
├── frontend/                    # Present when contributes.views exists
│   ├── left/
│   │   ├── index.html
│   │   └── assets/
│   └── window/
│       ├── index.html
│       └── assets/
├── backend/                     # Present when backend exists
│   └── acme-files               # Regular executable for this OS/architecture
├── assets/
│   └── files.png
└── README.md                    # Optional; not used by the runtime
```

The publish staging directory and final archive obey these rules:

- Every `contributes.views[].entry`, view icon, marketplace icon, and
  `backend.entry` resolves to an existing regular file inside the same archive.
- Frontend-only packages omit `backend/`; backend-only packages omit
  `frontend/`; combined packages contain both. A directory name alone does not
  declare a contribution: the manifest is authoritative.
- A backend artifact targets one OS/architecture combination. Different target
  artifacts for the same plugin version are built, digested, and signed
  independently; one archive does not contain a platform selector or multiple
  backend executables.
- All archive entry names are relative POSIX paths. Absolute paths, empty,
  `.`, or `..` segments, backslashes, duplicate canonical entries, regular-file
  ancestor collisions, symlinks, and non-regular special files are rejected
  before extraction. A directory entry may have one trailing `/`; that slash
  is removed for canonical comparison and extraction.
- `.navide-receipt.json`, `.navide-registry-receipt.json`,
  `.navide-package.zip`, `.navide-registry-trust.json`, version selectors,
  activation catalogs, storage snapshots, and active/previous state are
  Host-owned and must not appear in an author-created archive.
- Source files, tests, private keys, credentials, caches, `node_modules`, and
  build-system output not referenced by the package must be excluded. The
  packager uses an explicit canonical file list rather than recursively zipping
  the source project.
- The detached publisher signature is not stored in the ZIP. It signs the
  digest of the complete archive, so the manifest, frontend, backend, assets,
  and optional documentation are all covered.
- The normal marketplace installer rejects unsigned Manifest v2 archives.
  Unsigned local code belongs to the separate Developer Mode path and is not
  eligible for publishing or automatic updates.

### Backend source, development, and publish contract

The backend implementation language is private to the plugin. Navide does not
select an interpreter from the manifest and does not import an author's module.
The public runtime seam is one executable plus the versioned Navide backend
protocol.

| Stage | Python backend | Host-visible contract |
|---|---|---|
| Source development | Authors may use `.py` files, a virtual environment, and any Python build/test layout. | None. Source layout is not an installed interface. |
| `navide-plugin dev` | The author-owned development tool may launch the local Python interpreter or a temporary build. It must expose the same protocol-compatible child process used by the packaged backend. | Developer Mode receives a development launch descriptor; this exception is unsigned, local-only, and cannot be published or auto-updated. |
| `navide-plugin package` | Python, its required modules, and the plugin code are bundled into a target-specific executable by an author-selected tool such as PyInstaller or Nuitka. | `backend.entry` names the resulting executable inside the archive. |
| Install and runtime target | No Python installation, `pip`, virtual environment, source checkout, or author build tool may be required on the user's machine. | The Electron main process now has an internal Issue 07 conformance seam that can spawn an approved entry directly without a shell and communicate through Backend Wire v1. Approved catalog startup wiring and the complete plugin lifecycle remain later runtime work; Issue 05 still emits the fail-closed activation catalog but does not activate third-party v2 backends. |

Manifest validation rejects recognizable source or script suffixes. Package
validation also rejects empty backend entries, POSIX entries without executable
metadata, and extensionless executable files whose contents begin with a
shebang. The installer writes the declared backend entry with owner-only `0700`
mode. These checks prove archive executable intent; binary-format and exact
OS/architecture validation remain part of the canonical artifact work in B8.

The same publish rule applies to every implementation language: Go or Rust may
compile directly; Node.js requires a distributable executable that does not
depend on a separately installed Node.js runtime. The manifest does not contain
`language`, `python`, `module`, `interpreter`, or build-tool fields because none
of them are part of the Host interface.

A publishable Python backend therefore uses this shape:

```text
source project                          publish artifact
src/backend/main.py                    backend/acme-files
pyproject.toml            package      manifest.json
.venv/                    ────────>     (no .py, .venv, pip, or build config)
```

```json
{
  "backend": {
    "entry": "backend/acme-files",
    "protocolVersion": 1,
    "activation": "startup"
  }
}
```

`backend.entry: "backend/main.py"` is not a portable v2 publish artifact and
must be rejected. On POSIX targets the referenced regular file must be
executable; on Windows it must use the accepted executable format. Each
OS/architecture build is packaged, digested, signed, and published as a
separate artifact for the same plugin version.

The current v1 built-in loader is different: it discovers Python `backend.py`
files and imports them into the existing backend process. That behavior is a
legacy migration input only. It does not define the v2 package format and must
not be exposed to third-party v2 packages.

Cross-language backend support is not considered available merely because the
manifest has `backend.entry`. It becomes a public capability only after the
backend protocol, development launcher, packager, platform validation, and
cross-language conformance fixtures pass the B5/B8 release gates.

### Navide Backend Wire v1

`backend.protocolVersion: 1` selects **Navide Backend Wire v1**. This is a
small, Navide-owned profile aligned with the base message and stdio conventions
of MCP revision `2026-07-28`. It is not a complete MCP server contract and must
not be advertised as MCP-conformant.

The profile deliberately adopts only these MCP conventions:

- UTF-8 JSON-RPC 2.0 messages; request IDs are non-null strings or integers and
  are unique while in flight.
- stdio uses exactly one compact JSON-RPC message per line. Embedded newlines
  are forbidden. `Content-Length` headers and the legacy MCP
  `initialize`/`initialized` exchange are not used.
- Every request includes `_meta.io.modelcontextprotocol/protocolVersion` set to
  `2026-07-28`, `_meta.io.modelcontextprotocol/clientCapabilities`, and the
  diagnostic-only `_meta.io.modelcontextprotocol/clientInfo` when available.
- Cancellation uses `notifications/cancelled`; optional progress uses
  `notifications/progress` and the request's `_meta.progressToken`.
- stdout contains protocol frames only. Human-readable logs use stderr.
- Closing stdin is the graceful shutdown signal. The Host waits for a bounded
  period before terminating a process that does not exit.
- The Host supplies an explicit environment map for each backend process. The
  child does not inherit the Electron main process environment; invalid keys,
  non-string values, and NUL characters reject activation. Timed-out or
  cancelled request IDs are retained only for bounded late-response handling.

Navide does **not** initially implement MCP `server/discover`, tools, resources,
prompts, Multi Round-Trip Requests, MCP authorization, or the full MCP
extension negotiation model. The Host owns package authorization and runtime
identity; MCP `clientInfo` is never an authorization input.

The author-facing SDK remains transport-free:

```ts
interface PluginBackendClient {
  call<Result extends JsonValue>(
    name: string,
    arguments: JsonValue,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result>

  subscribe<Payload extends JsonValue>(
    event: string,
    listener: (payload: Payload) => void,
  ): Disposable
}
```

The production adapter maps that Interface to MCP base methods plus one
Navide-owned event notification:

| Wire method | Direction | Meaning |
|---|---|---|
| `navide/health` | Host to backend | Prove that the process understands Backend Wire v1. It is not an identity or permission handshake. |
| `navide/call` | Host to backend | Invoke one package-local method with JSON arguments and Host-generated runtime context. |
| `subscriptions/listen` | Host to backend | Open one long-lived stream whose `notifications.dev.navide/pluginEvents` filter contains the approved package-local event names. |
| `notifications/subscriptions/acknowledged` | Backend to Host | Acknowledge the accepted event filter before delivering any event. |
| `notifications/navide/event` | Backend to Host | Deliver an event with `_meta.io.modelcontextprotocol/subscriptionId`; the Host validates the subscription and audience before forwarding it. |

The `subscriptions/listen` request ID is the subscription ID. The backend sends
`notifications/subscriptions/acknowledged` first, and every later event carries
that ID in `_meta.io.modelcontextprotocol/subscriptionId`. Cancellation refers
to the same request ID. A backend-initiated graceful close sends the final
`resultType: "complete"` response for the long-lived request.

Each Host-to-backend call carries a `runtime` object generated from the
authenticated binding. The frontend cannot set or override `pluginId`,
`packageVersion`, `workspaceId`, `instanceId`, `contributionKey`, or
`hostWindowId`. Optional view/workspace fields are `null` for startup-only
backend calls that have no such binding.

```json
{"jsonrpc":"2.0","id":"req-1","method":"navide/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"navide-host","version":"0.2.0"}},"name":"plans.list","arguments":{"filter":"open"},"runtime":{"pluginId":"navide.plans","packageVersion":"1.0.0","workspaceId":"ws-1","instanceId":"view-1","contributionKey":"navide.plans.left","hostWindowId":"window-1"}}}
```

A successful call response includes MCP's required `resultType` discriminator,
a `value`, and `_meta.io.modelcontextprotocol/serverInfo` with the backend
implementation name and version. Navide requires this MCP result metadata even
though the base protocol makes it optional. The final response that gracefully
closes a subscription may omit `value`, but it carries both `serverInfo` and the
subscription ID. A failed protocol request uses the standard JSON-RPC/MCP error
envelope, which has no result `_meta`, and may omit `id` when the request ID
could not be read. A handled Plugin error uses application error code `1000`
and the original request ID; its stable public `PluginError` string is placed in
`error.data.code`. Internal stack traces, Python exceptions, transport details,
and Host routes never cross the SDK Interface.

```json
{"jsonrpc":"2.0","id":"req-1","result":{"resultType":"complete","value":[{"id":"plan-1"}],"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"navide.plans","version":"1.0.0"}}}}
{"jsonrpc":"2.0","id":"req-2","error":{"code":1000,"message":"Workspace is unavailable","data":{"code":"WORKSPACE_SCOPE_VIOLATION"}}}
```

The normative Backend Wire v1 schema and accepted/rejected fixture corpus are
published under `docs/plugin-contracts/` and validated together with the
Manifest v2 corpus. This contract enables backend-only and combined package
description and installation. Issue 07 adds a private Electron-main
supervisor/stdio conformance seam for health and unary calls; it is not a
public SDK surface and does not activate the installed catalog. Future AI
integration is a separate adapter: it may
expose an explicit allowlist of schema-described package methods as MCP tools.
No package method is AI-callable by default, and adopting this wire profile
does not itself create a tool catalog.

After installation, frontend-only, backend-only, and combined packages appear
in the Extensions installed list and can be removed there. Package inventory is
independent of frontend view descriptors, so a backend-only package remains
manageable even though it contributes no view.

The exact OS/architecture identifiers, archive size limits, and deterministic
ZIP metadata are B8 decisions. Until they are published, examples must not be
treated as accepted enum values.

## Manifest

The normative schema is
[`plugin-manifest-v2.schema.json`](../plugin-contracts/plugin-manifest-v2.schema.json).

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.files",
  "name": "Files",
  "version": "1.0.0",
  "publisher": "acme",
  "engines": { "navide": ">=0.2.0" },
  "permissions": {
    "system": ["fs", "ui"]
  },
  "marketplace": {
    "description": "Browse workspace files in the left workbench region.",
    "license": "MIT",
    "repository": "https://github.com/acme/navide-files",
    "homepage": "https://acme.example/navide-files",
    "categories": ["productivity"],
    "icon": "assets/files.png"
  },
  "contributes": {
    "views": [
      {
        "id": "left",
        "kind": "custom",
        "location": "left",
        "title": "Files",
        "entry": "frontend/left/index.html"
      }
    ]
  }
}
```

`contributes.views[].location` accepts exactly these values. The Host owns the
placement and mounts the plugin's isolated custom view into the selected
workbench region. `window` is the only value that creates a separate top-level
window.

The manifest `name` and every view `title` are plain display text with 1–80
Unicode code points; carriage returns, newlines, and angle brackets are
rejected. A manifest may declare at most 16 views.

| Value | Placement |
|---|---|
| `top` | Top workbench region |
| `bottom` | Bottom workbench region |
| `right` | Right workbench region |
| `left` | Left workbench region; use this when migrating a legacy sidebar contribution |
| `main` | Primary workbench content region |
| `window` | Separate top-level window |

`sidebar` is not a v2 location value. Unknown locations fail schema validation.

A package that contains both frontend and backend contributions uses one
manifest. `contributes` and `backend` are sibling top-level fields; the backend
does not have a second manifest:

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.files",
  "name": "Files",
  "version": "1.0.0",
  "publisher": "acme",
  "permissions": {
    "system": ["fs"]
  },
  "marketplace": {
    "description": "Browse workspace files and maintain an index.",
    "license": "MIT"
  },
  "contributes": {
    "views": [
      {
        "id": "left",
        "kind": "custom",
        "location": "left",
        "title": "Files",
        "entry": "frontend/left/index.html"
      },
      {
        "id": "window",
        "kind": "custom",
        "location": "window",
        "title": "Files",
        "entry": "frontend/window/index.html"
      }
    ]
  },
  "backend": {
    "entry": "backend/acme-files",
    "protocolVersion": 1,
    "activation": "startup"
  }
}
```

The version axes are independent:

| Field | Meaning | When an author changes it |
|---|---|---|
| `schemaVersion` | Manifest document shape | Only when adopting another manifest schema |
| `apiVersion` | Public SDK and capability contract | When the plugin consumes another public API range |
| `version` | This plugin package release; SemVer 2.0.0 prerelease and build metadata are accepted | Every published plugin release |
| `engines.navide` | Optional product/runtime requirement | Only when the plugin needs a particular Navide product feature |
| `backend.protocolVersion` | Navide child-process wire profile; `1` freezes the MCP 2026-07-28-aligned conventions above | Only when adopting another supported Navide wire profile |

`permissions` contains one coarse `system` namespace array and an optional
`shell` mode. Each key appears at most once because duplicate JSON object keys
are rejected before schema validation. The manifest never declares scope: the
capability catalog assigns scope to each catalog entry, and the Host derives
the runtime workspace, plugin, and view identity from its authenticated
binding.

The top-level `name` is the display name; it is plain display text with 1–80
Unicode code points and no newlines or angle brackets.

`marketplace` is required for every v2 package and is covered by the package
signature. It is the only source of author-controlled listing metadata:

| Field | Requirement |
|---|---|
| `description` | Required plain text, 1–280 characters |
| `license` | Required SPDX expression, 1–100 characters |
| `repository` | Optional HTTPS source repository URL |
| `homepage` | Optional HTTPS project URL |
| `categories` | Optional; at most five unique lowercase slugs |
| `icon` | Optional safe package-relative path; the packaged file must exist |

The v2 manifest does not define a second `displayName`. The registry keeps the
immutable metadata snapshot for every version and presents
the latest non-yanked version. Yanking that version falls back to the previous
non-yanked version. Publisher identity comes from the verified package and
authenticated namespace, never from a marketplace field.

Views activate when the Host opens their contribution. There is no top-level
`activationEvents` field in v2. A backend-only plugin is valid and activates at
startup:

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.skills",
  "name": "Skills",
  "version": "1.0.0",
  "publisher": "acme",
  "permissions": {},
  "marketplace": {
    "description": "Provide reusable skills to Navide agents.",
    "license": "MIT",
    "categories": ["developer-tools"]
  },
  "backend": {
    "entry": "backend/acme-skills",
    "protocolVersion": 1,
    "activation": "startup"
  }
}
```

Manifest v2 rejects `requires`, `activationEvents`, and
`contributes.commands`. The migration adapter maps legacy `onStartup` to
backend startup and `onView:*` to view contributions. Commands and
`onCommand:*` are not public until a separate command contract is specified.

All entries are package-relative regular files. Absolute paths, empty, `.`, or
`..` segments, Windows backslashes, symlink escapes, and shell command strings
are rejected. Unknown
fields, unknown permissions, duplicate JSON object keys, and unknown view kinds
fail closed. Manifest v2 initially supports only `custom` views.
`tree`/`provider` is deferred until its provider registration, item shape,
pagination, cancellation, error, and lifecycle Interface is published.

## SDK interface

```ts
export interface PluginContext {
  readonly pluginId: string
  readonly packageVersion: string
  readonly contributionKey: string
  readonly instanceId: string
  readonly workspaceId: string
  readonly startupDeadlineMs: number
  readonly capabilities: {
    invoke<M extends PublicMethod>(method: M, params: Params<M>): Promise<Result<M>>
  }
  readonly events: {
    subscribe<E extends PublicEvent>(event: E, listener: (payload: Payload<E>) => void): Disposable
  }
  readonly lifecycle: {
    reportProgress(message: string): void
  }
  readonly view: {
    hide(): Promise<void>
  }
  readonly targets: {
    subscribe(listener: (target: WorkspaceTarget | null) => void): Disposable
  }
}

export declare function definePlugin(
  activate: (context: PluginContext) => void | Promise<void>
): PluginDefinition
```

`instanceId` is a Host-generated opaque JSON string. Do not parse, construct,
persist, or use it as authorization input. The SDK sends `ready` only after the
`activate` promise resolves. `reportProgress` is diagnostic and does not extend
`startupDeadlineMs`.

`window.nav` is the private preload transport used by the SDK. Its channels,
payload wrappers, and bootstrap mechanics are not public API. Plugin code must
not call it directly.

## Capabilities and permissions

The normative method/event catalog is
[`capabilities-v1.json`](../plugin-contracts/capabilities-v1.json). Every entry
defines its address, request/result or event schema, required permission,
scope, visibility, and possible public errors.

Manifest v2 uses one coarse system namespace array and one shell mode:

```json
{
  "permissions": {
    "system": ["fs", "ui", "aiCli"],
    "shell": "allowlist"
  }
}
```

`system` accepts only `fs`, `ui`, and `aiCli`. It is not a map of methods or
read/write accesses: declaring `fs` allows catalog validation to consider the
filesystem methods, but does not bypass method schemas, scope checks, or Host
policy. `shell` accepts only `allowlist` or `full`; omission denies
`shell.run`. Storage, `git`, `terminal`, raw PTY, and arbitrary process access
are not Manifest v2 permissions.

| Namespace/address | Catalog methods/events | Scope |
|---|---|---|
| `system:fs` | `fs.readFile`, `fs.listDirectory`, `fs.glob`, `fs.stat`, `workspace.filesChanged` | `workspace` |
| `system:ui` | `ui.openInEditor` | `workspace` |
| `system:ui` | `ui.openExternal` | `plugin` (HTTPS; Host user-gesture gate) |
| `system:aiCli` | `aiCli.startSession`, `cancelStart`, `reattachSession`, `sendInput`, `resizeSession`, `redrawSession`, `interruptSession`, `stopSession`, `output`, `exited` | `workspace` |
| `shell` | `shell.run` | `workspace` |

`workspace` is a resource boundary, not raw workspace filesystem access. The
Host derives `workspaceId` from authenticated runtime binding. There is no
public `runtime` scope. Workspace events also require a Host-authenticated
event source for the same workspace; an unbound shared event is dropped.

### Storage partitions

Storage runtime remains deferred and is not opened by Issue 03.

`storage.get`, `storage.set`, and `storage.delete` accept a partition class in
`scope`; they do not accept a plugin ID, workspace ID, package version, or
storage path.

- `scope: "plugin"` addresses the Host-bound `(pluginId, key)` partition. All
  live views and the backend of that plugin share it, while another plugin
  using the same key receives a different value.
- `scope: "workspace"` addresses the Host-bound
  `(pluginId, currentWorkspaceId, key)` partition. Calls without a current
  workspace binding fail with `WORKSPACE_SCOPE_VIOLATION`; they never fall back
  to plugin scope.
- Package updates copy the active Host-managed storage snapshot into an
  isolated candidate. **Restart Plugin** activates the package and snapshot
  together; rollback restores the previous package and snapshot together.
- Raw `ui.settings` is a first-party legacy surface, not plugin storage. Theme,
  language, workbench layout, terminal runtime state, workspace files, and
  other domain data do not become accessible through the storage API.

The Host derives every partition identity from the authenticated runtime
binding. The `scope` argument only selects one of the two permitted partition
classes and cannot override identity or authorization.

The Host derives the authorization scope, workspace root, plugin identity, and
view identity from the catalog plus authenticated runtime binding. Plugin
requests cannot supply or override any of those values. Every declared method
must pass catalog/request validation, publisher eligibility where required, the
explicit package-version user grant, and authenticated binding checks before an
execution plan is returned.

First-party identity affects eligibility only. It never grants a namespace,
selects a package version, or bypasses the user grant. Git is not an
independent permission. The Host shell executable allowlist contains `git`;
all packages, including `navide.git`, must still declare `shell: "allowlist"`
and pass the same package-version grant and authenticated binding checks.
The allowlist matches only the canonical top-level executable name: it does
not accept wrappers, aliases, or path-qualified replacements, and it defines
no Git subcommand or argument-pattern policy.

### Embedded AI CLI public mapping

`AiCliDock` currently consumes the generic terminal transport. The public
catalog exposes only the Host-mediated AI CLI addresses below:

| Public address | Meaning |
| --- | --- |
| `aiCli.startSession` | Start a Host-selected, allowlisted profile |
| `aiCli.cancelStart` | Cancel a Host-owned start request |
| `aiCli.reattachSession` | Reattach to an already Host-bound session |
| `aiCli.sendInput` | Send input to an owned session |
| `aiCli.resizeSession` | Resize an owned session |
| `aiCli.redrawSession` | Redraw an owned session |
| `aiCli.interruptSession` | Interrupt an owned session |
| `aiCli.stopSession` | Stop an owned session |
| `aiCli.output` / `aiCli.exited` | Directed output and exit events |

`aiCli.startSession` accepts only an allowlisted `profileId` and terminal
display dimensions. The Host derives the command, arguments, working directory,
environment, credentials, workspace, pane metadata, session ID, view instance,
and event audience. Every control call validates the opaque session against the
authenticated plugin, package version, workspace, view instance, and audience.
Directed output and exit events are delivered only to the authenticated
audience that created or reattached the session.
`shell.run`, raw command/executable/arguments/environment/working-directory
parameters, and PID control have no `aiCli` mapping and must fail closed.
The Host executor also applies the catalog's active user-gesture requirement
for `ui.openExternal` before opening a URL.
Filesystem calls used by the dock's `@`-file picker remain authorized by
the public `system:fs` catalog; they are not absorbed into the AI CLI
permission.

Before install, Navide shows the declared system namespaces and shell mode,
resolves their catalog scope, and asks for an explicit package-version grant.
An update that adds a namespace or changes shell mode remains staged until the
user confirms the delta. Runtime calls are checked against that confirmed
package-version grant; `full` shell additionally requires a separate high-risk
confirmation. There is no package-ID auto-grant.

The legacy `git.changed` event is unusually authorized by `fs`. The v2 public
replacement is `workspace.filesChanged`; third-party code must not subscribe to
the legacy address.

## Errors

All SDK failures reject with `PluginError` containing a stable `code`, a safe
message, and optional structured details:

| Code | Meaning | Author response |
|---|---|---|
| `CAPABILITY_DENIED` | Permission was not granted | Change the manifest or remove the call |
| `METHOD_NOT_FOUND` | Address is unknown for the negotiated API | Check `apiVersion` and spelling |
| `INVALID_ARGUMENT` | Payload failed schema validation | Fix the request |
| `WORKSPACE_SCOPE_VIOLATION` | No workspace is bound, or a path/target escapes it | Use a workspace-bound runtime and a relative target |
| `USER_CANCELLED` | User rejected or cancelled the action | Stop quietly or restore UI state |
| `TIMEOUT` | Host-owned deadline expired | Retry only when safe and user-visible |
| `BACKEND_UNAVAILABLE` | Required Host/backend service is down | Disable the action and offer retry |
| `PLUGIN_STOPPING` | Runtime is draining or restarting | Do not start new work |
| `INTERNAL_ERROR` | Non-actionable Host failure | Log the correlation ID; do not inspect internals |

The v1 broker's `CAP_DENIED`, `UNKNOWN`, `BAD_REQUEST`, and `BACKEND_ERROR`
strings are internal legacy values and are mapped by the compatibility adapter.

## Views and lifecycle

A package may contribute multiple views, and each view may have multiple live
instances across windows and workspaces. Closing one instance must not close
another. Cross-view state belongs in plugin/workspace storage or the plugin's
backend, never in a guessed instance key.

`custom` views render isolated content in a Host-owned `WebContentsView` and
have a package-relative HTML `entry`. The initial v2 contract does not accept
`tree`, `provider`, or another view kind. A future Host-rendered tree is an
additive contract only after authors can implement and test the complete
provider Interface.

An update is downloaded and verified in the background but is not a live code
swap. The user chooses **Restart Plugin**. Navide drains that plugin, atomically
activates one complete frontend/backend package version, and restores its view
placements. Failure returns to the verified previous version. Navide itself and
unrelated plugins do not restart.

## Backend trust

A backend plugin is native local code. Process isolation limits crash impact;
it does not restrict filesystem, network, subprocess, or OS access.

- Normal mode will run only complete artifacts covered by a Registry envelope
  signature that chains to a Host-pinned Registry root; publisher keys are not
  Client trust roots in v2.
- An Official Registry can claim the reserved `navide.` namespace only when
  the App build provisions an independent Registry root for the exact Official
  Registry URL and the current root-signed profile is `official`. This build
  intentionally ships with that production root unprovisioned, so the Official
  Registry path fails closed until release provisioning supplies it. The
  publisher namespace key is never reused as a Registry root.
- A self-hosted Registry must have a durable Host-owned approval that binds its
  URL, root PEM, and a separately confirmed SPKI SHA-256 fingerprint before
  Navide contacts it. A self-hosted root remains a separate verification root;
  even root-signed metadata claiming `registryProfile: "official"` cannot grant
  Official Registry namespace authority. The informational fingerprint
  returned by the Registry is never a trust root.
  The approval document uses the exact fields `schemaVersion`, `registryUrl`,
  `rootPublicKeyPem`, and `confirmedFingerprint`; unknown or duplicate JSON
  fields fail closed. The local development default (`http://localhost:8787`)
  is self-hosted and therefore requires this approval too.
- Registry envelope signatures identify the Registry signer key ID. Root-signed
  trust metadata records active,
  rotating, expired, and revoked keys. Rotation has a bounded old/new overlap.
- Yank prevents new installs; revocation also blocks install, update, activation,
  and future backend spawn. A newly revoked running frontend plugin is stopped
  and quarantined; the later Electron backend supervisor must enforce the same
  decision before and during backend execution.
- Developer Mode accepts one explicitly selected local unpacked Manifest v2
  frontend directory only when `AGENT_TEAM_PLUGIN_DEV=1` and
  `AGENT_TEAM_PLUGIN_DEV_PATH` names that exact directory. It validates the
  strict manifest, rejects reserved ids and backend contributions, and records
  a persistent unsigned/local-only warning. The existing fixed dist-plugins
  bundles remain Host-owned app-development fixtures, not this package
  selection path. Developer Mode packages cannot publish, auto-update, execute
  backend code, or claim Registry provenance.

The package archive signature covers the manifest, frontend, backend, assets,
and their digests. Each OS/architecture artifact is signed independently.

## Compatibility policy

Public packages and `apiVersion` share a major version. A major accepts additive
optional fields, methods, and events only. Navide supports the current and
previous public API major; the previous major remains supported for at least 12
months. Public deprecations are announced for at least 6 months and span at
least two Navide minor releases before removal.

The migration plan's one-minor compatibility window applies only to Navide's
internal v1 loader/adapter. It is not the third-party API support policy.

## Development and publishing flow

1. Run `navide-plugin init` and choose a frontend, backend, or combined package.
2. Declare the smallest permissions and run `navide-plugin validate`.
3. Run `navide-plugin dev`; Navide Developer Mode loads the unpacked directory,
   displays an unsigned-code warning when needed, and streams scoped logs.
4. Run the generated unit tests with an in-memory SDK adapter. Test denied,
   cancelled, timeout, and multi-instance behavior before manual UI checks.
5. Run `navide-plugin package`. Inspect the canonical file list, signed
   marketplace metadata, and digest.
6. Sign with a registered publisher key and upload the OS/architecture artifact.
7. The registry revalidates strict JSON parsing, schema, SPDX license,
   capability/catalog parity, marketplace asset paths, archive safety, digest,
   signature, key status, and compatibility before accepting a release.

Third-party publishing stays closed until the SDK packages, CLI, schema parity,
trust operations, example plugin, and outside-workspace smoke test all exist.
