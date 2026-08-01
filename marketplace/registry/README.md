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
| GET | `/api/extensions/{namespace}/{name}` | Extension detail + full version list + publisher. |
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

**Signing.** The registry runs its own plugin-signing chain (independent of
Apple DevID / macOS notarization). A publisher registers an **Ed25519** public
key; a package carries a detached **base64 signature over the package's sha256
digest**. At publish time the signature is verified against the publisher's key
(`registry/signing.py :: Ed25519SignatureVerifier`). The permissive
`AcceptingSignatureVerifier` is retained for dev/tests and selected via
`REGISTRY_VERIFIER=accepting`.

**Publisher auth + namespace entitlement.** Publish/yank require an
`Authorization: Bearer <token>` header; the token is matched (sha256) against
`Publisher.token_hash`. A publisher may only publish/yank under **its own
namespace** — the `namespace` half of the manifest `id` must equal the
authenticated publisher (else `403`).

**Trust tier (`registry/trust.py`).** Each version is tagged:

- `signed-verified` — a signature verified against the publisher's key.
- `unsigned` — no signature (only allowed when `REGISTRY_REQUIRE_SIGNATURE=false`).

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
| `REGISTRY_ADMIN_TOKEN` | _(unset)_ | Gates `POST /api/publishers` when set. |

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
