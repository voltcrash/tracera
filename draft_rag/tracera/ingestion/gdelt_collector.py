"""
ingestion/gdelt_collector.py

Collects articles from the GDELT DOC 2.0 API (https://api.gdeltproject.org).
GDELT is free, keyless, and indexes global news coverage — it's used here
as a complementary source to hand-picked RSS feeds, giving broader topical
coverage driven by query keywords rather than fixed outlets.

GDELT's DOC API returns article metadata (title, url, source domain,
seen date, language) but NOT full article body text — only a short
snippet in some modes. For Phase 1 we store what GDELT gives us; full-text
extraction from the article URL itself is a reasonable Phase 2 enhancement
if needed, but is out of scope here to avoid scraping sites we haven't
vetted.
"""

from datetime import datetime, timezone
from typing import List, Optional

import requests
from dateutil import parser as dateutil_parser

from config.settings import settings
from ingestion.article_model import Article, SourceType
from ingestion.text_cleaner import clean_article_text
from utils.http_client import get_session
from utils.logger import get_logger

logger = get_logger(__name__)


def _parse_gdelt_date(seendate: Optional[str]) -> Optional[datetime]:
    """GDELT returns seendate as e.g. '20260804T120000Z'."""
    if not seendate:
        return None
    try:
        dt = dateutil_parser.parse(seendate)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def fetch_gdelt_results(query: str, max_records: int) -> List[dict]:
    """
    Call the GDELT DOC 2.0 API for a single query and return the raw
    'articles' list from the JSON response.
    """
    params = {
        "query": query,
        "mode": "artlist",
        "maxrecords": max_records,
        "format": "json",
        "sort": "datedesc",
    }
    session = get_session()

    try:
        response = session.get(
            settings.GDELT_API_BASE,
            params=params,
            timeout=settings.HTTP_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except requests.exceptions.SSLError as exc:
        logger.error(
            "SSL error querying GDELT: %s. If you're on Windows, make "
            "sure 'truststore' is installed (pip install truststore).",
            exc,
        )
        return []
    except requests.RequestException as exc:
        logger.error("GDELT request failed for query '%s': %s", query, exc)
        return []

    try:
        data = response.json()
    except ValueError:
        # GDELT occasionally returns an HTML error page with a 200 status
        # (e.g. during rate limiting); guard against that here.
        logger.warning("GDELT returned non-JSON response for query '%s'", query)
        return []

    return data.get("articles", [])


def collect_from_query(query_config: dict) -> List[Article]:
    """
    Collect articles for a single GDELT query config entry, e.g.:
        {"name": ..., "query": ..., "category": ...}
    """
    query = query_config["query"]
    category = query_config.get("category")

    logger.info("Querying GDELT: %s ('%s')", query_config.get("name"), query)
    raw_articles = fetch_gdelt_results(
        query=query, max_records=settings.GDELT_MAX_ARTICLES_PER_QUERY
    )

    articles: List[Article] = []
    for item in raw_articles:
        url = item.get("url")
        title = item.get("title")
        if not url or not title:
            continue

        # GDELT's artlist mode gives us a title + domain, not full body
        # text. We store the title as raw_text/cleaned_text placeholder
        # here; full-text fetching is deliberately deferred (see module
        # docstring).
        raw_text = title
        cleaned_text = clean_article_text(raw_text)

        try:
            article = Article(
                url=url,
                title=title.strip(),
                publisher=item.get("domain", "Unknown (GDELT)"),
                source_type=SourceType.GDELT,
                category=category,
                published_at=_parse_gdelt_date(item.get("seendate")),
                raw_text=raw_text,
                cleaned_text=cleaned_text,
                language=item.get("language"),
            )
            articles.append(article)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Skipping malformed GDELT entry: %s", exc)
            continue

    logger.info("Collected %d articles from GDELT query '%s'", len(articles), query)
    return articles


def collect_all_gdelt(query_configs: List[dict]) -> List[Article]:
    """Collect articles for every configured GDELT query."""
    all_articles: List[Article] = []
    for query_config in query_configs:
        all_articles.extend(collect_from_query(query_config))
    return all_articles
