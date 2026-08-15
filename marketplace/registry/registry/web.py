"""Server-rendered marketplace website (p3-discovery).

A dependency-light discovery frontend for the registry: Jinja2 templates +
self-hosted CSS, mounted on the same FastAPI app as the JSON API. It reads
through the same `RegistryRepository` the API uses -- no duplicated query logic
-- and renders package READMEs from the stored `.vsix` blob.

Security: README markdown is rendered with `markdown-it-py` configured with
raw-HTML disabled (`html=False`), so any `<script>`/`<img onerror=...>` in a
README is escaped to inert text and dangerous link schemes are dropped by the
built-in link validator. No user-authored HTML is ever emitted verbatim.
Package assets (icons/screenshots) are served only for a raster-image
Content-Type allowlist (`SAFE_ASSET_TYPES`) with `nosniff` + a locked-down CSP,
so a package cannot serve active `text/html`/`image/svg+xml` on this origin.
"""

from __future__ import annotations

import zipfile
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from markdown_it import MarkdownIt
from sqlmodel import Session

from .manifest import manifest_capabilities, manifest_icon
from .models import Extension, ExtensionVersion, Publisher
from .repository import RegistryRepository, rating_average
from .storage import StorageError
from .trust import sensitive_capabilities
from .versions import version_key

# Package assets are third-party uploads served on the marketplace origin, so a
# stored `text/html` or `image/svg+xml` Content-Type would be a stored-XSS
# vector. Assets are only ever icons/screenshots, so restrict to raster images
# and harden the response; anything else is rejected rather than sniffed.
SAFE_ASSET_TYPES = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp"}
)

_TEMPLATES_DIR = Path(__file__).parent / "web_templates"

# Raw HTML disabled -> README markdown cannot inject active markup (XSS-safe).
_MD = MarkdownIt("commonmark", {"html": False, "linkify": False})

_README_NAMES = {"readme.md", "readme.markdown", "readme"}


def render_markdown(text: str) -> str:
    """Render trusted-as-text markdown to sanitized HTML (no raw HTML)."""
    return _MD.render(text)


def _repo(request: Request) -> tuple[Session, RegistryRepository]:
    engine = request.app.state.registry.engine
    session = Session(engine)
    return session, RegistryRepository(session)


def _latest_active(versions: list[ExtensionVersion]) -> ExtensionVersion | None:
    active = [v for v in versions if not v.yanked]
    if not active:
        return None
    return max(active, key=lambda v: version_key(v.version))


def _card(extension: Extension, versions: list[ExtensionVersion]) -> dict:
    latest = _latest_active(versions)
    caps = manifest_capabilities(latest.manifest) if latest else []
    return {
        "namespace": extension.namespace,
        "name": extension.name,
        "identity": extension.identity,
        "display_name": extension.display_name or extension.name,
        "description": extension.description or "",
        "categories": extension.categories,
        "download_count": extension.download_count,
        "rating_average": rating_average(extension),
        "rating_count": extension.rating_count,
        "featured": extension.featured,
        "latest_version": latest.version if latest else None,
        "trust_tier": latest.trust_tier if latest else "unsigned",
        "sensitive_capabilities": sensitive_capabilities(caps),
    }


def _read_package_zip(request: Request, package_key: str) -> zipfile.ZipFile | None:
    storage = request.app.state.registry.storage
    try:
        data = storage.get(package_key)
    except StorageError:
        return None
    if not zipfile.is_zipfile(BytesIO(data)):
        return None
    return zipfile.ZipFile(BytesIO(data))


def _extract_readme(request: Request, row: ExtensionVersion) -> str | None:
    zf = _read_package_zip(request, row.package_key)
    if zf is None:
        return None
    with zf:
        target = None
        for entry in zf.namelist():
            if Path(entry).name.lower() in _README_NAMES:
                target = entry
                break
        if target is None:
            return None
        try:
            raw = zf.read(target).decode("utf-8", errors="replace")
        except KeyError:  # pragma: no cover - name came from the archive
            return None
    return render_markdown(raw)


