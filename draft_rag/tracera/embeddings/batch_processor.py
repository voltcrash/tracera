"""Bounded embedding inference and resilient pgvector batch persistence."""

from __future__ import annotations

from datetime import datetime, timezone
from time import sleep
from typing import Sequence

from embeddings.embedding_model import EmbeddingModel
from embeddings.models import (
    DEFAULT_EMBEDDING_VERSION,
    ArticleEmbedding,
    EmbeddingArticle,
    EmbeddingBatchResult,
)
from embeddings.vector_store import PgVectorStore
from utils.logger import get_logger

logger = get_logger(__name__)


class EmbeddingBatchProcessor:
    """Generate and persist one bounded batch without retaining prior batches."""

    def __init__(
        self,
        model: EmbeddingModel,
        vector_store: PgVectorStore,
        *,
        batch_size: int = 32,
        embedding_version: str = DEFAULT_EMBEDDING_VERSION,
        max_store_attempts: int = 3,
        retry_delay_seconds: float = 0.5,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be at least 1")
        if max_store_attempts < 1:
            raise ValueError("max_store_attempts must be at least 1")
        if retry_delay_seconds < 0:
            raise ValueError("retry_delay_seconds cannot be negative")

        self._model = model
        self._vector_store = vector_store
        self._batch_size = batch_size
        self._embedding_version = embedding_version
        self._max_store_attempts = max_store_attempts
        self._retry_delay_seconds = retry_delay_seconds

    def process(self, articles: Sequence[EmbeddingArticle], *, force: bool = False) -> EmbeddingBatchResult:
        """Embed and store one batch, returning failures without raising per-row errors."""
        if len(articles) > self._batch_size:
            raise ValueError("articles cannot exceed the configured batch_size")
        if not articles:
            return EmbeddingBatchResult(attempted=0, embedded=0, stored=0)

        embeddings, failed_article_ids = self._create_embeddings(articles)
        if not embeddings:
            return EmbeddingBatchResult(
                attempted=len(articles),
                embedded=0,
                stored=0,
                failed_article_ids=failed_article_ids,
            )

        try:
            stored = self._store_with_retry(embeddings, force=force)
        except Exception:  # noqa: BLE001 - return batch failure so the pipeline can continue
            logger.exception("Embedding storage failed for %d article(s).", len(embeddings))
            return EmbeddingBatchResult(
                attempted=len(articles),
                embedded=len(embeddings),
                stored=0,
                failed_article_ids=failed_article_ids + [item.article_id for item in embeddings],
            )

        return EmbeddingBatchResult(
            attempted=len(articles),
            embedded=len(embeddings),
            stored=stored,
            failed_article_ids=failed_article_ids,
        )

    def _create_embeddings(
        self, articles: Sequence[EmbeddingArticle]
    ) -> tuple[list[ArticleEmbedding], list[int]]:
        """Embed a batch, falling back to per-article inference if it fails."""
        try:
            vectors = self._model.encode(
                [article.processed_content for article in articles],
                batch_size=self._batch_size,
            )
            return self._make_embedding_records(articles, vectors), []
        except Exception as exc:  # noqa: BLE001 - isolate the bad input with individual retries
            logger.warning("Batch inference failed (%s); retrying articles individually.", exc)

        embeddings: list[ArticleEmbedding] = []
        failed_article_ids: list[int] = []
        for article in articles:
            try:
                vectors = self._model.encode([article.processed_content], batch_size=1)
                embeddings.extend(self._make_embedding_records([article], vectors))
            except Exception:  # noqa: BLE001 - one corrupt article must not halt later rows
                failed_article_ids.append(article.article_id)
                logger.exception("Embedding inference failed for article id=%d.", article.article_id)
        return embeddings, failed_article_ids

    def _make_embedding_records(
        self,
        articles: Sequence[EmbeddingArticle],
        vectors: Sequence[Sequence[float]],
    ) -> list[ArticleEmbedding]:
        """Associate model vectors with article IDs and Phase 3 provenance."""
        if len(articles) != len(vectors):
            raise ValueError("Model vector count does not match article count")
        embedded_at = datetime.now(timezone.utc)
        return [
            ArticleEmbedding(
                article_id=article.article_id,
                vector=list(vector),
                model_name=self._model.model_name,
                version=self._embedding_version,
                embedded_at=embedded_at,
            )
            for article, vector in zip(articles, vectors)
        ]

    def _store_with_retry(self, embeddings: Sequence[ArticleEmbedding], *, force: bool) -> int:
        """Retry a whole atomic database batch with bounded exponential backoff."""
        for attempt in range(1, self._max_store_attempts + 1):
            try:
                return self._vector_store.store_embeddings(embeddings, force=force)
            except Exception:
                if attempt == self._max_store_attempts:
                    raise
                delay = self._retry_delay_seconds * (2 ** (attempt - 1))
                logger.warning(
                    "Embedding storage attempt %d/%d failed; retrying in %.1fs.",
                    attempt,
                    self._max_store_attempts,
                    delay,
                )
                if delay:
                    sleep(delay)

        raise RuntimeError("Unreachable retry state")
