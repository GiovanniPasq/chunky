"""
Shared SSE formatting utility.

Usage::

    from backend.utils.sse import sse_event, sse_error, sse_timeout_tick

    yield sse_event({"type": "start"})
    yield sse_error(500, "something went wrong")

    # Inside a queue.get() TimeoutError handler:
    last_heartbeat, do_heartbeat, watchdog_fired = sse_timeout_tick(
        last_event, last_heartbeat, watchdog_s
    )

    # Full event-loop scaffolding (disconnect, heartbeat, watchdog,
    # sentinel termination, uniform cancellation):
    async for frame in run_sse_event_loop(
        queue=queue,
        http_request=http_request,
        on_cancel=_cancel_all,                 # idempotent cleanup
        handle_event=lambda ev: (sse_event(ev), False),
        watchdog_s=watchdog_s,
        queue_timeout_s=queue_timeout_s,
        log_name="my operation",
    ):
        yield frame
"""

import asyncio
import json
import logging
import time
from typing import AsyncIterator, Awaitable, Callable, Iterable

from fastapi import Request

from backend.config import get_settings

logger = logging.getLogger(__name__)


def sse_event(data: dict) -> str:
    """Format a dict as a single SSE data frame (JSON-encoded, newline-terminated)."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


def sse_error(status: int, message: str) -> str:
    """Shorthand for a standard SSE error event frame."""
    return sse_event({"type": "error", "status": status, "message": message})


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


async def run_sse_event_loop(
    *,
    queue: asyncio.Queue,
    http_request: Request,
    on_cancel: Callable[[], Awaitable[None]],
    handle_event: Callable[[dict], tuple[str | None, bool]],
    watchdog_s: float,
    queue_timeout_s: float,
    log_name: str,
    on_complete: Callable[[], Iterable[str]] | None = None,
) -> AsyncIterator[str]:
    """Drive the SSE response loop shared by every streaming endpoint.

    All five streaming endpoints follow the same shape: a background
    producer task pushes events (and a ``None`` sentinel) onto an
    ``asyncio.Queue``; the route handler consumes them, yields SSE
    frames, polls for client disconnect, sends keepalive heartbeats
    during idle periods, and fires a watchdog if the producer stops
    making progress.  This helper encapsulates that scaffolding so
    each route only has to provide the event-specific behaviour.

    The contract:
      * ``queue`` receives event dicts from the producer, and ``None``
        to signal clean completion.
      * On client disconnect, watchdog fire, or outer ``CancelledError``,
        ``on_cancel`` is awaited and a single ``{"type": "cancelled"}``
        SSE event is yielded before the generator exits.
      * ``handle_event`` receives one event dict at a time and returns
        ``(sse_frame_or_None, stop_after_yield)``.  Returning ``True``
        for ``stop_after_yield`` lets a handler implement early exit
        on terminal event types (e.g. ``done`` / ``error``) without
        having to know about the loop scaffolding.
      * ``on_complete`` runs only on the clean (sentinel-terminated)
        path — never on abort paths — so callers can emit a final
        ``batch_done`` / ``done`` frame.

    Args:
        queue:            Source of events.  ``None`` terminates cleanly.
        http_request:     For ``is_disconnected()`` polling each tick.
        on_cancel:        Idempotent cleanup for the producer.  Called
                          on every abort path and again in finally as a
                          safety net.  Implementations should guard with
                          ``if not runner.done()`` so the post-completion
                          finally call is a no-op.
        handle_event:     Synchronous formatter:
                          ``event -> (frame_or_None, stop_after_yield)``.
        watchdog_s:       Forwarded to :func:`sse_timeout_tick`.
        queue_timeout_s:  Per-iteration ``queue.get`` timeout in seconds.
        log_name:         Human-readable label used in log lines.
        on_complete:      Optional zero-arg callable returning SSE frames
                          to emit after a normal completion.  Not called
                          on abort paths.

    Yields:
        SSE-formatted strings (``data: ...\\n\\n`` and heartbeat comments).
    """
    last_event = time.monotonic()
    last_heartbeat = time.monotonic()

    try:
        while True:
            if await http_request.is_disconnected():
                logger.info("Client disconnected — cancelling %s", log_name)
                await on_cancel()
                yield sse_event({"type": "cancelled"})
                return

            try:
                event = await asyncio.wait_for(queue.get(), timeout=queue_timeout_s)
            except asyncio.TimeoutError:
                last_heartbeat, do_heartbeat, watchdog_fired = sse_timeout_tick(
                    last_event, last_heartbeat, watchdog_s
                )
                if do_heartbeat:
                    yield ": heartbeat\n\n"
                if watchdog_fired:
                    logger.error(
                        "%s watchdog fired: no event for %.0fs",
                        log_name, watchdog_s,
                    )
                    await on_cancel()
                    yield sse_error(
                        504,
                        f"No progress for {watchdog_s:.0f}s — operation timed out",
                    )
                    return
                continue

            if event is None:
                break  # producer signalled clean completion

            frame, stop = handle_event(event)
            if frame is not None:
                yield frame
            last_event = last_heartbeat = time.monotonic()
            if stop:
                return

        if on_complete is not None:
            for frame in on_complete():
                yield frame
    except asyncio.CancelledError:
        await on_cancel()
        raise
    finally:
        await on_cancel()
