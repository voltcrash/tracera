"""
ingestion/article_model.py

Defines the canonical Article representation used throughout the
ingestion pipeline. Every collector (RSS, GDELT, future sources) must
produce Article objects, so downstream stages (cleaning, dedup, storage)
never need to know where an article came from.
"""

import hashlib
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


class SourceType(str, Enum):
    RSS = "rss"
    GDELT = "gdelt"


class Article(BaseModel):
    # --- Identity ---
    url: HttpUrl
    title: str

    # --- Provenance ---
    publisher: str
    source_type: SourceType
    category: Optional[str] = None

    # --- Timing ---
    published_at: Optional[datetime] = None
    collected_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    # --- Content ---
    raw_text: str = ""          # text as extracted, before cleaning
    cleaned_text: str = ""      # populated by the text cleaner (Phase 2 logic, used here for storage)
    language: Optional[str] = None

    # --- Dedup ---
    content_hash: Optional[str] = None

    def compute_content_hash(self) -> str:
        """
        Content-based hash used for duplicate detection.

        We hash the URL + normalized title rather than full body text,
        because near-duplicate wire stories (e.g. the same Reuters piece
        syndicated by five outlets) often have slightly different body
        formatting but identical or near-identical titles+URLs. Full-text
        near-duplicate detection is a Phase 2 refinement; this Phase 1
        hash catches exact re-fetches efficiently and cheaply.
        """
        basis = f"{str(self.url).strip().lower()}|{self.title.strip().lower()}"
        digest = hashlib.sha256(basis.encode("utf-8")).hexdigest()
        self.content_hash = digest
        return digest

    model_config = ConfigDict(use_enum_values=True)
