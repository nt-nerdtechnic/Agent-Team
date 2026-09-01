# Plugin Developer Spec v2

> **Status: target draft; Issues 03, 16, the bounded Issue 21 Plans spike, and Issue 22's bridge/lifecycle spike are implemented.** The current runtime uses manifest
> v1 and is documented in [Plugin development guide](plugin-development.md).
> This document is the author-facing contract that the v2 migration must
> implement before third-party publishing opens.
>
> Issue 03 adds strict Manifest v2 grant parsing, catalog validation, and the
> Host authorization/planning seam. Issue 21 adds one bundled Plans
> package-local operation through the public SDK, authenticated Host router,
> and self-contained Python Backend Wire child. Issue 22 adds the Host-private
> core-service ports, package-owned watcher, bounded child lifecycle, and
> cross-language fixture parity. Normal production Plans activation remains
> deferred to Issue 23E. Issue 03 completes the
> parser, catalog, authorization planner, and Host enforcement seams.
> Issue 16 adds the durable storage adapter and Host-only lifecycle seams to
> Electron main. Production grant/consent and runtime-context production are
> not wired yet, so ordinary production plugin instances cannot reach storage;
> calls remain denied until that later integration is delivered. Other public
> execution adapters and persisted consent wiring also remain disabled.
>
> Issue 06 adds the public package boundary and the external frontend workflow.
> The checked-in SDK CLI currently supports `validate` and frontend-only
> `package`; `init`, `dev`, third-party backend packaging, signing, publishing,
> and general runtime activation remain deferred to their owning issues. The
> first-party Issue 21 build script packages only the bundled Plans spike and
> is not the public author workflow.
>
> **Migration decision:** Plan B (the B0-B9 checkpoint path) was approved on
> 2026-08-13. Plans A and C are not active implementation alternatives.

> **Issue 19 production first-party package:** The approved Plan B Git
> migration is now implemented as the bundled `navide.git` production case.
> It is one Manifest v2 package with two isolated `custom` views (`left` and
> `window`), and both views use the same active package version. This does not
> open third-party publishing or complete the later Plans/Skills migration,
> marketplace lifecycle, or legacy-removal work.

## What is public

Third-party plugins may depend only on these public package names:

- `@navide/plugin-contracts`: manifest types, capability addresses, payloads,
  error codes, and JSON Schema exports.
- `@navide/plugin-sdk`: activation, capability calls, events, lifecycle, view,
  and target APIs.
- `@navide/plugin-ui`: Vue components, shared presentation services, stable
  design tokens, and safe capability-backed UI controllers that do not expose
  Host transports.

Official and third-party packages use the same public dependency graph and the
same install, activation, update, rollback, and uninstall lifecycle. Official
status changes only Registry trust and marketplace classification; it does not
grant access to private Host modules or force an official package to be
installed. The base App must remain usable with an empty plugin catalog.

