"""
PDF-to-Markdown converter using any OpenAI-compatible Vision-Language Model.

Defaults to Ollama running locally (qwen3-vl), but can be pointed at
any provider that exposes an OpenAI-compatible chat completions endpoint.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import time
from pathlib import Path
from typing import Callable, Optional

import httpx

from backend.registry import register_converter
from .base import PDFConverter

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

_PROMPT = """Convert the PDF page image to clean markdown.

**Text:** Preserve exact content, reading order, and hierarchy (#, ##, ###). Use standard markdown for bold, italic, code, lists, blockquotes, footnotes.
**Tables:** Full markdown table syntax with alignment.
**Math:** LaTeX inline $...$ or display $$...$$.
**Visuals:** Replace with `![<type>: <description of content, labels, trends>](image)`.
**Code:** Triple backticks with language tag.

Output raw markdown only. No preamble, no commentary, no wrapping code block."""

# DPI used when rasterising each PDF page before sending it to the VLM.
_RENDER_DPI = 300
_DPI_SCALE = _RENDER_DPI / 72  # fitz uses 72 DPI as its baseline

_DEFAULT_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")

# Retry settings for timed-out VLM calls.
_MAX_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY_S = 1.0  # seconds; doubles each attempt (1 s, 2 s, 4 s)


@register_converter(
    name="vlm",
    label="VLM (Vision-Language Model)",
    description=(
        "Rasterises each page and sends it to an OpenAI-compatible VLM. "
        "Best quality for scanned PDFs. Requires a running model endpoint."
    ),
)
class VLMConverter(PDFConverter):
    """PDF-to-Markdown converter using any OpenAI-compatible VLM.

    Each page is rasterised at :data:`_RENDER_DPI` DPI and sent to the model
    as a base64-encoded PNG embedded in a ``data:`` URI.

    The ``http_client`` parameter accepts a shared ``httpx.Client`` so all
    conversions reuse the same connection pool instead of creating a new one
    per request.  Pass ``app.state.http_client_sync`` from the router.

    Provider examples::

        # Ollama (default) — no API key required
        converter = VLMConverter(http_client=shared_client)

        # OpenAI
        converter = VLMConverter(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            api_key="sk-...",
            http_client=shared_client,
        )
    """

    def __init__(
        self,
        model: str = "qwen3-vl:4b-instruct-q4_K_M",
        base_url: str = _DEFAULT_BASE_URL,
        api_key: str = "ollama",
        temperature: float = 0.1,
        user_prompt: Optional[str] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        from openai import OpenAI

        self._model = model
        self._temperature = temperature
        self._user_prompt = user_prompt
        self._on_progress = on_progress

        # If a shared client is supplied its timeout settings apply.
        # Otherwise use a conservative per-request timeout.
        client_kwargs: dict = dict(base_url=base_url, api_key=api_key)
        if http_client is not None:
            client_kwargs["http_client"] = http_client
        else:
            client_kwargs["timeout"] = httpx.Timeout(
                connect=10.0, read=120.0, write=10.0, pool=5.0
            )

        self._client = OpenAI(**client_kwargs)

    # ------------------------------------------------------------------
    # PDFConverter interface
    # ------------------------------------------------------------------

    def convert(self, pdf_path: Path) -> str:
        """Render every page and send each one to the VLM for transcription.

        Cancellation is signalled via the ``on_progress`` callback passed at
        construction time (see :meth:`document_service._progress_handler`):
        it raises ``InterruptedError`` when the caller's stop_event is set,
        which bubbles out of this method naturally.

        Returns:
            Full document as Markdown, pages separated by ``\\n\\n---\\n\\n``.
        """
        import fitz  # PyMuPDF

        self.validate_path(pdf_path)

        pages: list[str] = []

        with fitz.open(str(pdf_path)) as pdf_document:
            total = pdf_document.page_count
            for page_num in range(total):
                page = pdf_document[page_num]
                img_b64 = self._render_page_as_b64(page)
                markdown = self._transcribe_page_with_retry(img_b64)
                pages.append(markdown)

                if self._on_progress:
                    # The progress handler checks stop_event and raises
                    # InterruptedError when a cancellation is requested.
                    self._on_progress(page_num + 1, total)

        return "\n\n---\n\n".join(pages)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _render_page_as_b64(page) -> str:
        """Rasterise a fitz page and return a base64-encoded PNG string."""
        matrix = __import__("fitz").Matrix(_DPI_SCALE, _DPI_SCALE)
        pix = page.get_pixmap(matrix=matrix)
        return base64.b64encode(pix.tobytes("png")).decode("utf-8")

    def _transcribe_page(self, img_b64: str) -> str:
        """Send a base64 page image to the VLM and return the Markdown text."""
        prompt_text = self._user_prompt if self._user_prompt else _PROMPT
        response = self._client.chat.completions.create(
            model=self._model,
            temperature=self._temperature,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": f"data:image/png;base64,{img_b64}",
                        },
                        {"type": "text", "text": prompt_text},
                    ],
                },
            ],
        )
        content = (response.choices[0].message.content or "").strip()
        content = re.sub(r"^```(?:markdown)?\n?", "", content)
        content = re.sub(r"\n?```$", "", content)
        return content.strip()

    def _transcribe_page_with_retry(self, img_b64: str) -> str:
        """Call ``_transcribe_page`` with exponential back-off on timeout.

        On final timeout the exception is re-raised so the caller can decide
        whether to mark the page as failed or abort the entire conversion.
        """
        from openai import APITimeoutError

        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRY_ATTEMPTS):
            try:
                return self._transcribe_page(img_b64)
            except APITimeoutError as exc:
                last_exc = exc
                if attempt < _MAX_RETRY_ATTEMPTS - 1:
                    delay = _RETRY_BASE_DELAY_S * (2 ** attempt)
                    logger.warning(
                        "VLM page call timed out (attempt %d/%d), retrying in %.0fs",
                        attempt + 1,
                        _MAX_RETRY_ATTEMPTS,
                        delay,
                    )
                    time.sleep(delay)
                else:
                    logger.error(
                        "VLM page call timed out after %d attempts — aborting conversion",
                        _MAX_RETRY_ATTEMPTS,
                    )
        raise last_exc  # type: ignore[misc]
