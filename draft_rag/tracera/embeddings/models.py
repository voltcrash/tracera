"""Typed contracts used by the Phase 3 embedding pipeline.

These models keep database records, model output, and batch outcomes explicit
at each Phase 3 boundary.  They do not modify Phase 1 ingestion or Phase 2
preprocessing records.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator


EMBEDDING_DIMENSIONS = 384
DEFAULT_EMBEDDING_MODEL = "all-MiniLM-L6-v2"
DEFAULT_EMBEDDING_VERSION = "v1"

EmbeddingVector = Annotated[list[float], Field(min_length=EMBEDDING_DIMENSIONS, max_length=EMBEDDING_DIMENSIONS)]


class EmbeddingArticle(BaseModel):
    """Valid Phase 2 article data eligible for local embedding generation."""

    article_id: int = Field(gt=0)
    processed_content: str = Field(min_length=1)

    model_config = ConfigDict(frozen=True)

    @field_validator("processed_content")
    @classmethod
    def content_must_not_be_whitespace(cls, value: str) -> str:
        """Reject whitespace-only text before it reaches model inference."""
        if not value.strip():
            raise ValueError("processed_content must contain non-whitespace text")
        return value


class ArticleEmbedding(BaseModel):
    """A 384-dimensional local embedding ready for PostgreSQL pgvector storage."""

    article_id: int = Field(gt=0)
    vector: EmbeddingVector
    model_name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    embedded_at: datetime

    model_config = ConfigDict(frozen=True, protected_namespaces=())


class EmbeddingBatchResult(BaseModel):
    """Result of embedding and storing one bounded batch of articles."""

    attempted: int = Field(ge=0)
    embedded: int = Field(ge=0)
    stored: int = Field(ge=0)
    failed_article_ids: list[int] = Field(default_factory=list)

    model_config = ConfigDict(frozen=True)

    @field_validator("embedded", "stored")
    @classmethod
    def counts_cannot_exceed_attempted(cls, value: int, info) -> int:
        """Prevent impossible metrics from being reported by the pipeline."""
        attempted = info.data.get("attempted")
        if attempted is not None and value > attempted:
            raise ValueError(f"{info.field_name} cannot exceed attempted")
        return value


class EmbeddingPipelineSummary(BaseModel):
    """Aggregate outcome returned after a complete Phase 3 pipeline run."""

    batches_processed: int = Field(ge=0)
    articles_attempted: int = Field(ge=0)
    articles_embedded: int = Field(ge=0)
    articles_stored: int = Field(ge=0)
    failed_article_ids: Sequence[int] = Field(default_factory=tuple)

    model_config = ConfigDict(frozen=True)
