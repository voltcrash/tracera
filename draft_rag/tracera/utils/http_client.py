"""
utils/http_client.py

Centralized HTTP client used by every collector (RSS, GDELT, feed
validation). Exists mainly to fix a very common, very confusing failure
mode on Windows: `requests` raising

    SSLError: [SSL: CERTIFICATE_VERIFY_FAILED] unable to get local
    issuer certificate

This happens because `requests`/`urllib3` verify TLS connections
against the `certifi` package's bundled CA list, NOT against Windows'
own certificate store. On a lot of Windows machines — especially
college/corporate laptops with antivirus software (Kaspersky, McAfee,
Zscaler, etc.) or a network proxy that does TLS inspection — the
system silently re-signs HTTPS traffic with a locally-installed root
certificate. That root CA lives in the Windows certificate store, but
`certifi` has never heard of it, so every HTTPS request fails
verification even though the connection itself is legitimate from the
OS's point of view.

Fix: use the `truststore` package, which can verify against the
OS-native trust store (Windows' cert store, macOS Keychain, or Linux's
system CA store) instead of `certifi`.

IMPORTANT — how this is wired in, and why:

An earlier version of this module called `truststore.inject_into_ssl()`,
which globally monkey-patches `ssl.SSLContext` for the whole process.
That caused a `RecursionError` inside urllib3's connection setup: every
new HTTPS connection asks `ssl` for a fresh context, and once
`ssl.SSLContext` itself has been replaced, constructing further
"fresh" contexts can end up recursively re-wrapping the patched class.
Global monkey-patching also risks interfering with anything else in
the process that touches the `ssl` module.

This version does the opposite: it does NOT touch `ssl.create_default_context`,
`ssl.SSLContext`, or any urllib3 internals. Instead it builds ONE
explicit `truststore.SSLContext` instance at import time and hands it
to `requests` the way `requests`/`urllib3` are actually designed to be
configured — via a custom `HTTPAdapter` that passes `ssl_context=...`
into urllib3's `PoolManager`. This is the integration pattern documented
by truststore itself (https://truststore.readthedocs.io/en/latest/#urllib3-and-requests).
Nothing global is modified, so there's nothing to recurse into and
nothing that can affect unrelated code elsewhere in the process.

If `truststore` is unavailable or fails to initialize, requests falls
back to its normal behavior (certifi's bundled CA list) rather than
crashing the pipeline — full certificate verification still happens
either way; only the trust source differs.
"""

import platform
import ssl
from typing import Optional

import certifi
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config.settings import settings
from utils.logger import get_logger

logger = get_logger(__name__)

try:
    import truststore

    _TRUSTSTORE_AVAILABLE = True
except ImportError:
    truststore = None
    _TRUSTSTORE_AVAILABLE = False

# Built once, at import time — never rebuilt per-request and never used
# to replace anything in the global `ssl` module. This is what avoids
# the recursion: there is exactly one context object, constructed
# exactly once, passed explicitly to urllib3 as plain data.
_TRUSTSTORE_SSL_CONTEXT: Optional[ssl.SSLContext] = None
_TRUSTSTORE_INIT_ERROR: Optional[Exception] = None

if _TRUSTSTORE_AVAILABLE:
    try:
        _TRUSTSTORE_SSL_CONTEXT = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        # PROTOCOL_TLS_CLIENT already defaults to CERT_REQUIRED and
        # check_hostname=True, but we assert it explicitly here so a
        # future Python/truststore change can never silently weaken
        # verification without this module noticing.
        assert _TRUSTSTORE_SSL_CONTEXT.verify_mode == ssl.CERT_REQUIRED
        assert _TRUSTSTORE_SSL_CONTEXT.check_hostname is True
    except Exception as exc:  # noqa: BLE001
        _TRUSTSTORE_INIT_ERROR = exc
        _TRUSTSTORE_SSL_CONTEXT = None

_startup_logged = False


class _OSTrustStoreAdapter(HTTPAdapter):
    """
    HTTPAdapter that verifies TLS certificates against the pre-built
    OS-native truststore SSLContext, instead of the default
    certifi-backed context requests/urllib3 would otherwise construct.

    This only affects connections made through sessions that mount
    this adapter — it is not global, not monkey-patched, and safe to
    instantiate more than once (each instance just reuses the same
    already-built context object).
    """

    def init_poolmanager(self, *args, **kwargs):
        kwargs["ssl_context"] = _TRUSTSTORE_SSL_CONTEXT
        return super().init_poolmanager(*args, **kwargs)

    def proxy_manager_for(self, *args, **kwargs):
        kwargs["ssl_context"] = _TRUSTSTORE_SSL_CONTEXT
        return super().proxy_manager_for(*args, **kwargs)


def _log_ssl_setup_once() -> None:
    """Log which certificate trust source is active — once per process, not per request."""
    global _startup_logged
    if _startup_logged:
        return
    _startup_logged = True

    if _TRUSTSTORE_SSL_CONTEXT is not None:
        logger.info(
            "SSL verification uses the OS-native certificate store (via "
            "truststore, mounted as a requests HTTPAdapter — no global "
            "ssl module patching). This fixes 'CERTIFICATE_VERIFY_FAILED' "
            "errors common on Windows machines with antivirus/proxy TLS "
            "inspection."
        )
    elif _TRUSTSTORE_AVAILABLE:
        logger.warning(
            "The 'truststore' package is installed but its SSLContext "
            "failed to initialize (%s). Falling back to certifi's CA "
            "bundle; certificate verification is still enforced.",
            _TRUSTSTORE_INIT_ERROR,
        )
    else:
        logger.warning(
            "The 'truststore' package is not installed (pip install "
            "truststore). Falling back to certifi's CA bundle. If you're "
            "on Windows and see SSL: CERTIFICATE_VERIFY_FAILED errors, "
            "install truststore and re-run."
        )


def get_session() -> requests.Session:
    """
    Return a configured requests.Session for all outbound ingestion HTTP
    calls: OS-native SSL verification (when available), a real
    User-Agent (many news sites reject the default python-requests UA),
    and automatic retries on transient failures (connection resets, 5xx
    responses).

    Certificate verification is always on — this function never
    constructs a session with `verify=False` or an unverified context,
    regardless of whether truststore is available.
    """
    _log_ssl_setup_once()

    session = requests.Session()
    session.headers.update({"User-Agent": settings.USER_AGENT})

    retry_strategy = Retry(
        total=2,
        backoff_factor=1.0,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["GET", "HEAD"],
    )

    if _TRUSTSTORE_SSL_CONTEXT is not None:
        adapter = _OSTrustStoreAdapter(max_retries=retry_strategy)
    else:
        # Falls back to requests/urllib3's normal certifi-backed
        # verification — still fully verified, just not OS-native.
        adapter = HTTPAdapter(max_retries=retry_strategy)

    session.mount("https://", adapter)
    session.mount("http://", adapter)

    return session


def describe_ssl_environment() -> str:
    """
    Human-readable one-liner about the current SSL setup, useful for
    startup diagnostics (see ingestion/feed_validator.py).
    """
    return (
        f"platform={platform.system()}, "
        f"openssl={ssl.OPENSSL_VERSION}, "
        f"certifi_bundle={certifi.where()}, "
        f"truststore_active={_TRUSTSTORE_SSL_CONTEXT is not None}"
    )
