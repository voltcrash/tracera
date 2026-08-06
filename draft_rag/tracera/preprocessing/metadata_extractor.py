"""
preprocessing/metadata_extractor.py

Phase 2 metadata extraction: derives structural statistics (word/
sentence/paragraph/character counts, reading time), a short summary,
and keywords from an article's normalized text.

Keyword extraction uses YAKE (https://github.com/LIAAD/yake) when it's
installed — a lightweight, unsupervised, statistics-based keyword
extractor that needs no training data or heavy ML dependencies. If
YAKE isn't installed, this module transparently falls back to a small
frequency-based extractor with an English stopword list, so the
pipeline never breaks over a missing optional dependency.
"""

import re
from collections import Counter
from typing import List, Optional

from preprocessing.models import ExtractedMetadata
from utils.logger import get_logger

logger = get_logger(__name__)

try:
    import yake

    _YAKE_AVAILABLE = True
except ImportError:
    yake = None
    _YAKE_AVAILABLE = False

_WORDS_PER_MINUTE = 200  # standard average adult silent-reading speed, used for reading_time estimation
_DEFAULT_MAX_KEYWORDS = 10
_SUMMARY_MAX_LENGTH = 300  # characters

_WORD_PATTERN = re.compile(r"\b\w+\b", re.UNICODE)
_SENTENCE_BOUNDARY_PATTERN = re.compile(r"[.!?]+")
_FALLBACK_TOKEN_PATTERN = re.compile(r"\b[a-zA-Z]{3,}\b")

# Small, hand-picked English stopword list for the fallback keyword
# extractor. Deliberately not pulled from nltk/spacy corpora, to avoid
# adding a heavyweight dependency (or a runtime corpus download) just
# for this fallback path — YAKE is the primary path when available.
_ENGLISH_STOPWORDS = frozenset(
    """
    a about above after again against all am an and any are aren't as at be
    because been before being below between both but by can't cannot could
    couldn't did didn't do does doesn't doing don't down during each few for
    from further had hadn't has hasn't have haven't having he he'd he'll
    he's her here here's hers herself him himself his how how's i i'd i'll
    i'm i've if in into is isn't it it's its itself let's me more most
    mustn't my myself no nor not of off on once only or other ought our
    ours ourselves out over own said same shan't she she'd she'll she's
    should shouldn't so some such than that that's the their theirs them
    themselves then there there's these they they'd they'll they're they've
    this those through to too under until up very was wasn't we we'd we'll
    we're we've were weren't what what's when when's where where's which
    while who who's whom why why's with won't would wouldn't you you'd
    you'll you're you've your yours yourself yourselves says according also
    says told told
    """.split()
)


def count_words(text: str) -> int:
    """Count words using a Unicode-aware word-boundary regex (handles non-English scripts too)."""
    if not text:
        return 0
    return len(_WORD_PATTERN.findall(text))


def count_sentences(text: str) -> int:
    """
    Estimate sentence count by splitting on runs of ., !, or ? (a run,
    not a single character, so a normalized "..." ellipsis counts as
    one boundary rather than three).

    This is a heuristic, not a full sentence tokenizer: it doesn't
    special-case abbreviations ("Dr.", "U.S.") or decimal numbers
    ("3.14"). That tradeoff is deliberate — a real sentence tokenizer
    (spaCy, nltk punkt) is a meaningfully heavier dependency for a
    number that's only used for rough reading-time/complexity stats,
    not for anything downstream that needs sentence-exact boundaries.
    """
    if not text or not text.strip():
        return 0
    fragments = [f for f in _SENTENCE_BOUNDARY_PATTERN.split(text) if f.strip()]
    return len(fragments) if fragments else 1


def count_paragraphs(text: str) -> int:
    """
    Count paragraphs by splitting on blank lines. Assumes input has
    already passed through preprocessing.cleaner / text_normalizer,
    both of which preserve exactly one blank line ("\\n\\n") between
    paragraphs.
    """
    if not text or not text.strip():
        return 0
    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    return len(paragraphs) if paragraphs else 1