The package manifests declare public npm publication metadata and use normal
SemVer 2.0.0 versions, but registry publication is future work outside Issue
06. The package implementations live under
`packages/plugin-{contracts,sdk,ui,ui-vue}/` and have no dependency on Host
renderer sources. Third-party projects must use registry versions in a
published workflow, never `workspace:` dependencies. The Issue 06 release
gate packs those public packages and installs the tarballs in a directory
outside the Navide workspace; it does not publish to npm.

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
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "tsc -p tsconfig.json && node scripts/stage-package.mjs",
    "check": "navide-plugin validate dist/package",
    "package": "navide-plugin package dist/package --out dist/acme-files.vsix"
  },
  "dependencies": {
    "@navide/plugin-contracts": "^1.0.0",
    "@navide/plugin-sdk": "^1.0.0",
    "@navide/plugin-ui": "^1.0.0"
  }
}
```

The Issue 06 SDK distribution includes a `navide-plugin` executable with these
commands:

```text
navide-plugin validate <directory>
navide-plugin package <directory> [--out <file>]
```

`validate` rejects duplicate JSON keys, unknown manifest fields, unsafe paths,
symlinks, missing referenced files, and files outside the frontend/assets
package boundary. `package` emits a deterministic `.vsix` ZIP with a root
`manifest.json`; it rejects manifests containing backend contributions. The
CLI has no Host transport, process execution, signing, registry publishing,
scaffolding, or development server.

## Issue 06 external workspace workflow

The repository example at `examples/third-party-files/` is copied into a
temporary project outside the Navide workspace for the release smoke test. Its
package manifest declares SemVer ranges for the three public packages. The
smoke test replaces only those three public package ranges with local packed
tarballs and installs them with `pnpm --offline` in an isolated temporary
store. It uses the repository's installed TypeScript and Vite CLI entries for
the external project's typecheck and build; it does not install TypeScript or
Vite tarballs offline. The example itself contains no `workspace:` or private
feature dependency.

From the external project, the supported workflow is:

```text
pnpm install
pnpm run typecheck
pnpm run build
pnpm run check
pnpm run package
```

The example declares the `fs` system namespace and successfully invokes
`fs.readFile`. It also attempts `shell.run` without declaring `shell`; the Host
authorization seam rejects that call with `CAPABILITY_DENIED`. The example
does not implement backend wire handling, subscriptions, Git transport, or
any later package lifecycle.

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
  before extraction. Each entry name is at most 1024 characters. A directory
  entry may have one trailing `/`; that slash is removed for canonical
  comparison and extraction.
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
| Install and runtime target | No Python installation, `pip`, virtual environment, source checkout, or author build tool may be required on the user's machine. | The Electron main process has an internal Backend Wire v1 supervisor and Host router. Issue 21 exercises one bundled Plans executable directly without a shell; it does not activate installed third-party backends or complete the general package lifecycle. |

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
  ): Disposable & { ready: Promise<void>; settled: Promise<void> }
}
```

`ready` resolves after the Host has accepted the subscription. A package view
may retain an existing event fallback until its package owns the equivalent
event source, and must dispose the returned subscription when its view is
destroyed. `settled` rejects if an accepted subscription ends because the
backend becomes unavailable, so the view can restore that fallback event
route. Issue 22 supplies the package-owned watcher and makes the accepted
package subscription authoritative. Legacy watcher fallback remains available
only when the package subscription cannot be accepted or later becomes
unavailable. This watcher and lifecycle work is test-only until Issue 23E
activates the production Plans package; normal production startup remains on
the legacy adapter.

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
description and installation. Issues 07 and 08 add the private Electron-main
supervisor/stdio and subscription lifecycle seams; Issue 21 connects one
bundled Plans operation and event through the public SDK and Host router. Issue
22's bridge ports and child lifecycle are Host-private implementation seams;
they do not activate the production Plans package or expose core services to
the public SDK. These are not a public installed-backend activation workflow.
Future AI integration is a separate adapter: it may
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

## Agent Execution Policy

The Host has one global, agent-oriented Execution Policy. It is separate from
Manifest `permissions`, package-version Plugin Grants, and direct user actions;
it is not a per-plugin permission document. The normative v1 schema is
[`execution-policy-v1.schema.json`](../plugin-contracts/execution-policy-v1.schema.json).

The policy has exactly these fields:

```json
{
  "schemaVersion": 1,
  "mode": "allowlist",
  "system": ["fs", "ui", "aiCli"],
  "shell": ["git", "gh", "glab"]
}
```

`mode` is exactly `full`, `allowlist`, or `denylist`. `system` contains only
first-level public namespaces (`fs`, `ui`, and `aiCli`). `shell` contains exact
top-level executable names, not command strings or paths. The normative JSON
Schema describes the canonical persisted spelling
`[a-z0-9][a-z0-9._+-]*`. The contract parser also accepts ASCII uppercase
letters in input, canonicalizing them to lowercase before duplicate detection
and persistence, so `git` and `GIT` are the same entry. Entries are unique.
`full` is represented by the same shape with both arrays empty:

