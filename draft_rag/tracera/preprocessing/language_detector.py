"""
preprocessing/language_detector.py

Phase 2 language detection, using `langdetect` (already a Phase 1
dependency via requirements.txt). Wraps langdetect's API so callers
only ever see the typed LanguageDetectionResult model from
preprocessing/models.py, never langdetect's own exception types or
return shapes directly.

Stores a confidence score alongside the language code by using
langdetect's detect_langs() (which returns probability-ranked
candidates) instead of detect() (which only returns the top guess with
no score).
"""

from langdetect import DetectorFactory, detect_langs
from langdetect.lang_detect_exception import LangDetectException

from preprocessing.models import LanguageDetectionResult
from utils.logger import get_logger

logger = get_logger(__name__)

# langdetect seeds its internal detector from Python's random module;
# without a fixed seed, short or linguistically ambiguous text can
# detect as a different language on different runs of the same input.
# Fixing the seed makes results reproducible -- important for tests and
# for being able to reproduce "why did this article get tagged fr"
# after the fact.
DetectorFactory.seed = 0

# Below this length, langdetect's n-gram model doesn't have enough
# signal to be reliable -- short strings routinely misdetect (e.g. "OK"
# can register as almost anything). Flagging this explicitly is more
# honest than returning a confident-looking but meaningless guess.
_MIN_TEXT_LENGTH_FOR_DETECTION = 20  # characters


def detect_language(text: str) -> LanguageDetectionResult:
    """
    Detect the dominant language of `text`.

    Returns an ISO 639-1 code (e.g. "en", "fr", "hi") with a 0.0-1.0
    confidence score when detection succeeds. Never raises: langdetect
    fails loudly (LangDetectException) on empty, too-short, purely
    numeric, or otherwise language-less input -- that's an expected,
    common outcome here (a lot of article snippets are short), not a
    pipeline-stopping error. It surfaces as
    LanguageDetectionResult(language=None, detection_error=...) so the
    pipeline can log it and move on to the next article.
    """
    if not text or len(text.strip()) < _MIN_TEXT_LENGTH_FOR_DETECTION:
        return LanguageDetectionResult(
            language=None,
            confidence=None,
            detection_error=(
                f"Text too short for reliable detection "
                f"(< {_MIN_TEXT_LENGTH_FOR_DETECTION} chars)"
            ),
        )

    try:
        candidates = detect_langs(text)
    except LangDetectException as exc:
        logger.warning("Language detection failed: %s", exc)
        return LanguageDetectionResult(language=None, confidence=None, detection_error=str(exc))
    except Exception as exc:  # noqa: BLE001 - a third-party detector must never crash the pipeline
        logger.warning("Unexpected error during language detection: %s", exc)
        return LanguageDetectionResult(language=None, confidence=None, detection_error=str(exc))

    if not candidates:
        return LanguageDetectionResult(
            language=None, confidence=None, detection_error="No language candidates returned"
        )

    # detect_langs() returns candidates sorted by probability, highest first.
    top_candidate = candidates[0]
    return LanguageDetectionResult(
        language=top_candidate.lang,
        confidence=round(top_candidate.prob, 4),
    )
