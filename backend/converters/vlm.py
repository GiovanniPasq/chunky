"""
PDF-to-Markdown converter using any OpenAI-compatible Vision-Language Model.

Defaults to Ollama running locally (qwen3-vl), but can be pointed at
any provider that exposes an OpenAI-compatible chat completions endpoint.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import threading
from pathlib import Path
from typing import Callable, Optional

import fitz  # PyMuPDF — required for rasterising pages
import httpx

from backend.registry import register_converter
from .base import PDFConverter

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

_PROMPT = """You are an expert document parser specializing in converting PDF pages to markdown format.

**Your task:** Extract ALL content from the provided page image and return it as clean, well-structured markdown.

**Text Extraction Rules:**
1. Preserve the EXACT text as written (including typos, formatting, special characters)
2. Maintain the logical reading order (top-to-bottom, left-to-right)
3. Preserve hierarchical structure using appropriate markdown headers (#, ##, ###)
4. Keep paragraph breaks and line spacing as they appear
5. Use markdown lists (-, *, 1.) for bullet points and numbered lists
6. Preserve text emphasis: **bold**, *italic*, `code`
7. For multi-column layouts, extract left column first, then right column

**Tables:**
- Convert all tables to markdown table format
- Preserve column alignment and structure
- Use | for columns and - for headers

**Mathematical Formulas:**
- Convert to LaTeX format: inline `$...$`, display `$$...$$`
- If LaTeX conversion is uncertain, describe the formula clearly

**Images, Diagrams, Charts:**
- Insert markdown image placeholder: `![Description](image)`
- Provide a detailed, informative description including:
  * Type of visual (photo, diagram, chart, graph, illustration)
  * Main subject or purpose
  * Key elements, labels, or data points
  * Colors, patterns, or notable visual features
  * Context or relationship to surrounding text
- For charts/graphs: mention axes, data trends, and key values
- For diagrams: describe components and their relationships

**Special Elements:**
- Footnotes: Use markdown footnote syntax `[^1]`
- Citations: Preserve as written
- Code blocks: Use triple backticks with language specification
- Quotes: Use `>` for blockquotes
- Links: Preserve as `[text](url)` if visible

**Quality Guidelines:**
- DO NOT add explanations, comments, or meta-information
- DO NOT skip or summarize content
- DO NOT invent or hallucinate text not present in the image
- DO NOT include "Here is the markdown..." or similar preambles
- Output ONLY the markdown content, nothing else

**Output Format:**
Return raw markdown with no wrapper, no code blocks, no explanations. Start immediately with the page content."""

# DPI used when rasterising each PDF page before sending it to the VLM.
_RENDER_DPI = 300
_DPI_SCALE = _RENDER_DPI / 72  # fitz uses 72 DPI as its baseline

_DEFAULT_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")

# Retry settings for timed-out VLM calls.
_MAX_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY_S = 1.0  # seconds; doubles each attempt (1 s, 2 s, 4 s)

# Maximum number of page-transcription API calls in flight at once.
# A value of 3 pipelines well against most local/cloud VLM endpoints without
# flooding a single-worker model (e.g. Ollama) with too many queued requests.
_MAX_CONCURRENT_PAGES = 2


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

    Pages are transcribed concurrently (up to :data:`_MAX_CONCURRENT_PAGES`
    in flight at once) using ``AsyncOpenAI``.  The synchronous ``convert()``
    entry point bootstraps a private event loop via ``asyncio.run()`` so it
    can be called from a ``ThreadPoolExecutor`` worker without blocking the
    main asyncio event loop.

    The ``http_client`` parameter is accepted for API compatibility but is
    no longer used: ``AsyncOpenAI`` creates its own ``httpx.AsyncClient``
    inside ``_async_convert()`` so it stays bound to the correct event loop.

    Provider examples::

        # Ollama (default) — no API key required
        converter = VLMConverter()

        # OpenAI
        converter = VLMConverter(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            api_key="sk-...",
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
        http_client: Optional[httpx.Client] = None,  # kept for API compat, unused
        stop_event: Optional[threading.Event] = None,
    ) -> None:
        self._model = model
        self._base_url = base_url
        self._api_key = api_key
        self._temperature = temperature
        self._user_prompt = user_prompt
        self._on_progress = on_progress
        self._stop_event = stop_event
        self._timeout = httpx.Timeout(connect=10.0, read=300.0, write=10.0, pool=5.0)

    # ------------------------------------------------------------------
    # PDFConverter interface
    # ------------------------------------------------------------------

    def convert(self, pdf_path: Path, total_pages: Optional[int] = None) -> str:
        """Render every page and transcribe each one via the VLM concurrently.

        Called from a ``ThreadPoolExecutor`` worker via ``asyncio.to_thread()``.
        A private event loop is created with ``asyncio.run()`` so async page
        processing does not interact with the main application event loop.

        Args:
            pdf_path:    Path to the PDF file to convert.
            total_pages: Pre-computed page count from the caller (avoids a
                         redundant ``fitz.open()`` solely to read page count).

        Returns:
            Full document as Markdown, pages separated by ``\\n\\n---\\n\\n``.
        """
        self.validate_path(pdf_path)
        return asyncio.run(self._async_convert(pdf_path, total_pages))

    # ------------------------------------------------------------------
    # Async implementation
    # ------------------------------------------------------------------

    async def _async_convert(self, pdf_path: Path, total_pages: Optional[int]) -> str:
        """Async core: render all pages in an executor, then transcribe concurrently."""
        loop = asyncio.get_running_loop()

        if self._stop_event and self._stop_event.is_set():
            raise InterruptedError("Conversion cancelled before start")

        # ── Render all pages (CPU-bound C-native) ────────────────────────────
        # All rendering runs in a single executor call so the fitz document
        # context stays intact for the full duration.  Stop-event is checked
        # between pages so a cancellation request is honoured promptly.
        def _render_all() -> tuple[int, list[str]]:
            with fitz.open(str(pdf_path)) as doc:
                n = total_pages if total_pages is not None else doc.page_count
                images: list[str] = []
                for i in range(n):
                    if self._stop_event and self._stop_event.is_set():
                        raise InterruptedError("Conversion cancelled during rendering")
                    images.append(self._render_page_as_b64(doc[i]))
                return n, images

        total, rendered = await loop.run_in_executor(None, _render_all)

        # ── Transcribe all pages concurrently (I/O-bound async HTTP) ─────────
        # AsyncOpenAI + httpx.AsyncClient are created here so they are bound
        # to this event loop (created by asyncio.run()).  A semaphore caps the
        # number of in-flight API calls to avoid flooding single-worker models.
        sem = asyncio.Semaphore(_MAX_CONCURRENT_PAGES)

        async with httpx.AsyncClient(timeout=self._timeout) as http:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(
                base_url=self._base_url,
                api_key=self._api_key,
                http_client=http,
            )

            async def _process(page_num: int, img_b64: str) -> str:
                if self._stop_event and self._stop_event.is_set():
                    raise InterruptedError("Conversion cancelled before page")
                async with sem:
                    markdown = await self._transcribe_page_with_retry_async(client, img_b64)
                if self._on_progress:
                    self._on_progress(page_num + 1, total)
                return markdown

            page_tasks = [
                asyncio.create_task(_process(i, img))
                for i, img in enumerate(rendered)
            ]

            # Watcher: polls the threading stop-event every 0.25 s and actively
            # cancels all page tasks the moment it fires.  Without this, tasks
            # already inside `await client.chat.completions.create()` would
            # not be interrupted until their API call returned — potentially
            # 10–60 s for a slow local model.  task.cancel() raises
            # CancelledError at the httpx await point, aborting the HTTP
            # request immediately (< 0.25 s latency to cancellation).
            async def _cancellation_watcher() -> None:
                if self._stop_event is None:
                    return
                while True:
                    if self._stop_event.is_set():
                        for t in page_tasks:
                            t.cancel()
                        return
                    await asyncio.sleep(0.25)

            watcher = asyncio.create_task(_cancellation_watcher())
            try:
                results = list(await asyncio.gather(*page_tasks))
            except (Exception, asyncio.CancelledError):
                # Cancel any tasks still in flight (covers both InterruptedError
                # raised by a stop_event check and CancelledError injected by
                # the watcher), then wait for them to drain cleanly.
                for t in page_tasks:
                    t.cancel()
                await asyncio.gather(*page_tasks, return_exceptions=True)
                if self._stop_event and self._stop_event.is_set():
                    raise InterruptedError("Conversion cancelled")
                raise
            finally:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)

        parts = [f"<!-- page-marker:{i + 1} -->\n{md}" for i, md in enumerate(results)]
        return "\n\n---\n\n".join(parts)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _render_page_as_b64(page) -> str:
        """Rasterise a fitz page and return a base64-encoded PNG string."""
        matrix = fitz.Matrix(_DPI_SCALE, _DPI_SCALE)
        pix = page.get_pixmap(matrix=matrix)
        return base64.b64encode(pix.tobytes("png")).decode("utf-8")

    async def _transcribe_page_async(self, client, img_b64: str) -> str:
        """Send a base64 page image to the VLM and return the Markdown text."""
        prompt_text = self._user_prompt if self._user_prompt else _PROMPT
        response = await client.chat.completions.create(
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

    async def _transcribe_page_with_retry_async(self, client, img_b64: str) -> str:
        """Call ``_transcribe_page_async`` with exponential back-off on timeout.

        Uses ``asyncio.sleep()`` between retries (non-blocking).  Stop-event
        is checked before each attempt so no new API call is started after
        cancellation has been requested.
        """
        from openai import APITimeoutError

        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRY_ATTEMPTS):
            if self._stop_event and self._stop_event.is_set():
                raise InterruptedError("Conversion cancelled before retry")

            try:
                return await self._transcribe_page_async(client, img_b64)
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
                    await asyncio.sleep(delay)
                else:
                    logger.error(
                        "VLM page call timed out after %d attempts — aborting conversion",
                        _MAX_RETRY_ATTEMPTS,
                    )
        raise last_exc  # type: ignore[misc]
