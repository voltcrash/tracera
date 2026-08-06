"""
preprocessing/text_normalizer.py

Phase 2 text normalization: takes the already-cleaned text produced by
preprocessing/cleaner.py and produces a further-normalized version
suitable for embedding generation (Phase 4) — consistent quote/dash
characters, no repeated punctuation or symbol spam, tidy whitespace.

This module never sees the original raw article and never overwrites
anything — it's a pure function (text in, text out). The caller
(preprocessing/pipeline.py) is responsible for storing this result
alongside the un-normalized `processed_content` and the original raw
text, so nothing is ever lost — see preprocessing/models.py's
ProcessedArticle, which keeps processed_content and normalized_content
as two separate fields.
"""

import re
import unicodedata
from typing import Dict

from utils.logger import get_logger

logger = get_logger(__name__)

# --- Quote normalization -----------------------------------------------
# Maps every "smart"/typographic quote and guillemet variant to a plain
# ASCII quote, so downstream tokenizers/embedders see one consistent
# character instead of a dozen visually-similar Unicode look-alikes.
_QUOTE_MAP: Dict[str, str] = {
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",  # single curly quotes, low-9, high-reversed-9
    "\u2039": "'", "\u203A": "'",  # single guillemets
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',  # double curly quotes
    "\u00AB": '"', "\u00BB": '"',  # double guillemets « »
}

# --- Dash normalization -------------------------------------------------
# Maps every dash/hyphen-like Unicode character to a plain ASCII hyphen.
_DASH_MAP: Dict[str, str] = {
    "\u2010": "-", "\u2011": "-", "\u2012": "-",  # hyphen, non-breaking hyphen, figure dash
    "\u2013": "-", "\u2014": "-", "\u2015": "-",  # en dash, em dash, horizontal bar
    "\u2212": "-",  # minus sign
    "\uFE58": "-", "\uFE63": "-", "\uFF0D": "-",  # small em dash, small hyphen-minus, fullwidth hyphen-minus
}

_QUOTE_TRANSLATION = str.maketrans(_QUOTE_MAP)
_DASH_TRANSLATION = str.maketrans(_DASH_MAP)

# 2+ consecutive periods collapse to exactly one conventional ellipsis
# ("..."), handled separately from other punctuation so a genuine
# trailing thought ("Well...") isn't flattened down to a single period.
_REPEATED_PERIODS_PATTERN = re.compile(r"\.{2,}")

# Any other non-word, non-whitespace, non-period character repeated 2+
# times collapses to a single occurrence. This single pattern covers
# punctuation spam ("!!!", "??", "----") AND repeated emoji/symbols
# ("😀😀😀", "★★★★"), since Unicode symbol and emoji characters both fall
# outside \w (word characters) just like punctuation does.
_REPEATED_SYMBOL_PATTERN = re.compile(r"([^\w\s.])\1+")

_INLINE_WHITESPACE_PATTERN = re.compile(r"[ \t]+")
_EXCESS_BLANK_LINES_PATTERN = re.compile(r"\n{3,}")


def normalize_quotes(text: str) -> str:
    """Convert curly/typographic quotes and guillemets to plain ASCII quotes."""
    return text.translate(_QUOTE_TRANSLATION)


def normalize_dashes(text: str) -> str:
    """Convert en dashes, em dashes, minus signs, etc. to a plain ASCII hyphen."""
    return text.translate(_DASH_TRANSLATION)


def collapse_repeated_punctuation_and_symbols(text: str) -> str:
    """
    Collapse repeated punctuation ("!!!" -> "!", "----" -> "-") and
    repeated emoji/symbols ("😀😀😀" -> "😀") down to a single occurrence.
    Runs of 2+ periods are treated as an ellipsis and collapsed to
    exactly "..." rather than a single period, since that's the only
    case where the repetition itself is semantically meaningful.
    """
    text = _REPEATED_PERIODS_PATTERN.sub("...", text)
    text = _REPEATED_SYMBOL_PATTERN.sub(r"\1", text)
    return text


def normalize_whitespace(text: str) -> str:
    """
    Collapse runs of spaces/tabs to a single space and cap consecutive
    blank lines at one, while preserving paragraph breaks (a single
    blank line between paragraphs is kept, not removed).
    """
    text = _INLINE_WHITESPACE_PATTERN.sub(" ", text)
    text = _EXCESS_BLANK_LINES_PATTERN.sub("\n\n", text)
    # Trim trailing spaces left on each line by the collapses above.
    text = "\n".join(line.strip() for line in text.split("\n"))
    return text.strip()


def normalize_article_text(text: str) -> str:
    """
    Full Phase 2 normalization pipeline. Input should already be the
    output of preprocessing.cleaner.clean_article_content() — this
    function assumes HTML has already been stripped and focuses purely
    on character-level and punctuation-level normalization.

    Steps: Unicode NFKC normalization -> quote normalization -> dash
    normalization -> collapse repeated punctuation/symbols -> collapse
    excess whitespace.

    Never raises: on any unexpected error, logs a warning and returns
    the input unchanged rather than losing the article's content.
    """
    if not text or not text.strip():
        return ""

    try:
        normalized = unicodedata.normalize("NFKC", text)
        normalized = normalize_quotes(normalized)
        normalized = normalize_dashes(normalized)
        normalized = collapse_repeated_punctuation_and_symbols(normalized)
        normalized = normalize_whitespace(normalized)
        return normalized
    except Exception as exc:  # noqa: BLE001 - never let normalization crash the pipeline
        logger.warning("Text normalization failed (%s); returning input unchanged.", exc)
        return text
