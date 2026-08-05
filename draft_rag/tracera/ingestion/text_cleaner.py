"""
ingestion/text_cleaner.py

Lightweight text cleaning applied at ingestion time.

NOTE: This is intentionally minimal for Phase 1. Full cleaning (Unicode
normalization, language detection, aggressive whitespace rules, metadata
validation) is the explicit subject of Phase 2 and will build on top of
this module rather than duplicating it. What's here now exists because
raw RSS/GDELT text is frequently HTML-polluted and unusable even for
simple JSON storage without at least this much cleanup.
"""

import re
import unicodedata

from bs4 import BeautifulSoup

from utils.logger import get_logger

logger = get_logger(__name__)


def strip_html(raw_html: str) -> str:
    """Remove HTML tags and return plain text, preserving paragraph breaks."""
    if not raw_html:
        return ""
    try:
        soup = BeautifulSoup(raw_html, "lxml")
        text = soup.get_text(separator=" ")
        return text
    except Exception as exc:  # noqa: BLE001 - we want to log and degrade gracefully
        logger.warning("HTML stripping failed, returning raw input: %s", exc)
        return raw_html


def normalize_whitespace(text: str) -> str:
    """Collapse repeated whitespace/newlines into single spaces and trim."""
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_unicode(text: str) -> str:
    """Normalize unicode to NFKC form (fixes curly quotes, ligatures, etc.)."""
    if not text:
        return ""
    return unicodedata.normalize("NFKC", text)


def clean_article_text(raw_text: str) -> str:
    """Full Phase-1 cleaning pipeline applied to a single article body."""
    text = strip_html(raw_text)
    text = normalize_unicode(text)
    text = normalize_whitespace(text)
    return text
