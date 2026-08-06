"""Database-backed Phase 2 preprocessing pipeline.

Run with ``python -m preprocessing.pipeline`` after applying
``database/migrations/002_add_preprocessing_columns.sql``.  The pipeline only
writes Phase 2 columns; the Phase 1 source record is never changed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from psycopg2.extras import Json

from database.connection import db_cursor
from preprocessing.cleaner import clean_article_content
from preprocessing.language_detector import detect_language
from preprocessing.metadata_extractor import extract_metadata
from preprocessing.models import QualityValidationResult, RawArticleRecord
from preprocessing.quality_validator import validate_article_quality
from preprocessing.text_normalizer import normalize_article_text
from utils.logger import get_logger

logger = get_logger(__name__)

_PENDING_ARTICLES_QUERY = """
SELECT
    id, url, title, publisher, source_type, category, language,
    published_at, collected_at, content_hash, cleaned_text, raw_json_path
FROM articles
WHERE processed_at IS NULL
ORDER BY id
"""

_DUPLICATE_TITLE_QUERY = """
SELECT EXISTS (
    SELECT 1
    FROM articles
    WHERE id <> %s
      AND lower(trim(title)) = lower(trim(%s))
)
"""

_DUPLICATE_CONTENT_QUERY = """
SELECT EXISTS (
    SELECT 1
    FROM articles
    WHERE id <> %s
      AND normalized_content = %s
)
"""

_UPDATE_PREPROCESSING_QUERY = """
UPDATE articles
SET
    processed_content = %(processed_content)s,
    normalized_content = %(normalized_content)s,
    detected_language = %(detected_language)s,
    language_confidence = %(language_confidence)s,
    word_count = %(word_count)s,
    sentence_count = %(sentence_count)s,
    paragraph_count = %(paragraph_count)s,
    character_count = %(character_count)s,
    reading_time_minutes = %(reading_time_minutes)s,
    summary = %(summary)s,
    keywords = %(keywords)s,
    is_valid = %(is_valid)s,
    validation_reason = %(validation_reason)s,
    processed_at = %(processed_at)s
WHERE id = %(article_id)s
"""


@dataclass
class PreprocessingStats:
    """Counts produced by one preprocessing run."""

    processed: int = 0
    valid: int = 0
    invalid: int = 0
    failed: int = 0


def _rows_to_articles(cursor: Any, rows: Iterable[tuple[Any, ...]]) -> list[RawArticleRecord]:
    """Convert DB cursor tuples to the typed Phase 2 input model."""
    column_names = [description.name for description in cursor.description]
    return [RawArticleRecord.model_validate(dict(zip(column_names, row))) for row in rows]


def _database_validation_reasons(cursor: Any, article: RawArticleRecord, content: str) -> list[str]:
    """Return quality failures that can only be determined from stored records."""
    reasons: list[str] = []

    if not article.publisher or not article.publisher.strip():
        reasons.append("Publisher is missing")
    if article.published_at is None:
        reasons.append("Publication date is missing")

    title = article.title.strip()
    if title:
        cursor.execute(_DUPLICATE_TITLE_QUERY, (article.id, title))
        if cursor.fetchone()[0]:
            reasons.append("Duplicate title")

    if content:
        cursor.execute(_DUPLICATE_CONTENT_QUERY, (article.id, content))
        if cursor.fetchone()[0]:
            reasons.append("Duplicate content")

    return reasons


def _combine_validation(
    content_validation: QualityValidationResult, database_reasons: list[str]
) -> QualityValidationResult:
    """Merge pure-text and database-aware validation into one result."""
    reasons = list(database_reasons)
    if content_validation.validation_reason:
        reasons.insert(0, content_validation.validation_reason)

    if reasons:
        return QualityValidationResult(is_valid=False, validation_reason="; ".join(reasons))
    return QualityValidationResult(is_valid=True, validation_reason=None)


def _update_article(cursor: Any, article_id: int, values: dict[str, Any]) -> None:
    """Persist only the columns introduced by the Phase 2 migration."""
    cursor.execute(_UPDATE_PREPROCESSING_QUERY, {"article_id": article_id, **values})


def run_preprocessing_pipeline() -> PreprocessingStats:
    """Process every article that has not yet received Phase 2 output.

    A malformed record is logged and skipped while the rest of the batch
    continues.  Database connection/query failures are allowed to propagate
    after ``db_cursor`` logs and rolls back the transaction, preventing a
    partially committed database state.
    """
    stats = PreprocessingStats()
    logger.info("Starting preprocessing pipeline.")

    with db_cursor() as cursor:
        cursor.execute(_PENDING_ARTICLES_QUERY)
        articles = _rows_to_articles(cursor, cursor.fetchall())
        logger.info("Found %d article(s) pending preprocessing.", len(articles))

        for position, article in enumerate(articles, start=1):
            try:
                logger.info("Processing article %d/%d (id=%d).", position, len(articles), article.id)
                processed_content = clean_article_content(article.cleaned_text or "")
                normalized_content = normalize_article_text(processed_content)
                language = detect_language(normalized_content)
                metadata = extract_metadata(normalized_content, language.language)
                text_validation = validate_article_quality(normalized_content)
                db_reasons = _database_validation_reasons(cursor, article, normalized_content)
                validation = _combine_validation(text_validation, db_reasons)

                _update_article(
                    cursor,
                    article.id,
                    {
                        "processed_content": processed_content,
                        "normalized_content": normalized_content,
                        "detected_language": language.language,
                        "language_confidence": language.confidence,
                        "word_count": metadata.word_count,
                        "sentence_count": metadata.sentence_count,
                        "paragraph_count": metadata.paragraph_count,
                        "character_count": metadata.character_count,
                        "reading_time_minutes": metadata.reading_time_minutes,
                        "summary": metadata.summary,
                        "keywords": Json(metadata.keywords),
                        "is_valid": validation.is_valid,
                        "validation_reason": validation.validation_reason,
                        "processed_at": datetime.now(timezone.utc),
                    },
                )
                stats.processed += 1
                if validation.is_valid:
                    stats.valid += 1
                else:
                    stats.invalid += 1
                    logger.warning("Article id=%d flagged: %s", article.id, validation.validation_reason)
            except Exception:  # noqa: BLE001 - a bad row must not halt a batch
                stats.failed += 1
                logger.exception("Preprocessing failed for article id=%d; continuing.", article.id)

    logger.info(
        "Preprocessing complete: processed=%d valid=%d invalid=%d failed=%d.",
        stats.processed,
        stats.valid,
        stats.invalid,
        stats.failed,
    )
    return stats


if __name__ == "__main__":
    run_preprocessing_pipeline()