def estimate_reading_time_minutes(word_count: int, words_per_minute: int = _WORDS_PER_MINUTE) -> float:
    """Estimate reading time in minutes from word count, rounded to 1 decimal place."""
    if word_count <= 0:
        return 0.0
    return round(word_count / words_per_minute, 1)


def extract_first_paragraph_summary(text: str, max_length: int = _SUMMARY_MAX_LENGTH) -> str:
    """
    Return the article's first paragraph as a summary, truncated at a
    word boundary (never mid-word) if it exceeds max_length characters.
    """
    if not text or not text.strip():
        return ""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return ""

    first_paragraph = paragraphs[0]
    if len(first_paragraph) <= max_length:
        return first_paragraph

    truncated = first_paragraph[:max_length].rsplit(" ", 1)[0]
    return truncated.rstrip(",;: ") + "…"


def _extract_keywords_with_yake(text: str, language: Optional[str], max_keywords: int) -> List[str]:
    """
    Extract keywords using YAKE. YAKE needs a language hint (defaults
    to "en" if detection didn't produce one or isn't supported by YAKE)
    and scores keywords where LOWER = more relevant, so results are
    sorted ascending by score before truncating to max_keywords.
    """
    lang_code = language or "en"
    extractor = yake.KeywordExtractor(lan=lang_code, n=2, top=max_keywords, dedupLim=0.9)
    scored_keywords = extractor.extract_keywords(text)
    scored_keywords.sort(key=lambda pair: pair[1])
    return [keyword for keyword, _score in scored_keywords[:max_keywords]]


def _extract_keywords_fallback(text: str, max_keywords: int) -> List[str]:
    """
    Lightweight frequency-based keyword extractor used when YAKE isn't
    installed: lowercase, tokenize on word boundaries (3+ letters),
    drop English stopwords, return the most frequent remaining tokens.

    This is intentionally simple — it's a fallback path, not the
    primary extraction method, and works reasonably even on non-English
    text (stopword filtering just has no effect there, so it degrades
    to plain frequency ranking rather than failing outright).
    """
    tokens = _FALLBACK_TOKEN_PATTERN.findall(text.lower())
    filtered_tokens = [t for t in tokens if t not in _ENGLISH_STOPWORDS]
    counts = Counter(filtered_tokens)
    return [word for word, _count in counts.most_common(max_keywords)]


def extract_keywords(
    text: str,
    language: Optional[str] = None,
    max_keywords: int = _DEFAULT_MAX_KEYWORDS,
) -> List[str]:
    """
    Extract up to `max_keywords` keywords/keyphrases from `text`. Tries
    YAKE first if installed; falls back to a frequency-based extractor
    on any failure (missing dependency, unsupported language, internal
    YAKE error) so keyword extraction never breaks the pipeline.
    """
    if not text or not text.strip():
        return []

    if _YAKE_AVAILABLE:
        try:
            return _extract_keywords_with_yake(text, language, max_keywords)
        except Exception as exc:  # noqa: BLE001 - fall back rather than fail the article
            logger.warning(
                "YAKE keyword extraction failed (%s); using frequency-based fallback.", exc
            )

    return _extract_keywords_fallback(text, max_keywords)


def extract_metadata(
    text: str,
    language: Optional[str] = None,
    max_keywords: int = _DEFAULT_MAX_KEYWORDS,
) -> ExtractedMetadata:
    """
    Run the full Phase 2 metadata extraction pipeline on an article's
    normalized text and return a populated ExtractedMetadata model.

    Never raises: any unexpected failure is logged and results in an
    empty/zeroed ExtractedMetadata rather than stopping the pipeline
    for that article.
    """
    if not text or not text.strip():
        return ExtractedMetadata()

    try:
        word_count = count_words(text)
        return ExtractedMetadata(
            word_count=word_count,
            sentence_count=count_sentences(text),
            paragraph_count=count_paragraphs(text),
            character_count=len(text),
            reading_time_minutes=estimate_reading_time_minutes(word_count),
            summary=extract_first_paragraph_summary(text),
            keywords=extract_keywords(text, language=language, max_keywords=max_keywords),
        )
    except Exception as exc:  # noqa: BLE001 - never let metadata extraction crash the pipeline
        logger.warning("Metadata extraction failed (%s); returning empty metadata.", exc)
        return ExtractedMetadata()
