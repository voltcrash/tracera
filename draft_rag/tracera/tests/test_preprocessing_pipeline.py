"""Unit tests for the pure orchestration helpers in the Phase 2 pipeline."""

from preprocessing.models import QualityValidationResult
from preprocessing.pipeline import _combine_validation


def test_combine_validation_keeps_text_and_database_failures():
    result = _combine_validation(
        QualityValidationResult(is_valid=False, validation_reason="Content is empty"),
        ["Publisher is missing", "Duplicate title"],
    )

    assert result.is_valid is False
    assert result.validation_reason == "Content is empty; Publisher is missing; Duplicate title"


def test_combine_validation_accepts_article_with_no_failures():
    result = _combine_validation(QualityValidationResult(is_valid=True), [])

    assert result.is_valid is True
    assert result.validation_reason is None
