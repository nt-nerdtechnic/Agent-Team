# Navide plugin package format (`.vsix`-style)

> **Status: current manifest v1 implementation.** This file documents the
> existing registry reader and includes legacy fields such as `requires` and
> `activationEvents`. It is not the target Manifest v2 author contract. The v2
> target archive layout, path safety, target-specific backend artifact, and
> signing requirements are defined in
> [`docs/en-US/plugin-development-v2.md`](../../docs/en-US/plugin-development-v2.md).

A publishable plugin is a single **ZIP archive** (conventionally `*.vsix`) that
contains a `manifest.json` at its root plus optional asset files. The layout is
intentionally close to the VS Code `.vsix` idea (a ZIP with a manifest and
assets) but uses Navide's own trimmed manifest vocabulary — the same fields the
in-app plugin host already validates
(`backend/agent_team_backend/plugins/manifest.py`).

## Archive layout

```
my-plugin-0.1.0.vsix   (a ZIP archive)
├── manifest.json      (required, at archive root)
├── README.md          (optional)
├── icon.png           (optional; path is whatever manifest.icon points to)
└── screenshots/       (optional)
    └── main.png
```

Rules enforced by the reader (`registry/package.py`):

- The archive MUST be a valid ZIP.
- `manifest.json` MUST exist at the archive root and be valid JSON.
- The manifest MUST validate against the manifest schema below.
- If `manifest.icon` is set, the referenced path MUST exist inside the archive.
- Any other file is treated as an asset and recorded as an asset reference
  (path, size, guessed content-type).
- Archive paths MUST use canonical relative POSIX segments: no empty, `.`, or
  `..` segments, backslashes, duplicate canonical paths, or regular-file
  ancestor collisions. A directory entry may have one trailing `/`.

A malformed archive is rejected with a clear `PackageError`.

## `manifest.json` fields

The **core fields are identical** to the in-app plugin manifest, so a package
that the registry accepts is also loadable by the app's plugin host. The
registry adds a few **optional presentation fields** (marked *marketplace*)
needed for discovery — these are an additive superset, not a divergent schema.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `<namespace>.<name>`, lowercase; regex `^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$`. This is the registry identity. |
| `name` | string | yes | Non-empty. Human name (as in the app manifest). |
| `version` | string | yes | Strict semver `MAJOR.MINOR.PATCH` (no pre-release/build). |
| `publisher` | string | yes | Non-empty publisher id. |
| `engines` | object | yes | Non-empty `{host: range}`; host-API compat lives here, e.g. `{"navide": "^0.1.0"}`. |
| `entry` | string | no | Plugin entry file. |
| `contributes` | object | no | `{ "views": [{id,title}], "commands": [{id,title}] }`. |
| `requires` | string[] | no | Capabilities; each must be one of `fs, git, terminal, search, chat, ui, issues, plans`. |
| `activationEvents` | string[] | no | Each matches `onStartup` \| `onView:<id>` \| `onCommand:<id>`. Honored for backend plugins; frontend views ignore it (they start when the host opens them). |
| `displayName` | string | no | *marketplace* — falls back to `name` when absent. |
| `description` | string | no | *marketplace* — used by search. |
| `categories` | string[] | no | *marketplace* — used by search/filter. |
| `icon` | string | no | *marketplace* — archive-relative path to an icon asset. |

## Signing

There are two deliberately separate signatures:

| Signature | Producer | Purpose | Client trust role |
|---|---|---|---|
| Publisher submission signature | Publisher | Authenticates an upload to the Registry and proves namespace ownership at publish time. | None; a publisher-supplied key never becomes a Client trust root. |
| Registry central signature | Registry signer authorized by root-signed trust metadata | Binds the complete archive digest to immutable package, version, target, publisher, signer, and signing-time identity. | Accepted only after the App verifies current trust metadata with its pre-pinned Registry root. |

A package submission carries a **detached publisher signature** supplied to `POST /api/publish` as
the `signature` query param (not stored inside the ZIP). It is the **base64
encoding of an Ed25519 signature over the package's sha256 digest** (the same
digest the registry computes from the uploaded bytes). The registry verifies it
against the publisher's registered Ed25519 public key
(`registry/signing.py :: Ed25519SignatureVerifier`). This authenticates the
submission only; it is not returned as the Client trust contract. Once accepted,
the registry signs the full artifact digest and immutable listing envelope with
its registry signer and returns root-signed signer/blocklist metadata. Produce
the submission signature with `navide-plugin sign <package> --key <privkey>`.
See the README "Security model" section for the publish gate and policy config.
