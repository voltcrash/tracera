"""Content-quality validation for Phase 2 preprocessing.

The validator deliberately assesses only the normalized article body.  It does
not decide whether a publisher or a claim is trustworthy; those are separate
provenance and fact-checking concerns.  A failed validation is retained as
metadata so later pipeline stages can exclude weak content without deleting
the original article.
"""

from __future__ import annotations

from dataclasses import dataclass

from preprocessing.models import QualityValidationResult


@dataclass(frozen=True)
class QualityThresholds:
    """Tunable, conservative thresholds for a usable article body."""

    min_characters: int = 200
    min_words: int = 50
    min_letter_ratio: float = 0.45

    def __post_init__(self) -> None:
        if self.min_characters < 0 or self.min_words < 0:
            raise ValueError("Minimum content thresholds cannot be negative")
        if not 0.0 <= self.min_letter_ratio <= 1.0:
            raise ValueError("min_letter_ratio must be between 0.0 and 1.0")


DEFAULT_THRESHOLDS = QualityThresholds()


def _word_count(text: str) -> int:
    """Count Unicode words without assuming that content is English."""
    return len(text.split())


def _letter_ratio(text: str) -> float:
    """Return the share of non-whitespace characters that are letters."""
    meaningful_characters = [character for character in text if not character.isspace()]
    if not meaningful_characters:
        return 0.0
    return sum(character.isalpha() for character in meaningful_characters) / len(
        meaningful_characters
    )


def validate_article_quality(
    text: str | None,
    thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
) -> QualityValidationResult:
    """Validate a cleaned, normalized article body.

    The checks catch the ingestion failures that make text unsuitable for
    chunking or embeddings: missing content, tiny snippets, and pages that
    are predominantly numbers, markup remnants, or symbols.  The result is
    always returned rather than raised, allowing the preprocessing pipeline
    to persist a useful rejection reason per article.
    """
    if not isinstance(text, str):
        return QualityValidationResult(
            is_valid=False,
            validation_reason="Content is missing or not text",
        )

    content = text.strip()
    if not content:
        return QualityValidationResult(is_valid=False, validation_reason="Content is empty")

    character_count = len(content)
    if character_count < thresholds.min_characters:
        return QualityValidationResult(
            is_valid=False,
            validation_reason=(
                f"Content is too short ({character_count} characters; "
                f"minimum is {thresholds.min_characters})"
            ),
        )

    word_count = _word_count(content)
    if word_count < thresholds.min_words:
        return QualityValidationResult(
            is_valid=False,
            validation_reason=(
                f"Content has too few words ({word_count}; minimum is {thresholds.min_words})"
            ),
        )

    letter_ratio = _letter_ratio(content)
    if letter_ratio < thresholds.min_letter_ratio:
        return QualityValidationResult(
            is_valid=False,
            validation_reason=(
                f"Content has too little natural-language text "
                f"({letter_ratio:.0%} letters; minimum is {thresholds.min_letter_ratio:.0%})"
            ),
        )

    return QualityValidationResult(is_valid=True, validation_reason=None)


def validate_quality(
    text: str | None,
    thresholds: QualityThresholds = DEFAULT_THRESHOLDS,
) -> QualityValidationResult:
    """Backward-friendly concise name for :func:`validate_article_quality`."""
    return validate_article_quality(text, thresholds)
