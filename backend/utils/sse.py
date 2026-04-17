"""
Shared SSE formatting utility.

Usage::

    from backend.utils.sse import sse_event, sse_error, sse_watchdog_timeout

    yield sse_event({"type": "start"})
    yield sse_error(500, "something went wrong")

    timeout = sse_watchdog_timeout()   # float | None, from settings
"""

import json

from backend.config import get_settings


def sse_event(data: dict) -> str:
    """Format a dict as a single SSE data frame (JSON-encoded, newline-terminated)."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def sse_error(status: int, message: str) -> str:
    """Shorthand for a standard SSE error event frame."""
    return sse_event({"type": "error", "status": status, "message": message})


def sse_watchdog_timeout() -> float | None:
    """Return the SSE watchdog timeout in seconds, or None if disabled.

    Reads ``SSE_WATCHDOG_TIMEOUT_S`` from settings.  A value <= 0 means the
    watchdog is disabled (returns None, suitable for passing directly to
    ``asyncio.wait_for``).
    """
    s = get_settings().SSE_WATCHDOG_TIMEOUT_S
    return float(s) if s > 0 else None