def create_web_router() -> APIRouter:
    router = APIRouter(include_in_schema=False)
    templates = Jinja2Templates(directory=str(_TEMPLATES_DIR))

    @router.get("/", response_class=HTMLResponse)
    def home(
        request: Request,
        q: str | None = None,
        category: str | None = None,
        sort: str = "updated",
    ) -> HTMLResponse:
        if sort not in {"updated", "downloads", "rating"}:
            sort = "updated"
        session, repo = _repo(request)
        try:
            rows, total = repo.search_extensions(
                query=q, category=category, sort=sort, offset=0, limit=60
            )
            items = [_card(e, repo.list_versions(e.id)) for e in rows]
            featured = [
                _card(e, repo.list_versions(e.id)) for e in repo.list_featured()
            ]
            categories = repo.all_categories()
        finally:
            session.close()
        return templates.TemplateResponse(
            request,
            "home.html",
            {
                "items": items,
                "featured": featured,
                "categories": categories,
                "total": total,
                "query": q or "",
                "active_category": category or "",
                "sort": sort,
            },
        )

    @router.get("/extensions/{namespace}/{name}", response_class=HTMLResponse)
    def detail(request: Request, namespace: str, name: str) -> HTMLResponse:
        session, repo = _repo(request)
        try:
            extension = repo.get_extension(namespace, name)
            if extension is None:
                raise HTTPException(status_code=404, detail="extension not found")
            versions = repo.list_versions(extension.id)
            latest = _latest_active(versions)
            ordered = sorted(versions, key=lambda v: v.published_at, reverse=True)
            version_views = [
                {
                    "version": v.version,
                    "trust_tier": v.trust_tier,
                    "signed": v.signature is not None,
                    "yanked": v.yanked,
                    "published_at": v.published_at,
                    "download_count": v.download_count,
                    "capabilities": manifest_capabilities(v.manifest),
                    "sensitive_capabilities": sensitive_capabilities(
                        manifest_capabilities(v.manifest)
                    ),
                }
                for v in ordered
            ]
            readme_html = _extract_readme(request, latest) if latest else None
            screenshots = _screenshots(repo, latest) if latest else []
            icon_path = manifest_icon(latest.manifest) if latest else None
            pub = repo.session.get(Publisher, extension.publisher_id)
            publisher_display = pub.name if pub else extension.namespace
            context = {
                "ext": _card(extension, versions),
                "publisher": publisher_display,
                "versions": version_views,
                "readme_html": readme_html,
                "screenshots": screenshots,
                "icon_path": icon_path,
                "latest_version": latest.version if latest else None,
                "download_count": extension.download_count,
                "rating_average": rating_average(extension),
                "rating_count": extension.rating_count,
            }
        finally:
            session.close()
        return templates.TemplateResponse(request, "detail.html", context)

    @router.get("/extensions/{namespace}/{name}/{version}/assets/{asset_path:path}")
    def asset(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        asset_path: str,
    ) -> Response:
        session, repo = _repo(request)
        try:
            extension = repo.get_extension(namespace, name)
            if extension is None:
                raise HTTPException(status_code=404, detail="extension not found")
            row = repo.get_version(extension.id, version)
            if row is None:
                raise HTTPException(status_code=404, detail="version not found")
            allowed = {a.path: a.content_type for a in repo.list_assets(row.id)}
            if asset_path not in allowed:
                raise HTTPException(status_code=404, detail="asset not found")
            zf = _read_package_zip(request, row.package_key)
            if zf is None:
                raise HTTPException(status_code=404, detail="package unavailable")
            with zf:
                try:
                    blob = zf.read(asset_path)
                except KeyError as exc:
                    raise HTTPException(
                        status_code=404, detail="asset not found"
                    ) from exc
            media = allowed[asset_path]
        finally:
            session.close()
        if media not in SAFE_ASSET_TYPES:
            raise HTTPException(status_code=415, detail="unsupported asset type")
        return Response(
            content=blob,
            media_type=media,
            headers={
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": f'inline; filename="{Path(asset_path).name}"',
            },
        )

    return router


def _screenshots(repo: RegistryRepository, row: ExtensionVersion) -> list[str]:
    icon = manifest_icon(row.manifest)
    paths = []
    for asset in repo.list_assets(row.id):
        if asset.content_type.startswith("image/") and asset.path != icon:
            paths.append(asset.path)
    return sorted(paths)
