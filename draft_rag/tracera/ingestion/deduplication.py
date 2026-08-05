"""
ingestion/deduplication.py

Duplicate detection for ingested articles.

Two layers:
1. In-batch dedup: within a single ingestion run, drop articles whose
   content_hash repeats (e.g. the same story pulled from both an RSS
   feed and a GDELT query).
2. Cross-run dedup: persist previously-seen hashes to a small JSON index
   file on disk, so re-running the pipeline tomorrow doesn't re-store
   articles we already have. (Once Phase 5's Postgres schema is live,
   this check will move to a DB query — this file-based index is a
   deliberately simple Phase 1 stand-in.)
"""

import json
from pathlib import Path
from typing import Iterable, List, Set

from ingestion.article_model import Article
from utils.logger import get_logger

logger = get_logger(__name__)


class DuplicateIndex:
    """Tracks content_hash values already seen, persisted as a JSON set."""

    def __init__(self, index_path: Path):
        self.index_path = index_path
        self._seen: Set[str] = self._load()

    def _load(self) -> Set[str]:
        if not self.index_path.exists():
            return set()
        try:
            with open(self.index_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return set(data.get("hashes", []))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Could not load duplicate index (%s); starting fresh.", exc)
            return set()

    def save(self) -> None:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump({"hashes": sorted(self._seen)}, f, indent=2)

    def is_duplicate(self, content_hash: str) -> bool:
        return content_hash in self._seen

    def mark_seen(self, content_hash: str) -> None:
        self._seen.add(content_hash)


def deduplicate_articles(
    articles: Iterable[Article],
    duplicate_index: DuplicateIndex,
) -> List[Article]:
    """
    Filter a list of articles down to only the ones that are new,
    both within this batch and relative to prior runs.
    """
    articles = list(articles)  # materialize once so we can safely report counts below
    unique_articles: List[Article] = []
    batch_hashes: Set[str] = set()

    for article in articles:
        content_hash = article.compute_content_hash()

        if content_hash in batch_hashes:
            logger.debug("Dropping in-batch duplicate: %s", article.title)
            continue

        if duplicate_index.is_duplicate(content_hash):
            logger.debug("Dropping previously-seen duplicate: %s", article.title)
            continue

        batch_hashes.add(content_hash)
        duplicate_index.mark_seen(content_hash)
        unique_articles.append(article)

    logger.info(
        "Deduplication: %d input -> %d unique articles",
        len(articles),
        len(unique_articles),
    )
    return unique_articles
