"""
PDF-to-Markdown converter via a generic cloud API.

Sends the PDF file as a multipart/form-data POST request and expects
the raw Markdown text as the response body.  No model-specific payload,
no base64 encoding, no vendor lock-in.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path
from typing import Callable, Optional

import httpx

from backend.registry import register_converter
from .base import PDFConverter

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "http://localhost:8080/convert"


@register_converter(
    name="cloud",
    label="Cloud API",
    description=(
        "POSTs the PDF to a configurable cloud endpoint and returns the Markdown "
        "response body directly. No local model required."
    ),
)
class CloudConverter(PDFConverter):
    """PDF-to-Markdown converter via a plain HTTP POST.

    Sends the PDF as ``multipart/form-data`` (field name: ``file``) to
    ``base_url`` and treats the response body as the Markdown result::

        POST {base_url}
        Authorization: Bearer {bearer_token}   (omitted when bearer_token is not set)
        Content-Type: multipart/form-data

        file=<pdf bytes>

        200 OK
        Content-Type: text/plain (or text/markdown)

        # Document title
        ...

    The ``on_progress`` callback fires once (``on_progress(1, 1)``) after the
    response arrives, keeping the SSE progress contract consistent.
    """

    def __init__(
        self,
        base_url: str = _DEFAULT_BASE_URL,
        bearer_token: Optional[str] = None,  # sent as Authorization: Bearer <token>
        on_progress: Optional[Callable[[int, int], None]] = None,
        stop_event: Optional[threading.Event] = None,
    ) -> None:
        from backend.config import get_settings as _get_settings
        _s = _get_settings()

        self._base_url = base_url
        self._bearer_token = bearer_token
        self._on_progress = on_progress
        self._stop_event = stop_event
        self._max_retry_attempts = _s.HTTP_MAX_RETRY_ATTEMPTS
        self._retry_base_delay_s = _s.HTTP_RETRY_BASE_DELAY_S
        self._timeout = httpx.Timeout(
            connect=_s.HTTP_CONNECT_TIMEOUT_S,
            read=_s.CLOUD_READ_TIMEOUT_S,
            write=_s.CLOUD_WRITE_TIMEOUT_S,
            pool=_s.HTTP_POOL_TIMEOUT_S,
        )

    # ------------------------------------------------------------------
    # PDFConverter interface
    # ------------------------------------------------------------------

    def convert(self, pdf_path: Path, total_pages: Optional[int] = None) -> str:
        """POST the PDF to the cloud endpoint and return the Markdown body.

        Called from a ``ThreadPoolExecutor`` worker via ``asyncio.to_thread()``.
        ``asyncio.run()`` creates a private event loop so the HTTP call does
        not interact with the main application event loop.
        """
        self.validate_path(pdf_path)
        return asyncio.run(self._async_convert(pdf_path))

    # ------------------------------------------------------------------
    # Async implementation
    # ------------------------------------------------------------------

    async def _async_convert(self, pdf_path: Path) -> str:
        if self._stop_event and self._stop_event.is_set():
            raise InterruptedError("Conversion cancelled before start")

        async with httpx.AsyncClient(timeout=self._timeout) as http:
            markdown = await self._call_api_with_retry_async(http, pdf_path)

        if self._on_progress:
            self._on_progress(1, 1)

        return markdown

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    async def _call_api_with_retry_async(self, http: httpx.AsyncClient, pdf_path: Path) -> str:
        """POST with exponential back-off on timeout and transient server errors.

        Retries on:
        - ``httpx.TimeoutException`` — request timed out
        - ``httpx.HTTPStatusError`` with status >= 500 — transient server error

        4xx responses (bad request, auth failure) are not retried.
        Checks ``stop_event`` before each attempt so no new request is started
        after cancellation has been requested.
        """
        last_exc: Exception | None = None

        for attempt in range(self._max_retry_attempts):
            if self._stop_event and self._stop_event.is_set():
                raise InterruptedError("Conversion cancelled before retry")

            try:
                return await self._post_pdf(http, pdf_path)
            except (httpx.TimeoutException, httpx.HTTPStatusError) as exc:
                # Do not retry definitive client errors (4xx).
                if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code < 500:
                    raise
                last_exc = exc
                if attempt < self._max_retry_attempts - 1:
                    delay = self._retry_base_delay_s * (2 ** attempt)
                    logger.warning(
                        "Cloud API error (%s, attempt %d/%d), retrying in %.0fs",
                        type(exc).__name__,
                        attempt + 1,
                        self._max_retry_attempts,
                        delay,
                        extra={"base_url": self._base_url},
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(
                        "Cloud API failed after %d attempts — aborting conversion",
                        self._max_retry_attempts,
                        extra={"base_url": self._base_url},
                    )

        raise last_exc or RuntimeError("No retry attempts configured")

    async def _post_pdf(self, http: httpx.AsyncClient, pdf_path: Path) -> str:
        """Send one POST request and return the response body as Markdown.

        The PDF is streamed via an open file handle rather than loaded into
        memory with ``read_bytes()``, keeping peak memory usage at one upload
        buffer rather than the full file size.
        """
        headers: dict[str, str] = {}
        if self._bearer_token:
            headers["Authorization"] = f"Bearer {self._bearer_token}"
        with open(pdf_path, "rb") as fh:
            files = {"file": (pdf_path.name, fh, "application/pdf")}
            response = await http.post(self._base_url, files=files, headers=headers)
        response.raise_for_status()
        return response.text.strip()
