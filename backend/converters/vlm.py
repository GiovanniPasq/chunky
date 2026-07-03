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
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import fitz  # PyMuPDF — required for rasterising pages
import httpx

from backend.registry import register_converter
from backend.utils.retry import async_retry_with_backoff
from .vlm_checkpoint import CheckpointStore
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

def _get_render_dpi() -> int:
    from backend.config import get_settings as _gs
    return _gs().VLM_RENDER_DPI


def _get_default_base_url() -> str:
    from backend.config import get_settings as _gs
    return os.getenv("OLLAMA_BASE_URL", _gs().VLM_DEFAULT_BASE_URL)


@dataclass(slots=True)
class _PageResult:
    """Per-page outcome carried through asyncio.gather.

    Exactly one of ``markdown`` and ``error`` is populated. ``cached`` is
    True when the result was loaded from the checkpoint store and no API
    call was made.
    """

    page_num: int          # 0-indexed
    markdown: str | None
    error: str | None
    cached: bool = False


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

    Each page is rasterised at the configured ``VLM_RENDER_DPI`` and sent to
    the model as a base64-encoded PNG embedded in a ``data:`` URI.

    Pages are transcribed concurrently up to ``VLM_MAX_CONCURRENT_PAGES``.
    The synchronous ``convert()`` entry point runs in ``asyncio.to_thread()``
    and creates a private event loop via ``asyncio.run()``.

    Resilience features (see ``vlm_checkpoint.py`` for the on-disk format):

        * **Graceful per-page failure** — a transient or model-level error on
          one page no longer aborts the entire job. Failed pages get an
          inline ``<!-- page N failed: … -->`` placeholder in the final
          Markdown and the job runs to completion.
        * **Per-page checkpointing** — every successful page is persisted
          to ``mds/.checkpoints/{stem}_vlm/`` as it completes. An interrupted
          job resumes from the last cached page on the next run, skipping
          both rendering and the API call.

    After ``convert()`` returns, callers may read:

        * :attr:`failed_pages` — sorted list of 1-indexed page numbers that
          failed transcription (empty when the document is clean).
        * :attr:`resumed_from_pages` — count of pages that were loaded from
          the checkpoint at the start (0 when no checkpoint was used).

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
        model: str = "",
        base_url: str = "",
        api_key: str = "",
        temperature: float | None = None,
        user_prompt: str | None = None,
        on_progress: Callable[[int, int], None] | None = None,
        stop_event: threading.Event | None = None,
        checkpoint_store: CheckpointStore | None = None,
    ) -> None:
        from backend.config import get_settings as _get_settings
        _s = _get_settings()

        self._model = model or _s.VLM_DEFAULT_MODEL
        self._base_url = base_url or _get_default_base_url()
        self._api_key = api_key or _s.VLM_DEFAULT_API_KEY
        self._temperature = temperature if temperature is not None else _s.VLM_DEFAULT_TEMPERATURE
        self._user_prompt = user_prompt
        self._on_progress = on_progress
        self._stop_event = stop_event
        self._max_retry_attempts = _s.HTTP_MAX_RETRY_ATTEMPTS
        self._retry_base_delay_s = _s.HTTP_RETRY_BASE_DELAY_S
        self._max_concurrent_pages = _s.VLM_MAX_CONCURRENT_PAGES
        self._timeout = httpx.Timeout(
            connect=_s.HTTP_CONNECT_TIMEOUT_S,
            read=_s.VLM_READ_TIMEOUT_S,
            write=_s.VLM_WRITE_TIMEOUT_S,
            pool=_s.HTTP_POOL_TIMEOUT_S,
        )
        self._checkpoint_store = checkpoint_store

        # Populated by convert() — read by the caller for SSE / response payload.
        self.failed_pages: list[int] = []
        self.resumed_from_pages: int = 0

    # ------------------------------------------------------------------
    # PDFConverter interface
    # ------------------------------------------------------------------

    def convert(self, pdf_path: Path, total_pages: int | None = None) -> str:
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
            Pages that failed transcription are represented by an inline
            ``<!-- page N failed: … -->`` placeholder; the page count and
            ordering is preserved so downstream tooling can still rely on
            page-marker comments.
        """
        self.validate_path(pdf_path)
        return asyncio.run(self._async_convert(pdf_path, total_pages))

    # ------------------------------------------------------------------
    # Async implementation
    # ------------------------------------------------------------------

    async def _async_convert(self, pdf_path: Path, total_pages: int | None) -> str:
        """Async core: render pages on-demand and transcribe concurrently.

        Rendering and the API call share the same semaphore slot, so at most
        ``VLM_MAX_CONCURRENT_PAGES`` page PNGs exist in memory at once.
        Peak memory is bounded to that concurrency × one page PNG
        instead of ``total_pages × (one page PNG)``, which for a 100-page
        document at 300 DPI can be the difference between ~30 MB and ~1.5 GB.

        Pages already present in the checkpoint store skip both the
        rendering and the API call: they are loaded synchronously from disk
        and feed directly into the progress callback.  Cached loads do not
        acquire the concurrency semaphore — the semaphore bounds peak memory
        for in-flight page PNGs, which cached loads do not produce.
        """
        loop = asyncio.get_running_loop()

        if self._stop_event and self._stop_event.is_set():
            raise InterruptedError("Conversion cancelled before start")

        # ── Get page count ────────────────────────────────────────────────────
        if total_pages is not None:
            total = total_pages
        else:
            def _get_page_count() -> int:
                with fitz.open(str(pdf_path)) as doc:
                    return doc.page_count
            total = await loop.run_in_executor(None, _get_page_count)

        # ── Resolve which pages are already cached ───────────────────────────
        # We snapshot this once up-front so progress reporting and the
        # ``resumed_from_pages`` summary stay coherent even if files were to
        # appear under the checkpoint dir mid-run (they shouldn't — only the
        # converter writes there — but the snapshot keeps the logic simple).
        cached_pages: set[int] = set()
        if self._checkpoint_store is not None:
            for p in self._checkpoint_store.completed_pages():
                if 0 <= p < total:
                    cached_pages.add(p)
        self.resumed_from_pages = len(cached_pages)

        # ── Transcribe pages concurrently (render + API call per task) ───────
        # Each task renders its own page inside the executor and immediately
        # feeds the base64 image to the VLM.  The rendered bytes are eligible
        # for GC as soon as the API call returns — no large list held in memory.
        sem = asyncio.Semaphore(self._max_concurrent_pages)
        completed_pages = 0  # incremented each time any page finishes (asyncio-safe)

        async with httpx.AsyncClient(timeout=self._timeout) as http:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(
                base_url=self._base_url,
                api_key=self._api_key,
                http_client=http,
            )

            async def _process(page_num: int) -> _PageResult:
                nonlocal completed_pages
                if self._stop_event and self._stop_event.is_set():
                    raise InterruptedError("Conversion cancelled before page")

                # ── Fast path: checkpoint cache hit ──────────────────────────
                # Skip semaphore acquisition entirely — cached loads do not
                # consume the per-page memory budget that the semaphore guards.
                if page_num in cached_pages and self._checkpoint_store is not None:
                    try:
                        cached_md = await loop.run_in_executor(
                            None, self._checkpoint_store.load_page, page_num
                        )
                    except OSError as exc:
                        # Corrupt or unreadable checkpoint — fall through to
                        # a fresh transcription rather than failing the page.
                        logger.warning(
                            "Failed to load checkpoint for page %d: %s — re-transcribing",
                            page_num + 1, exc,
                        )
                        cached_pages.discard(page_num)
                    else:
                        completed_pages += 1
                        if self._on_progress:
                            self._on_progress(completed_pages, total)
                        return _PageResult(page_num=page_num, markdown=cached_md, error=None, cached=True)

                # Render this page in the executor (CPU-bound, releases GIL).
                # Re-opening the PDF is cheap — fitz uses OS-level page caching.
                def _render_one() -> str:
                    with fitz.open(str(pdf_path)) as doc:
                        if self._stop_event and self._stop_event.is_set():
                            raise InterruptedError("Conversion cancelled during rendering")
                        return self._render_page_as_b64(doc[page_num])

                try:
                    async with sem:
                        img_b64 = await loop.run_in_executor(None, _render_one)
                        markdown = await self._transcribe_page_with_retry_async(
                            client, img_b64, page_num=page_num
                        )
                except (asyncio.CancelledError, InterruptedError):
                    # Cancellation must propagate so the gather/watcher logic
                    # below can drain in-flight tasks and surface the
                    # InterruptedError to the caller.
                    raise
                except Exception as exc:
                    # Treat every other exception as a per-page failure: log,
                    # record a placeholder, and let the rest of the job
                    # continue.  This includes APIStatusError (4xx/5xx after
                    # retries are exhausted), the empty-choices ValueError,
                    # JSON decoding errors from broken model output, etc.
                    error_summary = f"{type(exc).__name__}: {str(exc)[:200]}"
                    logger.warning(
                        "Page %d transcription failed — recording placeholder: %s",
                        page_num + 1, error_summary,
                        extra={"model": self._model, "page_num": page_num},
                    )
                    completed_pages += 1
                    if self._on_progress:
                        self._on_progress(completed_pages, total)
                    return _PageResult(page_num=page_num, markdown=None, error=error_summary, cached=False)

                # ── Successful transcription ─────────────────────────────────
                # Persist to checkpoint BEFORE counting the page as done so a
                # crash between save and progress callback can't lose work.
                if self._checkpoint_store is not None:
                    try:
                        await loop.run_in_executor(
                            None, self._checkpoint_store.save_page, page_num, markdown
                        )
                    except OSError as exc:
                        # A failed checkpoint save is non-fatal — the page
                        # markdown is still returned in-memory.  Next run will
                        # simply re-transcribe this page.
                        logger.warning(
                            "Failed to save checkpoint for page %d: %s",
                            page_num + 1, exc,
                        )

                completed_pages += 1
                if self._on_progress:
                    self._on_progress(completed_pages, total)
                return _PageResult(page_num=page_num, markdown=markdown, error=None, cached=False)

            page_tasks = [asyncio.create_task(_process(i)) for i in range(total)]

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
                results: list[_PageResult] = list(await asyncio.gather(*page_tasks))
            except (Exception, asyncio.CancelledError):
                # Per-page exceptions are now caught inside ``_process`` — the
                # only exceptions that can escape are cancellation signals
                # (InterruptedError, CancelledError) propagated explicitly.
                # Drain any in-flight tasks before re-raising.
                for t in page_tasks:
                    t.cancel()
                await asyncio.gather(*page_tasks, return_exceptions=True)
                if self._stop_event and self._stop_event.is_set():
                    raise InterruptedError("Conversion cancelled")
                raise
            finally:
                watcher.cancel()
                try:
                    await asyncio.gather(watcher, return_exceptions=True)
                except Exception as _exc:
                    logger.warning("Error awaiting watcher cancellation: %s", _exc)

        # ── Assemble final Markdown, recording failures ───────────────────────
        self.failed_pages = sorted(r.page_num + 1 for r in results if r.error is not None)
        if self.failed_pages:
            logger.warning(
                "VLM conversion finished with %d failed page(s): %s",
                len(self.failed_pages), self.failed_pages,
            )

        parts: list[str] = []
        for r in results:
            page_marker = f"<!-- page-marker:{r.page_num + 1} -->"
            if r.error is not None:
                body = f"<!-- page {r.page_num + 1} failed: {r.error} -->"
            else:
                body = r.markdown or ""
            parts.append(f"{page_marker}\n{body}")
        return "\n\n---\n\n".join(parts)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _render_page_as_b64(page) -> str:
        """Rasterise a fitz page and return a base64-encoded PNG string."""
        dpi_scale = _get_render_dpi() / 72  # fitz uses 72 DPI as its baseline
        matrix = fitz.Matrix(dpi_scale, dpi_scale)
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
        if not response.choices:
            raise ValueError("VLM returned an empty choices list — no content to extract")
        content = (response.choices[0].message.content or "").strip()
        content = re.sub(r"^```(?:markdown)?\n?", "", content)
        content = re.sub(r"\n?```$", "", content)
        return content.strip()

    @staticmethod
    def _is_retryable(exc: Exception) -> bool:
        from openai import APIConnectionError, APIStatusError, APITimeoutError
        if isinstance(exc, (APITimeoutError, APIConnectionError)):
            return True
        if isinstance(exc, APIStatusError):
            return exc.status_code >= 500 or exc.status_code == 429
        return False

    async def _transcribe_page_with_retry_async(
        self, client, img_b64: str, page_num: int = 0
    ) -> str:
        """Call ``_transcribe_page_async`` with exponential back-off on transient errors.

        Stop-event is checked before each attempt so no new API call is started
        after cancellation has been requested.
        """
        if self._stop_event and self._stop_event.is_set():
            raise InterruptedError("Conversion cancelled before retry")

        return await async_retry_with_backoff(
            lambda: self._transcribe_page_async(client, img_b64),
            is_retryable=self._is_retryable,
            max_attempts=self._max_retry_attempts,
            base_delay_s=self._retry_base_delay_s,
            logger=logger,
            context={"model": self._model, "base_url": self._base_url, "page_num": page_num},
            operation="VLM page call",
        )
