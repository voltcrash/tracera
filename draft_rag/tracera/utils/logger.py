"""
utils/logger.py

Centralized logger factory. Every module calls get_logger(__name__)
instead of using print(), so log output is consistent, timestamped,
and filterable by module name and severity.
"""

import logging
import sys


_CONFIGURED = False


def _configure_root_logger() -> None:
    """Configure the root logger once, on first use."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    handler = logging.StreamHandler(sys.stdout)
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Return a module-scoped logger, configuring the root logger on first call."""
    _configure_root_logger()
    return logging.getLogger(name)
