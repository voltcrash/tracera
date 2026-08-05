# Tracera — Phase 1: News Ingestion

This is Phase 1 of the Tracera RAG-based news verification platform: a
complete, working pipeline that collects news articles from RSS feeds
and the GDELT DOC 2.0 API, deduplicates them, does light text cleanup,
and stores them both as JSON files and in PostgreSQL.

Nothing beyond ingestion is built yet — no chunking, no embeddings, no
LLM calls. That's intentional; each phase builds on a fully working
previous one.

## Update: source reliability & validation hardening

Every RSS URL in this project was manually re-verified live (fetched
and inspected, not just copied from a list) after finding real
problems in the original source list:

- **Reuters** — discontinued public RSS feeds in June 2020. The old
  URL served an HTML landing page that happened to return HTTP 200,
  which is exactly the kind of silent failure this update targets.
- **The Hindu** — blocks automated/non-browser requests outright.

Both were removed and replaced with **NDTV** (confirmed live). BBC was
also updated to `https://` and re-verified. **NPR** is kept but flagged
in `config/sources.yaml`: its RSS feeds have documented reports of
geoblocking non-US traffic with HTTP 403 — if the startup validator
below reports it as INVALID on your network, that's why.

Four things changed to make this kind of failure visible instead of
silent:

1. **The RSS collector now rejects non-feed URLs at runtime.**
   `ingestion/rss_collector.py`'s `_looks_like_feed()` checks the
   response's Content-Type *and* whether feedparser actually recognized
   a feed format — a URL returning HTTP 200 with an HTML page (like the
   old Reuters entry) is now logged and dropped instead of silently
   treated as zero articles with no explanation.
2. **`config/fact_check_sources.yaml`** — a new, separate config file
   for fact-checking organizations (PolitiFact, FactCheck.org, Full
   Fact — all verified live; Snopes excluded because its feed now
   returns HTTP 402/Payment Required). Kept separate from
   `sources.yaml` because these sources back the claim-verification
   pipeline (Phase 11), not the general news corpus.
3. **Windows SSL certificate handling is fixed.** `utils/http_client.py`
   uses the `truststore` package to make Python's SSL verification use
   the OS-native certificate store instead of `certifi`'s bundle. This
   is the standard fix for the classic Windows
   `SSL: CERTIFICATE_VERIFY_FAILED` error caused by antivirus software
   or a corporate/college network proxy doing TLS inspection — no
   manual certificate exporting needed.
4. **Startup feed validation.** `ingestion/feed_validator.py` checks
   every configured RSS URL — both `sources.yaml` and
   `fact_check_sources.yaml` — *before* ingestion starts, and prints a
   pass/fail report with a reason for every failure (HTTP status,
   timeout, SSL error, "not a feed", etc). The pipeline runs this
   automatically and skips invalid sources for that run rather than
   crashing. Run it standalone any time with:
   ```
   python -m ingestion.feed_validator
   ```

## What was built and why

