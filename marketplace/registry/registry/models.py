"""SQLModel data model for the registry.

Persistence is SQLite for the local/dev slice; all access goes through
`repository.RegistryRepository` so a different store can replace it later.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Column, UniqueConstraint
from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Publisher(SQLModel, table=True):
    __tablename__ = "publisher"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    """The publisher namespace (lowercase)."""
    display_name: str | None = None
    public_key: str | None = None
    """Registered Ed25519 public key (PEM); used to verify package signatures."""
    token_hash: str | None = Field(default=None, index=True)
    """sha256 of the publisher's bearer token; None until a token is issued."""
    created_at: datetime = Field(default_factory=_now)


class Extension(SQLModel, table=True):
    __tablename__ = "extension"
    __table_args__ = (UniqueConstraint("namespace", "name", name="uq_extension_identity"),)

    id: int | None = Field(default=None, primary_key=True)
    publisher_id: int = Field(foreign_key="publisher.id", index=True)
    namespace: str = Field(index=True)
    name: str = Field(index=True)
    identity: str = Field(index=True, unique=True)
    """`namespace.name`."""
    display_name: str | None = None
    description: str | None = None
    categories: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    featured: bool = Field(default=False, index=True)
    """Curation flag surfaced in the marketplace Featured section (admin-set)."""
    download_count: int = Field(default=0)
    """Aggregate downloads across all versions of this extension."""
    rating_sum: int = Field(default=0)
    """Sum of submitted rating scores; average = rating_sum / rating_count."""
    rating_count: int = Field(default=0)
    """Number of submitted ratings."""
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class ExtensionVersion(SQLModel, table=True):
    __tablename__ = "extension_version"
    __table_args__ = (
        UniqueConstraint("extension_id", "version", name="uq_version_identity"),
    )

    id: int | None = Field(default=None, primary_key=True)
    extension_id: int = Field(foreign_key="extension.id", index=True)
    version: str = Field(index=True)
    manifest: dict = Field(default_factory=dict, sa_column=Column(JSON))
    """Frozen snapshot of the manifest at publish time."""
    package_digest: str
    """sha256 hex of the uploaded package."""
    package_key: str
    """Storage key for the package blob."""
    signature: str | None = None
    """Detached Ed25519 signature (base64) over the package digest, if signed."""
    target: str = Field(default="universal", index=True)
    registry_envelope: dict = Field(default_factory=dict, sa_column=Column(JSON))
    """Immutable artifact identity envelope signed by the registry."""
    registry_signature: str | None = None
    """Detached Ed25519 signature over canonical registry_envelope JSON."""
    trust_tier: str = Field(default="unsigned", index=True)
    """Trust tier computed at publish: 'signed-verified' or 'unsigned' (see trust.py)."""
    download_count: int = Field(default=0)
    """Number of times this specific version's package was downloaded."""
    yanked: bool = Field(default=False, index=True)
    published_at: datetime = Field(default_factory=_now)


class ExtensionAsset(SQLModel, table=True):
    __tablename__ = "extension_asset"

    id: int | None = Field(default=None, primary_key=True)
    version_id: int = Field(foreign_key="extension_version.id", index=True)
    path: str
    """Archive-relative path."""
    size: int
    content_type: str
