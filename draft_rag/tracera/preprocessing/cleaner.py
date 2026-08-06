"""
preprocessing/cleaner.py

Phase 2 text cleaning: takes raw article HTML/text (as stored in the
Phase 1 `articles.cleaned_text` column, which only had light HTML
stripping applied) and produces fully cleaned plain text ready for
normalization and language detection.

Reuses ingestion.text_cleaner.normalize_unicode (a Phase 1 building
block) read-only, rather than reimplementing unicode normalization --
this project's coding standards call for no duplicated logic. Nothing
in Phase 1 is modified.

New in Phase 2, on top of what Phase 1's lighter cleaner does:
- Explicit <script>/<style>/comment removal before text extraction
- HTML entity decoding (&amp; -> &, &#39; -> ', etc.)
- Tracking-parameter stripping from URLs embedded in the article body
- Paragraph-structure preservation (blank line between paragraphs,
  instead of one flattened blob of text)
- Duplicate blank line collapsing
"""

import html
import re
from typing import List, Match
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup, Comment

from ingestion.text_cleaner import normalize_unicode
from utils.logger import get_logger

logger = get_logger(__name__)

# Query-string parameter names that indicate tracking, not
# content-identifying data. Prefix-matched (utm_source, utm_medium...)
# or exact-matched (gclid, fbclid...).
_TRACKING_PARAM_PREFIXES = ("utm_",)
_TRACKING_PARAM_EXACT = {
    "gclid", "fbclid", "mc_cid", "mc_eid", "igshid", "ref", "ref_src",
    "ref_url", "spm", "yclid", "msclkid", "_ga", "_gl", "mkt_tok",
    "vero_id", "vero_conv",
}

# Deliberately excludes container tags like <div>/<section>: including
# them caused duplicated output, since find_all() matches both a
# container AND the <p> tags nested inside it, and get_text() on the
# container re-extracts the same text its children already produced.
# Content wrapped in a bare <div> with no inner <p>/<li>/etc. is still
# handled correctly -- it just falls through to the whole-blob fallback
# in _extract_paragraphs() below, which is exactly the right behavior
# for unstructured markup.
_BLOCK_TAGS = ("p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote")
_URL_PATTERN = re.compile(r"https?://[^\s<>\"']+")


def strip_tracking_params(url: str) -> str:
    """
    Remove known tracking query parameters from a URL while preserving
    everything else (path, legitimate query params, fragment).

        https://site.com/a?utm_source=fb&id=42  ->  https://site.com/a?id=42

    Never raises -- malformed URLs are returned unchanged.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return url

    kept_params = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if not (
            key.lower() in _TRACKING_PARAM_EXACT
            or key.lower().startswith(_TRACKING_PARAM_PREFIXES)
        )
    ]
    new_query = urlencode(kept_params)
    cleaned = urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))
    return cleaned.rstrip("?")  # left behind if every param was a tracking param


def _strip_tracking_params_in_text(text: str) -> str:
    """Find every URL embedded in plain text and strip tracking params from each."""

    def _replace(match: Match) -> str:
        return strip_tracking_params(match.group(0))

    return _URL_PATTERN.sub(_replace, text)


def _remove_non_content_tags(soup: BeautifulSoup) -> None:
    """Strip script, style, noscript, and HTML comment nodes before text extraction."""
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    for comment in soup.find_all(string=lambda s: isinstance(s, Comment)):
        comment.extract()


def _extract_paragraphs(soup: BeautifulSoup) -> List[str]:
    """
    Walk block-level elements and return one string per paragraph, so
    paragraph structure survives HTML-to-text conversion instead of
    being flattened into a single blob.
    """
    block_elements = soup.find_all(_BLOCK_TAGS)

    if not block_elements:
        # No block-level structure to work with (plain text input, or a
        # feed summary with no markup) -- fall back to whole-blob
        # extraction; blank-line collapsing later cleans up any noise.
        text = soup.get_text(separator=" ")
        return [text] if text.strip() else []

    paragraphs: List[str] = []
    for element in block_elements:
        text = element.get_text(separator=" ", strip=True)
        if text:
            paragraphs.append(text)
    return paragraphs


def _collapse_blank_lines(text: str) -> str:
    """Collapse 3+ consecutive newlines down to exactly one blank line."""
    return re.sub(r"\n{3,}", "\n\n", text)


def _collapse_inline_whitespace(text: str) -> str:
    """Collapse runs of spaces/tabs (not newlines) into a single space."""
    return re.sub(r"[ \t]+", " ", text)


def clean_article_content(raw_html: str) -> str:
    """
    Full Phase 2 cleaning pipeline for a single article body.

    Accepts raw HTML (a feed's <content>/<summary> field) or
    already-lightly-cleaned text (Phase 1's `cleaned_text` column) --
    both are handled safely since BeautifulSoup degrades gracefully on
    plain text with no tags.

    Steps: decode HTML entities -> strip script/style/comments ->
    extract text paragraph-by-paragraph -> strip URL tracking params ->
    normalize Unicode -> collapse excess whitespace/blank lines.

    Never raises -- on any parsing failure, logs a warning and falls
    back to the least-destructive transformation still available.
    """
    if not raw_html or not raw_html.strip():
        return ""

    decoded = html.unescape(raw_html)

    try:
        soup = BeautifulSoup(decoded, "lxml")
        _remove_non_content_tags(soup)
        paragraphs = _extract_paragraphs(soup)
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, never crash the pipeline
        logger.warning(
            "HTML parsing failed during cleaning (%s); falling back to plain-text cleanup.",
            exc,
        )
        paragraphs = [decoded]

    joined = "\n\n".join(p for p in paragraphs if p.strip())
    joined = _strip_tracking_params_in_text(joined)
    joined = normalize_unicode(joined)
    joined = _collapse_inline_whitespace(joined)
    joined = _collapse_blank_lines(joined)

    return joined.strip()
