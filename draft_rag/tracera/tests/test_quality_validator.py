"""Offline tests for Phase 2 content-quality validation."""

from preprocessing.quality_validator import QualityThresholds, validate_article_quality


VALID_ARTICLE = " ".join(
    [
        "Independent reporters described the policy announcement in detail, including its expected effects on local services and residents."
    ]
    * 5
)


def test_accepts_substantive_natural_language_content():
    result = validate_article_quality(VALID_ARTICLE)

    assert result.is_valid is True
    assert result.validation_reason is None


def test_rejects_empty_content():
    result = validate_article_quality("  \n\t ")

    assert result.is_valid is False
    assert result.validation_reason == "Content is empty"


def test_rejects_short_snippet_with_clear_reason():
    result = validate_article_quality("Breaking news: more details soon.")

    assert result.is_valid is False
    assert result.validation_reason.startswith("Content is too short")


def test_rejects_symbol_and_number_heavy_content():
    content = ("12345 !!! ??? --- ") * 30
    result = validate_article_quality(
        content,
        QualityThresholds(min_characters=100, min_words=10, min_letter_ratio=0.45),
    )

    assert result.is_valid is False
    assert result.validation_reason.startswith("Content has too little natural-language text")


def test_rejects_non_text_input_without_raising():
    result = validate_article_quality(None)

    assert result.is_valid is False
    assert result.validation_reason == "Content is missing or not text"
