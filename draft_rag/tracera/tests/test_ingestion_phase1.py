"""
tests/test_ingestion_phase1.py

Offline unit tests for Phase 1 — no network or database calls, so they
can run in CI or a fresh clone with zero setup. Live network/DB behavior
(RSS fetch, GDELT fetch, Postgres insert) should be verified manually
per the "How to test it" instructions in README.md.

Run with:
    python -m pytest tests/test_ingestion_phase1.py -v
"""

import http.server
import threading
import tempfile
from pathlib import Path

import ssl
import sys

import feedparser
import requests

from ingestion.article_model import Article, SourceType
from ingestion.deduplication import DuplicateIndex, deduplicate_articles
from ingestion.feed_validator import FeedStatus, validate_feed_url
from ingestion.rss_collector import _looks_like_feed
from ingestion.text_cleaner import clean_article_text, normalize_whitespace, strip_html
from utils.http_client import _TRUSTSTORE_SSL_CONTEXT, get_session


class _HtmlPageHandler(http.server.BaseHTTPRequestHandler):
    """Serves an HTML page that is NOT an RSS feed — used to test rejection."""

    def do_GET(self):  # noqa: N802 (stdlib method name)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"<html><body><h1>Not a feed</h1></body></html>")

    def log_message(self, *args):
        pass  # silence default request logging during tests


class _RssFeedHandler(http.server.BaseHTTPRequestHandler):
    """Serves a genuine, minimal RSS 2.0 feed — used to test acceptance."""

    def do_GET(self):  # noqa: N802
        body = (
            b'<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>'
            b'<item><title>Hello</title><link>http://example.com/1</link>'
            b"<description>Test</description></item></channel></rss>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/rss+xml")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def _start_server(handler_cls, port: int) -> http.server.HTTPServer:
    server = http.server.HTTPServer(("127.0.0.1", port), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def make_article(url: str, title: str) -> Article:
    return Article(
        url=url,
        title=title,
        publisher="Test Publisher",
        source_type=SourceType.RSS,
        raw_text="<p>Some <b>raw</b> html</p>",
        cleaned_text="",
    )


def test_strip_html_removes_tags():
    result = strip_html("<p>Hello <b>World</b></p>")
    assert "<" not in result
    assert "Hello" in result and "World" in result


def test_normalize_whitespace_collapses_spaces():
    result = normalize_whitespace("Hello    \n\n  World  ")
    assert result == "Hello World"


def test_clean_article_text_end_to_end():
    result = clean_article_text("<div>  Breaking   News  </div>")
    assert result == "Breaking News"


def test_content_hash_is_deterministic():
    a1 = make_article("https://example.com/story", "Big Story")
    a2 = make_article("https://example.com/story", "Big Story")
    assert a1.compute_content_hash() == a2.compute_content_hash()


def test_content_hash_differs_for_different_urls():
    a1 = make_article("https://example.com/story-a", "Big Story")
    a2 = make_article("https://example.com/story-b", "Big Story")
    assert a1.compute_content_hash() != a2.compute_content_hash()


def test_deduplicate_articles_removes_in_batch_duplicates():
    with tempfile.TemporaryDirectory() as tmp_dir:
        index_path = Path(tmp_dir) / "seen_hashes.json"
        duplicate_index = DuplicateIndex(index_path)

        articles = [
            make_article("https://example.com/story", "Same Story"),
            make_article("https://example.com/story", "Same Story"),  # exact duplicate
            make_article("https://example.com/other", "Different Story"),
        ]

        unique = deduplicate_articles(articles, duplicate_index)
        assert len(unique) == 2


def test_deduplicate_articles_persists_across_runs():
    with tempfile.TemporaryDirectory() as tmp_dir:
        index_path = Path(tmp_dir) / "seen_hashes.json"

        # First run: one article gets stored, index saved to disk.
        index_run1 = DuplicateIndex(index_path)
        first_batch = [make_article("https://example.com/story", "Same Story")]
        unique_run1 = deduplicate_articles(first_batch, index_run1)
        index_run1.save()
        assert len(unique_run1) == 1

        # Second run: a fresh DuplicateIndex loads the saved hashes and
        # should now treat the same article as a duplicate.
        index_run2 = DuplicateIndex(index_path)
        second_batch = [make_article("https://example.com/story", "Same Story")]
        unique_run2 = deduplicate_articles(second_batch, index_run2)
        assert len(unique_run2) == 0


def test_looks_like_feed_rejects_html_response():
    """
    Regression test for the exact bug that made the old Reuters RSS
    entry look valid: a URL that returns HTTP 200 with an HTML page
    instead of RSS/Atom content must be rejected, not silently accepted.
    """
    server = _start_server(_HtmlPageHandler, 18901)
    try:
        response = requests.get("http://127.0.0.1:18901/", timeout=5)
        parsed = feedparser.parse(response.content)
        assert _looks_like_feed(response, parsed) is False
    finally:
        server.shutdown()


def test_looks_like_feed_accepts_real_rss():
    server = _start_server(_RssFeedHandler, 18902)
    try:
        response = requests.get("http://127.0.0.1:18902/", timeout=5)
        parsed = feedparser.parse(response.content)
        assert _looks_like_feed(response, parsed) is True
        assert len(parsed.entries) == 1
    finally:
        server.shutdown()


def test_feed_validator_reports_invalid_for_html_response():
    server = _start_server(_HtmlPageHandler, 18903)
    try:
        result = validate_feed_url("Broken Source", "http://127.0.0.1:18903/")
        assert result.status == FeedStatus.INVALID
    finally:
        server.shutdown()


def test_feed_validator_reports_valid_for_real_rss():
    server = _start_server(_RssFeedHandler, 18904)
    try:
        result = validate_feed_url("Working Source", "http://127.0.0.1:18904/")
        assert result.status == FeedStatus.VALID
        assert result.entry_count == 1
    finally:
        server.shutdown()


def test_get_session_does_not_cause_recursion():
    """
    Regression test for the RecursionError caused by an earlier version
    of utils/http_client.py that called truststore.inject_into_ssl()
    (a global ssl.SSLContext monkey-patch). Repeated session creation
    must never recurse — each collector call (RSS, GDELT, validator)
    creates a fresh session per request, so this has to be safe to call
    many times in a row.
    """
    original_limit = sys.getrecursionlimit()
    sys.setrecursionlimit(150)  # deliberately low so any real recursion fails loudly
    try:
        for _ in range(25):
            session = get_session()
            assert "https://" in session.adapters
            assert "http://" in session.adapters
    finally:
        sys.setrecursionlimit(original_limit)


def test_ssl_context_enforces_certificate_verification():
    """
    Regression test ensuring the truststore integration never weakens
    verification. If truststore is installed, its SSLContext must have
    CERT_REQUIRED and check_hostname=True (this codebase never sets
    verify=False or an unverified context).
    """
    if _TRUSTSTORE_SSL_CONTEXT is None:
        return  # truststore not installed in this environment; nothing to check
    assert _TRUSTSTORE_SSL_CONTEXT.verify_mode == ssl.CERT_REQUIRED
    assert _TRUSTSTORE_SSL_CONTEXT.check_hostname is True
