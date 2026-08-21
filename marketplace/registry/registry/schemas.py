"""API response models."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class VersionInfo(BaseModel):
    version: str
    package_digest: str
    yanked: bool
    published_at: datetime
    target: str
    registry_envelope: dict
    registry_signature: str | None
    signed: bool
    trust_tier: str
    capabilities: list[str]
    """Declared v2 permission namespaces or legacy `manifest.requires`."""
    sensitive_capabilities: list[str]
    """Subset of `capabilities` flagged for elevated scrutiny (fs/aiCli/shell)."""
    download_count: int
    """Downloads recorded for this specific version."""


class ExtensionSummary(BaseModel):
    namespace: str
    name: str
    identity: str
    display_name: str | None
    description: str | None
    categories: list[str]
    latest_version: str | None
    updated_at: datetime
    download_count: int
    """Aggregate downloads across all versions."""
    rating_average: float
    """Mean rating (0.0 when unrated)."""
    rating_count: int
    featured: bool


class ExtensionDetail(ExtensionSummary):
    publisher: str
    trust_metadata: dict
    trust_metadata_signature: str
    versions: list[VersionInfo]


class ExtensionListResponse(BaseModel):
    items: list[ExtensionSummary]
    total: int
    offset: int
    limit: int


class PublishResponse(BaseModel):
    namespace: str
    name: str
    version: str
    package_digest: str
    yanked: bool


class YankResponse(BaseModel):
    namespace: str
    name: str
    version: str
    yanked: bool


class PublisherRegisterRequest(BaseModel):
    name: str
    public_key: str | None = None
    token: str | None = None
    display_name: str | None = None


class PublisherRegisterResponse(BaseModel):
    name: str
    display_name: str | None
    has_public_key: bool
    has_token: bool


class RatingRequest(BaseModel):
    score: int = Field(ge=1, le=5)
    """A 1-5 rating. Per-user auth/dedup is deferred (see README)."""


class RatingResponse(BaseModel):
    namespace: str
    name: str
    rating_average: float
    rating_count: int


class FeaturedRequest(BaseModel):
    featured: bool = True


class FeaturedResponse(BaseModel):
    namespace: str
    name: str
    featured: bool


class HealthResponse(BaseModel):
    status: str
