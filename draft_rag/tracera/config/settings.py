"""
config/settings.py

Single source of truth for all configuration values used across the
ingestion pipeline (and later phases). Every other module should import
from here instead of calling os.getenv() directly — this keeps config
centralized and makes it trivial to see everything the system depends on.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from the project root, regardless of which directory the
# script is actually run from.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def _get_int(name: str, default: int) -> int:
    """Read an int env var safely, falling back to a default if missing/invalid."""
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


class Settings:
    # --- Database ---
    DB_HOST: str = os.getenv("DB_HOST", "localhost")
    DB_PORT: int = _get_int("DB_PORT", 5432)
    DB_NAME: str = os.getenv("DB_NAME", "tracera")
    DB_USER: str = os.getenv("DB_USER", "postgres")
    DB_PASSWORD: str = os.getenv("DB_PASSWORD", "")

    # --- GDELT ---
    GDELT_API_BASE: str = os.getenv(
        "GDELT_API_BASE", "https://api.gdeltproject.org/api/v2/doc/doc"
    )
    GDELT_MAX_ARTICLES_PER_QUERY: int = _get_int("GDELT_MAX_ARTICLES_PER_QUERY", 50)

    # --- RSS ---
    RSS_MAX_ARTICLES_PER_SOURCE: int = _get_int("RSS_MAX_ARTICLES_PER_SOURCE", 50)

    # --- HTTP ---
    HTTP_TIMEOUT_SECONDS: int = _get_int("HTTP_TIMEOUT_SECONDS", 15)
    USER_AGENT: str = "TraceraNewsBot/0.1 (+https://example.com/tracera; educational project)"

    # --- Storage ---
    RAW_DATA_DIR: Path = PROJECT_ROOT / os.getenv("RAW_DATA_DIR", "data/raw")
    PROCESSED_DATA_DIR: Path = PROJECT_ROOT / os.getenv("PROCESSED_DATA_DIR", "data/processed")

    # --- Misc ---
    SOURCES_CONFIG_PATH: Path = PROJECT_ROOT / "config" / "sources.yaml"
    FACT_CHECK_SOURCES_CONFIG_PATH: Path = PROJECT_ROOT / "config" / "fact_check_sources.yaml"


settings = Settings()

# Ensure storage directories exist at import time so downstream code never
# has to worry about "directory not found" errors.
settings.RAW_DATA_DIR.mkdir(parents=True, exist_ok=True)
settings.PROCESSED_DATA_DIR.mkdir(parents=True, exist_ok=True)
