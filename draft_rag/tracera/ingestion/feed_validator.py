"""
ingestion/feed_validator.py

Startup validation: before the ingestion pipeline fetches a single
article, this module checks every configured RSS URL (both
config/sources.yaml and config/fact_check_sources.yaml) and reports
whether each one is actually a valid, reachable RSS/Atom feed.

Why this exists: feed URLs go stale silently. A source can work fine
for months and then start returning a redirected HTML page, a 403, or
a dead domain — and without an explicit check, that just shows up as
"zero articles from source X" with no clear explanation. This module
turns that into an explicit, readable report before any collection
work happens, so a broken source is a visible startup finding, not a
silent gap in the data.

Run standalone:
    python -m ingestion.feed_validator

Or import validate_all_sources() / print_validation_report() from
ingestion/pipeline.py to run this automatically before every ingestion
run (see pipeline.py's use of this module).
"""

from dataclasses import dataclass
from enum import Enum
from typing import List

import feedparser
import requests
import yaml

from config.settings import settings
from utils.http_client import get_session
from utils.logger import get_logger

logger = get_logger(__name__)


class FeedStatus(str, Enum):
    VALID = "VALID"
    INVALID = "INVALID"


@dataclass
class FeedValidationResult:
    name: str
    url: str
    status: FeedStatus
    reason: str
    entry_count: int = 0


def validate_feed_url(name: str, url: str) -> FeedValidationResult:
    """
    Validate a single RSS URL: fetch it, confirm the response is
    actually parseable as RSS/Atom, and confirm it contains at least
    one entry. Never raises — every failure mode becomes an INVALID
    result with a human-readable reason instead of an exception, since
    this runs across a whole list of sources and one bad URL shouldn't
    stop the report.
    """
    session = get_session()

    try:
        response = session.get(url, timeout=settings.HTTP_TIMEOUT_SECONDS)
    except requests.exceptions.SSLError as exc:
        return FeedValidationResult(
            name, url, FeedStatus.INVALID,
            f"SSL error ({exc}). On Windows, install 'truststore' "
            f"(pip install truststore) — see utils/http_client.py.",
        )
    except requests.exceptions.Timeout:
        return FeedValidationResult(
            name, url, FeedStatus.INVALID,
            f"Timed out after {settings.HTTP_TIMEOUT_SECONDS}s",
        )
    except requests.exceptions.ConnectionError as exc:
        return FeedValidationResult(
            name, url, FeedStatus.INVALID, f"Connection failed ({exc})",
        )
    except requests.RequestException as exc:
        return FeedValidationResult(
            name, url, FeedStatus.INVALID, f"Request failed ({exc})",
        )

    if response.status_code != 200:
        return FeedValidationResult(
            name, url, FeedStatus.INVALID,
            f"HTTP {response.status_code}",
        )

    content_type = response.headers.get("Content-Type", "").lower()
    parsed = feedparser.parse(response.content)
    recognized_version = bool(parsed.get("version"))
    content_type_ok = any(hint in content_type for hint in ("xml", "rss", "atom"))

    if not recognized_version and not content_type_ok:
        return FeedValidationResult(
            name, url, FeedStatus.INVALID,
            f"Response is not a recognizable RSS/Atom feed "
            f"(Content-Type={content_type or 'unknown'!r})",
        )

    if not parsed.entries:
        return FeedValidationResult(
            name, url, FeedStatus.INVALID,
            "Feed parsed successfully but contained zero entries",
        )

    return FeedValidationResult(
        name, url, FeedStatus.VALID,
        f"OK ({parsed.get('version', 'unknown format')})",
        entry_count=len(parsed.entries),
    )


def _load_rss_source_list(path) -> List[dict]:
    with open(path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    # Both sources.yaml (rss_sources) and fact_check_sources.yaml
    # (fact_check_sources) are supported by checking for either key.
    return config.get("rss_sources") or config.get("fact_check_sources") or []


def validate_all_sources() -> List[FeedValidationResult]:
    """
    Validate every RSS source across both config files. Returns one
    FeedValidationResult per source, in the order they're configured.
    """
    results: List[FeedValidationResult] = []

    for config_path in (settings.SOURCES_CONFIG_PATH, settings.FACT_CHECK_SOURCES_CONFIG_PATH):
        sources = _load_rss_source_list(config_path)
        for source in sources:
            logger.info("Validating feed: %s", source.get("name"))
            result = validate_feed_url(source["name"], source["url"])
            results.append(result)

    return results


def print_validation_report(results: List[FeedValidationResult]) -> None:
    """Print a human-readable pass/fail table to the log."""
    valid = [r for r in results if r.status == FeedStatus.VALID]
    invalid = [r for r in results if r.status == FeedStatus.INVALID]

    logger.info("=== Feed validation report: %d/%d sources valid ===", len(valid), len(results))
    for result in results:
        marker = "OK   " if result.status == FeedStatus.VALID else "FAIL "
        logger.info("  [%s] %-35s %s", marker, result.name, result.reason)

    if invalid:
        logger.warning(
            "%d source(s) failed validation and will be skipped this run: %s",
            len(invalid), ", ".join(r.name for r in invalid),
        )


if __name__ == "__main__":
    all_results = validate_all_sources()
    print_validation_report(all_results)
