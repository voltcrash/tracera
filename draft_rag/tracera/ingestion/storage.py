"""
ingestion/storage.py

Handles writing Article objects to disk as JSON. This is the Phase 1
persistence layer for article *content*; structured *metadata* also
gets written to PostgreSQL (see database/models.py) so it can be
queried, filtered, and joined against later phases (embeddings, chunks).

Why both JSON and Postgres?
- JSON on disk: cheap, human-inspectable, easy to re-process during
  development (e.g. re-run chunking without re-fetching from the web).
- Postgres: queryable, relational, and where pgvector will live in
  Phase 5. Storing metadata there now means Phase 5 is additive, not
  a rewrite.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import List

from config.settings import settings
from ingestion.article_model import Article
from utils.logger import get_logger

logger = get_logger(__name__)


def _run_batch_filename() -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"articles_{timestamp}.json"


def save_articles_to_json(articles: List[Article], output_dir: Path = None) -> Path:
    """
    Write a batch of articles to a single timestamped JSON file under
    data/raw/. Returns the path written to.
    """
    output_dir = output_dir or settings.RAW_DATA_DIR
    output_dir.mkdir(parents=True, exist_ok=True)

    file_path = output_dir / _run_batch_filename()
    payload = [json.loads(article.model_dump_json()) for article in articles]

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    logger.info("Saved %d articles to %s", len(articles), file_path)
    return file_path


def load_articles_from_json(file_path: Path) -> List[dict]:
    """Load a previously-saved JSON batch back into a list of dicts."""
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)
