"""
ingestion/rss_collector.py

Collects articles from RSS/Atom feeds listed in config/sources.yaml (or
config/fact_check_sources.yaml).

Design note: this module knows nothing about GDELT, PostgreSQL, or
storage — its only job is "given a feed URL, return a list of Article
objects." That separation is what makes it easy to add a new source
type later (e.g. a NewsAPI collector) without touching this file.

Only genuine RSS/Atom feed URLs belong in the source configs. This
module actively rejects URLs that resolve to something else (an HTML
page, a JSON API, a dead redirect) rather than silently treating
whatever came back as if it were a feed — see `_looks_like_feed()`.
"""

from datetime import datetime, timezone
from typing import List, Optional

import feedparser
import requests
from dateutil import parser as dateutil_parser

from config.settings import settings
from ingestion.article_model import Article, SourceType
from ingestion.text_cleaner import clean_article_text
from utils.http_client import get_session
from utils.logger import get_logger

logger = get_logger(__name__)

# Content-Type substrings that indicate the response is actually
# RSS/Atom/XML, as opposed to an HTML page, a JSON error body, etc.
_FEED_CONTENT_TYPE_HINTS = ("xml", "rss", "atom")


def _parse_published_date(entry: dict) -> Optional[datetime]:
    """
    Feeds are inconsistent about date fields (published, updated, pubDate,
    dc:date...). Try the common ones and fall back to None rather than
    guessing — Phase 6's date filtering should be able to trust this field
    when it's present.
    """
    for field in ("published", "updated", "created"):
        raw_date = entry.get(field)
        if raw_date:
            try:
                dt = dateutil_parser.parse(raw_date)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except (ValueError, TypeError):
                continue
    return None


def _extract_entry_text(entry: dict) -> str:
    """Pull the best available body text out of a feedparser entry."""
    if "content" in entry and entry["content"]:
        return entry["content"][0].get("value", "")
    if "summary" in entry:
        return entry.get("summary", "")
    if "description" in entry:
        return entry.get("description", "")
    return ""


def _looks_like_feed(response: requests.Response, parsed: feedparser.FeedParserDict) -> bool:
    """
    Decide whether an HTTP response is actually an RSS/Atom feed, not
    just "some URL that returned 200 OK." We reject:

    - Responses whose Content-Type is clearly not XML/RSS/Atom (e.g. a
      WordPress "best-of" landing page served as text/html, which is
      exactly what broke the old Reuters entry in sources.yaml).
    - Responses feedparser couldn't identify a feed version for
      (`parsed.version == ""`), which reliably indicates "this wasn't a
      feed" even when feedparser's lenient parser doesn't set `bozo`.
    """
    content_type = response.headers.get("Content-Type", "").lower()
    content_type_ok = any(hint in content_type for hint in _FEED_CONTENT_TYPE_HINTS)

    # feedparser sets `version` to a non-empty string (e.g. "rss20",
    # "atom10") only when it recognized an actual feed format.
    recognized_version = bool(parsed.get("version"))

    if not content_type_ok and not recognized_version:
        return False
    return True


def fetch_feed(feed_url: str) -> Optional[feedparser.FeedParserDict]:
    """
    Fetch and parse a single feed. We fetch via requests first (so we
    control timeout, SSL verification, and a proper User-Agent header —
    many news sites reject the default feedparser UA) and hand the raw
    bytes to feedparser for parsing.

    Returns None for anything that isn't a genuine, parseable RSS/Atom
    feed — including URLs that return 200 OK but serve an HTML page
    instead of a feed.
    """
    session = get_session()
    try:
        response = session.get(feed_url, timeout=settings.HTTP_TIMEOUT_SECONDS)
        response.raise_for_status()
    except requests.exceptions.SSLError as exc:
        logger.error(
            "SSL error fetching %s: %s. If you're on Windows, make sure "
            "'truststore' is installed (pip install truststore) — see "
            "utils/http_client.py for details.",
            feed_url, exc,
        )
        return None
    except requests.RequestException as exc:
        logger.error("Failed to fetch RSS feed %s: %s", feed_url, exc)
        return None

    parsed = feedparser.parse(response.content)

    if not _looks_like_feed(response, parsed):
        logger.error(
            "Rejecting %s: response does not look like an RSS/Atom feed "
            "(Content-Type=%r, feedparser recognized version=%r). This "
            "URL should be removed or replaced in the source config.",
            feed_url, response.headers.get("Content-Type"), parsed.get("version"),
        )
        return None

    if parsed.bozo and not parsed.entries:
        logger.warning(
            "Feed %s parsed with errors and returned no entries: %s",
            feed_url,
            parsed.get("bozo_exception"),
        )
        return None
    return parsed


def collect_from_source(source: dict) -> List[Article]:
    """
    Collect articles from a single RSS source config entry, e.g.:
        {"name": ..., "url": ..., "publisher": ..., "category": ...}
    """
    feed_url = source["url"]
    publisher = source.get("publisher", source.get("name", "Unknown"))
    category = source.get("category")

    logger.info("Fetching RSS source: %s (%s)", source.get("name"), feed_url)
    parsed_feed = fetch_feed(feed_url)
    if parsed_feed is None:
        return []

    articles: List[Article] = []
    entries = parsed_feed.entries[: settings.RSS_MAX_ARTICLES_PER_SOURCE]

    for entry in entries:
        url = entry.get("link")
        title = entry.get("title")
        if not url or not title:
            logger.debug("Skipping entry with missing url/title from %s", feed_url)
            continue

        raw_text = _extract_entry_text(entry)
        cleaned_text = clean_article_text(raw_text)

        try:
            article = Article(
                url=url,
                title=title.strip(),
                publisher=publisher,
                source_type=SourceType.RSS,
                category=category,
                published_at=_parse_published_date(entry),
                raw_text=raw_text,
                cleaned_text=cleaned_text,
            )
            articles.append(article)
        except Exception as exc:  # noqa: BLE001 - invalid entries shouldn't kill the run
            logger.warning("Skipping malformed entry from %s: %s", feed_url, exc)
            continue

    logger.info("Collected %d articles from %s", len(articles), source.get("name"))
    return articles


def collect_all_rss(sources: List[dict]) -> List[Article]:
    """
    Collect articles from every configured RSS source, source-by-source.

    Used for both config/sources.yaml (general news) and
    config/fact_check_sources.yaml (fact-checking organizations) — both
    are lists of the same {name, url, publisher, category} shape, so
    the same collection logic applies to either.
    """
    all_articles: List[Article] = []
    for source in sources:
        all_articles.extend(collect_from_source(source))
    return all_articles
