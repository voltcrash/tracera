"""Phase 3: local embeddings and PostgreSQL pgvector integration.

This package is intentionally independent of the Phase 1 ingestion and Phase
2 preprocessing modules.  It reads only valid processed articles through its
own repository layer and will persist vectors without modifying source or
preprocessing fields.
"""