```json
{
  "schemaVersion": 1,
  "mode": "full",
  "system": [],
  "shell": []
}
```

The initial Host default is `allowlist` with all three system namespaces and
only `git`, `gh`, and `glab` in `shell`. Wrappers and interpreters are not in
that default. A user policy replaces the single global default and persists at
`<userData>/execution-policy/policy.json`. The Host-owned companion
`<userData>/execution-policy/revision.json` stores the durable revision
high-water mark. A valid policy is accepted only when its `revision` exactly
matches that high-water mark; a missing or corrupt policy therefore cannot
silently roll the effective revision backward. A missing sidecar is a legacy
migration case: only a strict-valid, owner-safe `policy.json` can bootstrap it
at the existing revision, without incrementing; bootstrap is serialized by
exclusive creation, idempotent for parallel readers, and must succeed before
the legacy policy is returned. If an existing sidecar is corrupt or unsafe,
the Host fails closed at the store instance's trusted revision floor, never
reconstructs that floor from `policy.json`, and rejects ordinary set/reset
writes. A strict-valid sidecar below the instance floor is treated as rollback
or inconsistent state: reads fail closed at the floor, while a valid set/reset
may repair it at the next revision. The directory and both files are owner-only
(`0700` and `0600`). Valid updates use same-directory temporary files and
atomic replacement, writing the high-water mark before the policy so an
interrupted update fails closed at the newer revision. Unknown versions,
fields, namespaces, modes, duplicate keys or entries, oversized state, and
unsafe executable spellings fail closed. Corrupt policy or inconsistent
state with a trusted sidecar can be repaired by a valid set/reset; corrupt or
unsafe sidecars and unsafe filesystem entries such as symlinks or non-regular
files remain preserved for explicit recovery or manual cleanup. On read, the
Host repairs an existing policy directory whose mode has drifted from `0700`
before loading its files; a missing directory remains the normal missing-state
path. If the directory cannot be inspected or safely repaired, the store treats
it as unavailable, fails closed, and leaves recovery to explicit or manual
handling rather than interpreting it as a corrupt revision sidecar.

The global-policy portion of Issue 23A defines the durable contract and Host
persistence seam. Repository source selection, UI/IPC exposure, and runtime
enforcement are specified by the relevant follow-up issues; this contract does
not add rules for plugins, Plans, Git, miniIDE, methods, paths, subcommands,
arguments, globs, or regular expressions.

## Repository Policy Recommendations

A repository may provide one untrusted recommendation at the Host-defined
canonical path `.navide/execution-policy.json`. The document uses the same
strict versioned Execution Policy contract as the Host default and global user
setting. Unknown fields or versions, duplicate JSON keys or entries, invalid
modes or namespaces, unsafe executable spellings, oversized files, symlinks,
and non-regular files are invalid and never broaden authority.

Opening a repository only makes its recommendation inspectable. It never
selects the recommendation automatically. Without a per-repository selection,
the Host preserves the existing global default or user policy behavior. An
explicit Host selection chooses exactly one source: the Navide default, the
global user setting, or the repository recommendation. Sources replace one
another; they are not merged with each other, Manifest permissions, or Plugin
Grants.

The Host stores per-repository source selections and the accepted repository
document fingerprint in its owner-only user-data state at
`<userData>/execution-policy/sources.json`, with the companion
`sources-revision.json`. Selection changes use the same durable effective
policy revision as the global policy store and persist across application
restarts. The repository document is never rewritten or deleted by source
selection or by switching back to the default or user source.

The accepted fingerprint is calculated from the parser's canonical policy
representation, including normalized shell names and set-stable system and
shell entries, rather than raw file bytes. Formatting, JSON key ordering, and
equivalent entry ordering therefore do not require re-acceptance. A missing or
temporarily unavailable document resolves to an unavailable source, while an
invalid, unsupported, duplicate-key, or unsafe document resolves to a corrupt
source. A changed valid document makes a previously accepted repository source
stale. In each case the Host preserves the durable selection, leaves the
repository source inactive, and returns the empty fail-closed policy; it never
silently rewrites the selection to default or user.

