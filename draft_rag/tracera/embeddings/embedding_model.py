"""Local, cached sentence-transformer embedding model adapter.

The adapter isolates the optional ``sentence-transformers`` dependency from
the rest of Phase 3 and ensures a model is loaded at most once for each
model/device combination during a process lifetime.
"""

from __future__ import annotations

from threading import Lock
from typing import Any, Sequence 

from embeddings.models import DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS
from utils.logger import get_logger

logger = get_logger(__name__)

_MODEL_CACHE: dict[tuple[str, str | None], "EmbeddingModel"] = {}
_MODEL_CACHE_LOCK = Lock()


class EmbeddingModelError(RuntimeError):
    """Raised when the local embedding model cannot be loaded or used."""


class EmbeddingModel:
    """Small, validated wrapper around a loaded SentenceTransformer instance."""

    def __init__(self, model: Any, model_name: str, device: str | None) -> None:
        self._model = model
        self.model_name = model_name
        self.device = device

    def encode(
        self,
        texts: Sequence[str],
        batch_size: int = 32,
        normalize_embeddings: bool = False,
    ) -> list[list[float]]:
        """Return one 384-dimensional vector per non-empty input text.

        Input validation happens before model inference so corrupt database
        records produce a clear error rather than an opaque model failure.
        """
        if batch_size < 1:
            raise ValueError("batch_size must be at least 1")
        if not texts:
            return []
        if any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ValueError("All texts must be non-empty strings")

        try:
            matrix = self._model.encode(
                list(texts),
                batch_size=batch_size,
                show_progress_bar=False,
                convert_to_numpy=True,
                normalize_embeddings=normalize_embeddings,
            )
        except Exception as exc:  # noqa: BLE001 - third-party model errors need a stable boundary
            raise EmbeddingModelError(f"Embedding inference failed: {exc}") from exc

        vectors = [[float(value) for value in vector] for vector in matrix]
        if len(vectors) != len(texts):
            raise EmbeddingModelError(
                f"Model returned {len(vectors)} vectors for {len(texts)} input texts"
            )
        if any(len(vector) != EMBEDDING_DIMENSIONS for vector in vectors):
            actual_dimensions = next(
                len(vector) for vector in vectors if len(vector) != EMBEDDING_DIMENSIONS
            )
            raise EmbeddingModelError(
                f"Expected {EMBEDDING_DIMENSIONS}-dimensional vectors; got {actual_dimensions}"
            )
        return vectors


def _load_sentence_transformer(model_name: str, device: str | None) -> Any:
    """Load the optional local model dependency only when Phase 3 is invoked."""
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise EmbeddingModelError(
            "sentence-transformers is required for Phase 3. "
            "Install it with: pip install sentence-transformers"
        ) from exc

    try:
        logger.info("Loading embedding model %s on %s.", model_name, device or "auto")
        return SentenceTransformer(model_name, device=device)
    except Exception as exc:  # noqa: BLE001 - provide Phase 3-specific context
        raise EmbeddingModelError(f"Could not load embedding model {model_name!r}: {exc}") from exc


def get_embedding_model(
    model_name: str = DEFAULT_EMBEDDING_MODEL,
    device: str | None = None,
) -> EmbeddingModel:
    """Return the cached local embedding model for ``model_name`` and ``device``."""
    if not model_name.strip():
        raise ValueError("model_name cannot be empty")

    cache_key = (model_name, device)
    with _MODEL_CACHE_LOCK:
        cached_model = _MODEL_CACHE.get(cache_key)
        if cached_model is not None:
            return cached_model

        loaded_model = EmbeddingModel(
            model=_load_sentence_transformer(model_name, device),
            model_name=model_name,
            device=device,
        )
        _MODEL_CACHE[cache_key] = loaded_model
        logger.info("Loaded embedding model %s.", model_name)
        return loaded_model


def clear_embedding_model_cache() -> None:
    """Clear cached models; intended for isolated tests and controlled shutdown."""
    with _MODEL_CACHE_LOCK:
        _MODEL_CACHE.clear()
