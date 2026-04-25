"""
Shared SSE formatting utility.

Usage::

    from backend.utils.sse import sse_event, sse_error, sse_watchdog_timeout, sse_timeout_tick

    yield sse_event({"type": "start"})
    yield sse_error(500, "something went wrong")

    timeout = sse_watchdog_timeout()   # float | None, from settings

    # Inside a queue.get() TimeoutError handler:
    last_heartbeat, do_heartbeat, watchdog_fired = sse_timeout_tick(
        last_event, last_heartbeat, watchdog_s
    )
"""

import json
import time

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


def sse_timeout_tick(
    last_event: float,
    last_heartbeat: float,
    watchdog_s: float | int,
) -> tuple[float, bool, bool]:
    """Called on queue.get() timeout; returns (new_last_heartbeat, should_heartbeat, watchdog_fired).

    ``last_event`` is NOT updated here — callers update it only when a real
    event arrives, so the watchdog tracks genuine progress, not keepalives.

    Usage::

        except asyncio.TimeoutError:
            last_heartbeat, do_heartbeat, watchdog_fired = sse_timeout_tick(
                last_event, last_heartbeat, watchdog_s
            )
            if do_heartbeat:
                yield ": heartbeat\\n\\n"
            if watchdog_fired:
                ...cancel and return...
            continue
    """
    now = time.monotonic()
    do_heartbeat = now - last_heartbeat >= get_settings().SSE_HEARTBEAT_INTERVAL_S
    watchdog_fired = watchdog_s > 0 and now - last_event > watchdog_s
    return (now if do_heartbeat else last_heartbeat), do_heartbeat, watchdog_fired