To accept a repository recommendation, the Host caller must provide the
fingerprint returned by its inspection of the recommendation. The Host
re-reads the canonical document and refuses the selection with
`recommendation-stale` when the current valid fingerprint differs, without
writing source state or advancing the effective policy revision. The caller
must inspect the current recommendation again before explicitly accepting it;
the Host never accepts repository content that was not bound to the caller's
inspected fingerprint.

The Host source snapshot distinguishes `selectedSource` (the last explicit
per-workspace choice) from `activeSource` (the source that actually supplied
the policy) and reports `active`, `stale`, `unavailable`, or `corrupt` status.
No explicit choice is represented by a null `selectedSource` and follows the
global user/default policy without creating source state. Expected source
operation refusals are typed and do not write state or advance the revision;
an explicit `user` selection requires a strict-valid global user policy. If no
such policy exists, a new selection is refused with
`user-policy-unavailable`; an existing user pin remains selected but becomes
`activeSource: null`, `status: unavailable`, and fail-closed. A malformed,
owner-unsafe, or metadata-corrupt global policy instead reports a
`status: corrupt` snapshot and never falls back to the Host default. Querying
never rewrites the pin; recovery requires restoring the global user policy or
explicitly selecting the `default` source. This does not affect an implicit
workspace with no selection, which continues to use the Host default when no
user policy exists.
An explicit Host-only full reset can clear all source selections when the
durable source high-water mark is trustworthy. The snapshot also exposes
opaque revision-aware `effectivePolicyKey` and canonical-policy
`effectivePolicyHash` identities for later Host consumers; Issue 23B does not
implement caching or enforcement. This Host source service is intentionally
not exposed through preload, IPC, renderer APIs, or Settings UI in Issue 23B;
those surfaces belong to Issue 23D.

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

Issue 06 implements `definePlugin` as a transport-free definition factory. It
does not open a preload channel, send `ready`, or provide a runtime adapter;
those responsibilities remain with the later Host integration.

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
| `system:aiCli` | `aiCli.listProfiles`, `startSession`, `resumeSession`, `cancelStart`, `reattachSession`, `sendInput`, `resizeSession`, `redrawSession`, `interruptSession`, `stopSession`, `output`, `exited` | `workspace` |
| `shell` | `shell.run` | `workspace` |

`workspace` is a resource boundary, not raw workspace filesystem access. The
Host derives `workspaceId` from authenticated runtime binding. There is no
public `runtime` scope. Workspace events also require a Host-authenticated
event source for the same workspace; an unbound shared event is dropped.

### Host-managed storage partitions

Manifest v2 exposes durable JSON key/value storage through the public
`storage.get`, `storage.set`, and `storage.delete` methods. Storage is a
Host-managed grant, not a `permissions.system` namespace: a plugin must have a
Host-approved storage grant for its authenticated package version, but must not
declare a new `storage` permission in its manifest.

Current runtime status: the Electron main-process adapter and Host-only
planning/lifecycle seams are implemented. The production source of `storage`
grants and authenticated snapshot context is connected for the first-party
`navide.git` migration; ordinary third-party production calls still receive
`CAPABILITY_DENIED` until their own grant/context integration is delivered.
The API below remains the public contract and does not expose the first-party
storage migration seam to third-party packages.

The SDK calls accept only a partition class and key; the Host derives the
plugin identity, workspace identity, package version, and storage location
from the authenticated runtime binding:

```ts
await context.capabilities.invoke('storage.set', {
  scope: 'plugin',
  key: 'panel-state',
  value: { collapsed: false },
})

const result = await context.capabilities.invoke('storage.get', {
  scope: 'workspace',
  key: 'filters',
})
if (result.found) console.log(result.value)
```

