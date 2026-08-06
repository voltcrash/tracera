"""Configuration and small reusable helpers for the Phase 3 pipeline."""

from __future__ import annotations

import os
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from typing import TypeVar

from config.settings import settings
from embeddings.models import DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_VERSION
from utils.logger import get_logger

logger = get_logger(__name__)

T = TypeVar("T")

_VALID_DEVICES = {"auto", "cpu", "cuda"}
_VALID_SIMILARITY_METRICS = {"cosine"}


@dataclass(frozen=True)
class EmbeddingConfig:
    """Runtime configuration for local model inference and pgvector storage."""

    model_name: str = DEFAULT_EMBEDDING_MODEL
    batch_size: int = 32
    device: str | None = None
    similarity_metric: str = "cosine"
    force_regenerate: bool = False
    embedding_version: str = DEFAULT_EMBEDDING_VERSION


def _setting(name: str, default: str) -> str:
    """Read a Phase 3 environment override, then a future settings attribute."""
    environment_value = os.getenv(name)
    if environment_value is not None:
        return environment_value
    return str(getattr(settings, name, default))


def _positive_integer(value: str, name: str, default: int) -> int:
    """Parse a positive integer setting, logging and falling back safely."""
    try:
        parsed = int(value)
    except ValueError:
        parsed = 0
    if parsed < 1:
        logger.warning("Invalid %s=%r; using default %d.", name, value, default)
        return default
    return parsed


def _boolean(value: str, name: str, default: bool = False) -> bool:
    """Parse a conventional boolean environment value with a safe fallback."""
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off", ""}:
        return False
    logger.warning("Invalid %s=%r; using default %s.", name, value, default)
    return default


def load_embedding_config() -> EmbeddingConfig:
    """Build validated Phase 3 configuration without changing existing settings.py."""
    model_name = _setting("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL).strip()
    if not model_name:
        logger.warning("EMBEDDING_MODEL is empty; using %s.", DEFAULT_EMBEDDING_MODEL)
        model_name = DEFAULT_EMBEDDING_MODEL

    device_value = _setting("EMBEDDING_DEVICE", "auto").strip().lower()
    if device_value not in _VALID_DEVICES:
        logger.warning("Invalid EMBEDDING_DEVICE=%r; using auto.", device_value)
        device_value = "auto"

    metric = _setting("EMBEDDING_SIMILARITY_METRIC", "cosine").strip().lower()
    if metric not in _VALID_SIMILARITY_METRICS:
        logger.warning("Invalid EMBEDDING_SIMILARITY_METRIC=%r; using cosine.", metric)
        metric = "cosine"

    version = _setting("EMBEDDING_VERSION", DEFAULT_EMBEDDING_VERSION).strip()
    if not version:
        version = DEFAULT_EMBEDDING_VERSION

    return EmbeddingConfig(
        model_name=model_name,
        batch_size=_positive_integer(_setting("EMBEDDING_BATCH_SIZE", "32"), "EMBEDDING_BATCH_SIZE", 32),
        device=None if device_value == "auto" else device_value,
        similarity_metric=metric,
        force_regenerate=_boolean(_setting("EMBEDDING_FORCE_REGENERATE", "false"), "EMBEDDING_FORCE_REGENERATE"),
        embedding_version=version,
    )


def batched(items: Sequence[T], batch_size: int) -> Iterator[Sequence[T]]:
    """Yield bounded slices of an in-memory sequence with validated sizing."""
    if batch_size < 1:
        raise ValueError("batch_size must be at least 1")
    for start in range(0, len(items), batch_size):
        yield items[start : start + batch_size]


def flatten(items: Iterable[Iterable[T]]) -> list[T]:
    """Flatten nested iterables for concise summary aggregation."""
    return [value for group in items for value in group]
