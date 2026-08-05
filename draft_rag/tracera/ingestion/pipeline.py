"""
ingestion/pipeline.py

Orchestrates the full Phase 1 ingestion run:

    Startup validation (every RSS URL checked before anything runs)
                |
                v
    RSS sources  ---\\
                      >---> combine ---> dedup ---> save JSON ---> save to Postgres
    GDELT queries---/
    Fact-check RSS -/

Run directly with:
    python -m ingestion.pipeline

This is the only module that "knows about" every other ingestion
module — collectors, cleaner, dedup, storage, and the feed validator
stay decoupled from each other and only get wired together here.
"""

import yaml

from config.settings import settings
from database.connection import initialize_schema
from database.models import insert_articles
from ingestion.deduplication import DuplicateIndex, deduplicate_articles
from ingestion.feed_validator import (
    FeedStatus,
    print_validation_report,
    validate_all_sources,
)
from ingestion.gdelt_collector import collect_all_gdelt
from ingestion.rss_collector import collect_all_rss
from ingestion.storage import save_articles_to_json
from utils.logger import get_logger

logger = get_logger(__name__)

DUPLICATE_INDEX_PATH = settings.PROCESSED_DATA_DIR / "seen_hashes.json"


def load_yaml_config(path) -> dict:
    """Load any of the project's YAML config files into a dict."""
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _drop_invalid_sources(sources: list, validation_results: list) -> list:
    """
    Filter a list of {name, url, ...} source dicts down to only the
    ones that passed startup validation. Sources that failed validation
    are skipped for this run rather than aborting the whole pipeline —
    a single stale feed shouldn't block ingestion from every other
    working source.
    """
    invalid_names = {
        r.name for r in validation_results if r.status == FeedStatus.INVALID
    }
    return [s for s in sources if s.get("name") not in invalid_names]


def run_ingestion_pipeline(use_database: bool = True, validate_feeds: bool = True) -> None:
    """
    Run one full ingestion cycle: validate -> collect -> dedup -> persist.

    Args:
        use_database: if False, skip the PostgreSQL step (useful for
            local testing without a database configured yet). JSON
            output still happens regardless.
        validate_feeds: if False, skip the startup RSS validation step
            and attempt to collect from every configured source
            regardless of whether it's currently reachable. Validation
            is on by default because it's what turns a silent "zero
            articles from source X" into an explicit, readable finding.
    """
    logger.info("=== Tracera Phase 1: News Ingestion — run starting ===")

    news_config = load_yaml_config(settings.SOURCES_CONFIG_PATH)
    fact_check_config = load_yaml_config(settings.FACT_CHECK_SOURCES_CONFIG_PATH)

    rss_sources = news_config.get("rss_sources", [])
    gdelt_queries = news_config.get("gdelt_queries", [])
    fact_check_rss_sources = fact_check_config.get("fact_check_sources", [])
    fact_check_gdelt_queries = fact_check_config.get("gdelt_queries", [])

    # --- Startup validation ---
    if validate_feeds:
        validation_results = validate_all_sources()
        print_validation_report(validation_results)
        rss_sources = _drop_invalid_sources(rss_sources, validation_results)
        fact_check_rss_sources = _drop_invalid_sources(fact_check_rss_sources, validation_results)
    else:
        logger.info("validate_feeds=False — skipping startup feed validation.")

    # --- Collect ---
    rss_articles = collect_all_rss(rss_sources)
    gdelt_articles = collect_all_gdelt(gdelt_queries)
    fact_check_articles = collect_all_rss(fact_check_rss_sources)
    fact_check_gdelt_articles = collect_all_gdelt(fact_check_gdelt_queries)

    all_articles = rss_articles + gdelt_articles + fact_check_articles + fact_check_gdelt_articles
    logger.info(
        "Collected %d raw articles before dedup "
        "(%d news RSS, %d news GDELT, %d fact-check RSS, %d fact-check GDELT).",
        len(all_articles), len(rss_articles), len(gdelt_articles),
        len(fact_check_articles), len(fact_check_gdelt_articles),
    )

    if not all_articles:
        logger.warning("No articles collected this run. Exiting.")
        return

    # --- Deduplicate ---
    duplicate_index = DuplicateIndex(DUPLICATE_INDEX_PATH)
    unique_articles = deduplicate_articles(all_articles, duplicate_index)
    duplicate_index.save()

    if not unique_articles:
        logger.info("All collected articles were duplicates of previous runs. Nothing new to store.")
        return

    # --- Persist: JSON ---
    json_path = save_articles_to_json(unique_articles)

    # --- Persist: PostgreSQL ---
    if use_database:
        try:
            initialize_schema()
            insert_articles(unique_articles, raw_json_path=json_path)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Database step failed (%s). Articles are still safely stored in %s.",
                exc, json_path,
            )
    else:
        logger.info("use_database=False — skipping PostgreSQL step.")

    logger.info("=== Ingestion run complete: %d new articles stored ===", len(unique_articles))


if __name__ == "__main__":
    run_ingestion_pipeline()