`storage.get` returns `{ found: true, value }` for a stored value, including a
stored top-level `null`, and `{ found: false, value: null }` when the key is
absent. `storage.set` replaces one value atomically and `storage.delete`
returns whether a value was removed. Requests cannot provide a plugin ID,
workspace ID, package version, partition path, or snapshot tier. Such fields
are rejected rather than treated as hints.

`scope: "plugin"` addresses `(authenticatedPluginId, packageVersion, tier,
key)`. All views using that authenticated plugin/package/tier binding share the
partition; another plugin, package version, or tier does not.
`scope: "workspace"` addresses
`(authenticatedPluginId, packageVersion, tier, authenticatedWorkspaceId, key)`.
Workspace storage requires a current authenticated workspace binding and never
falls back to the plugin partition. Missing or mismatched bindings fail closed
with `WORKSPACE_SCOPE_VIOLATION` or `CAPABILITY_DENIED`.

The Host stores data in its application-data directory with owner-only file
permissions. Each logical `(pluginId, packageVersion, tier)` snapshot is a
separate Host-selected directory containing one `plugin.json` file and one
hashed workspace file per workspace. Renderer/plugin identifiers are never
used as path components. Reads touch only the requested partition file, while
the snapshot quota is the sum of the canonical partition-file byte lengths.

The Host-owned layout is:

```text
<userData>/plugin-storage-v2/<plugin-key>/<package-key>/<tier>/
  plugin.json
  workspaces/<workspace-key>.json
```

`<plugin-key>`, `<package-key>`, and `<workspace-key>` are Host-generated
SHA-256 directory/file components; the raw identities never become paths.
Limits are measured in UTF-8 bytes: keys are at most 256 bytes, one canonical
JSON value is at most 1 MiB, and one package-version/tier snapshot is at most
10 MiB.
A 12 MiB per-partition physical format guard is independent of the current
quota. Exceeding a write-time limit returns the stable
`STORAGE_QUOTA_EXCEEDED` error; an unsuccessful write leaves the prior value
intact. Existing structurally valid data is not rejected merely because a
later policy quota is lower.

Durable means that the Host writes a same-directory temporary file, fsyncs the
file, atomically renames it, and fsyncs the parent directory before reporting
success. Deletes use the corresponding directory fsync. A corrupt partition
is preserved and fails only calls targeting that partition; it does not make
other plugin or workspace partitions unreadable.

Candidate, active, and previous snapshot selectors are Host-owned runtime
metadata and are part of the internal storage identity. A request can select
only the explicitly selected tier whose package version matches the
authenticated binding; equal package versions in two tiers remain separate
storage directories. The selected tier is fixed for the lifetime of a runtime
instance, so lifecycle changes destroy/reopen the instance rather than
silently retargeting it. Plugin code never sees tier, version, or storage
identity.

Package-version upgrades do not automatically carry data forward for ordinary
public packages: a new version starts with its own empty snapshot. The
first-party `navide.git` migration is an explicit Host-owned exception: before
its current package version is promoted, the Host may clone the prior active
Git snapshot into the current candidate, then retain the prior snapshot for
rollback. Plugin code cannot select or read the old tier. Issue 28 still owns
the general Host-only clone, promotion, rollback, retention, and
garbage-collection orchestration. Actual uninstall removes all storage for
that plugin after cleanup succeeds; a later reinstall does not restore the
deleted data.

Raw `ui.settings` remains a first-party legacy surface, not plugin storage.
Theme, language, workbench layout, terminal runtime state, workspace files, and
other domain data are not accessible through this API.

The Host will derive every partition identity from the authenticated runtime
binding. The `scope` argument will only select one of the two permitted
partition classes and will not override identity or authorization.

The Host derives the authorization scope, workspace root, plugin identity, and
view identity from the catalog plus authenticated runtime binding. Plugin
requests cannot supply or override any of those values. Every declared method
must pass catalog/request validation, publisher eligibility where required, the
explicit package-version user grant, and authenticated binding checks before an
execution plan is returned.

