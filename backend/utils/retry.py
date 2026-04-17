"""
Shared async retry utility with exponential back-off.

Usage::

    from backend.utils.retry import async_retry_with_backoff

    result = await async_retry_with_backoff(
        lambda: client.chat.completions.create(...),
        is_retryable=lambda exc: isinstance(exc, (APITimeoutError, APIConnectionError)),
        max_attempts=settings.HTTP_MAX_RETRY_ATTEMPTS,
        base_delay_s=settings.HTTP_RETRY_BASE_DELAY_S,
        logger=logger,
        context={"model": model},
    )
"""

import asyncio
import logging
from typing import Any, Callable, Coroutine


async def async_retry_with_backoff(
    coro_factory: Callable[[], Coroutine[Any, Any, Any]],
    *,
    is_retryable: Callable[[Exception], bool],
    max_attempts: int,
    base_delay_s: float,
    logger: logging.Logger,
    context: dict | None = None,
    operation: str = "LLM call",
) -> Any:
    """Call ``coro_factory()`` up to ``max_attempts`` times with exponential back-off.

    Args:
        coro_factory:  Zero-argument callable that returns a fresh coroutine per
                       attempt. Must be a factory (not the coroutine itself) so
                       each retry starts a new coroutine object.
        is_retryable:  Return ``True`` for exceptions that should be retried.
                       Return ``False`` to surface the exception immediately.
        max_attempts:  Maximum number of total attempts (including the first).
        base_delay_s:  Base delay in seconds; doubled per attempt (2^attempt).
        logger:        Logger instance for retry warnings and final error.
        context:       Optional extra fields forwarded to the logger's ``extra``
                       dict (e.g. ``{"model": "gpt-4o", "base_url": "..."}``)
                       for structured logging.
        operation:     Human-readable label used in log messages.

    Returns:
        The return value of ``coro_factory()`` on the first successful attempt.

    Raises:
        The last exception raised by ``coro_factory()`` after all attempts are
        exhausted, or a ``RuntimeError`` if no attempts were configured.
    """
    extra = context or {}
    last_exc: Exception | None = None

    for attempt in range(max_attempts):
        try:
            return await coro_factory()
        except Exception as exc:
            if not is_retryable(exc):
                raise
            last_exc = exc

        if attempt < max_attempts - 1:
            delay = base_delay_s * (2 ** attempt)
            logger.warning(
                "%s failed (%s) (attempt %d/%d), retrying in %.0fs",
                operation,
                type(last_exc).__name__,
                attempt + 1,
                max_attempts,
                delay,
                extra={**extra, "attempt": attempt + 1},
            )
            await asyncio.sleep(delay)
        else:
            logger.error(
                "%s failed after %d attempts — giving up",
                operation,
                max_attempts,
                extra=extra,
            )

    raise last_exc or RuntimeError("No retry attempts configured")
