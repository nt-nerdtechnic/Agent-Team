# Navide Marketplace Registry

Self-hosted plugin marketplace registry for the Navide / Agent-Team project.
Standalone FastAPI service, managed with [uv]. It does **not** touch the
Electron app or `backend/agent_team_backend/` — it is purely additive under
`marketplace/`.

See [`FORMAT.md`](./FORMAT.md) for the `.vsix`-style package format.

> **Not deployed.** This service currently runs locally only, for development
> and for exercising the publish/install path end to end. Navide ships
> first-party plugins bundled into the app package, so nothing installs from a
> registry in production, and third-party publishing is not open — see
> [the plugin development guide](../../docs/en-US/plugin-development.md) for
> how to get in touch about building one.
>
> Before this is ever exposed publicly, at minimum: add a schema migration
> mechanism (`db.py` only calls `SQLModel.metadata.create_all`, which will not
> add columns to existing tables), set `REGISTRY_ADMIN_TOKEN` (the publisher
> endpoint is open when unset), serve over https, and replace
> `LocalStorageBackend` with real object storage.

## Run locally

```bash
# From the repo root; creates marketplace/registry/.venv on first run.
uv --project marketplace/registry run \
  uvicorn registry.app:app --reload --port 8787
```

Data (SQLite DB + package blobs) lands in `./.registry-data` by default;
override with `REGISTRY_DATA_DIR=/some/path`.

Health check: `curl http://localhost:8787/api/health` → `{"status":"ok"}`.

## Run tests

```bash
uv --project marketplace/registry run pytest marketplace/registry/tests
```

