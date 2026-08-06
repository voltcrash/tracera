"""PostgreSQL/pgvector repository for Phase 3 article embeddings.

The repository owns Phase 3 database queries only.  It reads valid Phase 2
content and writes the embedding-related columns introduced by the Phase 3
migration; it never changes ingestion or preprocessing fields.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from psycopg2.extensions import connection as PGConnection
from psycopg2.extras import execute_values

from database.connection import get_connection
from embeddings.models import ArticleEmbedding, EMBEDDING_DIMENSIONS, EmbeddingArticle
from utils.logger import get_logger

logger = get_logger(__name__)

_SELECT_PENDING_ARTICLES = """
SELECT id, processed_content
FROM articles
WHERE id > %(after_id)s
  AND is_valid IS TRUE
  AND processed_content IS NOT NULL
  AND btrim(processed_content) <> ''
  AND (%(force)s OR embedding IS NULL)
ORDER BY id
LIMIT %(batch_size)s
"""

_STORE_EMBEDDINGS = """
UPDATE articles AS target
SET
    embedding = source.embedding::vector,
    embedding_model = source.model_name,
    embedded_at = source.embedded_at,
    embedding_version = source.version
FROM (VALUES %s) AS source(article_id, embedding, model_name, embedded_at, version, force)
WHERE target.id = source.article_id
  AND (source.force OR target.embedding IS NULL)
"""


def _vector_literal(vector: Sequence[float]) -> str:
    """Return pgvector's text input representation after dimension validation."""
    if len(vector) != EMBEDDING_DIMENSIONS:
        raise ValueError(
            f"Expected {EMBEDDING_DIMENSIONS} embedding dimensions; got {len(vector)}"
        )
    return "[" + ",".join(str(float(value)) for value in vector) + "]"


class PgVectorStore:
    """Repository for incremental reads and idempotent pgvector writes."""

    def __init__(self, connection_factory: Callable[[], PGConnection] = get_connection) -> None:
        self._connection_factory = connection_factory

    def fetch_pending_articles(
        self,
        *,
        after_id: int = 0,
        batch_size: int = 32,
        force: bool = False,
    ) -> list[EmbeddingArticle]:
        """Fetch one keyset-paginated batch eligible for embedding.

        Keyset pagination avoids loading all valid articles into memory and
        remains stable as individual batches update their embedding columns.
        """
        if after_id < 0:
            raise ValueError("after_id cannot be negative")
        if batch_size < 1:
            raise ValueError("batch_size must be at least 1")

        connection = self._connection_factory()
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    _SELECT_PENDING_ARTICLES,
                    {"after_id": after_id, "batch_size": batch_size, "force": force},
                )
                records: list[EmbeddingArticle] = []
                for article_id, content in cursor.fetchall():
                    try:
                        records.append(
                            EmbeddingArticle(article_id=article_id, processed_content=content)
                        )
                    except Exception as exc:  # noqa: BLE001 - skip corrupt records without halting a batch
                        logger.warning("Skipping corrupt article id=%s: %s", article_id, exc)
                return records
        finally:
            connection.close()

    def store_embeddings(self, embeddings: Sequence[ArticleEmbedding], *, force: bool = False) -> int:
        """Store a batch atomically and return the number of updated rows.

        Existing vectors remain untouched unless ``force=True``.  The database
        predicate repeats this protection so a concurrent process cannot
        overwrite an embedding between selection and storage.
        """
        if not embeddings:
            return 0

        rows = [
            (
                embedding.article_id,
                _vector_literal(embedding.vector),
                embedding.model_name,
                embedding.embedded_at,
                embedding.version,
                force,
            )
            for embedding in embeddings
        ]
        connection = self._connection_factory()
        try:
            with connection:
                with connection.cursor() as cursor:
                    execute_values(
                        cursor,
                        _STORE_EMBEDDINGS,
                        rows,
                        template="(%s, %s, %s, %s, %s, %s)",
                    )
                    stored = cursor.rowcount
            logger.info("Stored %d/%d embedding vector(s).", stored, len(embeddings))
            return stored
        finally:
            connection.close()
