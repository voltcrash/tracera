"""
database/models.py

Data-access functions for the `articles` table. Named "models.py" to
match the project's intended structure, though in Phase 1 these are
plain functions rather than ORM classes — deliberately simple until an
ORM is actually justified.
"""

from pathlib import Path
from typing import List, Optional

from psycopg2.extras import execute_values

from database.connection import db_cursor
from ingestion.article_model import Article
from utils.logger import get_logger

logger = get_logger(__name__)


INSERT_QUERY = """
INSERT INTO articles (
    url, title, publisher, source_type, category, language,
    published_at, collected_at, content_hash, cleaned_text, raw_json_path
)
VALUES %s
ON CONFLICT (content_hash) DO NOTHING
"""


def _article_to_row(article: Article, raw_json_path: Optional[str]) -> tuple:
    return (
        str(article.url),
        article.title,
        article.publisher,
        article.source_type,
        article.category,
        article.language,
        article.published_at,
        article.collected_at,
        article.content_hash,
        article.cleaned_text,
        raw_json_path,
    )


def insert_articles(articles: List[Article], raw_json_path: Optional[Path] = None) -> int:
    """
    Bulk-insert article metadata into PostgreSQL. Articles whose
    content_hash already exists are silently skipped (ON CONFLICT DO
    NOTHING) rather than raising, since dedup against the DB is a normal,
    expected occurrence on every run.

    Returns the number of rows actually inserted (best-effort; psycopg2's
    execute_values doesn't return per-row conflict info directly, so we
    report the count of articles submitted with a valid hash and let the
    row count in the DB itself be the ground truth).
    """
    if not articles:
        logger.info("No articles to insert.")
        return 0

    raw_json_path_str = str(raw_json_path) if raw_json_path else None
    rows = [_article_to_row(a, raw_json_path_str) for a in articles if a.content_hash]

    with db_cursor() as cur:
        execute_values(cur, INSERT_QUERY, rows)

    logger.info("Submitted %d articles for insertion into PostgreSQL.", len(rows))
    return len(rows)
