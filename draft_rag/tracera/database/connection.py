"""
database/connection.py

Thin wrapper around psycopg2 for getting a database connection and
applying schema.sql. We use plain psycopg2 (not an ORM) in Phase 1
because the schema is small and the queries are simple — an ORM can be
introduced later if the schema grows complex enough to justify it.
"""

from contextlib import contextmanager
from pathlib import Path

import psycopg2
from psycopg2.extensions import connection as PGConnection

from config.settings import settings
from utils.logger import get_logger

logger = get_logger(__name__)

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def get_connection() -> PGConnection:
    """Open a new PostgreSQL connection using settings from config/settings.py."""
    return psycopg2.connect(
        host=settings.DB_HOST,
        port=settings.DB_PORT,
        dbname=settings.DB_NAME,
        user=settings.DB_USER,
        password=settings.DB_PASSWORD,
    )


@contextmanager
def db_cursor():
    """
    Context manager yielding a cursor with automatic commit/rollback.

    Usage:
        with db_cursor() as cur:
            cur.execute("SELECT 1")
    """
    conn = get_connection()
    try:
        with conn:
            with conn.cursor() as cur:
                yield cur
    except Exception:
        logger.exception("Database operation failed; transaction rolled back.")
        raise
    finally:
        conn.close()


def initialize_schema() -> None:
    """Apply schema.sql to create tables/indexes if they don't already exist."""
    logger.info("Applying database schema from %s", SCHEMA_PATH)
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        schema_sql = f.read()

    with db_cursor() as cur:
        cur.execute(schema_sql)

    logger.info("Schema applied successfully.")
