# Plugin development guide

Navide plugins extend the app with new surfaces and new backend behavior. This
guide covers both plugin kinds, the manifest schema, the capability permission
model, and the packaging and signing rules.

For the package archive format alone, see
[`marketplace/registry/FORMAT.md`](../../marketplace/registry/FORMAT.md).

## Status: third-party publishing is not open yet

Navide currently ships first-party plugins only. There is no public marketplace
registry to publish to — the registry service in `marketplace/registry/` runs
locally for development, and the plugins that ship with the app are bundled into
the package rather than installed from it.

Two consequences worth knowing before you invest time:

- **You cannot publish a plugin for other users to install yet.** You can build
  and run one locally against a local registry, and everything in this guide
  works for that.
- **The capability whitelist is centrally maintained.** `requires` accepts only
  the namespaces listed under [Capability reference](#capability-reference); a
  plugin asking for anything else is refused as scope over-reach. Adding a new
  namespace means a change to the host, not something a plugin can declare on
  its own.

**If you want to build a plugin, please get in touch first** — open a thread in
[GitHub Discussions](https://github.com/nt-nerdtechnic/Navide/discussions)
(use **Ideas**). Tell us what surface you want to extend and which capabilities
it needs. That is also the route for requesting a new capability namespace. We
would rather shape the API around a real plugin than have you build against
something that is about to move.

## Three trust domains

A plugin travels through three domains, joined by one shared manifest schema and
one capability whitelist:

| Domain | Location | Responsibility |
|---|---|---|
| Marketplace registry | `marketplace/registry/` | Publishing, Ed25519 publisher signatures, trust tiers, discovery |
| Electron main process | `src/main/plugins/` | Loader registry, capability broker, install verification, view lifecycle |
| Python backend host | `backend/agent_team_backend/plugins/` | Module loader, capability façade, backend plugins |

The governing rule is **fail-closed**: signature verification, capability scope,
and archive path safety each reject on failure. Nothing is granted implicitly.

## Two kinds of plugin

**Frontend view plugins** render a UI. They run in a fully sandboxed
`WebContentsView` with `contextIsolation: true`, `nodeIntegration: false`, and
`sandbox: true`. The only host interface they can reach is `window.nav`. Their
manifest declares an `entry` pointing at an HTML file.

**Backend plugins** extend the Python service. They register HTTP routes,
startup and shutdown hooks, or agent spawn transformers. They have no `entry`;
they ship a `backend.py` instead.

A single plugin id may exist in both forms. They are separate plugins in
separate runtimes, not two halves of one thing.

## Quick start: a frontend view plugin

### 1. Create the plugin directory

```
src/renderer/plugins/<name>/
├── index.html      # <div id="app"> plus a module script pointing at mount.ts
├── mount.ts        # mounts your app, then calls window.nav.ready()
└── plugin.json     # source-side reference manifest
```

`mount.ts` must call `window.nav.ready()` once the app is mounted, so the host
knows it can deliver queued open targets:

```ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
window.nav.ready()
```

### 2. Add a Vite config

Each plugin is a **separate Vite build**, not an entry in the core renderer
build. Copy `vite.git.config.ts` and change `pluginRoot`, `outDir`, and the
manifest emitted by the `emitManifest()` plugin.

The separate build exists for a specific reason: it lets you alias
`composables/useBackend` to a `capabilityBackend` shim. A single module graph
cannot diverge per entry, so reusing an existing `useBackend`-based UI inside a
plugin requires its own build. The core renderer keeps the real WebSocket
`useBackend`; the plugin build gets a shim that forwards every `send(type,
payload)` through `window.nav.callCapability`.

If you are writing fresh UI that calls `window.nav` directly, you do not need
the shim — but you still need the separate build to produce a loadable plugin
directory.

The `emitManifest()` hook writes `manifest.json` into the output directory at
`closeBundle`, so the build output is itself a valid, loadable plugin
directory.

### 3. Register the build

In `package.json`, add a `build:<name>` script and chain it into `build`. To
ship the plugin inside the app, add its output to `build.extraResources`:

```json
{ "from": "dist-plugins/<name>", "to": "plugins/<name>" }
```

### 4. Register the plugin with the host

In `src/main/plugins/frontendPluginManager.ts`, follow the Git plugin block:
add the plugin id constant, a `bundled<Name>Dir()` resolver, a
`registerBundled<Name>()` function, a dev descriptor, a query-string builder,
and an `open<Name>PluginView()` entry point. Then call
`registerBundled<Name>()` from `src/main/index.ts`.

Keep the dev descriptor's `requires` identical to the manifest your Vite config
emits. If they drift, dev runs deny capability calls that the packaged build
allows — a failure that only reproduces under `AGENT_TEAM_PLUGIN_DEV=1`.

### 5. Receive host parameters

The host passes context through the entry URL's query string: `workspace_path`,
`http_url`, and `theme`, plus whatever extra parameters the plugin needs. Read
them from `window.location.search`. Seeding your theme from `?theme=` before
mount avoids a flash of the wrong palette.

## Quick start: a backend plugin

Create a directory containing `plugin.json` and `backend.py`. The loader
requires **both** files to be present; a directory holding only `manifest.json`
is treated as a frontend install and skipped. `backend.py` is loaded directly by
path, so no `__init__.py` is needed — add one only if your `backend.py` imports
sibling modules by package path.

```python
# backend.py
def activate(context):
    context.register_route("/my-plugin", asgi_app, methods=["POST"])
    context.register_startup(on_startup)
    context.register_shutdown(on_shutdown)

def deactivate():
    ...
```

`PluginContext` offers:

| Method | Purpose |
|---|---|
| `register_route(path, asgi_app, methods)` | Mount an HTTP route |
| `register_startup(hook)` | Run at service startup (may be async) |
| `register_shutdown(hook)` | Run at service shutdown |
| `register_spawn_transformer(fn)` | Rewrite an agent's spawn command: `(agent_key, command, port) -> command` |
| `clear_registrations()` | Drop registrations on deactivate |

Place the directory under `plugins/builtin/` to ship it with the service, or
install it into the directory named by `AGENT_TEAM_PLUGINS_DIR`. Discovery is
automatic — no wiring changes are needed. Each plugin loads inside its own
try/except, so a failing plugin never blocks service startup.

`navide_plans` is the reference implementation: it registers a route, startup
and shutdown hooks, and a spawn transformer.

## Manifest reference

| Field | Rule | Required |
|---|---|---|
| `id` | `^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$`. The `navide.` prefix is reserved | yes |
| `name` | Non-empty string | yes |
| `version` | Strict semver `MAJOR.MINOR.PATCH`, no pre-release or build metadata | yes |
| `publisher` | Non-empty publisher id | yes |
| `engines` | Non-empty object containing `navide`, e.g. `{"navide": "^0.1.0"}` | yes |
| `entry` | Frontend bundle entry point; validated against path escape | frontend only |
| `requires` | Capability namespaces; each must be in the whitelist below | no |
| `activationEvents` | Each matches `onStartup`, `onView:<id>`, or `onCommand:<id>`. **Backend plugins only** — see below | no |
| `contributes` | `{ "views": [{id, title}], "commands": [{id, title}] }` | no |
| `displayName`, `description`, `categories`, `icon` | Marketplace presentation only | no |

The authoritative schema lives in
`backend/agent_team_backend/plugins/manifest.py`. The marketplace registry
accepts the same core fields plus the presentation fields — an additive
superset, not a divergent schema.

**Filename matters**: backend plugin directories are read as `plugin.json`;
installed frontend packages are read as `manifest.json`. Under
`src/renderer/plugins/*/`, `plugin.json` is a source-side reference; the
`manifest.json` that actually ships is generated by the Vite config.

**Activation differs by kind.** A backend plugin is activated by the host at
the point its `activationEvents` call for — `wiring.py` checks the list before
running `activate()`. A frontend view has no activation events at all: its
`WebContentsView` is created the first time the host opens the view, and torn
down when the view closes. That is already the laziest possible lifecycle, so
the bundled frontend plugins declare no `activationEvents`, and you should not
either — the frontend loader never reads the field, and a declaration would
promise a lifecycle nothing implements.

## Capability reference

A plugin may only call namespaces it declares in `requires`. Anything else is
rejected with `CAP_DENIED` before it reaches the backend.

### Namespaces

| Namespace | Grants |
|---|---|
| `fs` | File read/write, directory listing, glob, archive listing, image reading — and the `git.changed` working-tree event |
| `git` | Status, log, diff, branch, stage, commit, sync, and credential events |
| `terminal` | Shell execution |
| `search` | Find and replace across files |
| `chat` | AI chat, editor rewrite/complete, review, analyzer models |
| `ui` | Settings get/set, settings-changed events, opening a file in the editor |
| `issues` | Cloud issue provider, list, get, create, comment, set state |
| `plans` | The `plans.changed` event (event-only; no request methods) |

`ping` is always available without declaring it, and is useful for verifying the
bridge works before wiring anything real.

`fs` and `terminal` are **sensitive**: installing a plugin that requests them
triggers an extra trust confirmation in the UI.

### Calling a capability

```js
const res = await window.nav.callCapability('fs', 'read_file', { path })
```

The host resolves the calling plugin's identity from the Electron sender id, not
from anything in the payload, so a plugin cannot impersonate another.

The `fs`, `git`, `search`, and `issues` namespaces map one-to-one onto backend
message types. `terminal`, `chat`, and `ui` are remapped — the full table:

| Capability | Backend type |
|---|---|
| `terminal.run` | `shell.run` |
| `chat.start` / `chat.stop` | `ai.chat.start` / `ai.chat.stop` |
| `chat.enhance_prompt` / `chat.web_search` | `ai.enhance_prompt` / `ai.web.search` |
| `chat.editor_rewrite` / `chat.editor_complete` | `editor.rewrite` / `editor.complete` |
| `chat.review_start` / `chat.review_stop` | `ai.review.start` / `ai.review.stop` |
| `chat.analyzer_models` | `analyzer.models` |
| `chat.settings_get` / `chat.settings_set` | `ai.chat.settings.get` / `ai.chat.settings.set` |
| `chat.test_connection` | `ai.chat.test_connection` |
| `chat.accept_edit` | `ai.chat.accept_edit` |
| `chat.approve_command` / `chat.reject_command` | `ai.chat.approve_command` / `ai.chat.reject_command` |
| `chat.notes_get` / `chat.notes_set` | `ai.chat.notes.get` / `ai.chat.notes.set` |
| `chat.threads_get` / `chat.threads_set` | `ai.chat.threads.get` / `ai.chat.threads.set` |
| `ui.settings_get` / `ui.settings_set` | `ui.settings.get` / `ui.settings.set` |

`ui.open_in_editor` is handled by the host process directly and never reaches
the backend.

Errors arrive as one of `CAP_DENIED`, `UNKNOWN`, `BAD_REQUEST`, or
`BACKEND_ERROR`.

### Receiving events

```js
const dispose = window.nav.on('git.changed', (payload) => { ... })
```

Events are gated by namespace, so you only receive what your `requires` covers:

| Event | Requires |
|---|---|
| `git.changed` | `fs` (it is a working-tree change signal) |
| `git.credential_request`, `git.credential_cancelled` | `git` |
| `ui.settings_changed` | `ui` |
| `ai.chat.*`, `ai.review.*` | `chat` |
| `plans.changed` | `plans` |

The host also emits a synthetic `nav.backend_status` event so a plugin can track
whether the backend connection is actually live.

### Backend capability maturity

Python plugins receive capability objects built from their `requires`. These
differ in maturity:

| Capability | State |
|---|---|
| `fs`, `git`, `search`, `issues` | Available |
| `terminal.run` | Available and hardened: `cwd` must be a registered workspace root or a subdirectory, 30-second timeout, output truncated at 8000 characters |
| `chat` | Partly available — settings, notes, threads, edit approval, and editor rewrite/complete delegate to the core service; `start`, `stop`, `test_connection`, `enhance_prompt`, and `web_search` raise `CapabilityNotAvailable` |
| `ui` | Interface only — all methods raise `CapabilityNotAvailable`; the namespace exists so authorization can be recorded |
| `plans` | Empty marker |

Frontend capability calls do **not** pass through the Python plugin host. The
broker forwards them to the backend's existing handler registry. The Python
capability objects serve Python plugins only.

## The `window.nav` bridge

The plugin preload exposes exactly one global. `window.agentTeam` is not
available to plugins.

| Method | Purpose |
|---|---|
| `callCapability(ns, method, args)` | Invoke a capability; returns a promise |
| `on(type, cb)` | Subscribe to an event; returns a disposer |
| `ready()` | Signal that the plugin has mounted |
| `hideSelf()` | Hide or close this plugin's own view |
| `onOpenTarget(cb)` | Receive incremental open targets (e.g. a file to open) |

`hideSelf()` is scoped to the caller — a plugin can only hide itself.

When the host routes an open target to an already-running plugin in the same
workspace, it delivers it through `onOpenTarget` rather than reloading, so open
tabs and scroll positions survive. Switching workspace reloads the entry.

## Security model

**Signatures.** A package carries a detached Ed25519 signature over the
archive's sha256 digest, supplied at publish time rather than stored inside the
archive. Produce it with `navide-plugin sign <package> --key <privkey>`.

**Trust tiers.** A package is either `signed-verified` or `unsigned`. Missing
signature material always yields `unsigned` — a registry cannot raise a
package's trust tier by asserting one.

**Reserved namespace.** Plugin ids beginning with `navide.` are reserved for
first-party plugins and are pinned to an official publisher key. Use your own
publisher prefix.

**Two-phase install.** `prepareInstall` downloads, cross-checks the digest,
parses and validates the manifest, verifies the signature, and checks capability
scope — all without writing to disk. Only after the user confirms any sensitive
capabilities does `commitInstall` write the plugin. Downloaded bytes never enter
a renderer process.

**Archive safety.** Every entry path is checked against directory escape before
extraction. Size limits are 50 MB per entry and 200 MB per archive.

**Install receipts.** First-party installs carry a receipt that is re-verified
against the pinned key on every load. A package that ships its own receipt file
is rejected.

## Packaging and publishing

Build the plugin, then package the output directory:

```bash
pnpm run build:<name>
navide-plugin keygen --out-dir <dir> --name <publisher>   # first time only
navide-plugin pack dist-plugins/<name>                    # → <id>-<version>.vsix
navide-plugin sign <package> --key <privkey>
navide-plugin publish <package> --registry <url> --token <token> --signature <sig>
```

`pack` requires a `manifest.json` in the source directory and names the output
`<id>-<version>.vsix` unless `--out` says otherwise. `--signature` accepts either
the signature string or a path to a signature file. `--registry` and `--token`
are required for `publish`.

The `navide-plugin` CLI ships with the registry service
(`marketplace/registry/`). Run it through
`uv --project marketplace/registry run navide-plugin`.

The archive is a ZIP with `manifest.json` at its root. Any other file is
recorded as an asset. If `manifest.icon` is set, the referenced path must exist
inside the archive.

**The registry is currently self-hosted.** The default endpoint is
`http://localhost:8787`, and plaintext HTTP is rejected outside loopback in
production builds. Publishing requires a publisher account on the registry
instance you are targeting. There is no public Navide registry yet, so
third-party distribution today means running your own instance or installing
from a local package.

## Local development

Set `AGENT_TEAM_PLUGIN_DEV=1` to expose the plugin dev menu, which registers dev
descriptors pointing at local build output and adds entries for the `noop` and
`fs_probe` probe plugins.

`noop` verifies the IPC bridge end to end with a `ping` call. `fs_probe`
demonstrates a real capability call plus event subscription. Both are minimal
and are the fastest way to confirm your environment works before writing a real
plugin.

## Testing

Frontend and main-process tests run under Vitest; files needing a DOM declare
`// @vitest-environment happy-dom` at the top. Backend plugin tests live in
`backend/tests/`.

Two conventions are worth copying:

- **Shim interface parity.** A `capabilityBackend` shim test starts by assigning
  the shim's type to the real `useBackend` type in both directions, so an
  interface drift fails at compile time rather than at runtime.
- **Map inversion.** The host's capability map and the shim's reverse map live
  in different builds and cannot share code, so a test cross-checks that they
  are exact inverses.

## Current limits

- Plugins can be installed and removed, but not disabled — there is no
  enable/disable state.
- `chat` and `ui` backend capabilities are interface-only for Python plugins;
  see the maturity table above.
- `contributes.views` and `contributes.commands` are accepted and validated by
  the manifest schema, but are not yet rendered or dispatched by the host.