First-party identity affects eligibility only. It never grants a namespace,
selects a package version, or bypasses the user grant. Git is not an
independent permission. The Host shell executable allowlist contains the
canonical top-level executables `git`, `gh`, and `glab`; all packages,
including `navide.git`, must still declare `shell: "allowlist"` and pass the
same package-version grant and authenticated binding checks. This is one
shared catalog allowlist: adding `gh` and `glab` for Host-owned GitHub/GitLab
Issue detection also makes those executables available to every package that
already has the generic allowlist grant. The public allowlist accepts only
canonical top-level executable names and a fixed set of built-in tool
families; it does not accept wrappers, path-qualified replacements, aliases,
extensions, credential/auth commands, or unknown external subcommands. Git
configuration and execution overrides such as `-c`, `-C`, `--config-env`,
`--git-dir`, `--work-tree`, `--exec-path`, `--upload-pack`, and
`--receive-pack` are rejected, as are direct execution hooks such as
`submodule foreach`, `bisect run`, and `rebase --exec`. Host-owned Git and
Issues services use a separate trusted argv interface and are not constrained
by this public plugin policy.

This remains a command broker rather than a process sandbox. Permitted Git and
provider commands can still modify repositories, contact remotes, and invoke
repository-controlled behavior such as ordinary Git hooks. Treat
`shell: "allowlist"` as a high-trust grant and request it only when the public
catalog methods are insufficient.

### First-party production Git package (Issue 19)

The removable factory-installed `navide.git` package is the first production consumer of the
Manifest v2 custom-view and Host-owned storage seams. Its `left` contribution
is embedded in the workbench and its `window` contribution is opened in the
dedicated Git window; the Host resolves both from one active package
descriptor/version. The package uses custom views only. It does not add a
tree/provider contribution or a public `git` or `issues` permission namespace.

Repository Git operations remain the existing Host/backend service, reached
through a typed first-party bridge and the Host shell broker. GitHub and GitLab
Issue provider detection and JSON normalization remain Host-owned; their
`gh`/`glab` calls use the same shell allowlist described above. The package
cannot provide an executable, raw command, working directory, environment, or
raw terminal access through this bridge. Its AI CLI dock uses the public
`system.aiCli` semantic contract, including Host-generated session identity,
terminal dimensions, redraw dimensions, and stop force semantics.

The bridge also preserves the existing Git contribution behavior (repository
tabs, change counts, issue dispatch/spawn handoffs, pane focus, account
settings, and Git window targets) while keeping workspace and view identity
Host-owned. Factory acquisition and verified Marketplace acquisition both feed
the same Manifest, catalog, exact-version grant, instance, and capability
runtime; factory provenance is not a permission bypass. Removing Bundled Git
records a durable opt-out, and Extensions provides the explicit restore action.
When the selected, trusted, approved `navide.git` version fails to
load, mount, or report ready, the Host retires that package's v2 instances and
uses the retained legacy renderer for the remainder of the process. Trust,
signature, revocation, grant, and capability denials fail closed and never
trigger the legacy path. An invalid installed package is also not hidden by the
factory or legacy copy. `NAVIDE_GIT_RECOVERY=legacy` remains the explicit operator override.
Issue 19 does not remove the legacy implementation or implement later
Plans/Skills migration or marketplace lifecycle work.

### Embedded AI CLI public mapping

`AiCliDock` currently consumes the generic terminal transport. The public
catalog exposes only the Host-mediated AI CLI addresses below:

| Public address | Meaning |
| --- | --- |
| `aiCli.listProfiles` | List the Host-allowlisted profile identifiers and labels |
| `aiCli.startSession` | Start a Host-selected, allowlisted profile |
| `aiCli.resumeSession` | Resume the detached session owned by this package/workspace/view tuple |
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
and event audience. Resize and redraw carry validated positive terminal
dimensions, and stop carries an explicit force value; neither permits raw PTY
or process control. Every control call validates the opaque session against
the authenticated plugin, package version, workspace, view instance, and
audience.
Directed output and exit events are delivered only to the authenticated
audience that created or reattached the session.
`shell.run`, raw command/executable/arguments/environment/working-directory
parameters, and PID control have no `aiCli` mapping and must fail closed.
The Host executor also applies the catalog's active user-gesture requirement
for `ui.openExternal` before opening a URL.
Filesystem calls used by the dock's `@`-file picker remain authorized by
the public `system:fs` catalog; they are not absorbed into the AI CLI
permission.

