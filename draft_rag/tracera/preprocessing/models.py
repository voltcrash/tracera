"""
preprocessing/models.py

Pydantic data contracts for the Phase 2 preprocessing pipeline.

RawArticleRecord  = what preprocessing reads FROM the `articles` table
                    (mirrors the Phase 1 schema in database/schema.sql
                    exactly; this module never modifies that schema).
ProcessedArticle  = what preprocessing writes BACK to the `articles`
                    table's new Phase 2 columns (see
                    database/migrations/002_add_preprocessing_columns.sql).

Every other preprocessing/ module imports these instead of passing
raw dicts around, so the boundary between pipeline stages is explicit
and type-checked.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class RawArticleRecord(BaseModel):
    """
    One row read from the Phase 1 `articles` table — the input to the
    Phase 2 pipeline. Field names and types mirror database/schema.sql
    exactly. This is a read-only view of Phase 1 data; preprocessing
    never mutates these fields, only reads them.
    """

    id: int
    url: str
    title: str
    publisher: Optional[str] = None
    source_type: Optional[str] = None
    category: Optional[str] = None
    language: Optional[str] = None  # Phase 1's column (GDELT-only, usually null) — NOT Phase 2's detected_language
    published_at: Optional[datetime] = None
    collected_at: Optional[datetime] = None
    content_hash: str
    cleaned_text: Optional[str] = ""
    raw_json_path: Optional[str] = None

    model_config = ConfigDict(frozen=True)


class LanguageDetectionResult(BaseModel):
    """Output of language_detector.py for a single article."""

    language: Optional[str] = None  # ISO 639-1 code, e.g. "en", "fr", "hi"; None if detection failed
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    detection_error: Optional[str] = None  # populated when detection failed, for logging/debugging


class ExtractedMetadata(BaseModel):
    """Output of metadata_extractor.py for a single article."""

    word_count: int = 0
    sentence_count: int = 0
    paragraph_count: int = 0
    character_count: int = 0
    reading_time_minutes: float = 0.0
    summary: str = ""  # first-paragraph-derived summary
    keywords: List[str] = Field(default_factory=list)


class QualityValidationResult(BaseModel):
    """
    Output of quality_validator.py for a single article.

    is_valid=False does NOT mean the article is deleted or skipped
    from storage — it's still written back with is_valid=False and a
    reason, so Phase 3 (Chunking) can filter on this column rather
    than re-deriving validity itself.
    """

    is_valid: bool
    validation_reason: Optional[str] = None  # None when is_valid is True


class ProcessedArticle(BaseModel):
    """
    Full result of running one RawArticleRecord through the Phase 2
    pipeline (cleaner -> normalizer -> language detector -> metadata
    extractor -> quality validator). This is what database/models.py
    (Phase 2's, not Phase 1's) writes back to the `articles` table.
    """

    article_id: int
    processed_content: str  # cleaned, HTML-free, whitespace-normalized text
    normalized_content: str  # processed_content further normalized (quotes/dashes/punctuation)

    language: LanguageDetectionResult
    metadata: ExtractedMetadata
    validation: QualityValidationResult

    processed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    model_config = ConfigDict(arbitrary_types_allowed=True)
