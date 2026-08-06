"""Command entry point for incremental local embedding generation.

Run ``python -m embeddings.pipeline`` after applying the Phase 3 migration.
Only valid Phase 2 articles are read, and existing vectors are preserved unless
``--force`` is explicitly supplied.
"""

from __future__ import annotations

import argparse
from typing import Optional

from embeddings.batch_processor import EmbeddingBatchProcessor
from embeddings.embedding_model import EmbeddingModel, get_embedding_model
from embeddings.models import EmbeddingPipelineSummary
from embeddings.utils import EmbeddingConfig, load_embedding_config
from embeddings.vector_store import PgVectorStore
from utils.logger import get_logger

logger = get_logger(__name__)


def run_embedding_pipeline(
    *,
    force: Optional[bool] = None,
    config: Optional[EmbeddingConfig] = None,
    model: Optional[EmbeddingModel] = None,
    vector_store: Optional[PgVectorStore] = None,
) -> EmbeddingPipelineSummary:
    """Embed eligible articles incrementally and return an aggregate summary.

    ``force=None`` uses configured behavior; passing ``True`` is the explicit
    opt-in to regenerate existing vectors.  Repository reads use an ID cursor,
    so the pipeline has bounded memory usage regardless of corpus size.
    """
    runtime_config = config or load_embedding_config()
    effective_force = runtime_config.force_regenerate if force is None else force
    store = vector_store or PgVectorStore()

    try:
        embedding_model = model or get_embedding_model(
            model_name=runtime_config.model_name,
            device=runtime_config.device,
        )
    except Exception:
        logger.exception("Unable to load the local embedding model; pipeline cannot start.")
        raise

    processor = EmbeddingBatchProcessor(
        embedding_model,
        store,
        batch_size=runtime_config.batch_size,
        embedding_version=runtime_config.embedding_version,
    )

    logger.info(
        "Starting embedding pipeline: model=%s device=%s batch_size=%d force=%s metric=%s.",
        runtime_config.model_name,
        runtime_config.device or "auto",
        runtime_config.batch_size,
        effective_force,
        runtime_config.similarity_metric,
    )

    batches_processed = 0
    articles_attempted = 0
    articles_embedded = 0
    articles_stored = 0
    failed_article_ids: list[int] = []
    after_id = 0

    while True:
        articles = store.fetch_pending_articles(
            after_id=after_id,
            batch_size=runtime_config.batch_size,
            force=effective_force,
        )
        if not articles:
            break

        batches_processed += 1
        logger.info("Processing embedding batch %d (%d article(s)).", batches_processed, len(articles))
        result = processor.process(articles, force=effective_force)

        articles_attempted += result.attempted
        articles_embedded += result.embedded
        articles_stored += result.stored
        failed_article_ids.extend(result.failed_article_ids)
        after_id = articles[-1].article_id

        logger.info(
            "Completed embedding batch %d: embedded=%d stored=%d failed=%d.",
            batches_processed,
            result.embedded,
            result.stored,
            len(result.failed_article_ids),
        )

    summary = EmbeddingPipelineSummary(
        batches_processed=batches_processed,
        articles_attempted=articles_attempted,
        articles_embedded=articles_embedded,
        articles_stored=articles_stored,
        failed_article_ids=tuple(failed_article_ids),
    )
    logger.info(
        "Embedding pipeline complete: batches=%d attempted=%d embedded=%d stored=%d failed=%d.",
        summary.batches_processed,
        summary.articles_attempted,
        summary.articles_embedded,
        summary.articles_stored,
        len(summary.failed_article_ids),
    )
    return summary


def _parse_arguments() -> argparse.Namespace:
    """Parse the small CLI surface without coupling runtime logic to argparse."""
    parser = argparse.ArgumentParser(description="Generate local embeddings for valid Tracera articles.")
    parser.add_argument(
        "--force",
        action="store_true",
        default=None,
        help="Regenerate vectors even when an article already has an embedding.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    arguments = _parse_arguments()
    run_embedding_pipeline(force=arguments.force)