| Requirement | Where | Why it's built this way |
|---|---|---|
| RSS collection | `ingestion/rss_collector.py` | Fetches via `requests` (not feedparser's own fetcher) so we control timeout + User-Agent — many outlets 403 the default UA. |
| GDELT integration | `ingestion/gdelt_collector.py` | Calls the free, keyless GDELT DOC 2.0 API. Returns title/url/domain/date metadata; full article body is not fetched from GDELT results to avoid scraping unvetted sites. |
| Metadata extraction | `ingestion/article_model.py` | A single `Article` Pydantic model is the contract every collector must produce — downstream code never needs to know if an article came from RSS or GDELT. |
| Duplicate removal | `ingestion/deduplication.py` | Hashes `url + normalized title`. Checks both within a single run and against a persisted JSON index of previously-seen hashes, so re-running tomorrow won't re-store today's articles. |
| JSON storage | `ingestion/storage.py` | Each run writes one timestamped JSON file to `data/raw/`. |
| PostgreSQL metadata storage | `database/` | `schema.sql` defines the `articles` table; `connection.py` handles connections; `models.py` does the actual insert (`ON CONFLICT DO NOTHING` on the content hash, so DB-level dedup backs up the JSON-index dedup). |
| Text cleaning | `ingestion/text_cleaner.py` | Minimal HTML-stripping + whitespace/unicode normalization needed to make stored text usable. Deeper cleaning (language detection, aggressive normalization) is explicitly Phase 2's job and will extend this module rather than duplicate it. |
| Modular code / adding new sources | `config/sources.yaml` + `config/settings.py` | Adding a new RSS feed or GDELT query is a YAML edit, not a code change (see below). Adding a genuinely new *source type* (e.g. NewsAPI) means writing one new collector module that returns `Article` objects — nothing else in the pipeline needs to change. |

## Project structure

```
tracera/
├── ingestion/
│   ├── article_model.py     # Canonical Article data model (pydantic)
│   ├── rss_collector.py     # RSS/Atom feed collector (rejects non-feed URLs)
│   ├── gdelt_collector.py   # GDELT DOC 2.0 API collector
│   ├── feed_validator.py    # Startup validation: checks every RSS URL before ingestion
│   ├── text_cleaner.py      # HTML stripping, whitespace/unicode normalization
│   ├── deduplication.py     # In-batch + cross-run duplicate detection
│   ├── storage.py           # Write articles to JSON
│   └── pipeline.py          # Orchestrates the full run (entry point)
├── database/
│   ├── schema.sql           # articles table definition
│   ├── connection.py        # psycopg2 connection + schema init
│   └── models.py            # insert_articles()
├── config/
│   ├── settings.py          # Loads .env, exposes typed settings
│   ├── sources.yaml         # General news RSS feeds + GDELT queries
│   └── fact_check_sources.yaml  # Fact-checking orgs (PolitiFact, FactCheck.org, Full Fact)
├── utils/
│   ├── logger.py            # Shared logging setup
│   └── http_client.py       # Shared requests session; fixes Windows SSL cert issues
├── tests/
│   └── test_ingestion_phase1.py  # Offline unit tests (no network/DB needed)
├── data/
│   ├── raw/                 # JSON output lands here
│   └── processed/           # Duplicate-hash index lives here
├── requirements.txt
├── .env.example
└── README.md
```

## Setup

1. **Create a virtual environment and install dependencies:**
   ```
   python -m venv venv
   venv\Scripts\activate        (Windows)
   pip install -r requirements.txt
   ```

2. **Configure environment variables:**
   ```
   copy .env.example .env
   ```
   Then edit `.env` with your real PostgreSQL credentials. GDELT needs no API key.

3. **Create the PostgreSQL database** (the tables themselves are created automatically by the pipeline on first run):
   ```
   createdb tracera
   ```

## How to run it

From the `tracera/` root:

```
python -m ingestion.pipeline
```

This will:
1. Read `config/sources.yaml`
2. Fetch every configured RSS feed and GDELT query
3. Deduplicate against both this run and all previous runs
4. Write new articles to `data/raw/articles_<timestamp>.json`
5. Create the `articles` table if it doesn't exist, and insert the new rows

If you don't have PostgreSQL set up yet and just want to test collection:
```python
from ingestion.pipeline import run_ingestion_pipeline
run_ingestion_pipeline(use_database=False)
```

## How to add a new source

- **New RSS feed:** add an entry under `rss_sources` in `config/sources.yaml`. No code change.
- **New GDELT query:** add an entry under `gdelt_queries` in `config/sources.yaml`. No code change.
- **New source type entirely** (e.g. a NewsAPI, a specific gov't RSS, a custom scraper for a site that allows it): write one new module in `ingestion/` that returns a `List[Article]`, following the shape of `rss_collector.py`. Then call it from `pipeline.py` alongside the existing `collect_all_rss` / `collect_all_gdelt` calls.

## How to test it

**Offline unit tests** (no network or DB required — test text cleaning, hashing, dedup, and feed-validation logic using local mock HTTP servers):
```
python -m pytest tests/test_ingestion_phase1.py -v
```
All 11 tests currently pass.

**Startup feed validation** (requires network; checks every configured RSS URL and reports valid/invalid with a reason):
```
python -m ingestion.feed_validator
```

**Live smoke test** (requires network access; verifies real feed fetching):
```python
from ingestion.rss_collector import collect_from_source
articles = collect_from_source({
    "name": "BBC Test",
    "url": "http://feeds.bbci.co.uk/news/world/rss.xml",
    "publisher": "BBC News",
    "category": "world",
})
print(len(articles), "articles collected")
```

**Full pipeline test** (requires network + PostgreSQL):
```
python -m ingestion.pipeline
```
Check `data/raw/` for the JSON output and query the `articles` table to confirm rows were inserted.

## Known Phase 1 limitations (by design — addressed in later phases)

- GDELT articles store only title text, not full body — full-text fetching from GDELT-sourced URLs is deferred.
- Text cleaning is minimal; language detection and deeper normalization are Phase 2.
- Deduplication is hash-based (exact url+title matches), not semantic/near-duplicate detection.
- No chunking, embeddings, or vector storage yet — that starts at Phase 3.

## Next step

Once you've verified this phase runs correctly on your machine (real RSS feeds + GDELT + your PostgreSQL instance), let me know and we'll move to **Phase 2 — Data Cleaning**.