### Issue 15 runtime boundary

The raw v1 `terminal` PTY namespace is not a Manifest v2 permission and is not
part of the public v2 catalog. Public AI CLI sessions remain Host-mediated
through the `aiCli.*` contract above. The current instance-aware PTY and event
logic is a Host-only integration seam for staged view productionization; no
renderer payload can supply an instance id or capability context, and the
shared backend event listener has no public-event source binding, so v2 events
received there fail closed. A Host producer must call the Host ingress with an
authenticated source: AI CLI output/exit uses the exact per-instance binding,
while `workspace.filesChanged` uses the reserved `host` source identity with
matching workspace and package version. The Host ingress also names the target
package id, so the event reaches eligible views for that exact package id,
version, and workspace; another package sharing the same version and workspace
never receives it.

If a view is torn down while `terminal.create` is still completing, the Host
first sends the generation-scoped create cancellation. If the backend has
already committed and later returns a successful create response, the Host
issues one force-kill for only that response's session id; it never creates a
route for the dead view. A cleanup failure leaves the session unrouted but
still owned by the Host's shared backend connection, so the ownerless-PTY
janitor cannot reclaim it while that connection lives; the PTY is released
when the connection ends and the janitor's grace period elapses.

The v2 ownership table is process-local. Within the same Host process, a view
may reattach only with its full authenticated package-version, workspace,
audience, and instance binding. After a Host app restart, an unknown v2 raw
PTY id is rejected even if the backend PTY process remains alive; durable
reattach requires a future contract covering persistent identity, version,
revocation, expiry, and a backend ownership namespace.

V2 context validation follows the descriptor's canonical package version and
view identity, not the temporary capability-policy adapter. Host-created
instance ids replace any supplied runtime, session, or pending-start instance
ids before the context reaches a running view.

The legacy `open()` entry point is only a lifecycle and plugin-id lookup
adapter. If it receives a descriptor with canonical Manifest v2 identity
(`packageVersion` and `views`), that instance uses v2 event and PTY ownership
rules: unknown reattach ids fail closed and a changed ownership tuple detaches
the route. V1 PTY compatibility applies only to descriptors without v2
identity.

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
| `STORAGE_QUOTA_EXCEEDED` | A storage key, value, or package-version snapshot exceeds its Host limit | Reduce the stored data or remove old keys |
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
- Developer Mode accepts one explicitly selected local unpacked Manifest v1 or
  Manifest v2 frontend directory only when `AGENT_TEAM_PLUGIN_DEV=1` and
  `AGENT_TEAM_PLUGIN_DEV_PATH` names that exact directory. Manifest v1 is a
  bounded local compatibility path: it remains unsigned and local-only, must
  be explicitly selected by the user, and cannot obtain Registry provenance.
  Both versions reject reserved ids and backend contributions and record a
  persistent unsigned/local-only warning. The existing fixed dist-plugins
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

Issue 06 supports the following external frontend workflow:

1. Install the three public packages from their SemVer registry ranges.
2. Declare the smallest permissions and run `navide-plugin validate <directory>`.
3. Run the plugin project's `typecheck` and `build` scripts to create a
   frontend-only staging directory.
4. Run `navide-plugin package <directory> --out <file>` and inspect the root
   manifest and explicit frontend/assets file list.
5. Run the outside-workspace smoke test with an in-memory Host adapter. It
   covers one declared capability success and one undeclared capability denial.

`navide-plugin init`, `navide-plugin dev`, backend executable packaging,
signing, registry publishing, and target-specific artifact lifecycle are later
contracts. This issue deliberately does not implement them.
