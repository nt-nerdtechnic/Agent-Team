"""FastAPI application for the marketplace registry."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from fastapi import Depends, FastAPI, Header, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import Engine
from sqlmodel import Session

from .auth import PublisherIdentity, get_publisher_identity
from .config import VERIFIER_ACCEPTING, Settings, load_settings
from .db import create_db_engine
from .models import Extension, ExtensionVersion, Publisher
from .manifest import ManifestV2, manifest_capabilities
from .package import PackageError, read_package
from .repository import RegistryRepository, rating_average
from .schemas import (
    ExtensionDetail,
    ExtensionListResponse,
    ExtensionSummary,
    FeaturedRequest,
    FeaturedResponse,
    HealthResponse,
    PublisherRegisterRequest,
    PublisherRegisterResponse,
    PublishResponse,
    RatingRequest,
    RatingResponse,
    VersionInfo,
    YankResponse,
)
from .signing import (
    AcceptingSignatureVerifier,
    Ed25519SignatureVerifier,
    SignatureVerifier,
)
from .storage import LocalStorageBackend, StorageBackend, StorageError
from .trust import compute_trust_tier, sensitive_capabilities
from .versions import latest_version


@dataclass
class RegistryState:
    engine: Engine
    storage: StorageBackend
    verifier: SignatureVerifier
    settings: Settings


def _make_verifier(settings: Settings) -> SignatureVerifier:
    if settings.verifier_kind == VERIFIER_ACCEPTING:
        return AcceptingSignatureVerifier()
    return Ed25519SignatureVerifier()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    state = RegistryState(
        engine=create_db_engine(settings.db_path),
        storage=LocalStorageBackend(settings.storage_root),
        verifier=_make_verifier(settings),
        settings=settings,
    )

    app = FastAPI(title="Navide Marketplace Registry", version="0.1.0")
    app.state.registry = state

    _register_routes(app)

    # Discovery website (p3-discovery): server-rendered pages + self-hosted
    # static assets, mounted alongside the /api/* JSON API on the same app.
    from .web import create_web_router

    static_dir = Path(__file__).parent / "web_static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
    app.include_router(create_web_router())
    return app


# -- dependencies -------------------------------------------------------
def _state(request: Request) -> RegistryState:
    return request.app.state.registry


def _session(state: RegistryState = Depends(_state)) -> Iterator[Session]:
    with Session(state.engine) as session:
        yield session


def _repo(session: Session = Depends(_session)) -> RegistryRepository:
    return RegistryRepository(session)


# -- helpers ------------------------------------------------------------
def _package_key(namespace: str, name: str, version: str) -> str:
    return f"{namespace}/{name}/{version}/package.vsix"


def _version_info(row: ExtensionVersion) -> VersionInfo:
    capabilities = manifest_capabilities(row.manifest)
    return VersionInfo(
        version=row.version,
        package_digest=row.package_digest,
        yanked=row.yanked,
        published_at=row.published_at,
        signed=row.signature is not None,
        signature=row.signature,
        trust_tier=row.trust_tier,
        capabilities=capabilities,
        sensitive_capabilities=sensitive_capabilities(capabilities),
        download_count=row.download_count,
    )


def _summary(extension: Extension, versions: list[ExtensionVersion]) -> ExtensionSummary:
    active = [v.version for v in versions if not v.yanked]
    return ExtensionSummary(
        namespace=extension.namespace,
        name=extension.name,
        identity=extension.identity,
        display_name=extension.display_name,
        description=extension.description,
        categories=extension.categories,
        latest_version=latest_version(active),
        updated_at=extension.updated_at,
        download_count=extension.download_count,
        rating_average=rating_average(extension),
        rating_count=extension.rating_count,
        featured=extension.featured,
    )


def _register_routes(app: FastAPI) -> None:
    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @app.post(
        "/api/publishers",
        response_model=PublisherRegisterResponse,
        status_code=201,
    )
    def register_publisher(
        request: Request,
        body: PublisherRegisterRequest,
        x_admin_token: str | None = Header(default=None),
        repo: RegistryRepository = Depends(_repo),
    ) -> PublisherRegisterResponse:
        """Register/update a publisher's Ed25519 public key and bearer token.

        Admin-gated: when `admin_token` is configured it must be presented via
        `X-Admin-Token`; left unset the endpoint is open (dev).
        """
        settings: Settings = request.app.state.registry.settings
        if settings.admin_token is not None and x_admin_token != settings.admin_token:
            raise HTTPException(status_code=401, detail="invalid admin token")
        publisher = repo.register_publisher(
            name=body.name,
            public_key=body.public_key,
            token=body.token,
            display_name=body.display_name,
        )
        return PublisherRegisterResponse(
            name=publisher.name,
            display_name=publisher.display_name,
            has_public_key=publisher.public_key is not None,
            has_token=publisher.token_hash is not None,
        )

    @app.post("/api/publish", response_model=PublishResponse, status_code=201)
    async def publish(
        request: Request,
        package: UploadFile,
        signature: str | None = None,
        identity: PublisherIdentity = Depends(get_publisher_identity),
        repo: RegistryRepository = Depends(_repo),
    ) -> PublishResponse:
        state: RegistryState = request.app.state.registry
        settings = state.settings
        data = await package.read()
        try:
            loaded = read_package(data)
        except PackageError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        manifest = loaded.manifest
        namespace = manifest.namespace
        name = manifest.extension_name

        # Namespace entitlement: an authenticated publisher may only publish
        # under its own namespace (p3-publish).
        if identity.authenticated and identity.publisher != namespace:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"publisher '{identity.publisher}' is not entitled to "
                    f"namespace '{namespace}'"
                ),
            )

        publisher_name = (
            identity.publisher if identity.authenticated else manifest.publisher
        )
        publisher = repo.get_or_create_publisher(publisher_name)

        # Signature gate (p3-security): reject a bad signature; allow unsigned
        # only when the config explicitly permits it (dev).
        if signature is None:
            if settings.require_signature:
                raise HTTPException(
                    status_code=403, detail="package signature is required"
                )
        elif not state.verifier.verify(
            digest=loaded.digest,
            signature=signature,
            public_key=publisher.public_key,
        ):
            raise HTTPException(
                status_code=403, detail="invalid package signature"
            )

        trust_tier = compute_trust_tier(signed=signature is not None)

        if isinstance(manifest, ManifestV2):
            display_name = manifest.name
            description = manifest.marketplace.description
            categories = manifest.marketplace.categories
        else:
            display_name = manifest.displayName or manifest.name
            description = manifest.description
            categories = manifest.categories

        extension = repo.get_or_create_extension(
            publisher=publisher,
            namespace=namespace,
            name=name,
            display_name=display_name,
            description=description,
            categories=categories,
        )

        if repo.get_version(extension.id, manifest.version) is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"version {manifest.version} of {extension.identity} "
                    "already exists"
                ),
            )

        key = _package_key(namespace, name, manifest.version)
        state.storage.put(key, data)
        row = repo.add_version(
            extension=extension,
            version=manifest.version,
            manifest=manifest.model_dump(exclude_none=True),
            package_digest=loaded.digest,
            package_key=key,
            signature=signature,
            trust_tier=trust_tier,
            assets=[(a.path, a.size, a.content_type) for a in loaded.assets],
        )
        return PublishResponse(
            namespace=namespace,
            name=name,
            version=row.version,
            package_digest=row.package_digest,
            yanked=row.yanked,
        )

    @app.get("/api/extensions", response_model=ExtensionListResponse)
    def list_extensions(
        q: str | None = None,
        category: str | None = None,
        sort: str = "updated",
        offset: int = 0,
        limit: int = 20,
        repo: RegistryRepository = Depends(_repo),
    ) -> ExtensionListResponse:
        limit = max(1, min(limit, 100))
        offset = max(0, offset)
        if sort not in {"updated", "downloads", "rating"}:
            sort = "updated"
        rows, total = repo.search_extensions(
            query=q, category=category, sort=sort, offset=offset, limit=limit
        )
        items = [_summary(e, repo.list_versions(e.id)) for e in rows]
        return ExtensionListResponse(
            items=items, total=total, offset=offset, limit=limit
        )

    @app.get(
        "/api/extensions/{namespace}/{name}", response_model=ExtensionDetail
    )
    def extension_detail(
        namespace: str,
        name: str,
        repo: RegistryRepository = Depends(_repo),
    ) -> ExtensionDetail:
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        versions = repo.list_versions(extension.id)
        summary = _summary(extension, versions)
        publisher = repo.session.get(Publisher, extension.publisher_id)
        publisher_name = publisher.name if publisher else extension.namespace
        publisher_key = publisher.public_key if publisher else None
        ordered = sorted(
            versions, key=lambda v: v.published_at, reverse=True
        )
        return ExtensionDetail(
            **summary.model_dump(),
            publisher=publisher_name,
            public_key=publisher_key,
            versions=[_version_info(v) for v in ordered],
        )

    @app.get("/api/extensions/{namespace}/{name}/{version}/download")
    def download(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        repo: RegistryRepository = Depends(_repo),
    ) -> StreamingResponse:
        state: RegistryState = request.app.state.registry
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        row = repo.get_version(extension.id, version)
        if row is None:
            raise HTTPException(status_code=404, detail="version not found")
        try:
            stream = state.storage.open_stream(row.package_key)
        except StorageError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        repo.increment_download(extension, row)
        filename = f"{namespace}.{name}-{version}.vsix"
        return StreamingResponse(
            stream,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Package-Digest": row.package_digest,
            },
        )

    @app.post(
        "/api/extensions/{namespace}/{name}/{version}/yank",
        response_model=YankResponse,
    )
    def yank(
        namespace: str,
        name: str,
        version: str,
        identity: PublisherIdentity = Depends(get_publisher_identity),
        repo: RegistryRepository = Depends(_repo),
    ) -> YankResponse:
        # Only the owning publisher may yank (p3-publish); dev/anonymous is
        # allowed when auth is not required.
        if identity.authenticated and identity.publisher != namespace:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"publisher '{identity.publisher}' cannot yank in "
                    f"namespace '{namespace}'"
                ),
            )
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        row = repo.get_version(extension.id, version)
        if row is None:
            raise HTTPException(status_code=404, detail="version not found")
        row = repo.yank_version(row)
        return YankResponse(
            namespace=namespace, name=name, version=version, yanked=row.yanked
        )

    @app.post(
        "/api/extensions/{namespace}/{name}/rating",
        response_model=RatingResponse,
    )
    def submit_rating(
        namespace: str,
        name: str,
        body: RatingRequest,
        repo: RegistryRepository = Depends(_repo),
    ) -> RatingResponse:
        """Add a 1-5 rating. Per-user auth/dedup is deferred (see README)."""
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        extension = repo.add_rating(extension, body.score)
        return RatingResponse(
            namespace=namespace,
            name=name,
            rating_average=rating_average(extension),
            rating_count=extension.rating_count,
        )

    @app.post(
        "/api/extensions/{namespace}/{name}/featured",
        response_model=FeaturedResponse,
    )
    def set_featured(
        request: Request,
        namespace: str,
        name: str,
        body: FeaturedRequest,
        x_admin_token: str | None = Header(default=None),
        repo: RegistryRepository = Depends(_repo),
    ) -> FeaturedResponse:
        """Admin-gated curation flag (same `X-Admin-Token` gate as publishers)."""
        settings: Settings = request.app.state.registry.settings
        if settings.admin_token is not None and x_admin_token != settings.admin_token:
            raise HTTPException(status_code=401, detail="invalid admin token")
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        extension = repo.set_featured(extension, body.featured)
        return FeaturedResponse(
            namespace=namespace, name=name, featured=extension.featured
        )


# Module-level app for `uvicorn registry.app:app`.
app = create_app()