## HTTP API

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/health` | Liveness probe. |
| POST | `/api/publishers` | Register/update a publisher's Ed25519 public key + bearer token. Admin-gated by `X-Admin-Token` when `REGISTRY_ADMIN_TOKEN` is set (open in dev). |
| POST | `/api/publish` | Upload a `.vsix` package (multipart field `package`); requires a `Bearer` publisher token and (in strict mode) a valid `signature`. Validates manifest, verifies signature, stores blob + assets, appends a version with a trust tier. 409 on duplicate, 403 on cross-namespace/bad-signature, 401 on bad/missing token. |
| GET | `/api/extensions` | Search (`q`) over name/description/categories, newest first, paginated (`offset`, `limit`). |
| GET | `/api/extensions/{namespace}/{name}` | Extension detail + full version list, registry envelopes/signatures, and root-signed trust metadata. |
| GET | `/api/extensions/{namespace}/{name}/{version}/download` | Stream the package blob **and increment** the per-version + aggregate download counters. |
| POST | `/api/extensions/{namespace}/{name}/{version}/yank` | Soft-yank a version (excluded from latest resolution, still downloadable by exact version). |
| POST | `/api/extensions/{namespace}/{name}/rating` | Add a `{ "score": 1..5 }` rating; returns the new average + count. Per-user auth/dedup is deferred (see below). |
| POST | `/api/extensions/{namespace}/{name}/featured` | Set the curation flag `{ "featured": bool }`. Admin-gated by `X-Admin-Token` (same gate as `/api/publishers`). |

`GET /api/extensions` also accepts `category` (exact category filter) and
`sort` (`updated` default, `downloads`, `rating`). Each summary now carries
`download_count`, `rating_average`, `rating_count`, `featured`; each version
carries `download_count`.

## Discovery website (p3-discovery)

A dependency-light, server-rendered marketplace site is mounted on the **same**
FastAPI app (Jinja2 templates + self-hosted CSS in `registry/web_templates/`
and `registry/web_static/`; no JS build, no CDN assets). The `/api/*` JSON API
is untouched.

| Method | Path | Renders |
|---|---|---|
| GET | `/` | Home: Featured section, browse grid, keyword search, category filter, sort (downloads/rating/updated). Cards show displayName, publisher, description, categories, downloads, rating, trust badge, sensitive-capability warning. |
| GET | `/extensions/{namespace}/{name}` | Detail: rendered README, screenshots, rating, downloads, per-version trust tier + declared capabilities, install hint, publisher. |
| GET | `/extensions/{namespace}/{name}/{version}/assets/{path}` | Serve an image/asset extracted from the package blob (allow-listed against the version's recorded assets). |
| — | `/static/*` | Self-hosted CSS. |

**README rendering + sanitization.** READMEs are extracted from the stored
`.vsix` blob and rendered with `markdown-it-py` configured with raw HTML
**disabled** (`MarkdownIt("commonmark", {"html": False})`). Any `<script>` /
`<img onerror=…>` in a README is escaped to inert text, and dangerous link
schemes (`javascript:` etc.) are dropped by the built-in link validator, so no
user-authored active markup is ever emitted (`tests/test_web.py`).

**Ratings limitation.** Ratings are stored as `rating_sum` + `rating_count`
(average is derived); the submit endpoint has **no per-user auth or dedup** —
this is a deliberate p3-discovery simplification. Real per-user rating auth is
deferred.

## Security model (p3-security + p3-publish)

**Signing.** Publisher Ed25519 signatures authenticate strict-mode submissions,
but publisher keys are not part of the Client trust contract. After validating
the publisher, namespace, manifest, and complete archive, the registry signs a
canonical JSON envelope binding the archive digest, package/version/target,
publisher, signer `keyId`, and signing time. Extension detail responses include
that envelope/signature and current signer/blocklist metadata signed by the
registry root. A Client accepts this metadata only after verifying it with an
App- or user-pinned root; `rootFingerprint` in a response is informational and
MUST NOT establish trust.

The default `self-hosted-dev` profile creates persistent owner-only keys and a
persistent signer lifecycle under `REGISTRY_DATA_DIR/trust/`. Its signed metadata
is explicitly labelled `self-hosted-dev` and carries the generated root
fingerprint so an operator can approve that root out of band. It never claims
Official Registry provenance. The `official` profile never generates trust
material: startup requires an explicit deployment config whose expected root
fingerprint must match the configured root key and the root pinned into the App
build. Registry root and signer private-key files must be regular, non-symlink
files with owner-only permissions; generated files are created as `0600`.

**Publisher auth + namespace entitlement.** Publish/yank require an
`Authorization: Bearer <token>` header; the token is matched (sha256) against
`Publisher.token_hash`. A publisher may only publish/yank under **its own
namespace** — the `namespace` half of the manifest `id` must equal the
authenticated publisher (else `403`).

**Trust tier (`registry/trust.py`).** Accepted versions are `signed-verified`
after the registry signature is created. Permissive dev mode may accept a
submission without a publisher signature, but it still centrally signs the
accepted artifact before exposing it to clients.

`manifest.requires` is the declared capability allowlist; `fs` and `terminal`
are flagged as **sensitive** (filesystem/shell reach). Trust tier + capabilities
+ sensitive-capabilities are exposed per version in the extension API for the
Extensions view to warn users. This is metadata/gating only — no runtime sandbox.

### Policy config (env)

| Var | Default | Effect |
|---|---|---|
| `REGISTRY_VERIFIER` | `ed25519` | `ed25519` (real) or `accepting` (dev). |
| `REGISTRY_REQUIRE_SIGNATURE` | `true` | Reject unsigned publishes. |
| `REGISTRY_REQUIRE_AUTH` | `true` | Reject anonymous publish/yank. |
| `REGISTRY_ADMIN_TOKEN` | _(unset)_ | Gates `POST /api/publishers` when set; required and non-empty for the `official` profile. |
| `REGISTRY_TRUST_PROFILE` | `self-hosted-dev` | `self-hosted-dev` for persistent locally generated trust material, or `official` for explicitly provisioned production material. |
| `REGISTRY_TRUST_CONFIG_FILE` | _(unset)_ | Required with `official`; path to the complete signer, root, rotation, validity, and blocklist policy below. Rejected for the default profile. |

### Official Registry trust deployment

Set `REGISTRY_TRUST_PROFILE=official` and point
`REGISTRY_TRUST_CONFIG_FILE` at a deployment-owned JSON file:

```json
{
  "schemaVersion": 1,
  "profile": "official",
  "expectedRootFingerprint": "sha256:<App-build-pinned-SPKI-digest>",
  "rootPrivateKeyFile": "/run/secrets/navide-registry-root.pem",
  "signer": {
    "keyId": "registry-2026-02",
    "privateKeyFile": "/run/secrets/navide-registry-signer.pem",
    "status": "active",
    "notBefore": "2026-08-01T00:00:00Z",
    "notAfter": "2027-08-01T00:00:00Z"
  },
  "trustedSigners": [
    {
      "keyId": "registry-2026-01",
      "publicKeyFile": "/etc/navide/trust/registry-2026-01.pub",
      "status": "rotating",
      "notBefore": "2025-08-01T00:00:00Z",
      "notAfter": "2026-09-01T00:00:00Z"
    }
  ],
  "blockedPublishers": ["compromised-publisher"],
  "blockedPackages": ["compromised.package", "acme.demo@1.2.3"]
}
```

All fields are required and unknown or duplicate JSON keys fail startup. The
current signer signs newly accepted artifacts. `trustedSigners` publishes prior
or staged public keys for rotation without granting them access to current
private signing material. Status is root-signed policy: `active` and
time-bounded `rotating` signers can validate artifacts, `expired` signers cannot
create new envelopes, and `revoked` signers fail closed. Package and publisher
blocklists are part of the same root-signed metadata. Changing the official
root requires a matching App build pin (or an authorization chain rooted in the
previous key); a Registry response cannot introduce its own replacement root.

The official profile also rejects verifier, signature, or publisher-auth
downgrades at startup and requires `REGISTRY_ADMIN_TOKEN`; those controls remain
configurable for `self-hosted-dev`.

`rootPrivateKeyFile` is needed by this current implementation to refresh trust
metadata. Production deployment must provide it as protected secret material;
moving root signing to an offline/HSM-backed publisher can replace this file
seam later without changing the Client wire contract.

## Packaging CLI (`navide-plugin`)

Console entry point (see `registry/cli.py`):

```bash
navide-plugin keygen  --out-dir . --name acme        # Ed25519 keypair -> acme.key/acme.pub
navide-plugin pack    ./plugin-src --out my.vsix      # build + validate a .vsix
navide-plugin sign    my.vsix --key acme.key --out my.sig
navide-plugin publish my.vsix --registry http://localhost:8787 \
  --token <bearer> --signature my.sig
```

`pack` reuses the format builder in `registry/package.py`; `sign` reuses the
Ed25519 primitives in `registry/signing.py`.

## Seams left for later Phase 3 todos

- **Discovery frontend** (`p3-discovery`): ✅ built — the server-rendered
  website above. Consumes the same repository layer as `GET /api/extensions`
  (search/category/sort) and `GET /api/extensions/{ns}/{name}`.
- **Extensions view** (`p3-lifecycle`): the in-app view install/update/remove
  drives off the version list + `download` endpoint. It needs, per version:
  `download` URL (streams the blob) and the `X-Package-Digest` response header
  for integrity verification; `latest_version` (summary/detail) resolves
  updates; and the trust fields already exposed — `trust_tier`, `capabilities`,
  `sensitive_capabilities`, `signed` — to gate/warn on install. Download counts
  and ratings are now also available for in-app display.
- **CDN storage** (real storage): `registry/storage.py` — `StorageBackend`
  protocol; only `LocalStorageBackend` is implemented. Drop in S3/CDN behind
  the same protocol.

[uv]: https://docs.astral.sh/uv/
